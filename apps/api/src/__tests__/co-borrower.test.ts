/**
 * A second person on one application.
 *
 * The schema has permitted four borrowers since `borrower_ordinal` landed, and
 * nothing in the product could put a second one on a file: every route read
 * `borrowers[0]`, `POST /files/:id/borrowers` updated that row rather than
 * appending, and the declaration tables hung off the one edge such a save could
 * reach. So "four borrowers" was a constraint with no writer behind it.
 *
 * What is here is the writer and the two reads it makes answerable: the
 * appended person gets the smallest free position and the file lists everybody
 * in DOCUMENT order, and Section 5 is answered per person rather than per file.
 * The second of those is the one with teeth. A declaration is a statement made
 * by the person it is about, so one set of answers shared by two borrowers is
 * one person's statement standing in for another's — on a document both of them
 * sign.
 *
 * The housing basis is the same rule seen from underneath. `current_housing` is
 * derived from the borrower's own CURRENT residence, so a co-borrower who has
 * not answered reads NULL — not `"rent"`, and not the applicant's answer.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { fileRouter } from "../routes/files.js";
import { declarationRouter } from "../routes/declarations.js";
import { loadLoanFile } from "../services/repository.js";
import {
  recordDeclaration,
  type DeclarationInput,
  type ResidenceInput,
} from "../services/declarations.js";
import { staffPrincipal } from "../services/party.js";
import { evaluateCondition, evaluateSatisfaction, REQUIREMENTS } from "@hm/requirements";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1, as the web posts it. */
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

/** Screen 2, as the web posts it: the applicant, and no housing basis. */
const SCREEN_TWO = {
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
  demographics: null,
  statedMonthlyIncome: 7_400,
};

/** The same fields about somebody else. */
const CO_BORROWER = {
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

/** Section 5, answered, with every question that has a follow-up answered No. */
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
} satisfies DeclarationInput;

/** The same, as the web posts it. The residence is the argument. */
function declarationBody(
  residences: readonly ResidenceInput[],
  over: Record<string, unknown> = {},
) {
  return { declaration: SECTION_FIVE, residences, propertyEstateType: "FeeSimple", ...over };
}

const RENTING = {
  residencyType: "Current",
  basis: "Rent",
  durationMonths: 30,
  monthlyRent: 2_150,
} satisfies ResidenceInput;
const OWNING = {
  residencyType: "Current",
  basis: "Own",
  durationMonths: 90,
} satisfies ResidenceInput;

/**
 * Section 5 for somebody who has never signed in, taken by phone.
 *
 * The only way a co-borrower's answers exist today, and it is a product
 * requirement rather than a gap in the routes.
 * `du_declarations_are_self_attested` admits the declaring borrower or a
 * member of staff and nobody else; a co-borrower named by the applicant is a
 * provisional party with no principal of their own, and the applicant's
 * principal is refused. So either the second borrower gets a session or
 * somebody writes the answers down while they say them. There is no staff
 * route, which is why this goes through the service the way staff would.
 */
async function byPhone(
  fileId: string,
  borrowerId: string,
  declaration: DeclarationInput,
  residences: readonly ResidenceInput[],
) {
  const app = await prisma.application.findFirstOrThrow({
    where: { loanFileId: fileId },
    select: { id: true },
  });
  return recordDeclaration(fileId, {
    declaration,
    residences,
    borrowerId,
    propertyEstateType: "FeeSimple",
    assertedByPrincipalId: await staffPrincipal(prisma, `ops-${app.id}`),
  });
}

/** Screens 1 and 2, through the real routes, leaving one borrower on a file. */
async function anApplication() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  const fileId = created.body.id;
  const saved = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
  expect(saved.status).toBe(201);
  return { user, fileId };
}

/** One row of the registry, by id, for the evaluators that take one. */
const requirement = (id: string) => REQUIREMENTS.find((r) => r.id === id)!;

type Appended = { borrowerId: string; borrowerOrdinal: number | null };

async function append(userId: string, fileId: string, over: Record<string, unknown> = {}) {
  return callAs<Appended>(userId, [fileRouter], "POST", `/${fileId}/co-borrowers`, {
    ...CO_BORROWER,
    ...over,
  });
}

/** Every borrowing position on this file's application, in order. */
async function ordinals(fileId: string): Promise<(number | null)[]> {
  const rows = await prisma.applicationParty.findMany({
    where: { application: { loanFileId: fileId } },
    orderBy: { borrowerOrdinal: "asc" },
    select: { borrowerOrdinal: true },
  });
  return rows.map((r) => r.borrowerOrdinal);
}

describe("appending a co-borrower", () => {
  it("puts them at the smallest free position", async () => {
    const { user, fileId } = await anApplication();
    const res = await append(user.id, fileId);

    expect(res.status).toBe(201);
    expect(res.body.borrowerOrdinal).toBe(2);
    expect(await ordinals(fileId)).toEqual([1, 2]);
  });

  it("leaves the applicant where they are", async () => {
    // Appending is not the operation that corrects Borrower 1, and a route
    // that could do both would let a co-borrower's details land on the person
    // whose request this is.
    const { user, fileId } = await anApplication();
    await append(user.id, fileId);

    const file = await loadLoanFile(fileId);
    expect(file!.borrowers[0]!.firstName).toBe("Dana");
    expect(file!.borrowers[0]!.ssn.last4).toBe("4321");
  });

  it("lists both people on the file, in document order", async () => {
    const { user, fileId } = await anApplication();
    await append(user.id, fileId);

    const file = await loadLoanFile(fileId);
    expect(file!.borrowers.map((b) => `${b.firstName} ${b.lastName}`)).toEqual([
      "Dana Whitfield",
      "Theo Okafor",
    ]);
  });

  it("orders them by position rather than by when the row was written", async () => {
    // The difference is reachable and not academic. A borrower dropped before
    // a resubmission frees their position, the allocator refills it, and the
    // replacement is the NEWEST row on the file — so creation order files them
    // last while the submission puts them second.
    const { user, fileId } = await anApplication();
    const leaving = await append(user.id, fileId, { ssnVaultHandle: "vault:leaving:1" });
    const third = await append(user.id, fileId, {
      firstName: "Marisol",
      lastName: "Vega",
      email: "marisol@example.test",
      ssnVaultHandle: "vault:marisol:1",
      ssnLast4: "1111",
    });
    expect([leaving.body.borrowerOrdinal, third.body.borrowerOrdinal]).toEqual([2, 3]);

    // Dropped: the row and the membership both. The ordinal lives on the
    // membership, so removing only the borrower row leaves the position
    // occupied by somebody who is no longer on the file.
    const dropped = await prisma.borrower.delete({
      where: { id: leaving.body.borrowerId },
      select: { partyId: true },
    });
    await prisma.applicationParty.deleteMany({
      where: { application: { loanFileId: fileId }, partyId: dropped.partyId },
    });
    const replacement = await append(user.id, fileId, {
      firstName: "Noor",
      lastName: "Haddad",
      email: "noor@example.test",
      ssnVaultHandle: "vault:noor:1",
      ssnLast4: "2222",
    });
    expect(replacement.body.borrowerOrdinal).toBe(2);

    const file = await loadLoanFile(fileId);
    expect(file!.borrowers.map((b) => b.firstName)).toEqual(["Dana", "Noor", "Marisol"]);
  });

  it("records them as a person who has not agreed to be here", async () => {
    // They have never signed in and never said any of this: the applicant did.
    // A CLAIMED party would say somebody agreed to be on this application, and
    // a fact stamped with their own principal would say they stated their own
    // date of birth on a screen they have never seen.
    const { user, fileId } = await anApplication();
    const res = await append(user.id, fileId);

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: res.body.borrowerId },
      select: { partyId: true },
    });
    const party = await prisma.party.findUniqueOrThrow({
      where: { id: row.partyId },
      select: { claimStatus: true, sourceFirstSeen: true },
    });
    expect(party.claimStatus).toBe("PROVISIONAL");
    expect(party.sourceFirstSeen).toBe("co_borrower_named_by_applicant");

    const applicant = await prisma.borrower.findFirstOrThrow({
      where: { loanFileId: fileId, id: { not: res.body.borrowerId } },
      select: { partyId: true },
    });
    const theirs = await prisma.fact.findFirstOrThrow({
      where: { partyId: row.partyId, predicate: "legal_name", supersededById: null },
      select: { assertedByPrincipalId: true },
    });
    const applicantPrincipal = await prisma.principal.findFirstOrThrow({
      where: { kind: "BORROWER", partyId: applicant.partyId },
      select: { id: true },
    });
    expect(theirs.assertedByPrincipalId).toBe(applicantPrincipal.id);
  });

  it("refuses a file nobody has said who they are on", async () => {
    // A file with no applicant has nobody for a co-borrower to be second to,
    // and appending onto one would make this person Borrower 1 by accident.
    //
    // Screen 1 saved and screen 2 not: the file HAS a credit request, so the
    // refusal has to come from the missing applicant rather than from the
    // missing application, which is a different sentence about a different
    // problem.
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const res = await append(user.id, created.body.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "NO_BORROWER" } });
    expect(await prisma.borrower.count({ where: { loanFileId: created.body.id } })).toBe(0);
  });

  it("refuses a file that is not a credit request yet", async () => {
    // The other refusal, and it is a different fact: there is no application
    // for a membership to hang off, so there is no position to allocate.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const res = await append(user.id, file.id);

    expect(res.status).toBe(409);
    expect(await prisma.borrower.count({ where: { loanFileId: file.id } })).toBe(0);
  });

  it("names everybody on the file in the list, in the same order", async () => {
    // The list is where somebody else's file gets its name, and it named that
    // file after one borrower while the route sent one borrower — a read and a
    // shape that agreed by accident. A joint application named after whichever
    // of the two people sorts first is the list deciding whose file it is.
    const { user, fileId } = await anApplication();
    await append(user.id, fileId);

    const res = await callAs<{ files: { id: string; borrowers: unknown[] }[] }>(
      user.id,
      [fileRouter],
      "GET",
      "/",
    );
    const row = res.body.files.find((f) => f.id === fileId);
    expect(row!.borrowers).toEqual([
      { firstName: "Dana", lastName: "Whitfield" },
      { firstName: "Theo", lastName: "Okafor" },
    ]);
  });

  it("refuses a fifth person with a sentence rather than a 500", async () => {
    // Four is the ceiling `application_parties_borrower_ordinal_is_one_to_four`
    // holds, and the allocator ran out of positions and threw a bare `Error` —
    // written for a seed script's stack trace, and reaching a client as
    // `INTERNAL_ERROR` at 500. A full household is a refusal, not a fault.
    const { user, fileId } = await anApplication();
    for (const [n, first] of [
      [2, "Theo"],
      [3, "Marisol"],
      [4, "Noor"],
    ] as const) {
      const res = await append(user.id, fileId, {
        firstName: first,
        email: `${first.toLowerCase()}@example.test`,
        ssnVaultHandle: `vault:${first.toLowerCase()}:1`,
        ssnLast4: String(1_000 + n),
      });
      expect(res.status, first).toBe(201);
      expect(res.body.borrowerOrdinal).toBe(n);
    }

    const fifth = await append(user.id, fileId, {
      firstName: "Kenji",
      email: "kenji@example.test",
      ssnVaultHandle: "vault:kenji:1",
      ssnLast4: "5555",
    });

    expect(fifth.status).toBe(409);
    expect(fifth.body).toMatchObject({ error: { code: "BORROWER_LIMIT" } });
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(4);
  });

  it("requires the SSN it lets a revisit leave out", async () => {
    // Optional on screen 2 only because going back to fix a phone number must
    // not ask for it again. Every call here is a first save for the person it
    // is about, so there is no revisit to spare.
    const { user, fileId } = await anApplication();
    const { ssnVaultHandle: _handle, ssnLast4: _last4, ...withoutSsn } = CO_BORROWER;
    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/co-borrowers`, withoutSsn);

    expect(res.status).toBe(400);
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(1);
  });
});

/**
 * One file, two sets of answers.
 *
 * The declaration hangs off the `application_parties` edge, and there is one
 * edge per person — but every writer reached the FIRST one, so a co-borrower's
 * answers had nowhere of their own to go. `borrowerId` is what names the person
 * answering; absent, it is still Borrower 1, which is what screen 3 sends.
 */
describe("Section 5, per person", () => {
  async function bothAnswered() {
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);

    // The applicant rents and has declared no bankruptcy; the co-borrower owns
    // and has. Two answers that cannot be confused for one another.
    //
    // The applicant's goes through their own screen. The co-borrower's cannot:
    // they have never signed in, so theirs is taken by phone — which is the
    // shape every jointly taken application has today.
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${fileId}/declaration`,
      declarationBody([RENTING]),
    );
    await byPhone(
      fileId,
      appended.body.borrowerId,
      { ...SECTION_FIVE, bankruptcy: true, bankruptcyChapters: ["ChapterSeven"] },
      [OWNING],
    );
    return { user, fileId, coBorrowerId: appended.body.borrowerId };
  }

  it("gives each borrower their own answers", async () => {
    const { fileId, coBorrowerId } = await bothAnswered();
    const file = await loadLoanFile(fileId);

    const [applicant, other] = file!.borrowers;
    expect(other!.id).toBe(coBorrowerId);
    expect(applicant!.declaration!.bankruptcy).toBe(false);
    expect(other!.declaration!.bankruptcy).toBe(true);
    expect(other!.declaration!.bankruptcyChapters).toEqual(["ChapterSeven"]);
  });

  it("gives each borrower their own residence history", async () => {
    const { fileId } = await bothAnswered();
    const file = await loadLoanFile(fileId);

    expect(file!.borrowers[0]!.residences.map((r) => r.basis)).toEqual(["Rent"]);
    expect(file!.borrowers[1]!.residences.map((r) => r.basis)).toEqual(["Own"]);
  });

  it("sees the co-borrower's bankruptcy, which only he declared", async () => {
    // The file used to carry one copy of Section 5 and it was borrower 1's, so
    // a co-borrower's declared bankruptcy met the applicant's "no": APP-023
    // read "section 5b answered, all no", `declared_bankruptcy` read false, and
    // APP-024 never reached the outstanding list — under a review screen
    // showing him the bankruptcy he had declared, above the signature that
    // attests to it.
    const { fileId } = await bothAnswered();
    const file = await loadLoanFile(fileId);

    expect(evaluateCondition("declared_bankruptcy", file!)).toBe(true);

    const answered = evaluateSatisfaction(requirement("APP-023"), file!);
    expect(answered.status).toBe("satisfied");
    expect((answered as { evidence: string }).evidence).toContain(
      "Theo Okafor: section 5b answered, 1 yes",
    );

    // And the chapters are asked of the person who declared one, not of the
    // applicant who did not.
    const chapters = evaluateSatisfaction(requirement("APP-024"), file!);
    expect(chapters.status).toBe("satisfied");
    expect((chapters as { evidence: string }).evidence).toBe(
      "Dana Whitfield: no bankruptcy declared; Theo Okafor: ChapterSeven",
    );
  });

  it("leaves a borrower who has not answered reading null", async () => {
    // Not "answered no". Every one of these questions turns on that
    // distinction, and a co-borrower borrowing the applicant's clean answers
    // is the derivation this whole path was rebuilt to end, with the person
    // swapped in for the credit report.
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${fileId}/declaration`,
      declarationBody([RENTING]),
    );

    const file = await loadLoanFile(fileId);
    expect(file!.borrowers[0]!.declaration).not.toBeNull();
    const other = file!.borrowers.find((b) => b.id === appended.body.borrowerId);
    expect(other!.declaration).toBeNull();
    expect(other!.residences).toEqual([]);
  });

  it("refuses the applicant answering for the co-borrower", async () => {
    // Naming somebody else says whose edge the answers go on. It does not say
    // who made the statement, and the two used to be read off the same id: the
    // row was stamped with the SUBJECT's principal, so every write was
    // self-attested by construction and the trigger that exists for exactly
    // this case could never fire. The database would then say a person who has
    // never signed in personally attested to a bankruptcy.
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${fileId}/declaration`,
      declarationBody([OWNING], { borrowerId: appended.body.borrowerId }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "NOT_THE_DECLARING_BORROWER" } });
    expect(
      await prisma.duDeclaration.count({
        where: { applicationParty: { application: { loanFileId: fileId } } },
      }),
    ).toBe(0);
  });

  it("mints nobody a principal for a form they have never seen", async () => {
    // The other half of the same write, and the one that outlives the request:
    // looking the asserter up by the declaring party CREATED a BORROWER
    // principal for a provisional party, so a person who has never agreed to be
    // here acquired an identity the ledger can attribute statements to.
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);
    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { partyId: true },
    });

    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${fileId}/declaration`,
      declarationBody([OWNING], { borrowerId: appended.body.borrowerId }),
    );

    expect(await prisma.principal.count({ where: { partyId: row.partyId } })).toBe(0);
  });

  it("lets staff record the ones taken by phone", async () => {
    // The refusal above is not a dead end, it is a route through a person. A
    // STAFF principal is what the trigger admits, and it is what an
    // application with a co-borrower on it has to go through until that person
    // has a session of their own.
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { partyId: true },
    });
    const view = await byPhone(fileId, appended.body.borrowerId, SECTION_FIVE, [OWNING]);

    expect(view.declaration.bankruptcy).toBe(false);
    const stored = await prisma.duDeclaration.findFirstOrThrow({
      where: { applicationParty: { partyId: row.partyId } },
      select: { assertedBy: { select: { kind: true } } },
    });
    expect(stored.assertedBy.kind).toBe("STAFF");
  });

  it("refuses a borrower who is not on this file", async () => {
    // Scoped to the file, so an id from somebody else's application cannot
    // have a declaration written onto it by a request that cannot reach it.
    const mine = await anApplication();
    const theirs = await anApplication();
    const elsewhere = await append(theirs.user.id, theirs.fileId);

    const res = await callAs(
      mine.user.id,
      [declarationRouter],
      "POST",
      `/${mine.fileId}/declaration`,
      declarationBody([OWNING], { borrowerId: elsewhere.body.borrowerId }),
    );

    expect(res.status).toBe(404);
    expect(
      await prisma.duDeclaration.count({
        where: { applicationParty: { application: { loanFileId: mine.fileId } } },
      }),
    ).toBe(0);
  });
});

/**
 * The housing basis, for the person whose housing it is.
 *
 * `borrowers.current_housing` is a derived copy of the borrower's own CURRENT
 * residence. It carried a NOT NULL default of `'rent'` and no screen asked;
 * what is left is a nullable column filled from one row — and a second borrower
 * is where "one row" has to mean THEIR row rather than the file's.
 */
describe("what a co-borrower pays for where they live", () => {
  it("reads NULL until they have answered", async () => {
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { currentHousing: true, monthlyRent: true },
    });
    expect(row.currentHousing).toBeNull();
    expect(row.monthlyRent).toBeNull();
  });

  it("is not filled in by the applicant answering", async () => {
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${fileId}/declaration`,
      declarationBody([RENTING]),
    );

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { currentHousing: true },
    });
    expect(row.currentHousing).toBeNull();
  });

  it("reads back what that borrower answered, and leaves the applicant's alone", async () => {
    const { user, fileId } = await anApplication();
    const appended = await append(user.id, fileId);
    const post = (body: Record<string, unknown>) =>
      callAs(user.id, [declarationRouter], "POST", `/${fileId}/declaration`, body);

    await post(declarationBody([RENTING]));
    await byPhone(fileId, appended.body.borrowerId, SECTION_FIVE, [OWNING]);

    const theirs = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { currentHousing: true, monthlyRent: true },
    });
    expect(theirs.currentHousing).toBe("own");
    expect(theirs.monthlyRent).toBeNull();

    const applicant = await prisma.borrower.findFirstOrThrow({
      where: { loanFileId: fileId, id: { not: appended.body.borrowerId } },
      select: { currentHousing: true, monthlyRent: true },
    });
    expect(applicant.currentHousing).toBe("rent");
    expect(Number(applicant.monthlyRent)).toBe(2_150);
  });
});
