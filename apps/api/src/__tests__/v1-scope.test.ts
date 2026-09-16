/**
 * What V1 takes, asked of the route and of the database separately.
 *
 * Two scope decisions, and the reason both are here rather than only in a zod
 * enum is the reason every other invariant in this repository ended up in
 * Postgres: a schema in one handler is a promise the next handler does not
 * make, and screen 1 is not the only door onto `loan_files`.
 *
 * - **No cash-out refinance.** The option is gone from screen 1, the two
 *   routes that take a purpose refuse it with a sentence a borrower can read,
 *   and `loan_files_v1_scope` refuses the row however it arrived.
 * - **No guarantor.** The enum has four members and a co-signer is a
 *   `NON_OCCUPANT_CO_BORROWER`, who signs the note and reaches Desktop
 *   Underwriter as a Borrower.
 *
 * The database halves are asked with raw SQL rather than through Prisma,
 * because Prisma's generated types are what stop the mistake in TypeScript and
 * a test that could not compile is not a test of the column.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { CASH_OUT_NOT_YET } from "@hm/shared";
import { fileRouter } from "../routes/files.js";
import { propertyRouter } from "../routes/property.js";
import { ensureApplicationParty } from "../services/applications.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** A credit request on its own file, with no parties on it yet. */
async function anApplication(): Promise<{ id: string }> {
  const file = await createLoanFile({ userId: (await createUser()).id });
  return prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
}

/** Screen 1's body, as the web posts it. */
const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

describe("a cash-out refinance, which V1 does not underwrite", () => {
  it("is refused at file creation, with the words screen 1 shows", async () => {
    const user = await createUser();
    const before = await prisma.loanFile.count();
    const res = await callAs<{ error: { message: string; code: string } }>(
      user.id,
      [fileRouter],
      "POST",
      "/",
      { ...SCREEN_ONE, purpose: "cash_out_refinance" },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LOAN_PURPOSE_OUT_OF_SCOPE");
    expect(res.body.error.message).toBe(CASH_OUT_NOT_YET);
    // And nothing was written on the way to being refused: the check is ahead
    // of the rate quote and of the transaction that mints the application.
    expect(await prisma.loanFile.count()).toBe(before);
  });

  it("is refused on a file that already exists and is trying to become one", async () => {
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    expect(created.status).toBe(201);

    const res = await callAs<{ error: { message: string } }>(
      user.id,
      [fileRouter],
      "PATCH",
      `/${created.body.id}`,
      { purpose: "cash_out_refinance" },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe(CASH_OUT_NOT_YET);
    const row = await prisma.loanFile.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { purpose: true },
    });
    expect(row.purpose).toBe("PURCHASE");
  });

  it("is refused by the affordability gate, before anybody is quoted a payment", async () => {
    // The gate answers with a monthly payment. Quoting one would tell somebody
    // their cash-out refinance works, a screen before the file exists.
    const user = await createUser();
    const res = await callAs<{ error: { code: string } }>(
      user.id,
      [propertyRouter],
      "POST",
      "/affordability",
      {
        valueOrPrice: 415_000,
        downPayment: 83_000,
        statedMonthlyIncome: 9_400,
        purpose: "cash_out_refinance",
        propertyType: "single_family",
        state: "TX",
      },
      "/api/property",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LOAN_PURPOSE_OUT_OF_SCOPE");
  });

  it("is refused by the database when no route is involved", async () => {
    // The half that survives a new writer. A seed, a script or a route nobody
    // has written yet reaches the table directly, and this is what answers.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "loan_files" (id, stage, purpose, updated_at) VALUES ($1, 'PROPERTY_LOAN', 'CASH_OUT_REFINANCE', now())`,
        randomUUID(),
      ),
    ).rejects.toThrow(/cash-out refinance is out of scope/);
  });

  it("leaves a file that already says cash-out saying it", async () => {
    // The decision about a file opened before the scope was settled: nobody
    // rewrites a borrower's stated purpose behind their back. The trigger
    // fires on a row ARRIVING in cash-out or MOVING into it, so a row already
    // sitting there can still be read and still be edited in every other
    // column — it just cannot be saved again from screen 1 until the borrower
    // picks a loan we take.
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`ALTER TABLE "loan_files" DISABLE TRIGGER loan_files_v1_scope`);
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "loan_files" (id, stage, purpose, updated_at) VALUES ($1, 'PROPERTY_LOAN', 'CASH_OUT_REFINANCE', now())`,
        id,
      );
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "loan_files" ENABLE TRIGGER loan_files_v1_scope`);
    }

    const moved = await prisma.loanFile.update({
      where: { id },
      data: { valueOrPrice: 500_000 },
      select: { purpose: true, valueOrPrice: true },
    });
    expect(moved.purpose).toBe("CASH_OUT_REFINANCE");
    expect(Number(moved.valueOrPrice)).toBe(500_000);

    // And out of it, which is the way forward for that borrower.
    const out = await prisma.loanFile.update({
      where: { id },
      data: { purpose: "RATE_TERM_REFINANCE" },
      select: { purpose: true },
    });
    expect(out.purpose).toBe("RATE_TERM_REFINANCE");
  });
});

describe("a co-signer, who is a borrower", () => {
  it("has no guarantor role to be put in", async () => {
    // Desktop Underwriter's eight party roles carry no guarantor, and neither
    // does the MISMO chain the submission is written against — so a party in
    // that role could not be conveyed at all, and the enum does not have one.
    const app = await anApplication();
    const party = await createParty();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "application_parties" (id, application_id, party_id, role) VALUES ($1, $2, $3, 'GUARANTOR')`,
        randomUUID(),
        app.id,
        party.id,
      ),
    ).rejects.toThrow(/invalid input value for enum "ApplicationPartyRole": "GUARANTOR"/);
  });

  it("is a non-occupant co-borrower, and takes a position like one", async () => {
    // The role that replaces it is a BORROWING one: it carries a
    // borrower_ordinal, it emits a BORROWER element, and it counts against the
    // four. That is what a co-signer is on an agency conventional loan — they
    // sign the note and appear on the URLA.
    const app = await anApplication();
    const applicant = await createParty();
    const cosigner = await createParty();
    await ensureApplicationParty(prisma, app.id, applicant.id, "PRIMARY_BORROWER");
    const edge = await ensureApplicationParty(
      prisma,
      app.id,
      cosigner.id,
      "NON_OCCUPANT_CO_BORROWER",
    );
    expect(edge.borrowerOrdinal).toBe(2);
  });
});
