/**
 * Section 5 and where the borrower lives, written down because somebody was
 * asked.
 *
 * This is the only writer of `du_declarations`, `du_bankruptcy_filings` and
 * `du_residences` in the product, and the only reason it has to be the only one
 * is that the alternative is a derivation. The review screen used to read "no
 * bankruptcy" off a credit pull; a clean credit report is absence of evidence,
 * not a "no", and there is no `ConnectorSnapshot` anywhere in this file for
 * that reason. The database refuses a machine principal outright, and a test
 * refuses a second writer.
 *
 * It is also what makes `borrowers.current_housing` true. That column carried a
 * NOT NULL default of `'rent'` and no screen ever asked, so every application
 * stated a housing basis nobody had given. `du_residences` is the source of
 * truth now; the column is a derived copy, written here, from the row the
 * borrower's own answer created.
 *
 * Money is bigint cents in these tables and dollars everywhere a person reads
 * one. The conversion is at the route edge and in `loadDeclaration` below,
 * because `res.json` throws on a bigint — a view that forgot one is a 500
 * rather than a wrong number.
 */

import { prisma, type Prisma } from "@hm/db";
import type {
  DuBankruptcyChapter,
  DuPropertyEstateType,
  DuResidencyBasis,
  DuResidencyType,
  DuYesNo,
} from "@hm/db";
import type { BorrowerDeclaration, BorrowerResidence } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { fromCents, toCents } from "./money.js";
import { ownsTransaction, type Db } from "./db.js";
import { primaryBorrowerRow } from "./borrower-order.js";

/** The housing basis, in the two vocabularies that have to agree. */
const HOUSING_FOR_BASIS: Readonly<Record<DuResidencyBasis, "own" | "rent" | "rent_free">> = {
  Own: "own",
  Rent: "rent",
  LivingRentFree: "rent_free",
};

export interface ResidenceInput {
  readonly residencyType: DuResidencyType;
  readonly basis: DuResidencyBasis;
  readonly durationMonths: number;
  /** Dollars in, cents in the column. */
  readonly monthlyRent?: number | null;
  readonly addressLineText?: string | null;
  readonly addressUnit?: string | null;
  readonly cityName?: string | null;
  readonly stateCode?: string | null;
  readonly postalCode?: string | null;
  readonly countryCode?: string | null;
}

export interface DeclarationInput {
  readonly intentToOccupy: DuYesNo;
  readonly homeownerPastThreeYears?: DuYesNo | null;
  readonly priorPropertyUsage?: Prisma.DuDeclarationUncheckedCreateInput["priorPropertyUsage"];
  readonly priorPropertyTitle?: Prisma.DuDeclarationUncheckedCreateInput["priorPropertyTitle"];
  readonly fhaSecondaryResidence?: boolean | null;
  readonly specialBorrowerSellerRelationship?: boolean | null;
  readonly undisclosedBorrowedFunds: boolean;
  /** Dollars in, cents in the column. */
  readonly undisclosedBorrowedFundsAmount?: number | null;
  readonly undisclosedMortgageApplication: boolean;
  readonly undisclosedCreditApplication: boolean;
  readonly propertyProposedCleanEnergyLien: boolean;
  readonly undisclosedComakerOfNote: boolean;
  readonly outstandingJudgments: boolean;
  readonly presentlyDelinquent: boolean;
  readonly partyToLawsuit?: boolean | null;
  readonly priorPropertyDeedInLieuConveyed: boolean;
  readonly priorPropertyShortSaleCompleted: boolean;
  readonly priorPropertyForeclosureCompleted: boolean;
  readonly bankruptcy: boolean;
  readonly bankruptcyChapters?: readonly DuBankruptcyChapter[];
  /**
   * The borrower's own words, keyed by the lettered question. DU consumes no
   * explanation element at all — there is no path for one in the emission
   * table — so this is for the 1003, the underwriter and the file's own record.
   */
  readonly explanations?: Readonly<Record<string, string>> | null;
}

/**
 * What was said, in the shape `LoanFile` carries.
 *
 * The view is `@hm/shared`'s rather than an `Omit` over the input above,
 * because the route's response and the file projection are the same answer to
 * the same question and a second shape is a second thing to keep true. The
 * input stays its own type: it is what a caller may leave out, which is not
 * what a reader gets back.
 */
export interface DeclarationView {
  readonly applicationPartyId: string;
  readonly assertedAt: string;
  readonly declaration: BorrowerDeclaration;
  readonly residences: readonly BorrowerResidence[];
}

/**
 * The edge one borrower on this file answers on.
 *
 * A declaration hangs off `application_parties` and not off the party, because
 * the answer to "have you declared bankruptcy in the past seven years" is
 * different on a different date and the answer a submission relied on has to
 * stay recoverable. A file with no application has nobody to answer as, and
 * saying so is better than lazily minting the credit request somebody has not
 * asked for.
 *
 * `borrowerId` names WHICH person is answering, and it is required as soon as
 * a file carries more than one. Absent, it is the person whose request this is
 * — Borrower 1, resolved through `primaryBorrowerRow`, which is the same
 * ordinal every reader of a file is sorted by. Screen 3 posts without one, so
 * resolving it any other way put the signer's Section 5 answers onto a
 * different person's edge on a file whose ordinal 1 had been refilled: the
 * review screen then showed the bankruptcy under somebody else's name and told
 * the person who declared it that they had not answered yet.
 */
export async function borrowerEdge(db: Db, loanFileId: string, borrowerId?: string) {
  const application = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application) {
    throw new AppError(409, "This file is not an application yet.", "NO_APPLICATION");
  }
  // Scoped to the file, so an id from somebody else's application answers 404
  // rather than writing a declaration onto a person this request cannot reach.
  const borrower = borrowerId
    ? await db.borrower.findFirst({
        where: { loanFileId, id: borrowerId },
        select: { id: true, partyId: true },
      })
    : await primaryBorrowerRow(db, loanFileId);
  if (!borrower) {
    throw borrowerId
      ? new AppError(404, "That person is not on this file.", "NOT_FOUND")
      : new AppError(409, "Tell us who you are first.", "NO_BORROWER");
  }
  const edge = await db.applicationParty.findFirst({
    where: { applicationId: application.id, partyId: borrower.partyId },
    select: { id: true },
  });
  if (!edge) {
    throw new AppError(409, "You are not on this application.", "NOT_ON_APPLICATION");
  }
  return { applicationId: application.id, borrower, edgeId: edge.id };
}

/**
 * Who may say this, checked where a refusal can carry a sentence.
 *
 * `du_declarations_are_self_attested` is the rule and stays the backstop: a
 * declaration is a statement the declaring borrower signs, a member of staff
 * may record one taken by phone, and nobody else may write one at all. Letting
 * that trigger be the only refusal would reach the caller as a 500 with the
 * reason filed off, which is what every other constraint this path mirrors is
 * mirrored to avoid.
 *
 * The asserting principal is the REQUESTER's, never the declaring borrower's.
 * Deriving it from the person being declared about made every write
 * self-attested by construction, so the trigger could not fire: an applicant
 * answering for a co-borrower minted that co-borrower a BORROWER principal —
 * for somebody who has never signed in — and recorded them as having
 * personally attested to a bankruptcy on a screen they have never seen.
 */
export async function assertMaySpeakFor(
  db: Db,
  principalId: string,
  declaringPartyId: string,
): Promise<void> {
  const actor = await db.principal.findUnique({
    where: { id: principalId },
    select: { kind: true, partyId: true },
  });
  if (actor?.kind === "STAFF") return;
  if (actor?.kind === "BORROWER" && actor.partyId === declaringPartyId) return;
  throw new AppError(
    403,
    "Section 5 is answered by the borrower it is about, so we cannot record these answers for somebody else.",
    "NOT_THE_DECLARING_BORROWER",
  );
}

function declarationRow(
  input: DeclarationInput,
): Omit<Prisma.DuDeclarationUncheckedCreateInput, "applicationPartyId" | "assertedByPrincipalId"> {
  return {
    intentToOccupy: input.intentToOccupy,
    homeownerPastThreeYears: input.homeownerPastThreeYears ?? null,
    priorPropertyUsage: input.priorPropertyUsage ?? null,
    priorPropertyTitle: input.priorPropertyTitle ?? null,
    fhaSecondaryResidence: input.fhaSecondaryResidence ?? null,
    specialBorrowerSellerRelationship: input.specialBorrowerSellerRelationship ?? null,
    undisclosedBorrowedFunds: input.undisclosedBorrowedFunds,
    undisclosedBorrowedFundsCents:
      input.undisclosedBorrowedFundsAmount != null
        ? toCents(input.undisclosedBorrowedFundsAmount)
        : null,
    undisclosedMortgageApplication: input.undisclosedMortgageApplication,
    undisclosedCreditApplication: input.undisclosedCreditApplication,
    propertyProposedCleanEnergyLien: input.propertyProposedCleanEnergyLien,
    undisclosedComakerOfNote: input.undisclosedComakerOfNote,
    outstandingJudgments: input.outstandingJudgments,
    presentlyDelinquent: input.presentlyDelinquent,
    partyToLawsuit: input.partyToLawsuit ?? null,
    priorPropertyDeedInLieuConveyed: input.priorPropertyDeedInLieuConveyed,
    priorPropertyShortSaleCompleted: input.priorPropertyShortSaleCompleted,
    priorPropertyForeclosureCompleted: input.priorPropertyForeclosureCompleted,
    bankruptcy: input.bankruptcy,
    explanations: (input.explanations ?? undefined) as Prisma.InputJsonValue | undefined,
  };
}

/**
 * Write the declaration, its chapters and the residences, in one transaction.
 *
 * One transaction because the bankruptcy indicator and its chapters are checked
 * against each other by a DEFERRABLE constraint trigger that fires at COMMIT: a
 * declared bankruptcy naming no chapter is refused there, which is the only
 * place both halves are visible at once. Replacing the residences in the same
 * boundary is what stops a borrower who corrects their basis from being left,
 * for an instant, with a `borrowers.current_housing` that disagrees with the row
 * it is derived from.
 */
export async function recordDeclaration(
  loanFileId: string,
  input: {
    declaration: DeclarationInput;
    residences: readonly ResidenceInput[];
    /** Who is answering. Absent is borrower 1, the person whose request this is. */
    borrowerId?: string;
    /**
     * The estate the subject property is held on, which belongs to the FILE and
     * not to the person answering. Written here because screen 3 is where it is
     * asked; a co-borrower answering later restates the same fact about the
     * same house.
     */
    propertyEstateType: DuPropertyEstateType;
    /**
     * Who is ASSERTING it, which is whoever made the request and not whoever
     * it is about. The two are the same person on every borrower's own save
     * and differ the moment a `borrowerId` names somebody else, which is the
     * case `assertMaySpeakFor` refuses.
     */
    assertedByPrincipalId: string;
  },
  db: Db = prisma,
): Promise<DeclarationView> {
  // The deferred trigger is why this cannot run statement by statement. The
  // bankruptcy indicator and its chapters are checked against each other at
  // COMMIT, which is the only moment both halves are visible; outside one
  // transaction the declaration commits alone and a true indicator with its
  // chapters still to come is refused before they arrive.
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => recordDeclaration(loanFileId, input, tx));
  }

  const { edgeId, borrower } = await borrowerEdge(db, loanFileId, input.borrowerId);
  const principalId = input.assertedByPrincipalId;
  await assertMaySpeakFor(db, principalId, borrower.partyId);
  const row = declarationRow(input.declaration);

  const declaration = await db.duDeclaration.upsert({
    where: { applicationPartyId: edgeId },
    create: { applicationPartyId: edgeId, assertedByPrincipalId: principalId, ...row },
    update: { assertedByPrincipalId: principalId, assertedAt: new Date(), ...row },
    select: { id: true },
  });

  // Answering again replaces the whole set rather than merging into it: a
  // borrower who corrects "Chapter 7" to "Chapter 13" said one thing, not two.
  await db.duBankruptcyFiling.deleteMany({ where: { declarationId: declaration.id } });
  if (input.declaration.bankruptcy) {
    await db.duBankruptcyFiling.createMany({
      data: (input.declaration.bankruptcyChapters ?? []).map((chapter) => ({
        declarationId: declaration.id,
        chapter,
      })),
    });
  }

  await db.duResidence.deleteMany({ where: { applicationPartyId: edgeId } });
  for (const residence of input.residences) {
    await db.duResidence.create({
      data: {
        applicationPartyId: edgeId,
        residencyType: residence.residencyType,
        basis: residence.basis,
        durationMonths: residence.durationMonths,
        monthlyRentCents: residence.monthlyRent != null ? toCents(residence.monthlyRent) : null,
        addressLineText: residence.addressLineText ?? null,
        addressUnit: residence.addressUnit ?? null,
        cityName: residence.cityName ?? null,
        stateCode: residence.stateCode ?? null,
        postalCode: residence.postalCode ?? null,
        countryCode: residence.countryCode ?? null,
      },
    });
  }

  // The derived copy follows the answer, unconditionally. The review screen
  // re-sends the basis it read on its way to joining the demographics, so this
  // is not the only writer of the column — it is the only one that has asked,
  // and it is what the column is derived FROM.
  //
  // There is always a Current residence to derive it from: the body refuses a
  // set without one and a DEFERRABLE constraint trigger refuses it again at
  // COMMIT. Writing the column only when one happened to be present is how the
  // derived copy outlives the row it is derived from.
  // The one answer on this screen that is not the borrower's own. It is in this
  // transaction rather than beside it because a borrower who reached the end of
  // screen 3 answered all of it or none of it, and a declaration that committed
  // without the estate type would leave the file looking asked and the casefile
  // still refused.
  await db.loanFile.update({
    where: { id: loanFileId },
    data: { propertyEstateType: input.propertyEstateType },
  });

  const current = input.residences.find((r) => r.residencyType === "Current")!;
  await db.borrower.update({
    where: { id: borrower.id },
    data: {
      currentHousing: HOUSING_FOR_BASIS[current.basis],
      monthlyRent: current.monthlyRent ?? null,
    },
  });

  // Read back off the edge that was just written, never off the file's first
  // borrower: a co-borrower's save would otherwise answer with the primary
  // borrower's stored answers, and the screen that posted would render them
  // as its own.
  return (await answersOn(db, edgeId))!;
}

/** One person's answers, in the shape the loan file projection carries. */
export type AnswersOnFile = Pick<DeclarationView, "declaration" | "residences">;

/**
 * What every borrower on this file answered, by `borrowers.id`.
 *
 * The application and the edges are read once for the whole file; the answers
 * themselves go through `answersOn` per person, because that is the one place
 * a stored row becomes a view — cents into dollars, chapters into a list — and
 * a second copy of that mapping is a second thing to keep true. Four borrowers
 * is the schema's ceiling, so the loop is bounded by a CHECK constraint.
 *
 * A borrower with no entry has not been asked. That is not "answered no",
 * which is the distinction every one of these questions turns on, and it is
 * why an absent key is left absent rather than filled with an empty view.
 */
export async function declarationsOnFile(
  loanFileId: string,
  db: Db = prisma,
): Promise<Map<string, AnswersOnFile>> {
  const answers = new Map<string, AnswersOnFile>();
  const application = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application) return answers;

  const borrowers = await db.borrower.findMany({
    where: { loanFileId },
    select: { id: true, partyId: true },
  });
  if (borrowers.length === 0) return answers;

  const edges = await db.applicationParty.findMany({
    where: { applicationId: application.id, partyId: { in: borrowers.map((b) => b.partyId) } },
    select: { id: true, partyId: true },
  });
  const edgeByParty = new Map(edges.map((e) => [e.partyId, e.id]));

  for (const borrower of borrowers) {
    const edgeId = edgeByParty.get(borrower.partyId);
    if (!edgeId) continue;
    const view = await answersOn(db, edgeId);
    if (view)
      answers.set(borrower.id, { declaration: view.declaration, residences: view.residences });
  }
  return answers;
}

/**
 * What was said, in dollars, with no bigint left for `res.json` to throw on.
 *
 * The client stays last, like every other reader here, so a caller already
 * inside a transaction sees what that transaction has written.
 */
export async function loadDeclaration(
  loanFileId: string,
  borrowerId?: string,
  db: Db = prisma,
): Promise<DeclarationView | null> {
  const { edgeId } = await borrowerEdge(db, loanFileId, borrowerId);
  return answersOn(db, edgeId);
}

/** The two tables, read off one edge and converted at the same boundary. */
async function answersOn(db: Db, edgeId: string): Promise<DeclarationView | null> {
  const row = await db.duDeclaration.findUnique({
    where: { applicationPartyId: edgeId },
    include: { chapters: { select: { chapter: true }, orderBy: { chapter: "asc" } } },
  });
  if (!row) return null;

  const residences = await db.duResidence.findMany({
    where: { applicationPartyId: edgeId },
    orderBy: { residencyType: "asc" },
  });

  return {
    applicationPartyId: edgeId,
    assertedAt: row.assertedAt.toISOString(),
    declaration: {
      intentToOccupy: row.intentToOccupy,
      homeownerPastThreeYears: row.homeownerPastThreeYears,
      priorPropertyUsage: row.priorPropertyUsage,
      priorPropertyTitle: row.priorPropertyTitle,
      fhaSecondaryResidence: row.fhaSecondaryResidence,
      specialBorrowerSellerRelationship: row.specialBorrowerSellerRelationship,
      undisclosedBorrowedFunds: row.undisclosedBorrowedFunds,
      undisclosedBorrowedFundsAmount:
        row.undisclosedBorrowedFundsCents != null
          ? fromCents(row.undisclosedBorrowedFundsCents)
          : null,
      undisclosedMortgageApplication: row.undisclosedMortgageApplication,
      undisclosedCreditApplication: row.undisclosedCreditApplication,
      propertyProposedCleanEnergyLien: row.propertyProposedCleanEnergyLien,
      undisclosedComakerOfNote: row.undisclosedComakerOfNote,
      outstandingJudgments: row.outstandingJudgments,
      presentlyDelinquent: row.presentlyDelinquent,
      partyToLawsuit: row.partyToLawsuit,
      priorPropertyDeedInLieuConveyed: row.priorPropertyDeedInLieuConveyed,
      priorPropertyShortSaleCompleted: row.priorPropertyShortSaleCompleted,
      priorPropertyForeclosureCompleted: row.priorPropertyForeclosureCompleted,
      bankruptcy: row.bankruptcy,
      bankruptcyChapters: row.chapters.map((c) => c.chapter),
      explanations: (row.explanations as Readonly<Record<string, string>> | null) ?? null,
    },
    residences: residences.map((r) => ({
      residencyType: r.residencyType,
      basis: r.basis,
      durationMonths: r.durationMonths,
      monthlyRent: r.monthlyRentCents != null ? fromCents(r.monthlyRentCents) : null,
      addressLineText: r.addressLineText,
      addressUnit: r.addressUnit,
      cityName: r.cityName,
      stateCode: r.stateCode,
      postalCode: r.postalCode,
      countryCode: r.countryCode,
    })),
  };
}
