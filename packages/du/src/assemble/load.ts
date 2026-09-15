/**
 * One read of every table a submission draws on, in the one order it is
 * allowed to have.
 *
 * **The emission order is a total order and it is here.** For every container
 * kind the live rows — `retired_at IS NULL` where the table has the column —
 * are taken in `(created_at ASC, id ASC)` order. The trailing id is unique, so
 * the tuple never ties: the order is total rather than merely deterministic,
 * and there is no second ordering anywhere in the assembler and no `ORDER BY`
 * left to the database's discretion. Given one database state the emitted bytes
 * are a function of that state alone.
 *
 * **Two orderings are deliberately not `(created_at, id)`, and both are still
 * total.** What makes them safe is not the leading column but the constraint
 * behind it: every ordering here ends in a column some unique constraint makes
 * decisive, so none of them can tie.
 *
 * - `application_parties`, by `borrower_ordinal`: which borrower is first is a
 *   decision the file already made, and `(created_at, id)` would let a re-added
 *   co-borrower become borrower one. It needs no trailing id because
 *   `application_parties_one_party_per_ordinal` is a unique index on
 *   `(application_id, borrower_ordinal)`, and this reads one application.
 * - `du_residences`, by `(residency_type, id)`: the wire order of a residence
 *   history is Current before Prior, which is a property of what a residence
 *   history MEANS rather than of when the two rows were written — and
 *   `recordDeclaration` replaces the whole set at once, so `created_at` would
 *   order them by whichever insert the writer happened to do first.
 *   `@@unique([applicationPartyId, residencyType])` is what makes the leading
 *   column decide on its own: there is at most one Current and one Prior.
 *
 * Everything is loaded before anything is built, because the arcs need labels
 * from four containers at once and a fold that re-queried per arc would be
 * both slower and a second place for an order to differ.
 */

import type { Prisma } from "@hm/db";

/** A client inside a transaction, or the client itself. Reads only. */
export type DuReader = Prisma.TransactionClient;

/** Live rows, oldest first, ties broken by an id that cannot tie. */
const LIVE = { retiredAt: null } as const;
const EMISSION_ORDER: [{ createdAt: "asc" }, { id: "asc" }] = [{ createdAt: "asc" }, { id: "asc" }];

/**
 * The facts a party's `PARTY` block is written from.
 *
 * Read with the same rule `standingOf` in `@hm/shared` applies and not through
 * it, because that helper takes the wire DTO and this reads the rows: a
 * retracted or superseded assertion is out, and of what is left the most
 * recently OBSERVED wins, with `recorded_at` and then the id breaking ties so
 * the answer is stable rather than dependent on row order.
 */
export const PARTY_PREDICATES = [
  "legal_name",
  "date_of_birth",
  "email",
  "phone",
  "current_address",
  "marital_status",
  "citizenship",
] as const;

export type PartyFacts = Readonly<Record<string, unknown>>;

export async function loadPartyFacts(
  db: DuReader,
  partyIds: readonly string[],
): Promise<Map<string, PartyFacts>> {
  const byParty = new Map<string, Record<string, unknown>>();
  if (partyIds.length === 0) return byParty;
  const rows = await db.fact.findMany({
    where: {
      partyId: { in: [...partyIds] },
      predicate: { in: [...PARTY_PREDICATES] },
      subjectKey: "",
      retractedAt: null,
      supersededById: null,
    },
    orderBy: [{ observedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
    select: { partyId: true, predicate: true, value: true },
  });
  for (const row of rows) {
    if (row.partyId === null) continue;
    const held = byParty.get(row.partyId) ?? {};
    // The query is already in standing order, so the first row for a predicate
    // is the one that stands and every later one is history.
    if (!(row.predicate in held)) held[row.predicate] = row.value;
    byParty.set(row.partyId, held);
  }
  return byParty;
}

/**
 * Every column `DECLARATION_DETAIL` is written from.
 *
 * Spelled out rather than selected wholesale so that a column added to
 * `du_declarations` arrives here as a decision about the wire rather than as a
 * silent new element.
 */
const declarationColumns = {
  intentToOccupy: true,
  homeownerPastThreeYears: true,
  priorPropertyUsage: true,
  priorPropertyTitle: true,
  fhaSecondaryResidence: true,
  specialBorrowerSellerRelationship: true,
  undisclosedBorrowedFunds: true,
  undisclosedMortgageApplication: true,
  undisclosedCreditApplication: true,
  propertyProposedCleanEnergyLien: true,
  undisclosedComakerOfNote: true,
  outstandingJudgments: true,
  presentlyDelinquent: true,
  partyToLawsuit: true,
  priorPropertyDeedInLieuConveyed: true,
  priorPropertyShortSaleCompleted: true,
  priorPropertyForeclosureCompleted: true,
  bankruptcy: true,
} as const;

export type LoadedApplication = NonNullable<Awaited<ReturnType<typeof loadApplication>>>;
export type LoadedParty = LoadedApplication["parties"][number];
export type LoadedAsset = Awaited<ReturnType<typeof loadAssets>>[number];
export type LoadedLiability = Awaited<ReturnType<typeof loadLiabilities>>[number];
export type LoadedExpense = Awaited<ReturnType<typeof loadExpenses>>[number];
export type LoadedIncome = Awaited<ReturnType<typeof loadIncome>>[number];
export type LoadedEmployment = Awaited<ReturnType<typeof loadEmployments>>[number];

export function loadApplication(db: DuReader, applicationId: string) {
  return db.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      loanFile: {
        select: {
          id: true,
          purpose: true,
          propertyLine1: true,
          propertyLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyPostalCode: true,
          valueOrPrice: true,
          occupancy: true,
          termMonths: true,
          amortization: true,
          noteRate: true,
        },
      },
      scenarios: {
        where: { isActive: true },
        orderBy: { seq: "desc" },
        take: 1,
        select: {
          objective: true,
          lienPosition: true,
          occupancy: true,
          loanAmountCents: true,
          termMonths: true,
          noteRateBps: true,
          valueEstimateCents: true,
        },
      },
      parties: {
        where: { borrowerOrdinal: { not: null } },
        orderBy: { borrowerOrdinal: "asc" },
        select: {
          id: true,
          partyId: true,
          borrowerOrdinal: true,
          declaration: {
            select: { ...declarationColumns, chapters: { select: { chapter: true } } },
          },
          residences: {
            orderBy: [{ residencyType: "asc" }, { id: "asc" }],
            select: {
              residencyType: true,
              basis: true,
              durationMonths: true,
              monthlyRentCents: true,
              addressLineText: true,
              addressUnit: true,
              cityName: true,
              stateCode: true,
              postalCode: true,
              countryCode: true,
            },
          },
        },
      },
      vestings: {
        orderBy: EMISSION_ORDER,
        select: { id: true, status: true, fullName: true, vestingType: true },
      },
      dealParties: {
        orderBy: EMISSION_ORDER,
        select: {
          id: true,
          role: true,
          legalEntityName: true,
          firstName: true,
          lastName: true,
          licenseIdentifier: true,
          licenseAuthorityType: true,
          partyRoleIdentifier: true,
          addressLineText: true,
          cityName: true,
          stateCode: true,
          postalCode: true,
          contactTelephone: true,
        },
      },
      jointCredit: {
        orderBy: EMISSION_ORDER,
        select: { fromApplicationPartyId: true, toApplicationPartyId: true },
      },
    },
  });
}

export function loadAssets(db: DuReader, applicationId: string) {
  return db.duAsset.findMany({
    where: { applicationId, ...LIVE },
    orderBy: EMISSION_ORDER,
    select: {
      id: true,
      kind: true,
      assetType: true,
      assetTypeOtherDescription: true,
      cashOrMarketValueCents: true,
      holderName: true,
      accountIdentifier: true,
      fundsSourceType: true,
      includedInAssetAccount: true,
      ownedProperty: {
        select: {
          id: true,
          dispositionStatus: true,
          isSubject: true,
          addressLineText: true,
          addressUnit: true,
          cityName: true,
          stateCode: true,
          postalCode: true,
          countryCode: true,
          currentUsage: true,
          intendedUsage: true,
          estimatedValueCents: true,
          lienUpbCents: true,
          maintenanceExpenseCents: true,
          rentalIncomeGrossCents: true,
          rentalIncomeNetCents: true,
        },
      },
      owners: {
        orderBy: EMISSION_ORDER,
        select: { applicationPartyId: true },
      },
    },
  });
}

export function loadLiabilities(db: DuReader, applicationId: string) {
  return db.duLiability.findMany({
    where: { applicationId, ...LIVE },
    orderBy: EMISSION_ORDER,
    select: {
      id: true,
      liabilityType: true,
      holderName: true,
      accountIdentifier: true,
      mortgageType: true,
      unpaidBalanceCents: true,
      monthlyPaymentCents: true,
      remainingTermMonths: true,
      payoffStatus: true,
      exclusionIndicator: true,
      helocMaximumBalanceCents: true,
      paymentIncludesTaxesInsurance: true,
      securedByOwnedPropertyId: true,
      obligors: { orderBy: EMISSION_ORDER, select: { applicationPartyId: true } },
    },
  });
}

/** `du_expenses` has no `retired_at`: a person types an expense and no connector supersedes one. */
export function loadExpenses(db: DuReader, applicationId: string) {
  return db.duExpense.findMany({
    where: { applicationId },
    orderBy: EMISSION_ORDER,
    select: {
      id: true,
      expenseType: true,
      expenseOtherDescription: true,
      monthlyPaymentCents: true,
      remainingTermMonths: true,
      payers: { orderBy: EMISSION_ORDER, select: { applicationPartyId: true } },
    },
  });
}

/**
 * Income and employment hang off the LOAN FILE and the party, not off the
 * application, which is why these two take a file id where everything else
 * takes an application id.
 */
export function loadIncome(db: DuReader, loanFileId: string) {
  return db.incomeSource.findMany({
    where: { loanFileId, ...LIVE },
    orderBy: EMISSION_ORDER,
    select: {
      id: true,
      partyId: true,
      employerId: true,
      employmentIncome: true,
      type: true,
      monthlyAmount: true,
    },
  });
}

export function loadEmployments(db: DuReader, loanFileId: string) {
  return db.employment.findMany({
    where: { loanFileId, ...LIVE },
    orderBy: EMISSION_ORDER,
    select: {
      id: true,
      partyId: true,
      employerId: true,
      employerName: true,
      position: true,
      startDate: true,
      status: true,
    },
  });
}
