/**
 * The reference policy for pmi-termination: the rulebook followed literally,
 * through the tools. Reading a date, an amount or a flag is reading; every
 * payment, balance, sum, rounding and date is a tool call. The 78% row is
 * found by halving the range of rows, as Step 3 allows, so a 360-row
 * schedule costs about nine balances, and calls that do not wait on one
 * another are made together in one turn. Held to the grader on every
 * generated task, it is the proof that each task can be solved from the
 * rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { PMI_SUBMIT_TOOL } from "./tools.js";

interface Want {
  readonly name: string;
  readonly input: Json;
  readonly key: string;
}

/** Independent calls made together in one turn, as a model may make them; read back by id. */
let batches = 0;
function* together(wants: readonly Want[]): Step<string[]> {
  if (wants.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = wants.map((w, k) => ({
    id: `pmi-${batch}-${k}`,
    name: w.name,
    input: w.input,
  }));
  const observations = yield calls;
  return calls.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return String((JSON.parse(o.content) as Record<string, unknown>)[wants[k]!.key]);
  });
}

const dateAdd = (date: string, months: number, days = 0): Want => ({
  name: "date_add",
  input: { date, months, days },
  key: "date",
});
const calcOf = (expression: string): Want => ({
  name: "calculate",
  input: { expression },
  key: "value",
});
const daysBetween = (from: string, to: string): Want => ({
  name: "days_between",
  input: { from, to },
  key: "days",
});
const businessDays = (date: string, days: number): Want => ({
  name: "add_business_days",
  input: { date, days },
  key: "date",
});
const levelPayment = (principal: string, rate: string, months: number): Want => ({
  name: "level_payment",
  input: { principal_cents: principal, annual_rate_pct: rate, term_months: months },
  key: "payment_cents",
});
const balanceAfter = (start: string, rate: string, payment: string, payments: number): Want => ({
  name: "balance_after",
  input: {
    start_balance_cents: start,
    annual_rate_pct: rate,
    payment_cents: payment,
    payments,
  },
  key: "balance_cents",
});

const firstOf = (d: string) => `${d.slice(0, 7)}-01`;
const ym = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const later = (a: string, b: string | null | undefined) => (b && b > a ? b : a);
const big = (x: string | number | bigint) => BigInt(x);

/** One version of the schedule: its rows' balance is balance_after(start, rate, pi, n − offset), from row `first`. */
interface Version {
  readonly first: number;
  readonly last: number;
  readonly start: string;
  readonly rate: string;
  readonly pi: string;
  /** Rows up to here are interest-only: their balance is the start. */
  readonly ioThrough: number;
  /** balance after row n = balance_after(start, rate, pi, n − offset). */
  readonly offset: number;
  /** Row n is due firstDue + (n − firstN) months. */
  readonly firstDue: string;
  readonly firstN: number;
}

interface Applied {
  readonly due: string;
  satisfied: string | null;
}

export function* pmiSteps(p: Json, _call: Call): Step<Json> {
  const loan = p["loan"] as Record<string, unknown>;
  const s = (k: string) => String(loan[k]);
  const asOf = String(p["as_of"]);
  const mi = p["mi"] as Record<string, unknown>;
  const mod = p["modification"] as Record<string, unknown> | null;
  const changes = p["rate_changes"] as { payment_number: number; new_rate_pct: string }[];
  const request = p["request"] as Record<string, unknown> | null;
  const ledger = p["ledger"] as {
    from: string;
    installments: { due_date: string; amount_cents: number | string }[];
    receipts: { received_on: string; amount_cents: number | string }[];
  };

  // Step 1
  const ov =
    loan["is_refinance"] === true
      ? s("appraised_value_cents")
      : big(s("sales_price_cents")) < big(s("appraised_value_cents"))
        ? s("sales_price_cents")
        : s("appraised_value_cents");
  const units = Number(loan["units"]);
  const occupancy = s("occupancy_at_origination");
  const rule78 =
    s("consummation") >= "1999-07-29" &&
    units === 1 &&
    (occupancy === "principal" || occupancy === "second_home");
  const propertyClass =
    occupancy === "investment" ? "investment" : units === 1 ? "one-unit" : "two-to-four";

  // Steps 2, 3 and 4, the first turn: the note's P&I, the threshold and the midpoint wait on nothing.
  const io = Number(loan["io_months"]);
  const term = Number(loan["amortizing_term_months"]);
  const total = io + term;
  const [governingDue, governingTerm] = mod
    ? [String(mod["first_modified_due"]), Number(mod["term_months"])]
    : [s("first_payment_due"), total];
  const [pi0, threshold, midpointTermination] = yield* together([
    levelPayment(s("original_principal_cents"), s("note_rate_pct"), term),
    calcOf(`round(${ov} * 78 / 100)`),
    // The amortization start (first due − 1 month) + term ÷ 2 months is the midpoint, a 1st; the
    // termination is the 1st after it: first due + term ÷ 2 months.
    dateAdd(governingDue, governingTerm / 2),
  ]);

  // Step 2: the schedule in effect.
  let version: Version = {
    first: 1,
    last: total,
    start: s("original_principal_cents"),
    rate: s("note_rate_pct"),
    pi: pi0!,
    ioThrough: io,
    offset: io,
    firstDue: s("first_payment_due"),
    firstN: 1,
  };
  const balanceOf = (v: Version, n: number): Want | string =>
    n <= v.ioThrough ? v.start : balanceAfter(v.start, v.rate, v.pi, n - v.offset);
  for (const rc of changes) {
    const k = rc.payment_number;
    const before = balanceOf(version, k - 1);
    const [start] = typeof before === "string" ? [before] : yield* together([before]);
    const remaining = total - (k - 1);
    const [pi] = yield* together([levelPayment(start!, rc.new_rate_pct, remaining)]);
    version = {
      first: k,
      last: total,
      start: start!,
      rate: rc.new_rate_pct,
      pi: pi!,
      ioThrough: 0,
      offset: k - 1,
      firstDue: version.firstDue,
      firstN: 1,
    };
  }
  let forborne = "0";
  if (mod) {
    const [pi] = yield* together([
      levelPayment(
        String(mod["ib_upb_cents"]),
        String(mod["rate_pct"]),
        Number(mod["term_months"]),
      ),
    ]);
    forborne = String(mod["forborne_principal_cents"]);
    version = {
      first: 1,
      last: Number(mod["term_months"]),
      start: String(mod["ib_upb_cents"]),
      rate: String(mod["rate_pct"]),
      pi: pi!,
      ioThrough: 0,
      offset: 0,
      firstDue: String(mod["first_modified_due"]),
      firstN: 1,
    };
  }

  // Step 3: the first row at or below the threshold, by halving.
  let row78: number | null = null;
  let date78: string | null = null;
  const target =
    forborne === "0" ? threshold! : (yield* together([calcOf(`${threshold} - ${forborne}`)]))[0]!;
  if (big(target) >= 0n) {
    let lo = Math.max(version.first, version.ioThrough + 1) - 1; // above the target
    let hi = version.last; // the last row's balance is 0
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const w = balanceOf(version, mid);
      const [bal] = typeof w === "string" ? [w] : yield* together([w]);
      if (big(bal!) <= big(target)) hi = mid;
      else lo = mid;
    }
    row78 = hi;
    date78 = (yield* together([dateAdd(version.firstDue, hi - version.firstN)]))[0]!;
  }

  // Step 5
  const trigger =
    !rule78 || date78 === null
      ? midpointTermination!
      : date78 < midpointTermination!
        ? date78
        : midpointTermination!;
  const position = {
    original_value_cents: ov,
    rule_78_applies: rule78,
    pi_cents: version.pi,
    scheduled_78_payment_number: row78,
    scheduled_78_date: date78,
    midpoint_termination_date: midpointTermination!,
    trigger_date: trigger,
  };

  // Step 6: the ledger, oldest first. Sums and differences are worked out; equal amounts are read.
  const installments: Applied[] = [...ledger.installments]
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
    .map((i) => ({ due: i.due_date, satisfied: null }));
  const amounts = new Map(ledger.installments.map((i) => [i.due_date, String(i.amount_cents)]));
  const receipts = ledger.receipts
    .map((r, k) => ({ ...r, k }))
    .sort((a, b) =>
      a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : a.k - b.k,
    );
  let held = "0";
  let next = 0;
  for (const rc of receipts) {
    const amount = String(rc.amount_cents);
    held = held === "0" ? amount : (yield* together([calcOf(`${held} + ${amount}`)]))[0]!;
    while (next < installments.length && big(held) >= big(amounts.get(installments[next]!.due)!)) {
      const owed = amounts.get(installments[next]!.due)!;
      held = held === owed ? "0" : (yield* together([calcOf(`${held} - ${owed}`)]))[0]!;
      installments[next]!.satisfied = rc.received_on;
      next++;
    }
  }

  const NONE = {
    request: null,
    automatic: null,
    termination: null,
    lpmi_options_notice_due: null,
  };
  let effective: string | null = null;
  let anchor: string | null = null;
  let code: string | null = null;
  let requestAnswer: Json | null = null;
  let automatic: Json | null = null;

  if (request) {
    // Step 7
    const received = String(request["received_on"]);
    const evidence = (request["evidence_satisfied_on"] ?? null) as string | null;
    const valuation = request["valuation"] as { value_cents: number; delivered_on: string } | null;
    const balance = request["balance"] as {
      upb_on_receipt_cents: number;
      postings: { posted_on: string; upb_after_cents: number }[];
      deferred_principal_cents: number;
      forborne_principal_cents: number;
    };
    const path = String(request["path"]);
    const extra = big(balance.deferred_principal_cents) + big(balance.forborne_principal_cents);
    const evaluationOf = (b: string | number): Want | string =>
      extra === 0n
        ? String(b)
        : calcOf(
            `${b} + ${balance.deferred_principal_cents} + ${balance.forborne_principal_cents}`,
          );
    const n0 = ym(received) - ym(s("consummation"));
    // The balances that matter: on the original-value path the receipt's and every posting's (the
    // threshold may be reached at any of them); on the current-value path only the last.
    const balances = [
      balance.upb_on_receipt_cents,
      ...balance.postings.map((x) => x.upb_after_cents),
    ].slice(path === "original_value" ? 0 : -1);
    const evalWants = balances.map(evaluationOf);
    const wants: Want[] = [
      dateAdd(later(received, evidence), 0, 30),
      dateAdd(s("consummation"), n0),
      dateAdd(firstOf(received), 0, -1),
      ...(valuation ? [dateAdd(valuation.delivered_on, 0, 120)] : []),
    ];
    const got = yield* together([
      ...wants,
      ...evalWants.filter((w): w is Want => typeof w !== "string"),
    ]);
    const [decisionDue, ageProbe, precedingEnd] = got as [string, string, string];
    const validUntil = valuation ? got[3]! : null;
    // 7, read first: a refused request reports nothing it would otherwise have evaluated.
    if (valuation && asOf > validUntil!) {
      return {
        position,
        request: {
          evaluation_upb_cents: null,
          threshold_bps: null,
          ltv_bps: null,
          fnma_current: null,
          late30_12m: null,
          late60_24m: null,
          result: "refused",
          reasons: ["VALUATION_EXPIRED"],
          decision_due: decisionDue,
        },
        automatic: null,
        termination: null,
        lpmi_options_notice_due: null,
      };
    }
    let cursor = wants.length;
    const evals = evalWants.map((w) => (typeof w === "string" ? w : got[cursor++]!));
    const evaluationUpb = evals[evals.length - 1]!;
    const age = ageProbe <= received ? n0 : n0 - 1;

    // 4: the threshold on the original-value path, and the date it was reached.
    const originalTh = propertyClass === "one-unit" ? 8000 : 7000;
    let reachedOn: string | null = null;
    let ltvs: string[] = [];
    if (path === "original_value") {
      ltvs = yield* together(evals.map((e) => calcOf(`floor(${e} * 10000 / ${ov})`)));
      const at = ltvs.findIndex((l) => Number(l) <= originalTh);
      reachedOn = at < 0 ? null : at === 0 ? received : balance.postings[at - 1]!.posted_on;
    }
    const D = reachedOn && reachedOn > received ? reachedOn : received;

    // 5: the windows.
    const [bStart, aStart] = yield* together([
      dateAdd(D, -Math.min(12, age)),
      dateAdd(D, -Math.min(24, age)),
    ]);
    const excluded = new Set(request["disaster_excluded"] as string[]);
    const window = installments.filter(
      (i) => i.due >= aStart! && i.due < D && !excluded.has(i.due),
    );
    const needsCount = window.filter(
      (i) => i.satisfied === null || i.satisfied > `${i.due.slice(0, 7)}-28`,
    );
    const counted = yield* together(needsCount.map((i) => daysBetween(i.due, i.satisfied ?? D)));
    const daysLate = new Map(needsCount.map((i, k) => [i.due, Number(counted[k])]));
    const lateOf = (i: Applied) => daysLate.get(i.due) ?? 0;
    const late30 = window.filter((i) => i.due >= bStart! && lateOf(i) >= 30).length;
    const late60 = window.filter((i) => lateOf(i) >= 60).length;
    const historyReason =
      late30 > 0
        ? "PAYMENT_HISTORY_30_12M"
        : window.some((i) => i.due < bStart! && lateOf(i) >= 60)
          ? "PAYMENT_HISTORY_60_24M"
          : null;

    // 6
    const fnmaCurrent = installments
      .filter((i) => i.due < precedingEnd)
      .every((i) => i.satisfied !== null && i.satisfied <= precedingEnd);

    const evaluated = {
      evaluation_upb_cents: evaluationUpb,
      fnma_current: fnmaCurrent,
      late30_12m: late30,
      late60_24m: late60,
    };
    {
      // 8
      let th: number | null;
      let value: string | null;
      if (path === "original_value") {
        th = originalTh;
        value = ov;
      } else {
        th =
          propertyClass === "one-unit"
            ? request["improvements_accepted"] === true
              ? 8000
              : age >= 60
                ? 8000
                : age >= 24
                  ? 7500
                  : null
            : age >= 24
              ? 7000
              : null;
        value = valuation ? String(valuation.value_cents) : null;
      }
      if (value === null) {
        requestAnswer = {
          ...evaluated,
          threshold_bps: th,
          ltv_bps: null,
          result: "value_check_needed",
          reasons: ["VALUATION_REQUIRED"],
          decision_due: decisionDue,
        };
      } else {
        // On the original-value path the evaluation balance is the last balance, its LTV already worked out.
        const ltv = Number(
          path === "original_value"
            ? ltvs[ltvs.length - 1]!
            : (yield* together([calcOf(`floor(${evaluationUpb} * 10000 / ${value})`)]))[0]!,
        );
        // 9
        const reasons: string[] = [];
        if (th === null) reasons.push("SEASONING_INSUFFICIENT");
        else if (ltv > th)
          reasons.push(
            path === "original_value" ? "LTV_ABOVE_THRESHOLD" : "LTV_ABOVE_THRESHOLD_CURRENT",
          );
        if (!fnmaCurrent) reasons.push("NOT_CURRENT");
        if (historyReason) reasons.push(historyReason);
        const answered = {
          ...evaluated,
          threshold_bps: th,
          ltv_bps: ltv,
          decision_due: decisionDue,
        };
        if (reasons.length > 0) {
          requestAnswer = { ...answered, result: "ineligible", reasons };
        } else if (path === "original_value") {
          // 10
          const checked =
            valuation !== null
              ? String(valuation.value_cents)
              : request["avm_cents"] == null
                ? null
                : String(request["avm_cents"]);
          if (checked === null || big(checked) < big(ov)) {
            requestAnswer = {
              ...answered,
              result: "value_check_needed",
              reasons: ["VALUE_DECLINED_OR_UNKNOWN"],
            };
          } else {
            requestAnswer = { ...answered, result: "eligible", reasons: [] };
            effective = later(later(received, reachedOn), evidence);
            code = "51";
          }
        } else {
          // 11
          requestAnswer = { ...answered, result: "eligible", reasons: [] };
          effective = later(received, valuation!.delivered_on);
          code = "52";
        }
        // 12
        if (effective) anchor = later(received, evidence);
      }
    }
  } else if (mi["plan"] === "lender_paid") {
    // Step 9
    if (asOf < trigger) return { position, ...NONE };
    const [notice] = yield* together([dateAdd(trigger, 0, 30)]);
    return { position, ...NONE, lpmi_options_notice_due: notice };
  } else {
    // Step 8
    if (asOf < trigger) return { position, ...NONE };
    const T = trigger;
    const testFirst = (() => {
      const m = ym(T) - 1;
      return `${String(Math.floor(m / 12)).padStart(4, "0")}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    })();
    const [testEnd, notice] = yield* together([dateAdd(T, 0, -1), dateAdd(T, 0, 30)]);
    const failing = installments.filter(
      (i) => i.due <= testFirst && (i.satisfied === null || i.satisfied > testEnd!),
    );
    if (failing.length === 0) {
      automatic = {
        current_on_trigger: true,
        not_current_installments: [],
        not_current_notice_due: null,
        cure_on: null,
      };
      effective = T;
    } else {
      let c: string | null = T;
      for (;;) {
        const due = installments.filter((i) => i.due <= c!);
        if (due.some((i) => i.satisfied === null)) {
          c = null;
          break;
        }
        const L = due.reduce((a, i) => (i.satisfied! > a ? i.satisfied! : a), T);
        if (L <= c) break;
        c = L;
      }
      automatic = {
        current_on_trigger: false,
        not_current_installments: failing.map((i) => i.due),
        not_current_notice_due: notice,
        cure_on: c,
      };
      if (c) effective = (yield* together([dateAdd(firstOf(c), 1)]))[0]!;
    }
    code = "53";
    anchor = effective;
  }

  if (!effective) {
    return {
      position,
      request: requestAnswer,
      automatic,
      termination: null,
      lpmi_options_notice_due: null,
    };
  }

  // Step 10: the clocks, and what the refund needs, together.
  const E = effective;
  const plan = String(mi["plan"]);
  const premium = String(mi["premium_cents"]);
  const coverage = String(mi["coverage_start"]);
  const yearsBack = Math.max(0, Number(E.slice(0, 4)) - Number(coverage.slice(0, 4)));
  const monthsIn = ym(E) - ym(coverage);
  const refundWants: Want[] =
    plan === "monthly"
      ? E.endsWith("-01")
        ? []
        : [daysBetween(firstOf(E), E)]
      : plan === "annual"
        ? [dateAdd(coverage, 12 * yearsBack), dateAdd(coverage, 12 * Math.max(0, yearsBack - 1))]
        : [dateAdd(coverage, monthsIn)];
  const [notice, stop, refund, insurer, escrow, ...refundGot] = yield* together([
    dateAdd(E, 0, 30),
    dateAdd(anchor!, 0, 30),
    dateAdd(E, 0, 45),
    businessDays(E, 2),
    businessDays(E, 10),
    ...refundWants,
  ]);
  let expression: string;
  if (plan === "monthly") {
    const days = Math.min(30, refundGot.length ? Number(refundGot[0]) : 0);
    expression = `round(${premium} * (30 - ${days}) / 30)`;
  } else if (plan === "annual") {
    const anniversary = refundGot[0]! <= E ? refundGot[0]! : refundGot[1]!;
    const [days] = yield* together([daysBetween(anniversary, E)]);
    expression = `round(${premium} * (365 - ${Math.min(365, Number(days))}) / 365)`;
  } else {
    const months = refundGot[0]! <= E ? monthsIn : monthsIn - 1;
    const rows = (mi["refund_schedule"] as { months_in_force_from: number; refund_pct: string }[])
      .filter((r) => r.months_in_force_from <= months)
      .sort((a, b) => b.months_in_force_from - a.months_in_force_from);
    expression = `round(${premium} * ${rows[0]!.refund_pct} / 100)`;
  }
  const [unearned] = yield* together([calcOf(expression)]);
  const [y, m, d] = E.split("-");
  return {
    position,
    request: requestAnswer,
    automatic,
    termination: {
      effective_on: E,
      lar89_action_code: code,
      lar89_action_date: `${m}${d}${y!.slice(2)}`,
      notice_due: notice,
      premium_stop_by: stop,
      refund_due: refund,
      insurer_notice_due: insurer,
      escrow_interim_analysis_due: escrow,
      unearned_premium_cents: unearned,
    },
    lpmi_options_notice_due: null,
  };
}

export class PmiReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:pmi-rulebook", pmiSteps, PMI_SUBMIT_TOOL);
  }
}
