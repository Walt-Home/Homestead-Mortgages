/**
 * Section 5 and where the borrower lives, written down because somebody was
 * asked.
 *
 * This is the only writer of `du_declarations`, `du_bankruptcy_filings` and
 * `du_residences` in the product, and the only reason it has to be the only one
 * is that the alternative is a derivation. Screen 4 reads "no bankruptcy" off a
 * credit pull today; a clean credit report is absence of evidence, not a "no",
 * and there is no `ConnectorSnapshot` anywhere in this file for that reason.
 * The database refuses a machine principal outright, and a test refuses a second
 * writer.
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
import type { DuBankruptcyChapter, DuResidencyBasis, DuResidencyType, DuYesNo } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { fromCents, toCents } from "./money.js";
import { principalForParty } from "./party.js";
import { ownsTransaction, type Db } from "./db.js";

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

export interface DeclarationView {
  readonly applicationPartyId: string;
  readonly assertedAt: string;
  readonly declaration: Omit<DeclarationInput, "undisclosedBorrowedFundsAmount"> & {
    readonly undisclosedBorrowedFundsAmount: number | null;
  };
  readonly residences: readonly (Omit<ResidenceInput, "monthlyRent"> & {
    readonly monthlyRent: number | null;
  })[];
}

/**
 * The edge this file's primary borrower answers on.
 *
 * A declaration hangs off `application_parties` and not off the party, because
 * the answer to "have you declared bankruptcy in the past seven years" is
 * different on a different date and the answer a submission relied on has to
 * stay recoverable. A file with no application has nobody to answer as, and
 * saying so is better than lazily minting the credit request somebody has not
 * asked for.
 */
async function borrowerEdge(db: Db, loanFileId: string) {
  const application = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application) {
    throw new AppError(409, "This file is not an application yet.", "NO_APPLICATION");
  }
  const borrower = await db.borrower.findFirst({
    where: { loanFileId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, partyId: true },
  });
  if (!borrower) {
    throw new AppError(409, "Tell us who you are first.", "NO_BORROWER");
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
  input: { declaration: DeclarationInput; residences: readonly ResidenceInput[] },
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

  const { edgeId, borrower } = await borrowerEdge(db, loanFileId);
  const principalId = await principalForParty(db, borrower.partyId);
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

  // The derived copy follows the answer, unconditionally. Screen 4 re-sends the
  // basis it read on its way to joining the demographics, so this is not the
  // only writer of the column — it is the only one that has asked, and it is
  // what the column is derived FROM.
  //
  // There is always a Current residence to derive it from: the body refuses a
  // set without one and a DEFERRABLE constraint trigger refuses it again at
  // COMMIT. Writing the column only when one happened to be present is how the
  // derived copy outlives the row it is derived from.
  const current = input.residences.find((r) => r.residencyType === "Current")!;
  await db.borrower.update({
    where: { id: borrower.id },
    data: {
      currentHousing: HOUSING_FOR_BASIS[current.basis],
      monthlyRent: current.monthlyRent ?? null,
    },
  });

  return (await loadDeclaration(loanFileId, db))!;
}

/** What was said, in dollars, with no bigint left for `res.json` to throw on. */
export async function loadDeclaration(
  loanFileId: string,
  db: Db = prisma,
): Promise<DeclarationView | null> {
  const { edgeId } = await borrowerEdge(db, loanFileId);
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
