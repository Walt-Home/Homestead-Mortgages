/**
 * A monitored loan's facts into the engine's row — his 33.2 rule 1, read
 * off our own tables.
 *
 * What his `monitoredUniverseRows` reads from `partner_book_facts` and
 * `v_refi_universe`, this reads from a `loans` row and its newest
 * `servicing_observations` row: the observation's columns for what the tape
 * reader typed (balance, rate, next due, delinquency, escrow, payment) and
 * the observation's `facts` for the rest of the tape as the m3-v1 profile
 * keyed it — the same keys his reader writes, because ours is his reader
 * ported. Nothing person-keyed is read: no name, no ZIP, no date of birth,
 * and the score is the tape's, for pricing only.
 *
 * A row the tape cannot describe well enough is skipped with the reason,
 * never guessed: no balance, no value, no first payment date.
 */

import { Decimal, centsToDecimal, levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import { addMonths, daysBetween, plainDate, type PlainDate } from "@hm/kernel/calendar";
import {
  VALUE_MEDIUM_MONTHS,
  monthsBetween,
  type Occupancy,
  type PropertyType,
  type UniverseLoan,
  type ValueEstimate,
} from "./engine.js";

export type Fact = string | number | boolean | null | undefined;

/** The loan's own row, in the words the API's model uses. */
export interface ObservedLoan {
  readonly loan_id: string;
  /** Our loan state: `monitoring_only` and `active` are in the universe; anything else is `not_active`. */
  readonly state: string;
  readonly rate_type: "fixed" | "arm";
  readonly note_rate_bps: number;
  readonly term_months: number;
  readonly original_principal_cents: Cents;
  readonly originated_on: string | null;
  readonly first_payment_on: string | null;
  readonly maturity_on: string | null;
  readonly occupancy: string | null;
  readonly property_state: string | null;
}

/** The newest observation: the typed columns and the tape's facts beside them. */
export interface Observation {
  readonly as_of: string;
  readonly status: string;
  readonly principal_balance_cents: Cents;
  readonly escrow_balance_cents: Cents | null;
  readonly scheduled_payment_cents: Cents | null;
  readonly current_rate_pct: string | null;
  readonly next_payment_due_on: string | null;
  readonly delinquency_days: number | null;
  readonly facts: Readonly<Record<string, Fact>>;
}

const fText = (v: Fact): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const fInt = (v: Fact): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};
const fMoney = (v: Fact): Cents | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
};
const fRate = (v: Fact): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v.toFixed(3);
  if (typeof v === "string" && /^\d{1,2}(\.\d{1,3})?$/.test(v.trim()))
    return Number(v.trim()).toFixed(3);
  return null;
};
const fBool = (v: Fact): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const x = v.trim().toLowerCase();
    if (["y", "yes", "true", "1"].includes(x)) return true;
    if (["n", "no", "false", "0", ""].includes(x)) return false;
  }
  return null;
};
const fDate = (v: Fact): PlainDate | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : null;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? plainDate(s) : null;
};
const dateOf = (v: string | null): PlainDate | null => (v ? fDate(v) : null);

/** The partner's notation: a 3/6/9 (30/60/90 days) or F (foreclosure) in the latest pay-string month. */
const payStringLate = (v: Fact): boolean => typeof v === "string" && /[369F]$/i.test(v.trim());
/** An MBA status other than current: a day count > 0 or a late word. */
const mbaStatusLate = (v: Fact): boolean =>
  typeof v === "string" &&
  ((/^\d+$/.test(v.trim()) && Number(v.trim()) > 0) || /late|delinq/i.test(v));
const within = (date: PlainDate, asOf: PlainDate, months: number): boolean =>
  date >= addMonths(asOf, -months);

export const occupancyOf = (v: Fact): Occupancy => {
  const x = String(v ?? "").toLowerCase();
  return x.startsWith("second") ? "second_home" : x.startsWith("invest") ? "investment" : "primary";
};
export const propertyTypeOf = (v: Fact): PropertyType => {
  const x = String(v ?? "sfr").toLowerCase();
  if (x.startsWith("condo")) return "condo";
  if (x.includes("pud")) return "pud";
  if (x.includes("coop") || x.includes("co-op")) return "coop";
  if (x.startsWith("manufactured")) return "manufactured_home";
  return "sfr";
};

export type UniverseRow = { readonly row: UniverseLoan } | { readonly skipped: string };

/** One loan into the engine's row, or the reason it cannot be. */
export function universeLoanOf(loan: ObservedLoan, obs: Observation, asOf: PlainDate): UniverseRow {
  try {
    const F = obs.facts;
    const originalTerm = fInt(F["original_term_months"]) ?? loan.term_months;
    const first = dateOf(loan.first_payment_on) ?? fDate(F["first_payment_date"]);
    if (!first) throw new RangeError("no first_payment_date");
    const note = dateOf(loan.originated_on) ?? fDate(F["origination_date"]) ?? first;
    const maturity =
      fDate(F["maturity_date"]) ?? dateOf(loan.maturity_on) ?? addMonths(first, originalTerm - 1);
    const nextDueTape = dateOf(obs.next_payment_due_on) ?? fDate(F["next_due_date"]);
    let next_due_date: PlainDate;
    if (nextDueTape) next_due_date = nextDueTape;
    else {
      const k = Math.max(0, monthsBetween(first, asOf));
      const cand = addMonths(first, k);
      next_due_date = cand <= asOf ? addMonths(first, k + 1) : cand;
    }
    const remaining_term_months =
      next_due_date <= maturity
        ? monthsBetween(next_due_date, maturity) + 1
        : (fInt(F["remaining_term_months"]) ?? 0);
    const payments_made = Math.max(0, Math.min(originalTerm, originalTerm - remaining_term_months));
    const note_rate_pct =
      fRate(F["note_rate_pct"]) ??
      fRate(obs.current_rate_pct) ??
      (loan.note_rate_bps / 100).toFixed(3);
    const upb_cents = fMoney(F["upb_cents"]) ?? obs.principal_balance_cents;
    if (upb_cents <= 0n) throw new RangeError("no interest-bearing UPB on the tape");
    const original_upb_cents = fMoney(F["original_upb_cents"]) ?? loan.original_principal_cents;
    const pi_cents =
      fMoney(F["pi_cents"]) ??
      levelPayment(original_upb_cents, ratePercent(note_rate_pct), originalTerm);

    // Delinquency: days past the tape's next due date at as-of; the pay string,
    // the MBA status and the observation's own count corroborate.
    let regx_days_delinquent = next_due_date < asOf ? daysBetween(next_due_date, asOf) : 0;
    if (
      regx_days_delinquent === 0 &&
      (payStringLate(F["pay_string"]) || mbaStatusLate(F["mba_delinquency_status"]))
    ) {
      regx_days_delinquent = 30;
    }
    if ((obs.delinquency_days ?? 0) > regx_days_delinquent)
      regx_days_delinquent = obs.delinquency_days ?? 0;

    // The value: the newest of Current FMV and Most Recent BPO by date, else the original appraisal.
    const fmv = fMoney(F["fmv_cents"]);
    const bpo = fMoney(F["bpo_value_cents"]);
    const appraised = fMoney(F["appraised_value_cents"]);
    const obsDay = plainDate(obs.as_of.slice(0, 10));
    const candidates: { source: ValueEstimate["source"]; value_cents: Cents; as_of: PlainDate }[] =
      [];
    if (fmv !== null && fmv > 0n)
      candidates.push({
        source: "partner_fmv",
        value_cents: fmv,
        as_of: fDate(F["fmv_date"]) ?? obsDay,
      });
    if (bpo !== null && bpo > 0n)
      candidates.push({
        source: "partner_bpo",
        value_cents: bpo,
        as_of: fDate(F["bpo_date"]) ?? obsDay,
      });
    candidates.sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : 0));
    const picked =
      candidates[0] ??
      (appraised !== null && appraised > 0n
        ? {
            source: "partner_appraisal" as const,
            value_cents: appraised,
            as_of: fDate(F["origination_date"]) ?? note,
          }
        : null);
    if (!picked)
      throw new RangeError(
        "no value on the tape (Current FMV, Most Recent BPO or Orig Appraised Value)",
      );
    const value_estimate: ValueEstimate = {
      ...picked,
      confidence: within(picked.as_of, asOf, VALUE_MEDIUM_MONTHS) ? "medium" : "low",
    };

    // MI: the PMI flag; the monthly premium from the PMI rate on the UPB when given.
    const pmi = fBool(F["pmi_flag"]) === true;
    const pmiRateRaw = fRate(F["pmi_rate_pct"]);
    const pmiRate =
      pmiRateRaw && Number(pmiRateRaw) > 5
        ? Decimal.parse(pmiRateRaw).div(Decimal.fromInt(100)).toFixed(3)
        : pmiRateRaw;
    const mi_monthly_cents =
      pmi && pmiRate && Number(pmiRate) > 0
        ? centsToDecimal(upb_cents)
            .mul(ratePercent(pmiRate))
            .div(Decimal.fromInt(12))
            .toCents("HALF_UP")
        : 0n;

    const bankruptcy_active =
      fBool(F["bk_status"]) === true ||
      (fDate(F["bk_filed_date"]) !== null &&
        fBool(F["bk_discharged"]) !== true &&
        fDate(F["bk_dismissed_date"]) === null);
    const foreclosure_referred =
      fBool(F["fc_status"]) === true || fDate(F["fc_referral_date"]) !== null;
    const lossmit_plan_active = fBool(F["modification_flag"]) === true;
    const transfer_out_pending = /transfer|service[\s_-]?released|sold/i.test(
      fText(F["servicing_status"]) ?? "",
    );

    const ti = fMoney(F["ti_cents"]) ?? 0n;
    const escrowed = ti > 0n;
    const amortization: UniverseLoan["amortization"] = loan.rate_type === "arm" ? "arm" : "fixed";
    const fixedPeriod = fInt(F["arm_fixed_period_months"]) ?? 0;
    const active = loan.state === "monitoring_only" || loan.state === "active";

    const row: UniverseLoan = {
      loan_id: loan.loan_id,
      status: active ? "active" : "not_active",
      product_code: amortization === "arm" ? "ARM" : `FRM${Math.round(originalTerm / 12)}`,
      amortization,
      note_date: note,
      first_payment_date: first,
      consummation_date: note,
      original_upb_cents,
      original_term_months: originalTerm,
      note_rate_pct,
      pi_cents,
      payments_made,
      upb_cents,
      next_due_date,
      remaining_term_months,
      escrowed,
      escrow_monthly_cents: ti,
      net_escrow_deposit_estimate_cents: escrowed ? ti * 2n : 0n,
      mi_status: pmi ? "bpmi_active" : "none",
      mi_monthly_cents,
      occupancy: occupancyOf(loan.occupancy ?? F["occupancy"]),
      property_type: propertyTypeOf(F["property_type"]),
      units: 1,
      property_state: loan.property_state ?? fText(F["property_state"]) ?? "XX",
      value_estimate,
      representative_score: fInt(F["fico_current"]) ?? fInt(F["fico_original"]),
      regx_days_delinquent,
      bankruptcy_active,
      foreclosure_referred,
      lossmit_plan_active,
      deceased_or_sii_pending: false,
      transfer_out_pending,
      refi_do_not_solicit: false,
      arm_first_adjustment_date:
        amortization === "arm" && fixedPeriod > 0 ? addMonths(first, fixedPeriod) : null,
    };
    return { row };
  } catch (e) {
    return { skipped: e instanceof Error ? e.message : String(e) };
  }
}
