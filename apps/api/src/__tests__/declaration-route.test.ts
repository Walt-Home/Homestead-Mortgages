/**
 * The route that asks Section 5, and the two promises it is easiest to break.
 *
 * The first is refusal. Twelve of these answers are NOT NULL in the table, and
 * a route that let a half-filled body through would either 500 on a constraint
 * or — worse, once somebody "fixes" the 500 — complete the missing half with
 * `false` on a document the borrower signs. So every required field is tried
 * missing, one at a time, and the route has to say no to each.
 *
 * A missing field is the easy half. The harder one is a body the schema likes
 * and the database does not: every CHECK, unique pair and deferred trigger
 * under these two tables is reachable from a well-formed request, and each one
 * that only the database catches arrives as a 500 with no field named. So each
 * is tried too, and the route has to name the field rather than let Postgres
 * answer for it.
 *
 * The second is the wire. `undisclosed_borrowed_funds_cents` and
 * `monthly_rent_cents` are bigint columns and `res.json` throws on a bigint, so
 * a response that carried one straight out of Prisma would be a 500 on the one
 * submission that actually has a borrowed-funds amount in it. The conversion is
 * at the edge, and this is what says so.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { BorrowerInput } from "../services/party.js";
import { declarationRouter } from "../routes/declarations.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const nadia: BorrowerInput = {
  firstName: "Nadia",
  lastName: "Okonkwo",
  email: "nadia@example.test",
  phone: "5555550188",
  dateOfBirth: "1990-02-02",
  ssnVaultHandle: "vault:nadia:1",
  currentAddress: { line1: "5 Fixture Ave", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  statedMonthlyIncome: 9000,
};

/** A file that has become an application, with its borrower on the edge. */
async function applicationFile() {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, nadia);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId: borrower.partyId, role: "PRIMARY_BORROWER" },
  });
  return { user, file, borrower };
}

/** Every answer No, the occupying branch taken, and one current residence. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    declaration: {
      intentToOccupy: "Yes",
      homeownerPastThreeYears: "No",
      undisclosedBorrowedFunds: false,
      undisclosedMortgageApplication: false,
      undisclosedCreditApplication: false,
      propertyProposedCleanEnergyLien: false,
      undisclosedComakerOfNote: false,
      outstandingJudgments: false,
      presentlyDelinquent: false,
      priorPropertyDeedInLieuConveyed: false,
      priorPropertyShortSaleCompleted: false,
      priorPropertyForeclosureCompleted: false,
      bankruptcy: false,
      ...overrides,
    },
    residences: [
      { residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2150 },
    ],
  };
}

/**
 * The twelve DU requires. The optional five are optional for a reason apiece —
 * a government file, an FHA file, a purchase, and the two that only exist once
 * the borrower says they have owned before — so they are not on this list.
 */
const REQUIRED_FIELDS = [
  "intentToOccupy",
  "undisclosedBorrowedFunds",
  "undisclosedMortgageApplication",
  "undisclosedCreditApplication",
  "propertyProposedCleanEnergyLien",
  "undisclosedComakerOfNote",
  "outstandingJudgments",
  "presentlyDelinquent",
  "priorPropertyDeedInLieuConveyed",
  "priorPropertyShortSaleCompleted",
  "priorPropertyForeclosureCompleted",
  "bankruptcy",
] as const;

describe("POST /files/:id/declaration", () => {
  it.each(REQUIRED_FIELDS)("refuses a submit with no %s", async (field) => {
    const { user, file } = await applicationFile();
    const partial = body();
    delete (partial.declaration as Record<string, unknown>)[field];

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      partial,
    );

    expect(res.status, `a missing ${field} was accepted`).toBe(400);
  });

  it("refuses a submit with no residence at all", async () => {
    const { user, file } = await applicationFile();
    const res = await callAs(user.id, [declarationRouter], "POST", `/${file.id}/declaration`, {
      ...body(),
      residences: [],
    });

    expect(res.status).toBe(400);
  });

  it("serializes a response carrying both bigint columns", async () => {
    // The one submission that populates them: a borrowed-funds amount and a
    // rent. Straight out of Prisma both are bigints, and `res.json` throws on
    // one — which arrives as a 500 from the error handler, not as a wrong
    // number, so the assertion on the status is half the test.
    const { user, file } = await applicationFile();
    const res = await callAs<{
      declaration: {
        declaration: { undisclosedBorrowedFundsAmount: number };
        residences: { monthlyRent: number }[];
      };
    }>(user.id, [declarationRouter], "POST", `/${file.id}/declaration`, {
      ...body({ undisclosedBorrowedFunds: true, undisclosedBorrowedFundsAmount: 12_500 }),
      residences: [
        { residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2150 },
      ],
    });

    expect(res.status).toBe(201);
    // Dollars on the way out, cents in the column.
    expect(res.body.declaration.declaration.undisclosedBorrowedFundsAmount).toBe(12_500);
    expect(res.body.declaration.residences[0]!.monthlyRent).toBe(2150);

    const row = await prisma.duDeclaration.findFirstOrThrow({
      select: { undisclosedBorrowedFundsCents: true },
    });
    expect(row.undisclosedBorrowedFundsCents).toBe(1_250_000n);
  });

  it("keeps the borrower's own words across a round trip", async () => {
    const { user, file } = await applicationFile();
    const explanations = {
      M: "Chapter 7 in 2019, discharged 2020. Medical bills after a hospital stay.",
      G: "A judgment from a disputed gym membership, satisfied in 2021.",
    };

    const posted = await callAs(user.id, [declarationRouter], "POST", `/${file.id}/declaration`, {
      ...body({
        outstandingJudgments: true,
        bankruptcy: true,
        bankruptcyChapters: ["ChapterSeven"],
        explanations,
      }),
    });
    expect(posted.status).toBe(201);

    const read = await callAs<{ declaration: { declaration: { explanations: unknown } } }>(
      user.id,
      [declarationRouter],
      "GET",
      `/${file.id}/declaration`,
    );

    expect(read.body.declaration.declaration.explanations).toEqual(explanations);
    // And it goes no further than the file: the DU emission path has no
    // element for an explanation at all, which `@hm/du`'s own suite asserts
    // against the generated cardinality table.
  });
});

/** The same body, with the residences replaced. */
function withResidences(residences: Record<string, unknown>[]) {
  return { ...body(), residences };
}

const CURRENT = { residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2150 };
const PRIOR = {
  residencyType: "Prior",
  basis: "Rent",
  durationMonths: 40,
  monthlyRent: 1800,
  addressLineText: "88 Willow Lane",
  cityName: "Demo City",
  stateCode: "CA",
  postalCode: "94001",
};

/**
 * Every rule the two tables carry, as a body that breaks it and the field the
 * refusal has to name.
 *
 * `constraint` is the thing in the database this mirrors. A constraint that is
 * renamed or dropped should bring its row here with it — that is the whole
 * reason the name is written down rather than described.
 */
const REFUSALS: readonly {
  readonly what: string;
  readonly constraint: string;
  readonly field: string;
  readonly body: Record<string, unknown>;
}[] = [
  {
    what: "a current residence carrying an address",
    constraint: "du_residences_current_borrows_the_pinned_address",
    field: "residences.0.addressLineText",
    body: withResidences([{ ...CURRENT, addressLineText: "12 Elm Street" }]),
  },
  {
    what: "a prior residence with no address",
    constraint: "du_residences_prior_carries_its_own_address",
    field: "residences.1.addressLineText",
    body: withResidences([CURRENT, { residencyType: "Prior", basis: "Own", durationMonths: 40 }]),
  },
  {
    what: "a rent amount on an owned home",
    constraint: "du_residences_rent_amount_needs_a_rent_basis",
    field: "residences.0.monthlyRent",
    body: withResidences([
      { residencyType: "Current", basis: "Own", durationMonths: 30, monthlyRent: 1200 },
    ]),
  },
  {
    what: "a rent wider than the wire takes",
    constraint: "du_residences_rent_fits_amount_9_2",
    field: "residences.0.monthlyRent",
    body: withResidences([{ ...CURRENT, monthlyRent: 1_000_000_000 }]),
  },
  {
    what: "two current residences",
    constraint: "du_residences_application_party_id_residency_type_key",
    field: "residences",
    body: withResidences([CURRENT, { ...CURRENT, durationMonths: 12 }]),
  },
  {
    what: "two prior residences",
    constraint: "du_residences_application_party_id_residency_type_key",
    field: "residences",
    body: withResidences([CURRENT, PRIOR, { ...PRIOR, durationMonths: 12 }]),
  },
  {
    what: "a prior residence and no current one",
    constraint: "du_residences_keep_a_current_home",
    field: "residences",
    body: withResidences([PRIOR]),
  },
  {
    what: "a declared bankruptcy naming no chapter",
    constraint: "du_bankruptcy_chapters_match_the_indicator_decl",
    field: "declaration.bankruptcyChapters",
    body: body({ bankruptcy: true }),
  },
  {
    what: "a chapter with no bankruptcy behind it",
    constraint: "du_bankruptcy_chapters_match_the_indicator_filing",
    field: "declaration.bankruptcyChapters",
    body: body({ bankruptcy: false, bankruptcyChapters: ["ChapterSeven"] }),
  },
  {
    what: "the same chapter named twice",
    constraint: "du_bankruptcy_filings_declaration_id_chapter_key",
    field: "declaration.bankruptcyChapters",
    body: body({ bankruptcy: true, bankruptcyChapters: ["ChapterSeven", "ChapterSeven"] }),
  },
  {
    what: "borrowed funds with no amount",
    constraint: "du_declarations_borrowed_amount_follows_indicator",
    field: "declaration.undisclosedBorrowedFundsAmount",
    body: body({ undisclosedBorrowedFunds: true }),
  },
  {
    what: "an amount with no borrowed funds",
    constraint: "du_declarations_borrowed_amount_follows_indicator",
    field: "declaration.undisclosedBorrowedFundsAmount",
    body: body({ undisclosedBorrowedFunds: false, undisclosedBorrowedFundsAmount: 500 }),
  },
  {
    what: "an amount wider than the wire takes",
    constraint: "du_declarations_borrowed_amount_fits_amount_9_2",
    field: "declaration.undisclosedBorrowedFundsAmount",
    body: body({ undisclosedBorrowedFunds: true, undisclosedBorrowedFundsAmount: 1_000_000_000 }),
  },
  {
    what: "an occupying borrower who skipped the homeowner question",
    constraint: "du_declarations_homeowner_follows_intent",
    field: "declaration.homeownerPastThreeYears",
    body: body({ homeownerPastThreeYears: null }),
  },
  {
    what: "a past homeowner who did not say how the home was used",
    constraint: "du_declarations_prior_usage_follows_homeowner",
    field: "declaration.priorPropertyUsage",
    body: body({ homeownerPastThreeYears: "Yes" }),
  },
];

/** The fields a validation failure named, as dotted paths. */
function fieldsNamed(payload: unknown): string[] {
  const details = (payload as { error?: { details?: { path?: (string | number)[] }[] } }).error
    ?.details;
  return (details ?? []).map((issue) => (issue.path ?? []).join("."));
}

describe("the route refuses what the database would refuse", () => {
  it.each(REFUSALS)("says no to $what ($constraint)", async ({ field, body: payload }) => {
    const { user, file } = await applicationFile();

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      payload,
    );

    // 400, not 500: a constraint the route does not mirror still refuses the
    // write, but it refuses it as a server fault with nothing the caller can
    // act on.
    expect(res.status).toBe(400);
    expect(fieldsNamed(res.body)).toContain(field);
    // And nothing was written on the way to being refused.
    expect(await prisma.duDeclaration.count()).toBe(0);
    expect(await prisma.duResidence.count()).toBe(0);
  });
});

/**
 * Nothing fills a declaration from connector output.
 *
 * The database refuses a machine principal, which covers the agent that writes
 * one as itself. It does not cover the shape this repo actually has today —
 * screen 4 reading "no bankruptcy" off a credit pull and posting it as the
 * borrower — so the second half of the promise is that only one file in the
 * product writes these tables, and that file has never heard of a snapshot.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("a declaration is asked, never derived", () => {
  const sources = [join(repoRoot, "apps"), join(repoRoot, "packages")].flatMap((d) =>
    sourceFiles(d),
  );

  it("has exactly one writer in the whole product", () => {
    const writers = sources.filter((f) =>
      /\b(duDeclaration|duBankruptcyFiling|duResidence)\.(create|createMany|update|updateMany|upsert)\b/.test(
        readFileSync(f, "utf8"),
      ),
    );

    expect(writers.map((f) => f.slice(repoRoot.length + 1))).toEqual([
      "apps/api/src/services/declarations.ts",
    ]);
  });

  it("reads no connector snapshot in that writer", () => {
    const writer = readFileSync(join(repoRoot, "apps/api/src/services/declarations.ts"), "utf8");

    // A clean credit report is absence of evidence, not a "no". The only
    // mention of a snapshot in this file is the sentence saying so.
    const code = writer.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/[Ss]napshot/);
  });
});
