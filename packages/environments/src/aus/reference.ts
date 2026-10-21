/**
 * The reference policy for aus-decision: the rulebook followed literally,
 * through the tools. Picking the middle of three scores, finding the latest
 * tax year, choosing a threshold, and comparing two figures are reading;
 * every sum, ratio, rounding, month count, date, APOR, APR and payment is a
 * tool call. Calls that do not depend on each other go together in one turn,
 * as a model may make them. Held to the grader on every generated task, it is
 * the proof that each file can be decided from the rulebook and the tools
 * alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { AUS_SUBMIT_TOOL } from "./tools.js";

interface Pending {
  readonly name: string;
  readonly input: Json;
}

let batches = 0;
/** Independent calls made together in one turn; each answer read back by id, or null for an APOR the table does not hold. */
function* together(calls: readonly Pending[]): Step<(Record<string, string> | null)[]> {
  if (calls.length === 0) return [];
  const batch = ++batches;
  const sent: ToolCall[] = calls.map((c, k) => ({
    id: `aus-${batch}-${k}`,
    name: c.name,
    input: c.input,
  }));
  const observations = yield sent;
  return sent.map((c) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o) throw new Error(`${c.name}: no observation`);
    if (o.is_error) {
      // Only the APOR lookup may answer that it holds no such week: that is a null APOR.
      if (c.name === "apor" && /^no APOR/.test(o.content)) return null;
      throw new Error(`${c.name} failed: ${o.content}`);
    }
    const answer = JSON.parse(o.content) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(answer).map(([key, v]) => [key, String(v)]));
  });
}

const calc = (expression: string): Pending => ({ name: "calculate", input: { expression } });
const sumOf = (xs: readonly (string | number)[]): string => (xs.length ? xs.join(" + ") : "0");

/** A decimal string as an integer number of thousandths: comparing two is reading. */
const milli = (x: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(x);
  if (!m) throw new Error(`not a decimal with at most three places: ${x}`);
  const v = BigInt(m[2]! + (m[3] ?? "").padEnd(3, "0"));
  return m[1] === "-" ? -v : v;
};
const above = (a: string, b: string | number) => milli(a) > milli(String(b));
const atLeast = (a: string, b: string | number) => milli(a) >= milli(String(b));
/** A decimal string written with exactly `places` decimals. */
const fixed = (x: string, places: number): string => {
  const [int, frac = ""] = x.split(".");
  if (frac.length > places) throw new Error(`${x} has more than ${places} decimals`);
  return places === 0 ? int! : `${int}.${frac.padEnd(places, "0")}`;
};

interface Borrower {
  name: string;
  occupies_property: boolean;
  credit: {
    scores: { score: number }[];
    tradelines: {
      creditor: string;
      type: string;
      opened_on: string;
      monthly_payment_cents: number;
      dti_exclusion: string | null;
    }[];
    public_records: {
      type: string;
      date: string;
      chapter: string | null;
      discharged_on: string | null;
    }[];
  } | null;
  assets: {
    accounts: {
      institution: string;
      type: string;
      mask: string;
      balance_cents: number;
      vested_balance_cents: number | null;
      used_to_qualify: boolean;
    }[];
  } | null;
  transcripts: { tax_year: number; wages_cents: number }[];
}

/** The QM points-and-fees limit for 2026: a percent of the total loan amount, or flat cents. */
function qmFeeLimit(loanCents: number): { percent: number } | { cents: number } {
  if (loanCents >= 13_795_800) return { percent: 3 };
  if (loanCents >= 8_277_500) return { cents: 413_900 };
  if (loanCents >= 2_759_200) return { percent: 5 };
  if (loanCents >= 1_724_500) return { cents: 138_000 };
  return { percent: 8 };
}
function qmSpreadCap(loanCents: number, propertyType: string): string {
  if (propertyType === "manufactured" && loanCents < 13_795_800) return "6.5";
  if (loanCents >= 13_795_800) return "2.25";
  if (loanCents >= 8_277_500) return "3.5";
  return "6.5";
}

export function* ausSteps(p: Json, _call: Call): Step<Json> {
  const borrowers = p["borrowers"] as Borrower[];
  const income = p["income_sources"] as {
    type: string;
    monthly_cents: number;
    continuance_established: boolean | null;
  }[];
  const property = p["property"] as Record<string, unknown>;
  const loan = p["loan"] as Record<string, unknown>;
  const product = p["product"] as Record<string, unknown>;
  const estimates = p["lender_estimates"] as Record<string, number>;
  const existing = loan["existing_loan"] as Record<string, unknown> | null;
  const decided = String(p["decided_at"]).slice(0, 10);
  const loanCents = Number(loan["amount_cents"]);
  const value = Number(property["value_cents"]);
  const pitia = String(estimates["housing_payment_cents"]);
  const closing = String(estimates["closing_costs_cents"]);
  const ipc = Number(loan["interested_party_contributions_cents"]);
  const occupancy = String(property["occupancy"]);
  const primary = occupancy === "primary_residence";
  const purchase = loan["purpose"] === "purchase";
  const fixedRate = product["amortization"] === "Fixed";
  const term = Number(product["term_months"]);
  const note = String(product["note_rate_pct"]);
  const findings: string[] = [];
  const blocked = new Set<string>();

  // Step 1: each own score, by reading.
  const own = borrowers.map((b) => {
    if (!b.credit || b.credit.scores.length === 0) return null;
    const sorted = b.credit.scores.map((s) => s.score).sort((a, c) => a - c);
    return sorted.length >= 3 ? sorted[1]! : sorted[0]!;
  });
  const scored = own.every((s) => s !== null);
  if (!scored) blocked.add("CRD-002").add("UW-010");
  // Step 2.
  const allCredit = borrowers.every((b) => b.credit !== null);
  if (!allCredit) blocked.add("CRD-016");

  // Step 3: the records, each with its reference date and minimum.
  const records = borrowers.flatMap((b) => b.credit?.public_records ?? []);
  const seasoning = records.map((r) => ({
    kind: r.type === "bankruptcy" ? "bankruptcy" : "derogatory",
    reference: r.type === "bankruptcy" ? (r.discharged_on ?? r.date) : r.date,
    minimum:
      r.type === "bankruptcy" ? (r.chapter === "13" ? 24 : 48) : r.type === "foreclosure" ? 84 : 48,
  }));

  // Step 4.
  if (!income.some((s) => s.type === "base_wage")) blocked.add("INC-004");
  const established = income.filter((s) => s.continuance_established === true);
  const transcriptsRun = borrowers.length > 0 && borrowers.every((b) => b.transcripts.length > 0);
  const latestWages = borrowers.map((b) =>
    b.transcripts.length
      ? [...b.transcripts].sort((a, c) => c.tax_year - a.tax_year)[0]!.wages_cents
      : 0,
  );

  // Step 5.
  const counted: string[] = [];
  if (allCredit) {
    const seen = new Set<string>();
    for (const b of borrowers)
      for (const t of b.credit!.tradelines) {
        const key = `${t.creditor.trim().toLowerCase()}|${t.type}|${t.opened_on}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (t.dti_exclusion === null) counted.push(String(t.monthly_payment_cents));
      }
  } else blocked.add("UW-004");

  // Step 8: the eligible accounts.
  const withAssets = borrowers.filter((b) => b.assets !== null);
  const eligible: string[] = [];
  {
    const seen = new Set<string>();
    for (const b of withAssets)
      for (const a of b.assets!.accounts) {
        const key = `${a.institution.trim().toLowerCase()}|${a.type}|${a.mask}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!a.used_to_qualify) continue;
        eligible.push(
          a.type === "retirement"
            ? `${a.vested_balance_cents ?? 0} * 60 / 100`
            : String(a.balance_cents),
        );
      }
  }
  const occupancyMonths = primary ? 0 : occupancy === "second_home" ? 2 : 6;

  // Everything that depends on nothing but the file, together.
  const first: Pending[] = [
    { name: "new_york_date", input: { instant: product["rate_set_at"] } },
    ...seasoning.map((s) => ({
      name: "whole_months_between",
      input: { from: s.reference, to: decided },
    })),
    calc(sumOf(established.map((s) => s.monthly_cents))),
    calc(`round(${loanCents} * 100 / ${value}, 2)`),
    calc(
      `round((${loanCents} + ${Number(loan["junior_lien_balance_cents"])}) * 100 / ${value}, 2)`,
    ),
    calc(
      `round((${loanCents} + ${Number(loan["junior_lien_credit_limit_cents"])}) * 100 / ${value}, 2)`,
    ),
    calc(`round(${loanCents} * 0.5 / 100) + 109500 + 49500`),
    calc(`round(${ipc} * 100 / ${value}, 2)`),
    calc(
      `${purchase ? value : Number(existing!["balance_cents"])} + ${closing} - ${ipc} - ${loanCents}`,
    ),
    calc(`${occupancyMonths} + 2 * (${Number(property["financed_properties"])} - 1)`),
  ];
  const twoScores = scored && own.length === 2;
  if (twoScores) first.push(calc(`round((${own[0]} + ${own[1]}) / 2)`));
  if (allCredit) first.push(calc(sumOf(counted)));
  if (withAssets.length > 0) first.push(calc(sumOf(eligible)));
  if (transcriptsRun) {
    const documented = `12 * (${sumOf(income.map((s) => s.monthly_cents))})`;
    const wages = `(${sumOf(latestWages)})`;
    first.push(calc(`round((${documented} - ${wages}) * 100 / ${wages}, 2)`));
  }
  const ntbMeasured =
    !purchase && existing !== null && existing["payment_basis"] === "principal_and_interest";
  if (ntbMeasured)
    first.push({
      name: "level_payment",
      input: { principal_cents: String(loanCents), annual_rate_pct: note, term_months: term },
    });
  const r1 = yield* together(first);
  let at = 0;
  const next = (key = "value") => r1[at++]![key]!;
  const rateSetOn = next("date");
  const months = seasoning.map(() => Number(next("months")));
  const qualifying = next();
  const ltv = fixed(next(), 2);
  const cltv = fixed(next(), 2);
  const hcltv = fixed(next(), 2);
  const pointsAndFees = next();
  const ipcRatio = fixed(next(), 2);
  const funds = next();
  const requiredMonths = Number(next());
  const average = twoScores ? Number(next()) : null;
  const liabilities = allCredit ? next() : null;
  const eligibleCents = withAssets.length > 0 ? next() : null;
  const variance = transcriptsRun ? fixed(next(), 2) : null;
  const newPayment = ntbMeasured ? next("payment_cents") : null;

  // Step 1, finished.
  const representative = scored ? Math.min(...(own as number[])) : null;
  const forMinimum = scored ? (own.length === 1 ? representative : average) : null;

  // Step 3, finished: the smallest margin decides.
  const decide = (kind: string) => {
    const xs = seasoning
      .map((s, k) => ({ ...s, months: months[k]! }))
      .filter((s) => s.kind === kind)
      .sort((a, b) => a.months - a.minimum - (b.months - b.minimum));
    const d = xs[0];
    if (!d) return null;
    if (d.months < d.minimum)
      findings.push(kind === "bankruptcy" ? "BANKRUPTCY_SEASONING" : "DEROGATORY_SEASONING");
    return d.months;
  };
  const bankruptcyMonths = decide("bankruptcy");
  const derogatoryMonths = decide("derogatory");

  // Step 4, finished.
  if (variance !== null && (above(variance, "10") || above("-10", variance)))
    findings.push("TRANSCRIPT_VARIANCE");

  // Step 7: what the rate-set date, the fees and the ratios need next.
  const aporTerm = fixedRate && [120, 180, 240, 360].includes(term);
  const overEighty = BigInt(loanCents) * 100n > BigInt(value) * 80n;
  const incomeKnown = BigInt(qualifying) !== 0n;
  const second: Pending[] = [calc(`${loanCents} - ${pointsAndFees}`)];
  if (aporTerm) second.push({ name: "apor", input: { date: rateSetOn, term_years: term / 12 } });
  if (fixedRate && !overEighty)
    second.push({
      name: "annual_percentage_rate",
      input: {
        loan_amount_cents: String(loanCents),
        note_rate_pct: note,
        term_months: term,
        prepaid_finance_charges_cents: pointsAndFees,
      },
    });
  if (incomeKnown) {
    second.push(calc(`round(${pitia} * 100 / ${qualifying}, 2)`));
    if (liabilities !== null)
      second.push(calc(`round((${pitia} + ${liabilities}) * 100 / ${qualifying}, 2)`));
  } else blocked.add("UW-004");
  if (eligibleCents !== null)
    second.push(calc(`round((${eligibleCents} - ${funds}) / ${pitia}, 1)`));
  if (newPayment !== null)
    second.push(calc(`${Number(existing!["monthly_payment_cents"])} - ${newPayment}`));
  const r2 = yield* together(second);
  at = 0;
  const after = () => r2[at++] ?? null;
  const totalLoan = after()!["value"]!;
  const found = aporTerm ? after() : null;
  const weekOf = found?.["week_of"] ?? null;
  const apor = found?.["apor_pct"] ?? null;
  const apr = fixedRate && !overEighty ? after()!["apr_pct"]! : null;
  const front = incomeKnown ? fixed(after()!["value"]!, 2) : null;
  const back = incomeKnown && liabilities !== null ? fixed(after()!["value"]!, 2) : null;
  const actual = eligibleCents !== null ? fixed(after()!["value"]!, 1) : null;
  const saving = newPayment !== null ? after()!["value"]! : null;
  if (apor === null || apr === null) blocked.add("UW-008");

  // Step 5, finished.
  if (back !== null && above(back, "45")) findings.push("DTI_ELEVATED");
  const atr = back !== null && withAssets.length === borrowers.length && borrowers.length > 0;

  // Step 6.
  const anyNonOccupant = borrowers.some((b) => b.occupies_property === false);
  const byPurpose = !purchase ? 97 : primary ? 97 : occupancy === "second_home" ? 90 : 85;
  const maxLtv = anyNonOccupant ? Math.min(byPurpose, 95) : byPurpose;
  if (above(ltv, maxLtv)) findings.push("LTV_EXCEEDS_MAXIMUM");

  // Step 8, finished.
  let satisfied: boolean | null = null;
  if (actual === null) blocked.add("AST-004");
  else {
    satisfied = atLeast(actual, requiredMonths);
    if (!satisfied) findings.push("RESERVES_INSUFFICIENT");
  }

  // Step 9.
  const ipcCap =
    occupancy === "investment" ? 2 : atLeast(ltv, "90.01") ? 3 : atLeast(ltv, "75.01") ? 6 : 9;
  if (above(ipcRatio, ipcCap)) findings.push("IPC_EXCEEDS_LIMIT");

  // Steps 10 to 14: the thresholds and the limits they set.
  const year2026 = rateSetOn.startsWith("2026-");
  const limitRule = qmFeeLimit(loanCents);
  const third: Pending[] = [];
  const spreadKnown = apr !== null && apor !== null;
  if (spreadKnown) third.push(calc(`${apr} - ${apor}`));
  if (year2026) {
    if ("percent" in limitRule)
      third.push(calc(`round(${totalLoan} * ${limitRule.percent} / 100)`));
    third.push(
      calc(
        loanCents >= 2_759_200
          ? `round(${totalLoan} * 5 / 100)`
          : `min(round(${totalLoan} * 8 / 100), 138000)`,
      ),
    );
  }
  // Step 15: the recoup needs only the saving.
  const recoupNeeded = saving !== null && BigInt(saving) > 0n;
  if (recoupNeeded) third.push(calc(`round(${closing} / ${saving}, 1)`));
  const r3 = yield* together(third);
  at = 0;
  const last = () => r3[at++]!["value"]!;
  const spread = spreadKnown ? last() : null;
  let qmLimit: string | null = null;
  let hoepaLimit: string | null = null;
  if (year2026) {
    qmLimit = "percent" in limitRule ? last() : String(limitRule.cents);
    hoepaLimit = last();
  }
  const recoup = recoupNeeded ? fixed(last(), 1) : null;

  // Step 11.
  let qm: string | null = null;
  if (spread === null || !year2026) blocked.add("UW-006");
  else if (!atr) qm = "non_qm";
  else
    qm = milli(spread) < milli(qmSpreadCap(loanCents, String(property["type"]))) ? "qm" : "non_qm";

  // Step 12.
  let pfPass: boolean | null = null;
  if (!year2026) blocked.add("UW-007");
  else {
    pfPass = BigInt(pointsAndFees) <= BigInt(qmLimit!);
    if (!pfPass) findings.push("POINTS_AND_FEES_EXCEEDED");
  }

  // Step 13.
  let hpml: boolean | null = null;
  if (spread !== null && primary) {
    if (!year2026) blocked.add("UW-008");
    else hpml = milli(spread) >= milli(loanCents > 83_275_000 ? "2.5" : "1.5");
  }

  // Step 14.
  let highCost: boolean | null = null;
  if (primary) {
    const rateTrigger = spread === null ? null : milli(spread) > milli("6.5");
    const feeTrigger = !year2026 ? null : BigInt(pointsAndFees) > BigInt(hoepaLimit!);
    const penaltyTrigger = product["prepayment_penalty"] === true ? null : false;
    const triggers = [rateTrigger, feeTrigger, penaltyTrigger];
    if (triggers.includes(true)) highCost = true;
    else if (triggers.every((t) => t === false)) highCost = false;
    if (highCost === null) blocked.add("UW-009");
    if (highCost === true) findings.push("HOEPA_HIGH_COST");
  }

  // Step 15.
  let ntbSatisfied: boolean | null = null;
  if (!purchase) {
    if (!ntbMeasured) blocked.add("APP-019");
    else ntbSatisfied = recoup === null ? false : !above(recoup, "60");
    if (ntbSatisfied === false) findings.push("NTB_NOT_SATISFIED");
  }

  // Step 16.
  const eligibility = [
    "LTV_EXCEEDS_MAXIMUM",
    "HOEPA_HIGH_COST",
    "POINTS_AND_FEES_EXCEEDED",
    "NTB_NOT_SATISFIED",
  ];
  const recommendation = findings.some((f) => eligibility.includes(f))
    ? "approve_ineligible"
    : blocked.size > 0
      ? "refer"
      : findings.length > 0
        ? "refer_with_caution"
        : "approve_eligible";
  const outcome =
    highCost === true
      ? "denied"
      : {
          approve_ineligible: "counteroffer",
          refer: "referred",
          refer_with_caution: "approved_with_conditions",
          approve_eligible: "clear_to_close",
        }[recommendation];

  return {
    representative_fico: representative,
    fico_for_minimum: forMinimum,
    bankruptcy_seasoning_months: bankruptcyMonths,
    derogatory_seasoning_months: derogatoryMonths,
    qualifying_income_cents: qualifying,
    transcript_variance_pct: variance,
    monthly_liabilities_cents: liabilities,
    dti_front_pct: front,
    dti_back_pct: back,
    atr_documented: atr,
    ltv_pct: ltv,
    cltv_pct: cltv,
    hcltv_pct: hcltv,
    max_ltv_pct: maxLtv,
    ipc_ratio_pct: ipcRatio,
    ipc_cap_pct: ipcCap,
    funds_to_close_cents: funds,
    required_reserve_months: requiredMonths,
    actual_reserve_months: actual,
    reserves_satisfied: satisfied,
    points_and_fees_cents: pointsAndFees,
    total_loan_amount_cents: totalLoan,
    points_and_fees_pass: pfPass,
    is_high_cost: highCost,
    apor_week_of: weekOf,
    apor_pct: apor === null ? null : fixed(apor, 2),
    apr_pct: apr === null ? null : fixed(apr, 3),
    qm_status: qm,
    is_hpml: hpml,
    ntb_recoup_months: recoup,
    ntb_satisfied: ntbSatisfied,
    findings: [...new Set(findings)].sort(),
    blocked: [...blocked].sort(),
    recommendation,
    outcome,
  };
}

export class AusReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:aus-rulebook", ausSteps, AUS_SUBMIT_TOOL);
  }
}
