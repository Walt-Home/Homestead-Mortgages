/**
 * The reference policy for escrow-analysis: the rulebook followed literally,
 * through the tools.
 *
 * It reads only the rendered task. Reading a field — is a bill there, is a
 * date before another — is reading, done here as a model would by looking;
 * every sum, rounding and date step is a tool call. Held to the grader on
 * every generated task, it is the proof that each task can be solved from
 * the rulebook and the tools alone.
 *
 * Calls that do not wait on one another are made together in one turn, as
 * a model may make them and as payments-posting's reference does: each
 * line's sum, each disbursement's anniversary, each disbursement's period.
 * One call a turn, the longest escrow-history ledger ran past the episode's
 * 80 turns; the running balance of Step 4 is still one period a turn.
 */

import type { ToolCall } from "../episode.js";
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

/** One call of a turn's batch: the tool, its input, and the key its answer is read from. */
interface Ask {
  readonly name: string;
  readonly input: Json;
  readonly key: string;
}

/** Calls that do not wait on one another, made together in one turn; read back by id, in order. */
let batches = 0;
export function* together(asks: readonly Ask[]): Step<unknown[]> {
  if (asks.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = asks.map((a, k) => ({
    id: `together-${batch}-${k}`,
    name: a.name,
    input: a.input,
  }));
  const observations = yield calls;
  return calls.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return (JSON.parse(o.content) as Record<string, unknown>)[asks[k]!.key];
  });
}

export const calcAsk = (expression: string): Ask => ({
  name: "calculate",
  input: { expression },
  key: "value",
});
const dateAddAsk = (date: string, months: number, days = 0): Ask => ({
  name: "date_add",
  input: { date, months, days },
  key: "date",
});

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
  const [yearEnd, staleLine] = (yield* together([
    dateAddAsk(yearStart, 12),
    dateAddAsk(asOf, -24),
  ])) as string[];
  // How each line's annual amount is found: a sum to make, a figure to read, or last year's
  // (null). The sums and each unbilled line's first anniversaries wait on nothing, so they go
  // together.
  const basisOf = (l: Line): Ask | string | null => {
    const bills = l.known_bills ?? [];
    if (bills.length > 0) return calcAsk(bills.map((b) => String(b.amount_cents)).join(" + "));
    if (l.estimate_basis === "contract" && l.contract_annual_cents != null)
      return String(l.contract_annual_cents);
    if (l.estimate_basis === "comparable" && l.comparable_annual_cents != null)
      return String(l.comparable_annual_cents);
    if (l.estimate_basis === "prior_year_cpi" && TAX_LINES.includes(l.line_type))
      return calcAsk(
        `round(${l.prior_year_annual_cents} * (100 + ${String(p["cpi_change_pct"])}) / 100)`,
      );
    return null;
  };
  const bases = lines.map(basisOf);
  const unbilled = lines.map((l) => (l.known_bills ?? []).length === 0);
  const first = yield* together([
    ...bases.filter((b): b is Ask => b !== null && typeof b === "object"),
    ...lines.flatMap((l, i) =>
      unbilled[i] ? l.prior_disbursed_on.map((d) => dateAddAsk(d, 12)) : [],
    ),
  ]);
  let read = 0;
  const annuals = lines.map((l, i) => {
    const basis = bases[i];
    if (basis === null || basis === undefined) return String(l.prior_year_annual_cents);
    return typeof basis === "string" ? basis : (first[read++] as string);
  });
  // A disbursement's anniversary still before the new year moves on a year at a time.
  let anniversaries = first.slice(read) as string[];
  for (;;) {
    const early = anniversaries.flatMap((x, k) => (x < yearStart ? [k] : []));
    if (early.length === 0) break;
    const later = (yield* together(
      early.map((k) => dateAddAsk(anniversaries[k]!, 12)),
    )) as string[];
    anniversaries = anniversaries.map((x, k) => {
      const at = early.indexOf(k);
      return at < 0 ? x : later[at]!;
    });
  }
  // Each unbilled line's installment, then its last.
  const counts = lines.map((l) => INSTALLMENTS[l.frequency] ?? 1);
  const unbilledAt = lines.flatMap((_, i) => (unbilled[i] ? [i] : []));
  const pers = (yield* together(
    unbilledAt.map((i) => calcAsk(`round(${annuals[i]!} / ${counts[i]!})`)),
  )) as string[];
  const lasts = (yield* together(
    unbilledAt.map((i, k) => calcAsk(`${annuals[i]!} - ${pers[k]!} * ${counts[i]! - 1}`)),
  )) as string[];

  const disbursements: { on: string; amount: string }[] = [];
  let taken = 0;
  lines.forEach((l, i) => {
    const bills = l.known_bills ?? [];
    if (bases[i] === null && l.prior_year_confirmed_on && l.prior_year_confirmed_on < staleLine!)
      anomalies.push(`${l.line_type}:estimate_basis_prior_year_gt_2y`);
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
      const n = counts[i]!;
      const k = unbilledAt.indexOf(i);
      const per = pers[k]!;
      const last = lasts[k]!;
      const dates = anniversaries.slice(taken, taken + l.prior_disbursed_on.length).sort();
      taken += l.prior_disbursed_on.length;
      dates.slice(0, n).forEach((on, j) => dated.push({ on, amount: j === n - 1 ? last : per }));
    }
    for (const x of dated) {
      if (l.terminates_on && x.on >= l.terminates_on) continue;
      if (x.on >= yearStart && x.on < yearEnd!) disbursements.push(x);
    }
  });

  // Step 3
  const annual = disbursements.length
    ? yield* calc(disbursements.map((x) => x.amount).join(" + "))
    : "0";
  const base = yield* calc(`round(${annual} / 12)`);

  // Step 4: each disbursement's period, together; then the running balance, a period a turn.
  const byPeriod: string[][] = Array.from({ length: 12 }, () => []);
  const periods = (yield* together(
    disbursements.map((x) => ({
      name: "whole_months_between",
      input: { from: yearStart, to: x.on },
      key: "months",
    })),
  )) as number[];
  disbursements.forEach((x, k) => byPeriod[periods[k]!]!.push(x.amount));
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
