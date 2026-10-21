/**
 * The reference policy for regz-price-tests: the rulebook followed
 * literally, through the tools.
 *
 * It reads only the rendered task. Choosing a tier or a threshold is
 * reading a table, done here as a model would by looking; every sum,
 * rounding, spread and lookup is a tool call. Held to the grader on every
 * generated task — the generator keeps a task only once this lands where
 * the engine does — it is the proof that each task can be solved from the
 * rulebook and the tools alone.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { REGZ_SUBMIT_TOOL } from "./tools.js";

interface Fee {
  name: string;
  payee: string;
  amount_cents?: number;
  percent_of_loan_amount?: string;
}

const KEPT = ["lender", "affiliate"];
const APOR_TERMS = [10, 15, 20, 30];

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

/** How the reference finds an APR: the inputs Appendix J takes, the tools to reach it with. */
export type AprStep = (
  inputs: { loanCents: number; note: string; term: number; prepaidCents: string },
  call: Call,
) => Step<string>;

/** The APR the way regz-price-tests's tools give it: one call to the Appendix J solve. */
export const aprByTool: AprStep = (i, call) =>
  call<string>(
    "annual_percentage_rate",
    {
      loan_amount_cents: String(i.loanCents),
      note_rate_pct: i.note,
      term_months: i.term,
      prepaid_finance_charges_cents: i.prepaidCents,
    },
    "apr_pct",
  );

export function regzSteps(p: Json, call: Call): Step<Json> {
  return regzStepsWith(aprByTool)(p, call);
}

/** The rulebook's steps, with Step 3's APR found the way `aprStep` finds it. */
export const regzStepsWith = (aprStep: AprStep) =>
  function* (p: Json, call: Call): Step<Json> {
    const calc = (expression: string) => call<string>("calculate", { expression }, "value");
    const loan = p["loan"] as Record<string, unknown>;
    const property = p["property"] as Record<string, unknown>;
    const fees = p["fees"] as Fee[];
    const loanCents = Number(loan["amount_cents"]);
    const note = String(loan["note_rate_pct"]);
    const term = Number(loan["term_months"]);
    const fixed = loan["amortization"] === "Fixed";
    const primary = property["occupancy"] === "primary_residence";

    // Step 1
    const amounts: { kept: boolean; cents: string }[] = [];
    for (const f of fees) {
      const cents =
        f.percent_of_loan_amount !== undefined
          ? yield* calc(`round(${loanCents} * ${f.percent_of_loan_amount} / 100)`)
          : String(f.amount_cents);
      amounts.push({ kept: KEPT.includes(f.payee), cents });
    }
    const sum = function* (xs: string[]): Step<string> {
      return xs.length ? yield* calc(xs.join(" + ")) : "0";
    };
    const total = yield* sum(amounts.map((a) => a.cents));
    const kept = yield* sum(amounts.filter((a) => a.kept).map((a) => a.cents));

    // Step 2
    const totalLoan = yield* calc(`${loanCents} - ${kept}`);

    // Step 3
    const overEighty = BigInt(loanCents) * 100n > BigInt(Number(property["value_cents"])) * 80n;
    let apr: string | null = null;
    if (fixed && !overEighty) {
      apr = yield* aprStep({ loanCents, note, term, prepaidCents: kept }, call);
    }

    // Step 4
    let apor: string | null = null;
    if (fixed && term % 12 === 0 && APOR_TERMS.includes(term / 12)) {
      const date = yield* call<string>("new_york_date", { instant: p["rate_quoted_at"] }, "date");
      apor = yield* call<string>("apor", { date, term_years: term / 12 }, "apor_pct");
    }
    const spread = apr !== null && apor !== null ? yield* calc(`${apr} - ${apor}`) : null;
    const cmp = function* (a: string, b: string): Step<number> {
      const d = Number(yield* calc(`${a} - ${b}`));
      return d > 0 ? 1 : d < 0 ? -1 : 0;
    };

    // Step 5
    let qm: string | null = null;
    if (spread !== null) {
      if (p["atr_documented"] !== true) qm = "non_qm";
      else
        qm =
          (yield* cmp(spread, qmSpreadCap(loanCents, String(property["property_type"])))) < 0
            ? "qm"
            : "non_qm";
    }

    // Step 6
    const limitRule = qmFeeLimit(loanCents);
    const limit =
      "cents" in limitRule
        ? String(limitRule.cents)
        : yield* calc(`round(${totalLoan} * ${limitRule.percent} / 100)`);
    const pass = BigInt(kept) <= BigInt(limit);

    // Step 7
    let hpml: boolean | null = null;
    if (spread !== null && primary) {
      const threshold = loanCents > 83_275_000 ? "2.5" : "1.5";
      hpml = (yield* cmp(spread, threshold)) >= 0;
    }

    // Step 8
    const aprTrigger = spread !== null && primary ? (yield* cmp(spread, "6.5")) > 0 : null;
    const hoepaLimit =
      loanCents >= 2_759_200
        ? yield* calc(`round(${totalLoan} * 5 / 100)`)
        : yield* calc(`min(round(${totalLoan} * 8 / 100), 138000)`);
    const feeTrigger = BigInt(kept) > BigInt(hoepaLimit);
    const penaltyTrigger = loan["prepayment_penalty"] === true ? null : false;
    let highCost: boolean | null = null;
    if (primary) {
      const triggers = [aprTrigger, feeTrigger, penaltyTrigger];
      if (triggers.includes(true)) highCost = true;
      else if (triggers.every((t) => t === false)) highCost = false;
    }

    // Step 9
    let recoup: string | null = null;
    let satisfied: boolean | null = null;
    const existing = p["existing_loan"] as Record<string, unknown> | null;
    if (
      loan["purpose"] !== "purchase" &&
      existing &&
      existing["payment_basis"] === "principal_and_interest"
    ) {
      const payment = yield* call<string>(
        "level_payment",
        { principal_cents: String(loanCents), annual_rate_pct: note, term_months: term },
        "payment_cents",
      );
      const saving = yield* calc(`${String(existing["monthly_payment_cents"])} - ${payment}`);
      if (BigInt(saving) <= 0n) satisfied = false;
      else {
        recoup = Number(yield* calc(`round(${total} / ${saving}, 1)`)).toFixed(1);
        satisfied = Number(recoup) <= 60;
      }
    }

    return {
      closing_cost_total_cents: total,
      points_and_fees_cents: kept,
      prepaid_finance_charges_cents: kept,
      total_loan_amount_cents: totalLoan,
      apr_pct: apr,
      apor_pct: apor,
      qm_status: qm,
      points_and_fees_limit_cents: limit,
      points_and_fees_pass: pass,
      is_hpml: hpml,
      hoepa_apr_trigger: aprTrigger,
      hoepa_fee_trigger: feeTrigger,
      hoepa_prepayment_penalty_trigger: penaltyTrigger,
      is_high_cost: highCost,
      ntb_recoup_months: recoup,
      ntb_satisfied: satisfied,
    };
  };

export class RegzReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:regz-rulebook", regzSteps, REGZ_SUBMIT_TOOL);
  }
}
