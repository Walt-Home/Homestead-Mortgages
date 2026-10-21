/**
 * Synthetic delinquent loans, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is made the
 * way a servicer's is: an original balance, rate and 30-year term, a number
 * of payments made (the balance is the engine's own amortization of them),
 * a number of months behind (the accrued interest is the engine's own), the
 * advances, sometimes an earlier modification's forbearance or a buydown,
 * and the pre-modification payment. Then it is aimed at an edge of the
 * waterfall:
 *   - MTMLTV around 50.00, where step 3 starts (at 50.00) and step 5 needs
 *     more than 50.00 — including 49.995 and 50.004, which print as 50.00;
 *   - a rate already on the MIR, a whole number of eighths above it, or off
 *     the grid (one partial step to the floor), and an ARM below the MIR;
 *   - a target the rate or the term alone reaches, one only forbearance
 *     reaches, and one nothing reaches (exhaustion), where 31 days
 *     delinquent or fewer decides eligibility at P&I equal to the pre-mod;
 *   - a pre-modification P&I that is a multiple of 5 cents, whose 80% is an
 *     exact cent and so is not the target;
 *   - a rate-table row effective on the evaluation date, and a later one;
 *   - a failed trial 364 or 365 days back, and three prior modifications;
 *   - a notice on the 15th or the 16th, and one in December.
 *
 * A task is kept only once the reference, working through the tools, lands
 * exactly where the engine does; the engine is exact decimal arithmetic, so
 * this is a guard rather than a filter, and a test says how rarely it bites.
 */

import { levelPayment, ratePercent } from "@hm/kernel/money";
import { addDays, addMonths, plainDate, ymd, parts } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { gradeFlexAgainst, expectedFlex, parseFlexSubmission } from "./grader.js";
import { accruedInterest, balanceAfter } from "./ported/flexmod.js";
import { flexSteps } from "./reference.js";
import {
  FLEX_ENVIRONMENT_NAME,
  FLEX_ENVIRONMENT_VERSION,
  flexPayload,
  type FlexTask,
} from "./task.js";
import { executeFlexTool } from "./tools.js";

export const flexTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${FLEX_ENVIRONMENT_NAME}/${FLEX_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const FIRST_EVALUATION = plainDate("2026-01-05");
const thousandths = (r: Rng, lo: number, hi: number) => (r.int(lo, hi) / 1000).toFixed(3);
const eighths = (r: Rng, lo: number, hi: number) => (r.int(lo * 8, hi * 8) / 8).toFixed(3);

type Aim = "mtmltv_edge" | "under_50" | "moderate" | "deep" | "exhaust";

/** One candidate; the caller keeps it only if it is fair to grade. */
export function drawFlexCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): FlexTask {
  const evaluation_on = addDays(FIRST_EVALUATION, r.int(0, 700));

  // The loan as originated, and where it stands.
  const original = BigInt(r.int(800, 7_000)) * 10_000n;
  const contract = r.chance(0.8) ? eighths(r, 3, 8.5) : thousandths(r, 3_000, 8_500);
  const made = r.int(12, 150);
  const behind = r.int(2, 14);
  const ib_upb_cents = balanceAfter(original, contract, 360, made);
  const accrued_interest_cents = accruedInterest(ib_upb_cents, contract, behind);
  const escrow_advances_cents = r.chance(0.8) ? BigInt(r.int(0, 900)) * 1_000n : 0n;
  const servicing_advances_cents = r.chance(0.7) ? BigInt(r.int(0, 300)) * 100n : 0n;
  const prior_nib_cents = r.chance(0.2) ? BigInt(r.int(50, 900)) * 10_000n : 0n;
  const buydown_funds_cents = r.chance(0.08) ? BigInt(r.int(5, 60)) * 10_000n : 0n;
  let pre_mod_pi_cents = levelPayment(original, ratePercent(contract), 360);
  // A pre-mod P&I that is a multiple of 5 cents: its 80% is an exact cent, which is not the target.
  if (r.chance(0.15)) pre_mod_pi_cents = (pre_mod_pi_cents / 5n) * 5n;
  const gross =
    ib_upb_cents +
    accrued_interest_cents +
    escrow_advances_cents +
    servicing_advances_cents +
    prior_nib_cents -
    buydown_funds_cents;

  // The value, aimed at a band of MTMLTV — 50.00 itself included.
  const aim = r.weighted<Aim>([
    ["mtmltv_edge", 18],
    ["under_50", 12],
    ["moderate", 30],
    ["deep", 30],
    ["exhaust", 10],
  ]);
  const percentTimes10k =
    aim === "mtmltv_edge"
      ? r.pick([499_950, 500_040, 500_050, 500_000, 499_949])
      : aim === "under_50"
        ? r.int(300_000, 495_000)
        : aim === "moderate"
          ? r.int(505_000, 800_000)
          : aim === "deep"
            ? r.int(800_000, 1_150_000)
            : r.int(1_000_000, 1_400_000);
  // percentTimes10k is the MTMLTV in ten-thousandths of a percent: value = gross × 100 × 10,000 ÷ it.
  const value_cents = (gross * 1_000_000n) / BigInt(percentTimes10k);

  // The rate table: monthly rows, one sometimes effective on the evaluation date, a later one beside it.
  const mirNow = r.chance(0.5) ? eighths(r, 5, 7.5) : thousandths(r, 5_000, 7_500);
  const lastEffective = r.chance(0.2) ? evaluation_on : addDays(evaluation_on, -r.int(1, 25));
  const mir_table = [
    { effective: addMonths(lastEffective, -2), rate_pct: thousandths(r, 5_000, 7_500) },
    { effective: addMonths(lastEffective, -1), rate_pct: thousandths(r, 5_000, 7_500) },
    { effective: lastEffective, rate_pct: mirNow },
    { effective: addDays(evaluation_on, r.int(1, 20)), rate_pct: thousandths(r, 5_000, 7_500) },
  ];

  // An ARM not on its final rate: sometimes below the MIR, which lifts it.
  const is_arm_not_final = r.chance(0.15);
  const contract_rate_pct =
    is_arm_not_final && r.chance(0.5) ? (Number(mirNow) - r.int(1, 8) / 8).toFixed(3) : contract;

  // The remaining term: what the loan has left, sometimes already near 480 or over it.
  const remaining_term_months = r.chance(0.05) ? r.int(470, 500) : 360 - made;

  const prior_modifications = r.weighted<number>([
    [0, 80],
    [1, 8],
    [2, 6],
    [3, 6],
  ]);
  const last_trial_failed_on = r.chance(0.1)
    ? addDays(evaluation_on, -r.pick([364, 365, 200, 500]))
    : null;

  // The notice: a few days after the evaluation, on the 15th or 16th sometimes, in December sometimes.
  let notice_sent_on = addDays(evaluation_on, r.int(1, 20));
  if (r.chance(0.25)) {
    const { y, m } = parts(notice_sent_on);
    notice_sent_on = ymd(y, m, r.pick([15, 16]));
    if (notice_sent_on < evaluation_on) notice_sent_on = addMonths(notice_sent_on, 1);
  }
  if (r.chance(0.1)) {
    const { y } = parts(notice_sent_on);
    notice_sent_on = ymd(y, 12, r.int(1, 28));
  }

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    evaluation_on,
    loan: {
      ib_upb_cents,
      accrued_interest_cents,
      escrow_advances_cents,
      servicing_advances_cents,
      prior_nib_cents,
      buydown_funds_cents,
      value_cents,
      contract_rate_pct,
      is_arm_not_final,
      remaining_term_months,
      pre_mod_pi_cents:
        aim === "exhaust" ? (pre_mod_pi_cents * BigInt(r.int(55, 90))) / 100n : pre_mod_pi_cents,
      delinquent_31_plus: r.chance(0.85),
    },
    mir_table,
    prior_modifications,
    last_trial_failed_on,
    trial: {
      notice_sent_on,
      ti_monthly_cents: BigInt(r.int(150, 950)) * 100n,
      escrow_shortage_cents: r.chance(0.6)
        ? BigInt(r.int(0, 4_000)) * 100n + BigInt(r.int(0, 99))
        : 0n,
    },
  };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function flexFairToGrade(task: FlexTask): boolean {
  const payload = JSON.parse(JSON.stringify(flexPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(flexSteps, payload, executeFlexTool);
  } catch {
    return false;
  }
  const parsed = parseFlexSubmission(byRules);
  return parsed.ok && gradeFlexAgainst(expectedFlex(task), parsed.answer).pass;
}

const ATTEMPTS = 40;

export function drawFlexTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: FlexTask; attempts: number } {
  const id = flexTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawFlexCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (flexFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no loan fair to grade in ${ATTEMPTS} draws`);
}

export const generateFlexTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawFlexTask(split, suiteSeed, index).task;

export function generateFlexSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): FlexTask[] {
  return Array.from({ length: n }, (_, i) => generateFlexTask(split, suiteSeed, i));
}

export const FLEX_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/** §12.8's worked example: $250,000 at 6.500%, 51 payments made, 8 behind; the MIR 6.625; notice on 2026-09-11. */
export const flexSpecTasks = (): FlexTask[] => [
  {
    id: `${FLEX_ENVIRONMENT_NAME}/${FLEX_ENVIRONMENT_VERSION}/spec/0/0`,
    split: "spec",
    suite_seed: 0,
    index: 0,
    evaluation_on: plainDate("2026-09-09"),
    loan: {
      ib_upb_cents: 23_676_547n,
      accrued_interest_cents: 1_025_984n,
      escrow_advances_cents: 420_000n,
      servicing_advances_cents: 18_000n,
      prior_nib_cents: 0n,
      buydown_funds_cents: 0n,
      value_cents: 29_000_000n,
      contract_rate_pct: "6.500",
      is_arm_not_final: false,
      remaining_term_months: 309,
      pre_mod_pi_cents: 158_017n,
      delinquent_31_plus: true,
    },
    mir_table: [
      { effective: plainDate("2026-08-14"), rate_pct: "6.625" },
      { effective: plainDate("2026-09-15"), rate_pct: "6.750" },
    ],
    prior_modifications: 0,
    last_trial_failed_on: null,
    trial: {
      notice_sent_on: plainDate("2026-09-11"),
      ti_monthly_cents: 52_000n,
      escrow_shortage_cents: 186_000n,
    },
  },
];
