/**
 * Annual escrow analyses, each drawn from a ten-year loan history the life
 * generator wrote: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). Its stream draws a
 * scenario for one escrowed loan: a life seed and, for most arms, a dated
 * event the bills obey: the county reassesses the property, up or down, or
 * the hazard premium rises at renewal. The loan is run for its decade
 * (`generate`), and every annual analysis in it is seen as the life
 * generator hands it to the engine (`LifeMoment`): the lines as the analyst
 * has them, the CPI, the balance on the run date and what is still to post,
 * the delinquency and the payment it replaces, which is the escrow share
 * billed on the first installment due after the run date (since 1.1.0, on
 * life 1.2.0; 1.0.0's was the old schedule's after last year's spread). The
 * task is one of those analyses, with the account's recent history beside it.
 *
 * The arm cycles by index through six, so any six tasks hold each, and each
 * names the verdict it lands on, so every verdict the runner tallies is at
 * least one arm in six:
 *   - reassessed_up: a reassessment of 25 to 80 % up, held, with a shortage;
 *   - premium_up: a premium 20 to 80 % higher at renewal, held, with a
 *     shortage;
 *   - reassessed_down: a reassessment of 30 to 60 % down on a larger loan,
 *     held, with a surplus refunded;
 *   - ordinary_shortage, ordinary_refund and ordinary_credit: no event; an
 *     analysis of the second year or later, from a year drawn, that is not
 *     held, with a shortage, a refund, or a surplus under $50 credited.
 * After an event, the analysis is the first on its arm among the three whose
 * coming year ends after the first bill the event changed: the one that can
 * see that bill among the coming year's (a hazard renewal is known there
 * half the time), and the two that see it in last year's. The renewal falls
 * in the two months before the computation year, so last year's figure
 * always carries the newest one, and the first analysis after the event
 * would never compare an increased bill with an old one. A draw that does
 * not land on its arm is drawn again under the next key.
 * Every analysis is the life generator's own, so the grader's run over the
 * task must conclude what the history did; a draw where it does not is
 * refused, and a test holds that none is. A task is then kept only once the
 * reference, working through the tools, lands exactly where the engine does.
 *
 * The histories draw from the calibration's typed defaults
 * (`defaultCalibration`), as the life generator's own tests do, so a change
 * to calibration.json does not move a pinned suite, and a browser draws the
 * same task the command line does.
 */

import { addMonths, plainDate } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { ESCROW_SPEC_CASES, escrowSpecTasks } from "../escrow/generator.js";
import {
  defaultCalibration,
  generate,
  type AnalysisRow,
  type Calibration,
  type LifeMoment,
  type LoanLife,
  type ScenarioEvent,
} from "../life/index.js";
import {
  expectedEscrowReview,
  gradeReviewAgainst,
  parseReviewSubmission,
  reviewAnalysis,
} from "./grader.js";
import { escrowReviewSteps } from "./reference.js";
import {
  REVIEW_ENVIRONMENT_NAME,
  REVIEW_ENVIRONMENT_VERSION,
  reviewPayload,
  type EscrowReviewTask,
} from "./task.js";
import { executeReviewTool } from "./tools.js";

export const reviewTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${REVIEW_ENVIRONMENT_NAME}/${REVIEW_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const REVIEW_ARMS = [
  "reassessed_up",
  "premium_up",
  "reassessed_down",
  "ordinary_shortage",
  "ordinary_refund",
  "ordinary_credit",
] as const;
export type ReviewArm = (typeof REVIEW_ARMS)[number];
export const reviewArmOf = (index: number): ReviewArm => REVIEW_ARMS[index % REVIEW_ARMS.length]!;

let calibration: Calibration | null = null;
const cal = (): Calibration => (calibration ??= defaultCalibration());

type AnalysisMoment = Extract<LifeMoment, { kind: "analysis" }>;

export interface ReviewDraw {
  readonly task: EscrowReviewTask;
  readonly life: LoanLife;
  readonly row: AnalysisRow;
}

/** The task, read off the history at the moment the analysis was about to be decided. */
export function reviewTaskAt(
  coords: Pick<EscrowReviewTask, "id" | "split" | "suite_seed" | "index">,
  life: LoanLife,
  m: AnalysisMoment,
): EscrowReviewTask {
  const d = life.draw;
  const since = addMonths(m.as_of, -24);
  return {
    ...coords,
    loan_number: d.servicer_loan_number,
    borrowers: d.parties.map((p) => `${p.given_name} ${p.surname}`),
    property_state: d.property.state,
    as_of: m.as_of,
    year_start: m.year_start,
    statement_sent_on: m.sent_on,
    lines: m.lines,
    cpi_change_pct: m.cpi_change_pct,
    cushion: { policy_months: 2, instrument_months: null, state_max_months: null },
    ledger: {
      balance_cents: m.balance,
      deposits: m.deposits.map((x) => ({
        on: x.on,
        amount_cents: x.amount,
        description: `installment due ${x.on}, escrow share`,
      })),
      disbursements: m.disbursements.map((x) => ({
        on: x.on,
        amount_cents: x.amount,
        description: `${x.line} bill`,
      })),
    },
    regx_days_delinquent: m.regx_days_delinquent,
    workout: false,
    borrower_election_months: null,
    instrument_shortage_max_months: null,
    current_escrow_payment_cents: m.old_payment,
    history: {
      analyses: life.analyses
        .filter((a) => a.as_of < m.as_of)
        .slice(-2)
        .map((a) => ({
          as_of: a.as_of,
          year_start: a.year_start,
          decision: a.decision,
          surplus_cents: a.surplus,
          shortage_cents: a.shortage,
          new_payment_cents: a.new_payment,
          effective_on: a.effective,
        })),
      disbursements: life.disbursements
        .filter((x) => x.on <= m.as_of && x.on > since)
        .map((x) => ({ on: x.on, line_type: x.line, amount_cents: x.amount })),
      month_ends: life.months
        .filter((x) => x.as_of < m.as_of)
        .slice(-12)
        .map((x) => ({
          month: x.month,
          escrow_balance_cents: x.escrow_balance,
          escrow_payment_cents: x.escrow_payment,
          days_delinquent: x.days_delinquent,
        })),
    },
  };
}

/** Whether the grader's run over the task concludes what the history's own analysis did. */
export function agreesWithHistory(task: EscrowReviewTask, row: AnalysisRow): boolean {
  const r = reviewAnalysis(task);
  const d = r.decision;
  const surplus =
    d.kind === "refund" || d.kind === "credit" || d.kind === "retain" ? d.surplus_cents : null;
  return (
    r.actual === row.projected_actual &&
    r.projection.annual_cents === row.annual &&
    r.projection.base_payment_cents === row.base_payment &&
    r.projection.target_at_start_cents === row.target_at_start &&
    d.kind === row.decision &&
    surplus === row.surplus &&
    (d.kind === "shortage" ? d.shortage_cents : null) === row.shortage &&
    r.payment.payment_cents === row.new_payment &&
    r.payment.first_month_cents === row.first_month_payment &&
    r.effective === row.effective &&
    task.current_escrow_payment_cents === row.old_payment &&
    // The history's flags are the engine's without the bill comparison, which the review adds.
    row.anomalies.every((x) => r.triggers.includes(x))
  );
}

/** Whether a task lands where its arm aims. */
export function onArm(arm: ReviewArm, task: EscrowReviewTask): boolean {
  const a = expectedEscrowReview(task);
  const shortage = a.decision === "shortage";
  switch (arm) {
    case "reassessed_up":
    case "premium_up":
      return a.flag_stands && shortage;
    case "reassessed_down":
      return a.flag_stands && a.decision === "refund";
    case "ordinary_shortage":
      return !a.flag_stands && shortage;
    case "ordinary_refund":
      return !a.flag_stands && a.decision === "refund";
    case "ordinary_credit":
      return !a.flag_stands && a.decision === "credit";
  }
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function reviewFairToGrade(task: EscrowReviewTask): boolean {
  const payload = JSON.parse(JSON.stringify(reviewPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(escrowReviewSteps, payload, executeReviewTool);
  } catch {
    return false;
  }
  const parsed = parseReviewSubmission(byRules);
  return parsed.ok && gradeReviewAgainst(expectedEscrowReview(task), parsed.answer).pass;
}

/** One candidate under one key: the scenario, its decade, and an analysis on the arm, or null when the draw has none. */
export function drawReviewCandidate(
  r: Rng,
  id: string,
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): ReviewDraw | null {
  const arm = reviewArmOf(index);
  const lifeSeed = r.int(0, 0x7fffffff);
  const month = r.int(14, 90);
  const events: ScenarioEvent[] =
    arm === "reassessed_up"
      ? [{ kind: "tax_reassessment", loan: 0, month, pct: r.int(25, 80) }]
      : arm === "premium_up"
        ? [{ kind: "insurance_increase", loan: 0, month, pct: r.int(20, 80) }]
        : arm === "reassessed_down"
          ? [{ kind: "tax_reassessment", loan: 0, month, pct: -r.int(30, 60) }]
          : [];
  // A reassessment down moves the payment far enough to be held only where the taxes are large.
  const upb = arm === "reassessed_down" ? r.int(4_000, 8_000) * 10_000 : null;
  const firstYear = r.int(2, 9);

  const moments = new Map<number, AnalysisMoment>();
  const res = generate(
    lifeSeed,
    {
      name: id,
      loans: 1,
      random: { payoff: false },
      pins: { 0: { escrowed: true, ...(upb !== null ? { orig_upb_cents: upb } : {}) } },
      events,
    },
    {
      calibration: cal(),
      observe: (_loan, _history, m) => {
        if (m.kind === "analysis") moments.set(m.year, m);
      },
    },
  );
  const life = res.clean.loans[0]!;
  // After an event, the first three analyses whose coming year ends after the first bill it changed: the
  // one that can see that bill among the coming year's, and the two that see it in last year's.
  const at = addMonths(life.draw.first_due, month);
  const basis = arm === "premium_up" ? "hazard" : "tax";
  const changed = life.lines
    .filter((l) => l.basis === basis)
    .flatMap((l) => l.bills.filter((b) => b.on >= at).slice(0, 1))
    .map((b) => b.on)
    .sort()[0];
  const rows =
    events.length > 0
      ? changed === undefined
        ? []
        : life.analyses.filter((a) => addMonths(a.year_start, 12) > changed).slice(0, 3)
      : [
          ...life.analyses.filter((a) => a.year >= firstYear),
          ...life.analyses.filter((a) => a.year >= 2 && a.year < firstYear),
        ];
  for (const row of rows) {
    const m = moments.get(row.year);
    if (!m || row.servicer !== "us") continue;
    const task = reviewTaskAt({ id, split, suite_seed: suiteSeed, index }, life, m);
    if (!agreesWithHistory(task, row)) continue;
    if (onArm(arm, task)) return { task, life, row };
  }
  return null;
}

const ATTEMPTS = 40;

export function drawReviewTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: EscrowReviewTask; attempts: number } {
  const id = reviewTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const drawn = drawReviewCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (drawn && reviewFairToGrade(drawn.task)) return { task: drawn.task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no ${reviewArmOf(index)} analysis in ${ATTEMPTS} draws`);
}

export const generateReviewTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawReviewTask(split, suiteSeed, index).task;

export function generateReviewSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): EscrowReviewTask[] {
  return Array.from({ length: n }, (_, i) => generateReviewTask(split, suiteSeed, i));
}

export const REVIEW_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked example, as tasks ────────────────────────────────── */

/**
 * §3.2's annual analysis and its three variants, escrow-analysis's spec
 * cases, reviewed. Today's escrow payment is the $130.00 the ledger deposits:
 * the example's $172.22 is a change of 32 %, held, and so is the deficiency
 * variant's $243.05; the refund's $138.33 and the credit's $136.11 are not.
 */
export const REVIEW_SPEC_CASES: readonly { readonly name: string }[] = ESCROW_SPEC_CASES.map(
  (c, i) => ({
    name: `${c.name}${i === 0 || i === 3 ? ", held: the payment changes more than 25 %" : ", not held"}`,
  }),
);

export const reviewSpecTasks = (): EscrowReviewTask[] =>
  escrowSpecTasks().map((t, index) => ({
    ...t,
    id: `${REVIEW_ENVIRONMENT_NAME}/${REVIEW_ENVIRONMENT_VERSION}/spec/0/${index}`,
    loan_number: "3.2-EXAMPLE",
    borrowers: ["Fixture Borrower"],
    property_state: "OH",
    history: {
      analyses: [],
      disbursements: [
        { on: plainDate("2026-07-15"), line_type: "tax_county", amount_cents: 52_000n },
        { on: plainDate("2026-09-15"), line_type: "tax_school", amount_cents: 36_000n },
        { on: plainDate("2026-12-15"), line_type: "tax_county", amount_cents: 76_000n },
        { on: plainDate("2027-03-15"), line_type: "tax_supplemental", amount_cents: 26_000n },
      ],
      month_ends: [],
    },
  }));
