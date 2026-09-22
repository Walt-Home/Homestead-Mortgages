/**
 * The daily refinance review, ported.
 *
 * Doug's §33.2 review over his 20.1 engine, brought across as a pure module:
 * the same arithmetic, the same candidate, the same fire rule, the same
 * verdict vocabulary and the same reason codes — so a loan reviewed here and
 * the same loan reviewed on his platform say the same thing for the same
 * inputs, and a test holds them to it. What is NOT here is everything his
 * engine closes over that this product does not have: his pass-through
 * pricing solve (20.4's sheet, LLPA matrix and cost schedules — the
 * candidate rate comes in through a rate port instead), the Fannie Mae
 * gates that read his 29.x delivery records (premium recapture, delivery in
 * process: treated as open, and said so), the analyst's model turn (rule 4),
 * and offer delivery (rule 5). Those are named where they are absent.
 *
 * Rates are percent strings on the eighth grid ("7.250"), money is `bigint`
 * cents, dates are the kernel's `PlainDate`, and every rounding is the one
 * his spec names — half-up to the cent at the step stated. The worked
 * examples in his 20.1 spec are this module's tests.
 */

import {
  Decimal,
  centsToDecimal,
  divRound,
  levelPayment,
  monthlyInterest,
  ratePercent,
  type Cents,
} from "@hm/kernel/money";
import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  parts,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";

/** His rule set's name, and this port's. The row carries both. */
export const RULE_SET_VERSION = "sm.refi_trigger.v1+partner_book.review.v1";
export const PORT_VERSION = "hm.refi-review.v1";

export const REFI_PRODUCT_CODE = "FRM30";
export const LCOR_CASH_BACK_FLOOR_CENTS: Cents = 200_000n;
export const LCOR_CASH_BACK_PCT = "1";
export const ROUNDING_STEP_CENTS: Cents = 100_000n;
/** Fannie Mae's Eligibility Matrix, as his 20.1 carries it, ×10,000. */
export const LTV_LIMITS_X10000 = {
  primary_fixed: 9700,
  second_home: 9000,
  investment: 7500,
} as const;
export const FNMA_OWNERSHIP_CHECK_LTV_X10000 = 9500;
/** 33.2 open question 1's default: a value within 12 months is `medium`, older `low`, beyond 24 months the review is `not_now`. */
export const VALUE_MEDIUM_MONTHS = 12;
export const VALUE_STALE_MONTHS = 24;
export const MA_28C_WINDOW_MONTHS = 60;

export const CANDIDATE_REASONS: readonly string[] = [
  "rate_delta",
  "npv_positive",
  "seven_year_delta_positive",
  "prescreen",
  "state_rule",
];
export const EXCLUSION_REASONS: readonly string[] = [
  "not_active",
  "bankruptcy_active",
  "foreclosure_referred",
  "lossmit_plan_active",
  "deceased_or_sii_pending",
  "transfer_out_pending",
  "delinquent",
];
export const NOT_NOW_REASONS: readonly string[] = [
  "cooldown",
  "frequency_cap",
  "premium_recapture_window",
  "marketing_suppression",
];

/** The program's parameters his data model carries as configuration (term sheet, unverified there too). */
export interface Program {
  readonly min_rate_reduction_bps: number;
  readonly min_npv_cents: Cents;
  readonly holding_period_months: number;
  readonly max_offers_per_loan_per_12m: number;
  readonly resolicit_cooldown_days: number;
}
export const DEFAULT_PROGRAM: Program = {
  min_rate_reduction_bps: 25,
  min_npv_cents: 0n,
  holding_period_months: 84,
  max_offers_per_loan_per_12m: 2,
  resolicit_cooldown_days: 90,
};

export type Occupancy = "primary" | "second_home" | "investment";
export type PropertyType = "sfr" | "pud" | "condo" | "coop" | "manufactured_home";
export type MiStatus = "none" | "bpmi_active";

export interface ValueEstimate {
  readonly source: "partner_fmv" | "partner_bpo" | "partner_appraisal";
  readonly value_cents: Cents;
  readonly as_of: PlainDate;
  readonly confidence: "medium" | "low";
}

/** One loan as the selection may see it: servicing facts and candidate inputs, and nothing that names a person. */
export interface UniverseLoan {
  readonly loan_id: string;
  readonly status: "active" | "not_active";
  readonly product_code: string;
  readonly amortization: "fixed" | "arm";
  readonly note_date: PlainDate;
  readonly first_payment_date: PlainDate;
  readonly consummation_date: PlainDate;
  readonly original_upb_cents: Cents;
  readonly original_term_months: number;
  readonly note_rate_pct: string;
  readonly pi_cents: Cents;
  readonly payments_made: number;
  readonly upb_cents: Cents;
  readonly next_due_date: PlainDate;
  readonly remaining_term_months: number;
  readonly escrowed: boolean;
  readonly escrow_monthly_cents: Cents;
  readonly net_escrow_deposit_estimate_cents: Cents;
  readonly mi_status: MiStatus;
  readonly mi_monthly_cents: Cents;
  readonly occupancy: Occupancy;
  readonly property_type: PropertyType;
  readonly units: 1 | 2 | 3 | 4;
  readonly property_state: string;
  readonly value_estimate: ValueEstimate;
  readonly representative_score: number | null;
  readonly regx_days_delinquent: number;
  readonly bankruptcy_active: boolean;
  readonly foreclosure_referred: boolean;
  readonly lossmit_plan_active: boolean;
  readonly deceased_or_sii_pending: boolean;
  readonly transfer_out_pending: boolean;
  readonly refi_do_not_solicit: boolean;
  readonly arm_first_adjustment_date: PlainDate | null;
}

/** What the gates read and the selection never does: the last decline and the rolling offer history. */
export interface GateFacts {
  readonly declined_on: PlainDate | null;
  readonly offered_at: readonly PlainDate[];
}
export const NO_GATE_FACTS: GateFacts = { declined_on: null, offered_at: [] };

const dec = (s: string): Decimal => Decimal.parse(s);
const maxC = (a: Cents, b: Cents): Cents => (a > b ? a : b);
const pctOfCents = (c: Cents, pct: string): Cents =>
  centsToDecimal(c).mul(ratePercent(pct)).toCents("HALF_UP");

/** "$3,758.96", for the explanation his engine writes. */
export const money = (c: Cents): string => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const d = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${d}.${(a % 100n).toString().padStart(2, "0")}`;
};

/* ── amortization arithmetic (his worked example 1) ─────────────────────── */

/** Scheduled interest each period rounded half-up (F-1-09); the balance after `n` scheduled payments. */
export function balanceAfter(
  startCents: Cents,
  noteRatePct: string,
  piCents: Cents,
  n: number,
): Cents {
  const r = ratePercent(noteRatePct);
  let u = startCents;
  for (let i = 0; i < n; i++) {
    const int = monthlyInterest(u, r);
    u -= piCents - int;
    if (u < 0n) return 0n;
  }
  return u;
}

/** Scheduled UPB after `paymentsMade` payments on the original terms ($565,000 at 7.000 % after 24 = $553,106.41). */
export const scheduledUpb = (
  originalCents: Cents,
  noteRatePct: string,
  termMonths: number,
  paymentsMade: number,
): Cents =>
  balanceAfter(
    originalCents,
    noteRatePct,
    levelPayment(originalCents, ratePercent(noteRatePct), termMonths),
    paymentsMade,
  );

/** The level payment at a percent rate: `L × r/12 ÷ (1 − (1 + r/12)^−n)`, half-up ($560,000 at 6.125 % → $3,402.62). */
export const levelPaymentPct = (loanCents: Cents, noteRatePct: string, termMonths: number): Cents =>
  levelPayment(loanCents, ratePercent(noteRatePct), termMonths);

/** Per diem at note_rate / 365 on the balance, half-up ($553,106.41 × 7.000 % / 365 = $106.08). */
export const perDiem365 = (upbCents: Cents, noteRatePct: string): Cents =>
  centsToDecimal(upbCents)
    .mul(ratePercent(noteRatePct))
    .div(Decimal.fromInt(365))
    .toCents("HALF_UP");

export interface PayoffEstimate {
  readonly upb_cents: Cents;
  readonly per_diem_cents: Cents;
  readonly days: number;
  readonly payoff_cents: Cents;
  readonly through: PlainDate;
}

/** Payoff through the disbursement date: balance + per diem × days from the next due date ($554,273.29 in his example). */
export function payoffEstimate(
  loan: Pick<UniverseLoan, "upb_cents" | "note_rate_pct" | "next_due_date">,
  through: PlainDate,
): PayoffEstimate {
  const days = Math.max(0, daysBetween(loan.next_due_date, through));
  const per_diem_cents = perDiem365(loan.upb_cents, loan.note_rate_pct);
  return {
    upb_cents: loan.upb_cents,
    per_diem_cents,
    days,
    payoff_cents: loan.upb_cents + per_diem_cents * BigInt(days),
    through,
  };
}

export interface PrepaidInterest {
  readonly days: number;
  readonly per_diem_cents: Cents;
  readonly prepaid_interest_cents: Cents;
  readonly interest_paid_through_date: PlainDate;
}

/** His 30.2: interest from the disbursement date through the end of its month, inclusive, at the rounded per diem (Nov 12–30 = 19 days × $93.97). */
export function prepaidInterest(
  amountCents: Cents,
  noteRatePct: string,
  disbursement: PlainDate,
): PrepaidInterest {
  const ipt = endOfMonth(disbursement);
  const days = daysBetween(disbursement, ipt) + 1;
  const per_diem_cents = perDiem365(amountCents, noteRatePct);
  return {
    days,
    per_diem_cents,
    prepaid_interest_cents: per_diem_cents * BigInt(days),
    interest_paid_through_date: ipt,
  };
}

/** Remaining interest on the existing loan = pi × remaining term − upb. */
export const remainingInterest = (
  piCents: Cents,
  remainingMonths: number,
  upbCents: Cents,
): Cents => piCents * BigInt(remainingMonths) - upbCents;

/** NPV of a level monthly delta over H months at r/12, half-up at the end ($356.34 × 84 at 6.125 % = $24,292.78). */
export function npvOfDelta(deltaCents: Cents, annualRatePct: string, months: number): Cents {
  const rm = ratePercent(annualRatePct).div(Decimal.fromInt(12));
  const d = centsToDecimal(deltaCents);
  let f = Decimal.ONE;
  let sum = Decimal.ZERO;
  for (let m = 1; m <= months; m++) {
    f = f.mul(Decimal.ONE.add(rm));
    sum = sum.add(d.div(f));
  }
  return sum.toCents("HALF_UP");
}

/** `(r0 − r1) × 10,000` to one decimal, from percent strings (7.250 → 6.375 = 87.5). */
export const rateDeltaBps = (r0Pct: string, r1Pct: string): number =>
  Number(dec(r0Pct).sub(dec(r1Pct)).mul(Decimal.fromInt(100)).toFixed(1, "HALF_UP"));

/** Whole months from `a` to `b` (Feb 6, 2023 → Nov 6, 2026 = 45). */
export function monthsBetween(a: PlainDate, b: PlainDate): number {
  const pa = parts(a);
  const pb = parts(b);
  let m = (pb.y - pa.y) * 12 + (pb.m - pa.m);
  if (pb.d < pa.d) m -= 1;
  return m;
}

/** Rule 3 of 33.2: the rate the loan would need to see to fire — the current rate minus 25 bps, floored to the eighth grid. */
export function watchRatePct(noteRatePct: string): string {
  const r = dec(noteRatePct).sub(dec("0.25"));
  const eighths = Math.floor(Number(r.mul(Decimal.fromInt(8)).toFixed(6, "HALF_UP")) + 1e-9);
  return (eighths / 8).toFixed(3);
}

/* ── candidate construction (his rule 2) ────────────────────────────────── */

export interface CandidateSchedule {
  readonly consummation_date: PlainDate;
  readonly disbursement_date: PlainDate;
  readonly first_payment_date: PlainDate;
}

/** His run's standard schedule: consummation 36 days out, disbursement after rescission (+6), first payment on the 1st after the following month. */
export function defaultSchedule(asOf: PlainDate): CandidateSchedule {
  const consummation_date = addDays(asOf, 36);
  const disbursement_date = addDays(consummation_date, 6);
  const p = parts(addMonths(disbursement_date, 1));
  const first_payment_date = addMonths(ymd(p.y, p.m, 1), 1);
  return { consummation_date, disbursement_date, first_payment_date };
}

export interface CandidateTerms {
  readonly product_code: string;
  readonly term_months: number;
  readonly payoff_estimate_cents: Cents;
  readonly per_diem_cents: Cents;
  readonly payoff_days: number;
  readonly prepaid_interest_cents: Cents;
  readonly prepaid_days: number;
  readonly net_escrow_deposit_cents: Cents;
  readonly loan_amount_cents: Cents;
  readonly rounded_to_thousand: boolean;
  readonly cash_back_cents: Cents;
  readonly cash_back_cap_cents: Cents;
  readonly value_cents: Cents;
  readonly value_source: ValueEstimate["source"];
  readonly ltv: string;
  readonly ltv_x10000: number;
  readonly schedule: CandidateSchedule;
}

export interface EligibilityPrescreen {
  readonly ltv_ok: boolean;
  readonly occupancy_ok: boolean;
  readonly delinquency_ok: boolean;
  readonly product_ok: boolean;
  readonly requires_fnma_ownership_check: boolean;
  readonly ltv_limit_x10000: number;
  readonly reasons: readonly string[];
}

/** B2-1.3-02: cash back cap = max(1 % of the new loan amount, $2,000). */
export const cashBackCap = (loanCents: Cents): Cents =>
  maxC(pctOfCents(loanCents, LCOR_CASH_BACK_PCT), LCOR_CASH_BACK_FLOOR_CENTS);
const roundUpToThousand = (c: Cents): Cents =>
  ((c + ROUNDING_STEP_CENTS - 1n) / ROUNDING_STEP_CENTS) * ROUNDING_STEP_CENTS;

/** LTV = loan / value to 4 dp. */
export function ltvOf(loanCents: Cents, valueCents: Cents): { ltv: string; x10000: number } {
  if (valueCents <= 0n) throw new RangeError("value_cents must be positive");
  const x = Number(divRound(loanCents * 10_000n, valueCents, "HALF_UP"));
  return { ltv: (x / 10_000).toFixed(4), x10000: x };
}

export const ltvLimit = (occupancy: Occupancy): number =>
  occupancy === "primary"
    ? LTV_LIMITS_X10000.primary_fixed
    : occupancy === "second_home"
      ? LTV_LIMITS_X10000.second_home
      : LTV_LIMITS_X10000.investment;

/**
 * Rule 2: a 30-year fixed limited-cash-out candidate. Loan amount = payoff
 * estimate + prepaid interest (estimated at the existing note rate, as his
 * does before pricing) + net escrow deposit, rounded up to the next $1,000
 * only while the cash back stays under the cap. Cash-out is never built
 * here: his engine builds it only on a borrower's request, and nothing on
 * this side asks yet.
 */
export function buildCandidate(
  loan: UniverseLoan,
  o: { as_of: PlainDate; schedule?: CandidateSchedule; term_months?: number },
): { candidate: CandidateTerms; prescreen: EligibilityPrescreen } {
  const schedule = o.schedule ?? defaultSchedule(o.as_of);
  const payoff = payoffEstimate(loan, schedule.disbursement_date);
  const term_months = o.term_months ?? 360;
  const disb = schedule.disbursement_date;
  const raw =
    payoff.payoff_cents +
    prepaidInterest(payoff.payoff_cents, loan.note_rate_pct, disb).prepaid_interest_cents +
    loan.net_escrow_deposit_estimate_cents;
  const rounded = roundUpToThousand(raw);
  const cashBack = (L: Cents) =>
    L - payoff.payoff_cents - prepaidInterest(L, loan.note_rate_pct, disb).prepaid_interest_cents;
  const useRounded = cashBack(rounded) <= cashBackCap(rounded);
  const loan_amount_cents = useRounded ? rounded : raw;
  const prepaid = prepaidInterest(loan_amount_cents, loan.note_rate_pct, disb);
  const cash_back_cents = loan_amount_cents - payoff.payoff_cents - prepaid.prepaid_interest_cents;
  const { ltv, x10000 } = ltvOf(loan_amount_cents, loan.value_estimate.value_cents);
  const limit = ltvLimit(loan.occupancy);
  const reasons: string[] = [];
  const ltv_ok = x10000 <= limit && !(loan.value_estimate.confidence === "low" && x10000 > 9000);
  if (!ltv_ok) {
    reasons.push(
      x10000 > limit
        ? `ltv ${ltv} exceeds ${limit / 100}% (Eligibility Matrix)`
        : "value_confidence=low and ltv > 90%",
    );
  }
  const occupancy_ok = ["primary", "second_home", "investment"].includes(loan.occupancy);
  if (!occupancy_ok) reasons.push("occupancy");
  const product_ok = loan.amortization === "fixed" || loan.amortization === "arm";
  if (!product_ok) reasons.push("product");
  const delinquency_ok = loan.regx_days_delinquent === 0;
  if (!delinquency_ok) reasons.push("delinquent");
  if (cash_back_cents > cashBackCap(loan_amount_cents)) reasons.push("cash_back_exceeds_cap");
  return {
    candidate: {
      product_code: REFI_PRODUCT_CODE,
      term_months,
      payoff_estimate_cents: payoff.payoff_cents,
      per_diem_cents: payoff.per_diem_cents,
      payoff_days: payoff.days,
      prepaid_interest_cents: prepaid.prepaid_interest_cents,
      prepaid_days: prepaid.days,
      net_escrow_deposit_cents: loan.net_escrow_deposit_estimate_cents,
      loan_amount_cents,
      rounded_to_thousand: useRounded,
      cash_back_cents,
      cash_back_cap_cents: cashBackCap(loan_amount_cents),
      value_cents: loan.value_estimate.value_cents,
      value_source: loan.value_estimate.source,
      ltv,
      ltv_x10000: x10000,
      schedule,
    },
    prescreen: {
      ltv_ok,
      occupancy_ok,
      delinquency_ok,
      product_ok,
      requires_fnma_ownership_check: x10000 > FNMA_OWNERSHIP_CHECK_LTV_X10000 && ltv_ok,
      ltv_limit_x10000: limit,
      reasons,
    },
  };
}

/* ── the rate, through a port ───────────────────────────────────────────── */

/**
 * What the rate port answered for the candidate: the note rate a 30-year
 * fixed is quoted at today, on the eighth grid, and where it came from. His
 * engine solves this off a sheet's price stack against the third-party
 * costs (20.4); this product's pricing port quotes a rate and no price, so
 * the costs are the program's — paid by the lender and recovered through
 * the rate, borrower-paid costs zero — and the quoted rate is taken as the
 * pass-through rate. Null is "no rate today", which his engine calls
 * `not_priceable`.
 */
export interface CandidateRate {
  readonly note_rate_pct: string;
  readonly source: string;
  /** Monthly MI on the candidate, when the port or the LTV says so. Zero at 80 % LTV and below. */
  readonly mi_monthly_cents?: Cents;
}

/* ── benefit metrics (his rule 4) ───────────────────────────────────────── */

export interface BenefitMetrics {
  readonly rate_delta_bps: number;
  readonly pi_delta_cents: Cents;
  readonly mi_delta_cents: Cents;
  readonly payment_delta_cents: Cents;
  readonly borrower_paid_costs_cents: Cents;
  readonly breakeven_months: number | null;
  readonly existing_remaining_interest_cents: Cents;
  readonly new_lifetime_interest_cents: Cents;
  readonly lifetime_interest_delta_cents: Cents;
  readonly same_term_months: number;
  readonly same_term_pi_cents: Cents;
  readonly same_term_pi_delta_cents: Cents;
  readonly same_term_lifetime_interest_cents: Cents;
  readonly same_term_lifetime_interest_delta_cents: Cents;
  readonly same_term_npv_cents: Cents;
  readonly holding_period_months: number;
  readonly npv_cents: Cents;
  readonly existing_balance_at_h_cents: Cents;
  readonly new_balance_at_h_cents: Cents;
  readonly balance_delta_at_h_cents: Cents;
  readonly seven_year_total_cost_delta_cents: Cents;
  readonly existing_note_rate_pct: string;
  readonly candidate_note_rate_pct: string;
  readonly existing_pi_cents: Cents;
  readonly candidate_pi_cents: Cents;
}

/** Rule 4 in full, from the priced candidate; borrower-paid costs are zero by program design. */
export function computeBenefit(
  loan: UniverseLoan,
  c: CandidateTerms,
  rate: CandidateRate,
  program: Pick<Program, "holding_period_months">,
): BenefitMetrics {
  const r0 = loan.note_rate_pct;
  const r1 = rate.note_rate_pct;
  const H = program.holding_period_months;
  const pi0 = loan.pi_cents;
  const pi1 = levelPaymentPct(c.loan_amount_cents, r1, c.term_months);
  const L1 = c.loan_amount_cents;
  const mi1 = c.ltv_x10000 > 8000 ? (rate.mi_monthly_cents ?? 0n) : 0n;
  const mi0 = loan.mi_status === "bpmi_active" ? loan.mi_monthly_cents : 0n;
  const pi_delta_cents = pi0 - pi1;
  const mi_delta_cents = mi0 - mi1;
  const payment_delta_cents = pi_delta_cents + mi_delta_cents;
  const borrower_paid_costs_cents = 0n;
  const breakeven_months = 0;
  const existing_remaining_interest_cents = remainingInterest(
    pi0,
    loan.remaining_term_months,
    loan.upb_cents,
  );
  const new_lifetime_interest_cents = pi1 * BigInt(c.term_months) - L1;
  const same_term_months = loan.remaining_term_months;
  const same_term_pi_cents = levelPaymentPct(L1, r1, same_term_months);
  const same_term_lifetime_interest_cents = same_term_pi_cents * BigInt(same_term_months) - L1;
  const existing_balance_at_h_cents = balanceAfter(loan.upb_cents, r0, pi0, H);
  const new_balance_at_h_cents = balanceAfter(L1, r1, pi1, H);
  return {
    rate_delta_bps: rateDeltaBps(r0, r1),
    pi_delta_cents,
    mi_delta_cents,
    payment_delta_cents,
    borrower_paid_costs_cents,
    breakeven_months,
    existing_remaining_interest_cents,
    new_lifetime_interest_cents,
    lifetime_interest_delta_cents: new_lifetime_interest_cents - existing_remaining_interest_cents,
    same_term_months,
    same_term_pi_cents,
    same_term_pi_delta_cents: pi0 - same_term_pi_cents,
    same_term_lifetime_interest_cents,
    same_term_lifetime_interest_delta_cents:
      same_term_lifetime_interest_cents - existing_remaining_interest_cents,
    same_term_npv_cents: npvOfDelta(pi0 - same_term_pi_cents + mi_delta_cents, r1, H),
    holding_period_months: H,
    npv_cents: npvOfDelta(payment_delta_cents, r1, H),
    existing_balance_at_h_cents,
    new_balance_at_h_cents,
    balance_delta_at_h_cents: existing_balance_at_h_cents - new_balance_at_h_cents,
    seven_year_total_cost_delta_cents:
      pi0 * BigInt(H) + existing_balance_at_h_cents - (pi1 * BigInt(H) + new_balance_at_h_cents),
    existing_note_rate_pct: r0,
    candidate_note_rate_pct: r1,
    existing_pi_cents: pi0,
    candidate_pi_cents: pi1,
  };
}

/* ── the fire rule (his rule 5) ─────────────────────────────────────────── */

export interface FireDecision {
  readonly fire: boolean;
  readonly present_same_term_first: boolean;
  readonly reasons: readonly string[];
}

/**
 * `offer_ready` iff the rate delta clears the floor, the NPV is positive,
 * the seven-year total cost is lower, the prescreen and the state rule pass
 * and nothing suppresses; a 30-year reset that costs more over the full
 * term is allowed only when the same-remaining-term candidate also has a
 * positive NPV, and that option is presented first.
 */
export function fireRule(
  m: Pick<
    BenefitMetrics,
    | "rate_delta_bps"
    | "npv_cents"
    | "seven_year_total_cost_delta_cents"
    | "lifetime_interest_delta_cents"
    | "same_term_npv_cents"
  >,
  program: Pick<Program, "min_rate_reduction_bps" | "min_npv_cents">,
  gates: { prescreen_ok: boolean; state_rule_ok: boolean; suppression_reasons: readonly string[] },
): FireDecision {
  const reasons: string[] = [];
  if (m.rate_delta_bps < program.min_rate_reduction_bps) {
    reasons.push(`rate_delta_bps ${m.rate_delta_bps} < ${program.min_rate_reduction_bps}`);
  }
  if (m.npv_cents <= program.min_npv_cents)
    reasons.push(`npv_cents ${m.npv_cents} ≤ ${program.min_npv_cents}`);
  if (m.seven_year_total_cost_delta_cents <= 0n) reasons.push("seven_year_total_cost_delta ≤ 0");
  if (!gates.prescreen_ok) reasons.push("prescreen_failed");
  if (!gates.state_rule_ok) reasons.push("state_rule_failed");
  reasons.push(...gates.suppression_reasons);
  let present_same_term_first = false;
  if (m.lifetime_interest_delta_cents > 0n) {
    if (m.same_term_npv_cents > 0n) present_same_term_first = true;
    else reasons.push("lifetime_interest_delta > 0 and same_term_npv ≤ 0");
  }
  return { fire: reasons.length === 0, present_same_term_first, reasons };
}

/* ── gates and the state rule ───────────────────────────────────────────── */

export interface GateResult {
  readonly open: boolean;
  readonly opens_on: PlainDate | null;
  readonly reason: string | null;
}
const gateOpen = (open: boolean, opens_on: PlainDate | null, reason: string): GateResult =>
  open ? { open: true, opens_on, reason: null } : { open: false, opens_on, reason };

/** SM_REFI_RESOLICIT_COOLDOWN_90: closed until the decline + 90 days. */
export function resolicitCooldownGate(f: {
  declined_on: PlainDate | null;
  as_of: PlainDate;
  days?: number;
}): GateResult {
  if (!f.declined_on) return gateOpen(true, null, "");
  const opens_on = addDays(f.declined_on, f.days ?? 90);
  return gateOpen(
    f.as_of >= opens_on,
    opens_on,
    `cooldown after the ${f.declined_on} decline: opens ${opens_on}`,
  );
}

/** SM_REFI_OFFER_FREQUENCY_CAP: at most N offers per rolling 12 months. */
export function offerFrequencyCapGate(f: {
  offered_at: readonly PlainDate[];
  as_of: PlainDate;
  max_offers_per_loan_per_12m?: number;
}): GateResult {
  const max = f.max_offers_per_loan_per_12m ?? 2;
  const since = addMonths(f.as_of, -12);
  const counted = f.offered_at.filter((d) => d > since && d <= f.as_of).sort();
  if (counted.length < max) return gateOpen(true, null, "");
  return gateOpen(
    false,
    addMonths(counted[counted.length - max]!, 12),
    `${counted.length} offers in the rolling 12 months ≥ cap ${max}`,
  );
}

export type BorrowerInterestFactor = "payment_reduction" | "rate_reduction";
export interface BorrowerInterestDetermination {
  readonly applies: boolean;
  readonly months_since_consummation: number;
  readonly pass: boolean;
  readonly factors: readonly BorrowerInterestFactor[];
  readonly rule: string | null;
}
export interface JurisdictionRefiRule {
  readonly statute: string;
  readonly window_months: number;
}
export const MA_183_28C: JurisdictionRefiRule = {
  statute: "M.G.L. c.183 §28C",
  window_months: MA_28C_WINDOW_MONTHS,
};
/** The one state rule his data model carries. Others load as new entries without changing the code. */
export const DEFAULT_JURISDICTION_RULES: Readonly<
  Record<string, JurisdictionRefiRule | undefined>
> = { MA: MA_183_28C };

/**
 * MA_183_28C_BORROWER_INTEREST_60M: where the state's rule is set and the
 * existing loan was consummated under 60 months before the candidate, the
 * refinance must be in the borrower's interest — a lower payment after
 * costs, or a lower rate. A longer amortization is never a factor.
 */
export function borrowerInterestRule(f: {
  property_state: string;
  existing_consummation_date: PlainDate;
  candidate_consummation_date: PlainDate;
  rules: Readonly<Record<string, JurisdictionRefiRule | undefined>>;
  pi_delta_cents: Cents;
  borrower_paid_costs_cents: Cents;
  rate_delta_bps: number;
  breakeven_months?: number | null;
}): BorrowerInterestDetermination {
  const rule = f.rules[f.property_state];
  const months = monthsBetween(f.existing_consummation_date, f.candidate_consummation_date);
  if (!rule || months >= rule.window_months) {
    return {
      applies: false,
      months_since_consummation: months,
      pass: true,
      factors: [],
      rule: rule?.statute ?? null,
    };
  }
  const factors: BorrowerInterestFactor[] = [];
  if (
    f.pi_delta_cents > 0n &&
    (f.borrower_paid_costs_cents === 0n ||
      (f.breakeven_months !== null &&
        f.breakeven_months !== undefined &&
        f.breakeven_months <= rule.window_months))
  ) {
    factors.push("payment_reduction");
  }
  if (f.rate_delta_bps > 0) factors.push("rate_reduction");
  return {
    applies: true,
    months_since_consummation: months,
    pass: factors.length > 0,
    factors,
    rule: rule.statute,
  };
}

/* ── the universe (his rule 1), one loan at a time ──────────────────────── */

export type ExclusionReason =
  | "not_active"
  | "bankruptcy_active"
  | "foreclosure_referred"
  | "lossmit_plan_active"
  | "deceased_or_sii_pending"
  | "transfer_out_pending"
  | "delinquent"
  | "marketing_suppression"
  | "cooldown"
  | "frequency_cap";

/**
 * Why a loan is out of today's proactive universe, in his order, or null
 * when it is in. The two gates that read his 29.x delivery records — the
 * premium-recapture window and the closing-to-delivery pipeline — are not
 * here: nothing on this side holds a Fannie Mae purchase date or a delivery
 * queue, so they are open, and the decision record says so.
 */
export function exclusionOf(
  row: UniverseLoan,
  facts: GateFacts,
  asOf: PlainDate,
  program: Program,
): { reason: ExclusionReason; opens_on: PlainDate | null } | null {
  const out = (reason: ExclusionReason, opens_on: PlainDate | null = null) => ({
    reason,
    opens_on,
  });
  if (row.status !== "active") return out("not_active");
  if (row.bankruptcy_active) return out("bankruptcy_active");
  if (row.foreclosure_referred) return out("foreclosure_referred");
  if (row.lossmit_plan_active) return out("lossmit_plan_active");
  if (row.deceased_or_sii_pending) return out("deceased_or_sii_pending");
  if (row.transfer_out_pending) return out("transfer_out_pending");
  if (row.regx_days_delinquent > 0) return out("delinquent");
  if (row.refi_do_not_solicit) return out("marketing_suppression");
  const cd = resolicitCooldownGate({
    declined_on: facts.declined_on,
    as_of: asOf,
    days: program.resolicit_cooldown_days,
  });
  if (!cd.open) return out("cooldown", cd.opens_on);
  const cap = offerFrequencyCapGate({
    offered_at: facts.offered_at,
    as_of: asOf,
    max_offers_per_loan_per_12m: program.max_offers_per_loan_per_12m,
  });
  if (!cap.open) return out("frequency_cap", cap.opens_on);
  return null;
}

/* ── the review (his 33.2, rule 3) ──────────────────────────────────────── */

export type ReviewVerdict = "candidate" | "watching" | "not_now" | "excluded";

/** The review's inputs as the engine saw them: the row's facts and the day's figures, copied, never recomputed. */
export interface ReviewFacts {
  readonly note_rate_pct: string;
  readonly candidate_rate_pct: string | null;
  readonly rate_delta_bps: number | null;
  readonly upb_cents: string;
  readonly value_cents: string;
  readonly value_source: ValueEstimate["source"];
  readonly value_as_of: PlainDate;
  readonly value_confidence: "medium" | "low";
  readonly ltv: string;
  readonly remaining_term_months: number;
  readonly pi_cents: string;
  readonly candidate_pi_cents: string | null;
  readonly candidate_loan_amount_cents: string | null;
  readonly monthly_delta_cents: string | null;
  readonly npv_cents: string | null;
  readonly breakeven_months: number | null;
  readonly seven_year_delta_cents: string | null;
  readonly days_delinquent: number;
  readonly flags: readonly string[];
  readonly watch_rate_pct?: string;
}

/** His rule 10 payload, computed fields only: what a disclosure and a card are built from. */
export interface BenefitDisclosure {
  readonly current_rate_pct: string;
  readonly current_pi_cents: string;
  readonly new_rate_pct: string;
  readonly new_pi_cents: string;
  readonly rate_delta_bps: number;
  readonly pi_delta_cents: string;
  readonly remaining_term_months: number;
  readonly new_term_months: number;
  readonly loan_amount_cents: string;
  readonly lifetime_interest_existing_cents: string;
  readonly lifetime_interest_new_cents: string;
  readonly same_term_months: number;
  readonly same_term_pi_cents: string;
  readonly same_term_lifetime_interest_cents: string;
  readonly present_same_term_first: boolean;
  readonly cash_back_cents: string;
  readonly cash_back_cap_cents: string;
  readonly borrower_paid_costs_cents: string;
  readonly npv_cents: string;
  readonly holding_period_months: number;
  readonly seven_year_total_cost_delta_cents: string;
  readonly costs_statement: string;
  readonly not_a_commitment: true;
}

export interface Review {
  readonly loan_id: string;
  readonly as_of: PlainDate;
  readonly verdict: ReviewVerdict;
  readonly reasons: readonly string[];
  readonly facts: ReviewFacts;
  readonly offer: BenefitDisclosure | null;
  readonly candidate: CandidateTerms | null;
  readonly metrics: BenefitMetrics | null;
  readonly prescreen: EligibilityPrescreen | null;
  readonly state_determination: BorrowerInterestDetermination | null;
  readonly excluded: { reason: ExclusionReason; opens_on: PlainDate | null } | null;
  readonly rate_source: string | null;
  readonly explanation: string;
  readonly rule_set_version: string;
  readonly port_version: string;
}

export interface ReviewContext {
  readonly as_of: PlainDate;
  /** The rate port's answer for the candidate, or null for no rate today. */
  readonly rate: CandidateRate | null;
  readonly program?: Program;
  readonly jurisdiction_rules?: Readonly<Record<string, JurisdictionRefiRule | undefined>>;
  readonly gate_facts?: GateFacts;
  /** Exceptions the tape reader raised on the row (`implausible_value` is the one the verdict reads). */
  readonly exceptions?: readonly string[];
  readonly schedule?: CandidateSchedule;
}

const within = (date: PlainDate, asOf: PlainDate, months: number): boolean =>
  date >= addMonths(asOf, -months);

/** His rule 10 in words: the same explanation his engine writes for a candidate. */
export function explainBenefit(o: {
  existing: Pick<UniverseLoan, "remaining_term_months">;
  candidate: CandidateTerms;
  metrics: BenefitMetrics;
  present_same_term_first: boolean;
}): string {
  const m = o.metrics;
  const c = o.candidate;
  const same = `Over the same ${m.same_term_months} months you have left, the new rate would make the payment ${money(m.same_term_pi_cents)} and cost ${money(m.same_term_lifetime_interest_cents)} in interest instead of ${money(m.existing_remaining_interest_cents)}.`;
  const reset = `A new ${c.term_months}-month term lowers the payment to ${money(m.candidate_pi_cents)} (${money(m.pi_delta_cents)} a month less) and costs ${money(m.new_lifetime_interest_cents)} in interest over its full term${m.lifetime_interest_delta_cents > 0n ? ", which is more than the interest left on your current loan" : `, ${money(-m.lifetime_interest_delta_cents)} less than the interest left on your current loan`}.`;
  return `${o.present_same_term_first ? `${same} ${reset}` : `${reset} ${same}`} Third-party costs are paid by the lender and recovered from the sale of the loan through the rate — the rate you are offered already includes those costs; you could get a lower rate by paying them yourself. This is not a commitment to lend; rates change daily.`;
}

function factsOf(i: {
  row: UniverseLoan;
  candidate: CandidateTerms | null;
  metrics: BenefitMetrics | null;
  rate: CandidateRate | null;
  exceptions: readonly string[];
  as_of: PlainDate;
  verdict: ReviewVerdict;
}): ReviewFacts {
  const { row, candidate: ct, metrics: m } = i;
  const ve = row.value_estimate;
  const flags: string[] = [];
  if (row.bankruptcy_active) flags.push("bankruptcy_active");
  if (row.foreclosure_referred) flags.push("foreclosure_referred");
  if (row.lossmit_plan_active) flags.push("lossmit_plan_active");
  if (row.deceased_or_sii_pending) flags.push("deceased_or_sii_pending");
  if (row.transfer_out_pending) flags.push("transfer_out_pending");
  if (row.refi_do_not_solicit) flags.push("marketing_suppression");
  if (row.regx_days_delinquent > 0) flags.push("delinquent");
  if (row.mi_status === "bpmi_active") flags.push("mi_active");
  if (ve.confidence === "low") flags.push("value_low_confidence");
  if (!within(ve.as_of, i.as_of, VALUE_STALE_MONTHS)) flags.push("value_stale");
  if (
    row.arm_first_adjustment_date &&
    row.arm_first_adjustment_date >= i.as_of &&
    row.arm_first_adjustment_date <= addMonths(i.as_of, 12)
  ) {
    flags.push("arm_reset_within_12m");
  }
  for (const x of i.exceptions) if (!flags.includes(x)) flags.push(x);
  const facts: ReviewFacts = {
    note_rate_pct: row.note_rate_pct,
    candidate_rate_pct: i.rate?.note_rate_pct ?? null,
    rate_delta_bps: m?.rate_delta_bps ?? null,
    upb_cents: String(row.upb_cents),
    value_cents: String(ve.value_cents),
    value_source: ve.source,
    value_as_of: ve.as_of,
    value_confidence: ve.confidence,
    ltv: ltvOf(row.upb_cents, ve.value_cents).ltv,
    remaining_term_months: row.remaining_term_months,
    pi_cents: String(row.pi_cents),
    candidate_pi_cents: m ? String(m.candidate_pi_cents) : null,
    candidate_loan_amount_cents: ct ? String(ct.loan_amount_cents) : null,
    monthly_delta_cents: m ? String(m.payment_delta_cents) : null,
    npv_cents: m ? String(m.npv_cents) : null,
    breakeven_months: m ? m.breakeven_months : null,
    seven_year_delta_cents: m ? String(m.seven_year_total_cost_delta_cents) : null,
    days_delinquent: row.regx_days_delinquent,
    flags,
  };
  return i.verdict === "watching"
    ? { ...facts, watch_rate_pct: watchRatePct(row.note_rate_pct) }
    : facts;
}

/**
 * One loan's review of the day.
 *
 * His pipeline, in his order: the universe's exclusion first; then the
 * candidate and its prescreen; then the rate through the port (his 20.4
 * solve is where the two differ); the benefit metrics; the state rule; the
 * fire rule; and the state machine that turns an opportunity's status into
 * a verdict — `candidate`, `watching` (current and eligible, the numbers
 * are not there today), `not_now` (a gate, a stale or implausible value, or
 * a candidate that could not be priced), `excluded` (not current, or not in
 * the universe at all).
 */
export function reviewLoan(row: UniverseLoan, ctx: ReviewContext): Review {
  const program = ctx.program ?? DEFAULT_PROGRAM;
  const rules = ctx.jurisdiction_rules ?? DEFAULT_JURISDICTION_RULES;
  const gateFacts = ctx.gate_facts ?? NO_GATE_FACTS;
  const exceptions = ctx.exceptions ?? [];
  const base = {
    loan_id: row.loan_id,
    as_of: ctx.as_of,
    rate_source: ctx.rate?.source ?? null,
    rule_set_version: RULE_SET_VERSION,
    port_version: PORT_VERSION,
  };

  const excluded = exclusionOf(row, gateFacts, ctx.as_of, program);
  if (excluded && EXCLUSION_REASONS.includes(excluded.reason)) {
    const verdict: ReviewVerdict = "excluded";
    return {
      ...base,
      verdict,
      reasons: [excluded.reason],
      facts: factsOf({
        row,
        candidate: null,
        metrics: null,
        rate: null,
        exceptions,
        as_of: ctx.as_of,
        verdict,
      }),
      offer: null,
      candidate: null,
      metrics: null,
      prescreen: null,
      state_determination: null,
      excluded,
      explanation: `excluded: ${excluded.reason}`,
    };
  }

  const built = buildCandidate(row, {
    as_of: ctx.as_of,
    ...(ctx.schedule ? { schedule: ctx.schedule } : {}),
  });
  const suppression: string[] = excluded ? [excluded.reason] : [];
  const metrics = ctx.rate ? computeBenefit(row, built.candidate, ctx.rate, program) : null;
  if (!metrics) suppression.push("not_priceable");
  const sd = metrics
    ? borrowerInterestRule({
        property_state: row.property_state,
        existing_consummation_date: row.consummation_date,
        candidate_consummation_date: built.candidate.schedule.consummation_date,
        rules,
        pi_delta_cents: metrics.pi_delta_cents,
        borrower_paid_costs_cents: metrics.borrower_paid_costs_cents,
        rate_delta_bps: metrics.rate_delta_bps,
        breakeven_months: metrics.breakeven_months,
      })
    : null;
  const prescreen_ok =
    built.prescreen.ltv_ok &&
    built.prescreen.occupancy_ok &&
    built.prescreen.product_ok &&
    built.prescreen.delinquency_ok;
  const fire = metrics
    ? fireRule(metrics, program, {
        prescreen_ok,
        state_rule_ok: sd ? sd.pass : true,
        suppression_reasons: suppression,
      })
    : { fire: false, present_same_term_first: false, reasons: [...suppression, "not_priced"] };

  // His verdictOf, in his order: an exclusion first, then the not-now
  // conditions — a gate, an implausible or stale value — which override a
  // firing candidate, then the candidate, then watching.
  const implausible = exceptions.includes("implausible_value");
  const stale = !within(row.value_estimate.as_of, ctx.as_of, VALUE_STALE_MONTHS);
  let verdict: ReviewVerdict;
  let reasons: string[];
  if (fire.fire && !implausible && !stale) {
    verdict = "candidate";
    reasons = [...CANDIDATE_REASONS];
  } else if (fire.reasons.some((r) => EXCLUSION_REASONS.includes(r))) {
    verdict = "excluded";
    reasons = [...fire.reasons];
  } else if (implausible || stale || fire.reasons.some((r) => NOT_NOW_REASONS.includes(r))) {
    verdict = "not_now";
    reasons = [
      ...fire.reasons,
      ...(implausible ? ["implausible_value"] : []),
      ...(stale ? ["value_stale"] : []),
    ];
  } else {
    verdict = "watching";
    reasons = fire.reasons.length ? [...fire.reasons] : ["no_benefit"];
  }

  const offer: BenefitDisclosure | null =
    verdict === "candidate" && metrics
      ? {
          current_rate_pct: row.note_rate_pct,
          current_pi_cents: String(row.pi_cents),
          new_rate_pct: metrics.candidate_note_rate_pct,
          new_pi_cents: String(metrics.candidate_pi_cents),
          rate_delta_bps: metrics.rate_delta_bps,
          pi_delta_cents: String(metrics.pi_delta_cents),
          remaining_term_months: row.remaining_term_months,
          new_term_months: built.candidate.term_months,
          loan_amount_cents: String(built.candidate.loan_amount_cents),
          lifetime_interest_existing_cents: String(metrics.existing_remaining_interest_cents),
          lifetime_interest_new_cents: String(metrics.new_lifetime_interest_cents),
          same_term_months: metrics.same_term_months,
          same_term_pi_cents: String(metrics.same_term_pi_cents),
          same_term_lifetime_interest_cents: String(metrics.same_term_lifetime_interest_cents),
          present_same_term_first: fire.present_same_term_first,
          cash_back_cents: String(built.candidate.cash_back_cents),
          cash_back_cap_cents: String(built.candidate.cash_back_cap_cents),
          borrower_paid_costs_cents: String(metrics.borrower_paid_costs_cents),
          npv_cents: String(metrics.npv_cents),
          holding_period_months: metrics.holding_period_months,
          seven_year_total_cost_delta_cents: String(metrics.seven_year_total_cost_delta_cents),
          costs_statement:
            "the rate you are offered already includes those costs; you could get a lower rate by paying them yourself",
          not_a_commitment: true,
        }
      : null;

  return {
    ...base,
    verdict,
    reasons,
    facts: factsOf({
      row,
      candidate: built.candidate,
      metrics,
      rate: ctx.rate,
      exceptions,
      as_of: ctx.as_of,
      verdict,
    }),
    offer,
    candidate: built.candidate,
    metrics,
    prescreen: { ...built.prescreen },
    state_determination: sd,
    excluded,
    explanation:
      verdict === "candidate" && metrics
        ? explainBenefit({
            existing: row,
            candidate: built.candidate,
            metrics,
            present_same_term_first: fire.present_same_term_first,
          })
        : `${verdict}: ${reasons.join(", ")}`,
  };
}
