/**
 * The fifth screen, from the body it posts to the requirements it retires.
 *
 * `declaration-route.test.ts` holds the route to its refusals — a partial body,
 * a follow-up under the wrong trigger, a bigint reaching `res.json`. This is
 * the other half: the answers a person actually gives, all seventeen of them,
 * arriving through the route and coming back out of the projection with each
 * one still attached to the question it was the answer to.
 *
 * Thirteen of them are booleans, and a mapping that swapped two of them would
 * be invisible to a test that answered No to everything — so no two adjacent
 * questions here share an answer. The one that matters most is the swap that
 * would put "yes, I declared bankruptcy" somewhere else on a document the
 * borrower signs.
 *
 * The requirements are the rest of it. Six rows went into the sheet with this
 * screen, and the reason they are rows rather than a check inside the route is
 * that the engine cannot report work that has no requirement. Three of them
 * are conditional on what the borrower said, which is the only place in the
 * registry where a condition reads an answer rather than a retrieval.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { assessAll, progress } from "@hm/requirements";
import type { BorrowerDeclaration } from "@hm/shared";
import type { BorrowerInput } from "../services/party.js";
import { declarationRouter } from "../routes/declarations.js";
import { loadLoanFile } from "../services/repository.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const dana: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5125550142",
  dateOfBirth: "1988-04-04",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "9 Fixture Ave", city: "Austin", state: "TX", postalCode: "78701" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  statedMonthlyIncome: 8_500,
};

async function applicationFile(stage: "CREDIT" | "BANK" = "CREDIT") {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id, stage });
  const borrower = await saveBorrower(file.id, dana);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId: borrower.partyId, role: "PRIMARY_BORROWER" },
  });
  return { user, file };
}

/**
 * Every question answered, and no two neighbors alike.
 *
 * The three conditional follow-ups are all taken, so this one body reaches all
 * six requirements: the homeowner branch, the bankruptcy chapters and the
 * previous address.
 */
const EVERY_ANSWER = {
  declaration: {
    intentToOccupy: "Yes",
    homeownerPastThreeYears: "Yes",
    priorPropertyUsage: "SecondHome",
    priorPropertyTitle: "JointWithSpouse",
    fhaSecondaryResidence: null,
    specialBorrowerSellerRelationship: true,
    undisclosedBorrowedFunds: true,
    undisclosedBorrowedFundsAmount: 9_000,
    undisclosedMortgageApplication: false,
    undisclosedCreditApplication: true,
    propertyProposedCleanEnergyLien: false,
    undisclosedComakerOfNote: true,
    outstandingJudgments: false,
    presentlyDelinquent: true,
    partyToLawsuit: false,
    priorPropertyDeedInLieuConveyed: true,
    priorPropertyShortSaleCompleted: false,
    priorPropertyForeclosureCompleted: true,
    bankruptcy: true,
    bankruptcyChapters: ["ChapterThirteen"],
    explanations: { C: "A loan from my brother for the closing costs." },
  },
  residences: [
    { residencyType: "Current", basis: "Rent", durationMonths: 14, monthlyRent: 2_400 },
    {
      residencyType: "Prior",
      basis: "Rent",
      durationMonths: 36,
      monthlyRent: 1_900,
      addressLineText: "12 Old Street",
      addressUnit: "4",
      cityName: "Austin",
      stateCode: "TX",
      postalCode: "78701",
    },
  ],
};

/** A borrower with nothing to declare, which is the ordinary shape. */
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
  },
  residences: [{ residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 1_850 }],
};

const post = (userId: string, fileId: string, body: unknown) =>
  callAs(userId, [declarationRouter], "POST", `/${fileId}/declaration`, body);

const idsSatisfied = (file: Awaited<ReturnType<typeof loadLoanFile>>) =>
  assessAll(file!)
    .filter((a) => a.satisfaction.status === "satisfied")
    .map((a) => a.requirement.id);

describe("what the screen posts", () => {
  it("comes back attached to the question it answered", async () => {
    const { user, file } = await applicationFile();
    expect((await post(user.id, file.id, EVERY_ANSWER)).status).toBe(201);

    const loaded = await loadLoanFile(file.id);
    const said = loaded!.declaration!;
    for (const [field, answer] of Object.entries(EVERY_ANSWER.declaration)) {
      if (field === "bankruptcyChapters" || field === "explanations") continue;
      expect(said[field as keyof BorrowerDeclaration], field).toEqual(answer);
    }
    expect(said.bankruptcyChapters).toEqual(["ChapterThirteen"]);
    expect(said.explanations).toEqual({ C: "A loan from my brother for the closing costs." });

    // The residences come back in dollars, with the address on the row that
    // carries one and nothing on the row that reads the pinned fact.
    expect(loaded!.residences).toHaveLength(2);
    const current = loaded!.residences.find((r) => r.residencyType === "Current")!;
    expect(current).toMatchObject({ basis: "Rent", durationMonths: 14, monthlyRent: 2_400 });
    expect(current.addressLineText).toBeNull();
    expect(loaded!.residences.find((r) => r.residencyType === "Prior")).toMatchObject({
      addressLineText: "12 Old Street",
      cityName: "Austin",
      stateCode: "TX",
      postalCode: "78701",
    });
  });

  it("is unasked rather than answered no, before anybody answers", async () => {
    // The distinction the whole screen exists for. A file nobody has asked
    // reads null here, and screen 5 says so instead of printing a clean set.
    const { file } = await applicationFile();
    const loaded = await loadLoanFile(file.id);
    expect(loaded!.declaration).toBeNull();
    expect(loaded!.residences).toEqual([]);
  });

  it("moves the file to the declarations stage, and never backwards", async () => {
    const { user, file } = await applicationFile();
    expect((await post(user.id, file.id, NOTHING_TO_DECLARE)).status).toBe(201);
    expect((await loadLoanFile(file.id))!.stage).toBe("declarations");

    // A borrower correcting one answer after connecting their bank is not
    // dragged back to this screen: the stage is a high-water mark.
    const later = await applicationFile("BANK");
    expect((await post(later.user.id, later.file.id, NOTHING_TO_DECLARE)).status).toBe(201);
    expect((await loadLoanFile(later.file.id))!.stage).toBe("bank");
  });
});

describe("the six requirements this screen carries", () => {
  it("retires all six when the borrower takes every branch", async () => {
    const { user, file } = await applicationFile();
    const before = await loadLoanFile(file.id);
    expect(idsSatisfied(before)).not.toContain("APP-022");

    await post(user.id, file.id, EVERY_ANSWER);
    const after = await loadLoanFile(file.id);

    expect(idsSatisfied(after)).toEqual(
      expect.arrayContaining(["APP-022", "APP-023", "APP-024", "APP-025", "APP-026", "APP-027"]),
    );
  });

  it("does not ask a follow-up question of a borrower it was never put to", async () => {
    const { user, file } = await applicationFile();
    await post(user.id, file.id, NOTHING_TO_DECLARE);
    const assessed = assessAll((await loadLoanFile(file.id))!);
    const applies = (id: string) => assessed.find((a) => a.requirement.id === id)!.applies;

    // No bankruptcy, no prior home, two years in the same place — three
    // requirements that DO NOT apply, which is a different answer from three
    // that are outstanding.
    expect(applies("APP-024")).toBe(false);
    expect(applies("APP-025")).toBe(false);
    expect(applies("APP-027")).toBe(false);
    expect(applies("APP-022")).toBe(true);
  });

  it("cannot know whether they apply until somebody is asked", async () => {
    // Three-valued, like every other condition in the registry: an unasked
    // borrower is "we might still ask", not a borrower with nothing to
    // declare. Collapsing that to false is how a file reports itself finished
    // with questions nobody has put.
    const { file } = await applicationFile();
    const assessed = assessAll((await loadLoanFile(file.id))!);
    for (const id of ["APP-024", "APP-025", "APP-027"]) {
      expect(assessed.find((a) => a.requirement.id === id)!.applies, id).toBeNull();
    }
  });

  it("never moves the satisfied count backwards", async () => {
    // Rule 2, on the one change that could trip it: six always-applicable
    // rows landed in the registry with this screen, and answering them may
    // only ever raise what is satisfied. The failure this guards is the
    // 23 → 21 of the payroll connection, arriving from the sheet instead.
    const { user, file } = await applicationFile();
    const before = progress((await loadLoanFile(file.id))!);
    await post(user.id, file.id, NOTHING_TO_DECLARE);
    const after = progress((await loadLoanFile(file.id))!);

    expect(after.satisfied).toBeGreaterThan(before.satisfied);
    expect(after.undetermined).toBeLessThan(before.undetermined);
  });
});
