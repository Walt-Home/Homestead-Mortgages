/**
 * Section 5 is asked, and where somebody lives is recorded rather than assumed.
 *
 * Every promise these tables make is a constraint or a trigger, so all of it is
 * against the real Postgres: a suite that mocked the database would see a
 * declaration written by an AI agent, a declared bankruptcy naming no chapter,
 * and a co-borrower flipped to a non-borrowing spouse with their answers still
 * hanging off them.
 *
 * The one that matters most is at the foot of the file. A declaration names the
 * principal that asserted it, that foreign key is RESTRICT, and a principal
 * cascades from a party — so with neither sweep in place, `DELETE FROM parties`
 * raises, and deleting an account stops working everywhere that goes at the
 * table directly rather than through `DELETE /api/auth/me`.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@hm/db";
import { partyForUser, principalForParty, staffPrincipal } from "../services/party.js";
import type { BorrowerInput } from "../services/party.js";
import { authRouter } from "../routes/auth.js";
import { fileRouter } from "../routes/files.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const dana: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 2150,
  statedMonthlyIncome: 8500,
};

/** A file, the application it became, and the borrower's own edge onto it. */
async function borrowerOnAnApplication() {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, dana);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  const edge = await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId: borrower.partyId, role: "PRIMARY_BORROWER" },
    select: { id: true },
  });
  return {
    user,
    file,
    app,
    partyId: borrower.partyId,
    edgeId: edge.id,
    principalId: await principalForParty(prisma, borrower.partyId),
  };
}

/**
 * A declaration where every answer is No.
 *
 * `intentToOccupy` is Yes because it is the interesting branch — it is the one
 * that makes a follow-up required — and the homeowner answer that follows it is
 * No, which is what keeps `priorPropertyUsage` legally absent.
 */
function declarationFor(
  applicationPartyId: string,
  assertedByPrincipalId: string,
  overrides: Partial<Prisma.DuDeclarationUncheckedCreateInput> = {},
): Prisma.DuDeclarationUncheckedCreateInput {
  return {
    applicationPartyId,
    assertedByPrincipalId,
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
  };
}

function residenceFor(
  applicationPartyId: string,
  overrides: Partial<Prisma.DuResidenceUncheckedCreateInput> = {},
): Prisma.DuResidenceUncheckedCreateInput {
  return {
    applicationPartyId,
    residencyType: "Current",
    basis: "Rent",
    durationMonths: 30,
    ...overrides,
  };
}

/** The prior address the wire wants, since a Current row may carry none. */
const PRIOR_ADDRESS = {
  addressLineText: "88 Willow Lane",
  cityName: "Demo City",
  stateCode: "CA",
  postalCode: "94001",
} as const;

describe("a declaration answers its own follow-ups", () => {
  it("writes when every conditional chain agrees", async () => {
    // The green case first, so none of the refusals below can be passing
    // because the row was unwritable for some other reason.
    const { edgeId, principalId } = await borrowerOnAnApplication();
    const row = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, principalId, {
        homeownerPastThreeYears: "Yes",
        priorPropertyUsage: "PrimaryResidence",
        priorPropertyTitle: "JointWithSpouse",
        undisclosedBorrowedFunds: true,
        undisclosedBorrowedFundsCents: 1_250_000n,
      }),
      select: { id: true, undisclosedBorrowedFundsCents: true },
    });
    expect(row.undisclosedBorrowedFundsCents).toBe(1_250_000n);
  });

  it("refuses an intent to occupy with no answer about owning before", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { homeownerPastThreeYears: null }),
      }),
    ).rejects.toThrow(/du_declarations_homeowner_follows_intent/);
  });

  it("refuses that answer when there is no intent to occupy", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, {
          intentToOccupy: "No",
          homeownerPastThreeYears: "Yes",
        }),
      }),
    ).rejects.toThrow(/du_declarations_homeowner_follows_intent/);
  });

  it("refuses a prior usage from somebody who has not owned before", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { priorPropertyUsage: "Investment" }),
      }),
    ).rejects.toThrow(/du_declarations_prior_usage_follows_homeowner/);
  });

  it("refuses a former homeowner who does not say how they used it", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { homeownerPastThreeYears: "Yes" }),
      }),
    ).rejects.toThrow(/du_declarations_prior_usage_follows_homeowner/);
  });

  it("refuses borrowed funds with no amount, and an amount with no borrowed funds", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { undisclosedBorrowedFunds: true }),
      }),
      "declared, unquantified",
    ).rejects.toThrow(/du_declarations_borrowed_amount_follows_indicator/);
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { undisclosedBorrowedFundsCents: 5_000n }),
      }),
      "quantified, undeclared",
    ).rejects.toThrow(/du_declarations_borrowed_amount_follows_indicator/);
  });

  it("refuses an amount too wide for the wire", async () => {
    // Nine integer digits and two decimals. A wider number is rejected at
    // submission, days later, with no local symptom.
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, {
          undisclosedBorrowedFunds: true,
          undisclosedBorrowedFundsCents: 100_000_000_000n,
        }),
      }),
    ).rejects.toThrow(/du_declarations_borrowed_amount_fits_amount_9_2/);
  });
});

describe("a declared bankruptcy names its chapters", () => {
  it("writes the declaration and its chapters in one transaction", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    const row = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, principalId, {
        bankruptcy: true,
        chapters: { create: [{ chapter: "ChapterSeven" }, { chapter: "ChapterThirteen" }] },
      }),
      select: { id: true, chapters: { select: { chapter: true } } },
    });
    expect(row.chapters).toHaveLength(2);
  });

  it("refuses a declared bankruptcy that names no chapter", async () => {
    // At COMMIT rather than on the insert, because the declaration and its
    // chapters land in one transaction and a row cannot be judged before its
    // children exist.
    const { edgeId, principalId } = await borrowerOnAnApplication();
    await expect(
      prisma.duDeclaration.create({
        data: declarationFor(edgeId, principalId, { bankruptcy: true }),
      }),
    ).rejects.toThrow(/says bankruptcy but names no chapter/);
  });

  it("refuses a chapter under a declaration that says there was none", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    const declaration = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, principalId),
      select: { id: true },
    });
    await expect(
      prisma.duBankruptcyFiling.create({
        data: { declarationId: declaration.id, chapter: "ChapterEleven" },
      }),
    ).rejects.toThrow(/but says no bankruptcy/);
  });

  it("refuses the deletion of the last chapter, in a later transaction", async () => {
    // The operation nobody thinks to test, and the one that leaves the exact
    // state the constraint exists to forbid: the declaration still says yes and
    // there is no longer anything saying which.
    const { edgeId, principalId } = await borrowerOnAnApplication();
    const declaration = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, principalId, {
        bankruptcy: true,
        chapters: { create: [{ chapter: "ChapterSeven" }] },
      }),
      select: { id: true, chapters: { select: { id: true } } },
    });
    await expect(
      prisma.duBankruptcyFiling.delete({ where: { id: declaration.chapters[0]!.id } }),
    ).rejects.toThrow(/says bankruptcy but names no chapter/);
  });

  it("refuses a chapter moved onto another declaration", async () => {
    // The other operation that empties a declaration: an UPDATE takes the
    // chapter away from the row it was under, and that row still says yes. A
    // function that read only the chapter's new parent would ask about the
    // declaration that is fine and never about the one that is not.
    const from = await borrowerOnAnApplication();
    const to = await borrowerOnAnApplication();
    const emptied = await prisma.duDeclaration.create({
      data: declarationFor(from.edgeId, from.principalId, {
        bankruptcy: true,
        chapters: { create: [{ chapter: "ChapterSeven" }] },
      }),
      select: { id: true, chapters: { select: { id: true } } },
    });
    // A different chapter on the receiving side, so what refuses the move is
    // the invariant and not the unique pair.
    const receiving = await prisma.duDeclaration.create({
      data: declarationFor(to.edgeId, to.principalId, {
        bankruptcy: true,
        chapters: { create: [{ chapter: "ChapterThirteen" }] },
      }),
      select: { id: true },
    });
    await expect(
      prisma.duBankruptcyFiling.update({
        where: { id: emptied.chapters[0]!.id },
        data: { declarationId: receiving.id },
      }),
    ).rejects.toThrow(/says bankruptcy but names no chapter/);
  });

  it("refuses a fifth chapter, because there are four", async () => {
    const { edgeId, principalId } = await borrowerOnAnApplication();
    const declaration = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, principalId, {
        bankruptcy: true,
        chapters: {
          create: [
            { chapter: "ChapterSeven" },
            { chapter: "ChapterEleven" },
            { chapter: "ChapterTwelve" },
            { chapter: "ChapterThirteen" },
          ],
        },
      }),
      select: { id: true },
    });
    await expect(
      prisma.duBankruptcyFiling.create({
        data: { declarationId: declaration.id, chapter: "ChapterSeven" },
      }),
    ).rejects.toThrow(/du_bankruptcy_filings_declaration_id_chapter_key|Unique constraint/);
  });
});

describe("nobody but the borrower declares", () => {
  it("refuses a machine principal outright", async () => {
    // Screen 4 reads these off a credit pull today. A clean report is an
    // absence of evidence, not a "no", and the difference is a signature on a
    // federal form.
    const { edgeId } = await borrowerOnAnApplication();
    for (const kind of ["AI_AGENT", "PARTNER", "SERVICE"] as const) {
      const actor = await prisma.principal.create({
        data: { kind, subject: `${kind.toLowerCase()}-${randomUUID()}` },
        select: { id: true },
      });
      await expect(
        prisma.duDeclaration.create({ data: declarationFor(edgeId, actor.id) }),
        kind,
      ).rejects.toThrow(/may not declare on a borrower's behalf/);
    }
  });

  it("refuses a borrower answering for somebody else", async () => {
    // Not hypothetical: screen 4's single signature makes the signed-in primary
    // borrower the obvious asserter for a co-borrower's row.
    const primary = await borrowerOnAnApplication();
    const other = await createUser();
    const otherPartyId = await partyForUser(prisma, other.id);
    const otherEdge = await prisma.applicationParty.create({
      data: { applicationId: primary.app.id, partyId: otherPartyId, role: "CO_BORROWER" },
      select: { id: true },
    });
    await expect(
      prisma.duDeclaration.create({ data: declarationFor(otherEdge.id, primary.principalId) }),
    ).rejects.toThrow(/cannot declare for party/);
  });

  it("lets staff record one taken by phone", async () => {
    const { edgeId, app } = await borrowerOnAnApplication();
    const ops = await staffPrincipal(prisma, `ops-${app.id}`);
    const row = await prisma.duDeclaration.create({
      data: declarationFor(edgeId, ops),
      select: { assertedByPrincipalId: true },
    });
    expect(row.assertedByPrincipalId).toBe(ops);
  });
});

describe("a declaration belongs to a borrowing party", () => {
  async function nonBorrowingSpouse() {
    const primary = await borrowerOnAnApplication();
    const spouse = await createUser();
    const spousePartyId = await partyForUser(prisma, spouse.id);
    const edge = await prisma.applicationParty.create({
      data: {
        applicationId: primary.app.id,
        partyId: spousePartyId,
        role: "NON_BORROWING_SPOUSE",
      },
      select: { id: true },
    });
    return { edgeId: edge.id, principalId: await principalForParty(prisma, spousePartyId) };
  }

  it("refuses a declaration on a non-borrowing spouse", async () => {
    // DU has no Borrower element for one, so the row would have nowhere to go.
    const { edgeId, principalId } = await nonBorrowingSpouse();
    await expect(
      prisma.duDeclaration.create({ data: declarationFor(edgeId, principalId) }),
    ).rejects.toThrow(/is NON_BORROWING_SPOUSE, which is not a DU Borrower/);
  });

  it("refuses a residence on one too", async () => {
    const { edgeId } = await nonBorrowingSpouse();
    await expect(prisma.duResidence.create({ data: residenceFor(edgeId) })).rejects.toThrow(
      /is NON_BORROWING_SPOUSE, which is not a DU Borrower/,
    );
  });

  it("refuses the role change that would strand the rows", async () => {
    // The direction a trigger on the child tables cannot see: the answers were
    // legal when they were written, and the write that invalidates them is the
    // one on the edge.
    const primary = await borrowerOnAnApplication();
    const co = await createUser();
    const coPartyId = await partyForUser(prisma, co.id);
    const edge = await prisma.applicationParty.create({
      data: { applicationId: primary.app.id, partyId: coPartyId, role: "CO_BORROWER" },
      select: { id: true },
    });
    const coPrincipal = await principalForParty(prisma, coPartyId);
    await prisma.duDeclaration.create({ data: declarationFor(edge.id, coPrincipal) });

    // A move between two borrowing roles is nobody's problem.
    await prisma.applicationParty.update({
      where: { id: edge.id },
      data: { role: "NON_OCCUPANT_CO_BORROWER" },
    });
    await expect(
      prisma.applicationParty.update({
        where: { id: edge.id },
        data: { role: "NON_BORROWING_SPOUSE" },
      }),
    ).rejects.toThrow(/carries DU borrower rows and cannot become NON_BORROWING_SPOUSE/);
  });

  it("refuses it for a residence alone, with no declaration in sight", async () => {
    const primary = await borrowerOnAnApplication();
    const co = await createUser();
    const coPartyId = await partyForUser(prisma, co.id);
    const edge = await prisma.applicationParty.create({
      data: { applicationId: primary.app.id, partyId: coPartyId, role: "CO_BORROWER" },
      select: { id: true },
    });
    await prisma.duResidence.create({ data: residenceFor(edge.id) });
    await expect(
      prisma.applicationParty.update({
        where: { id: edge.id },
        data: { role: "GUARANTOR" },
      }),
    ).rejects.toThrow(/carries DU borrower rows and cannot become GUARANTOR/);
  });
});

describe("a residence", () => {
  it("takes a rent with a rent basis, and refuses one with an owned basis", async () => {
    const { edgeId } = await borrowerOnAnApplication();
    const row = await prisma.duResidence.create({
      data: residenceFor(edgeId, { monthlyRentCents: 215_000n }),
      select: { monthlyRentCents: true },
    });
    expect(row.monthlyRentCents).toBe(215_000n);

    await expect(
      prisma.duResidence.create({
        data: residenceFor(edgeId, {
          residencyType: "Prior",
          basis: "Own",
          monthlyRentCents: 215_000n,
          ...PRIOR_ADDRESS,
        }),
      }),
    ).rejects.toThrow(/du_residences_rent_amount_needs_a_rent_basis/);
  });

  it("accepts a rent basis with no amount at all", async () => {
    // DU's condition is "basis is Rent AND the amount exists". A prior
    // residence rented eight years ago whose rent nobody remembers is a legal
    // file, and a biconditional here would make it an unwritable row.
    const { edgeId } = await borrowerOnAnApplication();
    const row = await prisma.duResidence.create({
      data: residenceFor(edgeId, {
        residencyType: "Prior",
        basis: "Rent",
        durationMonths: 96,
        ...PRIOR_ADDRESS,
      }),
      select: { monthlyRentCents: true },
    });
    expect(row.monthlyRentCents).toBeNull();
  });

  it("refuses a tenancy too long for the wire", async () => {
    const { edgeId } = await borrowerOnAnApplication();
    await prisma.duResidence.create({ data: residenceFor(edgeId, { durationMonths: 999 }) });
    await expect(
      prisma.duResidence.create({
        data: residenceFor(edgeId, {
          residencyType: "Prior",
          durationMonths: 1000,
          ...PRIOR_ADDRESS,
        }),
      }),
    ).rejects.toThrow(/du_residences_duration_fits_numeric_3/);
  });

  it("refuses a current residence that carries its own address", async () => {
    // There is one storage for where somebody lives now — the pinned
    // `current_address` fact — and a copy here is a second one to drift.
    const { edgeId } = await borrowerOnAnApplication();
    await expect(
      prisma.duResidence.create({ data: residenceFor(edgeId, PRIOR_ADDRESS) }),
    ).rejects.toThrow(/du_residences_current_borrows_the_pinned_address/);
  });

  it("refuses a prior residence that carries none", async () => {
    // And this is the other direction: nothing in this codebase records where
    // somebody used to live, so a Prior row without an address has nowhere to
    // read one from.
    const { edgeId } = await borrowerOnAnApplication();
    await expect(
      prisma.duResidence.create({ data: residenceFor(edgeId, { residencyType: "Prior" }) }),
    ).rejects.toThrow(/du_residences_prior_carries_its_own_address/);
  });
});

describe("deleting a party still works with a declaration on it", () => {
  it("succeeds against `parties` directly, not only through the account route", async () => {
    // The foreign key that bites: `asserted_by_principal_id` is RESTRICT, and
    // Postgres fires the `principals` cascade before the `application_parties`
    // one. Seven call sites delete a party without going through
    // `DELETE /api/auth/me`, and every one of them would raise here.
    const { partyId, edgeId, principalId } = await borrowerOnAnApplication();
    await prisma.duDeclaration.create({ data: declarationFor(edgeId, principalId) });
    await prisma.duResidence.create({ data: residenceFor(edgeId) });

    await prisma.party.delete({ where: { id: partyId } });

    expect(await prisma.duDeclaration.count({ where: { applicationPartyId: edgeId } })).toBe(0);
    expect(await prisma.duResidence.count({ where: { applicationPartyId: edgeId } })).toBe(0);
  });

  it("finds the declarations to sweep through an index", async () => {
    // Both sweeps select on `asserted_by_principal_id`, once per principal and
    // once per party deleted. Unindexed, deleting one account is a sequential
    // scan of every declaration in the database per row — which is why `facts`,
    // the same RESTRICT edge swept the same way, carries the same index.
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'du_declarations' AND indexdef LIKE '%(asserted_by_principal_id)%'
    `;
    expect(indexes).toHaveLength(1);
  });
});

/**
 * A co-borrower on somebody else's file, whose Section 5 a member of staff
 * recorded by phone.
 *
 * The shape every jointly taken application has, because a co-borrower who has
 * never signed in has no principal of their own to assert with — and the shape
 * where the asserting principal and the declaring party belong to two different
 * people, which is what makes the sweep on `principals` load-bearing rather
 * than redundant.
 */
async function aCoBorrowerWithAPhoneDeclaration() {
  const owner = await borrowerOnAnApplication();
  const co = await createUser();
  const coPartyId = await partyForUser(prisma, co.id);
  const edge = await prisma.applicationParty.create({
    data: { applicationId: owner.app.id, partyId: coPartyId, role: "CO_BORROWER" },
    select: { id: true },
  });
  const ops = await staffPrincipal(prisma, `ops-${owner.app.id}`);
  await prisma.duDeclaration.create({ data: declarationFor(edge.id, ops) });
  await prisma.duResidence.createMany({
    data: [
      residenceFor(edge.id, { durationMonths: 14 }),
      residenceFor(edge.id, { residencyType: "Prior", durationMonths: 48, ...PRIOR_ADDRESS }),
    ],
  });
  return { owner, co, coPartyId, edgeId: edge.id, ops };
}

describe("the account route survives it too", () => {
  it("deletes a co-borrower whose declaration staff asserted, and leaves the file open", async () => {
    const { owner, co, edgeId } = await aCoBorrowerWithAPhoneDeclaration();

    const deleted = await callAs(co.id, [authRouter], "DELETE", "/me", undefined, "/api/auth");
    expect(deleted.status).toBe(200);

    expect(await prisma.duDeclaration.count({ where: { applicationPartyId: edgeId } })).toBe(0);
    expect(await prisma.duResidence.count({ where: { applicationPartyId: edgeId } })).toBe(0);
    const open = await callAs(owner.user.id, [fileRouter], "GET", `/${owner.file.id}`);
    expect(open.status).toBe(200);
  });

  it("takes the answers with the principal that vouched for them, and says so", async () => {
    // The mirror, and the one that costs somebody else something: the member of
    // staff who took the answers leaves, and an unattributed Section 5 is not a
    // declaration. The borrower has to be asked again, so the file says it
    // happened rather than losing the row quietly.
    const { owner, edgeId, ops } = await aCoBorrowerWithAPhoneDeclaration();

    await prisma.principal.delete({ where: { id: ops } });

    expect(await prisma.duDeclaration.count({ where: { applicationPartyId: edgeId } })).toBe(0);
    const events = await prisma.fileEvent.findMany({
      where: { loanFileId: owner.file.id, kind: "du_declaration_removed" },
      select: { payload: true, actor: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("system");
    expect(events[0]!.payload).toMatchObject({
      applicationId: owner.app.id,
      applicationPartyId: edgeId,
      assertedByPrincipalId: ops,
    });
  });
});
