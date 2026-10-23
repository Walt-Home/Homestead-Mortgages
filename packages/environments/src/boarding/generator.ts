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
 * defect's cell in place. The behavior is drawn from the calibration's typed
 * defaults, so a new calibration file does not move the pinned suite.
 * The plan of a batch is taken in turn by index:
 *   - one clean loan; one with D-42; one with D-03; one with both (the
 *     demo's shape);
 *   - three loans, one with D-42 and two clean; the same with D-03;
 *   - four loans, one with D-42, one with D-03, two clean;
 *   - three clean loans.
 * The clean loans are the negatives, and they are drawn to look like the
 * defects: a note with a dollar cap that the tape carries (beside D-03's,
 * which it does not), a loan with no escrow (beside D-42's Yes), an ARM.
 *
 * A package is kept only when the servicing app's gate, its own rules run
 * over the package as its own decoder reads it, finds nothing on any loan,
 * so what is left to find is what the gate cannot see; and when the
 * reference, working through the tools, finds exactly the planted cells.
 * Otherwise it is redrawn under the next key.
 */

import { addMonths, parts, plainDate, ymd } from "@hm/kernel/calendar";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { rngFor, type Rng } from "../rng.js";
import { demoLoan } from "../life/demo.js";
import { defaultCalibration, type Calibration } from "../life/calibration.js";
import { generate } from "../life/generate.js";
import type { LoanPins } from "../life/draw.js";
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
  "d03_one",
  "both_one",
  "batch_d42",
  "batch_d03",
  "batch_mixed",
  "batch_clean",
] as const;
export type BoardingPlan = (typeof BOARDING_PLAN_NAMES)[number];
/** Each batch's loans, by what each carries planted. */
export const BOARDING_PLANS: Readonly<Record<BoardingPlan, readonly (readonly string[])[]>> = {
  clean_one: [[]],
  d42_one: [["D-42"]],
  d03_one: [["D-03"]],
  both_one: [["D-03", "D-42"]],
  batch_d42: [["D-42"], [], []],
  batch_d03: [["D-03"], [], []],
  batch_mixed: [["D-42"], ["D-03"], [], []],
  batch_clean: [[], [], []],
};
export const boardingPlanOf = (index: number): BoardingPlan =>
  BOARDING_PLAN_NAMES[index % BOARDING_PLAN_NAMES.length]!;

/** The dollar caps a drawn note carries (the life generator's own, draw.ts NOTE_CAPS_CENTS). */
const CAPS = [1_500, 2_500, 3_500, 5_000];
const EARLIEST = plainDate("2026-03-01");

/* ── the gate ────────────────────────────────────────────────────────────── */

/** The licensed states the gate is told of: the sixteen the life generator draws. */
const LICENSED = new Set([
  "CA",
  "TX",
  "FL",
  "NY",
  "IL",
  "PA",
  "OH",
  "GA",
  "NC",
  "MI",
  "NJ",
  "VA",
  "WA",
  "AZ",
  "MA",
  "CO",
]);

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

/** The pins a clean loan is drawn with: often a capped note the tape carries, sometimes no escrow, sometimes an ARM. */
function cleanPins(r: Rng): LoanPins {
  const u = r.next();
  const cap = r.pick(CAPS);
  const arm = r.pick(["5/6", "7/6", "10/6"] as const);
  return u < 0.4
    ? { late_charge_cap_cents: cap }
    : u < 0.6
      ? { escrowed: false }
      : u < 0.75
        ? { arm }
        : {};
}

export function drawBoardingCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
  calibration: Calibration,
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
    const defects = plan[slot]!;
    pins[i] = defects.length
      ? {
          ...(defects.includes("D-03") ? { late_charge_cap_cents: r.pick(CAPS), arm: null } : {}),
          ...(defects.includes("D-42") ? { escrowed: true } : {}),
        }
      : cleanPins(r);
    events.push({ kind: "transfer_in", loan: i, on: T });
  });
  const seed = r.int(0, 0x7fffffff);
  const planted = order.map((slot) => plan[slot]!);
  const requests = ["D-03", "D-42"].flatMap((d) => {
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
  } catch {
    return null; // a defect the drawn note cannot carry (a cap that does not bind)
  }
  const book = res.defective ?? res.clean;
  // Every loan reached the transfer; one paid off before it is no transfer at all.
  if (book.loans.some((l) => l.transfer_in_on !== T || !l.at_transfer)) return null;
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
    )
      return null;
  }
  const loans: PackageLoan[] = book.loans.map((life, i) => ({ life, defects: planted[i]! }));
  const pkg = writeTransferPackage(loans, {
    ...PACKAGE_DEFAULTS,
    batch_id: `B-${T.replace(/-/g, "")}-${String(index).padStart(4, "0")}`,
    transfer_date: T,
  });
  if ([...gateFailures(pkg).values()].some((f) => f.length > 0)) return null;
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
