/**
 * What screen 1 does when there is no loan to price, and what a row may hold.
 *
 * The affordability gate had no test at all, which is how it came to answer
 * `{"message": "Internal server error"}` to an ordinary request. A down
 * payment that covers the price leaves a loan of nothing; the pricing port
 * refuses to quote nothing, correctly; and `UnquotableScenarioError` is not an
 * `AppError`, so it fell through to the generic handler and was logged as a
 * crash. The one screen whose job is to tell somebody their loan cannot work
 * told them the server had broken instead — on an all-cash purchase, on a typo
 * in one field, and on a refinance borrower answering "how much equity are you
 * keeping?" with all of it.
 *
 * The rest of this file is the other end of the same promise. A rate nobody
 * quoted must not reach a decision, and the place that promise is kept is the
 * row: `loan_files` carried no CHECK constraint at all, so a product code
 * beside a NULL note rate was a legal row, and it read back as zero percent.
 * These run against the real Postgres because the constraint is the claim.
 */

import { Router } from "express";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { PricingNotWiredError, UnquotableScenarioError } from "@hm/connectors";
import {
  BRITISH,
  DELIVERY_TIME,
  PROMISES,
  RATE_COMMITMENT,
  REQ_ID,
  VENDOR_CLAIM,
} from "@hm/shared";
import { propertyRouter } from "../routes/property.js";
import { asyncRoute } from "../middleware/error-handler.js";
import { loadLoanFile } from "../services/repository.js";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1's gate call, as `PropertyLoanPage` posts it. */
const GATE = {
  valueOrPrice: 415_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
  occupancy: "primary_residence",
  purpose: "purchase",
  propertyType: "single_family",
  state: "TX",
};

/**
 * The rules every borrower-facing line keeps, applied to the ones this path
 * serves.
 *
 * `borrower-copy.test.ts` reads `apps/web` and `stories.test.ts` reads the
 * personas; roughly forty inline `AppError` messages across the routes and
 * services are read by neither, and these are four of them. Held against the
 * response body rather than against a catalog, because the response body is
 * what a borrower is shown — an inline message cannot be read any other way.
 */
function readable(text: string | undefined) {
  expect(text, "a borrower has to be told something").toBeTruthy();
  for (const [name, rule] of [
    ["PROMISES", PROMISES],
    ["DELIVERY_TIME", DELIVERY_TIME],
    ["VENDOR_CLAIM", VENDOR_CLAIM],
    ["RATE_COMMITMENT", RATE_COMMITMENT],
    ["BRITISH", BRITISH],
    ["REQ_ID", REQ_ID],
  ] as const) {
    expect(`${name}: ${text}`, name).not.toMatch(rule);
  }
}

interface GateBody {
  verdict?: string;
  loanAmount?: number;
  estimatedMonthlyPayment?: number;
  error?: { message: string; code: string; details?: { message: string }[] };
}

async function gate(over: Record<string, unknown> = {}) {
  const user = await createUser();
  return callAs<GateBody>(
    user.id,
    [propertyRouter],
    "POST",
    "/affordability",
    { ...GATE, ...over },
    "/api/property",
  );
}

describe("the affordability gate, when there is no loan in it", () => {
  it("answers a workable loan with a verdict, which is the case that must keep working", async () => {
    const res = await gate();
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("workable");
    expect(res.body.loanAmount).toBe(332_000);
    // Priced off the sheet rather than off a variable: 6.25% over 360 months
    // on $332,000 is a little over $2,000 of principal and interest, before
    // taxes and insurance are added.
    expect(res.body.estimatedMonthlyPayment).toBeGreaterThan(2_000);
  });

  it.each([
    ["covers the price exactly — an all-cash purchase", 415_000],
    ["is more than the price — a typo in one field", 450_000],
  ])("refuses a down payment that %s, and does not crash", async (_why, downPayment) => {
    const res = await gate({ downPayment });
    // A 400 a borrower can read, not a 500 with a stack in the log. The status
    // is the assertion: every one of these answered 500 before.
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    // Zod carries the refinement's own sentence, which is what the screen
    // shows. It is a line of borrower copy and is held to the rules as one.
    const said = res.body.error?.details?.[0]?.message;
    expect(said).toMatch(/no loan here to check/);
    readable(said);
  });

  it("still refuses a price of nothing, which was never a loan either", async () => {
    const res = await gate({ valueOrPrice: 0, downPayment: 0 });
    expect(res.status).toBe(400);
  });
});

/**
 * A pricing failure that is not a validation failure still has to be readable.
 *
 * Neither of these is an `AppError`, and neither is reachable from a route
 * today — the schema refuses the unquotable request above, and no deployment
 * selects the unwired adapter. That is exactly why they are tested here: the
 * day somebody wires a vendor, or adds a second caller that does not validate
 * first, the answer must not be a 500 that reads like a broken container.
 */
describe("a pricing failure never answers with a stack", () => {
  const thrower = Router();
  thrower.post(
    "/unquotable",
    asyncRoute(async () => {
      throw new UnquotableScenarioError("A loan of nothing prices at nothing. Refusing to quote.");
    }),
  );
  thrower.post(
    "/not-wired",
    asyncRoute(async () => {
      throw new PricingNotWiredError(
        "No pricing endpoint is configured, so there is nobody to ask.",
      );
    }),
  );

  async function call(path: string) {
    const user = await createUser();
    return callAs<GateBody>(user.id, [thrower], "POST", path, {}, "/api/pricing-errors");
  }

  it("gives an unquotable scenario a 4xx and a code", async () => {
    const res = await call("/unquotable");
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("UNQUOTABLE_LOAN");
    readable(res.body.error?.message);
    // The error's own message names a loan amount and is written for whoever
    // operates this. What reaches the borrower is ours.
    expect(res.body.error?.message).not.toMatch(/Refusing to quote/);
  });

  it("gives an adapter with no vendor behind it a 503 and the same code screen 1 uses", async () => {
    const res = await call("/not-wired");
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("NO_RATE_QUOTED");
    readable(res.body.error?.message);
    expect(res.body.error?.message).not.toMatch(/endpoint/);
  });
});

const WHOLE_PRODUCT = "loan_files_quote_a_whole_product_or_none";

describe("a file carries a whole quoted product or none of one", () => {
  it("refuses a product code beside a rate nobody quoted", async () => {
    const file = await createLoanFile();
    // The ordinary vendor-mapping bug: the adapter answered without the field,
    // so Prisma writes SQL NULL beside a non-null product code.
    await expect(
      prisma.loanFile.update({
        where: { id: file.id },
        data: { productCode: "CONF-30-FIXED", termMonths: 360, noteRate: null },
      }),
    ).rejects.toThrow(WHOLE_PRODUCT);
  });

  it("refuses a rate of zero, which is the one bad rate that reads as a number", async () => {
    const file = await createLoanFile();
    await expect(
      prisma.loanFile.update({
        where: { id: file.id },
        data: { productCode: "CONF-30-FIXED", termMonths: 360, noteRate: 0 },
      }),
    ).rejects.toThrow(WHOLE_PRODUCT);
  });

  it("refuses a term of zero months for the same reason", async () => {
    const file = await createLoanFile();
    await expect(
      prisma.loanFile.update({
        where: { id: file.id },
        data: { productCode: "CONF-30-FIXED", termMonths: 0, noteRate: 6.25 },
      }),
    ).rejects.toThrow(WHOLE_PRODUCT);
  });

  it("allows the whole product, and allows none of it", async () => {
    const bare = await createLoanFile();
    await expect(loadLoanFile(bare.id)).resolves.toMatchObject({ product: null });

    const quoted = await createLoanFile();
    await prisma.loanFile.update({
      where: { id: quoted.id },
      data: {
        productCode: "CONF-30-FIXED",
        termMonths: 360,
        noteRate: 6.25,
      },
    });
    await expect(loadLoanFile(quoted.id)).resolves.toMatchObject({
      product: { productCode: "CONF-30-FIXED", termMonths: 360, noteRate: 6.25 },
    });
  });

  /**
   * The second half of one promise, reached by removing the first.
   *
   * `repository.ts` read the rate as `numOr(row.noteRate, 0)` beside a `?? 360`
   * for the term, so a half-quoted row came back as a product priced at zero
   * percent — and zero does not read as missing anywhere downstream. It
   * amortizes. `housingPitia` records a payment computed from it as a
   * derivation with a formula beside it, no input is blocked, and the decision
   * has nothing to refer on.
   *
   * The constraint above means no such row can be written any more, which is
   * also why the constraint has to come off to reach the mapping at all. Rows
   * written before it existed are the case this defends, and dropping it here
   * is the only way to have one.
   */
  it("reads a half-quoted row as no product rather than as zero percent", async () => {
    const file = await createLoanFile();
    await prisma.$executeRawUnsafe(`ALTER TABLE "loan_files" DROP CONSTRAINT "${WHOLE_PRODUCT}"`);
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "loan_files" SET "product_code" = 'CONF-30-FIXED', "term_months" = 360, "note_rate" = NULL WHERE "id" = $1::uuid`,
        file.id,
      );
      const loaded = await loadLoanFile(file.id);
      expect(loaded?.product).toBeNull();
    } finally {
      // The row goes before the constraint comes back, so what is restored is
      // the migration's constraint and not a weakened copy of it. A test that
      // left this table without its CHECK would take every later test's
      // guarantee with it.
      await prisma.loanFile.delete({ where: { id: file.id } });
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "loan_files" ADD CONSTRAINT "${WHOLE_PRODUCT}" CHECK (
           ("product_code" IS NULL AND "term_months" IS NULL AND "note_rate" IS NULL)
           OR ("product_code" IS NOT NULL AND "term_months" IS NOT NULL AND "note_rate" IS NOT NULL
               AND "term_months" > 0 AND "note_rate" > 0)
         )`,
      );
    }
  });
});
