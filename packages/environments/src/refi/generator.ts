/**
 * Synthetic loans, seeded: no borrower's data, ever.
 *
 * Each task is drawn from its own stream keyed by its id, so a task is a
 * function of (split, suite seed, index) and can be rebuilt alone. A loan is
 * made the way a servicer's book is: an original balance, rate and term, a
 * first payment, a number of payments made, and the balance the engine's own
 * amortization says those payments leave — so the payment, the balance and
 * the remaining term always agree. The draws are weighted so every verdict
 * and every branch of the rules turns up; which verdict a loan gets is never
 * decided here, only by the engine at grading time.
 */

import { addDays, addMonths, parts, plainDate, ymd } from "@hm/kernel/calendar";
import {
  levelPaymentPct,
  scheduledUpb,
  type CandidateRate,
  type GateFacts,
  type Occupancy,
  type PropertyType,
  type UniverseLoan,
  type ValueEstimate,
} from "@hm/refi-review";
import { hash32, rngFor, type Rng } from "../rng.js";
import { ENVIRONMENT_NAME, ENVIRONMENT_VERSION, type RefiTask, type Split } from "./task.js";

export const taskId = (split: Split, suiteSeed: number, index: number): string =>
  `${ENVIRONMENT_NAME}/${ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const FIRST_REVIEW_DATE = plainDate("2025-01-02");
const REVIEW_DATE_SPAN_DAYS = 1456;

const eighths = (pct: number): string => (Math.round(pct * 8) / 8).toFixed(3);
const roundTo = (c: bigint, step: bigint): bigint => ((c + step / 2n) / step) * step;
const pctOf = (c: bigint, pctTimes1000: number): bigint =>
  (c * BigInt(pctTimes1000) + 50_000n) / 100_000n;

const STATES: readonly (readonly [string, number])[] = [
  ["MA", 15],
  ["CA", 14],
  ["TX", 11],
  ["FL", 10],
  ["NY", 8],
  ["AZ", 6],
  ["WA", 6],
  ["CO", 5],
  ["IL", 5],
  ["NJ", 5],
  ["GA", 5],
  ["NC", 5],
  ["OH", 5],
];

/** One task from a stream; exported so a variant environment can start from the same loans. */
export function drawRefiTask(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): RefiTask {
  const review_date = addDays(FIRST_REVIEW_DATE, r.int(0, REVIEW_DATE_SPAN_DAYS));
  const { y, m } = parts(review_date);
  const next_due_date = addMonths(ymd(y, m, 1), 1);

  const term = r.weighted<number>([
    [360, 80],
    [240, 8],
    [180, 12],
  ]);
  const age = Math.min(
    term - 1,
    r.weighted<() => number>([
      [() => r.int(1, 36), 40],
      [() => r.int(37, 72), 30],
      [() => r.int(73, 180), 30],
    ])(),
  );
  const first_payment_date = addMonths(next_due_date, -age);
  const note_date = addDays(addMonths(first_payment_date, -2), r.int(0, 27));

  // The quote first, then the note rate around it: above it by enough to
  // fire, near it, or below it.
  const quoteRate = eighths(4.75 + r.int(0, 22) / 8);
  const deltaEighths = r.weighted<() => number>([
    [() => r.int(3, 18), 60],
    [() => r.int(-2, 2), 22],
    [() => r.int(-16, -3), 18],
  ])();
  const note_rate_pct = eighths(Math.min(9, Math.max(2.25, Number(quoteRate) + deltaEighths / 8)));

  const original_upb_cents = BigInt(r.int(80, 1200)) * 100_000n;
  const origLtvX1000 = r.int(550, 970);
  const origValue = (original_upb_cents * 1000n) / BigInt(origLtvX1000);
  const pi_cents = levelPaymentPct(original_upb_cents, note_rate_pct, term);
  const upb_cents = scheduledUpb(original_upb_cents, note_rate_pct, term, age);

  const valueFactorX100 = r.int(80, 170);
  const value_cents = roundTo((origValue * BigInt(valueFactorX100)) / 100n, 100_000n);
  const source = r.weighted<ValueEstimate["source"]>([
    ["partner_fmv", 55],
    ["partner_bpo", 37],
    ["partner_appraisal", 8],
  ]);
  const valueAge = r.weighted<() => number>([
    [() => r.int(0, 360), 64],
    [() => r.int(361, 730), 30],
    [() => r.int(731, 1100), 6],
  ])();
  const valueAsOf = source === "partner_appraisal" ? note_date : addDays(review_date, -valueAge);
  const value_estimate: ValueEstimate = {
    source,
    value_cents: value_cents > 0n ? value_cents : 100_000n,
    as_of: valueAsOf,
    confidence: valueAsOf >= addMonths(review_date, -12) ? "medium" : "low",
  };

  const escrowed = r.chance(0.75);
  const escrow_monthly_cents = escrowed ? BigInt(r.int(150, 1500)) * 100n : 0n;
  const withMi = origLtvX1000 > 800 && upb_cents * 1000n > origValue * 780n;
  const mi_monthly_cents = withMi ? pctOf(upb_cents, r.int(5, 22) * 50) / 12n : 0n;

  const occupancy = r.weighted<Occupancy>([
    ["primary", 85],
    ["second_home", 8],
    ["investment", 7],
  ]);
  const property_type = r.weighted<PropertyType>([
    ["sfr", 70],
    ["pud", 15],
    ["condo", 12],
    ["coop", 2],
    ["manufactured_home", 1],
  ]);
  const arm = r.chance(0.06);
  const property_state = r.weighted(STATES);
  const delinquent = r.chance(0.06);

  const loan: UniverseLoan = {
    loan_id: `L${hash32(id).toString(16).padStart(8, "0")}`,
    status: r.chance(0.03) ? "not_active" : "active",
    product_code: arm ? "ARM" : `FRM${term / 12}`,
    amortization: arm ? "arm" : "fixed",
    note_date,
    first_payment_date,
    consummation_date: note_date,
    original_upb_cents,
    original_term_months: term,
    note_rate_pct,
    pi_cents,
    payments_made: age,
    upb_cents,
    next_due_date,
    remaining_term_months: term - age,
    escrowed,
    escrow_monthly_cents,
    net_escrow_deposit_estimate_cents: escrow_monthly_cents * 2n,
    mi_status: withMi ? "bpmi_active" : "none",
    mi_monthly_cents,
    occupancy,
    property_type,
    units: 1,
    property_state,
    value_estimate,
    representative_score: r.chance(0.03) ? null : r.int(620, 820),
    regx_days_delinquent: delinquent ? r.pick([30, 60, 90, 120]) : 0,
    bankruptcy_active: r.chance(0.03),
    foreclosure_referred: r.chance(0.02),
    lossmit_plan_active: r.chance(0.03),
    deceased_or_sii_pending: r.chance(0.01),
    transfer_out_pending: r.chance(0.02),
    refi_do_not_solicit: r.chance(0.03),
    arm_first_adjustment_date: arm ? addMonths(first_payment_date, r.pick([60, 84, 120])) : null,
  };

  const highLtv = upb_cents * 100n > value_estimate.value_cents * 78n;
  const quote: CandidateRate | null = r.chance(0.05)
    ? null
    : {
        note_rate_pct: quoteRate,
        source: "synthetic rate sheet",
        ...(highLtv && r.chance(0.6) ? { mi_monthly_cents: pctOf(upb_cents, 550) / 12n } : {}),
      };

  const gate_facts: GateFacts = {
    declined_on: r.chance(0.08) ? addDays(review_date, -r.int(1, 200)) : null,
    offered_at: r.chance(0.1)
      ? Array.from({ length: r.int(1, 3) }, () => addDays(review_date, -r.int(1, 540))).sort()
      : [],
  };

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    review_date,
    loan,
    quote,
    gate_facts,
    exceptions: r.chance(0.025) ? ["implausible_value"] : [],
  };
}

/** One task, rebuilt from its coordinates alone. */
export function generateTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): RefiTask {
  const id = taskId(split, suiteSeed, index);
  return drawRefiTask(rngFor(id), id, split, suiteSeed, index);
}

/** A suite: `n` tasks of one split from one seed. */
export function generateSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): RefiTask[] {
  return Array.from({ length: n }, (_, i) => generateTask(split, suiteSeed, i));
}

/**
 * The held-out suite every reported score is measured on: never used in a
 * prompt, a few-shot example or a training run. Its seed is fixed here so
 * that "the held-out set" means one thing.
 */
export const HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's own cases, as tasks ─────────────────────────────────────── */

const d = plainDate;

/** The servicing spec's worked example 1: $565,000 at 7.000 %, twenty-four payments in, reviewed Thu Oct 1, 2026. */
const EXAMPLE_ONE: UniverseLoan = {
  loan_id: "example-1",
  status: "active",
  product_code: "FRM30",
  amortization: "fixed",
  note_date: d("2024-09-18"),
  first_payment_date: d("2024-11-01"),
  consummation_date: d("2024-09-18"),
  original_upb_cents: 56_500_000n,
  original_term_months: 360,
  note_rate_pct: "7.000",
  pi_cents: 375_896n,
  payments_made: 24,
  upb_cents: 55_310_641n,
  next_due_date: d("2026-11-01"),
  remaining_term_months: 336,
  escrowed: true,
  escrow_monthly_cents: 150_000n,
  net_escrow_deposit_estimate_cents: 300_000n,
  mi_status: "none",
  mi_monthly_cents: 0n,
  occupancy: "primary",
  property_type: "sfr",
  units: 1,
  property_state: "AZ",
  value_estimate: {
    source: "partner_fmv",
    value_cents: 80_000_000n,
    as_of: d("2026-08-31"),
    confidence: "medium",
  },
  representative_score: 748,
  regx_days_delinquent: 0,
  bankruptcy_active: false,
  foreclosure_referred: false,
  lossmit_plan_active: false,
  deceased_or_sii_pending: false,
  transfer_out_pending: false,
  refi_do_not_solicit: false,
  arm_first_adjustment_date: null,
};

const RATE_6125: CandidateRate = { note_rate_pct: "6.125", source: "spec" };
const NO_GATES: GateFacts = { declined_on: null, offered_at: [] };

interface SpecCase {
  readonly name: string;
  readonly loan: UniverseLoan;
  readonly quote: CandidateRate | null;
  readonly gate_facts: GateFacts;
  /** What the spec says the review concludes, from `@hm/refi-review`'s own tests. */
  readonly verdict: "candidate" | "watching" | "not_now" | "excluded";
}

export const SPEC_CASES: readonly SpecCase[] = [
  {
    name: "20.1-T1 worked example 1",
    loan: EXAMPLE_ONE,
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "candidate",
  },
  {
    name: "20.1-T6 Massachusetts, consummated 45 months before",
    loan: { ...EXAMPLE_ONE, property_state: "MA", consummation_date: d("2023-02-06") },
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "candidate",
  },
  {
    name: "20.1-T7 a decline a month ago closes the path",
    loan: EXAMPLE_ONE,
    quote: RATE_6125,
    gate_facts: { declined_on: d("2026-09-01"), offered_at: [] },
    verdict: "not_now",
  },
  {
    name: "two offers in the rolling year",
    loan: EXAMPLE_ONE,
    quote: RATE_6125,
    gate_facts: { declined_on: null, offered_at: [d("2026-03-01"), d("2026-06-01")] },
    verdict: "not_now",
  },
  {
    name: "33.2-T3 a flat rate is watching",
    loan: EXAMPLE_ONE,
    quote: { note_rate_pct: "7.000", source: "spec" },
    gate_facts: NO_GATES,
    verdict: "watching",
  },
  {
    name: "no quote today",
    loan: EXAMPLE_ONE,
    quote: null,
    gate_facts: NO_GATES,
    verdict: "watching",
  },
  {
    name: "a value older than two years",
    loan: {
      ...EXAMPLE_ONE,
      value_estimate: { ...EXAMPLE_ONE.value_estimate, as_of: d("2024-01-01"), confidence: "low" },
    },
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "not_now",
  },
  {
    name: "an active bankruptcy",
    loan: { ...EXAMPLE_ONE, bankruptcy_active: true },
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "excluded",
  },
  {
    name: "thirty days late",
    loan: { ...EXAMPLE_ONE, regx_days_delinquent: 30 },
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "excluded",
  },
  {
    name: "not active",
    loan: { ...EXAMPLE_ONE, status: "not_active" },
    quote: RATE_6125,
    gate_facts: NO_GATES,
    verdict: "excluded",
  },
];

export const specTasks = (): RefiTask[] =>
  SPEC_CASES.map((c, index) => ({
    id: `${ENVIRONMENT_NAME}/${ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    review_date: d("2026-10-01"),
    loan: c.loan,
    quote: c.quote,
    gate_facts: c.gate_facts,
    exceptions: [],
  }));
