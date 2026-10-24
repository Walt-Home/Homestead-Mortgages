/**
 * The first demo's page, as data: the demo loan's ten years in its clean
 * history and its defective twin, the m3-v1 tape a partner sees each month,
 * the three moments a model is asked to act, what the defects cost on the
 * twin, and a book of 1,000 loans held to the calibration's acceptance tests.
 *
 * Nothing here is computed for the page alone. The histories are the life
 * generator's (`generate`, over the ported engines), drawn exactly as
 * `demoLoan()` draws them; the tape is `writeTape`'s; each moment is posed by
 * its environment's own task builder, answered by its reference policy
 * through its own tools (`solveNow`), and graded by its own grader; the cost
 * of a missed late-fee cap is cashiering's `lateChargeAmount`; the book is
 * the generator's, read by `calibrationCheck` and `bookPanel`.
 *
 * The demo loan is drawn from the calibration's typed defaults
 * (`defaultCalibration`), as the three environments draw their tasks, so the
 * page shows the tasks they pose. The book is drawn from calibration.json,
 * which the caller reads and hands in, because a bundled module cannot find
 * the file beside itself.
 *
 * `scripts/build-demo.mjs` bundles this module, runs it, and fills the page
 * template with the result. Every value is plain JSON: cents as numbers
 * (every figure here is far below 2^53), and each graded field exactly as
 * its grader writes it.
 */

import { addDays, addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { formatCents, type Cents } from "@hm/kernel/money";
import type { FieldGrade } from "../episode.js";
import { solveNow, type Json } from "../refi/reference.js";
import { toJsonLine } from "../record.js";
import { defaultCalibration, loadCalibration, type CalibrationFile } from "../life/calibration.js";
import {
  DEMO_DEFECTS,
  DEMO_SCENARIO,
  DEMO_SEED,
  DEMO_TRANSFER_DATE,
  demoLoan,
} from "../life/demo.js";
import type { DefectLabel } from "../life/defects.js";
import { generate, LIFE_VERSION, type LifeBook } from "../life/generate.js";
import type { AnalysisRow, LifeMoment, LoanLife } from "../life/simulate.js";
import {
  TAPE_HEADERS,
  TAPE_PROFILE,
  TAPE_VERSION,
  tapeColumnIndex,
  tapeMonths,
  writeTape,
} from "../life/tape.js";
import { CORRESPONDENCE_FILE } from "../life/transfer-package.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { parseCsv } from "../boarding/ported/tape-codec.js";
import {
  boardingPayload,
  boardingSpecTasks,
  boardingSteps,
  boardingTriage,
  boardingVerdict,
  executeBoardingTool,
  type BoardingTask,
  type TriageAnswer,
} from "../boarding/index.js";
import {
  CATCHUP_ARMS,
  catchupFairToGrade,
  catchupInScope,
  catchupMomentInScope,
  catchupPayload,
  catchupPosting,
  catchupSteps,
  catchupTaskAt,
  catchupVerdict,
  executeCatchupTool,
  historyInScope,
  onArm as catchupOnArm,
  type CatchupAnswer,
  type CatchupTask,
} from "../catchup/index.js";
import {
  agreesWithHistory,
  escrowReview,
  escrowReviewSteps,
  executeReviewTool,
  reviewFairToGrade,
  reviewPayload,
  reviewTaskAt,
  reviewVerdict,
  type EscrowReviewAnswer,
  type EscrowReviewTask,
} from "../escrow-review/index.js";
import { bookPanel, type AcceptanceFile, type PageBook } from "./book-panel.js";

/** Bump on any change to what the page shows or how it is computed. */
export const DEMO_PAGE_VERSION = "1.0.0";

/* ── the shapes ───────────────────────────────────────────────────────────── */

export type TwinName = "clean" | "defective";

/** A labeled difference from the clean history, on a row of the defective twin. */
export interface PageMark {
  readonly defects: readonly string[];
  /** The planted value itself, not a symptom of it. */
  readonly root: boolean;
  readonly note: string;
}

export type PageEventKind =
  | "transfer"
  | "receipt"
  | "late_charge"
  | "no_late_charge"
  | "disbursement"
  | "analysis"
  | "call"
  | "borrower"
  | "mi"
  | "payoff";

export interface PageEvent {
  readonly on: string;
  readonly kind: PageEventKind;
  /** The prior servicer's, before the transfer. */
  readonly prior: boolean;
  readonly text: string;
  /** Cents, or null. */
  readonly amount: number | null;
  readonly detail: readonly string[];
  /** Routine and repeated every month (the mortgage-insurance premium). */
  readonly quiet: boolean;
  readonly mark: PageMark | null;
  /** In the clean history and not in this one. */
  readonly ghost: boolean;
}

export interface PageMonth {
  readonly month: string;
  readonly servicer: "prior" | "us";
  readonly status: string;
  readonly mba: string;
  readonly days_delinquent: number;
  readonly upb: number;
  readonly escrow_balance: number;
  readonly suspense: number;
  readonly late_charges_due: number;
  readonly pi: number;
  readonly escrow_payment: number;
  readonly next_due: string | null;
  readonly lpi: string | null;
  readonly metro2_status: string;
  readonly events: readonly PageEvent[];
  /** Labels dated in the month (defective twin), and the month-end fields they changed. */
  readonly labels: {
    readonly count: number;
    readonly fields: readonly {
      readonly defect: string;
      readonly table: string;
      readonly field: string;
      readonly true_value: string;
      readonly planted_value: string;
    }[];
  };
  /** The m3-v1 row the tape writer writes for the loan that month, or null when the loan is not on our books. */
  readonly tape: readonly string[] | null;
  /** What happened in the month that no column of the tape carries. */
  readonly hidden: readonly string[];
}

export interface PageTwin {
  readonly name: TwinName;
  readonly boarded: {
    readonly on: string;
    readonly escrowed: boolean;
    readonly cap_cents: number | null;
  };
  readonly months: readonly PageMonth[];
  readonly label_count: number;
  readonly label_tables: readonly {
    readonly defect: string;
    readonly table: string;
    readonly count: number;
  }[];
}

export interface PageFact {
  readonly label: string;
  readonly value: string;
  /** A cell a planted defect sits in. */
  readonly flag?: boolean;
}

export interface PageGraded {
  readonly field: string;
  /** The grader's expected value, exactly as it writes it. */
  readonly expected: string;
  /** The same, for a reader. */
  readonly shown: string;
  /** What the reference policy's answer gave, as the grader read it. */
  readonly got: string | null;
  readonly ok: boolean;
}

export interface PagePosed {
  readonly posed: true;
  readonly task_id: string;
  /** The rendered task's first line, verbatim. */
  readonly opening: string;
  readonly prompt_chars: number;
  readonly rulebook_words: number;
  readonly tools: readonly string[];
  readonly shown: readonly { readonly heading: string; readonly facts: readonly PageFact[] }[];
  readonly elided: string;
  /** The reference policy's submission, for a reader. */
  readonly answer: readonly PageFact[];
  /** The reference policy's submission as it was submitted. */
  readonly answer_raw: Json;
  readonly graded: readonly PageGraded[];
  readonly pass: boolean;
  readonly tool_calls: number;
  readonly verdict: string;
  /** The arm of the environment's draw the moment lands on, where the environment names arms. */
  readonly arm: string | null;
  readonly why: string;
}

export interface PageNotPosed {
  readonly posed: false;
  readonly why: string;
}

export type MomentId = "triage" | "catchup" | "escrow";

export interface PageMoment {
  readonly id: MomentId;
  readonly title: string;
  readonly on: string;
  readonly env: { readonly name: string; readonly version: string };
  readonly summary: string;
  readonly twins: Readonly<Record<TwinName, PagePosed | PageNotPosed>>;
}

export interface PageHarm {
  readonly d03: {
    readonly pct: string;
    readonly cap_cents: number;
    readonly rows: readonly {
      readonly installment_due: string;
      readonly assessed_on: string;
      readonly charged: number;
      readonly allowed: number;
      readonly over: number;
      readonly collected: number;
      readonly collected_on: string | null;
      readonly refund: number;
    }[];
    readonly over_total: number;
    readonly refund_total: number;
  };
  readonly d31: {
    readonly lines: readonly {
      readonly line: string;
      readonly label: string;
      readonly bills: number;
      readonly total: number;
      readonly first_due: string;
      readonly last_due: string;
    }[];
    readonly bills: number;
    readonly total: number;
    readonly tax_total: number;
    readonly first_tax: { readonly on: string; readonly amount: number } | null;
    readonly first_hazard: {
      readonly on: string;
      readonly amount: number;
      readonly days_after_boarding: number;
    } | null;
    readonly escrow_not_billed: { readonly installments: number; readonly total: number };
    readonly payoff_refund: { readonly clean: number; readonly defective: number };
    readonly penalty: null;
    readonly penalty_note: string;
  };
}

export interface DemoPageData {
  readonly page_version: string;
  readonly life_version: string;
  readonly tape: { readonly profile: string; readonly version: string };
  readonly demo_calibration: { readonly version: string; readonly path: null };
  readonly envs: readonly { readonly name: string; readonly version: string }[];
  readonly loan: {
    readonly id: string;
    readonly servicer_loan_number: string;
    readonly prior_servicer_loan_number: string;
    readonly borrowers: readonly string[];
    readonly city: string;
    readonly state: string;
    readonly note_date: string;
    readonly first_due: string;
    readonly maturity: string;
    readonly orig_upb: number;
    readonly value: number;
    readonly ltv_pct: number;
    readonly note_rate_pct: string;
    readonly term_months: number;
    readonly pi: number;
    readonly mi: {
      readonly annual: number;
      readonly rate_pct: string;
      readonly coverage_pct: number;
    } | null;
    readonly late_charge: {
      readonly pct: string;
      readonly grace_days: number;
      readonly cap_cents: number | null;
    };
    readonly transfer_on: string;
    readonly defects: readonly string[];
  };
  readonly story: readonly {
    readonly on: string;
    readonly text: string;
    readonly moment: MomentId | null;
  }[];
  readonly tape_headers: readonly string[];
  /** The tape columns the lane shows, by index into `tape_headers`. */
  readonly tape_lane: readonly number[];
  readonly twins: Readonly<Record<TwinName, PageTwin>>;
  readonly moments: readonly PageMoment[];
  readonly harm: PageHarm;
  readonly book: PageBook;
}

export interface DemoPageOptions {
  /** calibration.json as written, which the book is drawn from. */
  readonly calibrationFile: CalibrationFile;
  /** calibration-acceptance.json as written. */
  readonly acceptance: AcceptanceFile;
  readonly bookLoans?: number;
  readonly bookSeed?: string;
}

/* ── formatting ───────────────────────────────────────────────────────────── */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const usd = (c: Cents | number): string => formatCents(BigInt(c));
const n = (c: Cents): number => Number(c);
const monthName = (d: string): string => `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const MONTH = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const fullMonth = (d: string): string => `${MONTH[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const dayName = (d: string): string =>
  `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

const LINE: Readonly<Record<string, string>> = {
  tax_county: "county tax",
  tax_school: "school tax",
  hazard: "hazard insurance",
  flood: "flood insurance",
  mi_borrower_paid: "mortgage insurance premium",
};
const lineName = (l: string) => LINE[l] ?? l.replace(/_/g, " ");

const REASON: Readonly<Record<string, string>> = {
  collection_call: "collection call",
  promise_to_pay: "promise to pay",
  escrow_taxes_insurance: "escrow, taxes or insurance",
  servicing_communication: "a question about their account",
  payment_process: "how a payment was handled",
  loss_mitigation: "help with payments",
  foreclosure: "foreclosure",
  servicing_transfer: "the servicing transfer",
  fees: "fees",
  payoff: "a payoff",
  mortgage_insurance: "mortgage insurance",
  lien_release: "the lien release",
  interest_rate: "the interest rate",
  credit_reporting: "credit reporting",
};
const reasonName = (r: string) => REASON[r] ?? r.replace(/_/g, " ");

/** The escrow engine's review triggers (escrow/analysis.ts's `anomalies`, and the line anomalies of its projection). */
const ANOMALY: Readonly<Record<string, string>> = {
  payment_change_gt_25pct: "payment change over 25%",
  payment_change_gt_150: "payment change over $150",
  surplus_gt_2500: "a surplus over $2,500",
  bill_variance_gt_20pct: "a bill over 20% against last year",
  missing_penalty_date: "a tax bill with no penalty date",
  pmi_without_termination: "mortgage insurance with no termination date",
};
const anomalyName = (a: string) => ANOMALY[a] ?? a.replace(/_/g, " ");

/** A labeled value, for a reader: cents fields as dollars, Metro 2's zero-padded whole dollars as dollars. */
const CENTS_FIELDS = new Set([
  "amount",
  "late_charge",
  "to_suspense",
  "suspense_used",
  "upb_after",
  "amount_cents",
  "collected_cents",
  "escrow_balance",
  "escrow_payment",
  "paid_in_month",
  "late_charges_due",
  "amount_past_due",
  "upb",
  "suspense",
  "escrow",
  "escrow_refund",
  "late_charge_max_cents",
]);
const METRO2_DOLLARS = new Set([
  "scheduled_monthly_payment",
  "actual_payment_amount",
  "amount_past_due",
  "current_balance",
]);
function labelValue(table: string, field: string, v: string | null): string {
  if (v === null || v === "") return "blank";
  if (table === "metro2" && METRO2_DOLLARS.has(field) && /^\d+$/.test(v))
    return `$${Number(v).toLocaleString("en-US")}`;
  if (CENTS_FIELDS.has(field) && /^-?\d+$/.test(v)) return usd(BigInt(v));
  if (field === "installments") {
    try {
      const xs = JSON.parse(v) as { escrow: string }[];
      return `escrow share ${usd(xs.reduce((s, x) => s + BigInt(x.escrow), 0n))}`;
    } catch {
      return v;
    }
  }
  return v.replace(/_/g, " ");
}

/* ── one history, month by month ─────────────────────────────────────────── */

const monthOf = (d: string) => d.slice(0, 7);

interface LabelIndex {
  byRow: Map<string, DefectLabel[]>;
  byMonth: Map<string, DefectLabel[]>;
}

function indexLabels(labels: readonly DefectLabel[]): LabelIndex {
  const byRow = new Map<string, DefectLabel[]>();
  const byMonth = new Map<string, DefectLabel[]>();
  for (const l of labels) {
    const k = `${l.file_or_table}|${l.row}`;
    byRow.set(k, [...(byRow.get(k) ?? []), l]);
    const m = monthOf(l.on);
    byMonth.set(m, [...(byMonth.get(m) ?? []), l]);
  }
  return { byRow, byMonth };
}

/** A label's field, for a reader. */
const FIELD_NAME: Readonly<Record<string, string>> = {
  amount_cents: "amount",
  collected_cents: "collected",
  upb_after: "balance after",
  escrow_refund: "escrow refunded",
};
const fieldName = (f: string) => FIELD_NAME[f] ?? f.replace(/_/g, " ");

function markOf(
  ls: readonly DefectLabel[] | undefined,
  skip: readonly string[] = [],
): PageMark | null {
  const shown = (ls ?? []).filter((l) => !skip.includes(l.field));
  if (shown.length === 0) return null;
  const defects = [...new Set(shown.flatMap((l) => l.defect_id.split("+")))].sort();
  // Two defects can each show the same difference, and a fee's amount sits in two tables: say each once.
  const parts = shown
    .filter((l) => l.field !== "*")
    .map(
      (l) =>
        `${fieldName(l.field)}: ${labelValue(l.file_or_table, l.field, l.true_value)} in the clean history, ${labelValue(l.file_or_table, l.field, l.planted_value)} here`,
    );
  return { defects, root: shown.some((l) => l.root_cause), note: [...new Set(parts)].join("; ") };
}

function receiptEvent(r: LoanLife["receipts"][number], idx: LabelIndex | null): PageEvent {
  const insts = r.installments;
  const which =
    insts.length === 0
      ? ""
      : insts.length === 1
        ? `the ${monthName(insts[0]!.due)} installment`
        : `the ${insts.map((x) => monthName(x.due)).join(" and ")} installments`;
  const lead: Readonly<Record<string, string>> = {
    regular: "Payment received",
    oldest: "Payment of the oldest installment",
    cure: "Catch-up payment",
    plan: "Repayment-plan payment",
    promise: "Payment as promised",
    partial: "Partial payment",
    partial_rest: "Rest of the partial payment",
    short_50: "Payment short by under $50",
    curtail: "Payment with extra principal",
    stale_bill_pay: "Bill pay sends the old amount",
    payoff: "Payoff funds",
  };
  const bits: string[] = [];
  if (which) bits.push(`pays ${which}`);
  if (r.late_charge > 0n) bits.push(`${usd(r.late_charge)} to the late charge`);
  if (r.curtailment > 0n) bits.push(`${usd(r.curtailment)} extra principal`);
  if (r.suspense_used > 0n) bits.push(`uses ${usd(r.suspense_used)} held in suspense`);
  if (r.to_suspense > 0n) bits.push(`${usd(r.to_suspense)} held in suspense`);
  if (r.outcome === "prepaid") bits.push("received before the due date");
  if (r.channel === "transferor_forward") bits.push("forwarded by the prior servicer");
  const detail = insts.map(
    (x) =>
      `${monthName(x.due)}: ${usd(x.interest)} interest, ${usd(x.principal)} principal, ${usd(x.escrow)} escrow`,
  );
  return {
    on: r.on,
    kind: r.mode === "payoff" ? "payoff" : "receipt",
    prior: r.servicer === "prior",
    text: `${lead[r.mode] ?? r.mode}${bits.length ? `: ${bits.join("; ")}` : ""}`,
    amount: n(r.amount),
    detail,
    quiet: false,
    mark: idx ? markOf(idx.byRow.get(`payments|${r.id}`), ["installments"]) : null,
    ghost: false,
  };
}

/** A month-by-month view of one history: its events, its month-ends and its tape rows. */
function twinView(
  name: TwinName,
  life: LoanLife,
  book: LifeBook,
  clean: LoanLife,
  labels: readonly DefectLabel[],
  scenarioPromise: { made: string; pay_on: string } | null,
): PageTwin {
  const idx = name === "defective" ? indexLabels(labels) : null;
  const events = new Map<string, PageEvent[]>();
  const add = (e: PageEvent) => {
    const m = monthOf(e.on);
    events.set(m, [...(events.get(m) ?? []), e]);
  };
  const inst = new Map(life.installments.map((i) => [i.due, i]));

  // The transfer, and what our boarding wrote.
  if (life.transfer_in_on) {
    const t = life.boarded.terms;
    const roots = idx
      ? [...(idx.byRow.get(`loan_terms|${life.loan_id}`) ?? []).filter((l) => l.root_cause)]
      : [];
    add({
      on: life.transfer_in_on,
      kind: "transfer",
      prior: false,
      text: `Servicing transfers to us. The prior servicer's books close on ${dayName(addDays(life.transfer_in_on, -1))}, and the loan boards from its transfer package`,
      amount: null,
      detail: [
        `Boarded ${t.escrowed ? "escrowed" : "non-escrowed"}`,
        `Late-fee cap boarded: ${t.late_charge_cap_cents === null ? "none" : usd(t.late_charge_cap_cents)} (the note says ${life.draw.late_charge.cap_cents === null ? "none" : usd(life.draw.late_charge.cap_cents)})`,
        `${life.at_transfer ? `At the transfer: balance ${usd(life.at_transfer.upb)}, escrow ${usd(life.at_transfer.escrow_balance)}, next due ${dayName(life.at_transfer.next_due)}` : ""}`,
      ].filter(Boolean),
      quiet: false,
      mark:
        roots.length === 0
          ? null
          : {
              defects: roots.map((l) => l.defect_id).sort(),
              root: true,
              note: roots
                .map((l) =>
                  l.defect_id === "D-42"
                    ? "the package's escrow cell said Yes, which the servicing app's decoder reads as No, so the loan boarded non-escrowed (D-42, boarding it as D-31)"
                    : l.defect_id === "D-03"
                      ? `the tape has no column for the note's ${usd(BigInt(l.true_value ?? "0"))} cap on a late charge, so none boarded (D-03)`
                      : `${l.field}: ${l.true_value} → ${l.planted_value}`,
                )
                .join("; "),
            },
      ghost: false,
    });
  }

  // A payoff's funds are the payoff row's, below.
  for (const r of life.receipts) if (r.mode !== "payoff") add(receiptEvent(r, idx));

  for (const f of life.fees) {
    const mark = idx
      ? markOf([
          ...(idx.byRow.get(`fees|${f.id}`) ?? []),
          ...(idx.byRow.get(`late_charge_runs|${f.due}`) ?? []),
        ])
      : null;
    add({
      on: f.assessed_on,
      kind: "late_charge",
      prior: f.servicer === "prior",
      text: `Late charge assessed on the ${monthName(f.due)} installment, the day after grace ends`,
      amount: n(f.amount),
      detail: [
        f.collected_on
          ? `Collected ${usd(f.collected)} on ${dayName(f.collected_on)}`
          : `Still owed: ${usd(f.amount - f.collected)}`,
      ],
      quiet: false,
      mark,
      ghost: false,
    });
  }

  // A late-charge run that charged nothing on an installment still unpaid: the engine counted suspense toward it.
  const unpaidAtRun = (run: LoanLife["late_charge_runs"][number]) => {
    if (run.outcome === "assessed") return false;
    const i = inst.get(run.due);
    const paidBy = i?.credited_as_of ?? i?.satisfied_on ?? null;
    return paidBy === null || paidBy >= run.on;
  };
  for (const run of life.late_charge_runs) {
    if (!unpaidAtRun(run)) continue;
    add({
      on: run.on,
      kind: "no_late_charge",
      prior: run.servicer === "prior",
      text: `Late-charge run on the ${monthName(run.due)} installment: none assessed (the engine's reason: ${(run.reason ?? run.outcome).replace(/_/g, " ")})`,
      amount: null,
      detail: [
        "The installment is still unpaid, but the cashiering engine counts the money held in suspense toward its P&I (the servicing app's decision 2.7-Q1), and the old amount covers the P&I.",
      ],
      quiet: false,
      mark: null,
      ghost: false,
    });
  }

  for (const d of life.disbursements) {
    const text =
      d.kind === "bill"
        ? `Escrow pays the ${lineName(d.line)}`
        : d.kind === "refund"
          ? "Escrow surplus refunded to the borrower"
          : "Escrow balance refunded after the payoff";
    add({
      on: d.on,
      kind: "disbursement",
      prior: d.servicer === "prior",
      text,
      amount: n(d.amount),
      detail: [`Escrow balance after: ${usd(d.balance_after)}`],
      quiet: d.kind === "bill" && d.line === "mi_borrower_paid",
      mark: null,
      ghost: false,
    });
  }

  for (const a of life.analyses) {
    const result =
      a.decision === "shortage"
        ? `a shortage of ${usd(a.shortage ?? 0n)}${a.deficiency && a.deficiency > 0n ? ` and a deficiency of ${usd(a.deficiency)}` : ""}, spread over 12 months`
        : a.decision === "refund"
          ? `a surplus of ${usd(a.surplus ?? 0n)}, refunded`
          : a.decision === "credit"
            ? `a surplus of ${usd(a.surplus ?? 0n)}, credited`
            : a.decision;
    add({
      on: a.as_of,
      kind: "analysis",
      prior: a.servicer === "prior",
      text: `Annual escrow analysis for the year from ${monthName(a.year_start)}: ${result}`,
      amount: null,
      detail: [
        // `old_payment` is the escrow payment on the loan's terms when the analysis ran, for the next installment, last
        // year's shortage or credit still in it at its level amount: what the engine's review triggers compare with
        // (life 1.2.0).
        `New escrow payment ${usd(a.new_payment)} from ${dayName(a.effective)}, against ${usd(a.old_payment)} on the loan's terms now; statement sent ${dayName(a.sent_on)}`,
        a.anomalies.length > 0
          ? `Held for review: ${a.anomalies.map(anomalyName).join(", ")}`
          : "Not held for review",
      ],
      quiet: false,
      mark: null,
      ghost: false,
    });
  }

  for (const c of life.contacts)
    add({
      on: c.on,
      kind: "call",
      prior: c.servicer === "prior",
      text:
        c.direction === "outbound"
          ? `Servicer calls the borrower (${reasonName(c.reason)}): ${c.outcome === "voicemail" ? "voicemail left" : "no answer"}`
          : `Borrower calls: ${reasonName(c.reason)}`,
      amount: null,
      detail: [`${c.minutes} ${c.minutes === 1 ? "minute" : "minutes"}`],
      quiet: false,
      mark: null,
      ghost: false,
    });

  const BEHAVIOR: Readonly<Record<string, string>> = {
    missed: "The borrower sends nothing for this installment",
    promise_made: scenarioPromise
      ? `On the call the borrower promises to pay everything owed by ${dayName(scenarioPromise.pay_on)}; the collection calls stop`
      : "The borrower promises to pay",
    deferred_to_promise: "The next installment's payment waits for the promised date",
    promise_kept: "Promise kept",
    promise_broken: "Promise broken",
    stale_bill_pay: "The borrower's bill pay is still set to the old payment amount",
    disaster: "A disaster declaration covers the property's county",
    transfer_out: "Servicing transfers out",
    plan_started: "Repayment plan starts",
    plan_completed: "Repayment plan completed",
    plan_failed: "Repayment plan fails",
  };
  for (const b of life.behavior) {
    const text = BEHAVIOR[b.kind];
    if (!text) continue;
    add({
      on: b.on,
      kind: "borrower",
      prior: b.servicer === "prior",
      text: b.due && b.kind === "missed" ? `${text} (${monthName(b.due)})` : text,
      amount: null,
      detail: [],
      quiet: false,
      mark: null,
      ghost: false,
    });
  }

  for (const p of life.pmi)
    add({
      on: p.on,
      kind: "mi",
      prior: p.servicer === "prior",
      text:
        p.status === "terminated"
          ? "Mortgage insurance ends automatically at its 78% date (Homeowners Protection Act)"
          : `Mortgage insurance: ${p.status.replace(/_/g, " ")}`,
      amount: null,
      detail: p.effective_on ? [`Effective ${dayName(p.effective_on)}`] : [],
      quiet: false,
      mark: null,
      ghost: false,
    });

  if (life.payoff) {
    const p = life.payoff;
    const mark = idx ? markOf(idx.byRow.get("payoffs|payoff")) : null;
    add({
      on: p.on,
      kind: "payoff",
      prior: p.servicer === "prior",
      text: `Paid off${p.by_refinance ? " by a refinance" : ""}`,
      amount: n(p.funds),
      detail: [
        `${usd(p.principal)} principal, ${usd(p.interest)} interest (${usd(p.per_diem)} a day)`,
        `Escrow balance of ${usd(p.escrow_refund)} refunded`,
      ],
      quiet: false,
      mark,
      ghost: false,
    });
  }

  // The defective twin: what the clean history did that this one did not.
  if (name === "defective" && idx) {
    const key = (d: LoanLife["disbursements"][number]) => `${d.on}|${d.line}|${d.kind}|${d.amount}`;
    const here = new Set(life.disbursements.map(key));
    for (const d of clean.disbursements)
      if (d.kind === "bill" && d.servicer === "us" && !here.has(key(d)))
        add({
          on: d.on,
          kind: "disbursement",
          prior: false,
          text: `Not paid: the ${lineName(d.line)}`,
          amount: n(d.amount),
          detail: [
            "The clean history's escrow account paid this bill; boarded non-escrowed, this one has no account to pay it from.",
          ],
          quiet: d.line === "mi_borrower_paid",
          mark: {
            defects: ["D-42"],
            root: false,
            note: "disbursements: a bill the escrow account should have paid",
          },
          ghost: true,
        });
    const ghostAnalyses = labels.filter(
      (l) => l.file_or_table === "escrow_analyses" && l.field === "*",
    );
    for (const l of ghostAnalyses) {
      const a = clean.analyses.find((x) => String(x.year) === l.row)!;
      add({
        on: a.as_of,
        kind: "analysis",
        prior: false,
        text: `Not run: the annual escrow analysis for the year from ${monthName(a.year_start)}`,
        amount: null,
        detail: [
          `The clean history ran it and set the escrow payment to ${usd(a.new_payment)}${a.anomalies.length ? `, held for review (${a.anomalies.map(anomalyName).join(", ")})` : ""}.`,
        ],
        quiet: false,
        mark: {
          defects: [l.defect_id],
          root: false,
          note: "escrow_analyses: the analysis was never run",
        },
        ghost: true,
      });
    }
    // The clean history's month of bill pay sending the old amount, if it had one: why its calls were made.
    const stale = clean.behavior.find((b) => b.kind === "stale_bill_pay" && b.servicer === "us");
    for (const l of labels.filter((x) => x.file_or_table === "contacts" && x.field === "*")) {
      const c = JSON.parse(l.true_value ?? "{}") as {
        on: PlainDate;
        reason: string;
        outcome?: string;
      };
      const afterStale =
        stale !== undefined &&
        c.reason === "collection_call" &&
        c.on > stale.on &&
        daysBetween(stale.on, c.on) <= 45;
      add({
        on: c.on,
        kind: "call",
        prior: false,
        text: `Not made: a ${reasonName(c.reason)} (${c.outcome === "voicemail" ? "voicemail" : "no answer"} in the clean history)`,
        amount: null,
        detail: [
          afterStale
            ? `The clean history's payment rose and bill pay sent the old amount on ${dayName(stale.on)}, so an installment was late; here the payment never rose, and nothing was.`
            : "The clean history made this call; this history did not.",
        ],
        quiet: false,
        mark: {
          defects: [l.defect_id],
          root: false,
          note: "contacts: a call the clean history made",
        },
        ghost: true,
      });
    }
    for (const l of labels.filter(
      (x) => x.file_or_table === "borrower_events" && x.field === "*",
    )) {
      const b = JSON.parse(l.true_value ?? "{}") as { on: string; kind: string };
      add({
        on: b.on,
        kind: "borrower",
        prior: false,
        text: `Not here: ${(BEHAVIOR[b.kind] ?? b.kind).replace(/^The /, "the ")}`,
        amount: null,
        detail: [],
        quiet: false,
        mark: {
          defects: [l.defect_id],
          root: false,
          note: "borrower_events: an event of the clean history",
        },
        ghost: true,
      });
    }
  }

  // The tape: one row a month on our books.
  const tapeRows = new Map<string, readonly string[]>();
  for (const m of tapeMonths(book)) {
    const t = writeTape(book, m);
    const k = t.loans.indexOf(life.loan_id);
    if (k >= 0) tapeRows.set(m, t.rows[k]!);
  }

  const first = life.months[0]!.month;
  const last = life.months.at(-1)!.month;
  const TI = tapeColumnIndex("ti_cents");
  let prevTi: string | null = null;
  const months: PageMonth[] = life.months.map((m) => {
    const evs = [...(events.get(m.month) ?? [])];
    // Anything dated outside the month-ends (none in the demo) joins the first or last month.
    if (m.month === first) for (const [k, v] of events) if (k < first) evs.push(...v);
    if (m.month === last) for (const [k, v] of events) if (k > last) evs.push(...v);
    evs.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    const tape = tapeRows.get(m.month) ?? null;
    const monthLabels = idx?.byMonth.get(m.month) ?? [];
    // What the month's own rows did that no tape column carries, read off the history, not off the page's text.
    const hidden: string[] = [];
    if (tape) {
      const inMonth = (d: string) => monthOf(d) === m.month;
      if (life.transfer_in_on && inMonth(life.transfer_in_on))
        hidden.push(
          life.boarded.terms.escrowed
            ? "The transfer itself: the first row simply appears."
            : "The transfer, and that the loan boarded non-escrowed: no column carries an escrow flag. The signs are a T&I of 0.00 beside an escrow balance, and in the months after, a balance that never moves.",
        );
      for (const f of life.fees.filter((x) => x.servicer === "us" && inMonth(x.assessed_on)))
        hidden.push(`The ${usd(f.amount)} late charge: no column carries a late charge or a fee.`);
      for (const r of life.late_charge_runs.filter((x) => x.servicer === "us" && inMonth(x.on)))
        if (unpaidAtRun(r))
          hidden.push("That the late-charge run charged nothing on an unpaid installment.");
      if (life.receipts.some((r) => r.servicer === "us" && inMonth(r.on) && r.to_suspense > 0n))
        hidden.push(
          "That the payment went to suspense: there is no suspense column, and Cash Flow Month 12 shows only that money arrived.",
        );
      if (life.analyses.some((a) => a.servicer === "us" && inMonth(a.as_of)))
        hidden.push(
          "The escrow analysis and what it found: the tape shows only the T&I payment it sets, from the month-end when an installment it applies to is next due.",
        );
      if (life.contacts.some((c) => c.servicer === "us" && inMonth(c.on)))
        hidden.push("The calls and what was said: only Srv Last Contact Date moves.");
      if (
        life.behavior.some((b) => b.servicer === "us" && b.kind === "promise_made" && inMonth(b.on))
      )
        hidden.push("The promise to pay and its date.");
      if (
        life.disbursements.some(
          (d) =>
            d.servicer === "us" &&
            d.kind === "bill" &&
            d.line !== "mi_borrower_paid" &&
            inMonth(d.on),
        )
      )
        hidden.push("Which bills escrow paid: only the escrow balance moves.");
      // The twin: what should have happened and did not leaves no trace on a tape at all.
      for (const e of evs.filter((x) => x.ghost && x.kind === "disbursement" && !x.quiet))
        hidden.push(
          `That the ${usd(e.amount ?? 0)} ${e.text.replace(/^Not paid: the /, "")} due ${dayName(e.on)} was never paid: the tape carries no bill, and the escrow balance does not move.`,
        );
      if (evs.some((x) => x.ghost && x.kind === "analysis"))
        hidden.push(
          "That no escrow analysis ran: a tape cannot show what did not happen, and T&I stays at 0.00.",
        );
      // A cent of rounding moves the escrow share most months; a change of a dollar or more is a new payment.
      if (prevTi !== null && Math.abs(Number(tape[TI]) - Number(prevTi)) >= 1)
        hidden.push(
          `Why the T&I payment changed, from ${prevTi} to ${tape[TI]}: the tape gives no reason.`,
        );
      prevTi = tape[TI]!;
    }
    return {
      month: m.month,
      servicer: m.servicer,
      status: m.status,
      mba: m.mba_status,
      days_delinquent: m.days_delinquent,
      upb: n(m.upb),
      escrow_balance: n(m.escrow_balance),
      suspense: n(m.suspense),
      late_charges_due: n(m.late_charges_due),
      pi: n(m.pi),
      escrow_payment: n(m.escrow_payment),
      next_due: m.next_due,
      lpi: m.lpi,
      metro2_status: m.metro2.account_status,
      events: evs,
      labels: {
        count: monthLabels.length,
        fields: monthLabels
          .filter(
            (l) =>
              (l.file_or_table === "month_ends" || l.file_or_table === "metro2") &&
              l.row === m.month,
          )
          .map((l) => ({
            defect: l.defect_id,
            table: l.file_or_table,
            field: l.field,
            true_value: labelValue(l.file_or_table, l.field, l.true_value),
            planted_value: labelValue(l.file_or_table, l.field, l.planted_value),
          })),
      },
      tape,
      hidden,
    };
  });

  const tables = new Map<string, number>();
  for (const l of name === "defective" ? labels : []) {
    const k = `${l.defect_id}|${l.file_or_table}`;
    tables.set(k, (tables.get(k) ?? 0) + 1);
  }
  return {
    name,
    boarded: {
      on: life.boarded.on,
      escrowed: life.boarded.terms.escrowed,
      cap_cents:
        life.boarded.terms.late_charge_cap_cents === null
          ? null
          : n(life.boarded.terms.late_charge_cap_cents),
    },
    months,
    label_count: name === "defective" ? labels.length : 0,
    label_tables: [...tables]
      .map(([k, count]) => {
        const [defect, table] = k.split("|") as [string, string];
        return { defect, table, count };
      })
      .sort((a, b) => b.count - a.count || (a.table < b.table ? -1 : 1)),
  };
}

/* ── the moments ─────────────────────────────────────────────────────────── */

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A solver run to its submission through the environment's own tools, counting the calls. */
function reference(
  steps: Parameters<typeof solveNow>[0],
  payload: Record<string, unknown>,
  execute: (name: string, input: unknown) => string,
): { raw: Json; calls: number } {
  let calls = 0;
  const raw = solveNow(steps, JSON.parse(JSON.stringify(payload)) as Json, (name, input) => {
    calls += 1;
    return execute(name, input);
  });
  return { raw, calls };
}

/** A graded field's expected value, for a reader. */
function shownValue(field: string, v: string): string {
  if (/^-?\d+$/.test(v) && (/cents/.test(field) || field === "refund_due_cents"))
    return usd(BigInt(v));
  if (v.startsWith("[") || v.startsWith("{")) {
    try {
      const x = JSON.parse(v) as unknown;
      if (Array.isArray(x))
        return x.length === 0
          ? "none"
          : x
              .map((e) =>
                typeof e === "object" && e
                  ? Object.entries(e as Record<string, unknown>)
                      .map(([k, y]) =>
                        typeof y === "string" && /^-?\d+$/.test(y) && /cents/.test(k)
                          ? `${k.replace(/_cents$/, "").replace(/_/g, " ")} ${usd(BigInt(y))}`
                          : `${k.replace(/_/g, " ")} ${String(y)}`,
                      )
                      .join(", ")
                  : String(e),
              )
              .join("; ");
    } catch {
      return v;
    }
  }
  if (field === "anomalies") return v === "" ? "none" : v.split(",").map(anomalyName).join(", ");
  if (v === '""') return "(blank)";
  return v === "null" ? "none" : v.replace(/^"(.*)"$/, "$1");
}

function gradedOf(fields: readonly FieldGrade[]): PageGraded[] {
  return fields.map((f) => ({
    field: f.field,
    expected: f.expected,
    shown: shownValue(f.field, f.expected),
    got: f.got,
    ok: f.ok,
  }));
}

const firstLine = (rendered: string) => rendered.split("\n")[0]!;

/** A transfer package's files, for a reader. */
const FILE_NAME: Readonly<Record<string, string>> = {
  "lossmit_file.csv": "loss mitigation",
  "fc_bk_file.csv": "foreclosure and bankruptcy",
  "consents_file.csv": "consents",
  "images_manifest.csv": "images",
  "trial_balance.csv": "trial balance",
  "fnma_position.csv": "Fannie Mae position",
  "mers_lookup.csv": "MERS",
  "fair_lending.csv": "fair-lending",
};

function triagePosed(task: BoardingTask, why: string): PagePosed {
  const env = boardingTriage;
  const payload = boardingPayload(task);
  const { raw, calls } = reference(boardingSteps, payload, (name, input) =>
    executeBoardingTool(name, input, task),
  );
  const parsed = env.parseAnswer(raw);
  if (!parsed.ok)
    throw new Error(`boarding-triage: the reference's answer does not parse: ${parsed.error}`);
  const grade = env.grade(task, parsed.answer);
  const files = payload["files"] as Record<string, Record<string, string>[]>;
  const tape = files["boarding_tape.final.csv"]![0]!;
  const planted = new Set(task.labels.map((l) => l.field));
  const cell = (k: string) => ({
    label: k,
    value: tape[k] === "" ? "(blank)" : tape[k]!,
    ...(planted.has(k) ? { flag: true } : {}),
  });
  const statements = parseCsv(task.files[CORRESPONDENCE_FILE]).filter(
    (r) => r["kind"] === "periodic_statement",
  );
  const latest = statements.reduce((a, b) => (b["sent_on"]! > a["sent_on"]! ? b : a));
  const history = parseCsv(task.files["payment_history.csv"]);
  const unpaid = history.find((h) => !h["received_on"]);
  const answer = parsed.answer as TriageAnswer;
  // The files the payload shows whole that this card does not, and the files it never shows.
  const SHOWN = ["boarding_tape.final.csv", "escrow_history.csv", "escrow_analysis.csv"];
  const whole = Object.keys(files).filter((f) => !SHOWN.includes(f));
  const restricted = Object.keys(task.files).filter(
    (f) => !(f in files) && f !== "payment_history.csv" && f !== CORRESPONDENCE_FILE,
  );
  return {
    posed: true,
    task_id: task.id,
    opening: firstLine(env.render(task)),
    prompt_chars: env.render(task).length,
    rulebook_words: words(env.system),
    tools: env.tools.map((t) => t.name),
    shown: [
      {
        heading: "The final tape, the cells the checks read (boarding_tape.final.csv)",
        facts: [
          "escrowed",
          "escrow_payment",
          "escrow_balance",
          "mi_flag",
          "pi_payment",
          "late_charge_pct",
          "late_charge_grace_days",
          "late_charge_max",
          "next_due_date",
          "upb",
        ].map(cell),
      },
      {
        heading: "The escrow files, shown whole",
        facts: [
          ...files["escrow_history.csv"]!.map((r) => ({
            label: `escrow_history: ${r["line_type"]}`,
            value: `${r["annual_amount"]} a year, next due ${r["next_due_date"]}`,
          })),
          ...files["escrow_analysis.csv"]!.map((r) => ({
            label: "escrow_analysis",
            value: `last analysis ${r["last_analysis_date"]}, balance ${r["escrow_balance"]}`,
          })),
        ],
      },
      {
        heading: "Read with read_file",
        facts: [
          {
            label: `correspondence_file: the latest of ${statements.length} periodic statements`,
            value: `sent ${latest["sent_on"]}, bills ${latest["due_date"]}: P&I ${latest["pi"]}, late fee ${latest["late_fee"]}`,
            ...(planted.has("late_charge_max") ? { flag: true } : {}),
          },
          {
            label: `payment_history: ${history.length} installments`,
            value: unpaid
              ? `oldest unpaid: ${unpaid["due_date"]}, scheduled ${unpaid["scheduled_amount"]}`
              : "none unpaid",
          },
        ],
      },
    ],
    elided: `Left out here: the tape's other ${Object.keys(tape).length - 10} cells, ${plural(whole.length, "more short file")} the model sees whole (${whole.map((f) => FILE_NAME[f] ?? f).join(", ")}), and the rulebook of ${words(env.system).toLocaleString("en-US")} words.${restricted.length ? ` The ${restricted.map((f) => FILE_NAME[f] ?? f).join(" and ")} ${restricted.length === 1 ? "file is" : "files are"} restricted and not shown.` : ""}`,
    answer:
      answer.findings.length === 0
        ? [{ label: "Findings", value: "none: the loan is passed as it is" }]
        : answer.findings.map((f) => ({
            label: `${f.file} ${f.field}`,
            value: `says ${f.says === "" || f.says === null ? "(blank)" : JSON.stringify(f.says)}, truth ${f.truth === null ? "null" : JSON.stringify(f.truth)}: ${f.handling.replace(/_/g, " ")}`,
          })),
    answer_raw: raw,
    graded: gradedOf(grade.fields),
    pass: grade.pass,
    tool_calls: calls,
    verdict: boardingVerdict(task),
    arm: null,
    why,
  };
}

function catchupPosed(task: CatchupTask, why: string): PagePosed {
  const env = catchupPosting;
  const { raw, calls } = reference(catchupSteps, catchupPayload(task), executeCatchupTool);
  const parsed = env.parseAnswer(raw);
  if (!parsed.ok)
    throw new Error(`catchup-posting: the reference's answer does not parse: ${parsed.error}`);
  const grade = env.grade(task, parsed.answer);
  const a = parsed.answer as CatchupAnswer;
  const terms = (t: CatchupTask["note"]["late_charge"]) =>
    `${t.pct}% of P&I after ${t.grace_days} days' grace, cap ${t.cap_cents === null ? "none" : usd(t.cap_cents)}`;
  const open = task.loan.installments.filter((i) => i.status === "due");
  return {
    posed: true,
    task_id: task.id,
    opening: firstLine(env.render(task)),
    prompt_chars: env.render(task).length,
    rulebook_words: words(env.system),
    tools: env.tools.map((t) => t.name),
    shown: [
      {
        heading: "The receipt and the late-charge terms",
        facts: [
          {
            label: "Receipt",
            value: `${usd(task.receipt.amount_cents)} on ${task.receipt.received_on}`,
          },
          { label: "The note", value: terms(task.note.late_charge) },
          {
            label: "What the system boarded",
            value: terms(task.servicing.late_charge),
            ...(task.servicing.late_charge.cap_cents !== task.note.late_charge.cap_cents
              ? { flag: true }
              : {}),
          },
        ],
      },
      {
        heading: "The loan as the system shows it that morning",
        facts: [
          { label: "Balance", value: usd(task.loan.upb_cents) },
          { label: "Paid through", value: task.loan.lpi_date ?? "none" },
          { label: "Suspense", value: usd(task.loan.suspense_cents) },
          {
            label: "Late charges due (the system's)",
            value: usd(task.loan.late_charges_due_cents),
          },
          {
            label: `Open installments (${open.length})`,
            value: open
              .map((i) => `${i.due_date}: ${usd(i.pi_cents)} P&I + ${usd(i.escrow_cents)} escrow`)
              .join("; "),
          },
          ...task.late_charges.map((f) => ({
            label: `Late charge on ${f.installment_due_date}`,
            value: `${usd(f.amount_cents)} assessed ${f.assessed_on}, ${usd(f.collected_cents)} collected, on P&I of ${usd(f.installment_pi_cents)}`,
            ...(f.amount_cents >
            lateChargeAmount(
              f.installment_pi_cents,
              task.note.late_charge.pct,
              task.note.late_charge.cap_cents,
            )
              ? { flag: true }
              : {}),
          })),
        ],
      },
    ],
    elided: `Left out here: the ledger's other ${plural(task.loan.installments.length - open.length, "installment")}, ${plural(task.history.receipts.length, "payment")} and ${plural(task.history.month_ends.length, "month-end")} of history, and the rulebook of ${words(env.system).toLocaleString("en-US")} words.`,
    answer: [
      ...a.installments.map((i) => ({
        label: `Applies ${i.due_date} (${i.kind})`,
        value: `${usd(BigInt(i.interest_cents))} interest, ${usd(BigInt(i.principal_cents))} principal, ${usd(BigInt(i.escrow_cents))} escrow`,
      })),
      ...a.late_charges.map((x) => ({
        label: `Late charge on ${x.installment_due_date}, held to the note`,
        value: usd(BigInt(x.allowed_cents)),
      })),
      { label: "Late charge paid", value: usd(BigInt(a.late_charge_paid_cents)) },
      { label: "To suspense", value: usd(BigInt(a.to_suspense_cents)) },
      { label: "Refund due", value: usd(BigInt(a.refund_due_cents)) },
      { label: "Late charges still due", value: usd(BigInt(a.late_charges_due_after_cents)) },
      { label: "Balance after", value: usd(BigInt(a.upb_after_cents)) },
      { label: "Paid through", value: a.lpi_after ?? "none" },
      { label: "Current after posting", value: a.current_after_posting ? "yes" : "no" },
    ],
    answer_raw: raw,
    graded: gradedOf(grade.fields),
    pass: grade.pass,
    tool_calls: calls,
    verdict: catchupVerdict(task),
    arm: CATCHUP_ARMS.find((x) => catchupOnArm(x, task)) ?? null,
    why,
  };
}

/**
 * The escrow payment on the loan's terms for the first installment due after an analysis, read off the history's own
 * rows rather than the moment, and what that installment bills: last year's analysis's payment through the twelve
 * months it sets, its base after them, or the first year's base before any analysis.
 */
function escrowToday(life: LoanLife, a: AnalysisRow): { terms: Cents; billed: Cents } {
  const next = life.installments.find((i) => i.due > a.as_of)!;
  const prior = life.analyses.filter((x) => x.as_of < a.as_of && x.effective <= next.due).at(-1);
  const terms = !prior
    ? next.escrow
    : next.due < addMonths(prior.effective, 12)
      ? prior.new_payment
      : prior.base_payment;
  return { terms, billed: next.escrow };
}

function escrowPosed(
  task: EscrowReviewTask,
  why: string,
  today: { readonly terms: Cents; readonly billed: Cents },
): PagePosed {
  const env = escrowReview;
  // escrow-review 1.1.0's payment today is the one on the loan's terms for the next installment, a running spread at
  // its level amount (life 1.2.0); the build stops if not.
  if (today.terms !== task.current_escrow_payment_cents)
    throw new Error(
      `escrow-review: the payment today, ${task.current_escrow_payment_cents}, is not the ${today.terms} on the loan's terms for the next installment`,
    );
  const { raw, calls } = reference(escrowReviewSteps, reviewPayload(task), executeReviewTool);
  const parsed = env.parseAnswer(raw);
  if (!parsed.ok)
    throw new Error(`escrow-review: the reference's answer does not parse: ${parsed.error}`);
  const grade = env.grade(task, parsed.answer);
  const a = parsed.answer as EscrowReviewAnswer;
  return {
    posed: true,
    task_id: task.id,
    opening: firstLine(env.render(task)),
    prompt_chars: env.render(task).length,
    rulebook_words: words(env.system),
    tools: env.tools.map((t) => t.name),
    shown: [
      {
        heading: "The lines as the analyst has them",
        facts: task.lines.map((l) => {
          const bills = l.known_bills ?? [];
          return {
            label: `${lineName(l.line_type)} (${l.frequency})`,
            value: `last year ${usd(l.prior_year_annual_cents)}; ${
              bills.length
                ? `bills known: ${usd(bills.reduce((s, b) => s + b.amount_cents, 0n))}`
                : l.estimate_basis === "contract"
                  ? `on its contract, ${usd(l.contract_annual_cents ?? 0n)}`
                  : l.estimate_basis === "prior_year_cpi"
                    ? `estimated from last year with CPI of ${task.cpi_change_pct}%`
                    : l.estimate_basis === "prior_year"
                      ? "estimated at last year's figure"
                      : `estimated (${l.estimate_basis.replace(/_/g, " ")})`
            }`,
          };
        }),
      },
      {
        heading: "The account on the run date",
        facts: [
          { label: "Escrow balance", value: usd(task.ledger.balance_cents) },
          {
            label: `Escrow shares still to post (${task.ledger.deposits.length})`,
            value: usd(task.ledger.deposits.reduce((s, d) => s + d.amount_cents, 0n)),
          },
          {
            label: `Bills still to pay before the year (${task.ledger.disbursements.length})`,
            value: usd(task.ledger.disbursements.reduce((s, d) => s + d.amount_cents, 0n)),
          },
          {
            // The task's "payment today" is the one on the loan's terms for the next installment, last year's shortage
            // or credit in it at its level amount, which is what the review triggers compare with. A spread's final
            // installment bills its rounding beside it.
            label:
              "Escrow payment on the loan's terms today (the next installment's, last year's spread included)",
            value: `${usd(task.current_escrow_payment_cents)}${today.billed !== today.terms ? `; the installment bills ${usd(today.billed)}, the spread's final rounding` : ""}`,
          },
          { label: "Days delinquent", value: String(task.regx_days_delinquent) },
          {
            label: "Cushion",
            value: `${task.cushion.policy_months} months (the servicer's policy)`,
          },
        ],
      },
    ],
    elided: `Left out here: ${plural(task.history.analyses.length, "earlier analysis", "earlier analyses")}, ${plural(task.history.disbursements.length, "disbursement")} of the last two years and ${plural(task.history.month_ends.length, "month-end")}, and the rulebook of ${words(env.system).toLocaleString("en-US")} words.`,
    answer: [
      { label: "Annual total", value: usd(BigInt(a.annual_cents)) },
      { label: "Base payment", value: usd(BigInt(a.base_payment_cents)) },
      { label: "Target balance at the start", value: usd(BigInt(a.target_at_start_cents)) },
      { label: "Projected actual balance", value: usd(BigInt(a.projected_actual_cents)) },
      { label: "Decision", value: a.decision },
      ...(a.shortage_cents ? [{ label: "Shortage", value: usd(BigInt(a.shortage_cents)) }] : []),
      ...(a.deficiency_cents
        ? [{ label: "Deficiency", value: usd(BigInt(a.deficiency_cents)) }]
        : []),
      ...(a.surplus_cents ? [{ label: "Surplus", value: usd(BigInt(a.surplus_cents)) }] : []),
      ...(a.repayment_months !== null
        ? [{ label: "Spread over", value: plural(a.repayment_months, "month") }]
        : []),
      { label: "New escrow payment", value: usd(BigInt(a.new_payment_cents)) },
      { label: "Effective", value: a.effective_on },
      {
        label: "Triggers",
        value: a.anomalies.length ? a.anomalies.map(anomalyName).join(", ") : "none",
      },
      { label: "The flag stands", value: a.flag_stands ? "yes" : "no" },
    ],
    answer_raw: raw,
    graded: gradedOf(grade.fields),
    pass: grade.pass,
    tool_calls: calls,
    verdict: reviewVerdict(task),
    arm: null,
    why,
  };
}

/* ── what the defects cost on the twin ──────────────────────────────────── */

function harmOf(clean: LoanLife, twin: LoanLife): PageHarm {
  const note = twin.draw.late_charge;
  if (note.cap_cents === null) throw new Error("the demo loan's note has no cap");
  const piOf = new Map(twin.installments.map((i) => [i.due, i.pi]));
  const cleanFee = new Map(clean.fees.map((f) => [f.due, f]));
  const rows = twin.fees
    .filter((f) => f.servicer === "us")
    .map((f) => {
      const allowed = lateChargeAmount(piOf.get(f.due)!, note.pct, note.cap_cents);
      // The clean history's own run charged what the note allows: the engine agrees with itself.
      if (cleanFee.get(f.due)?.amount !== allowed)
        throw new Error(
          `the clean history's charge on ${f.due} is not lateChargeAmount's ${allowed}`,
        );
      const refund = f.collected > allowed ? f.collected - allowed : 0n;
      return {
        installment_due: f.due,
        assessed_on: f.assessed_on,
        charged: n(f.amount),
        allowed: n(allowed),
        over: n(f.amount - allowed),
        collected: n(f.collected),
        collected_on: f.collected_on,
        refund: n(refund),
      };
    });

  const key = (d: LoanLife["disbursements"][number]) => `${d.on}|${d.line}|${d.kind}|${d.amount}`;
  const here = new Set(twin.disbursements.map(key));
  const unpaid = clean.disbursements.filter(
    (d) => d.kind === "bill" && d.servicer === "us" && !here.has(key(d)),
  );
  const byLine = new Map<string, typeof unpaid>();
  for (const d of unpaid) byLine.set(d.line, [...(byLine.get(d.line) ?? []), d]);
  const lines = [...byLine].map(([line, ds]) => ({
    line,
    label: lineName(line),
    bills: ds.length,
    total: n(ds.reduce((s, d) => s + d.amount, 0n)),
    first_due: ds[0]!.on,
    last_due: ds.at(-1)!.on,
  }));
  const cleanInst = new Map(clean.installments.map((i) => [i.due, i]));
  const notBilled = twin.installments.filter(
    (i) => i.due >= twin.boarded.on && (cleanInst.get(i.due)?.escrow ?? 0n) > i.escrow,
  );
  const first = (f: (d: (typeof unpaid)[number]) => boolean) => {
    const d = unpaid.find(f);
    return d ? { on: d.on, amount: n(d.amount) } : null;
  };
  const hazard = first((d) => d.line === "hazard");
  return {
    d03: {
      pct: note.pct,
      cap_cents: n(note.cap_cents),
      rows,
      over_total: rows.reduce((s, r) => s + r.over, 0),
      refund_total: rows.reduce((s, r) => s + r.refund, 0),
    },
    d31: {
      lines,
      bills: unpaid.length,
      total: n(unpaid.reduce((s, d) => s + d.amount, 0n)),
      tax_total: n(
        unpaid.filter((d) => d.line.startsWith("tax")).reduce((s, d) => s + d.amount, 0n),
      ),
      first_tax: first((d) => d.line.startsWith("tax")),
      first_hazard: hazard && {
        ...hazard,
        days_after_boarding: daysBetween(twin.boarded.on, hazard.on),
      },
      escrow_not_billed: {
        installments: notBilled.length,
        total: n(notBilled.reduce((s, i) => s + (cleanInst.get(i.due)!.escrow - i.escrow), 0n)),
      },
      payoff_refund: {
        clean: n(clean.payoff?.escrow_refund ?? 0n),
        defective: n(twin.payoff?.escrow_refund ?? 0n),
      },
      penalty: null,
      penalty_note:
        "Not computed. No engine here prices a county's late-payment penalty or interest, and the life generator models no tax sale, lapse or force-placed policy, so a figure here would be invented. The bills above are what went unpaid.",
    },
  };
}

/* ── the page ────────────────────────────────────────────────────────────── */

const LANE_KEYS = [
  "as_of_date",
  "next_due_date",
  "upb_cents",
  "pi_cents",
  "ti_cents",
  "total_due_cents",
  "escrow_balance_cents",
  "last_payment_date",
  "cash_flow_month_12",
  "pay_string",
  "mba_delinquency_status",
  "last_contact_date",
  "pmi_flag",
  "servicing_status",
] as const;

export function demoPageData(o: DemoPageOptions): DemoPageData {
  const cal = defaultCalibration();
  const observed = { clean: new Map<string, LifeMoment>(), twin: new Map<string, LifeMoment>() };
  const res = generate(DEMO_SEED, DEMO_SCENARIO, {
    calibration: cal,
    defects: DEMO_DEFECTS.map((id) => ({ id, loans: [0] })),
    observe: (_loan, history, m) =>
      observed[history].set(m.kind === "receipt" ? m.receipt_id : `analysis-${m.year}`, m),
  });
  const clean = res.clean.loans[0]!;
  const twin = res.defective!.loans[0]!;

  // The same loan `demoLoan()` draws, and the same labels: the page shows the demo the environments pose.
  const demo = demoLoan(cal);
  if (
    toJsonLine(demo.clean) !== toJsonLine(clean) ||
    toJsonLine(demo.twins.defective) !== toJsonLine(twin) ||
    toJsonLine(demo.labels.defective) !== toJsonLine(res.labels)
  )
    throw new Error("the page's run of the demo scenario is not demoLoan()'s");

  const promiseEvent = DEMO_SCENARIO.events!.find((e) => e.kind === "promise_to_pay");
  const promise =
    promiseEvent &&
    promiseEvent.kind === "promise_to_pay" &&
    "on" in promiseEvent &&
    promiseEvent.pay_on
      ? { made: promiseEvent.on, pay_on: promiseEvent.pay_on }
      : null;

  // The note's late-charge terms, as the copy below states them.
  const noteTerms = clean.draw.late_charge;
  if (noteTerms.cap_cents === null) throw new Error("the demo loan's note has no cap");
  const cap = usd(noteTerms.cap_cents);

  const twins = {
    clean: twinView("clean", clean, res.clean, clean, [], promise),
    defective: twinView("defective", twin, res.defective!, clean, res.labels, promise),
  };

  /* Moment 1: boarding triage, the environment's own spec cases on the demo's packages. */
  const spec = boardingSpecTasks();
  const triage: PageMoment = {
    id: "triage",
    title: "Boarding triage",
    on: DEMO_TRANSFER_DATE,
    env: { name: boardingTriage.name, version: boardingTriage.version },
    summary:
      "The transfer package arrives before the loan boards. The model reviews it for what the servicing app's gate cannot see, names each defect, and says what to do about it.",
    twins: {
      clean: triagePosed(
        spec[0]!,
        "The clean package: nothing is wrong, and the right answer is to pass the loan as it is.",
      ),
      defective: triagePosed(
        spec[3]!,
        `The package as it transfers: the escrow cell says Yes, which the decoder would read as No, and the note's ${cap} cap on a late charge is not on the tape. The statements quote the capped fee.`,
      ),
    },
  };

  /* Moment 2: the catch-up, read off each history the way catchup-posting reads a drawn task. */
  const missed = clean.behavior.find((b) => b.kind === "missed" && b.servicer === "us")!.due!;
  const catchupOf = (name: TwinName): PagePosed => {
    const life = name === "clean" ? clean : twin;
    const at = life.receipts.findIndex(
      (r) =>
        r.on > missed &&
        r.servicer === "us" &&
        r.channel === "borrower" &&
        (r.mode === "promise" || r.mode === "cure" || r.mode === "oldest"),
    );
    const row = life.receipts[at]!;
    const m = observed[name === "clean" ? "clean" : "twin"].get(row.id);
    if (!m || m.kind !== "receipt") throw new Error(`no receipt moment for ${row.id}`);
    const rates = new Set(row.installments.map((x) => x.rate_pct));
    const task = catchupTaskAt(
      {
        id: `${catchupPosting.name}/${catchupPosting.version}/demo/${name}`,
        split: "spec",
        suite_seed: 0,
        index: name === "clean" ? 0 : 1,
      },
      life,
      m,
      [...rates][0]!,
    );
    // The generator's own filters: a moment it would not pose is not shown.
    if (
      rates.size !== 1 ||
      !catchupMomentInScope(m, life) ||
      !historyInScope(life, at) ||
      !catchupInScope(task) ||
      !catchupFairToGrade(task) ||
      !CATCHUP_ARMS.some((x) => catchupOnArm(x, task))
    )
      throw new Error(`the demo's ${name} catch-up is not one catchup-posting would pose`);
    return catchupPosed(
      task,
      name === "clean"
        ? `The cap boarded, so the system already charged the ${cap} the note allows. The model holds every charge to the note, posts the receipt and says the loan is current.`
        : `The cap never boarded, so the system charged ${noteTerms.pct}% of P&I. The model must hold the charge to the note's ${cap}; what the borrower sent above it goes to suspense. catchup-posting plants D-03 alone; this twin carries D-42 too, so its installments carry no escrow. Its filters pass it all the same, on its "${CATCHUP_ARMS.find((x) => catchupOnArm(x, task)) ?? "no"}" arm.`,
    );
  };
  const catchup: PageMoment = {
    id: "catchup",
    title: "Posting the catch-up payment",
    on: clean.receipts.find((r) => r.on > missed && r.mode === "promise")?.on ?? missed,
    env: { name: catchupPosting.name, version: catchupPosting.version },
    summary:
      "March's payment was missed and a late charge assessed. On the promised day the borrower sends everything owed. The model posts it: the split, the late charge held to the note, any refund, and whether the loan is current.",
    twins: { clean: catchupOf("clean"), defective: catchupOf("defective") },
  };

  /* Moment 3: the flagged analysis, as escrow-review reads one. */
  const flagged = clean.analyses.find((a) => a.servicer === "us" && a.anomalies.length > 0)!;
  const am = observed.clean.get(`analysis-${flagged.year}`);
  if (!am || am.kind !== "analysis") throw new Error("no moment for the flagged analysis");
  const reviewTask = reviewTaskAt(
    {
      id: `${escrowReview.name}/${escrowReview.version}/demo/clean`,
      split: "spec",
      suite_seed: 0,
      index: 0,
    },
    clean,
    am,
  );
  if (!agreesWithHistory(reviewTask, flagged) || !reviewFairToGrade(reviewTask))
    throw new Error("the demo's flagged analysis is not one escrow-review would pose");
  const escrow: PageMoment = {
    id: "escrow",
    title: "Reviewing the flagged escrow analysis",
    on: flagged.as_of,
    env: { name: escrowReview.name, version: escrowReview.version },
    summary:
      "The county reassessed the house and the insurer raised the premium. The annual analysis finds a shortage and the payment jumps, so the servicing app holds it for review. The model checks the analysis and says whether the flag stands.",
    twins: {
      clean: escrowPosed(
        reviewTask,
        `The payment rises by more than a quarter and by more than $150, so the hold stands. On the tape the new payment appears in the row for ${fullMonth(addMonths(flagged.effective, -1))}, when ${MONTH[Number(flagged.effective.slice(5, 7)) - 1]}'s installment is next due, with no reason given.`,
        escrowToday(clean, flagged),
      ),
      defective: {
        posed: false,
        why: `Not posed. The loan boarded non-escrowed (D-42 read as D-31), so the system has no escrow account and runs no analysis. The bills it should have paid are under "What missing the defects costs".`,
      },
    },
  };

  const harm = harmOf(clean, twin);

  /* The book. */
  const bookCal = loadCalibration({ file: o.calibrationFile });
  if (bookCal.warnings.length > 0)
    throw new Error(`calibration.json read with warnings: ${bookCal.warnings.join("; ")}`);
  const book = bookPanel({
    calibration: bookCal,
    file: o.calibrationFile,
    acceptance: o.acceptance,
    loans: o.bookLoans ?? 1_000,
    seed: o.bookSeed ?? "demo-book-1",
  });

  const d = clean.draw;
  const analysisRise = clean.analyses.find((a) => a.year === flagged.year)!;
  const mi = clean.pmi.find((p) => p.status === "terminated");
  return {
    page_version: DEMO_PAGE_VERSION,
    life_version: LIFE_VERSION,
    tape: { profile: TAPE_PROFILE, version: TAPE_VERSION },
    demo_calibration: { version: cal.version, path: null },
    envs: [triage.env, catchup.env, escrow.env],
    loan: {
      id: clean.loan_id,
      servicer_loan_number: d.servicer_loan_number,
      prior_servicer_loan_number: d.prior_servicer_loan_number,
      borrowers: d.parties.map((p) => `${p.given_name} ${p.surname}`),
      city: d.property.city,
      state: d.property.state,
      note_date: d.note_date,
      first_due: d.first_due,
      maturity: d.maturity,
      orig_upb: n(d.orig_upb_cents),
      value: n(d.value_cents),
      ltv_pct: d.ltv_pct,
      note_rate_pct: d.note_rate_pct,
      term_months: d.term_months,
      pi: n(d.initial_pi_cents),
      mi: d.mi
        ? { annual: n(d.mi.annual_cents), rate_pct: d.mi.rate_pct, coverage_pct: d.mi.coverage_pct }
        : null,
      late_charge: {
        pct: d.late_charge.pct,
        grace_days: d.late_charge.grace_days,
        cap_cents: d.late_charge.cap_cents === null ? null : n(d.late_charge.cap_cents),
      },
      transfer_on: DEMO_TRANSFER_DATE,
      defects: [...DEMO_DEFECTS],
    },
    story: [
      { on: d.first_due, text: "First payment, to another servicer", moment: null },
      { on: DEMO_TRANSFER_DATE, text: "Servicing transfers to us", moment: "triage" },
      { on: missed, text: "March's payment is missed", moment: null },
      { on: catchup.on, text: "The borrower catches up", moment: "catchup" },
      { on: flagged.as_of, text: "The escrow analysis is flagged", moment: "escrow" },
      { on: analysisRise.effective, text: "The payment rises", moment: null },
      ...(mi ? [{ on: mi.on, text: "Mortgage insurance ends", moment: null }] : []),
      ...(clean.payoff ? [{ on: clean.payoff.on, text: "Paid off", moment: null }] : []),
    ],
    tape_headers: [...TAPE_HEADERS],
    tape_lane: LANE_KEYS.map(tapeColumnIndex),
    twins,
    moments: [triage, catchup, escrow],
    harm,
    book,
  };
}
