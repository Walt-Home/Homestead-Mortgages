/**
 * Synthetic tape deliveries, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). It is one month of a
 * partner's monthly tape stream: the life generator runs a book of 8 to 14
 * loans month by month for five years (payment timing, partials,
 * curtailments, misses and cures, escrow analyses, ARM changes, payoffs,
 * transfers in and out), the tape writer writes the partner's tapes for the
 * month and the two before it, and the delivery is the month's file as it
 * came to the desk, beside the last one the desk loaded. The behavior is
 * drawn from the calibration's typed defaults, so a new calibration file does
 * not move the pinned suite.
 *
 * What a delivery carries is taken in turn by index (`INTAKE_ARMS`): nothing;
 * one tape-stream defect in one of its forms; a spreadsheet's two (T-03 and
 * T-04); or a history error made in the month on the partner's books (V-01,
 * V-02, D-25), alone or under a stream defect. A history error is planted as
 * a twin (src/life/defects.ts), on an event the clean history had in the
 * month: a tax bill, the first hazard renewal after a transfer, a borrower's
 * payment and a loan a keystroke away for it to land on (whose number the
 * scenario pins, which moves no other draw). D-28, a payment drafted twice, is
 * not drawn: on a monthly tape it is a month paid twice and the next paid
 * ahead, which a borrower who pays the next installment early in the same
 * month also shows, and the tape cannot tell them apart.
 *
 * A delivery is kept only when the reference, working through the tools,
 * finds exactly what was planted, with nothing extra, and gives its verdict.
 * Otherwise it is redrawn under the next key.
 */

import {
  addBusinessDays,
  addMonths,
  endOfMonth,
  plainDate,
  servicer as servicerCalendar,
  type PlainDate,
} from "@hm/kernel/calendar";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { rngFor, type Rng } from "../rng.js";
import { defaultCalibration, type Calibration } from "../life/calibration.js";
import { DEFECTS, onOurBooks } from "../life/defects.js";
import { generate, type DefectRequest, type LifeBook } from "../life/generate.js";
import type { LoanPins } from "../life/draw.js";
import type { LoanLife } from "../life/simulate.js";
import type { ScenarioEvent } from "../life/scenario.js";
import { writeTape, tapeColumnIndex, type TapeFile } from "../life/tape.js";
import {
  plantTapeDefects,
  tapeDefectById,
  type PlantedTapes,
  type TapeDefectRequest,
} from "../life/tape-defects.js";
import { deskReading } from "./desk.js";
import {
  gradeIntakeAgainst,
  parseIntakeSubmission,
  readFindings,
  verdictOf,
  type Ask,
  type ExpectedFinding,
  type IntakeDefect,
  type IntakeExpected,
} from "./grader.js";
import { intakeSteps } from "./reference.js";
import {
  INTAKE_ENVIRONMENT_NAME,
  INTAKE_ENVIRONMENT_VERSION,
  intakePayload,
  type IntakeFile,
  type TapeIntakeTask,
} from "./task.js";
import { executeIntakeTool } from "./tools.js";

export const intakeTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${INTAKE_ENVIRONMENT_NAME}/${INTAKE_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

/** A stream defect an arm plants: in the month (M) or the month before it (M-1), in a form and column when it names them. */
interface StreamPlan {
  readonly id: string;
  readonly at: "M" | "M-1";
  readonly variant?: string;
  readonly column?: string;
}
type HistoryId = "V-01" | "V-02" | "D-25";
/** The registry's key for each: D-25 is planted in its wrong-loan form (`D-25/wrong-loan`), the finding names D-25. */
const REGISTRY_KEY: Readonly<Record<HistoryId, string>> = {
  "V-01": "V-01",
  "V-02": "V-02",
  "D-25": "D-25/wrong-loan",
};
interface Plan {
  readonly stream: readonly StreamPlan[];
  readonly history: HistoryId | null;
}

export const INTAKE_ARMS = [
  "clean",
  "month_missing",
  "month_resent",
  "header_required",
  "header_optional",
  "codes",
  "dates",
  "as_of",
  "tax_amount",
  "renewal_billed_away",
  "payment_misposted",
  "clean_again",
  "spreadsheet",
  "month_relabeled",
  "misposted_as_of",
  "renewal_header",
] as const;
export type IntakeArm = (typeof INTAKE_ARMS)[number];

const s = (id: string, extra: Partial<StreamPlan> = {}): StreamPlan => ({ id, at: "M", ...extra });
export const INTAKE_PLANS: Readonly<Record<IntakeArm, Plan>> = {
  clean: { stream: [], history: null },
  month_missing: { stream: [s("T-01", { at: "M-1", variant: "missing" })], history: null },
  month_resent: { stream: [s("T-01", { variant: "resent" })], history: null },
  header_required: { stream: [s("T-02", { variant: "required" })], history: null },
  header_optional: { stream: [s("T-02", { variant: "optional" })], history: null },
  codes: { stream: [s("T-03")], history: null },
  dates: { stream: [s("T-04")], history: null },
  as_of: { stream: [s("T-05")], history: null },
  tax_amount: { stream: [], history: "V-01" },
  renewal_billed_away: { stream: [], history: "V-02" },
  payment_misposted: { stream: [], history: "D-25" },
  clean_again: { stream: [], history: null },
  spreadsheet: { stream: [s("T-03"), s("T-04")], history: null },
  month_relabeled: { stream: [s("T-01", { variant: "relabeled" })], history: null },
  misposted_as_of: { stream: [s("T-05")], history: "D-25" },
  renewal_header: { stream: [s("T-02", { variant: "optional" })], history: "V-02" },
};
export const intakeArmOf = (index: number): IntakeArm => INTAKE_ARMS[index % INTAKE_ARMS.length]!;

const EARLIEST = plainDate("2026-03-01");
/** Months each loan runs from its first payment: the book's five years. */
const BOOK_MONTHS = 60;
const MIN_ROWS = 5;

const ym = (d: PlainDate) => d.slice(0, 7);
const plusMonths = (month: string, n: number) => ym(addMonths(plainDate(`${month}-01`), n));
const endOf = (month: string) => endOfMonth(plainDate(`${month}-01`));

const ASK_OF: Readonly<Record<string, Ask>> = {
  "T-02": "restore_header",
  "T-03": "export_codes_as_text",
  "T-04": "export_dates_in_layout",
  "T-05": "write_month_end_as_of",
  "V-01": "research_disbursement",
  "V-02": "confirm_insurance_billing",
  "D-25": "move_payment",
};
const AS: Readonly<Record<string, Pick<ExpectedFinding, "says_as" | "truth_as">>> = {
  "T-02": { says_as: "header", truth_as: "header" },
  "T-03": { says_as: "text", truth_as: "text" },
  "T-04": { says_as: "text", truth_as: "date" },
  "T-05": { says_as: "text", truth_as: "date" },
  "V-01": { says_as: "money", truth_as: "money" },
  "V-02": { says_as: "money", truth_as: "money" },
  "D-25": { says_as: "money", truth_as: "money" },
};

/** The findings the stream's root labels give: one per defect and column, its first row's cell; one per T-01 month. */
function streamFindings(p: PlantedTapes, month: string): ExpectedFinding[] {
  const out: ExpectedFinding[] = [];
  for (const x of p.placed) {
    const loading = tapeDefectById(x.defect_id).loading(x.variant);
    const effect = loading === "resend" ? "hold" : loading === "corrected" ? "corrected" : "none";
    if (x.defect_id === "T-01") {
      const missing = x.variant === "missing";
      out.push({
        defect: "T-01",
        month: x.month,
        loan: null,
        column: null,
        says: null,
        truth: null,
        ask: missing ? "send_missing_month" : "send_this_month",
        says_as: "text",
        truth_as: "text",
        // A month never delivered leaves the one that came loadable.
        effect: missing && x.month !== month ? "none" : effect,
      });
      continue;
    }
    const tape = p.clean.find((f) => f.month === x.month)!.filename;
    const labels = p.labels.filter((l) => l.defect_id === x.defect_id && l.tape === tape);
    for (const field of [...new Set(labels.map((l) => l.field))]) {
      const first = labels.find((l) => l.field === field)!;
      out.push({
        defect: x.defect_id as IntakeDefect,
        month: x.month,
        loan: null,
        column: field,
        says: first.planted_value,
        truth: first.true_value,
        ask: ASK_OF[x.defect_id]!,
        ...AS[x.defect_id]!,
        effect,
      });
    }
  }
  return out;
}

/** A tape's cell for a loan, by the generator's loan id, or null when the loan is not on it. */
function cell(f: TapeFile, loan: string, key: string): string | null {
  const k = f.loans.indexOf(loan);
  return k < 0 ? null : (f.rows[k]![tapeColumnIndex(key)] ?? null);
}

function fileOf(f: TapeFile, forMonth: string, receivedOn: PlainDate): IntakeFile {
  return {
    name: f.filename,
    for_month: forMonth,
    received_on: receivedOn,
    headers: f.headers,
    rows: f.rows,
  };
}

/** Whether a loan is on our books from the month before `month` through its end, still being paid. */
const throughMonth = (life: LoanLife, month: string) =>
  onOurBooks(life, endOf(plusMonths(month, -1))) && onOurBooks(life, endOf(month));

/** The borrower's own payments a loan posted in a month. */
const paidIn = (life: LoanLife, month: string) => life.receipts.filter((x) => ym(x.on) === month);

/** Where a history error can be made in the book, and the month it lands in. */
function historyPlaces(
  id: HistoryId,
  book: LifeBook,
  months: readonly string[],
): { loan: number; month: string; at: PlainDate; partner: number | null }[] {
  const out: { loan: number; month: string; at: PlainDate; partner: number | null }[] = [];
  const inRange = new Set(months);
  book.loans.forEach((life, i) => {
    if (id === "V-01") {
      if (!DEFECTS["V-01"]!.eligible(life.draw)) return;
      for (const c of DEFECTS["V-01"]!.history!.candidates(life)) {
        const m = ym(c.on);
        if (inRange.has(m) && throughMonth(life, m))
          out.push({ loan: i, month: m, at: c.on, partner: null });
      }
    } else if (id === "V-02") {
      // A loan with no mortgage insurance, whose premium would leave escrow every month, and no other bill that month.
      if (life.draw.mi !== null || !DEFECTS["V-02"]!.eligible(life.draw)) return;
      for (const c of DEFECTS["V-02"]!.history!.candidates(life)) {
        const m = ym(c.on);
        const other = life.disbursements.some((x) => ym(x.on) === m && x.line !== "hazard");
        if (inRange.has(m) && !other && throughMonth(life, m))
          out.push({ loan: i, month: m, at: c.on, partner: null });
      }
    }
  });
  if (id === "D-25")
    for (const m of months) {
      // A payer and a loan to land on, each paying one installment that month and nothing else.
      const one = book.loans.flatMap((life, i) => {
        const r = paidIn(life, m);
        return throughMonth(life, m) &&
          r.length === 1 &&
          r[0]!.mode === "regular" &&
          r[0]!.channel === "borrower"
          ? [{ i, at: r[0]!.on }]
          : [];
      });
      for (const a of one)
        for (const b of one)
          if (a.i !== b.i) out.push({ loan: a.i, month: m, at: a.at, partner: b.i });
    }
  return out;
}

/** A loan number a keystroke from another's: its last digit one on. */
const neighborOf = (n: string) => n.slice(0, -1) + String((Number(n.at(-1)) + 1) % 10);

export function drawIntakeCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
  calibration: Calibration,
  plan: Plan = INTAKE_PLANS[intakeArmOf(index)],
  arm: string = intakeArmOf(index),
): TapeIntakeTask | null {
  // The book: a partner's loans, a third of them reaching it by transfer.
  const start = addMonths(EARLIEST, r.int(0, 18));
  const cohort = r.int(6, 24);
  const loans = r.int(8, 14);
  const events: ScenarioEvent[] = [];
  for (let i = 0; i < loans; i++)
    if (r.chance(0.35)) events.push({ kind: "transfer_in", loan: i, month: r.int(2, 18) });
  const seed = r.int(0, 0x7fffffff);
  const partner = `Partner ${r.int(100, 999)}`;
  const monthDraw = r.int(cohort + 3, BOOK_MONTHS - 4);
  const pick = r.next();
  const lag = [r.int(5, 8), r.int(5, 8)] as const;
  const scenario = {
    loans,
    start,
    cohort_months: cohort,
    months: BOOK_MONTHS,
    random: { transfers_out: true },
    events,
  };
  const first = generate(seed, scenario, { calibration }).clean;
  const months = Array.from({ length: BOOK_MONTHS - 4 - cohort - 2 }, (_, k) =>
    plusMonths(ym(start), cohort + 3 + k),
  );

  // The month, and where a history error lands in it.
  let M = plusMonths(ym(start), monthDraw);
  const pins: Record<number, LoanPins> = {};
  const defects: DefectRequest[] = [];
  if (plan.history) {
    const places = historyPlaces(plan.history, first, months);
    if (places.length === 0) return null;
    const at = places[Math.floor(pick * places.length)]!;
    M = at.month;
    if (at.partner !== null) {
      // The loan the payment lands on carries the payer's number a keystroke off: the scenario pins it.
      const number = neighborOf(first.loans[at.loan]!.draw.servicer_loan_number);
      if (first.loans.some((l) => l.draw.servicer_loan_number === number)) return null;
      pins[at.partner] = { servicer_loan_number: number };
      defects.push({
        id: REGISTRY_KEY[plan.history],
        loans: [at.loan],
        at: at.at,
        with: [at.partner],
      });
    } else defects.push({ id: REGISTRY_KEY[plan.history], loans: [at.loan], at: at.at });
  }
  const res = generate(
    seed,
    { ...scenario, pins },
    { calibration, ...(defects.length ? { defects } : {}) },
  );
  const book = res.defective ?? res.clean;
  if (plan.history && !res.planted.every((x) => ym(x.on) === M)) return null;

  // The partner's tapes for the month and the two before it, as its system wrote them, and the delivery's defects.
  let stream: TapeFile[];
  try {
    stream = [plusMonths(M, -2), plusMonths(M, -1), M].map((m) => writeTape(book, m));
  } catch (e) {
    // Two loans drawn one loan number: a tape the writer refuses to write.
    if (e instanceof RangeError) return null;
    throw e;
  }
  if (stream.some((f) => f.rows.length < MIN_ROWS)) return null;
  const requests: TapeDefectRequest[] = plan.stream.map((x) => ({
    id: x.id,
    months: [x.at === "M" ? M : plusMonths(M, -1)],
    ...(x.variant ? { variant: x.variant } : {}),
    ...(x.column ? { column: x.column } : {}),
  }));
  let planted: PlantedTapes;
  try {
    planted = plantTapeDefects(book, stream, requests);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
  const delivered = planted.planted.filter((f) => f.month === M);
  const lastFile =
    planted.planted.find((f) => f.month === plusMonths(M, -1)) ??
    planted.planted.find((f) => f.month === plusMonths(M, -2))!;
  if (delivered.length !== 1) return null;
  const delivery = fileOf(delivered[0]!, M, addBusinessDays(endOf(M), lag[0], servicerCalendar));
  const last = fileOf(
    lastFile,
    lastFile.month,
    addBusinessDays(endOf(lastFile.month), lag[1], servicerCalendar),
  );

  // What the labels say: the stream's defects, and each history error as the delivery shows it.
  const findings = streamFindings(planted, M);
  if (plan.history) {
    const clean = writeTape(res.clean, M);
    const column = plan.history === "D-25" ? "cash_flow_month_12" : "escrow_balance_cents";
    const header =
      plan.history === "D-25"
        ? "Cash Flow Month 12 (Most Recent Month)"
        : "SRV Asset Escrow Balance";
    for (const x of res.planted) {
      const life = book.loans[x.index]!;
      const says = cell(delivered[0]!, life.loan_id, column);
      if (says === null) return null;
      findings.push({
        defect: plan.history,
        month: M,
        loan: life.draw.servicer_loan_number,
        column: header,
        says,
        truth: plan.history === "D-25" ? cell(clean, life.loan_id, column) : null,
        ask: ASK_OF[plan.history]!,
        ...AS[plan.history]!,
        effect: "none",
      });
    }
  }
  const expected: IntakeExpected = { verdict: verdictOf(findings.map((f) => f.effect)), findings };
  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    arm,
    partner,
    delivery,
    last_loaded: last,
    desk_reading: deskReading(delivery.headers, delivery.rows),
    expected,
  };
}

/** Whether the rulebook followed through the tools finds exactly the labels, nothing more, and gives the verdict. */
export function intakeFairToGrade(task: TapeIntakeTask): boolean {
  const payload = JSON.parse(JSON.stringify(intakePayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(intakeSteps, payload, (n, i) => executeIntakeTool(n, i, task));
  } catch {
    return false;
  }
  const parsed = parseIntakeSubmission(byRules);
  return (
    parsed.ok &&
    gradeIntakeAgainst(task.expected, parsed.answer).pass &&
    readFindings(task.expected, parsed.answer).extra.length === 0
  );
}

const ATTEMPTS = 40;

export function drawIntakeTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
  calibration: Calibration = defaultCalibration(),
): { task: TapeIntakeTask; attempts: number } {
  const id = intakeTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = rngFor(attempt === 0 ? id : `${id}#${attempt}`);
    const task = drawIntakeCandidate(r, id, split, suiteSeed, index, calibration);
    if (task && intakeFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no delivery the reference solves exactly in ${ATTEMPTS} draws`);
}

export const generateIntakeTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): TapeIntakeTask => drawIntakeTask(split, suiteSeed, index).task;

export function generateIntakeSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): TapeIntakeTask[] {
  return Array.from({ length: n }, (_, i) => generateIntakeTask(split, suiteSeed, i));
}

export const INTAKE_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's own cases: each defect in a named form ───────────────────── */

export const INTAKE_SPEC_CASES: readonly { readonly name: string; readonly plan: Plan }[] = [
  { name: "a clean month", plan: INTAKE_PLANS.clean },
  { name: "last month never delivered (T-01)", plan: INTAKE_PLANS.month_missing },
  {
    name: "last month's tape sent again under its own name (T-01)",
    plan: INTAKE_PLANS.month_resent,
  },
  {
    name: "the next due date's header renamed (T-02, required)",
    plan: { stream: [s("T-02", { variant: "required", column: "Next Due Date" })], history: null },
  },
  {
    name: "the pay string's header renamed (T-02)",
    plan: { stream: [s("T-02", { variant: "optional", column: "Pay String" })], history: null },
  },
  {
    name: "a spreadsheet's zeros and day-first maturity dates (T-03, T-04)",
    plan: {
      stream: [s("T-03"), s("T-04", { variant: "day_first", column: "Date Maturity" })],
      history: null,
    },
  },
  {
    name: "two-digit years on the closing date (T-04)",
    plan: {
      stream: [s("T-04", { variant: "two_digit_year", column: "Orig Date Closing" })],
      history: null,
    },
  },
  {
    name: "Excel serial numbers for the next due date (T-04)",
    plan: { stream: [s("T-04", { variant: "serial", column: "Next Due Date" })], history: null },
  },
  {
    name: "the export's day as the as-of (T-05)",
    plan: { stream: [s("T-05", { variant: "export_date" })], history: null },
  },
  {
    name: "last month's end as the as-of (T-05)",
    plan: { stream: [s("T-05", { variant: "prior_month_end" })], history: null },
  },
  { name: "a tax bill paid at ten times the county's (V-01)", plan: INTAKE_PLANS.tax_amount },
  {
    name: "a hazard renewal billed to the prior servicer (V-02)",
    plan: INTAKE_PLANS.renewal_billed_away,
  },
  {
    name: "a payment posted to the loan a keystroke away (D-25)",
    plan: INTAKE_PLANS.payment_misposted,
  },
];

export function intakeSpecTasks(calibration: Calibration = defaultCalibration()): TapeIntakeTask[] {
  return INTAKE_SPEC_CASES.map((c, index) => {
    const id = `${INTAKE_ENVIRONMENT_NAME}/${INTAKE_ENVIRONMENT_VERSION}/spec/0/${index}`;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const r = rngFor(attempt === 0 ? id : `${id}#${attempt}`);
      const task = drawIntakeCandidate(r, id, "spec", 0, index, calibration, c.plan, c.name);
      if (task && intakeFairToGrade(task)) return task;
    }
    throw new Error(`${id}: no delivery for "${c.name}" in ${ATTEMPTS} draws`);
  });
}

/** The task's verdict, for a run's tally: what the delivery holds. */
export function intakeVerdict(task: TapeIntakeTask): string {
  const ids = [...new Set(task.expected.findings.map((f) => f.defect))].sort();
  return ids.length === 0 ? "clean" : ids.join("+");
}
