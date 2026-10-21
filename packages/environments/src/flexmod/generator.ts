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
 *     more than 50.00 — including just above 49.995 and 50.004, which print
 *     as 50.00;
 *   - a rate already on the MIR, a whole number of eighths above it, or off
 *     the grid (one partial step to the floor), and an ARM below the MIR,
 *     its cap at or above the rate step 2 sets, sometimes exactly on it;
 *   - a loan modified before to 480 months, a year or more of payments
 *     since, so more than 360 months are left and step 4 has at most 40 to
 *     add;
 *   - a target the rate alone reaches at an eighth-point step above the MIR
 *     (the pre-mod set from that step's payment), one the term alone
 *     reaches, one only forbearance reaches, and one nothing reaches
 *     (exhaustion);
 *   - an exhausted waterfall whose P&I equals the pre-mod exactly (the
 *     pre-mod set from the final P&I), where 31 days delinquent or fewer
 *     decides eligibility, drawn about half and half;
 *   - a pre-modification P&I that is a multiple of 5 cents, whose 80% is an
 *     exact cent and so is not the target;
 *   - a rate-table row effective on the evaluation date, and a later one;
 *   - a failed trial 364 or 365 days back, and three prior modifications;
 *   - an escrow shortage whose 60-month spread ends in exactly half a cent;
 *   - a notice on the 15th or the 16th, and one in December; never before
 *     the evaluation, as the service sends it only once the loan is eligible.
 *
 * `flexInScope` keeps out the two places the waterfall departs from F-1-27
 * (a remaining term over 480, an ARM's rate above its cap), which the
 * generator never draws. A task is kept only once the reference, working
 * through the tools, lands exactly where the engine does; the engine is
 * exact decimal arithmetic, so both are guards rather than filters, and a
 * test holds them at no redraws and runs both over unfiltered draws too.
 */

import { levelPayment, ratePercent } from "@hm/kernel/money";
import { addDays, addMonths, plainDate, ymd, parts } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { gradeFlexAgainst, expectedFlex, mirFor, parseFlexSubmission } from "./grader.js";
import { accruedInterest, balanceAfter, targetPi, waterfall } from "./ported/flexmod.js";
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
const milli = (pct: string) => Math.round(Number(pct) * 1000);

type Aim = "mtmltv_edge" | "under_50" | "moderate" | "deep" | "exhaust" | "rate_only" | "pi_tie";

/** One candidate; the caller keeps it only if it is fair to grade. */
export function drawFlexCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): FlexTask {
  const evaluation_on = addDays(FIRST_EVALUATION, r.int(0, 700));
  // The edge the loan is aimed at, first: a target the rate alone reaches needs a contract rate well above the MIR.
  const aim = r.weighted<Aim>([
    ["mtmltv_edge", 17],
    ["under_50", 11],
    ["moderate", 26],
    ["deep", 26],
    ["exhaust", 9],
    ["rate_only", 6],
    ["pi_tie", 5],
  ]);

  // The loan as originated, and where it stands.
  const original = BigInt(r.int(800, 7_000)) * 10_000n;
  const contract =
    aim === "rate_only"
      ? eighths(r, 7, 9.5)
      : r.chance(0.8)
        ? eighths(r, 3, 8.5)
        : thousandths(r, 3_000, 8_500);
  const made = r.int(12, 150);
  const behind = r.int(2, 14);
  // Sometimes the loan was modified before, to 480 months, and has paid a year or more since: more
  // than 360 months left, never more than 480 (an amortizing Fannie Mae loan cannot have more), and
  // its first twelve modified payments made, so no earlier modification's first year is in doubt.
  // Its balance and payment are the modification's own.
  const sinceModification = r.chance(0.05) ? r.int(12, 40) : null;
  const atModification = balanceAfter(original, contract, 360, made);
  const ib_upb_cents =
    sinceModification === null
      ? atModification
      : balanceAfter(atModification, contract, 480, sinceModification);
  const accrued_interest_cents = accruedInterest(ib_upb_cents, contract, behind);
  const escrow_advances_cents = r.chance(0.8) ? BigInt(r.int(0, 900)) * 1_000n : 0n;
  const servicing_advances_cents = r.chance(0.7) ? BigInt(r.int(0, 300)) * 100n : 0n;
  const prior_nib_cents = r.chance(0.2) ? BigInt(r.int(50, 900)) * 10_000n : 0n;
  const buydown_funds_cents = r.chance(0.08) ? BigInt(r.int(5, 60)) * 10_000n : 0n;
  let pre_mod_pi_cents =
    sinceModification === null
      ? levelPayment(original, ratePercent(contract), 360)
      : levelPayment(atModification, ratePercent(contract), 480);
  // A pre-mod P&I that is a multiple of 5 cents: its 80% is an exact cent, which is not the target.
  if (r.chance(0.15)) pre_mod_pi_cents = (pre_mod_pi_cents / 5n) * 5n;
  // Exhaustion: a pre-mod well below what the loan now needs. The tie starts lower still, so nearly every one exhausts.
  if (aim === "exhaust") pre_mod_pi_cents = (pre_mod_pi_cents * BigInt(r.int(55, 90))) / 100n;
  if (aim === "pi_tie") pre_mod_pi_cents = (pre_mod_pi_cents * BigInt(r.int(40, 75))) / 100n;
  const gross =
    ib_upb_cents +
    accrued_interest_cents +
    escrow_advances_cents +
    servicing_advances_cents +
    prior_nib_cents -
    buydown_funds_cents;

  // The value, aimed at a band of MTMLTV — 50.00 itself included.
  const percentTimes10k =
    aim === "mtmltv_edge"
      ? r.pick([499_950, 500_040, 500_050, 500_000, 499_949])
      : aim === "under_50"
        ? r.int(300_000, 495_000)
        : aim === "moderate"
          ? r.int(505_000, 800_000)
          : aim === "deep"
            ? r.int(800_000, 1_150_000)
            : aim === "rate_only"
              ? r.int(505_000, 1_150_000)
              : aim === "pi_tie"
                ? r.int(300_000, 1_400_000)
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

  // An ARM not on its final rate: sometimes below the MIR, which lifts it. Its lifetime cap (or final
  // step) is at or above the rate step 2 sets, a quarter of the time exactly on it: F-1-27 caps the
  // rate there and the engine does not (flexmod-2), so a cap below it is never drawn.
  const is_arm_not_final = r.chance(0.15);
  const contract_rate_pct =
    is_arm_not_final && r.chance(0.5) ? (Number(mirNow) - r.int(1, 8) / 8).toFixed(3) : contract;
  const lifted = Math.max(milli(contract_rate_pct), milli(mirNow));
  const rate_cap_pct = is_arm_not_final
    ? ((lifted + 125 * (r.chance(0.25) ? 0 : r.int(1, 40))) / 1000).toFixed(3)
    : null;

  // The remaining term: what the loan has left, the modification's when it has one.
  const remaining_term_months = sinceModification === null ? 360 - made : 480 - sinceModification;

  const prior_modifications = Math.max(
    sinceModification === null ? 0 : 1,
    r.weighted<number>([
      [0, 80],
      [1, 8],
      [2, 6],
      [3, 6],
    ]),
  );
  const last_trial_failed_on = r.chance(0.1)
    ? addDays(evaluation_on, -r.pick([364, 365, 200, 500]))
    : null;

  // The notice: a few days after the evaluation, on the 15th or 16th sometimes; never before the evaluation.
  let notice_sent_on = addDays(evaluation_on, r.int(1, 20));
  if (r.chance(0.25)) {
    const { y, m } = parts(notice_sent_on);
    notice_sent_on = ymd(y, m, r.pick([15, 16]));
    if (notice_sent_on < evaluation_on) notice_sent_on = addMonths(notice_sent_on, 1);
  }
  // A December evaluation's notice stays in December sometimes: any day from the evaluation's to the 31st.
  const evaluated = parts(evaluation_on);
  if (evaluated.m === 12 && r.chance(0.5))
    notice_sent_on = ymd(evaluated.y, 12, r.int(evaluated.d, 31));

  const delinquent_31_plus = r.chance(aim === "pi_tie" ? 0.5 : 0.85);
  const ti_monthly_cents = BigInt(r.int(150, 950)) * 100n;
  // The shortage: none, any amount, or one 60 months spreads into exactly half a cent over.
  const escrow_shortage_cents = !r.chance(0.6)
    ? 0n
    : r.chance(0.15)
      ? BigInt(r.int(0, 6_600)) * 60n + 30n
      : BigInt(r.int(0, 4_000)) * 100n + BigInt(r.int(0, 99));

  const loan = {
    ib_upb_cents,
    accrued_interest_cents,
    escrow_advances_cents,
    servicing_advances_cents,
    prior_nib_cents,
    buydown_funds_cents,
    value_cents,
    contract_rate_pct,
    is_arm_not_final,
    rate_cap_pct,
    remaining_term_months,
    pre_mod_pi_cents,
    delinquent_31_plus,
  };
  const task: FlexTask = {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    evaluation_on,
    loan,
    mir_table,
    prior_modifications,
    last_trial_failed_on,
    trial: { notice_sent_on, ti_monthly_cents, escrow_shortage_cents },
  };
  const mir = mirFor(task);
  if (mir === null) return task;

  if (aim === "rate_only") {
    // A target the rate alone reaches: the smallest pre-mod whose target is at or above the payment at
    // an eighth-point step k, at least one step short of the MIR, so step 3 stops there.
    const start =
      is_arm_not_final && milli(mir) > milli(contract_rate_pct) ? mir : contract_rate_pct;
    const steps = Math.floor((milli(start) - milli(mir)) / 125);
    if (steps < 2) return task;
    const rate = ((milli(start) - 125 * r.int(1, steps - 1)) / 1000).toFixed(3);
    const atStep = levelPayment(gross, ratePercent(rate), remaining_term_months);
    let pre = (atStep * 100n) / 80n;
    while (targetPi(pre) < atStep) pre += 1n;
    return { ...task, loan: { ...loan, pre_mod_pi_cents: pre } };
  }
  if (aim === "pi_tie") {
    // An exhausted waterfall ran every step to its end, so a pre-mod at its final P&I (whose target is
    // still below that P&I) leaves it where it was, with P&I equal to the pre-mod exactly.
    const w = waterfall({ ...loan, mir_pct: mir });
    if (w.pi_cents > w.target_pi_cents)
      return { ...task, loan: { ...loan, pre_mod_pi_cents: w.pi_cents } };
  }
  return task;
}

/**
 * The guard, run on the task and the engine's own rate table lookup: a loan
 * is kept only when the waterfall does nothing its spec calls wrong on it.
 *   - no more than 480 months left. F-1-27 step 4 extends the term to 480
 *     months and no further, and an amortizing Fannie Mae loan never has
 *     more; the engine keeps a longer term as it finds it (flexmod-1);
 *   - an ARM or step-rate loan not on its final rate carries its cap, and
 *     the rate step 2 sets is at or below it. F-1-27 step 2 caps the rate at
 *     the lifetime cap or final step; the engine takes the greater of the
 *     contract rate and the MIR with no cap (flexmod-2).
 */
export function flexInScope(task: FlexTask): boolean {
  if (task.loan.remaining_term_months > 480) return false;
  if (!task.loan.is_arm_not_final) return true;
  const cap = task.loan.rate_cap_pct;
  const mir = mirFor(task);
  if (cap === null) return false;
  return mir === null || Math.max(milli(task.loan.contract_rate_pct), milli(mir)) <= milli(cap);
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
    if (flexInScope(task) && flexFairToGrade(task)) return { task, attempts: attempt + 1 };
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
      rate_cap_pct: null,
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
