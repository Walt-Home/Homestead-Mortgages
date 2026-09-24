/**
 * The daily refinance review, run over our own loans.
 *
 * `@hm/refi-review` is the engine — the servicing app's 33.2 over its 20.1,
 * ported as a pure module — and this is what feeds it and keeps what it
 * says: every loan whose review is on, its newest observation and the
 * tape's facts beside it, and the rate the pricing port quotes for a
 * 30-year fixed on that loan today. One `loan_reviews` row per loan per
 * day, append-only, with the engine's facts and, for a candidate, the
 * benefit disclosure.
 *
 * Every loan on a servicer's book is watched from the day the book is
 * loaded, claimed or not: the row, an offer when it is a candidate, the
 * analyst's sentence for the card, the next review due tomorrow. The one
 * difference the claim makes is delivery. An offer on a claimed loan is
 * delivered as it is made — the person can see the card today — and its
 * thirty days run from now; an offer on an unclaimed loan is made and
 * waits, with no validity and no place in the two-a-year cap, until the
 * claim delivers it. The desk runs this the day a book lands so the
 * invitations can go to the candidates first.
 *
 * Quotes are memoized per kind of loan for the run: the port answers a
 * rate and no price, and a sheet's 30-year fixed rate is one number per
 * product, so a book of fourteen thousand loans is a dozen quotes.
 *
 * What is lawful here is what the loan model said it would be: a rate
 * comparison against a published sheet over our own servicing data, which
 * is not a consumer report. Nothing person-keyed is read — the row the
 * engine sees carries no name, no address and no date of birth — and the
 * pricing port is asked without a person, through the same unguarded call
 * screen 1 makes before anyone has authorized anything.
 *
 * Where the port differs from his platform, it is the rate. His 20.4 solves
 * the candidate rate off a sheet's price stack against the third-party
 * costs; ours quotes a rate and no price, so the sheet's rate is taken as
 * the pass-through rate with borrower-paid costs at zero, and a sheet that
 * returns a stack rather than one rate is answered as "no rate today", the
 * way his engine says `not_priceable`, rather than picked from by array
 * order. `services/pricing.ts` refuses the same ambiguity for the same
 * reason.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import { UnquotableScenarioError, type PricingConnector } from "@hm/connectors";
import type { PlainDate } from "@hm/kernel/calendar";
import {
  buildCandidate,
  fillReviewTokens,
  reasonsInWords,
  reviewLoan,
  universeLoanOf,
  type CandidateRate,
  type PropertyType as EnginePropertyType,
  type Review,
  type ReviewFacts,
  type UniverseLoan,
} from "@hm/refi-review";
import type { OccupancyType, PricingScenario, PropertyType } from "@hm/shared";
import { connectors } from "./connectors.js";
import { inChunks, type Db } from "./db.js";
import { toDomainLoanState } from "./loan-transition.js";
import { QUOTED_LOCK_DAYS } from "./pricing.js";
import {
  analystMaxPerDay,
  analystModelFromEnv,
  analystModelRan,
  analystTurn,
  type AnalystModel,
  type AnalystRecord,
} from "./refi-analyst.js";
import {
  NO_OFFER_STATE,
  dayEt,
  expireOffers,
  offerStateFor,
  openOffers,
  type OfferToOpen,
} from "./refi-offers.js";

/** Today in the creditor's zone, as the engine's day. */
export const todayEt = (now: Date = new Date()): PlainDate => dayEt(now);

const OCCUPANCY: Record<UniverseLoan["occupancy"], OccupancyType> = {
  primary: "primary_residence",
  second_home: "second_home",
  investment: "investment",
};
const PROPERTY: Record<EnginePropertyType, PropertyType> = {
  sfr: "single_family",
  pud: "single_family",
  condo: "condo",
  coop: "co_op",
  manufactured_home: "manufactured",
};

/**
 * The rate for this loan's candidate, off the pricing port, or null when
 * the port has none: an unquotable scenario, no 30-year fixed on the sheet,
 * or a stack the port cannot choose from without a policy it does not own.
 */
/**
 * One quote per kind of loan per run, not one per loan. The port answers a
 * rate and no price, and a sheet's 30-year fixed rate is one number per
 * product — what moves with the state, the amount and the loan-to-value are
 * price adjustments the port does not quote. So every loan of one purpose,
 * occupancy, property type and lock gets the sheet's one rate, and a book
 * of fourteen thousand loans is a dozen quotes rather than fourteen
 * thousand: the fixture sleeps 900 ms a quote and a vendor is a network
 * call, which is the difference between seconds and hours.
 */
export type QuoteMemo = Map<string, CandidateRate | null>;

function quoteKey(scenario: PricingScenario): string {
  return [scenario.purpose, scenario.occupancy, scenario.propertyType, scenario.lockDays].join("|");
}

export async function candidateRateFor(
  pricing: PricingConnector,
  row: UniverseLoan,
  asOf: PlainDate,
  memo?: QuoteMemo,
): Promise<CandidateRate | null> {
  const { candidate } = buildCandidate(row, { as_of: asOf });
  const scenario: PricingScenario = {
    purpose: "rate_term_refinance",
    occupancy: OCCUPANCY[row.occupancy],
    propertyType: PROPERTY[row.property_type],
    state: row.property_state,
    loanAmount: Number(candidate.loan_amount_cents) / 100,
    propertyValue: Number(row.value_estimate.value_cents) / 100,
    // The column the sheet is read on — his candidate is quoted off a
    // 45-day column of his sheet, and the column is the sheet's property,
    // not the candidate's; ours has one, and it is the one screen 1 reads.
    lockDays: QUOTED_LOCK_DAYS,
  };
  const key = quoteKey(scenario);
  if (memo?.has(key)) return memo.get(key) ?? null;
  let quotes;
  try {
    quotes = await pricing.quoteProducts(scenario);
  } catch (err) {
    if (err instanceof UnquotableScenarioError) {
      memo?.set(key, null);
      return null;
    }
    throw err;
  }
  const thirty = quotes.filter(
    (q) => q.basis === "borrower_rate" && q.termMonths === 360 && q.amortization === "fixed",
  );
  const one = thirty.length === 1 ? thirty[0] : null;
  const answer =
    !one || one.basis !== "borrower_rate"
      ? null
      : {
          note_rate_pct: one.noteRate.toFixed(3),
          source: `${pricing.capabilities.provider}:${one.productCode}`,
        };
  memo?.set(key, answer);
  return answer;
}

export interface ReviewedLoan {
  readonly loanId: string;
  readonly servicerLoanNumber: string | null;
  readonly verdict: Review["verdict"];
  readonly reasons: readonly string[];
  readonly candidateRatePct: string | null;
  /** Whether somebody has claimed the loan and can see the result today. */
  readonly claimed: boolean;
}

export interface ReviewRunReport {
  readonly asOf: PlainDate;
  /** Loans whose review is on: every loan on a book, claimed or not. */
  readonly monitored: number;
  /** Of those, the loans on a book nobody has claimed yet. */
  readonly unclaimed: number;
  readonly reviewed: readonly ReviewedLoan[];
  readonly alreadyReviewed: number;
  readonly skipped: readonly {
    loanId: string;
    servicerLoanNumber: string | null;
    reason: string;
  }[];
  /** Offers opened for the day's candidates, and open offers that lapsed before the pass. */
  readonly offersOpened: number;
  /** Of those, made on an unclaimed loan and waiting for the claim to be delivered. */
  readonly offersAwaitingClaim: number;
  readonly offersExpired: number;
  /** The analyst's turns: written, and skipped by reason. */
  readonly analyst: { readonly written: number; readonly skipped: Record<string, number> };
}

/**
 * Review every monitored loan for one day, once.
 *
 * A loan already reviewed for the day is left alone — the unique index
 * holds that too — so a second run in a day, or a deploy-time run beside
 * the scheduled one, writes nothing. A loan the tape cannot describe is
 * skipped with the reason and not guessed. `next_review_due_at` moves to
 * the next day, which is what the review's own index is shaped for.
 *
 * A loan holding an open offer, or an open refinance application opened
 * from one, is skipped too: the offer stands until the person answers or
 * it lapses, and a second verdict under it would be a second answer to a
 * question they are still holding. Open offers past their validity are
 * closed before the pass, so a loan whose offer lapsed is reviewed again the
 * same morning. A candidate opens an offer; the engine's gates — the
 * cooldown after a decline, the two-a-year cap, a standing never — are read
 * off the offers themselves.
 *
 * The analyst's turn runs per review when a model is on and the day's cap
 * has room; its record, or the reason it was skipped, is written with the
 * row. A turn never fails a review.
 */
export async function reviewLoans(
  opts: {
    asOf?: PlainDate;
    loanIds?: readonly string[];
    /** One servicer's book only. */
    servicerId?: string;
    pricing?: PricingConnector;
    /** The analyst's model; undefined reads the environment, null is the model off. */
    analyst?: AnalystModel | null;
    analystMaxPerDay?: number;
    now?: Date;
  } = {},
  db: Db = prisma,
): Promise<ReviewRunReport> {
  const asOf = opts.asOf ?? todayEt(opts.now);
  const now = opts.now ?? new Date();
  const pricing = opts.pricing ?? connectors().pricing;
  const analyst = opts.analyst === undefined ? analystModelFromEnv() : opts.analyst;
  const maxPerDay = opts.analystMaxPerDay ?? analystMaxPerDay();
  const day = new Date(`${asOf}T00:00:00.000Z`);
  const offersExpired = await expireOffers(db, now);
  const loans = await db.loan.findMany({
    where: {
      monitoringEnabled: true,
      ...(opts.loanIds ? { id: { in: [...opts.loanIds] } } : {}),
      ...(opts.servicerId ? { servicerId: opts.servicerId } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      rateType: true,
      noteRateBps: true,
      termMonths: true,
      originalPrincipalCents: true,
      originatedOn: true,
      firstPaymentOn: true,
      maturityOn: true,
      occupancy: true,
      propertyState: true,
      servicerLoanNumber: true,
      observations: {
        orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
        take: 1,
        select: {
          id: true,
          asOf: true,
          status: true,
          principalBalanceCents: true,
          escrowBalanceCents: true,
          scheduledPaymentCents: true,
          currentRatePct: true,
          nextPaymentDueOn: true,
          delinquencyDays: true,
          facts: true,
        },
      },
      reviews: { where: { asOf: day }, select: { id: true }, take: 1 },
    },
  });
  const unclaimed = (l: { status: (typeof loans)[number]["status"] }) =>
    toDomainLoanState(l.status) === "imported_unclaimed";
  // The people who can read a card today come first, so the analyst's daily
  // cap serves them before the book that is still waiting to be claimed.
  const due = loans
    .filter((l) => l.reviews.length === 0)
    .sort((a, b) => Number(unclaimed(a)) - Number(unclaimed(b)));
  const alreadyReviewed = loans.length - due.length;
  const offerStates = await offerStateFor(
    db,
    due.map((l) => l.id),
    now,
  );

  const reviewed: ReviewedLoan[] = [];
  const skipped: { loanId: string; servicerLoanNumber: string | null; reason: string }[] = [];
  const quotes: QuoteMemo = new Map();
  // Written as sets at the end: a book is thousands of rows and one morning.
  const rows: Prisma.LoanReviewCreateManyInput[] = [];
  const offers: OfferToOpen[] = [];
  const reviewedIds: string[] = [];
  let analystTurns = 0;
  const analystReport = { written: 0, skipped: {} as Record<string, number> };
  for (const loan of due) {
    const claimed = !unclaimed(loan);
    const state = offerStates.get(loan.id) ?? NO_OFFER_STATE;
    if (state.held) {
      skipped.push({
        loanId: loan.id,
        servicerLoanNumber: loan.servicerLoanNumber,
        reason: state.held,
      });
      continue;
    }
    const obs = loan.observations[0];
    if (!obs) {
      skipped.push({
        loanId: loan.id,
        servicerLoanNumber: loan.servicerLoanNumber,
        reason: "no servicing observation",
      });
      continue;
    }
    const u = universeLoanOf(
      {
        loan_id: loan.id,
        // An unclaimed loan is watched from the day its book was loaded; the
        // engine's word for a watched loan is `monitoring_only`, and the
        // claim is the door, not the switch.
        state: claimed ? toDomainLoanState(loan.status) : "monitoring_only",
        rate_type: loan.rateType === "ARM" ? "arm" : "fixed",
        note_rate_bps: loan.noteRateBps,
        term_months: loan.termMonths,
        original_principal_cents: loan.originalPrincipalCents,
        originated_on: loan.originatedOn?.toISOString().slice(0, 10) ?? null,
        first_payment_on: loan.firstPaymentOn?.toISOString().slice(0, 10) ?? null,
        maturity_on: loan.maturityOn?.toISOString().slice(0, 10) ?? null,
        occupancy: loan.occupancy,
        property_state: loan.propertyState,
      },
      {
        as_of: obs.asOf.toISOString(),
        status: obs.status,
        principal_balance_cents: obs.principalBalanceCents,
        escrow_balance_cents: obs.escrowBalanceCents,
        scheduled_payment_cents: obs.scheduledPaymentCents,
        current_rate_pct: obs.currentRatePct?.toFixed(3) ?? null,
        next_payment_due_on: obs.nextPaymentDueOn?.toISOString().slice(0, 10) ?? null,
        delinquency_days: obs.delinquencyDays,
        facts: (obs.facts ?? {}) as Record<string, string | number | boolean | null>,
      },
      asOf,
    );
    if ("skipped" in u) {
      skipped.push({
        loanId: loan.id,
        servicerLoanNumber: loan.servicerLoanNumber,
        reason: u.skipped,
      });
      continue;
    }
    // The gates read off the delivered offers: a decline within ninety days,
    // two offers in twelve months, or a standing never, each a `not_now` the
    // engine names, so the person's answer is what keeps the loan quiet.
    const row: UniverseLoan = state.doNotSolicit ? { ...u.row, refi_do_not_solicit: true } : u.row;
    const rate = await candidateRateFor(pricing, row, asOf, quotes);
    const review = reviewLoan(row, { as_of: asOf, rate, gate_facts: state.gate });
    const turn: AnalystRecord = await analystTurn(
      analyst,
      {
        loan_id: loan.id,
        as_of_date: asOf,
        verdict: review.verdict,
        reasons: review.reasons,
        facts: review.facts,
      },
      { turnsToday: analystTurns, maxPerDay },
    );
    if (analystModelRan(turn)) analystTurns += 1;
    if ("skipped" in turn) {
      analystReport.skipped[turn.skipped] = (analystReport.skipped[turn.skipped] ?? 0) + 1;
    } else {
      analystReport.written += 1;
    }
    const reviewId = randomUUID();
    rows.push({
      id: reviewId,
      loanId: loan.id,
      asOf: day,
      observationId: obs.id,
      verdict: review.verdict.toUpperCase() as "CANDIDATE" | "WATCHING" | "NOT_NOW" | "EXCLUDED",
      reasons: [...review.reasons] as Prisma.InputJsonValue,
      facts: review.facts as unknown as Prisma.InputJsonValue,
      offer: review.offer ? (review.offer as unknown as Prisma.InputJsonValue) : undefined,
      candidateRatePct: rate?.note_rate_pct ?? null,
      rateSource: rate?.source ?? null,
      ruleSetVersion: `${review.rule_set_version} (${review.port_version})`,
      explanation: review.explanation,
      analyst: turn as unknown as Prisma.InputJsonValue,
    });
    if (review.verdict === "candidate" && review.offer && rate) {
      offers.push({
        loanId: loan.id,
        reviewId,
        detectedOn: asOf,
        disclosure: review.offer as unknown as Prisma.InputJsonValue,
        candidateRatePct: rate.note_rate_pct,
        rateSource: rate.source,
        deliver: claimed,
      });
    }
    reviewedIds.push(loan.id);
    reviewed.push({
      loanId: loan.id,
      servicerLoanNumber: loan.servicerLoanNumber,
      verdict: review.verdict,
      reasons: review.reasons,
      candidateRatePct: rate?.note_rate_pct ?? null,
      claimed,
    });
  }
  await inChunks(rows, (chunk) => db.loanReview.createMany({ data: chunk }));
  await openOffers(db, offers, now);
  const tomorrow = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  await inChunks(reviewedIds, (chunk) =>
    db.loan.updateMany({ where: { id: { in: chunk } }, data: { nextReviewDueAt: tomorrow } }),
  );
  return {
    asOf,
    monitored: loans.length,
    unclaimed: loans.filter(unclaimed).length,
    reviewed,
    alreadyReviewed,
    skipped,
    offersOpened: offers.length,
    offersAwaitingClaim: offers.filter((o) => !o.deliver).length,
    offersExpired,
    analyst: analystReport,
  };
}

/** The newest review of one loan, as the route hands it out; null before the first. */
export async function latestLoanReview(loanId: string, db: Db = prisma) {
  const row = await db.loanReview.findFirst({
    where: { loanId },
    orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
  });
  if (!row) return null;
  const reasons = Array.isArray(row.reasons) ? (row.reasons as string[]) : [];
  const facts = row.facts as Record<string, unknown>;
  // The analyst's words, with every token filled from the row's own facts.
  // A skipped turn is nothing here: the engine's reasons in words stand.
  const record = row.analyst as AnalystRecord | null;
  const analyst =
    record && !("skipped" in record)
      ? {
          rationale: fillReviewTokens(record.rationale, facts as unknown as ReviewFacts),
          flags: [...record.flags],
          confidence: record.confidence,
        }
      : null;
  return {
    asOf: row.asOf.toISOString().slice(0, 10),
    verdict: row.verdict.toLowerCase() as Review["verdict"],
    reasons,
    reasonsInWords: reasonsInWords(reasons),
    facts,
    offer: (row.offer as Record<string, unknown> | null) ?? null,
    candidateRatePct: row.candidateRatePct?.toFixed(3) ?? null,
    rateSource: row.rateSource,
    ruleSetVersion: row.ruleSetVersion,
    explanation: row.explanation,
    analyst,
    recordedAt: row.recordedAt.toISOString(),
  };
}
