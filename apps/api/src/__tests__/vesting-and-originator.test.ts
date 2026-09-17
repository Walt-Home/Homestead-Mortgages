/**
 * How title will read, and who originated: the two writers item 3 was missing.
 *
 * The vesting is asked on the review screen and stated by the applicant; the
 * signature attests to it and is refused without it. The originator is on
 * every application from birth, as the two deal-party rows a casefile cannot
 * do without, from configuration or the placeholders that stand in for it.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { PLACEHOLDER_ORIGINATOR } from "@hm/du";
import { applicationRouter } from "../routes/application.js";
import { fileRouter } from "../routes/files.js";
import { vestingRouter } from "../routes/vesting.js";
import { declarationRouter } from "../routes/declarations.js";
import { loadLoanFile } from "../services/repository.js";
import { appendCoBorrowerWithFacts } from "../services/co-borrowers.js";
import { recordOriginationParties } from "../services/originator.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

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
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: { ethnicity: "declined", race: "declined", sex: "declined" },
  statedMonthlyIncome: 7_400,
};

const THEO = {
  firstName: "Theo",
  lastName: "Okafor",
  email: "theo@example.test",
  phone: "5555550188",
  dateOfBirth: "1984-02-19",
  ssnVaultHandle: "vault:theo:1",
  ssnLast4: "8765",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: false,
  isMilitary: false,
  demographics: null,
};

const SECTION_FIVE = {
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
};

async function anApplication(over: Record<string, unknown> = {}) {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", {
    ...SCREEN_ONE,
    ...over,
  });
  expect(created.status).toBe(201);
  const fileId = created.body.id;
  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA)).status).toBe(
    201,
  );
  return { user, fileId };
}

const vest = (userId: string, fileId: string, body: unknown) =>
  callAs<{ vestings: { status: string; fullName: string; vestingType: string | null }[] }>(
    userId,
    [vestingRouter],
    "POST",
    `/${fileId}/vesting`,
    body,
  );

describe("how title will read", () => {
  it("is stated by the applicant and read back off the file", async () => {
    const { user, fileId } = await anApplication();
    const res = await vest(user.id, fileId, {
      proposed: { fullName: "Dana Whitfield", vestingType: null },
      current: null,
    });
    expect(res.status).toBe(201);
    expect(res.body.vestings).toEqual([
      { status: "Proposed", fullName: "Dana Whitfield", vestingType: null },
    ]);
    const file = (await loadLoanFile(fileId))!;
    expect(file.vestings).toEqual(res.body.vestings);
    // Restated, not duplicated.
    await vest(user.id, fileId, {
      proposed: { fullName: "Dana R. Whitfield", vestingType: null },
    });
    expect((await loadLoanFile(fileId))!.vestings.map((v) => v.fullName)).toEqual([
      "Dana R. Whitfield",
    ]);
  });

  it("wants the manner of holding once two names are on it", async () => {
    const { user, fileId } = await anApplication();
    await appendCoBorrowerWithFacts(fileId, THEO);
    const bare = await vest(user.id, fileId, {
      proposed: { fullName: "Dana Whitfield and Theo Okafor", vestingType: null },
    });
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: { code: "VESTING_TYPE_REQUIRED" } });
    const held = await vest(user.id, fileId, {
      proposed: {
        fullName: "Dana Whitfield and Theo Okafor",
        vestingType: "JointTenantsWithRightOfSurvivorship",
      },
    });
    expect(held.status).toBe(201);
  });

  it("takes a current title only on a refinance", async () => {
    const purchase = await anApplication();
    const refused = await vest(purchase.user.id, purchase.fileId, {
      proposed: { fullName: "Dana Whitfield", vestingType: null },
      current: { fullName: "Dana Whitfield", vestingType: null },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "NOT_A_REFINANCE" } });

    const refinance = await anApplication({ purpose: "rate_term_refinance" });
    const both = await vest(refinance.user.id, refinance.fileId, {
      proposed: { fullName: "Dana Whitfield", vestingType: null },
      current: { fullName: "Dana Whitfield", vestingType: null },
    });
    expect(both.status, JSON.stringify(both.body)).toBe(201);
    expect(both.body.vestings.map((v) => v.status)).toEqual(["Current", "Proposed"]);
  });

  it("is the applicant's to state", async () => {
    const { fileId } = await anApplication();
    const stranger = await createUser();
    const res = await vest(stranger.id, fileId, {
      proposed: { fullName: "Somebody Else", vestingType: null },
    });
    expect(res.status).toBe(404);
    expect(await prisma.duVesting.count({ where: { application: { loanFileId: fileId } } })).toBe(
      0,
    );
  });

  it("has to be stated before the applicant signs", async () => {
    const { user, fileId } = await anApplication();
    await callAs(user.id, [declarationRouter], "POST", `/${fileId}/declaration`, {
      declaration: SECTION_FIVE,
      residences: [{ residencyType: "Current", basis: "Own", durationMonths: 90 }],
      propertyEstateType: "FeeSimple",
    });
    const refused = await callAs(
      user.id,
      [applicationRouter],
      "POST",
      `/${fileId}/sign-application`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "VESTING_REQUIRED" } });
    await vest(user.id, fileId, { proposed: { fullName: "Dana Whitfield", vestingType: null } });
    const signed = await callAs(
      user.id,
      [applicationRouter],
      "POST",
      `/${fileId}/sign-application`,
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
  });
});

describe("who originated", () => {
  it("is on every application from birth, as the two rows a casefile needs", async () => {
    const { fileId } = await anApplication();
    const rows = await prisma.duDealParty.findMany({
      where: { application: { loanFileId: fileId } },
      orderBy: { role: "asc" },
      select: {
        role: true,
        legalEntityName: true,
        firstName: true,
        lastName: true,
        licenseIdentifier: true,
        licenseAuthorityType: true,
      },
    });
    expect(rows).toEqual([
      {
        role: "LoanOriginationCompany",
        legalEntityName: PLACEHOLDER_ORIGINATOR.companyLegalName,
        firstName: null,
        lastName: null,
        licenseIdentifier: PLACEHOLDER_ORIGINATOR.companyNmlsId,
        licenseAuthorityType: "Private",
      },
      {
        role: "LoanOriginator",
        legalEntityName: null,
        firstName: PLACEHOLDER_ORIGINATOR.originatorFirstName,
        lastName: PLACEHOLDER_ORIGINATOR.originatorLastName,
        licenseIdentifier: PLACEHOLDER_ORIGINATOR.originatorNmlsId,
        licenseAuthorityType: "Private",
      },
    ]);
  });

  it("is written once", async () => {
    const { fileId } = await anApplication();
    const app = await prisma.application.findFirstOrThrow({ where: { loanFileId: fileId } });
    await prisma.$transaction((tx) => recordOriginationParties(tx, app.id));
    expect(await prisma.duDealParty.count({ where: { applicationId: app.id } })).toBe(2);
  });
});
