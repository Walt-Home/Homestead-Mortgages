/**
 * The grader is the servicing app's Metro 2 engine.
 *
 * `buildSnapshot`, `renderBase` and `validateSnapshot` are the ported
 * `metro2.ts` itself, and `applyFifo` the ported ledger. The engine takes
 * each month's loan state as its caller builds it, and the servicing app's
 * one caller (operations-runtime/runners.ts:141-145) fixes no convention for
 * a condition, a prior record or a ledger as of a month-end: it passes
 * condition none, no prior and no MIN. So the harness restates the
 * conventions the servicing app does keep, each with its line:
 *   (a) a month-end's ledger is FIFO over the receipts received on or before
 *       it, as early-intervention/ops.ts:40 builds its delinquency snapshot
 *       ("receipts after `as_of` are not yet in the ledger"). Over the whole
 *       ledger the engine's amount past due reads a later receipt as paid
 *       (metro2.ts:93), so the prefix is the only ledger it is right on;
 *   (b) a record that fails validation is omitted, and the next month
 *       carries it with D for its month, its PHP and its date of first
 *       delinquency (credit-reporting/ops.ts:170, :182 phpAfterOmission);
 *   (c) the actual payment is the receipts dated in the month and the
 *       date of last payment the latest receipt (operations-runtime/
 *       runners.ts:138-139), both on or before the month-end, per (a); a
 *       borrower's payoff funds count in both (8.1 rules 2 and 3: "total
 *       borrower payments posted"), but never enter the FIFO ledger,
 *       because the engine reads the payment rating at the closing date
 *       off that ledger (metro2.ts:161-165);
 *   (d) a forbearance plan's entry status and amount past due are the
 *       ledger's on the day before the plan's effective date, which v1
 *       always puts on a 1st (8.1 rule 13: 78 and $7,378.65 at 04-30 for a
 *       plan effective 05-01);
 *   (e) the last record before the first month is read the way a hand-off
 *       is (metro2.ts handoffHistory): a PHP shorter than 24 is padded with
 *       B;
 *   (f) a short sale's foreclosure had started when a foreclosure referral
 *       is in force at its month-end. v1 never dates one after the closing
 *       date, and the generator's guard refuses one that is.
 * The record is renderBase's, under the policy's rounding, which
 * buildSnapshot never reads itself.
 */

import { addDays, endOfMonth, plainDate, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { applyFifo, type AppliedInstallment } from "../pmi/ported/delinquency.js";
import {
  buildSnapshot,
  deriveDelinquency,
  handoffHistory,
  renderBase,
  statusForDays,
  validateSnapshot,
} from "./ported/metro2.js";
import type {
  AccountStatus,
  CreditLoanState,
  LoanCondition,
  Metro2Snapshot,
  PriorHistory,
} from "./ported/types.js";
import type { InForce, Metro2Month, Metro2Task } from "./task.js";

/** MMDDYYYY → YYYY-MM-DD; 00000000 → null. */
export function fromMetro2Date(s: string): PlainDate | null {
  if (s === "00000000") return null;
  return plainDate(`${s.slice(4, 8)}-${s.slice(0, 2)}-${s.slice(2, 4)}`);
}

export const asOfOf = (month: string): PlainDate => endOfMonth(plainDate(`${month}-01`));

/** (a): the ledger as of a date, over the receipts received on or before it. */
export function ledgerAsOf(task: Metro2Task, on: PlainDate): readonly AppliedInstallment[] {
  return applyFifo(
    task.installments,
    task.receipts.filter((r) => r.received_on <= on),
  ).installments;
}

const find = <K extends InForce["kind"]>(m: Metro2Month, kind: K) =>
  m.in_force.find((x) => x.kind === kind) as Extract<InForce, { kind: K }> | undefined;

/** The one plan, workout or closing in force at the month-end, as the engine's condition. */
export function conditionOf(task: Metro2Task, m: Metro2Month): LoanCondition {
  for (const e of m.in_force) {
    switch (e.kind) {
      case "forbearance_plan": {
        // (d): the entry figures are the ledger's on the day before the plan took effect.
        const before = addDays(e.effective_on, -1);
        const dq = deriveDelinquency(ledgerAsOf(task, before), before);
        return {
          kind: "forbearance",
          effective_on: e.effective_on,
          entry_status: statusForDays(dq.days),
          entry_amount_past_due_cents: dq.amount_past_due_cents,
          plan_payment_cents: e.plan_payment_cents,
        };
      }
      case "repayment_plan":
        return {
          kind: "repayment_plan",
          plan_payment_cents: e.plan_payment_cents,
          remaining_arrears_cents: e.remaining_arrears_cents,
        };
      case "trial_plan":
        return { kind: "trial", trial_payment_cents: e.trial_payment_cents };
      case "modification":
        return {
          kind: "modification",
          new_term_months: e.new_term_months,
          new_piti_cents: e.new_piti_cents,
        };
      case "payment_deferral":
        return { kind: "deferral" };
      case "payoff":
        return { kind: "paid_in_full", closed_on: e.closed_on, by_refinance: e.by_refinance };
      case "short_sale": {
        // (f)
        return {
          kind: "short_sale",
          closed_on: e.closed_on,
          foreclosure_started: find(m, "foreclosure_referral") !== undefined,
        };
      }
      case "foreclosure_sale":
        return {
          kind: "foreclosure_sale",
          closed_on: e.closed_on,
          deficiency_pursued: e.deficiency_pursued,
        };
      case "deed_in_lieu":
        return {
          kind: "deed_in_lieu",
          closed_on: e.closed_on,
          deficiency_pursued: e.deficiency_pursued,
        };
      case "foreclosure_referral":
        break;
    }
  }
  return { kind: "none" };
}

/** (e): the last record as the engine's prior history. */
export function priorOf(task: Metro2Task): PriorHistory | null {
  const r = task.last_record;
  if (!r) return null;
  return handoffHistory(
    r.payment_history_profile,
    fromMetro2Date(r.date_of_first_delinquency),
    r.account_status,
  );
}

/** The loan state the engine is handed for one month-end. */
export function stateFor(
  task: Metro2Task,
  m: Metro2Month,
  prior: PriorHistory | Metro2Snapshot | null,
): CreditLoanState {
  const asOf = asOfOf(m.month);
  const inLedger = task.receipts.filter((r) => r.received_on <= asOf);
  const payoff = find(m, "payoff");
  // (c)
  const inMonth = inLedger.filter((r) => r.received_on.slice(0, 7) === m.month);
  const paid: Cents =
    inMonth.reduce((a, r) => a + r.amount_cents, 0n) + (payoff ? payoff.payoff_funds_cents : 0n);
  const dates = [...inLedger.map((r) => r.received_on), ...(payoff ? [payoff.closed_on] : [])];
  const last = dates.length ? [...dates].sort().at(-1)! : null;
  return {
    loan_id: task.loan.loan_id,
    as_of: asOf,
    installments: ledgerAsOf(task, asOf),
    upb_cents: m.books.upb_cents,
    deferred_principal_cents: m.books.deferred_principal_cents,
    forborne_principal_cents: m.books.forborne_principal_cents,
    pi_cents: task.loan.pi_cents,
    escrow_cents: task.loan.escrow_cents,
    original_amount_cents: task.loan.original_amount_cents,
    note_date: task.loan.note_date,
    maturity_date: m.books.maturity_date,
    original_term_months: task.loan.original_term_months,
    remaining_term_months: m.books.remaining_term_months,
    interest_type: task.loan.interest_type,
    fnma_loan_number: m.books.fnma_loan_number,
    min: m.books.min,
    payments_in_month_cents: paid,
    last_payment_on: last,
    condition: conditionOf(task, m),
    foreclosure_referred: find(m, "foreclosure_referral") !== undefined,
    consumers: task.consumers,
    prior,
  };
}

/* ── the answer ─────────────────────────────────────────────────────────── */

export interface FurnishedRecord {
  readonly month: string;
  readonly furnished: true;
  readonly account_status: string;
  readonly payment_rating: string;
  readonly date_closed: string;
  readonly amount_past_due: string;
  readonly date_of_first_delinquency: string;
  readonly payment_history_profile: string;
  readonly special_comment: string;
  readonly current_balance: string;
  readonly scheduled_monthly_payment: string;
  readonly terms_duration: string;
  readonly k4: { readonly balloon_due_date: string; readonly balloon_amount: string } | null;
  readonly actual_payment_amount: string;
  readonly date_of_last_payment: string;
}

export interface OmittedRecord {
  readonly month: string;
  readonly furnished: false;
  readonly hard_errors: readonly string[];
}

export type MonthRecord = FurnishedRecord | OmittedRecord;

export interface ConsumerAnswer {
  readonly party_id: string;
  readonly segment: string;
  readonly ecoa: string;
  readonly special_comment: string;
}

export interface Metro2Answer {
  readonly records: readonly MonthRecord[];
  /** The consumer segments of the last furnished month. */
  readonly consumers: readonly ConsumerAnswer[];
}

/** What the generator's scope guard is shown as each month is built: the engine's own results. */
export interface FurnishingObserver {
  month?(m: Metro2Month, state: CreditLoanState, snapshot: Metro2Snapshot, errors: string[]): void;
}

export function recordOf(
  month: string,
  s: Metro2Snapshot,
  rounding: Metro2Task["policy"]["metro2_rounding"],
): FurnishedRecord {
  const r = renderBase(s, rounding);
  return {
    month,
    furnished: true,
    account_status: r["account_status"]!,
    payment_rating: r["payment_rating"]!,
    date_closed: r["date_closed"]!,
    amount_past_due: r["amount_past_due"]!,
    date_of_first_delinquency: r["date_of_first_delinquency"]!,
    payment_history_profile: r["payment_history_profile"]!,
    special_comment: r["special_comment"]!,
    current_balance: r["current_balance"]!,
    scheduled_monthly_payment: r["scheduled_monthly_payment"]!,
    terms_duration: r["terms_duration"]!,
    k4: s.k4
      ? { balloon_due_date: r["k4_balloon_due_date"]!, balloon_amount: r["k4_balloon_amount"]! }
      : null,
    actual_payment_amount: r["actual_payment_amount"]!,
    date_of_last_payment: r["date_of_last_payment"]!,
  };
}

/** Every month in order, each built on the one before (b). */
export function furnish(task: Metro2Task, observe: FurnishingObserver = {}): Metro2Answer {
  let prior: PriorHistory | Metro2Snapshot | null = priorOf(task);
  const records: MonthRecord[] = [];
  let consumers: ConsumerAnswer[] = [];
  for (const m of task.months) {
    const state = stateFor(task, m, prior);
    const s = buildSnapshot(state, task.policy);
    const errors = [...validateSnapshot(s)].sort();
    observe.month?.(m, state, s, errors);
    if (errors.length > 0) {
      records.push({ month: m.month, furnished: false, hard_errors: errors });
      prior = { php: s.php, status: null, dofd: s.dofd, omitted: true };
      continue;
    }
    records.push(recordOf(m.month, s, task.policy.metro2_rounding));
    consumers = s.consumers.map((c) => ({
      party_id: c.party_id,
      segment: c.segment,
      ecoa: c.ecoa,
      special_comment: c.special_comment,
    }));
    prior = s;
  }
  return { records, consumers };
}

export const expectedMetro2 = (task: Metro2Task): Metro2Answer => furnish(task);

/** How the window ends: the last month's account status, or that it was not furnished. */
export function metro2Verdict(task: Metro2Task): string {
  const last = expectedMetro2(task).records.at(-1)!;
  return last.furnished ? `ends ${last.account_status}` : "ends omitted";
}

/* ── grading ──────────────────────────────────────────────────────────────
 * A furnished month is seven fields, each standing or falling whole, so a
 * field that is constant on most months rides with the one that decides it:
 *   status             account status, payment rating and date closed;
 *   amount_past_due;
 *   dofd               date of first delinquency;
 *   php                payment history profile, graded against the
 *                      engine's own chain: a wrong status, or a month
 *                      furnished that should be omitted (or the reverse),
 *                      sits in every later month's PHP in the window, one
 *                      position deeper each month, and costs each of them,
 *                      as it would at the bureaus. An error in the first
 *                      month of six costs five later PHPs; in the last,
 *                      none;
 *   special_comment;
 *   terms_and_balance  current balance, scheduled payment, terms duration
 *                      and K4, which move together at a forbearance, a
 *                      workout and a closing. On a closing month the
 *                      scheduled payment is left out: the engine keeps the
 *                      PITI there and the spec says nothing of it;
 *   payments           actual payment and date of last payment.
 * An omitted month is the same seven fields, each right only when the
 * answer omits the month with the same hard errors, so furnishing a month
 * that should be omitted costs what omitting one that should be furnished
 * does. The consumer segments of the last furnished month are one field. A
 * month answered that the task does not have is a field of its own, wrong.
 */

export const GROUPS = [
  "status",
  "amount_past_due",
  "dofd",
  "php",
  "special_comment",
  "terms_and_balance",
  "payments",
] as const;
export type Group = (typeof GROUPS)[number];

const CLOSED = new Set<string>(["13", "65", "89", "94"]);

function groupOf(r: FurnishedRecord, g: Group, closing: boolean): unknown {
  switch (g) {
    case "status":
      return {
        account_status: r.account_status,
        payment_rating: r.payment_rating,
        date_closed: r.date_closed,
      };
    case "amount_past_due":
      return r.amount_past_due;
    case "dofd":
      return r.date_of_first_delinquency;
    case "php":
      return r.payment_history_profile;
    case "special_comment":
      return r.special_comment;
    case "terms_and_balance":
      return {
        current_balance: r.current_balance,
        ...(closing ? {} : { scheduled_monthly_payment: r.scheduled_monthly_payment }),
        terms_duration: r.terms_duration,
        k4: r.k4,
      };
    case "payments":
      return {
        actual_payment_amount: r.actual_payment_amount,
        date_of_last_payment: r.date_of_last_payment,
      };
  }
}

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
const omittedText = (r: OmittedRecord) => `omitted: ${r.hard_errors.join(",")}`;

export function gradeMetro2Against(want: Metro2Answer, answer: Metro2Answer | null): Grade {
  const fields: FieldGrade[] = [];
  const check = (field: string, expected: string, got: string | null) =>
    fields.push({
      field,
      expected,
      got: answer ? got : null,
      ok: answer !== null && got === expected,
    });
  for (const w of want.records) {
    const a = answer?.records.find((x) => x.month === w.month) ?? null;
    // The groups of the answer's record judged as the expected one is: a closing month by the engine's status.
    const closing = w.furnished && CLOSED.has(w.account_status);
    const shown = (g: Group): string | null =>
      a === null ? null : a.furnished ? canon(groupOf(a, g, closing)) : omittedText(a);
    for (const g of GROUPS)
      check(
        `month[${w.month}].${g}`,
        w.furnished ? canon(groupOf(w, g, closing)) : omittedText(w),
        shown(g),
      );
  }
  const months = new Set(want.records.map((r) => r.month));
  for (const a of answer?.records ?? [])
    if (!months.has(a.month)) check(`month[${a.month}]`, "no such month", "answered");
  // The segments in any order: the answer carries no position to order them by.
  const byParty = (cs: readonly ConsumerAnswer[]) =>
    [...cs].sort((a, b) => (a.party_id < b.party_id ? -1 : a.party_id > b.party_id ? 1 : 0));
  check(
    "consumers",
    canon(byParty(want.consumers)),
    answer ? canon(byParty(answer.consumers)) : null,
  );
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeMetro2 = (task: Metro2Task, answer: Metro2Answer | null): Grade =>
  gradeMetro2Against(expectedMetro2(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  "11",
  "71",
  "78",
  "80",
  "82",
  "83",
  "84",
  "13",
  "65",
  "89",
  "94",
  "97",
  "05",
];
export const PAYMENT_RATINGS = ["", "0", "1", "2", "3", "4", "5", "6"] as const;
export const SPECIAL_COMMENTS = [
  "",
  "CP",
  "AC",
  "CO",
  "AW",
  "BO",
  "AU",
  "AS",
  "BA",
  "H",
  "AZ",
] as const;
export const HARD_ERRORS = [
  "APD_WITH_CLOSED_STATUS",
  "DOFD_REQUIRED",
  "K3_FNMA_LOAN_NUMBER",
  "K3_MIN_MISSING",
  "MIN_NOT_18_DIGITS",
  "NO_CONSUMER_SEGMENT",
  "PAYMENT_RATING_REQUIRED",
  "PHP_LENGTH",
  "STATUS_11_WITH_DOFD",
] as const;
export const SEGMENTS = ["base", "J1", "J2"] as const;
export const ECOA_CODES = ["1", "2", "5", "X", "Z", "T"] as const;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONEY = /^\d{9}$/;
const DATE8 = /^\d{8}$/;
const TERMS = /^\d{3}$/;
const PHP = /^[0-6GHJKLBDE]{24}$/;

const FURNISHED_KEYS = [
  "month",
  "furnished",
  "account_status",
  "payment_rating",
  "date_closed",
  "amount_past_due",
  "date_of_first_delinquency",
  "payment_history_profile",
  "special_comment",
  "current_balance",
  "scheduled_monthly_payment",
  "terms_duration",
  "k4",
  "actual_payment_amount",
  "date_of_last_payment",
];
const OMITTED_KEYS = ["month", "furnished", "hard_errors"];
const CONSUMER_KEYS = ["party_id", "segment", "ecoa", "special_comment"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const extraKey = (o: Record<string, unknown>, allowed: readonly string[]): string | undefined =>
  Object.keys(o).find((k) => !allowed.includes(k));
const missingKey = (o: Record<string, unknown>, required: readonly string[]): string | undefined =>
  required.find((k) => !(k in o));
const oneOf = (v: unknown, xs: readonly string[]): v is string =>
  typeof v === "string" && xs.includes(v);

export function parseMetro2Submission(raw: unknown): Parsed<Metro2Answer> {
  const fail = (error: string): Parsed<Metro2Answer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_records again.`,
  });
  if (!isObject(raw)) return fail("the submission must be an object");
  const extra = extraKey(raw, ["records", "consumers"]);
  if (extra) return fail(`the submission has no field ${JSON.stringify(extra)}`);
  if (!Array.isArray(raw["records"])) return fail("records must be a list, one entry per month");
  const records: MonthRecord[] = [];
  const seen = new Set<string>();
  for (const r of raw["records"] as unknown[]) {
    if (!isObject(r)) return fail("each record must be an object");
    const month = r["month"];
    if (typeof month !== "string" || !MONTH.test(month))
      return fail("each record needs its month, YYYY-MM");
    if (seen.has(month)) return fail(`month ${month} is listed twice; give one record per month`);
    seen.add(month);
    if (r["furnished"] === false) {
      const x = extraKey(r, OMITTED_KEYS) ?? missingKey(r, OMITTED_KEYS);
      if (x)
        return fail(
          `month ${month}: an omitted record has exactly month, furnished and hard_errors (${x})`,
        );
      const errs = r["hard_errors"];
      if (!Array.isArray(errs) || errs.length === 0 || !errs.every((e) => oneOf(e, HARD_ERRORS)))
        return fail(
          `month ${month}: hard_errors must be a non-empty list of ${HARD_ERRORS.join(", ")}`,
        );
      if (new Set(errs).size !== errs.length)
        return fail(`month ${month}: a hard error is listed twice`);
      records.push({ month, furnished: false, hard_errors: [...(errs as string[])].sort() });
      continue;
    }
    if (r["furnished"] !== true) return fail(`month ${month}: furnished must be true or false`);
    const x = extraKey(r, FURNISHED_KEYS) ?? missingKey(r, FURNISHED_KEYS);
    if (x)
      return fail(
        `month ${month}: a furnished record has exactly the fields the schema names (${x})`,
      );
    const at = (what: string) => fail(`month ${month}: ${what}`);
    if (!oneOf(r["account_status"], ACCOUNT_STATUSES))
      return at(`account_status must be one of ${ACCOUNT_STATUSES.join(", ")}`);
    if (!oneOf(r["payment_rating"], PAYMENT_RATINGS))
      return at('payment_rating must be "" or a digit from 0 to 6');
    if (!oneOf(r["special_comment"], SPECIAL_COMMENTS))
      return at(
        `special_comment must be one of ${SPECIAL_COMMENTS.map((c) => JSON.stringify(c)).join(", ")}`,
      );
    for (const k of [
      "amount_past_due",
      "current_balance",
      "scheduled_monthly_payment",
      "actual_payment_amount",
    ])
      if (typeof r[k] !== "string" || !MONEY.test(r[k] as string))
        return at(`${k} must be 9 digits of whole dollars, e.g. "000002459"`);
    for (const k of ["date_closed", "date_of_first_delinquency", "date_of_last_payment"])
      if (typeof r[k] !== "string" || !DATE8.test(r[k] as string))
        return at(`${k} must be MMDDYYYY, or "00000000"`);
    if (typeof r["terms_duration"] !== "string" || !TERMS.test(r["terms_duration"]))
      return at('terms_duration must be 3 digits, e.g. "360"');
    if (typeof r["payment_history_profile"] !== "string" || !PHP.test(r["payment_history_profile"]))
      return at("payment_history_profile must be 24 characters of 0-6, B, D, E, G, H, J, K or L");
    const k4 = r["k4"];
    let k4Out: FurnishedRecord["k4"] = null;
    if (k4 !== null) {
      if (
        !isObject(k4) ||
        extraKey(k4, ["balloon_due_date", "balloon_amount"]) ||
        typeof k4["balloon_due_date"] !== "string" ||
        !DATE8.test(k4["balloon_due_date"]) ||
        typeof k4["balloon_amount"] !== "string" ||
        !MONEY.test(k4["balloon_amount"])
      )
        return at("k4 must be null, or balloon_due_date (MMDDYYYY) and balloon_amount (9 digits)");
      k4Out = { balloon_due_date: k4["balloon_due_date"], balloon_amount: k4["balloon_amount"] };
    }
    records.push({
      month,
      furnished: true,
      account_status: r["account_status"],
      payment_rating: r["payment_rating"],
      date_closed: r["date_closed"] as string,
      amount_past_due: r["amount_past_due"] as string,
      date_of_first_delinquency: r["date_of_first_delinquency"] as string,
      payment_history_profile: r["payment_history_profile"],
      special_comment: r["special_comment"],
      current_balance: r["current_balance"] as string,
      scheduled_monthly_payment: r["scheduled_monthly_payment"] as string,
      terms_duration: r["terms_duration"],
      k4: k4Out,
      actual_payment_amount: r["actual_payment_amount"] as string,
      date_of_last_payment: r["date_of_last_payment"] as string,
    });
  }
  if (!Array.isArray(raw["consumers"]))
    return fail("consumers must be a list: the last furnished month's consumer segments");
  const consumers: ConsumerAnswer[] = [];
  const parties = new Set<string>();
  for (const c of raw["consumers"] as unknown[]) {
    if (!isObject(c)) return fail("each consumer must be an object");
    const x = extraKey(c, CONSUMER_KEYS) ?? missingKey(c, CONSUMER_KEYS);
    if (x)
      return fail(`each consumer has exactly party_id, segment, ecoa and special_comment (${x})`);
    if (typeof c["party_id"] !== "string" || c["party_id"] === "")
      return fail("each consumer needs its party_id");
    if (parties.has(c["party_id"]))
      return fail(`consumer ${c["party_id"]} is listed twice; give one segment per consumer`);
    parties.add(c["party_id"]);
    if (!oneOf(c["segment"], SEGMENTS)) return fail("a consumer's segment must be base, J1 or J2");
    if (!oneOf(c["ecoa"], ECOA_CODES))
      return fail(`a consumer's ecoa must be one of ${ECOA_CODES.join(", ")}`);
    if (!oneOf(c["special_comment"], SPECIAL_COMMENTS))
      return fail("a consumer's special_comment must be one the schema names");
    consumers.push({
      party_id: c["party_id"],
      segment: c["segment"],
      ecoa: c["ecoa"],
      special_comment: c["special_comment"],
    });
  }
  return {
    ok: true,
    answer: {
      records: records.sort((a, b) => (a.month < b.month ? -1 : 1)),
      consumers,
    },
  };
}
