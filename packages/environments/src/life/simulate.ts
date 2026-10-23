/**
 * One loan's life, month by month, over the ported engines.
 *
 * The engines decide: cashiering allocation and late charges
 * (`payments/ported`), escrow analysis (`escrow/ported`), the ARM change by
 * both engines (`arm/ported`), mortgage-insurance termination
 * (`pmi/ported`), the payoff quote (`payoff/ported`) and the Metro 2 record
 * (`metro2/ported`). None of them keeps a loan's state from one call to the
 * next, so this module carries everything they do not:
 *   - the borrower: what they pay, when, and what they do when behind;
 *   - the escrow balance between analyses and each year's bills;
 *   - the payment schedule each analysis or ARM change produces;
 *   - the rate `allocate` reads: it charges every installment one payment
 *     covers at `note_rate_pct`, so a payment that spans a rate change is
 *     posted in two calls, each at its installments' own rate;
 *   - the rolling twelve months of $50-rule partials (`allocate` only ever
 *     adds to the count);
 *   - which fee a payment collected (`allocate` lowers the amount due and
 *     names no fee), marked oldest first;
 *   - the ledger Metro 2 and PMI read, which is the cashiering ledger itself:
 *     an installment is paid when cashiering satisfied it, never by a FIFO
 *     replay of the raw receipts (the two disagree wherever money went to
 *     suspense or to fees, which the prototype measured on 7,302 of 120,000
 *     month-ends);
 *   - the index feed, the boarding of a transferred loan, and the payoff
 *     (`allocate` never caps the last installment at the balance, and no
 *     engine closes a loan).
 *
 * Within a day the late-charge run comes before the day's receipts (the
 * servicing app's 00:30 convention, ops-2-7.ts:110, as payments/grader.ts
 * restates it), receipts before the day's disbursements, and the analysis
 * and the ARM change after both.
 *
 * Randomness never reads state. Each installment's behavior is drawn from a
 * stream of its own, each calendar month's contacts and hazards from
 * another, and each analysis from a third, so two runs that differ in one
 * value (the defective twin) consume the same draws and differ only where
 * that value reaches.
 */

import {
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  endOfMonth,
  parts,
  rollBack,
  rollForward,
  servicer as servicerCalendar,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import {
  computeArmAdjustment,
  indexDate,
  noticeWindow,
  scheduledUpbAfter,
  selectIndex,
  sendCheck,
  type ArmAdjustmentInput,
  type IndexObs,
} from "../arm/ported/arm.js";
import { verifyArmAdjustment } from "../arm/ported/arm-verify.js";
import {
  anomalies as escrowAnomalies,
  decide,
  effectiveDate,
  newPayment as escrowNewPayment,
  project,
  projectLines,
  settlementDepositCeiling,
  type EscrowLineInput,
} from "../escrow/ported/analysis.js";
import {
  boardingMonthReporter,
  buildSnapshot,
  deriveDelinquency,
  renderBase,
  validateSnapshot,
} from "../metro2/ported/metro2.js";
import type {
  CreditConsumer,
  CreditLoanState,
  LoanCondition,
  Metro2Snapshot,
  PriorHistory,
} from "../metro2/ported/types.js";
import {
  allocate,
  type AllocationPlan,
  type AllocationRequest,
} from "../payments/ported/allocation.js";
import {
  assessLateCharge,
  graceEndFor,
  recordFee,
  releaseSuspended,
  waiveAll,
} from "../payments/ported/latecharges.js";
import type {
  AllocationOutcome,
  Fee,
  InstallmentProjection,
  LoanCashState,
} from "../payments/ported/types.js";
import { quote } from "../payoff/ported/quote.js";
import {
  fnmaDelinquencyStatus,
  regxDaysDelinquent,
  type AppliedInstallment,
  type FnmaDelinquencyStatus,
} from "../pmi/ported/delinquency.js";
import {
  armResetVersion,
  buildSchedule,
  midpoint,
  scheduledDateForPct,
  type ScheduleVersion,
} from "../pmi/ported/schedule.js";
import {
  automaticTermination,
  pendingTriggerDate,
  rule78Applies,
} from "../pmi/ported/termination.js";
import { rngFor, type Rng } from "../rng.js";
import { EARLY_DAYS, PARTIAL_LAG_DAYS, behaviorBase, borrowerRates } from "./behavior.js";
import type { Rates } from "./calibration.js";
import type { EscrowLine, LoanDraw } from "./draw.js";
import { marketRateOn, normal, printsAround, type MarketMonth } from "./feeds.js";
import type { LoanScript, RandomToggles } from "./scenario.js";

/* ── design choices the calibration has no key for ──────────────────────── */

/** A payment short by $50 or less, which the $50 rule may apply (the prototype's rate). */
const FIFTY_SHORT_SHARE = 0.01;
/** A borrower whose area has a disaster declaration misses this many times as often, that month and the next. */
const DISASTER_MISS_MULTIPLIER = 4;
/** Payoffs: a turnover hazard that ramps over thirty months, plus a refinance hazard once the market is half a point under the note. */
const TURNOVER_MONTHLY = 0.004;
const REFI_THRESHOLD_PCT = 0.5;
const REFI_MONTHLY_PER_POINT = 0.02;
const REFI_MONTHLY_MAX = 0.03;
/** A curtailment is never more than a tenth of the balance. */
const CURTAILMENT_MAX_SHARE = 10n;
/** Contacts from a borrower who is behind come three times as often. */
const BEHIND_CONTACT_MULTIPLIER = 3;
/** A payment the prior servicer forwards reaches us 5 to 10 days after it reached them. */
const FORWARD_LAG_DAYS: readonly [number, number] = [5, 10];
/** The escrow balance is refunded this many business days after a payoff (the quote says within 20). */
const PAYOFF_REFUND_BUSINESS_DAYS = 10;

const ACTOR = { kind: "system" as const, id: "life-generator" };

/* ── the history ─────────────────────────────────────────────────────────── */

export type Servicer = "prior" | "us";
export type ReceiptMode =
  | "regular"
  | "oldest"
  | "cure"
  | "plan"
  | "promise"
  | "partial"
  | "partial_rest"
  | "short_50"
  | "curtail"
  | "stale_bill_pay"
  | "payoff"
  /** A history error's: the same draft taken twice (D-28). */
  | "duplicate"
  /** A history error's: another borrower's payment, keyed to this loan (D-25). */
  | "misposted";

export interface ReceiptRow {
  readonly id: string;
  readonly on: PlainDate;
  readonly credited_as_of: PlainDate;
  readonly amount: Cents;
  readonly mode: ReceiptMode;
  readonly channel: "borrower" | "transferor_forward" | "misposted";
  readonly servicer: Servicer;
  readonly outcome: AllocationOutcome | "payoff";
  readonly installments: readonly {
    readonly due: PlainDate;
    readonly interest: Cents;
    readonly principal: Cents;
    readonly escrow: Cents;
    readonly rate_pct: string;
    readonly kind: "contractual" | "prepaid";
    readonly fifty_rule_shortfall: Cents;
  }[];
  readonly late_charge: Cents;
  readonly curtailment: Cents;
  readonly to_suspense: Cents;
  readonly suspense_used: Cents;
  readonly upb_after: Cents;
}

export interface FeeRow {
  readonly id: string;
  readonly due: PlainDate;
  readonly assessed_on: PlainDate;
  readonly amount: Cents;
  readonly state: Fee["state"];
  readonly collected: Cents;
  readonly collected_on: PlainDate | null;
  readonly servicer: Servicer;
}

export interface LateChargeRunRow {
  readonly due: PlainDate;
  readonly on: PlainDate;
  readonly outcome: string;
  readonly reason: string | null;
  readonly amount: Cents | null;
  readonly servicer: Servicer;
}

export interface DisbursementRow {
  readonly id: string;
  readonly on: PlainDate;
  readonly line: string;
  /** `returned`: money a payee sent back into the account, written as a negative amount (a history error's, V-01). */
  readonly kind: "bill" | "refund" | "payoff_refund" | "returned";
  readonly amount: Cents;
  readonly balance_after: Cents;
  readonly servicer: Servicer;
}

export interface AnalysisRow {
  readonly year: number;
  readonly as_of: PlainDate;
  readonly year_start: PlainDate;
  readonly sent_on: PlainDate;
  readonly balance: Cents;
  readonly projected_actual: Cents;
  readonly annual: Cents;
  readonly base_payment: Cents;
  readonly target_at_start: Cents;
  readonly decision: string;
  readonly surplus: Cents | null;
  readonly shortage: Cents | null;
  readonly deficiency: Cents | null;
  readonly old_payment: Cents;
  readonly new_payment: Cents;
  readonly first_month_payment: Cents;
  readonly effective: PlainDate;
  readonly regx_days_delinquent: number;
  readonly anomalies: readonly string[];
  readonly servicer: Servicer;
}

export interface ArmChangeRow {
  readonly change: PlainDate;
  readonly first_new_payment: PlainDate;
  readonly index_date: PlainDate;
  readonly index_pct: string;
  readonly prior_rate_pct: string;
  readonly new_rate_pct: string;
  readonly bound: string;
  readonly new_pi: Cents;
  readonly expected_upb: Cents;
  readonly remaining_term_months: number;
  readonly engine_b_agrees: boolean;
  readonly discrepancy: string | null;
  readonly notice_sent_on: PlainDate;
  readonly notice_late_days: number | null;
  readonly servicer: Servicer;
}

export interface PmiRow {
  readonly on: PlainDate;
  readonly trigger: PlainDate;
  readonly status: string;
  readonly effective_on: PlainDate | null;
  readonly servicer: Servicer;
}

export interface ContactRow {
  readonly on: PlainDate;
  /** Inbound: the borrower called. Outbound: the servicer's collection call (only with the scenario's `outreach`). */
  readonly direction: "inbound" | "outbound";
  readonly reason: string;
  readonly minutes: number;
  readonly servicer: Servicer;
  /** An outbound call's outcome; an inbound call has none. */
  readonly outcome?: "no_answer" | "voicemail";
}

export interface BehaviorRow {
  readonly on: PlainDate;
  readonly kind:
    | "missed"
    | "already_paid"
    | "deferred_to_promise"
    | "promise_made"
    | "promise_kept"
    | "promise_broken"
    | "plan_started"
    | "plan_completed"
    | "plan_failed"
    | "disaster"
    | "boarded"
    | "transfer_out"
    | "payoff"
    | "stale_bill_pay";
  readonly due: PlainDate | null;
  readonly servicer: Servicer;
}

export interface InstallmentRow {
  readonly due: PlainDate;
  readonly pi: Cents;
  readonly escrow: Cents;
  readonly status: InstallmentProjection["status"];
  readonly satisfied_on: PlainDate | null;
  readonly credited_as_of: PlainDate | null;
}

export interface Metro2Month {
  readonly furnished_by: Servicer;
  /** The Base segment as `renderBase` writes it, or null when validation omitted the month. */
  readonly record: Readonly<Record<string, string>> | null;
  readonly errors: readonly string[];
  readonly account_status: string;
}

export interface MonthEnd {
  readonly month: string;
  readonly as_of: PlainDate;
  readonly servicer: Servicer;
  readonly upb: Cents;
  readonly suspense: Cents;
  readonly late_charges_due: Cents;
  readonly escrow_balance: Cents;
  readonly escrow_advance: Cents;
  readonly rate_pct: string;
  readonly pi: Cents;
  readonly escrow_payment: Cents;
  readonly next_due: PlainDate | null;
  readonly lpi: PlainDate | null;
  readonly last_payment_on: PlainDate | null;
  readonly paid_in_month: Cents;
  readonly days_delinquent: number;
  readonly mba_status: FnmaDelinquencyStatus;
  readonly amount_past_due: Cents;
  readonly status: "current" | "delinquent" | "paid_off" | "transferred";
  readonly mi_active: boolean;
  readonly plan_active: boolean;
  readonly remaining_term_months: number;
  readonly metro2: Metro2Month;
}

export interface PayoffRow {
  readonly on: PlainDate;
  readonly by_refinance: boolean;
  readonly funds: Cents;
  readonly principal: Cents;
  readonly interest: Cents;
  readonly late_charges: Cents;
  readonly suspense_credit: Cents;
  readonly escrow_advance: Cents;
  readonly escrow_refund: Cents;
  readonly per_diem: Cents;
  readonly servicer: Servicer;
}

/** The terms boarding writes onto the loan (`loan_terms`), which cashiering and escrow read. */
export interface BoardedTerms {
  readonly late_charge_pct: string;
  readonly late_charge_grace_days: number;
  readonly late_charge_cap_cents: Cents | null;
  /** `loan_terms.escrowed`: false on an escrowed loan stops the escrow account at boarding (D-31). */
  readonly escrowed: boolean;
}

/** The loan as it stood at the close of business before the transfer date: what the prior servicer hands over. */
export interface TransferSnapshot {
  /** The transfer date; every figure is as of the end of the day before it. */
  readonly on: PlainDate;
  readonly upb: Cents;
  readonly suspense: Cents;
  readonly late_charges_due: Cents;
  readonly escrow_balance: Cents;
  readonly lpi: PlainDate | null;
  /** The oldest installment unpaid, and its rate, P&I and escrow. */
  readonly next_due: PlainDate;
  readonly rate_pct: string;
  readonly pi: Cents;
  readonly escrow_payment: Cents;
  readonly last_payment_on: PlainDate | null;
  readonly mi_active: boolean;
  /** The installment ledger as it stood: every installment added so far, each with the day it was paid in full. */
  readonly installments: readonly InstallmentRow[];
}

export interface LoanLife {
  readonly loan_id: string;
  readonly draw: LoanDraw;
  readonly lines: readonly EscrowLine[];
  /** The date the loan reached us by transfer (after the window when a book boards it too old to reach us inside it), or null when it was ours from its first payment. */
  readonly transfer_in_on: PlainDate | null;
  /** When our boarding wrote its terms (the transfer date, or the note date), and what it wrote. */
  readonly boarded: { readonly on: PlainDate; readonly terms: BoardedTerms };
  /** What the prior servicer's books said at the transfer, or null when the loan was ours from its first payment. */
  readonly at_transfer: TransferSnapshot | null;
  readonly receipts: readonly ReceiptRow[];
  readonly fees: readonly FeeRow[];
  readonly late_charge_runs: readonly LateChargeRunRow[];
  readonly disbursements: readonly DisbursementRow[];
  readonly analyses: readonly AnalysisRow[];
  readonly arm_changes: readonly ArmChangeRow[];
  readonly pmi: readonly PmiRow[];
  readonly contacts: readonly ContactRow[];
  readonly behavior: readonly BehaviorRow[];
  readonly installments: readonly InstallmentRow[];
  readonly months: readonly MonthEnd[];
  readonly payoff: PayoffRow | null;
  readonly transfer_out_on: PlainDate | null;
  readonly invariants: { readonly ok: boolean; readonly notes: readonly string[] };
}

export interface SimContext {
  /** The book's stream key; every loan stream hangs off it. */
  readonly key: string;
  readonly rates: Rates;
  readonly random: RandomToggles;
  readonly months: number;
  readonly feed: readonly IndexObs[];
  readonly market: readonly MarketMonth[];
  /** The servicer's outbound collection calls (the scenario's `outreach`). */
  readonly outreach?: boolean;
}

/**
 * A moment an environment draws a task from: what an engine is about to be
 * handed, as it stands, before the engine runs. Each is a copy, so nothing an
 * observer does reaches the history.
 */
export type LifeMoment =
  | {
      readonly kind: "receipt";
      readonly receipt_id: string;
      readonly mode: ReceiptMode;
      readonly on: PlainDate;
      readonly credited_as_of: PlainDate;
      readonly amount: Cents;
      readonly curtailment: Cents;
      /** The cash state the receipt is posted against. */
      readonly state: LoanCashState;
      /** The note rate each installment in the state is charged at. */
      readonly rates: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "analysis";
      readonly year: number;
      readonly as_of: PlainDate;
      readonly year_start: PlainDate;
      readonly sent_on: PlainDate;
      /** The lines as the analyst has them, the inputs `projectLines` is handed. */
      readonly lines: readonly EscrowLineInput[];
      readonly cpi_change_pct: string;
      /** The escrow balance on the run date. */
      readonly balance: Cents;
      /** The escrow shares of the installments still to be paid before the year, assumed paid. */
      readonly deposits: readonly { readonly on: PlainDate; readonly amount: Cents }[];
      /** The bills still to be paid out before the year. */
      readonly disbursements: readonly {
        readonly on: PlainDate;
        readonly line: string;
        readonly amount: Cents;
      }[];
      readonly regx_days_delinquent: number;
      /** The escrow payment the new one replaces. */
      readonly old_payment: Cents;
    };

/**
 * An error made in the history after boarding, by a vendor or a system the
 * servicer depends on (defects.ts, the history errors). Each changes one
 * event before the engines are handed it; everything after is the engines'.
 * A row an error adds is named off the row it comes from, and a row it
 * removes keeps its id spent, so every other row of the twin keeps the id it
 * has in the clean history and the two compare row by row.
 */
export type HistoryError =
  /** A bill paid from escrow at the amount a vendor reported, not the bill's; the payee returns the excess on `returned_on`. */
  | {
      readonly kind: "bill_amount";
      readonly line: EscrowLine["line_type"];
      readonly due: PlainDate;
      readonly paid: Cents;
      readonly returned_on: PlainDate | null;
    }
  /** A bill that went to someone else and reached the servicer late: paid on `paid_on`, not on its due date. */
  | {
      readonly kind: "bill_late";
      readonly line: EscrowLine["line_type"];
      readonly due: PlainDate;
      readonly paid_on: PlainDate;
    }
  /** The receipt `receipt` drafted twice: posted again the same day, as `${receipt}-DUP`. */
  | { readonly kind: "receipt_twice"; readonly receipt: string }
  /** The receipt `receipt` keyed to another loan, `to`: never posted here. */
  | { readonly kind: "receipt_elsewhere"; readonly receipt: string; readonly to: string }
  /** Another loan's receipt keyed to this one: posted here as `id`. */
  | {
      readonly kind: "receipt_from";
      readonly id: string;
      readonly on: PlainDate;
      readonly amount: Cents;
      readonly from: string;
    };

export interface SimOverrides {
  /** What boarding writes, given the note's terms. The clean history boards the note as it is. */
  readonly boarded?: (note: BoardedTerms) => BoardedTerms;
  /** Shown each receipt before the waterfall posts it (a payoff is quoted, not posted), and each analysis before it is decided. */
  readonly observe?: (moment: LifeMoment) => void;
  /** Errors made in the history. The clean history has none. */
  readonly errors?: readonly HistoryError[];
}

/* ── the draws ───────────────────────────────────────────────────────────── */

/** One installment's behavior, drawn before anything about the loan is known. */
interface PaymentDraw {
  readonly uTiming: number;
  readonly withinDay: number;
  readonly earlyDays: number;
  readonly afterDays: number;
  readonly uMiss: number;
  readonly uCure: number;
  readonly uRoll: number;
  readonly uPartial: number;
  readonly partialShort: Cents;
  readonly partialLag: number;
  readonly uFifty: number;
  readonly fiftyShort: Cents;
  readonly uCurtail: number;
  readonly curtail: Cents;
  readonly forwardLag: number;
}

function drawPayment(r: Rng, dayWeights: readonly number[]): PaymentDraw {
  const uTiming = r.next();
  let u = r.next();
  let withinDay = 16;
  for (let k = 0; k < dayWeights.length; k++) {
    if (u < dayWeights[k]!) {
      withinDay = k + 2;
      break;
    }
    u -= dayWeights[k]!;
  }
  return {
    uTiming,
    withinDay,
    earlyDays: r.int(EARLY_DAYS[0], EARLY_DAYS[1]),
    afterDays: r.int(0, 10),
    uMiss: r.next(),
    uCure: r.next(),
    uRoll: r.next(),
    uPartial: r.next(),
    partialShort: BigInt(r.int(6_000, 80_000)),
    partialLag: r.int(PARTIAL_LAG_DAYS[0], PARTIAL_LAG_DAYS[1]),
    uFifty: r.next(),
    fiftyShort: BigInt(r.int(100, 5_000)),
    uCurtail: r.next(),
    curtail: BigInt(r.int(100, 2_000)) * 100n,
    forwardLag: r.int(FORWARD_LAG_DAYS[0], FORWARD_LAG_DAYS[1]),
  };
}

/** One calendar month's contacts and hazards. */
interface MonthDraw {
  readonly uContacts: number;
  readonly contacts: readonly {
    readonly day: number;
    readonly uReason: number;
    readonly minutes: number;
  }[];
  readonly uDisaster: number;
  readonly uPayoff: number;
  readonly uRefi: number;
  readonly payoffDay: number;
  readonly uTransferOut: number;
  readonly transferDay: number;
}

function drawMonth(r: Rng): MonthDraw {
  const uContacts = r.next();
  const contacts = [0, 1, 2].map(() => ({
    day: r.int(1, 28),
    uReason: r.next(),
    minutes: Math.exp(0.5 * normal(r) - 0.125),
  }));
  return {
    uContacts,
    contacts,
    uDisaster: r.next(),
    uPayoff: r.next(),
    uRefi: r.next(),
    payoffDay: r.int(5, 25),
    uTransferOut: r.next(),
    transferDay: r.int(1, 28),
  };
}

/** How many of up to three contacts a Poisson(λ) month has, from one uniform. */
function poissonUpTo3(u: number, lambda: number): number {
  let p = Math.exp(-lambda);
  let cdf = p;
  for (let n = 0; n < 3; n++) {
    if (u < cdf) return n;
    p *= lambda / (n + 1);
    cdf += p;
  }
  return 3;
}

/**
 * The day a payment drawn for `day` of the due month inside grace arrives.
 * Payments arrive on business days. A day off moves to the next business day
 * of the same arrival bin, else the one before it in the bin, so the book's
 * share in each bin is the calibration's; rolling forward alone would carry a
 * bin's last days into the next (a fifth of days 2 to 5 into 6 to 10). A bin
 * with no business day in it rolls forward as any payment does.
 */
export function withinGraceDay(
  due: PlainDate,
  day: number,
  bins: readonly (readonly [number, number])[],
): PlainDate {
  const on = addDays(due, day - 1);
  if (servicerCalendar.isBusinessDay(on)) return on;
  const bin = bins.find(([first, last]) => first <= day && day <= last);
  if (!bin) return on;
  for (let d = day + 1; d <= bin[1]; d++) {
    const x = addDays(due, d - 1);
    if (servicerCalendar.isBusinessDay(x)) return x;
  }
  for (let d = day - 1; d >= bin[0]; d--) {
    const x = addDays(due, d - 1);
    if (servicerCalendar.isBusinessDay(x)) return x;
  }
  return on;
}

/* ── the loan ────────────────────────────────────────────────────────────── */

type EvKind =
  | "board"
  | "plan"
  | "promise_made"
  | "pmi"
  | "run"
  | "receipt"
  | "promise_pay"
  | "payoff"
  | "transfer_out"
  | "disburse"
  | "analysis"
  | "arm";
const PRIORITY: Record<EvKind, number> = {
  board: 0,
  plan: 1,
  promise_made: 1,
  pmi: 2,
  run: 3,
  receipt: 4,
  promise_pay: 4,
  payoff: 5,
  transfer_out: 6,
  disburse: 7,
  analysis: 8,
  arm: 9,
};
interface Ev {
  readonly on: PlainDate;
  readonly kind: EvKind;
  readonly seq: number;
  readonly due?: PlainDate;
  readonly amount?: Cents;
  readonly line?: string;
  readonly refund?: boolean;
  /** A history error's: the id its row keeps (a bill paid late, an excess returned, a receipt keyed here from another loan). */
  readonly rowId?: string;
  readonly returned?: boolean;
  readonly mode?: ReceiptMode;
  readonly credited?: PlainDate;
  readonly channel?: ReceiptRow["channel"];
  readonly draws?: PaymentDraw;
  readonly year?: number;
  readonly scriptedMiss?: boolean;
  readonly byRefi?: boolean;
  readonly promise?: number;
  readonly plan?: number;
  canceled?: boolean;
}
const evLess = (a: Ev, b: Ev) =>
  a.on !== b.on
    ? a.on < b.on
    : PRIORITY[a.kind] !== PRIORITY[b.kind]
      ? PRIORITY[a.kind] < PRIORITY[b.kind]
      : a.seq < b.seq;
const byDue = (a: { due_date: PlainDate }, b: { due_date: PlainDate }) =>
  a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
const monthsBetween = (a: PlainDate, b: PlainDate) => {
  const pa = parts(a);
  const pb = parts(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
};
const pOf = (i: { pi_cents: Cents; escrow_cents: Cents }) => i.pi_cents + i.escrow_cents;
const ledgerRow = (i: InstallmentProjection): InstallmentRow => ({
  due: i.due_date,
  pi: i.pi_cents,
  escrow: i.escrow_cents,
  status: i.status,
  satisfied_on: i.satisfied_on ?? null,
  credited_as_of: i.credited_as_of ?? null,
});
const clamp01 = (x: number, hi = 1) => (x < 0 ? 0 : x > hi ? hi : x);

/**
 * Post one receipt through `allocate`, at each installment's own rate. A
 * receipt whose pool reaches past a rate change is posted in two calls: the
 * first takes exactly the installments at the earlier rate (with the open
 * suspense), the second the rest at the later one. The split happens only
 * when the pool covers an installment beyond the change, so neither call
 * takes the partial-payment path a single call would not have taken.
 *
 * The first call sees only the earlier rate's installments and no fees. When
 * suspense alone pays those installments, it takes none of the payment, and
 * what suspense holds beyond them stays in suspense for the second call, so
 * the fees are paid after every installment, as one call would pay them.
 */
export function allocateAtRates(
  s0: LoanCashState,
  req: AllocationRequest,
  rateOf: (due: PlainDate) => string,
): AllocationPlan[] {
  const plans: AllocationPlan[] = [];
  let s = s0;
  let amount = req.amount_cents;
  for (let guard = 0; guard < 64; guard++) {
    const open = s.installments.filter((i) => i.status === "due").sort(byDue);
    const r0 = open.length ? rateOf(open[0]!.due_date) : s.note_rate_pct;
    const j = open.findIndex((i) => rateOf(i.due_date) !== r0);
    let carve: Cents | null = null;
    if (j > 0 && req.designation === "unspecified") {
      const reserved = req.curtailment_cents ?? 0n;
      let pool = amount + s.suspense_unapplied_cents;
      let n = 0;
      for (const inst of open) {
        const P = pOf(inst);
        if ((inst.due_date > req.received_on ? pool - reserved : pool) < P) break;
        pool -= P;
        n++;
      }
      // n > j means the pool pays installment j too, so what the earlier rate's installments need is under `amount`.
      if (n > j) {
        let need = 0n;
        for (let k = 0; k < j; k++) need += pOf(open[k]!);
        const c = need - s.suspense_unapplied_cents;
        carve = c > 0n ? c : 0n;
      }
    }
    const id = plans.length ? `${req.payment_id}.${plans.length}` : req.payment_id;
    const at: LoanCashState = { ...s, note_rate_pct: r0 };
    if (carve === null) {
      plans.push(allocate(at, { ...req, payment_id: id, amount_cents: amount }));
      return plans;
    }
    const { curtailment_cents: _reserved, ...plain } = req;
    void _reserved;
    const later = new Set(open.slice(j));
    const p = allocate(
      {
        ...at,
        installments: s.installments.filter((i) => !later.has(i)),
        late_charges_due_cents: 0n,
        nsf_fees_due_cents: 0n,
        other_fees_due_cents: 0n,
      },
      { ...plain, payment_id: id, amount_cents: carve },
    );
    plans.push(p);
    s = {
      ...p.next,
      installments: [...p.next.installments, ...later].sort(byDue),
      late_charges_due_cents: s.late_charges_due_cents,
      nsf_fees_due_cents: s.nsf_fees_due_cents,
      other_fees_due_cents: s.other_fees_due_cents,
    };
    amount -= carve;
  }
  throw new Error(`${req.payment_id}: the rate split did not converge`);
}

/** One loan's history over the context's months from its first payment. */
export function simulateLoan(
  ctx: SimContext,
  d: LoanDraw,
  lines: readonly EscrowLine[],
  script: LoanScript,
  transferInOn: PlainDate | null,
  ov: SimOverrides = {},
): LoanLife {
  const R = ctx.rates;
  const rnd = ctx.random;
  const loanKey = `${ctx.key}/loan/${d.index}`;
  const months = ctx.months;
  const windowEnd = endOfMonth(addMonths(d.first_due, months - 1));
  const who = (on: PlainDate): Servicer =>
    transferInOn !== null && on < transferInOn ? "prior" : "us";

  const receipts: ReceiptRow[] = [];
  const runs: LateChargeRunRow[] = [];
  const disbursements: DisbursementRow[] = [];
  const analyses: AnalysisRow[] = [];
  const armChanges: ArmChangeRow[] = [];
  const pmiRows: PmiRow[] = [];
  const contacts: ContactRow[] = [];
  const behavior: BehaviorRow[] = [];
  const monthEnds: MonthEnd[] = [];
  const archived: InstallmentProjection[] = [];
  const notes: string[] = [];
  let payoff: PayoffRow | null = null;
  let atTransfer: TransferSnapshot | null = null;
  let transferOutOn: PlainDate | null = null;
  let ended:
    | { kind: "paid_in_full"; on: PlainDate; by_refinance: boolean }
    | { kind: "transfer_out"; on: PlainDate }
    | null = null;
  const note = (on: PlainDate, kind: BehaviorRow["kind"], due: PlainDate | null = null) =>
    behavior.push({ on, kind, due, servicer: who(on) });

  // The terms: the note's, and what boarding writes (the same, unless a defect says otherwise).
  const noteTerms: BoardedTerms = {
    late_charge_pct: d.late_charge.pct,
    late_charge_grace_days: d.late_charge.grace_days,
    late_charge_cap_cents: d.late_charge.cap_cents,
    escrowed: d.escrowed,
  };
  const boardedTerms = ov.boarded ? ov.boarded(noteTerms) : noteTerms;
  const boardedOn = transferInOn ?? d.note_date;
  const initialTerms = transferInOn ? noteTerms : boardedTerms;

  // INVENTED: the P&I and note rate by due date; the cashiering state carries one rate and each installment one P&I.
  const piSched: { from: PlainDate; pi: Cents; rate: string }[] = [
    { from: d.first_due, pi: d.initial_pi_cents, rate: d.note_rate_pct },
  ];
  const termsFor = (due: PlainDate) => {
    let t = piSched[0]!;
    for (const x of piSched) if (x.from <= due) t = x;
    return t;
  };
  const rateOf = (due: PlainDate) => termsFor(due).rate;

  // INVENTED: the escrow payment by due date (each analysis writes the next 24), and the balance between analyses.
  const escrowSched = new Map<PlainDate, Cents>();
  // INVENTED: what a loan boarded non-escrowed does with an escrow account it had (D-31). From the boarding date its
  // installments carry no escrow, no bill is paid from the account and no analysis is run; the balance the prior
  // servicer sent is held where boarding posted it (service.ts postOpeningEntries posts it whatever the flag says)
  // and refunded at a payoff. The borrower pays what is billed, which is now the P&I.
  let escrowOffFrom: PlainDate | null = null;
  const escrowOn = (on: PlainDate) =>
    d.escrowed && !(escrowOffFrom !== null && on >= escrowOffFrom);
  let escrowBal = 0n;
  let escrowDeposits = 0n;
  let escrowDisbursed = 0n;
  let escrowInitial = 0n;
  let lastEscrow = 0n;
  const escrowFor = (due: PlainDate): Cents =>
    escrowOn(due) ? (escrowSched.get(due) ?? lastEscrow) : 0n;
  let miTerminatedOn: PlainDate | null = null;
  let disbSeq = 0;

  let state: LoanCashState = {
    loan_id: d.loan_id,
    instrument_date: d.note_date,
    lien: "first",
    escrowed: d.escrowed,
    note_rate_pct: d.note_rate_pct,
    remittance_type: "A/A",
    upb_cents: d.orig_upb_cents,
    lpi_date: addMonths(d.first_due, -1),
    installments: [],
    late_charges_due_cents: 0n,
    nsf_fees_due_cents: 0n,
    other_fees_due_cents: 0n,
    suspense_unapplied_cents: 0n,
    holds: [],
    trial_active: false,
    plan_active: false,
    partial_count_12m: 0,
    opted_out_of_50_rule: false,
    late_charge_pct: initialTerms.late_charge_pct,
    late_charge_grace_days: initialTerms.late_charge_grace_days,
    late_charge_cap_cents: initialTerms.late_charge_cap_cents,
    late_charge_basis: "pi",
    fees: [],
    overlays: [],
    transfer_shield_until: null,
  };
  // INVENTED: the rolling twelve-month window behind partial_count_12m.
  const fiftyDates: PlainDate[] = [];

  // Initial escrow: the first year's projection off its own bills, deposited at the settlement ceiling
  // (`settlementDepositCeiling`, apps/servicing/src/domain/escrow/analysis.ts:109).
  if (d.escrowed) {
    const y1 = addMonths(d.first_due, 12);
    const lines0: EscrowLineInput[] = lines.map((l) => {
      const bills = l.bills.filter((b) => b.on >= d.first_due && b.on < y1);
      const annual = bills.reduce((s, b) => s + b.amount, 0n);
      return {
        line_type: l.line_type,
        frequency: l.frequency,
        estimate_basis: l.basis === "mi" ? "contract" : "known_bill",
        prior_year_annual_cents: annual,
        prior_disbursed_on: bills.map((b) => addMonths(b.on, -12)),
        ...(l.basis === "mi"
          ? { contract_annual_cents: annual }
          : { known_bills: bills.map((b) => ({ amount_cents: b.amount, due_on: b.on })) }),
      };
    });
    const pr = project(projectLines(lines0, d.first_due).items, d.first_due, { policy_months: 2 });
    escrowBal = settlementDepositCeiling(pr);
    escrowInitial = escrowBal;
    for (let k = 0; k < 24; k++) escrowSched.set(addMonths(d.first_due, k), pr.base_payment_cents);
    lastEscrow = pr.base_payment_cents;
  }

  // PMI: the schedule once, and its trigger date (the earlier of the 78 % date and the midpoint).
  let miSchedule: ScheduleVersion | null = null;
  let miTrigger: PlainDate | null = null;
  const rule78 = rule78Applies({
    consummation: d.note_date,
    units: 1,
    occupancy_at_origination: "principal",
  });
  const mid = midpoint(d.first_due, d.term_months).midpoint_termination_date;
  if (d.mi) {
    miSchedule = buildSchedule({
      upb_cents: d.orig_upb_cents,
      annual_rate: ratePercent(d.note_rate_pct),
      term_months: d.term_months,
      first_due: d.first_due,
    });
    miTrigger = pendingTriggerDate(
      scheduledDateForPct(miSchedule, d.value_cents, 78)?.due_date ?? null,
      mid,
      rule78,
    );
  }

  // ARM: the schedule basis the expected balance is read from (ops-7-2.ts:314-319, restated in arm/grader.ts).
  let armBasis = {
    from_due: d.first_due,
    upb: d.orig_upb_cents,
    rate: d.note_rate_pct,
    pi: d.initial_pi_cents,
  };

  // The event queue, per calendar month.
  const queue = new Map<string, Ev[]>();
  let seq = 0;
  const push = (e: Omit<Ev, "seq">): Ev => {
    const key = e.on.slice(0, 7);
    const ev: Ev = { ...e, seq: seq++ };
    let arr = queue.get(key);
    if (!arr) {
      arr = [];
      queue.set(key, arr);
    }
    let i = arr.length;
    while (i > 0 && evLess(ev, arr[i - 1]!)) i--;
    arr.splice(i, 0, ev);
    return ev;
  };

  for (const l of lines)
    for (const b of l.bills)
      if (b.on <= windowEnd)
        push({ on: b.on, kind: "disburse", amount: b.amount, line: l.line_type });
  const analysisLead = (y: number) => rngFor(`${loanKey}/esc/${y}`);
  const scheduleAnalysis = (y: number) => {
    if (!d.escrowed) return;
    const lead = analysisLead(y).int(45, 75);
    const asOf = addDays(addMonths(d.first_due, 12 * y), -lead);
    if (asOf <= windowEnd) push({ on: asOf, kind: "analysis", year: y });
  };
  scheduleAnalysis(1);
  if (d.arm)
    for (
      let c = d.arm.first_change;
      c <= windowEnd && addMonths(c, 1) <= d.maturity;
      c = addMonths(c, d.arm.period_months)
    )
      push({ on: addDays(indexDate(c, d.arm.lookback_days), 7), kind: "arm", due: c });
  if (miTrigger && miTrigger <= windowEnd) push({ on: miTrigger, kind: "pmi", due: miTrigger });
  if (transferInOn) push({ on: transferInOn, kind: "board" });
  script.plans.forEach((p, i) => push({ on: p.on, kind: "plan", plan: i }));
  script.promises.forEach((p, i) => {
    push({ on: p.made_on, kind: "promise_made", promise: i });
    push({ on: p.pay_on, kind: "promise_pay", promise: i });
  });
  if (script.payoff)
    push({ on: script.payoff.on, kind: "payoff", byRefi: script.payoff.by_refinance });
  if (script.transfer_out) push({ on: script.transfer_out, kind: "transfer_out" });
  // A history error's: another loan's receipt keyed to this one, posted on the day it came in.
  const errors = ov.errors ?? [];
  /** The installments another loan's payment, posted here, paid (D-25). */
  const paidByAnother = new Set<PlainDate>();
  for (const x of errors)
    if (x.kind === "receipt_from" && x.on <= windowEnd)
      push({
        on: x.on,
        kind: "receipt",
        due: x.on,
        mode: "misposted",
        amount: x.amount,
        credited: x.on,
        channel: "misposted",
        rowId: x.id,
      });

  /* ── the behavior layer ────────────────────────────────────────────────── */

  // INVENTED: everything the borrower does. None of the ports has a borrower. The book's shares become this
  // borrower's probabilities through their habits (behavior.ts).
  const base = behaviorBase(R);
  const own = borrowerRates(base, d.lateness, d.fragility);
  const pRoll = own.miss;
  const pCure = base.cure;
  const pRoll2 = base.miss_again;
  const pAfter = own.after_grace;
  const pWithin = own.within_grace;
  let disasterUntil: PlainDate | null = null;
  let lastRegular: Cents | null = null;
  const staleArmed = [...script.bill_pay_stale];
  let forwarded = 0;
  interface Plan {
    readonly on: PlainDate;
    readonly months: number;
    /** What was owed when the plan began: the installments past due (named in `in_arrears`), the fees, less suspense. */
    readonly arrears: Cents;
    readonly in_arrears: ReadonlySet<PlainDate>;
    readonly share: Cents;
    paid: number;
    done: boolean;
  }
  const plans: Plan[] = [];
  const activePlan = (): Plan | undefined => plans.find((p) => !p.done);
  const promiseCovers = (on: PlainDate) =>
    script.promises.some((p) => p.made_on <= on && on < p.pay_on);
  const open = () => state.installments.filter((i) => i.status === "due").sort(byDue);
  const fees = () =>
    state.late_charges_due_cents + state.nsf_fees_due_cents + state.other_fees_due_cents;
  /** Everything owed by `through`: every open installment due by then at its own amount, the fees, less what suspense holds. */
  const cureAmount = (through: PlainDate): Cents => {
    let s = fees() - state.suspense_unapplied_cents;
    for (const i of state.installments)
      if (i.status === "due" && i.due_date <= through) s += pOf(i);
    return s;
  };

  // The late-charge run for each installment, kept so a boarding that changes the grace period can move the runs still to come.
  const runEvents = new Map<PlainDate, Ev>();
  const planReceipt = (inst: InstallmentProjection, j: number) => {
    const due = inst.due_date;
    const md = drawPayment(rngFor(`${loanKey}/m/${j}`), R.payment.day_of_month);
    const runDay = addDays(graceEndFor(state, due), 1);
    runEvents.set(due, push({ on: runDay, kind: "run", due }));
    let on: PlainDate;
    // After grace is late in the month: a payment never received in its month is a miss, drawn apart from timing.
    if (rnd.payments && md.uTiming < pAfter) {
      on = addDays(runDay, md.afterDays);
      const last = rollBack(endOfMonth(due), servicerCalendar);
      if (on > last) on = last < runDay ? runDay : last;
    } else if (rnd.payments && md.uTiming < pAfter + pWithin)
      on = withinGraceDay(due, md.withinDay, R.payment.day_of_month_bins);
    else on = d.persona === "early" ? addDays(due, -(rnd.payments ? md.earlyDays : 3)) : due;
    on = rollForward(on, servicerCalendar);
    const credited = on;
    let channel: ReceiptRow["channel"] = "borrower";
    // A payment sent to the prior servicer after the transfer reaches us late and is credited as of the day they had it.
    if (
      transferInOn &&
      on >= transferInOn &&
      !script.missed.has(due) &&
      forwarded < (script.transfer_in?.misdirected ?? 0)
    ) {
      forwarded++;
      channel = "transferor_forward";
      on = rollForward(addDays(on, md.forwardLag), servicerCalendar);
    }
    push({
      on,
      kind: "receipt",
      due,
      mode: "regular",
      credited,
      channel,
      draws: md,
      scriptedMiss: script.missed.has(due),
    });
  };

  const addInstallment = (j: number) => {
    const due = addMonths(d.first_due, j);
    if (due > d.maturity) return;
    const t = termsFor(due);
    const esc = escrowFor(due);
    lastEscrow = esc;
    const inst: InstallmentProjection = {
      due_date: due,
      pi_cents: t.pi,
      escrow_cents: esc,
      status: "due",
    };
    state.installments.push(inst);
    planReceipt(inst, j);
  };

  /** The cashiering ledger, as Metro 2 and the PMI and Reg X tests read it. */
  const applied = (): AppliedInstallment[] =>
    state.installments.map((i) => {
      const paid = i.status === "satisfied" || i.status === "prepaid";
      return {
        due_date: i.due_date,
        amount_cents: pOf(i),
        satisfied_on: paid ? (i.credited_as_of ?? i.satisfied_on ?? null) : null,
        paid_cents: paid ? pOf(i) : 0n,
      };
    });

  let paidInMonth = 0n;
  let lastPaymentOn: PlainDate | null = null;
  let principalApplied = 0n;
  let lateCollected = 0n;
  let receiptSeq = 0;
  let prior: PriorHistory | Metro2Snapshot | null = null;

  const markFeesCollected = (amount: Cents, on: PlainDate) => {
    let lc = amount;
    for (const f of state.fees ?? []) {
      if (lc <= 0n) break;
      if (f.fee_type !== "late_charge" || f.state !== "assessed") continue;
      const openAmt = f.amount_cents - f.collected_cents;
      const take = lc < openAmt ? lc : openAmt;
      f.collected_cents += take;
      lc -= take;
      f.collected_on = on;
      if (f.collected_cents === f.amount_cents) f.state = "collected";
    }
    lateCollected += amount;
  };

  const post = (
    on: PlainDate,
    credited: PlainDate,
    amount: Cents,
    mode: ReceiptMode,
    channel: ReceiptRow["channel"],
    curtail: Cents,
    fixedId?: string,
  ): void => {
    // A history error's row is named off another's (HistoryError), and spends no id of the loan's own.
    const id = fixedId ?? `${d.loan_id}-R${++receiptSeq}`;
    // A receipt keyed to another loan never reaches this one; its id stays spent.
    if (errors.some((x) => x.kind === "receipt_elsewhere" && x.receipt === id)) return;
    const cutoff = addDays(on, -365);
    while (fiftyDates.length && fiftyDates[0]! < cutoff) fiftyDates.shift();
    state.partial_count_12m = fiftyDates.length;
    if (ov.observe)
      ov.observe({
        kind: "receipt",
        receipt_id: id,
        mode,
        on,
        credited_as_of: credited,
        amount,
        curtailment: curtail,
        state: {
          ...state,
          installments: state.installments.map((i) => ({ ...i })),
          holds: [...state.holds],
          fees: (state.fees ?? []).map((f) => ({ ...f })),
          overlays: (state.overlays ?? []).map((o) => ({ ...o })),
        },
        rates: Object.fromEntries(state.installments.map((i) => [i.due_date, rateOf(i.due_date)])),
      });
    const plansMade = allocateAtRates(
      state,
      {
        payment_id: id,
        amount_cents: amount,
        received_on: on,
        credited_as_of: credited,
        designation: "unspecified",
        ...(curtail > 0n ? { curtailment_cents: curtail } : {}),
      },
      rateOf,
    );
    const last = plansMade[plansMade.length - 1]!;
    state = last.next;
    let escrowIn = 0n;
    let lc = 0n;
    let curtailed = 0n;
    const insts: ReceiptRow["installments"][number][] = [];
    const outcomes: AllocationOutcome[] = [];
    for (const p of plansMade) {
      outcomes.push(p.outcome);
      for (const a of p.allocations) {
        if (a.bucket === "escrow") escrowIn += a.amount_cents;
        if (a.bucket === "principal" || a.bucket === "curtailment")
          principalApplied += a.amount_cents;
      }
      lc += p.late_charge_cents;
      curtailed += p.curtailment_cents;
      for (const x of p.installments)
        insts.push({
          due: x.due_date,
          interest: x.interest_cents,
          principal: x.principal_cents,
          escrow: x.escrow_cents,
          rate_pct: rateOf(x.due_date),
          kind: x.kind,
          fifty_rule_shortfall: x.fifty_rule_shortfall_cents ?? 0n,
        });
    }
    const outcome: AllocationOutcome = outcomes.includes("applied_with_50_rule")
      ? "applied_with_50_rule"
      : outcomes.includes("applied")
        ? "applied"
        : last.outcome;
    if (outcome === "applied_with_50_rule") fiftyDates.push(on);
    escrowBal += escrowIn;
    escrowDeposits += escrowIn;
    markFeesCollected(lc, on);
    paidInMonth += amount;
    lastPaymentOn = on;
    receipts.push({
      id,
      on,
      credited_as_of: credited,
      amount,
      mode,
      channel,
      servicer: who(on),
      outcome,
      installments: insts,
      late_charge: lc,
      curtailment: curtailed,
      to_suspense: last.to_suspense_cents,
      suspense_used: plansMade[0]!.suspense_used_cents,
      upb_after: state.upb_cents,
    });
    // INVENTED: the payoff by overshoot. A level payment's last installment overpays the balance, by cents on a loan
    // that ran to schedule and by up to a month's principal on one its curtailments shortened. A drawn loan reaches it
    // only in a run past the decade. The overage is noted and not refunded, and neither is the escrow balance.
    if (state.upb_cents <= 0n && !ended) {
      const over = -state.upb_cents;
      principalApplied -= over;
      state = {
        ...state,
        upb_cents: 0n,
        installments: state.installments.filter((i) => i.due_date <= on || i.status !== "due"),
      };
      notes.push(over > 0n ? `paid to zero on ${on}, ${over}¢ over` : `paid to zero on ${on}`);
      ended = { kind: "paid_in_full", on, by_refinance: false };
      note(on, "payoff");
    }
    // A draft taken twice: the same amount, the same day, posted again by the waterfall.
    if (!ended && errors.some((x) => x.kind === "receipt_twice" && x.receipt === id))
      post(on, credited, amount, "duplicate", channel, 0n, `${id}-DUP`);
  };

  const onReceipt = (e: Ev) => {
    const target = e.due!;
    const channel = e.channel ?? "borrower";
    const credited = e.credited ?? e.on;
    if (e.mode === "misposted") {
      post(e.on, credited, e.amount!, "misposted", channel, 0n, e.rowId);
      for (const x of receipts.find((r) => r.id === e.rowId)?.installments ?? [])
        paidByAnother.add(x.due);
      return;
    }
    if (e.mode === "partial_rest")
      return post(e.on, credited, e.amount!, "partial_rest", channel, 0n);
    if (e.scriptedMiss) return void note(e.on, "missed", target);
    if (promiseCovers(e.on)) return void note(e.on, "deferred_to_promise", target);
    const md = e.draws!;
    const o = open();
    const oldest = o[0];
    const targetInst = state.installments.find((i) => i.due_date === target);
    const behind = oldest !== undefined && oldest.due_date < target;
    const plan = activePlan();
    // An installment a cure or a promise already paid (a late receipt arriving after the next one's cure) is not paid
    // twice: the borrower sends nothing for it. One another borrower's payment paid (D-25) the borrower knows nothing
    // of, and pays as billed.
    if (!plan && targetInst && targetInst.status !== "due" && !paidByAnother.has(target))
      return void note(e.on, "already_paid", target);
    if (plan) {
      // Each plan payment is the month's own installment (none when it is one of the arrears) and a share of the arrears.
      plan.paid++;
      const extra =
        plan.paid === plan.months
          ? plan.arrears - plan.share * BigInt(plan.months - 1)
          : plan.share;
      const regular = targetInst && !plan.in_arrears.has(target) ? pOf(targetInst) : 0n;
      post(e.on, credited, regular + extra, "plan", channel, 0n);
      if (plan.paid === plan.months) {
        plan.done = true;
        const caughtUp = !state.installments.some((i) => i.status === "due" && i.due_date <= e.on);
        if (caughtUp) waiveAll(state, "workout_completion", ACTOR);
        else releaseSuspended(state, "repayment_plan_pending_waiver");
        state.overlays = (state.overlays ?? []).map((x) =>
          x.kind === "repayment_plan_pending_waiver" && !x.to ? { ...x, to: e.on } : x,
        );
        note(e.on, caughtUp ? "plan_completed" : "plan_failed");
      }
      return;
    }
    const disaster = disasterUntil !== null && e.on <= disasterUntil ? DISASTER_MISS_MULTIPLIER : 1;
    if (behind) {
      if (!rnd.delinquency || md.uCure < pCure) {
        const owed = cureAmount(target > e.on ? target : e.on);
        return post(e.on, credited, owed > 0n ? owed : pOf(oldest!), "cure", channel, 0n);
      }
      if (md.uRoll < clamp01(pRoll2 * disaster)) return void note(e.on, "missed", target);
      return post(e.on, credited, pOf(oldest!), "oldest", channel, 0n);
    }
    if (rnd.delinquency && md.uMiss < clamp01(pRoll * disaster, 0.9))
      return void note(e.on, "missed", target);
    // What the borrower was billed: the oldest installment open, or, for one another borrower's payment paid without
    // their knowing (D-25), that installment itself.
    const statement = pOf(
      targetInst && paidByAnother.has(target) ? targetInst : (oldest ?? targetInst!),
    );
    const stale =
      staleArmed.length > 0 &&
      staleArmed[0]! <= e.on &&
      lastRegular !== null &&
      statement !== lastRegular;
    if (stale) {
      staleArmed.shift();
      note(e.on, "stale_bill_pay", target);
      return post(e.on, credited, lastRegular!, "stale_bill_pay", channel, 0n);
    }
    lastRegular = statement;
    if (rnd.payments && md.uPartial < R.payment.partial_share) {
      const short = md.partialShort < statement ? md.partialShort : statement / 3n;
      push({
        on: rollForward(addDays(e.on, md.partialLag), servicerCalendar),
        kind: "receipt",
        due: target,
        mode: "partial_rest",
        amount: short,
        channel,
      });
      return post(e.on, credited, statement - short, "partial", channel, 0n);
    }
    if (rnd.payments && state.escrowed && md.uFifty < FIFTY_SHORT_SHARE)
      return post(e.on, credited, statement - md.fiftyShort, "short_50", channel, 0n);
    if (rnd.payments && md.uCurtail < R.payment.curtailment_share) {
      const cap = state.upb_cents / CURTAILMENT_MAX_SHARE;
      const c = md.curtail < cap ? md.curtail : cap;
      if (c > 0n) return post(e.on, credited, statement + c, "curtail", channel, c);
    }
    return post(e.on, credited, statement, "regular", channel, 0n);
  };

  const onPromiseMade = (e: Ev) => {
    const p = script.promises[e.promise!]!;
    contacts.push({
      on: e.on,
      direction: "inbound",
      reason: "promise_to_pay",
      minutes: R.contacts.handle_time_minutes,
      servicer: who(e.on),
    });
    note(p.made_on, "promise_made");
  };
  const onPromisePay = (e: Ev) => {
    const p = script.promises[e.promise!]!;
    if (!p.kept) return void note(e.on, "promise_broken");
    note(e.on, "promise_kept");
    const owed = p.amount ?? cureAmount(e.on);
    if (owed > 0n) post(e.on, e.on, owed, "promise", "borrower", 0n);
  };
  const onPlan = (e: Ev) => {
    const p = script.plans[e.plan!]!;
    let arrears = fees() - state.suspense_unapplied_cents;
    const inArrears = new Set<PlainDate>();
    for (const i of state.installments)
      if (i.status === "due" && i.due_date < e.on) {
        arrears += pOf(i);
        inArrears.add(i.due_date);
      }
    if (arrears <= 0n) return;
    plans.push({
      on: e.on,
      months: p.months,
      arrears,
      in_arrears: inArrears,
      share: arrears / BigInt(p.months),
      paid: 0,
      done: false,
    });
    // Charges on the installments the plan covers, and on those due while it runs, accrue suspended until it ends
    // (the overlay `assessLateCharge` reads, apps/servicing/src/domain/cashiering/latecharges.ts:88).
    const from = [...inArrears].sort()[0] ?? e.on;
    state.overlays = [
      ...(state.overlays ?? []),
      { kind: "repayment_plan_pending_waiver", from, to: null },
    ];
    note(e.on, "plan_started");
  };

  const onRun = (e: Ev) => {
    if (!state.installments.some((i) => i.due_date === e.due)) return;
    const res = assessLateCharge({
      state,
      installment_due_date: e.due!,
      run_on: e.on,
      unposted_receipts_on_or_before_grace: 0,
    });
    let amount: Cents | null = null;
    if (res.outcome === "assessed" || res.outcome === "accrued_suspended") {
      // The fee's id is the engine's randomUUID; a history must be the same every run, so it is named by its installment.
      recordFee(state, { ...res.fee, id: `${d.loan_id}-LC-${e.due}` });
      amount = res.fee.amount_cents;
    }
    runs.push({
      due: e.due!,
      on: e.on,
      outcome: res.outcome,
      reason: res.outcome === "not_assessed" ? res.reason : null,
      amount,
      servicer: who(e.on),
    });
  };

  const disburse = (
    on: PlainDate,
    line: string,
    kind: DisbursementRow["kind"],
    amount: Cents,
    fixedId?: string,
  ): string => {
    const id = fixedId ?? `${d.loan_id}-D${++disbSeq}`;
    escrowBal -= amount;
    escrowDisbursed += amount;
    disbursements.push({
      id,
      on,
      line,
      kind,
      amount,
      balance_after: escrowBal,
      servicer: who(on),
    });
    return id;
  };
  const onDisburse = (e: Ev) => {
    if (!escrowOn(e.on)) return;
    if (e.line === "mi_borrower_paid" && miTerminatedOn && e.on >= miTerminatedOn) return;
    if (e.returned) return void disburse(e.on, e.line!, "returned", e.amount!, e.rowId);
    if (e.rowId) return void disburse(e.on, e.line!, "bill", e.amount!, e.rowId);
    const err = e.refund
      ? undefined
      : errors.find(
          (x) =>
            (x.kind === "bill_amount" || x.kind === "bill_late") &&
            x.line === e.line &&
            x.due === e.on,
        );
    if (err?.kind === "bill_late") {
      // The bill went to someone else; it is paid when it reaches the servicer, under the id it would have had.
      const id = `${d.loan_id}-D${++disbSeq}`;
      if (err.paid_on <= windowEnd)
        push({ on: err.paid_on, kind: "disburse", amount: e.amount!, line: e.line!, rowId: id });
      return;
    }
    if (err?.kind === "bill_amount") {
      // Paid as the vendor reported it; the payee returns what it was paid over the bill.
      const id = disburse(e.on, e.line!, "bill", err.paid);
      const excess = err.paid - e.amount!;
      if (err.returned_on !== null && err.returned_on <= windowEnd && excess !== 0n)
        push({
          on: err.returned_on,
          kind: "disburse",
          amount: -excess,
          line: e.line!,
          returned: true,
          rowId: `${id}-RET`,
        });
      return;
    }
    disburse(e.on, e.line!, e.refund ? "refund" : "bill", e.amount!);
  };

  const onAnalysis = (e: Ev) => {
    if (!escrowOn(e.on)) return;
    const y = e.year!;
    const ys = addMonths(d.first_due, 12 * y);
    const ye = addMonths(ys, 12);
    const py = addMonths(ys, -12);
    const asOf = e.on;
    // The analyst's inputs, drawn from the analysis's own stream: CPI for taxes, the renewal quote known half the time.
    const r = analysisLead(y);
    r.int(45, 75);
    const cpi = rnd.growth
      ? (2 + r.next() * 3).toFixed(1)
      : (R.escrow.tax_growth_yoy * 100).toFixed(1);
    const quoteKnown = r.next() < 0.5;
    const sentAfter = r.int(1, 10);
    const inputs: EscrowLineInput[] = [];
    for (const l of lines) {
      if (l.basis === "mi" && miTerminatedOn && miTerminatedOn <= ys) continue;
      const last = l.bills.filter((b) => b.on >= py && b.on < ys);
      const next = l.bills.filter((b) => b.on >= ys && b.on < ye);
      const base = {
        line_type: l.line_type,
        frequency: l.frequency,
        prior_year_annual_cents: last.reduce((s, b) => s + b.amount, 0n),
        prior_disbursed_on: last.map((b) => b.on),
      };
      const known = {
        ...base,
        estimate_basis: "known_bill" as const,
        known_bills: next.map((b) => ({ amount_cents: b.amount, due_on: b.on })),
      };
      if (last.length === 0) inputs.push(known);
      else if (l.basis === "tax")
        inputs.push({
          ...base,
          estimate_basis: "prior_year_cpi",
          prior_year_confirmed_on: last[0]!.on,
        });
      else if (l.basis === "mi")
        inputs.push({
          ...base,
          estimate_basis: "contract",
          contract_annual_cents: next.reduce((s, b) => s + b.amount, 0n),
          terminates_on: miTerminatedOn ?? miTrigger,
        });
      else if (quoteKnown) inputs.push(known);
      else
        inputs.push({
          ...base,
          estimate_basis: "prior_year",
          prior_year_confirmed_on: last[0]!.on,
        });
    }
    const pl = projectLines(inputs, ys, { cpi_change_pct: cpi, as_of: asOf });
    const projection = project(pl.items, ys, {
      policy_months: 2,
      instrument_months: null,
      state_max_months: null,
    });
    // The projected actual balance as escrow/grader.ts's projectedActual reads it: the balance now, plus the deposits
    // still due before the year (assumed paid), less what is still to be paid out. An installment due after the run
    // date that an early payer has already paid is in the balance now, and is not counted twice.
    const deposits: { on: PlainDate; amount: Cents }[] = [];
    for (let due = addMonths(ys, -3); due < ys; due = addMonths(due, 1)) {
      if (due <= asOf) continue;
      const inst = state.installments.find((i) => i.due_date === due);
      if (!inst || inst.status === "due") deposits.push({ on: due, amount: escrowFor(due) });
    }
    const toPay: { on: PlainDate; line: string; amount: Cents }[] = [];
    for (const l of lines)
      for (const b of l.bills)
        if (
          b.on > asOf &&
          b.on < ys &&
          !(l.basis === "mi" && miTerminatedOn && b.on >= miTerminatedOn)
        )
          toPay.push({ on: b.on, line: l.line_type, amount: b.amount });
    let pa = escrowBal;
    for (const x of deposits) pa += x.amount;
    for (const x of toPay) pa -= x.amount;
    const dq = regxDaysDelinquent(applied(), asOf);
    const decision = decide({
      projection,
      projected_actual_cents: pa,
      as_of: asOf,
      regx_days_delinquent: dq,
      workout: false,
      borrower_election_months: null,
      instrument_shortage_max_months: null,
    });
    const pay = escrowNewPayment(projection, decision);
    const sent = addDays(asOf, sentAfter);
    const eff = effectiveDate(ys, sent);
    const oldPayment = escrowFor(eff);
    if (ov.observe)
      ov.observe({
        kind: "analysis",
        year: y,
        as_of: asOf,
        year_start: ys,
        sent_on: sent,
        lines: inputs,
        cpi_change_pct: cpi,
        balance: escrowBal,
        deposits,
        disbursements: toPay,
        regx_days_delinquent: dq,
        old_payment: oldPayment,
      });
    const flags = [...pl.anomalies, ...escrowAnomalies(oldPayment, pay.payment_cents, decision)];
    for (let k = 0; k < 24; k++) {
      const due = addMonths(eff, k);
      escrowSched.set(
        due,
        k === 0
          ? pay.first_month_cents
          : k === 11
            ? pay.final_month_cents
            : k < 12
              ? pay.payment_cents
              : projection.base_payment_cents,
      );
    }
    // An installment already projected past the effective date takes the new escrow payment.
    for (const i of state.installments)
      if (i.status === "due" && i.due_date >= eff && escrowSched.has(i.due_date))
        (i as { escrow_cents: Cents }).escrow_cents = escrowSched.get(i.due_date)!;
    if (decision.kind === "refund" && decision.due_on <= windowEnd)
      push({
        on: decision.due_on,
        kind: "disburse",
        amount: decision.surplus_cents,
        line: "refund",
        refund: true,
      });
    analyses.push({
      year: y,
      as_of: asOf,
      year_start: ys,
      sent_on: sent,
      balance: escrowBal,
      projected_actual: pa,
      annual: projection.annual_cents,
      base_payment: projection.base_payment_cents,
      target_at_start: projection.target_at_start_cents,
      decision: decision.kind,
      surplus:
        decision.kind === "refund" || decision.kind === "credit" || decision.kind === "retain"
          ? decision.surplus_cents
          : null,
      shortage: decision.kind === "shortage" ? decision.shortage_cents : null,
      deficiency: decision.kind === "shortage" ? decision.deficiency_cents : null,
      old_payment: oldPayment,
      new_payment: pay.payment_cents,
      first_month_payment: pay.first_month_cents,
      effective: eff,
      regx_days_delinquent: dq,
      anomalies: flags,
      servicer: who(asOf),
    });
    scheduleAnalysis(y + 1);
  };

  const onArm = (e: Ev) => {
    const a = d.arm!;
    const change = e.due!;
    const fnpd = addMonths(change, 1);
    const idxDate = indexDate(change, a.lookback_days);
    const sel = selectIndex(printsAround(ctx.feed, idxDate), idxDate);
    if (!sel) throw new Error(`${d.loan_id}: no index print for ${idxDate}`);
    const expected = scheduledUpbAfter(
      armBasis.upb,
      armBasis.rate,
      armBasis.pi,
      monthsBetween(armBasis.from_due, change) + 1,
    );
    const remaining = monthsBetween(fnpd, d.maturity) + 1;
    const priorRate = termsFor(change).rate;
    const input: ArmAdjustmentInput = {
      index_pct: sel.value,
      margin_pct: a.margin_pct,
      prior_rate_pct: priorRate,
      initial_note_rate_pct: d.note_rate_pct,
      initial_cap_pct: a.initial_cap_pct,
      periodic_cap_pct: a.periodic_cap_pct,
      lifetime_cap_pct: a.lifetime_cap_pct,
      first_change: change === a.first_change,
      expected_upb_cents: expected,
      remaining_term_months: remaining,
    };
    const A = computeArmAdjustment(input);
    const B = verifyArmAdjustment(input, A);
    const w = noticeWindow(fnpd, change, a.lookback_days);
    const sc = sendCheck(e.on, w, { gate: "ARM_C_NOT_BEFORE", deadline: "ARM_C_DEADLINE" });
    piSched.push({ from: fnpd, pi: A.new_pi_cents, rate: A.new_rate_pct });
    armBasis = { from_due: fnpd, upb: expected, rate: A.new_rate_pct, pi: A.new_pi_cents };
    // An installment already projected for the first new payment takes the new P&I.
    for (const i of state.installments)
      if (i.status === "due" && i.due_date >= fnpd)
        (i as { pi_cents: Cents }).pi_cents = termsFor(i.due_date).pi;
    if (miSchedule && !miTerminatedOn) {
      const n = monthsBetween(d.first_due, fnpd) + 1;
      miSchedule = armResetVersion(
        miSchedule,
        n,
        ratePercent(A.new_rate_pct),
        d.term_months - (n - 1),
      );
      const t78 = scheduledDateForPct(miSchedule, d.value_cents, 78)?.due_date ?? null;
      const nt = pendingTriggerDate(t78, mid, rule78);
      if (nt !== miTrigger) {
        miTrigger = nt;
        if (nt > e.on && nt <= windowEnd) push({ on: nt, kind: "pmi", due: nt });
      }
    }
    armChanges.push({
      change,
      first_new_payment: fnpd,
      index_date: idxDate,
      index_pct: sel.value,
      prior_rate_pct: priorRate,
      new_rate_pct: A.new_rate_pct,
      bound: A.bound,
      new_pi: A.new_pi_cents,
      expected_upb: expected,
      remaining_term_months: remaining,
      engine_b_agrees: B.agrees === true,
      discrepancy: B.discrepancy,
      notice_sent_on: e.on,
      notice_late_days: sc.breach ? sc.breach.days_late : null,
      servicer: who(e.on),
    });
  };

  const onPmi = (e: Ev) => {
    if (miTerminatedOn || e.due !== miTrigger) return;
    const res = automaticTermination(applied(), e.due!, rule78);
    let effective: PlainDate | null = null;
    if (res.status === "terminated") {
      miTerminatedOn = res.clocks.effective_on;
      effective = miTerminatedOn;
    } else if (res.status === "deferred_not_current") {
      // INVENTED: the re-sweep. The port answers a cure only from what the ledger already shows; look again next month.
      const nx = addMonths(e.due!, 1);
      if (nx <= windowEnd) {
        miTrigger = nx;
        push({ on: nx, kind: "pmi", due: nx });
      }
    }
    pmiRows.push({
      on: e.on,
      trigger: e.due!,
      status: res.status,
      effective_on: effective,
      servicer: who(e.on),
    });
  };

  const onBoard = (e: Ev) => {
    // The prior servicer's books at the close of the day before: boarding is the first event of its day.
    const o = open();
    const lastDue = state.installments.reduce<PlainDate>(
      (m, i) => (i.due_date > m ? i.due_date : m),
      d.first_due,
    );
    const nextDue = o[0]?.due_date ?? addMonths(lastDue, 1);
    const t = termsFor(nextDue);
    atTransfer = {
      on: e.on,
      upb: state.upb_cents,
      suspense: state.suspense_unapplied_cents,
      late_charges_due: state.late_charges_due_cents,
      escrow_balance: escrowBal,
      lpi: state.lpi_date,
      next_due: nextDue,
      rate_pct: t.rate,
      pi: t.pi,
      escrow_payment: escrowFor(nextDue),
      last_payment_on: lastPaymentOn,
      mi_active: d.mi !== null && !(miTerminatedOn !== null && miTerminatedOn <= e.on),
      installments: [...archived, ...state.installments].sort(byDue).map(ledgerRow),
    };
    const graceBefore = state.late_charge_grace_days;
    state.late_charge_pct = boardedTerms.late_charge_pct;
    state.late_charge_grace_days = boardedTerms.late_charge_grace_days;
    state.late_charge_cap_cents = boardedTerms.late_charge_cap_cents;
    if (d.escrowed && !boardedTerms.escrowed) {
      escrowOffFrom = e.on;
      state = { ...state, escrowed: false };
      for (const i of state.installments)
        if (i.status === "due" && i.due_date >= e.on)
          (i as { escrow_cents: Cents }).escrow_cents = 0n;
    }
    // §1024.33(c)(1): sixty days in which a payment sent to the prior servicer is not late.
    state.transfer_shield_until = addDays(e.on, 60);
    if (graceBefore !== boardedTerms.late_charge_grace_days)
      for (const [due, run] of runEvents)
        if (run.on > e.on && !run.canceled) {
          run.canceled = true;
          runEvents.set(due, push({ on: addDays(graceEndFor(state, due), 1), kind: "run", due }));
        }
    note(e.on, "boarded");
  };

  const onPayoff = (e: Ev) => {
    const lpi = state.lpi_date ?? addMonths(d.first_due, -1);
    const rate = rateOf(addMonths(lpi, 1));
    const advance = escrowBal < 0n ? -escrowBal : 0n;
    const q = quote({
      upb_cents: state.upb_cents,
      rate_pct: rate,
      lpi_due: lpi,
      good_through: e.on,
      late_charges_cents: state.late_charges_due_cents,
      fees_cents: state.nsf_fees_due_cents + state.other_fees_due_cents,
      escrow_advance_cents: advance,
      suspense_credit_cents: state.suspense_unapplied_cents,
    });
    const principal = state.upb_cents;
    const lateCharges = state.late_charges_due_cents;
    const suspense = state.suspense_unapplied_cents;
    markFeesCollected(lateCharges, e.on);
    principalApplied += principal;
    escrowBal += advance;
    escrowDeposits += advance;
    state = {
      ...state,
      upb_cents: 0n,
      late_charges_due_cents: 0n,
      nsf_fees_due_cents: 0n,
      other_fees_due_cents: 0n,
      suspense_unapplied_cents: 0n,
      // An installment not yet due never comes due; one already paid ahead stays paid (the quote credits its interest).
      // One due and unpaid stays unpaid in the ledger: the payoff pays the loan, not the installment, as the metro2
      // environment's ledgers hold it, and Metro 2 rates the closing from it.
      installments: state.installments.filter((i) => i.due_date <= e.on || i.status !== "due"),
    };
    const refund = escrowBal > 0n ? escrowBal : 0n;
    if (refund > 0n)
      disburse(
        addBusinessDays(e.on, PAYOFF_REFUND_BUSINESS_DAYS, servicerCalendar),
        "payoff_refund",
        "payoff_refund",
        refund,
      );
    paidInMonth += q.total_cents;
    lastPaymentOn = e.on;
    receipts.push({
      id: `${d.loan_id}-R${++receiptSeq}`,
      on: e.on,
      credited_as_of: e.on,
      amount: q.total_cents,
      mode: "payoff",
      channel: "borrower",
      servicer: who(e.on),
      outcome: "payoff",
      installments: [],
      late_charge: lateCharges,
      curtailment: 0n,
      to_suspense: 0n,
      suspense_used: suspense,
      upb_after: 0n,
    });
    payoff = {
      on: e.on,
      by_refinance: e.byRefi ?? false,
      funds: q.total_cents,
      principal,
      interest: q.interest.total_cents,
      late_charges: lateCharges,
      suspense_credit: suspense,
      escrow_advance: advance,
      escrow_refund: refund,
      per_diem: q.per_diem_cents,
      servicer: who(e.on),
    };
    ended = { kind: "paid_in_full", on: e.on, by_refinance: e.byRefi ?? false };
    note(e.on, "payoff");
  };

  const onTransferOut = (e: Ev) => {
    transferOutOn = e.on;
    ended = { kind: "transfer_out", on: e.on };
    note(e.on, "transfer_out");
  };

  const processMonth = (key: string) => {
    const evs = queue.get(key) ?? [];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      if (e.canceled || ended) continue;
      switch (e.kind) {
        case "receipt":
          onReceipt(e);
          break;
        case "run":
          onRun(e);
          break;
        case "disburse":
          onDisburse(e);
          break;
        case "analysis":
          onAnalysis(e);
          break;
        case "arm":
          onArm(e);
          break;
        case "pmi":
          onPmi(e);
          break;
        case "board":
          onBoard(e);
          break;
        case "plan":
          onPlan(e);
          break;
        case "promise_made":
          onPromiseMade(e);
          break;
        case "promise_pay":
          onPromisePay(e);
          break;
        case "payoff":
          onPayoff(e);
          break;
        case "transfer_out":
          onTransferOut(e);
          break;
      }
    }
    queue.delete(key);
  };

  /** The calendar month's contacts, disaster and payoff hazards, drawn from the month's own stream. */
  const monthHazards = (k: number, monthStart: PlainDate) => {
    const md = drawMonth(rngFor(`${loanKey}/c/${k}`));
    const behind = state.installments.some((i) => i.status === "due" && i.due_date < monthStart);
    const { y, m } = parts(monthStart);
    const dim = daysInMonth(y, m);
    if (rnd.contacts) {
      const lambda = (R.contacts.per_loan_year / 12) * (behind ? BEHIND_CONTACT_MULTIPLIER : 1);
      const n = poissonUpTo3(md.uContacts, lambda);
      for (let c = 0; c < n; c++) {
        const x = md.contacts[c]!;
        let u = x.uReason;
        let reason = R.contacts.inbound_reason_mix[R.contacts.inbound_reason_mix.length - 1]![0];
        for (const [name, w] of R.contacts.inbound_reason_mix) {
          if (u < w) {
            reason = name;
            break;
          }
          u -= w;
        }
        const on = ymd(y, m, Math.min(x.day, dim));
        contacts.push({
          on,
          direction: "inbound",
          reason,
          minutes: Math.round(R.contacts.handle_time_minutes * x.minutes * 10) / 10,
          servicer: who(on),
        });
      }
    }
    if (rnd.disasters && md.uDisaster < (R.disaster.by_calendar_month[m - 1] ?? 0)) {
      disasterUntil = endOfMonth(addMonths(monthStart, 1));
      note(monthStart, "disaster");
    }
    if (rnd.payoff && !script.payoff && k > 0) {
      const ramp = Math.min(1, (k + 1) / 30);
      const incentive = Number(rateOf(monthStart)) - marketRateOn(ctx.market, monthStart);
      const refi =
        incentive > REFI_THRESHOLD_PCT
          ? Math.min(REFI_MONTHLY_MAX, REFI_MONTHLY_PER_POINT * (incentive - REFI_THRESHOLD_PCT))
          : 0;
      const hazard = TURNOVER_MONTHLY * ramp + refi;
      if (md.uPayoff < hazard) {
        const on = rollForward(ymd(y, m, md.payoffDay), servicerCalendar);
        if (on <= endOfMonth(monthStart))
          push({ on, kind: "payoff", byRefi: md.uRefi * hazard < refi });
      }
    }
    // Only a loan on our books can be transferred out of them.
    if (rnd.transfers_out && !script.transfer_out && k > 0 && who(monthStart) === "us") {
      const monthly = 1 - Math.pow(1 - R.transfer.annual_rate, 1 / 12);
      if (md.uTransferOut < monthly)
        push({ on: ymd(y, m, Math.min(md.transferDay, dim)), kind: "transfer_out" });
    }
  };

  const consumers: CreditConsumer[] = d.parties.map((p) => ({
    party_id: p.party_id,
    position: p.position,
    same_address_as_base: p.same_address_as_base,
    liability: p.liability,
  }));
  const furnisherFor = (asOf: PlainDate, monthStart: PlainDate): Servicer => {
    if (transferInOn === null || transferInOn < monthStart) return "us";
    if (transferInOn > asOf) return "prior";
    return boardingMonthReporter(transferInOn) === "supermortgage" ? "us" : "prior";
  };

  const monthEnd = (monthStart: PlainDate) => {
    const asOf = endOfMonth(monthStart);
    const ap = applied();
    const o = open();
    const nextDue = o[0]?.due_date ?? null;
    const ref = nextDue ?? addMonths(monthStart, 1);
    const t = termsFor(ref);
    const dq = deriveDelinquency(ap, asOf);
    const plan = activePlan();
    const condition: LoanCondition = ended
      ? ended.kind === "paid_in_full"
        ? { kind: "paid_in_full", closed_on: ended.on, by_refinance: ended.by_refinance }
        : { kind: "transfer_out", transfer_date: ended.on }
      : plan
        ? {
            kind: "repayment_plan",
            plan_payment_cents:
              pOf(o[0] ?? { pi_cents: t.pi, escrow_cents: escrowFor(ref) }) + plan.share,
            remaining_arrears_cents: dq.amount_past_due_cents,
          }
        : { kind: "none" };
    const pm = parts(d.maturity);
    const pn = parts(ref);
    const remaining = Math.max(0, (pm.y - pn.y) * 12 + pm.m - pn.m + 1);
    const cs: CreditLoanState = {
      loan_id: d.loan_id,
      as_of: asOf,
      installments: ap,
      upb_cents: state.upb_cents,
      deferred_principal_cents: 0n,
      forborne_principal_cents: 0n,
      pi_cents: t.pi,
      escrow_cents: escrowFor(ref),
      original_amount_cents: d.orig_upb_cents,
      note_date: d.note_date,
      maturity_date: d.maturity,
      original_term_months: d.term_months,
      remaining_term_months: remaining,
      interest_type: d.arm ? "V" : "F",
      fnma_loan_number: d.fnma_loan_number,
      min: d.min,
      payments_in_month_cents: paidInMonth,
      last_payment_on: lastPaymentOn,
      condition,
      consumers,
      prior,
    };
    const snap = buildSnapshot(cs);
    const errs = validateSnapshot(snap);
    let record: Record<string, string> | null = null;
    if (errs.length) prior = { php: snap.php, status: null, dofd: snap.dofd, omitted: true };
    else {
      record = renderBase(snap);
      prior = snap;
    }
    // A loan that closed this month is measured on the day it closed, so an installment still in grace when it was
    // paid off or transferred does not age to the month-end. The MBA count is of payments missed at a month-end, so the
    // month's own installment is not one; a loan paid in full has nothing past due.
    const at = ended ? ended.on : asOf;
    const days = regxDaysDelinquent(ap, at);
    const mba = ended
      ? fnmaDelinquencyStatus(
          ap.filter((i) => i.due_date < monthStart),
          at,
        )
      : fnmaDelinquencyStatus(ap, asOf);
    const pastDue = !ended
      ? dq.amount_past_due_cents
      : ended.kind === "paid_in_full"
        ? 0n
        : deriveDelinquency(ap, at).amount_past_due_cents;
    monthEnds.push({
      month: monthStart.slice(0, 7),
      as_of: asOf,
      servicer: who(asOf),
      upb: state.upb_cents,
      suspense: state.suspense_unapplied_cents,
      late_charges_due: state.late_charges_due_cents,
      escrow_balance: escrowBal,
      escrow_advance: escrowBal < 0n ? -escrowBal : 0n,
      rate_pct: t.rate,
      pi: t.pi,
      escrow_payment: escrowFor(ref),
      next_due: ended ? null : nextDue,
      lpi: state.lpi_date,
      last_payment_on: lastPaymentOn,
      paid_in_month: paidInMonth,
      days_delinquent: days,
      mba_status: mba,
      amount_past_due: pastDue,
      status: ended
        ? ended.kind === "paid_in_full"
          ? "paid_off"
          : "transferred"
        : days >= 30
          ? "delinquent"
          : "current",
      mi_active: d.mi !== null && !ended && !(miTerminatedOn && miTerminatedOn <= asOf),
      plan_active: plan !== undefined,
      remaining_term_months: remaining,
      metro2: {
        furnished_by: furnisherFor(asOf, monthStart),
        record,
        errors: errs,
        account_status: snap.account_status,
      },
    });
  };

  addInstallment(0);
  // The month before the first due date: an early payer's first receipt lands in it.
  processMonth(addMonths(d.first_due, -1).slice(0, 7));
  for (let k = 0; k < months; k++) {
    const monthStart = addMonths(d.first_due, k);
    monthHazards(k, monthStart);
    addInstallment(k + 1); // one month ahead, so an early payer's receipt finds it
    paidInMonth = 0n;
    processMonth(monthStart.slice(0, 7));
    monthEnd(monthStart);
    if (ended) break;
    // Installments satisfied more than 24 months back are read by nothing the engines run each month
    // (delinquency is the earliest unpaid, the PHP is carried, the MI test asks only that all are paid).
    if (k % 12 === 11) {
      const cut = addMonths(monthStart, -24);
      const keep: InstallmentProjection[] = [];
      for (const i of state.installments) {
        if ((i.status === "satisfied" || i.status === "prepaid") && i.due_date < cut)
          archived.push(i);
        else keep.push(i);
      }
      if (keep.length !== state.installments.length) state = { ...state, installments: keep };
    }
  }
  const endOn = (ended as { on: PlainDate } | null)?.on ?? null;
  const tail = endOn ? (x: { on: PlainDate }) => x.on <= endOfMonth(endOn) : () => true;

  // The invariants the prototype checked, and the ones this module adds.
  const finalUpb = state.upb_cents;
  if (finalUpb !== d.orig_upb_cents - principalApplied)
    notes.push(
      `upb ${finalUpb} != original - principal applied ${d.orig_upb_cents - principalApplied}`,
    );
  if (escrowInitial + escrowDeposits - escrowDisbursed !== escrowBal)
    notes.push("escrow ledger does not reconcile");
  const feeRows: FeeRow[] = (state.fees ?? [])
    .filter((f) => f.fee_type === "late_charge")
    .map((f) => ({
      id: f.id,
      due: f.installment_due_date!,
      assessed_on: f.assessed_on,
      amount: f.amount_cents,
      state: f.state,
      collected: f.collected_cents,
      collected_on: f.collected_on ?? null,
      servicer: who(f.assessed_on),
    }));
  const collected = feeRows.reduce((s, f) => s + f.collected, 0n);
  if (collected !== lateCollected)
    notes.push(`fees collected ${collected} != late charges allocated ${lateCollected}`);
  if (state.suspense_unapplied_cents < 0n) notes.push("suspense below zero");
  if (state.late_charges_due_cents < 0n) notes.push("late charges due below zero");
  const ledger = [...archived, ...state.installments].sort(byDue).map(ledgerRow);
  if (ctx.outreach)
    contacts.push(
      ...outreachCalls(loanKey, ledger, script.promises, d.first_due, endOn ?? windowEnd, who),
    );
  const invariantNotes = notes.filter((n) => !n.startsWith("paid to zero"));
  return {
    loan_id: d.loan_id,
    draw: d,
    lines,
    transfer_in_on: transferInOn,
    boarded: { on: boardedOn, terms: boardedTerms },
    at_transfer: atTransfer,
    receipts,
    fees: feeRows,
    late_charge_runs: runs,
    disbursements,
    analyses,
    arm_changes: armChanges,
    pmi: pmiRows,
    contacts: contacts.filter(tail).sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)),
    behavior,
    installments: ledger,
    months: monthEnds,
    payoff,
    transfer_out_on: transferOutOn,
    invariants: { ok: invariantNotes.length === 0, notes },
  };
}

/** The ledger as the outreach reads it: each installment and the day it was paid in full. */
type LedgerRow = Pick<
  InstallmentRow,
  "due" | "pi" | "escrow" | "status" | "satisfied_on" | "credited_as_of"
>;

/** The cadence's first attempt, on the day the §1024.31 count reaches it (plan.ts:16, FIRST_ATTEMPT_DAY). */
const OUTREACH_FIRST_DAY = 17;
/** Each later attempt is due this many days after the last (plan.ts:17, CYCLE_DAYS). */
const OUTREACH_CYCLE_DAYS = 7;
/** A promise to pay due within this many days ceases the cadence (FNMA_D2202_PTP_MAX_30). */
const OUTREACH_PROMISE_MAX_DAYS = 30;

/**
 * The servicer's outbound collection calls: the servicing app's D2-2-02 plan
 * (apps/servicing/src/domain/early-intervention/plan.ts) run over the ledger
 * after the fact, since no call changes what the borrower pays. The plan opens
 * the day the §1024.31 count reaches 17 and attempts that day (`openPlanIfDue`,
 * plan.ts:70-76); each later attempt is due 7 days after the last, moved to the
 * servicer's next business day (`recordAttempt`, plan.ts:95). A promise to pay
 * due within 30 days ceases it (`ceased{ptp_pending}`; FNMA_D2202_CESSATION_ON_QRPC
 * and FNMA_D2202_PTP_MAX_30 in spec/registry/timers.json), a broken one resumes
 * it on the day it was due (`promise_broken`), and the cure closes it.
 *
 * INVENTED: each attempt's outcome, drawn from a stream of its own day (no
 * attempt reaches the borrower; a conversation would be a contact with a
 * reason, which the borrower's own calls carry), and its minutes.
 */
function outreachCalls(
  loanKey: string,
  ledger: readonly LedgerRow[],
  promises: LoanScript["promises"],
  firstDue: PlainDate,
  end: PlainDate,
  who: (on: PlainDate) => Servicer,
): ContactRow[] {
  const ap: AppliedInstallment[] = ledger.map((i) => {
    const paid = i.status === "satisfied" || i.status === "prepaid";
    return {
      due_date: i.due,
      amount_cents: i.pi + i.escrow,
      satisfied_on: paid ? (i.credited_as_of ?? i.satisfied_on ?? null) : null,
      paid_cents: paid ? i.pi + i.escrow : 0n,
    };
  });
  const held = (on: PlainDate) =>
    promises.some(
      (p) =>
        p.made_on <= on &&
        on < p.pay_on &&
        daysBetween(p.made_on, p.pay_on) <= OUTREACH_PROMISE_MAX_DAYS,
    );
  const out: ContactRow[] = [];
  let status: "closed" | "active" | "ceased" = "closed";
  let nextDue: PlainDate = firstDue;
  for (let on = addDays(firstDue, OUTREACH_FIRST_DAY); on <= end;) {
    const days = regxDaysDelinquent(ap, on);
    if (days === 0) {
      // Cured, or never late: the next plan can open no sooner than an installment due later reaches day 17.
      status = "closed";
      const next = ap.find(
        (i) =>
          i.due_date > on &&
          (i.satisfied_on === null ||
            daysBetween(i.due_date, i.satisfied_on) >= OUTREACH_FIRST_DAY),
      );
      if (!next) break;
      on = addDays(next.due_date, OUTREACH_FIRST_DAY);
      continue;
    }
    if (held(on)) {
      if (status === "active") status = "ceased";
      on = addDays(on, 1);
      continue;
    }
    if (status === "ceased") {
      status = "active";
      nextDue = on;
    }
    if (status === "closed") {
      if (days < OUTREACH_FIRST_DAY) {
        on = addDays(on, OUTREACH_FIRST_DAY - days);
        continue;
      }
      status = "active";
      nextDue = on;
    }
    if (on >= nextDue) {
      const outcome = rngFor(`${loanKey}/out/${on}`).next() < 0.6 ? "no_answer" : "voicemail";
      out.push({
        on,
        direction: "outbound",
        reason: "collection_call",
        minutes: outcome === "voicemail" ? 1 : 0.5,
        servicer: who(on),
        outcome,
      });
      nextDue = rollForward(addDays(on, OUTREACH_CYCLE_DAYS), servicerCalendar);
    }
    on = addDays(on, 1);
  }
  return out;
}

/** The level payment at the note's own terms; exported for tests that check the schedule. */
export const notePayment = (d: LoanDraw): Cents =>
  levelPayment(d.orig_upb_cents, ratePercent(d.note_rate_pct), d.term_months);
