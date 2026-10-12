/**
 * The bank comes before the questions (12 October 2026).
 *
 * Three promises the swap makes, each against a real Postgres. The stranded
 * files: a file parked at DECLARATIONS under the old order had finished the
 * credit pull and not reached the bank, which under the new order is a file
 * at BANK, and the migration says so; a file at BANK keeps its label. The
 * bank route: linking hands a file to the questions, unless the applicant
 * already answered them (the old order, or "Answer the questions first" on
 * the bank screen), in which case the bank was the last step before the
 * review. And the three lists that name the order agree.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { REQUIREMENTS } from "@hm/requirements";
import { FLOW_STAGES } from "@hm/shared";
import { connectorRouter } from "../routes/connectors.js";
import { declarationRouter } from "../routes/declarations.js";
import { fileRouter } from "../routes/files.js";
import { loadLoanFile } from "../services/repository.js";
import { STAGE_ORDER } from "../services/stage.js";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const MIGRATION = new URL(
  "../../../../packages/db/prisma/migrations/20261012170000_the_bank_comes_before_the_questions/migration.sql",
  import.meta.url,
);

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

const DANA = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: null,
  isMilitary: false,
  demographics: null,
};

/** Section 5 with nothing to declare, a current rental, and the land. */
const NOTHING_TO_DECLARE = {
  declaration: {
    intentToOccupy: "Yes",
    homeownerPastThreeYears: "No",
    specialBorrowerSellerRelationship: false,
    undisclosedBorrowedFunds: false,
    undisclosedMortgageApplication: false,
    undisclosedCreditApplication: false,
    propertyProposedCleanEnergyLien: false,
    undisclosedComakerOfNote: false,
    outstandingJudgments: false,
    presentlyDelinquent: false,
    partyToLawsuit: false,
    priorPropertyDeedInLieuConveyed: false,
    priorPropertyShortSaleCompleted: false,
    priorPropertyForeclosureCompleted: false,
    bankruptcy: false,
    bankruptcyChapters: [],
  },
  residences: [{ residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 1_800 }],
  propertyEstateType: "FeeSimple",
};

/** A file with its applicant on it and her authorization, ready to pull. */
async function authorized() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA)).status).toBe(
    201,
  );
  const dana = (await loadLoanFile(fileId))!.borrowers[0]!;
  for (const kind of ["verification_authorization", "econsent"]) {
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind,
      borrowerId: dana.id,
    });
  }
  return { user, fileId };
}

const stageOf = (id: string) =>
  prisma.loanFile
    .findUniqueOrThrow({ where: { id }, select: { stage: true } })
    .then((f) => f.stage);

describe("the three lists that name the order", () => {
  it("agree, with the bank before the questions", () => {
    expect(STAGE_ORDER.map((s) => s.toLowerCase())).toEqual([...FLOW_STAGES]);
    expect(STAGE_ORDER.indexOf("BANK")).toBeLessThan(STAGE_ORDER.indexOf("DECLARATIONS"));
  });

  it("include the sheet's screen column, through the registry it generates", () => {
    // The ordinal is what sorts outstanding work, so a sheet that numbered
    // the screens in another order would list Section 5 before the bank on
    // the review while the stepper walked them the other way round.
    const byOrdinal = [
      ...new Map(REQUIREMENTS.map((r) => [r.screenOrdinal, r.screen] as const)).entries(),
    ]
      .sort((a, b) => a[0] - b[0])
      .map(([, screen]) => screen);
    expect(byOrdinal).toEqual(FLOW_STAGES.slice(0, byOrdinal.length));
    expect(byOrdinal.indexOf("bank")).toBeLessThan(byOrdinal.indexOf("declarations"));
  });
});

describe("the stranded files", () => {
  it("moves a file parked at the questions under the old order to the bank, and leaves the rest alone", async () => {
    const parked = await createLoanFile({ stage: "DECLARATIONS" });
    const atBank = await createLoanFile({ stage: "BANK" });
    const past = await createLoanFile({ stage: "PAYROLL" });

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, "utf8"));

    expect(await stageOf(parked.id)).toBe("BANK");
    expect(await stageOf(atBank.id)).toBe("BANK");
    expect(await stageOf(past.id)).toBe("PAYROLL");
  });
});

describe("the bank route", () => {
  it("hands the file to the questions", async () => {
    const h = await authorized();
    await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/credit`, {});
    expect(await stageOf(h.fileId)).toBe("BANK");

    const res = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await loadLoanFile(h.fileId))!.stage).toBe("declarations");
  });

  it("hands a file whose applicant already answered them past the questions", async () => {
    // The old order's shape, and the shape "Answer the questions first"
    // leaves: the questions answered, the bank not yet linked. The stage is
    // put back to BANK by hand because the declaration save moves it on.
    const h = await authorized();
    await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/credit`, {});
    const answered = await callAs(
      h.user.id,
      [declarationRouter],
      "POST",
      `/${h.fileId}/declaration`,
      NOTHING_TO_DECLARE,
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(201);
    await prisma.loanFile.update({ where: { id: h.fileId }, data: { stage: "BANK" } });

    const res = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await loadLoanFile(h.fileId))!.stage).toBe("payroll");
  });
});
