/**
 * The reference policy for arm-adjustment: the rulebook followed literally,
 * through the tools. Reading the index series, comparing two dates or two
 * rates, and writing a rate with its decimals are reading; every date step,
 * sum, eighth, balance and payment is a tool call. Calls that do not depend
 * on each other go together in one turn, as a model may make them. Held to
 * the grader on every generated task, it is the proof that each change can
 * be worked from the rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { ARM_SUBMIT_TOOL } from "./tools.js";

interface Pending {
  readonly name: string;
  readonly input: Json;
  readonly key: string;
}

/** Independent calls made together in one turn; their results read back by id, in order. */
let batches = 0;
function* together(calls: readonly Pending[]): Step<string[]> {
  if (calls.length === 0) return [];
  const batch = ++batches;
  const sent: ToolCall[] = calls.map((c, k) => ({
    id: `arm-${batch}-${k}`,
    name: c.name,
    input: c.input,
  }));
  const observations = yield sent;
  return sent.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return String((JSON.parse(o.content) as Record<string, unknown>)[calls[k]!.key]);
  });
}

const dateAdd = (date: string, months: number, days = 0): Pending => ({
  name: "date_add",
  input: { date, months, days },
  key: "date",
});
const daysBetween = (from: string, to: string): Pending => ({
  name: "days_between",
  input: { from, to },
  key: "days",
});
const wholeMonths = (from: string, to: string): Pending => ({
  name: "whole_months_between",
  input: { from, to },
  key: "months",
});
const calc = (expression: string): Pending => ({
  name: "calculate",
  input: { expression },
  key: "value",
});

/** A decimal string as an integer number of hundred-thousandths: comparing two is reading. */
const scaled = (x: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,5}))?$/.exec(x);
  if (!m) throw new Error(`not a decimal with at most five places: ${x}`);
  const v = BigInt(m[2]! + (m[3] ?? "").padEnd(5, "0"));
  return m[1] === "-" ? -v : v;
};
/** A decimal string written with exactly `places` decimals, where it has no more. */
const fixed = (x: string, places: number): string => {
  const [int, frac = ""] = x.split(".");
  if (frac.length > places) throw new Error(`${x} has more than ${places} decimals`);
  return `${int}.${frac.padEnd(places, "0")}`;
};

export function* armSteps(p: Json, _call: Call): Step<Json> {
  const loan = p["loan"] as Record<string, unknown>;
  const s = (k: string) => String(loan[k]);
  const basis = loan["schedule_basis"] as Record<string, unknown>;
  const change = String(p["change_date"]);
  const send = String(p["proposed_send_on"]);
  const first = change === s("first_change_date");
  const io = (loan["interest_only_until"] ?? null) as string | null;
  const term = Number(loan["term_months"]);
  const lookback = Number(loan["lookback_days"]);
  const estimate = loan["initial_disclosure_estimate"] === true;

  // Step 1, and the whole months Step 6 counts.
  const [indexDate, fnpd, maturity, nextChange, basisMonths] = yield* together([
    dateAdd(change, 0, -lookback),
    dateAdd(change, 1),
    dateAdd(s("first_payment_due"), term - 1),
    dateAdd(change, Number(loan["adjustment_period_months"])),
    wholeMonths(String(basis["from_due_date"]), change),
  ]);

  // Step 2: reading the series.
  const print = (p["index_series"] as { effective_date: string; value: string }[])
    .filter((e) => e.effective_date <= indexDate!)
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))[0];
  if (!print) throw new Error(`no index print on or before ${indexDate}`);

  // Step 3, Step 5's limits, the counts of Steps 1 and 6, and Step 8's day counts.
  const prior = s("current_rate_pct");
  const cap = first ? s("initial_cap_pct") : s("periodic_cap_pct");
  const ioBalance = io !== null && change <= io;
  const second = yield* together([
    calc(`${print.value} + ${s("margin_pct")}`),
    calc(`${prior} + ${cap}`),
    calc(`${prior} - ${cap}`),
    calc(`${s("initial_note_rate_pct")} + ${s("lifetime_cap_pct")}`),
    wholeMonths(fnpd!, maturity!),
    ...(ioBalance ? [] : [calc(`${basisMonths} + 1`)]),
    ...(first ? [daysBetween(s("consummation_date"), fnpd!)] : []),
    ...(first ? [daysBetween(s("consummation_date"), change)] : []),
  ]);
  const [unrounded, hi, lo, ceiling, remainingMonths] = second as [
    string,
    string,
    string,
    string,
    string,
  ];
  let k = 5;
  const n = ioBalance ? null : second[k++]!;
  const daysToFnpd = first ? Number(second[k++]) : null;
  const daysToChange = first ? Number(second[k++]) : null;

  // Step 8's kind, by reading.
  const kind =
    term <= 12
      ? "fnma_only"
      : first && daysToFnpd! <= 210 && !estimate
        ? "fnma_only"
        : first && daysToChange! <= 60 && estimate
          ? "c_first_25"
          : Number(loan["adjustment_period_months"]) <= 2 ||
              (s("consummation_date") < "2015-01-10" && lookback < 45)
            ? "c_25_120"
            : "c_60_120";
  const gated = kind === "c_60_120" || kind === "c_25_120";

  // Step 4's floor and remainder, Step 1's remaining term, Step 6's balance, Steps 8, 10 and 11's dates.
  const third = yield* together([
    calc(`floor(${unrounded} * 8)`),
    calc(`${unrounded} * 8 - floor(${unrounded} * 8)`),
    calc(`${remainingMonths} + 1`),
    ...(n === null
      ? []
      : [
          {
            name: "balance_after",
            input: {
              start_balance_cents: String(basis["upb_cents"]),
              annual_rate_pct: String(basis["rate_pct"]),
              payment_cents: String(basis["pi_cents"]),
              payments: Number(n),
            },
            key: "balance_cents",
          },
        ]),
    ...(gated ? [dateAdd(fnpd!, 0, -120)] : []),
    kind === "c_60_120"
      ? dateAdd(fnpd!, 0, -60)
      : kind === "fnma_only"
        ? dateAdd(change, 0, -25)
        : dateAdd(fnpd!, 0, -25),
    ...(kind === "fnma_only" ? [] : [dateAdd(change, 0, -25)]),
    ...(first ? [dateAdd(fnpd!, 0, -240), dateAdd(fnpd!, 0, -210)] : []),
  ]);
  const [f, remainder, remaining] = third as [string, string, string];
  let j = 3;
  const expected = n === null ? String(basis["upb_cents"]) : third[j++]!;
  const windowOpen = gated ? third[j++]! : null;
  const dueBy = third[j++]!;
  const fnmaBy = kind === "fnma_only" ? dueBy : third[j++]!;
  const initialOpen = first ? third[j++]! : null;
  const initialDue = first ? third[j++]! : null;

  // Step 4.
  const half = scaled("0.5");
  const midpoint = scaled(remainder) === half;
  const up =
    scaled(remainder) > half || (midpoint && loan["rounding_rule"] === "nearest_eighth_half_up");
  const [eighth] = yield* together([calc(up ? `(${f} + 1) / 8` : `${f} / 8`)]);
  const rounded = fixed(eighth!, 3);

  // Step 5, by reading.
  let rate = rounded;
  let bound = "none";
  if (scaled(rate) > scaled(hi)) {
    rate = fixed(hi, 3);
    bound = first ? "initial" : "periodic";
  } else if (scaled(rate) < scaled(lo)) {
    rate = fixed(lo, 3);
    bound = first ? "initial" : "periodic";
  }
  if (scaled(rate) > scaled(ceiling)) {
    rate = fixed(ceiling, 3);
    bound = "lifetime";
  }
  if (scaled(rate) < scaled(s("margin_pct"))) {
    rate = fixed(s("margin_pct"), 3);
    bound = "floor";
  }

  // Step 7.
  const interestOnly = io !== null && fnpd! <= io;
  const [payment] = yield* together([
    interestOnly
      ? calc(`round(${expected} * ${rate} / 1200)`)
      : {
          name: "level_payment",
          input: {
            principal_cents: expected,
            annual_rate_pct: rate,
            term_months: Number(remaining),
          },
          key: "payment_cents",
        },
  ]);

  // Step 9, by reading.
  const rateChanged = rate !== prior;
  const paymentChanged = payment !== s("current_pi_cents");
  const cease = loan["fdcpa_cease_on_file"] === true && loan["fdcpa_debt_collector"] === true;
  const template =
    rateChanged && paymentChanged && kind !== "fnma_only" && !cease
      ? "NTC_REGZ_20C_ARM_ADJ"
      : rateChanged || paymentChanged
        ? "NTC_FNMA_C2_1_02_RATE_CHANGE"
        : null;

  // Step 10.
  let outcome: string | null = null;
  let daysLate: number | null = null;
  if (template === "NTC_REGZ_20C_ARM_ADJ") {
    if (windowOpen !== null && send < windowOpen) outcome = "blocked";
    else if (send > dueBy) {
      outcome = "late";
      const [late] = yield* together([daysBetween(dueBy, send)]);
      daysLate = Number(late);
    } else outcome = "on_time";
  } else if (template !== null) outcome = send > fnmaBy ? "late" : "on_time";

  // Step 11.
  const status = !first
    ? null
    : term <= 12
      ? "exempt_short_term"
      : daysToFnpd! <= 210
        ? "originator_duty"
        : "servicer";

  return {
    index_date: indexDate,
    index_effective_date: print.effective_date,
    index_value: print.value,
    unrounded_pct: fixed(unrounded, 5),
    rounded_pct: rounded,
    midpoint_flag: midpoint,
    new_rate_pct: rate,
    bound,
    expected_upb_cents: expected,
    first_new_payment_due: fnpd,
    remaining_term_months: Number(remaining),
    next_change_date: nextChange,
    new_pi_cents: payment,
    notice_kind: kind,
    notice_window_open: windowOpen,
    notice_due_by: dueBy,
    notice_template: template,
    send_outcome: outcome,
    days_late: daysLate,
    initial_notice_status: status,
    initial_notice_window_open: initialOpen,
    initial_notice_due_by: initialDue,
  };
}

export class ArmReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:arm-rulebook", armSteps, ARM_SUBMIT_TOOL);
  }
}
