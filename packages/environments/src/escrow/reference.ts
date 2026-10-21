/**
 * The reference policy for escrow-analysis: the rulebook followed literally,
 * through the tools.
 *
 * It reads only the rendered task. Reading a field — is a bill there, is a
 * date before another — is reading, done here as a model would by looking;
 * every sum, rounding and date step is a tool call. Held to the grader on
 * every generated task, it is the proof that each task can be solved from
 * the rulebook and the tools alone.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { ESCROW_SUBMIT_TOOL } from "./tools.js";

const TAX_LINES = [
  "tax_county",
  "tax_city",
  "tax_school",
  "tax_special",
  "tax_supplemental",
  "tax_personal_property_mh",
];
const INSTALLMENTS: Readonly<Record<string, number>> = {
  annual: 1,
  semiannual: 2,
  quarterly: 4,
  monthly: 12,
};

interface Bill {
  amount_cents: number;
  due_on: string;
  penalty_on?: string | null;
  discount?: { by: string; amount_cents: number } | null;
  available_on?: string | null;
}
interface Line {
  line_type: string;
  frequency: string;
  estimate_basis: string;
  prior_year_annual_cents: number;
  prior_year_confirmed_on?: string | null;
  known_bills?: Bill[];
  comparable_annual_cents?: number | null;
  contract_annual_cents?: number | null;
  terminates_on?: string | null;
  prior_disbursed_on: string[];
}
interface Posting {
  on: string;
  amount_cents: number;
}

export function* escrowSteps(p: Json, call: Call): Step<Json> {
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const dateAdd = (date: string, months: number, days = 0) =>
    call<string>("date_add", { date, months, days }, "date");
  const big = (x: string | number) => BigInt(x);
  const asOf = p["as_of"] as string;
  const yearStart = p["year_start"] as string;
  const lines = p["lines"] as Line[];
  const anomalies: string[] = [];

  // Steps 1 and 2: each line's amount and its disbursements in the year.
  const yearEnd = yield* dateAdd(yearStart, 12);
  const staleLine = yield* dateAdd(asOf, -24);
  const disbursements: { on: string; amount: string }[] = [];
  for (const l of lines) {
    let annual: string;
    const bills = l.known_bills ?? [];
    if (bills.length > 0)
      annual = yield* calc(bills.map((b) => String(b.amount_cents)).join(" + "));
    else if (l.estimate_basis === "contract" && l.contract_annual_cents != null)
      annual = String(l.contract_annual_cents);
    else if (l.estimate_basis === "comparable" && l.comparable_annual_cents != null)
      annual = String(l.comparable_annual_cents);
    else if (l.estimate_basis === "prior_year_cpi" && TAX_LINES.includes(l.line_type))
      annual = yield* calc(
        `round(${l.prior_year_annual_cents} * (100 + ${String(p["cpi_change_pct"])}) / 100)`,
      );
    else {
      annual = String(l.prior_year_annual_cents);
      if (l.prior_year_confirmed_on && l.prior_year_confirmed_on < staleLine)
        anomalies.push(`${l.line_type}:estimate_basis_prior_year_gt_2y`);
    }
    if (l.line_type === "mi_borrower_paid" && !l.terminates_on)
      anomalies.push("mi_borrower_paid:pmi_without_termination");

    const dated: { on: string; amount: string }[] = [];
    if (bills.length > 0) {
      for (const b of bills) {
        let on = b.penalty_on ?? b.due_on;
        if (b.discount && b.discount.by < on) on = b.discount.by;
        if (b.available_on && on < b.available_on) on = b.available_on;
        dated.push({ on, amount: String(b.amount_cents) });
      }
    } else {
      const n = INSTALLMENTS[l.frequency] ?? 1;
      const per = yield* calc(`round(${annual} / ${n})`);
      const last = yield* calc(`${annual} - ${per} * ${n - 1}`);
      const dates: string[] = [];
      for (const d of l.prior_disbursed_on) {
        let x = yield* dateAdd(d, 12);
        while (x < yearStart) x = yield* dateAdd(x, 12);
        dates.push(x);
      }
      dates.sort();
      dates.slice(0, n).forEach((on, k) => dated.push({ on, amount: k === n - 1 ? last : per }));
    }
    for (const x of dated) {
      if (l.terminates_on && x.on >= l.terminates_on) continue;
      if (x.on >= yearStart && x.on < yearEnd) disbursements.push(x);
    }
  }

  // Step 3
  const annual = disbursements.length
    ? yield* calc(disbursements.map((x) => x.amount).join(" + "))
    : "0";
  const base = yield* calc(`round(${annual} / 12)`);

  // Step 4
  const byPeriod: string[][] = Array.from({ length: 12 }, () => []);
  for (const x of disbursements) {
    const k = yield* call<number>("whole_months_between", { from: yearStart, to: x.on }, "months");
    byPeriod[k]!.push(x.amount);
  }
  let balance = "0";
  let low = 0n;
  for (const out of byPeriod) {
    balance = yield* calc(`${balance} + ${base}${out.map((a) => ` - ${a}`).join("")}`);
    if (big(balance) < low) low = big(balance);
  }
  const requiredStart = (-low).toString();

  // Step 5
  const cushionIn = p["cushion"] as Record<string, number | null>;
  const months = Math.min(
    ...[
      cushionIn["policy_months"],
      cushionIn["instrument_months"],
      cushionIn["state_max_months"],
    ].filter((m): m is number => m !== null && m !== undefined),
  );
  const cushion = yield* calc(`min(floor(${annual} * ${months} / 12), floor(${annual} / 6))`);
  const target = yield* calc(`${requiredStart} + ${cushion}`);

  // Step 6
  const ledger = p["ledger"] as {
    balance_cents: number;
    deposits: Posting[];
    disbursements: Posting[];
  };
  const inWindow = (x: Posting) => x.on > asOf && x.on < yearStart;
  const ins = ledger.deposits.filter(inWindow).map((x) => ` + ${x.amount_cents}`);
  const outs = ledger.disbursements.filter(inWindow).map((x) => ` - ${x.amount_cents}`);
  const actual = yield* calc(`${ledger.balance_cents}${ins.join("")}${outs.join("")}`);

  // Step 7
  const current = Number(p["regx_days_delinquent"]) <= 30;
  const workout = p["workout"] === true;
  const answer: Json = {
    surplus_cents: null,
    shortage_cents: null,
    deficiency_cents: null,
    repayment_months: null,
    installment_cents: null,
    final_installment_cents: null,
    deficiency_installment_cents: null,
    deficiency_final_installment_cents: null,
    lump_sum_option_offered: null,
    credit_monthly_cents: null,
    first_month_extra_credit_cents: null,
    refund_due_on: null,
  };
  let decision: string;
  let payment = base;
  let firstMonth = base;
  let finalMonth = base;
  let surplus = "0";
  if (big(actual) >= big(target)) {
    surplus = yield* calc(`${actual} - ${target}`);
    if (big(surplus) === 0n) decision = "balanced";
    else if (!current) decision = "retain";
    else if (big(surplus) >= 5000n) {
      decision = "refund";
      answer["refund_due_on"] = yield* dateAdd(asOf, 0, 30);
    } else {
      decision = "credit";
      const monthly = yield* calc(`floor(${surplus} / 12)`);
      const extra = yield* calc(`${surplus} - 12 * ${monthly}`);
      answer["credit_monthly_cents"] = monthly;
      answer["first_month_extra_credit_cents"] = extra;
      payment = yield* calc(`${base} - ${monthly}`);
      finalMonth = payment;
      firstMonth = yield* calc(`${base} - ${monthly} - ${extra}`);
    }
    if (decision !== "balanced") answer["surplus_cents"] = surplus;
  } else {
    decision = "shortage";
    const negative = big(actual) < 0n;
    const deficiency = negative ? yield* calc(`abs(${actual})`) : "0";
    const shortage = negative ? target : yield* calc(`${target} - ${actual}`);
    const election = p["borrower_election_months"] as number | null;
    const spread = workout ? (election !== null ? Math.max(12, election) : 60) : 12;
    const installment = yield* calc(`round(${shortage} / ${spread})`);
    const final = yield* calc(`${shortage} - ${installment} * ${spread - 1}`);
    const dInst = negative ? yield* calc(`round(${deficiency} / 12)`) : "0";
    const dFinal = negative ? yield* calc(`${deficiency} - ${dInst} * 11`) : "0";
    Object.assign(answer, {
      shortage_cents: shortage,
      deficiency_cents: deficiency,
      repayment_months: spread,
      installment_cents: installment,
      final_installment_cents: final,
      deficiency_installment_cents: dInst,
      deficiency_final_installment_cents: dFinal,
      lump_sum_option_offered: current && big(shortage) < big(base) && !workout,
    });
    // Step 8
    payment = yield* calc(`${base} + ${installment} + ${dInst}`);
    firstMonth = payment;
    finalMonth = yield* calc(`${base} + ${final} + ${dFinal}`);
  }

  // Step 9
  const earliest = yield* dateAdd(p["statement_sent_on"] as string, 0, 30);
  let effective = yearStart;
  while (effective < earliest) effective = yield* dateAdd(effective, 1);

  // Step 10
  const old = String(p["current_escrow_payment_cents"]);
  const change = yield* calc(`abs(${payment} - ${old})`);
  if (big(old) > 0n && big(change) * 100n > big(old) * 25n)
    anomalies.push("payment_change_gt_25pct");
  if (big(change) > 15000n) anomalies.push("payment_change_gt_150");
  if (decision === "refund" && big(surplus) > 250000n) anomalies.push("surplus_gt_2500");

  return {
    annual_cents: annual,
    base_payment_cents: base,
    required_start_cents: requiredStart,
    cushion_cents: cushion,
    target_at_start_cents: target,
    projected_actual_cents: actual,
    decision,
    ...answer,
    new_payment_cents: payment,
    first_month_payment_cents: firstMonth,
    final_month_payment_cents: finalMonth,
    effective_on: effective,
    anomalies,
  };
}

export class EscrowReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:escrow-rulebook", escrowSteps, ESCROW_SUBMIT_TOOL);
  }
}
