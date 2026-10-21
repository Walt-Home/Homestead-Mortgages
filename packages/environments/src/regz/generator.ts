/**
 * Synthetic quotes, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index), drawn from its own
 * stream. A quote is a loan, a property and a lender's itemized fees, priced
 * against the week its rate was set, and aimed at an edge of the rules:
 *
 *   - a loan amount a dollar either side of a tier's bound ($17,245,
 *     $27,592, $82,775, $137,958) or of the conforming limit ($832,750);
 *   - a loan at exactly 80% of value, or just over it, where the APR is refused;
 *   - a note rate searched on the eighth-point grid so the spread lands near
 *     the HPML line, the QM threshold or the HOEPA trigger;
 *   - a rate set late on a Sunday in New York, which is Monday in UTC and
 *     belongs to the week before;
 *   - small loans whose flat fees trip the points-and-fees limits;
 *   - a manufactured home, a second home, an investment property, an ARM, a
 *     25-year term, a prepayment penalty, an undocumented ability to repay;
 *   - a refinance whose saving is negative, slim or real, on a principal-and-
 *     interest or a scheduled payment.
 *
 * **A task is kept only once the rulebook followed through the tools lands
 * where the engine does.** The engine computes in binary floating point; the
 * tools and the rulebook in exact decimals. On almost every quote the two
 * agree to the cent and the thousandth. Where they would not — a fee on a
 * half cent, a ratio on a bright line to the fifteenth digit — the task is
 * not fair to grade, and it is redrawn under the next key.
 */

import { addDays, plainDate, type PlainDate } from "@hm/kernel/calendar";
import { APOR_TABLE, annualPercentageRate, lookupApor, round } from "@hm/underwriting";
import { rngFor, type Rng } from "../rng.js";
import { solveNow, type Call, type Step } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { expectedRegz, gradeRegzAgainst, parseRegzSubmission } from "./grader.js";
import { regzSteps } from "./reference.js";
import {
  REGZ_ENVIRONMENT_NAME,
  REGZ_ENVIRONMENT_VERSION,
  regzPayload,
  type FeeLine,
  type Payee,
  type RegzTask,
} from "./task.js";
import { executeRegzTool } from "./tools.js";

export const regzTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${REGZ_ENVIRONMENT_NAME}/${REGZ_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const BOUNDS = [17_245, 27_592, 82_775, 137_958, 832_750];
const FIRST_DAY = plainDate("2026-01-02");
const LAST_OFFSET = 258; // through 2026-09-17: the table's last week is 2026-09-14

const dollars = (r: Rng, lo: number, hi: number) => r.int(lo, hi) * 100;

function rateQuotedAt(r: Rng): string {
  let day: PlainDate = addDays(FIRST_DAY, r.int(0, LAST_OFFSET));
  if (r.chance(0.3)) {
    // Late Sunday in New York is early Monday in UTC: move to a Monday, before 05:00 UTC.
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    day = addDays(day, (8 - dow) % 7 || 7);
    if (day > addDays(FIRST_DAY, LAST_OFFSET)) day = addDays(day, -7);
    return `${day}T0${r.int(0, 4)}:${String(r.int(0, 59)).padStart(2, "0")}:00.000Z`;
  }
  return `${day}T${r.int(13, 22)}:${String(r.int(0, 59)).padStart(2, "0")}:00.000Z`;
}

function loanAmountCents(r: Rng): number {
  const kind = r.weighted<"bound" | "small" | "mid" | "large">([
    ["bound", 30],
    ["small", 15],
    ["mid", 35],
    ["large", 20],
  ]);
  if (kind === "bound") return (r.pick(BOUNDS) + r.pick([-1, 0, 1])) * 100;
  if (kind === "small") return r.int(12_000, 90_000) * 100;
  if (kind === "mid") return dollars(r, 900, 4_000) * 100;
  return dollars(r, 4_000, 15_000) * 100;
}

function feeLines(r: Rng, loanCents: number): FeeLine[] {
  const lines: FeeLine[] = [];
  const add = (name: string, payee: Payee, line: Omit<FeeLine, "name" | "payee">) =>
    lines.push({ name, payee, ...line });
  if (r.chance(0.85))
    add("Origination fee", "lender", {
      percent_of_loan_amount: r.pick(["0.5", "0.75", "1", "1.5"]),
    });
  if (r.chance(0.3))
    add("Discount points", "lender", { percent_of_loan_amount: r.pick(["0.25", "0.5", "1", "2"]) });
  add("Underwriting fee", "lender", { amount_cents: r.int(495, 1_295) * 100 });
  if (r.chance(0.7)) add("Processing fee", "lender", { amount_cents: r.int(250, 795) * 100 });
  add("Appraisal fee", r.chance(0.25) ? "affiliate" : "third_party", {
    amount_cents: r.int(450, 900) * 100,
  });
  add("Credit report fee", "third_party", { amount_cents: r.int(25, 95) * 100 });
  if (r.chance(0.6))
    add("Flood determination fee", "third_party", { amount_cents: r.int(10, 20) * 100 });
  add("Settlement or closing fee", r.chance(0.15) ? "affiliate" : "third_party", {
    amount_cents: r.int(500, 1_200) * 100,
  });
  add("Lender's title insurance", "third_party", {
    amount_cents: Math.max(30_000, Math.round((loanCents * 0.0028) / 100) * 100),
  });
  add("Recording fees", "government", { amount_cents: r.int(50, 250) * 100 });
  return lines;
}

/** Prepaid finance charges in dollars, the way the engine's schedule prices them. */
function keptDollars(fees: readonly FeeLine[], loanCents: number): number {
  let sum = 0;
  for (const f of fees) {
    if (f.payee !== "lender" && f.payee !== "affiliate") continue;
    sum +=
      f.percent_of_loan_amount !== undefined
        ? round(((loanCents / 100) * Number(f.percent_of_loan_amount)) / 100, 2)
        : (f.amount_cents ?? 0) / 100;
  }
  return round(sum, 2);
}

/** One candidate quote; the caller keeps it only if it is fair to grade. */
export function drawQuote(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): RegzTask {
  const rate_quoted_at = rateQuotedAt(r);
  const term_months = r.weighted<number>([
    [360, 68],
    [180, 17],
    [240, 6],
    [120, 3],
    [300, 6],
  ]);
  const amortization = r.chance(0.08) ? ("AdjustableRate" as const) : ("Fixed" as const);
  const amount_cents = loanAmountCents(r);

  // The value: at or under 80%, exactly 80%, or over it.
  const ltvKind = r.weighted<"under" | "at" | "over">([
    ["under", 68],
    ["at", 10],
    ["over", 22],
  ]);
  const value_cents =
    ltvKind === "at"
      ? Math.ceil((amount_cents * 125) / 100 / 100) * 100
      : ltvKind === "under"
        ? Math.ceil((amount_cents * 100) / r.int(40, 79) / 100) * 100
        : Math.floor((amount_cents * 10_000) / r.int(8_001, 9_700) / 100) * 100;

  const fees = feeLines(r, amount_cents);

  // The note rate: on the eighth grid, searched so the spread lands where the draw aims it.
  const apor = lookupApor(APOR_TABLE, new Date(rate_quoted_at), term_months, "Fixed");
  const base = apor.found ? apor.rate : 6.25;
  const aim = r.weighted<number>([
    [1.5 + r.int(-12, 12) / 100, 30],
    [2.25 + r.int(-12, 12) / 100, 18],
    [3.5 + r.int(-12, 12) / 100, 10],
    [6.5 + r.int(-12, 12) / 100, 12],
    [r.int(-50, 300) / 100, 30],
  ]);
  const kept = keptDollars(fees, amount_cents);
  let best = { note: base, gap: Infinity };
  for (
    let eighths = Math.round((base - 1.5) * 8);
    eighths <= Math.round((base + 9) * 8);
    eighths++
  ) {
    const note = eighths / 8;
    if (note < 2) continue;
    const a = annualPercentageRate({
      loanAmount: amount_cents / 100,
      noteRate: note,
      termMonths: term_months,
      amortization: "Fixed",
      prepaidFinanceCharges: kept,
      mortgageInsuranceApplies: false,
    });
    if (!a.computed) continue;
    const gap = Math.abs(a.apr - base - aim);
    if (gap < best.gap) best = { note, gap };
  }
  const note_rate_pct = best.note.toFixed(3);

  const purpose = r.chance(0.35) ? ("rate_term_refinance" as const) : ("purchase" as const);
  let existing_loan: RegzTask["existing_loan"] = null;
  if (purpose === "rate_term_refinance") {
    const r1 = best.note / 100 / 12;
    const newPayment = (amount_cents * r1) / (1 - Math.pow(1 + r1, -term_months));
    const factor = r.weighted<number>([
      [r.int(85, 99) / 100, 20],
      [r.int(101, 104) / 100, 25],
      [r.int(105, 140) / 100, 55],
    ]);
    existing_loan = {
      monthly_payment_cents: Math.round(newPayment * factor),
      payment_basis: r.chance(0.75) ? "principal_and_interest" : "scheduled_payment",
      rate_pct: r.chance(0.8) ? (best.note + r.int(4, 16) / 8).toFixed(3) : null,
    };
  }

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    rate_quoted_at,
    loan: {
      purpose,
      amount_cents,
      note_rate_pct,
      term_months,
      amortization,
      prepayment_penalty: r.chance(0.07),
    },
    property: {
      value_cents,
      property_type: r.weighted([
        ["single_family", 58],
        ["condo", 14],
        ["townhouse", 8],
        ["two_to_four_unit", 6],
        ["manufactured", 14],
      ] as const),
      occupancy: r.weighted([
        ["primary_residence", 80],
        ["second_home", 12],
        ["investment", 8],
      ] as const),
    },
    fees,
    atr_documented: r.chance(0.92),
    existing_loan,
  };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
/** Which solver and tools decide fairness, and under which name tasks are drawn: a variant supplies its own. */
export interface RegzDraw {
  readonly taskId: (split: Split, suiteSeed: number, index: number) => string;
  readonly steps: (payload: Record<string, unknown>, call: Call) => Step<Record<string, unknown>>;
  readonly execute: (name: string, input: unknown) => string;
}
const REGZ_DRAW: RegzDraw = { taskId: regzTaskId, steps: regzSteps, execute: executeRegzTool };

export function fairToGrade(task: RegzTask, draw: RegzDraw = REGZ_DRAW): boolean {
  const payload = JSON.parse(JSON.stringify(regzPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(draw.steps, payload, draw.execute);
  } catch {
    return false;
  }
  const parsed = parseRegzSubmission(byRules);
  return parsed.ok && gradeRegzAgainst(expectedRegz(task), parsed.answer).pass;
}

const ATTEMPTS = 40;

/** One task, rebuilt from its coordinates alone; `attempts` says how many draws it took. */
export function drawRegzTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
  draw: RegzDraw = REGZ_DRAW,
): { task: RegzTask; attempts: number } {
  const id = draw.taskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawQuote(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (fairToGrade(task, draw)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no quote fair to grade in ${ATTEMPTS} draws`);
}

export const generateRegzTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawRegzTask(split, suiteSeed, index).task;

export function generateRegzSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): RegzTask[] {
  return Array.from({ length: n }, (_, i) => generateRegzTask(split, suiteSeed, i));
}

export const REGZ_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };
