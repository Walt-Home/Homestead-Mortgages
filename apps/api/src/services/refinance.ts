/**
 * A refinance born from a loan we watch.
 *
 * When a person says yes to an offer, the application walks OUR five screens
 * — the same file, the same engine, the same signature — with screen 1
 * already answered from what the loan and the tape know: the address, the
 * kind of dwelling, how it is occupied, the servicer's value, the balance
 * and payment being paid off, and the amount the offer was built on. It
 * lands on screen 2. What screen 1 asks that no tape knows is the income the
 * person states, so the card asks for that one thing before it opens.
 *
 * The same seed answers "what would a refinance still need?" before the yes:
 * a file assembled in memory from it, run through the requirement engine as
 * a dry run, says which of our screens still have work. That is readiness in
 * our own requirement words rather than a second checklist beside them. Four
 * of his thirteen readiness items have no requirement of ours to run —
 * contact details, account activation, how fresh the value is, insurance —
 * and the card names them as unchecked rather than pretending.
 *
 * Rate-and-term only. `assertPurposeInScope` refuses cash-out here as it does
 * on screen 1, and the engine builds no cash-out candidate to begin with.
 */

import { prisma } from "@hm/db";
import type { Loan, LoanReview, RefiOffer } from "@hm/db";
import type { LoanFile, OccupancyType, PropertyType } from "@hm/shared";
import { outstandingForBorrower, type ScreenId } from "@hm/requirements";
import {
  occupancyOf,
  propertyTypeOf,
  type BenefitDisclosure,
  type ReviewFacts,
} from "@hm/refi-review";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { createDraftApplication, scenarioTermsFrom } from "./applications.js";
import { connectors } from "./connectors.js";
import { ownsTransaction, type Db } from "./db.js";
import { moveLoan } from "./loan-transition.js";
import { assertFacts, partnerFactsFor, partyForUser, principalForParty } from "./party.js";
import { quoteSubjectProduct } from "./pricing.js";
import { assertPurposeInScope } from "./scope.js";
import { settleReconciledEvidence } from "./standing.js";

/** What the tape calls a dwelling, in screen 1's words. */
const PROPERTY_TYPE: Record<ReturnType<typeof propertyTypeOf>, PropertyType> = {
  sfr: "single_family",
  pud: "single_family",
  condo: "condo",
  coop: "co_op",
  manufactured_home: "manufactured",
};
const OCCUPANCY: Record<ReturnType<typeof occupancyOf>, OccupancyType> = {
  primary: "primary_residence",
  second_home: "second_home",
  investment: "investment",
};
const VALUATION_SOURCE: Record<ReviewFacts["value_source"], SeedValuationSource> = {
  partner_fmv: "servicer_fmv",
  partner_bpo: "servicer_bpo",
  partner_appraisal: "servicer_appraisal",
};
type SeedValuationSource = "servicer_fmv" | "servicer_bpo" | "servicer_appraisal";

/** What screen 1 is answered with, from the loan, its newest observation and the offer. */
export interface RefinanceSeed {
  readonly purpose: "rate_term_refinance";
  readonly address: {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly propertyType: PropertyType;
  readonly occupancy: OccupancyType;
  readonly value: number;
  readonly valuationSource: SeedValuationSource;
  readonly loanAmount: number;
  readonly existingLoan: {
    readonly servicer: string;
    readonly loanNumber: string;
    readonly balance: number;
    readonly rate: number | null;
    readonly monthlyPayment: number;
    readonly paymentBasis: "principal_and_interest" | "scheduled_payment";
  };
  /** The offer's own product, for the dry run; the real file is quoted fresh. */
  readonly offered: {
    readonly noteRate: number;
    readonly termMonths: number;
    readonly quotedAt: Date;
  };
}

const cents = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
};

export async function refinanceSeed(
  db: Db,
  args: { loan: Loan; offer: RefiOffer; review: LoanReview },
): Promise<RefinanceSeed> {
  const { loan, offer, review } = args;
  if (!loan.propertyLine1 || !loan.propertyCity || !loan.propertyState) {
    throw new AppError(
      409,
      "We don't have this property's address on file yet, so a refinance can't start from here.",
      "REFINANCE_NEEDS_ADDRESS",
    );
  }
  const [obs, servicer] = await Promise.all([
    db.servicingObservation.findFirst({
      where: { loanId: loan.id },
      orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
      select: {
        facts: true,
        principalBalanceCents: true,
        currentRatePct: true,
        scheduledPaymentCents: true,
      },
    }),
    loan.servicerId
      ? db.servicer.findUnique({ where: { id: loan.servicerId }, select: { displayName: true } })
      : null,
  ]);
  const facts = (obs?.facts ?? {}) as Record<string, unknown>;
  const reviewFacts = review.facts as unknown as ReviewFacts;
  const disclosure = offer.disclosure as unknown as BenefitDisclosure;

  const value = cents(reviewFacts.value_cents);
  const loanAmount = cents(disclosure.loan_amount_cents);
  if (value === null || loanAmount === null) {
    throw new AppError(409, "This offer is missing a figure it was built on.", "OFFER_INCOMPLETE");
  }

  // The payment being paid off: the tape's principal and interest when it
  // carried one, else the scheduled payment as what it is, else the figure
  // the engine computed and the offer showed.
  const pi = cents(facts["pi_cents"]);
  const scheduled = cents(obs?.scheduledPaymentCents);
  const existingPayment =
    pi !== null
      ? { monthlyPayment: pi, paymentBasis: "principal_and_interest" as const }
      : scheduled !== null
        ? { monthlyPayment: scheduled, paymentBasis: "scheduled_payment" as const }
        : {
            monthlyPayment: cents(disclosure.current_pi_cents) ?? 0,
            paymentBasis: "principal_and_interest" as const,
          };
  const currentRate = obs?.currentRatePct ? Number(obs.currentRatePct) : loan.noteRateBps / 100;

  return {
    purpose: "rate_term_refinance",
    address: {
      line1: loan.propertyLine1,
      line2: loan.propertyLine2,
      city: loan.propertyCity,
      state: loan.propertyState.toUpperCase(),
      postalCode: loan.propertyPostalCode ?? "",
    },
    propertyType: PROPERTY_TYPE[propertyTypeOf(facts["property_type"] as never)],
    occupancy: loan.occupancy
      ? OCCUPANCY[occupancyOf(loan.occupancy as never)]
      : OCCUPANCY[occupancyOf(facts["occupancy"] as never)],
    value,
    valuationSource: VALUATION_SOURCE[reviewFacts.value_source] ?? "servicer_appraisal",
    loanAmount,
    existingLoan: {
      servicer: servicer?.displayName ?? "your servicer",
      loanNumber: loan.servicerLoanNumber ?? "",
      balance: cents(obs?.principalBalanceCents) ?? cents(reviewFacts.upb_cents) ?? 0,
      rate: Number.isFinite(currentRate) ? currentRate : null,
      ...existingPayment,
    },
    offered: {
      noteRate: Number(offer.candidateRatePct),
      termMonths: Number(disclosure.new_term_months) || 360,
      quotedAt: offer.offeredAt,
    },
  };
}

/* ── readiness: the engine, dry ──────────────────────────────────────────── */

/** His readiness items with no requirement of ours behind them. Named on the card, never faked. */
export const READINESS_UNMAPPED = [
  "contact_details",
  "account_activation",
  "value_freshness",
  "insurance",
] as const;

export interface RefinanceReadiness {
  /** Every screen the engine still has work on, and how much. Zero rows means nothing outstanding. */
  readonly byScreen: readonly { readonly screen: ScreenId; readonly outstanding: number }[];
  readonly unmapped: readonly string[];
}

/** The file as it would be born from the seed, before anybody has said who they are. */
export function seededLoanFile(seed: RefinanceSeed, now: Date = new Date()): LoanFile {
  const iso = now.toISOString();
  return {
    id: "refinance-dry-run",
    createdAt: iso,
    updatedAt: iso,
    stage: "identity",
    property: {
      address: {
        line1: seed.address.line1,
        line2: seed.address.line2 ?? undefined,
        city: seed.address.city,
        state: seed.address.state,
        postalCode: seed.address.postalCode,
      },
      deliverableAddressVerified: true,
      propertyType: seed.propertyType,
      estateType: null,
      occupancy: seed.occupancy,
      valueOrPrice: seed.value,
      valuationSource: seed.valuationSource,
      financedPropertyCount: 1,
    },
    loan: {
      purpose: seed.purpose,
      loanAmount: seed.loanAmount,
      downPayment: 0,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
      existingLoan: seed.existingLoan,
    },
    product: {
      productCode: config.quotedProductCode,
      termMonths: seed.offered.termMonths,
      amortization: "Fixed",
      noteRate: seed.offered.noteRate,
      rateQuotedAt: seed.offered.quotedAt.toISOString(),
      prepaymentPenalty: false,
      overlays: [],
    },
    borrowers: [],
    invitedBorrowers: [],
    vestings: [],
    consents: [],
    application: null,
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
    credit: null,
    assets: null,
    payroll: null,
    transcripts: [],
    incomeSources: [],
    employment: [],
    documents: [],
    disclosures: [],
    links: [],
    decision: null,
    sanctionsScreenClear: null,
    ssnValidatedWithSsa: null,
    fraudReviewComplete: false,
    applicationSignedAt: null,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
  };
}

/**
 * What our engine would still ask of the PERSON, by screen, on a file born
 * from this seed: the borrower's outstanding work, never the lender's — an
 * OFAC screen or a derived ratio is ours to do and no answer to "what would
 * you need from me".
 *
 * Screen 1 is left out on purpose. On a seeded file the engine lists two
 * borrower items there: the stated income, which the yes collects before
 * the file exists, and the first-time-homebuyer answer, which screen 2
 * takes. Neither is a screen the person walks, and a card that said the
 * property still needed them would send them back to a screen that is
 * already answered.
 */
export function refinanceReadiness(
  seed: RefinanceSeed,
  now: Date = new Date(),
): RefinanceReadiness {
  const counts = new Map<ScreenId, number>();
  for (const a of outstandingForBorrower(seededLoanFile(seed, now))) {
    const screen = a.requirement.screen;
    if (screen === "property_loan") continue;
    counts.set(screen, (counts.get(screen) ?? 0) + 1);
  }
  const byScreen = [...counts.entries()].map(([screen, outstanding]) => ({ screen, outstanding }));
  return { byScreen, unmapped: [...READINESS_UNMAPPED] };
}

/* ── the yes ─────────────────────────────────────────────────────────────── */

/**
 * The person as the servicer named them, handed back with the yes.
 *
 * Read through `partnerFactsFor`, the one reader that follows the claim's
 * merge: the tape's party folded into the person's at the claim and its
 * facts stayed where they were asserted, behind the pointer. Screen 2 does
 * not take this — it establishes who somebody is from their ID, and a
 * servicer's spelling of a name is not that — so it is a courtesy for the
 * page, never a fact the file carries.
 */
export interface RefinancePrefill {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly dateOfBirth: string | null;
}

export async function refinancePrefill(db: Db, partyId: string): Promise<RefinancePrefill> {
  const facts = await partnerFactsFor(db, partyId);
  const newest = (predicate: string) => facts.find((f) => f.predicate === predicate)?.value ?? null;
  const n = newest("legal_name") as { first?: unknown; last?: unknown } | null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    firstName: str(n?.first),
    lastName: str(n?.last),
    dateOfBirth: str(newest("date_of_birth")),
  };
}

/**
 * Open the refinance application, and end the offer as engaged, in one act.
 *
 * Screen 1's save, done for the person: the quote before the transaction
 * (a vendor round trip must not hold row locks), then the person, the file,
 * the stated income and the draft application in one transaction — exactly
 * the order `POST /files` writes them and for the same reasons — with the
 * prior loan on the application and the offer moved to ENGAGED beside it.
 * The rate is quoted fresh today rather than copied off the offer: the
 * offer's disclosure says it is not a commitment, and a file carrying a
 * rate nobody quoted today would carry it into every ratio on the decision.
 */
export async function openRefinanceApplication(
  args: {
    loan: Loan;
    offer: RefiOffer;
    review: LoanReview;
    userId: string;
    statedMonthlyIncome: number;
    now?: Date;
  },
  db: Db = prisma,
): Promise<{ fileId: string; applicationId: string; prefill: RefinancePrefill }> {
  const now = args.now ?? new Date();
  const seed = await refinanceSeed(db, args);
  assertPurposeInScope(seed.purpose);
  const product = await quoteSubjectProduct(connectors().pricing, {
    purpose: seed.purpose,
    occupancy: seed.occupancy,
    propertyType: seed.propertyType,
    state: seed.address.state,
    loanAmount: seed.loanAmount,
    propertyValue: seed.value,
  });

  const run = async (tx: Db) => {
    // The person first, then the file: the lock order `POST /files` explains.
    const partyId = await partyForUser(tx, args.userId);
    const principalId = await principalForParty(tx, partyId);
    const created = await tx.loanFile.create({
      data: {
        userId: args.userId,
        stage: "IDENTITY",
        purpose: "RATE_TERM_REFINANCE",
        loanAmount: seed.loanAmount,
        downPayment: 0,
        propertyLine1: seed.address.line1,
        propertyLine2: seed.address.line2,
        propertyCity: seed.address.city,
        propertyState: seed.address.state,
        propertyPostalCode: seed.address.postalCode,
        propertyType: seed.propertyType,
        occupancy: seed.occupancy,
        valueOrPrice: seed.value,
        valuationSource: seed.valuationSource,
        // The servicer's record of the address, which is a record and not the
        // borrower's typing; the same stand-in for APP-004 screen 1 makes.
        addressVerified: true,
        financedPropertyCount: 1,
        interestedPartyContributions: 0,
        existingServicer: seed.existingLoan.servicer,
        existingLoanNumber: seed.existingLoan.loanNumber,
        existingBalance: seed.existingLoan.balance,
        existingRate: seed.existingLoan.rate,
        existingMonthlyPayment: seed.existingLoan.monthlyPayment,
        existingPaymentBasis: seed.existingLoan.paymentBasis,
        productCode: product.productCode,
        termMonths: product.termMonths,
        noteRate: product.noteRate,
        rateQuoteLockDays: product.lockDays,
        rateQuotedAt: product.effectiveAt,
        rateQuoteExpiresAt: product.expiresAt,
      },
    });
    await assertFacts(tx, partyId, principalId, [
      { predicate: "monthly_income", value: args.statedMonthlyIncome },
    ]);
    await settleReconciledEvidence(tx, { partyId, causedBy: "refinance_offer:yes" });
    const terms = scenarioTermsFrom(created);
    if (!terms) throw new Error(`A refinance was seeded with no statable terms: ${created.id}`);
    const { applicationId } = await createDraftApplication(tx, {
      loanFileId: created.id,
      partyId,
      terms,
      priorLoanId: args.loan.id,
    });
    await tx.refiOffer.update({
      where: { id: args.offer.id },
      data: { status: "ENGAGED", answeredAt: now, applicationId },
    });
    const prefill = await refinancePrefill(tx, partyId);
    return { fileId: created.id, applicationId, prefill };
  };
  return ownsTransaction(db) ? await prisma.$transaction(run) : await run(db);
}

/* ── the funding ─────────────────────────────────────────────────────────── */

/**
 * The prior loan retired by the loan its refinance became.
 *
 * The one move that makes `refinanced_internally` mean something: the
 * application funded, the new loan exists, and the old one names it. The
 * trigger on `loans` refuses the move without the successor, so the pointer
 * is written first and the move after, in the caller's transaction. Null
 * when the application refinanced nothing of ours.
 */
export async function retirePriorLoan(
  db: Db,
  args: {
    applicationId: string;
    successorLoanId: string;
    actorPrincipalId: string;
    causedBy: string;
  },
): Promise<{ priorLoanId: string } | null> {
  const app = await db.application.findUniqueOrThrow({
    where: { id: args.applicationId },
    select: { priorLoanId: true, status: true },
  });
  if (!app.priorLoanId) return null;
  if (app.status !== "FUNDED") {
    throw new Error(
      `application ${args.applicationId} is ${app.status}; a prior loan is retired by a funding`,
    );
  }
  await db.loan.update({
    where: { id: app.priorLoanId },
    data: { refinancedByLoanId: args.successorLoanId },
  });
  await moveLoan(
    {
      id: app.priorLoanId,
      event: "refinanced_by_us",
      actorPrincipalId: args.actorPrincipalId,
      reasonCode: "internal_refinance_funded",
      causedBy: args.causedBy,
    },
    db,
  );
  return { priorLoanId: app.priorLoanId };
}
