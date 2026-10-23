/**
 * Synthetic transfer packages, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). It is one transfer
 * batch of one to four loans from the life generator, each boarded by
 * transfer on the batch's date, 13 to 47 months after its first payment,
 * with its prior servicer's months generated in full: payment timing,
 * partials, curtailments, misses and cures, the borrower's calls and the
 * servicer's collection calls, escrow analyses, ARM changes. A history runs a
 * year past the transfer, which is where a twin's first symptoms land; the
 * package reads only what came before. A loan's package is written from its
 * history; a loan with a planted defect is written from its twin, with the
 * defect in place, and labeled against its clean twin. The behavior is drawn
 * from the calibration's typed defaults, so a new calibration file does not
 * move the pinned suite. The plan of a batch is taken in turn by index, twenty
 * of them:
 *   - one clean loan; one loan with each of the ten defects; one with D-03 and
 *     D-42 (the demo's shape);
 *   - three or four loans pairing two defects beside clean ones: two terms the
 *     prior servicer must answer for (D-03, D-01); two flags left off beside
 *     their details (D-35, D-37); two histories (D-24, D-25); a
 *     servicemember and a flood zone (D-12, D-15); the insurance and the
 *     escrow (D-18, D-42); a plan and a phantom row (D-35, D-24); the demo's
 *     two on two loans (D-42, D-03);
 *   - three clean loans.
 * Each defect is drawn on 20 to 40 of the 200 held-out packages. A defect's
 * loan is drawn with what it needs: a capped note, an ARM, a servicemember
 * called to duty three to twelve months before the transfer on a rate above
 * the cap, a Chapter 13 petition two to nine months before it, a repayment
 * plan in force at it, mortgage insurance, a flood line. The clean loans are
 * the negatives, and they are drawn to look like the defects: a capped note
 * the tape carries, no escrow, an ARM, a servicemember, a bankruptcy and a
 * plan each flagged with their details, mortgage insurance, a flood zone.
 *
 * A package is kept only when the servicing app's gate, its own rules run
 * over the package as its own decoder reads it, finds nothing on any loan,
 * so what is left to find is what the gate cannot see; and when the
 * reference, working through the tools, finds exactly the planted cells.
 * Otherwise it is redrawn under the next key.
 */

import { addDays, addMonths, parts, plainDate, ymd, type PlainDate } from "@hm/kernel/calendar";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { rngFor, type Rng } from "../rng.js";
import { demoLoan } from "../life/demo.js";
import { defaultCalibration, type Calibration } from "../life/calibration.js";
import { DEFECTS } from "../life/defects.js";
import { generate } from "../life/generate.js";
import { STATE_CODES, type LoanPins } from "../life/draw.js";
import type { ScenarioEvent } from "../life/scenario.js";
import {
  PACKAGE_DEFAULTS,
  writeTransferPackage,
  type PackageLoan,
  type TransferPackage,
} from "../life/transfer-package.js";
import { decodeTransferBatch } from "./ported/tape-codec.js";
import { runRules } from "./ported/rules.js";
import { gradeTriage, parseTriageSubmission } from "./grader.js";
import { boardingSteps } from "./reference.js";
import {
  BOARDING_ENVIRONMENT_NAME,
  BOARDING_ENVIRONMENT_VERSION,
  boardingPayload,
  type BoardingTask,
} from "./task.js";
import { executeBoardingTool } from "./tools.js";

export const boardingTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${BOARDING_ENVIRONMENT_NAME}/${BOARDING_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const BOARDING_PLAN_NAMES = [
  "clean_one",
  "d42_one",
  "d35_one",
  "d03_one",
  "d01_one",
  "d12_one",
  "d37_one",
  "d18_one",
  "d24_one",
  "d25_one",
  "d15_one",
  "both_one",
  "batch_terms",
  "batch_flags",
  "batch_history",
  "batch_protections",
  "batch_insurance",
  "batch_plan_history",
  "batch_mixed",
  "batch_clean",
] as const;
export type BoardingPlan = (typeof BOARDING_PLAN_NAMES)[number];
/** Each batch's loans, by what each carries planted. */
export const BOARDING_PLANS: Readonly<Record<BoardingPlan, readonly (readonly string[])[]>> = {
  clean_one: [[]],
  d42_one: [["D-42"]],
  d35_one: [["D-35"]],
  d03_one: [["D-03"]],
  d01_one: [["D-01"]],
  d12_one: [["D-12"]],
  d37_one: [["D-37"]],
  d18_one: [["D-18"]],
  d24_one: [["D-24"]],
  d25_one: [["D-25"]],
  d15_one: [["D-15"]],
  both_one: [["D-03", "D-42"]],
  batch_terms: [["D-03"], ["D-01"], []],
  batch_flags: [["D-35"], ["D-37"], [], []],
  batch_history: [["D-24"], ["D-25"], []],
  batch_protections: [["D-12"], ["D-15"], []],
  batch_insurance: [["D-18"], ["D-42"], []],
  batch_plan_history: [["D-35"], ["D-24"], []],
  batch_mixed: [["D-42"], ["D-03"], [], []],
  batch_clean: [[], [], []],
};
export const boardingPlanOf = (index: number): BoardingPlan =>
  BOARDING_PLAN_NAMES[index % BOARDING_PLAN_NAMES.length]!;

/** The dollar caps a drawn note carries (the life generator's own, draw.ts NOTE_CAPS_CENTS). */
const CAPS = [1_500, 2_500, 3_500, 5_000];
/** Note rates above the servicemember's 6 % cap, so the cap reaches the interest. */
const ABOVE_CAP = ["6.750", "7.000", "7.250", "7.500"];
const LTVS = [85, 88, 90, 92, 95];
const ARMS = ["5/6", "7/6", "10/6"] as const;
const EARLIEST = plainDate("2026-03-01");

/* ── the gate ────────────────────────────────────────────────────────────── */

/** The licensed states the gate is told of: every state the life generator draws a property in. */
const LICENSED: ReadonlySet<string> = new Set(STATE_CODES);

/**
 * The servicing app's gate over a package as its decoder reads it: every rule
 * of `ALL_RULES`, each loan against the package's own trial balance, Fannie
 * Mae position and MERS lookup. Every failing rule, by loan.
 */
export function gateFailures(pkg: Pick<TransferPackage, "files" | "batch">): Map<string, string[]> {
  const d = decodeTransferBatch(pkg.files);
  const fnma = new Map(d.fnma.map((p) => [p.fnma_loan_number, p]));
  const tb = new Map(d.trialBalance.map((t) => [t.transferor_loan_number, t.upb_cents]));
  const mers = new Map(d.mers.map((m) => [m.min, m]));
  const loanNumbers = new Map<string, number>();
  const mins = new Map<string, number>();
  for (const l of d.loans) {
    if (l.fnma_loan_number)
      loanNumbers.set(l.fnma_loan_number, (loanNumbers.get(l.fnma_loan_number) ?? 0) + 1);
    if (l.min) mins.set(l.min, (mins.get(l.min) ?? 0) + 1);
  }
  const out = new Map<string, string[]>();
  for (const loan of d.loans) {
    const failed = runRules({
      loan,
      batch: {
        batch_id: pkg.batch.batch_id,
        transfer_date: pkg.batch.transfer_date,
        transferor_party_id: "P-TR",
        transferor_servicer_number: pkg.batch.transferor_servicer_number,
        partner_servicer_number: pkg.batch.partner_servicer_number,
        rule_set_version: "boarding.dq.v1",
        acceptable_mers_org_ids: new Set([
          pkg.batch.partner_mers_org_id,
          pkg.batch.transferor_mers_org_id,
        ]),
      },
      ext: {
        fnma: (n) => fnma.get(n),
        trialBalanceUpb: (n) => tb.get(n),
        mers: (m) => mers.get(m),
        licensed: (s) => LICENSED.has(s),
        onPlatform: () => false,
      },
      batchCounts: { loanNumbers, mins },
    })
      .filter((r) => r.result === "fail")
      .map((r) => r.code);
    out.set(loan.transferor_loan_number, failed);
  }
  return out;
}

/* ── one batch ───────────────────────────────────────────────────────────── */

function taskOf(
  pkg: TransferPackage,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): BoardingTask {
  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    batch: pkg.batch,
    files: pkg.files,
    loans: pkg.loans.map((l) => l.transferor_loan_number),
    labels: pkg.manifest.labels,
  };
}

/** What a loan of the batch is drawn with: its pinned terms, and the events of its own life before the transfer. */
interface Slot {
  readonly pins: LoanPins;
  readonly events: (loan: number) => ScenarioEvent[];
}

/** A day of the month `months` before the transfer: the facts a defect needs happen before it. */
const before = (r: Rng, T: PlainDate, months: number): string => {
  const p = parts(addMonths(T, -months));
  return ymd(p.y, p.m, r.int(1, 28));
};
/** A repayment plan in force at the transfer: the installment due two months before it missed, the plan from its 20th. */
const planEvents =
  (T: PlainDate) =>
  (loan: number): ScenarioEvent[] => {
    const missed = addMonths(plainDate(`${T.slice(0, 7)}-01`), -2);
    return [
      { kind: "missed_payment", loan, on: missed },
      { kind: "repayment_plan", loan, on: addDays(missed, 19), months: 6 },
    ];
  };

/** Each draw is made every time, in one order, so a slot's draws never move another's. */
function slotFor(r: Rng, ids: readonly string[], T: PlainDate): Slot {
  const cap = r.pick(CAPS);
  const arm = r.pick(ARMS);
  const rate = r.pick(ABOVE_CAP);
  const ltv = r.pick(LTVS);
  const duty = before(r, T, r.int(3, 12));
  const filed = before(r, T, r.int(2, 9));
  const u = r.next();
  const none = () => [];
  if (ids.length === 0) {
    // The clean loans are drawn to look like the defects: a capped note the tape carries, no escrow, an ARM, a
    // servicemember, a bankruptcy and a plan each flagged with their details, mortgage insurance, a flood zone.
    if (u < 0.2) return { pins: { late_charge_cap_cents: cap }, events: none };
    if (u < 0.32) return { pins: { escrowed: false }, events: none };
    if (u < 0.44) return { pins: { arm }, events: none };
    if (u < 0.52)
      return {
        pins: { arm: null, note_rate_pct: rate },
        events: (loan) => [{ kind: "active_duty", loan, on: duty }],
      };
    if (u < 0.6) return { pins: {}, events: (loan) => [{ kind: "bankruptcy", loan, on: filed }] };
    if (u < 0.68) return { pins: {}, events: planEvents(T) };
    if (u < 0.8) return { pins: { mi: true, ltv_pct: ltv, escrowed: true }, events: none };
    if (u < 0.88) return { pins: { escrowed: true, flood: true }, events: none };
    return { pins: {}, events: none };
  }
  const pins: LoanPins[] = [];
  const events: ((loan: number) => ScenarioEvent[])[] = [];
  for (const id of ids) {
    if (id === "D-03") pins.push({ late_charge_cap_cents: cap, arm: null });
    if (id === "D-42" || id === "D-25") pins.push({ escrowed: true });
    if (id === "D-35") events.push(planEvents(T));
    if (id === "D-01") pins.push({ arm });
    if (id === "D-12") {
      pins.push({ arm: null, note_rate_pct: rate });
      events.push((loan) => [{ kind: "active_duty", loan, on: duty }]);
    }
    if (id === "D-37") events.push((loan) => [{ kind: "bankruptcy", loan, on: filed }]);
    if (id === "D-18") pins.push({ mi: true, ltv_pct: ltv, escrowed: true, arm: null });
    if (id === "D-15") pins.push({ escrowed: true, flood: true });
  }
  return {
    pins: Object.assign({}, ...pins) as LoanPins,
    events: (loan) => events.flatMap((e) => e(loan)),
  };
}

export function drawBoardingCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
  calibration: Calibration,
  /** Told why a draw is redrawn, for the suite's statistics. */
  redrawn: (why: string) => void = () => {},
): BoardingTask | null {
  const plan = BOARDING_PLANS[boardingPlanOf(index)];
  const order = plan.map((_, k) => k);
  // A shuffle from the stream, so a planted loan is not always first.
  for (let k = order.length - 1; k > 0; k--) {
    const j = r.int(0, k);
    [order[k], order[j]] = [order[j]!, order[k]!];
  }
  const start = addMonths(EARLIEST, r.int(0, 18));
  const cohort = r.int(1, 12);
  const month = addMonths(start, cohort - 1 + r.int(13, 36));
  const p = parts(month);
  const T = r.chance(0.25) ? ymd(p.y, p.m, 16) : month;
  const pins: Record<number, LoanPins> = {};
  const events: ScenarioEvent[] = [];
  order.forEach((slot, i) => {
    const s = slotFor(r, plan[slot]!, T);
    pins[i] = s.pins;
    events.push({ kind: "transfer_in", loan: i, on: T }, ...s.events(i));
  });
  const seed = r.int(0, 0x7fffffff);
  const planted = order.map((slot) => plan[slot]!);
  const requests = Object.keys(DEFECTS).flatMap((d) => {
    const loans = planted.flatMap((ids, i) => (ids.includes(d) ? [i] : []));
    return loans.length ? [{ id: d, loans }] : [];
  });
  let res;
  try {
    // Each history runs a year past the transfer: the package reads only what came before it, and a twin's year
    // after boarding is where its labels' first symptoms land.
    const months = (parts(T).y - parts(start).y) * 12 + parts(T).m - parts(start).m + 13;
    res = generate(
      seed,
      { loans: plan.length, start, cohort_months: cohort, months, outreach: true, pins, events },
      { calibration, defects: requests },
    );
  } catch (e) {
    // A defect the drawn note cannot carry (a cap that does not bind) is redrawn. Anything else is a defect in the
    // generator, and is thrown: redrawing it would quietly leave a kind of loan out of every suite.
    const m =
      e instanceof RangeError
        ? /^(D-\d+) cannot be planted on loan \d+: (its history)?/.exec(e.message)
        : null;
    if (m) {
      redrawn(`${m[1]}: ${m[2] ? "the history lacks what it needs" : "the note cannot carry it"}`);
      return null;
    }
    throw e;
  }
  const book = res.defective ?? res.clean;
  // Every loan reached the transfer; one paid off before it is no transfer at all.
  if (book.loans.some((l) => l.transfer_in_on !== T || !l.at_transfer)) {
    redrawn("paid off before the transfer");
    return null;
  }
  // A cap on a clean loan is on its tape, and binds or not; a planted one binds, or the statements could not show it.
  for (const [i, ids] of planted.entries()) {
    const d = book.loans[i]!.draw;
    if (
      ids.includes("D-03") &&
      !(
        d.late_charge.cap_cents !== null &&
        lateChargeAmount(book.loans[i]!.at_transfer!.pi, d.late_charge.pct, null) >
          d.late_charge.cap_cents
      )
    ) {
      redrawn("a cap the P&I never reaches");
      return null;
    }
  }
  const loans: PackageLoan[] = book.loans.map((life, i) => ({
    life,
    defects: planted[i]!,
    clean: res.clean.loans[i]!,
  }));
  const pkg = writeTransferPackage(loans, {
    ...PACKAGE_DEFAULTS,
    batch_id: `B-${T.replace(/-/g, "")}-${String(index).padStart(4, "0")}`,
    transfer_date: T,
  });
  const failed = [...new Set([...gateFailures(pkg).values()].flat())].sort();
  if (failed.length > 0) {
    redrawn(`the gate: ${failed.join(", ")}`);
    return null;
  }
  return taskOf(pkg, id, split, suiteSeed, index);
}

/** Whether the rulebook followed through the tools finds exactly the planted cells and passes the rest. */
export function boardingFairToGrade(task: BoardingTask): boolean {
  const payload = JSON.parse(JSON.stringify(boardingPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(boardingSteps, payload, (n, i) => executeBoardingTool(n, i, task));
  } catch {
    return false;
  }
  const parsed = parseTriageSubmission(byRules);
  return parsed.ok && gradeTriage(task, parsed.answer).pass;
}

const ATTEMPTS = 40;

export function drawBoardingTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
  calibration: Calibration = defaultCalibration(),
): { task: BoardingTask; attempts: number } {
  const id = boardingTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = rngFor(attempt === 0 ? id : `${id}#${attempt}`);
    const task = drawBoardingCandidate(r, id, split, suiteSeed, index, calibration);
    if (task && boardingFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(
    `${id}: no package the gate passes and the reference solves in ${ATTEMPTS} draws`,
  );
}

export const generateBoardingTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): BoardingTask => drawBoardingTask(split, suiteSeed, index).task;

export function generateBoardingSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): BoardingTask[] {
  return Array.from({ length: n }, (_, i) => generateBoardingTask(split, suiteSeed, i));
}

export const BOARDING_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's own cases: the demo loan ─────────────────────────────────── */

export const BOARDING_SPEC_CASES = [
  { name: "the demo loan, clean", pkg: "clean" },
  { name: "the demo loan with its escrow cell written Yes (D-42)", pkg: "D-42" },
  { name: "the demo loan with its late-fee cap left off the tape (D-03)", pkg: "D-03" },
  { name: "the demo loan as it transfers: both", pkg: "defective" },
] as const;

export function boardingSpecTasks(): BoardingTask[] {
  const demo = demoLoan(defaultCalibration());
  return BOARDING_SPEC_CASES.map((c, index) =>
    taskOf(
      demo.packages[c.pkg],
      `${BOARDING_ENVIRONMENT_NAME}/${BOARDING_ENVIRONMENT_VERSION}/spec/0/${index}`,
      "spec",
      0,
      index,
    ),
  );
}
