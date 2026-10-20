/**
 * The reference policy for refi-tape: Step 0 through the tools, then the
 * review exactly as refi-review's reference policy does it.
 *
 * Reading a field — is it there, is it a date, is it yes — is reading, and
 * is done here in code as a model would by looking; every date step and
 * every sum is a tool call. Held to the grader on every generated task, it
 * proves each one can be solved from the rulebook and the tools alone.
 */

import { reviewSteps, ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";

type Fact = unknown;

const text = (v: Fact): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const int = (v: Fact): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.trunc(v)
    : typeof v === "string" && /^-?\d+$/.test(v.trim())
      ? Number(v.trim())
      : null;
const cents = (v: Fact): string | null =>
  typeof v === "number" && Number.isFinite(v)
    ? String(Math.round(v))
    : typeof v === "string" && /^-?\d+$/.test(v.trim())
      ? String(BigInt(v.trim()))
      : null;
const rate = (v: Fact): string | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toFixed(3)
    : typeof v === "string" && /^\d{1,2}(\.\d{1,3})?$/.test(v.trim())
      ? Number(v.trim()).toFixed(3)
      : null;
const yesNo = (v: Fact): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const x = v.trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(x)) return true;
  if (["n", "no", "false", "0", ""].includes(x)) return false;
  return null;
};
const date = (v: Fact): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : null;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const big = (x: string) => BigInt(x);

const notReviewable = (reason: string): Json => ({
  verdict: "not_reviewable",
  reasons: [reason],
  offer: null,
  watch_rate_pct: null,
});

export function* tapeSteps(p: Json, call: Call): Step<Json> {
  const rec = p["loan_record"] as Json;
  const tape = p["tape"] as Json;
  const F = tape["facts"] as Json;
  const review = p["review_date"] as string;
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const addMonths = (d: string, months: number) =>
    call<string>("date_add", { date: d, months }, "date");
  const monthsBetween = (from: string, to: string) =>
    call<number>("whole_months_between", { from, to }, "months");

  const first = date(rec["first_payment_on"]) ?? date(F["first_payment_date"]);
  if (!first) return notReviewable("no_first_payment_date");
  const term = int(F["original_term_months"]) ?? Number(rec["term_months"]);
  const consummation = date(rec["originated_on"]) ?? date(F["origination_date"]) ?? first;
  const maturity =
    date(F["maturity_date"]) ?? date(rec["maturity_on"]) ?? (yield* addMonths(first, term - 1));

  let nextDue = date(tape["next_payment_due_on"]) ?? date(F["next_due_date"]);
  if (!nextDue) {
    const k = Math.max(0, yield* monthsBetween(first, review));
    const candidate = yield* addMonths(first, k);
    nextDue = candidate > review ? candidate : yield* addMonths(first, k + 1);
  }
  const remaining =
    nextDue <= maturity
      ? (yield* monthsBetween(nextDue, maturity)) + 1
      : (int(F["remaining_term_months"]) ?? 0);

  const noteRate =
    rate(F["note_rate_pct"]) ??
    rate(tape["current_rate_pct"]) ??
    Number(yield* calc(`round(${Number(rec["note_rate_bps"])} / 100, 3)`)).toFixed(3);

  const upb = cents(F["upb_cents"]) ?? String(tape["principal_balance_cents"]);
  if (!(big(upb) > 0n)) return notReviewable("no_upb");
  const originalUpb = cents(F["original_upb_cents"]) ?? String(rec["original_principal_cents"]);
  const pi =
    cents(F["pi_cents"]) ??
    (yield* call<string>(
      "level_payment",
      { principal_cents: originalUpb, annual_rate_pct: noteRate, term_months: term },
      "payment_cents",
    ));

  const tapeDay = String(tape["as_of"]).slice(0, 10);
  let late =
    nextDue < tapeDay
      ? yield* call<number>("days_between", { from: nextDue, to: tapeDay }, "days")
      : 0;
  const payString = F["pay_string"];
  const mba = F["mba_delinquency_status"];
  const saysLate =
    (typeof payString === "string" && /[369F]$/i.test(payString.trim())) ||
    (typeof mba === "string" &&
      ((/^\d+$/.test(mba.trim()) && Number(mba.trim()) > 0) || /late|delinq/i.test(mba)));
  if (late === 0 && saysLate) late = 30;
  const tapeDays =
    typeof tape["delinquency_days"] === "number" ? (tape["delinquency_days"] as number) : 0;
  if (tapeDays > late) late = tapeDays;

  const valuations: { value: string; asOf: string }[] = [];
  const fmv = cents(F["fmv_cents"]);
  if (fmv !== null && big(fmv) > 0n)
    valuations.push({ value: fmv, asOf: date(F["fmv_date"]) ?? tapeDay });
  const bpo = cents(F["bpo_value_cents"]);
  if (bpo !== null && big(bpo) > 0n)
    valuations.push({ value: bpo, asOf: date(F["bpo_date"]) ?? tapeDay });
  let picked = valuations.reduce<{ value: string; asOf: string } | null>(
    (best, v) => (best === null || v.asOf > best.asOf ? v : best),
    null,
  );
  if (!picked) {
    const appraised = cents(F["appraised_value_cents"]);
    if (appraised !== null && big(appraised) > 0n) {
      picked = { value: appraised, asOf: date(F["origination_date"]) ?? consummation };
    }
  }
  if (!picked) return notReviewable("no_value");
  const mediumLine = yield* addMonths(review, -12);

  const pmi = yesNo(F["pmi_flag"]) === true;
  const rawPmi = rate(F["pmi_rate_pct"]);
  const pmiRate =
    rawPmi && Number(rawPmi) > 5
      ? Number(yield* calc(`round(${rawPmi} / 100, 3)`)).toFixed(3)
      : rawPmi;
  const mi =
    pmi && pmiRate && Number(pmiRate) > 0
      ? yield* calc(`round(${upb} * ${pmiRate} / 100 / 12)`)
      : "0";

  const ti = cents(F["ti_cents"]) ?? "0";
  const netEscrow = big(ti) > 0n ? yield* calc(`2 * ${ti}`) : "0";
  const occupancyWord = String(rec["occupancy"] ?? F["occupancy"] ?? "").toLowerCase();
  const state = String(rec["state"]);

  const row: Json = {
    status: state === "monitoring_only" || state === "active" ? "active" : "not_active",
    bankruptcy_active:
      yesNo(F["bk_status"]) === true ||
      (date(F["bk_filed_date"]) !== null &&
        yesNo(F["bk_discharged"]) !== true &&
        date(F["bk_dismissed_date"]) === null),
    foreclosure_referred: yesNo(F["fc_status"]) === true || date(F["fc_referral_date"]) !== null,
    lossmit_plan_active: yesNo(F["modification_flag"]) === true,
    deceased_or_sii_pending: false,
    transfer_out_pending: /transfer|service[\s_-]?released|sold/i.test(
      text(F["servicing_status"]) ?? "",
    ),
    regx_days_delinquent: late,
    refi_do_not_solicit: false,
    note_rate_pct: noteRate,
    next_due_date: nextDue,
    upb_cents: upb,
    pi_cents: pi,
    remaining_term_months: remaining,
    net_escrow_deposit_estimate_cents: netEscrow,
    mi_status: pmi ? "bpmi_active" : "none",
    mi_monthly_cents: mi,
    occupancy: occupancyWord.startsWith("second")
      ? "second_home"
      : occupancyWord.startsWith("invest")
        ? "investment"
        : "primary",
    property_state: (rec["property_state"] as string | null) ?? text(F["property_state"]) ?? "XX",
    consummation_date: consummation,
    value_estimate: {
      value_cents: picked.value,
      as_of: picked.asOf,
      confidence: picked.asOf >= mediumLine ? "medium" : "low",
    },
  };
  return yield* reviewSteps(
    {
      review_date: review,
      loan: row,
      quote: p["quote"],
      offer_history: p["offer_history"],
      tape_exceptions: p["tape_exceptions"],
    },
    call,
  );
}

export class TapeReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", tapeSteps);
  }
}
