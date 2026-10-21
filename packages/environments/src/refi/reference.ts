/**
 * The reference policy: the rulebook followed literally, through the tools.
 *
 * It reads only what a model reads — the rendered task — and every figure
 * it reaches is a tool call's answer, every comparison one a model could
 * make by reading two numbers. Held to the grader on every generated task,
 * it is the proof that each task can be solved from the rulebook and the
 * tools alone: a task the reference fails is a defect in the environment,
 * not a hard question.
 */

import type { Observation, Policy, PolicySession, PolicyTurn, ToolCall } from "../episode.js";
import { payloadOf } from "./task.js";
import { SUBMIT_TOOL } from "./tools.js";

export type Json = Record<string, unknown>;
export type Step<R> = Generator<ToolCall[], R, readonly Observation[]>;
export type Call = <R>(name: string, input: Json, key: string) => Step<R>;

const EXCLUSIONS: readonly (readonly [string, (l: Json) => boolean])[] = [
  ["not_active", (l) => l["status"] !== "active"],
  ["bankruptcy_active", (l) => l["bankruptcy_active"] === true],
  ["foreclosure_referred", (l) => l["foreclosure_referred"] === true],
  ["lossmit_plan_active", (l) => l["lossmit_plan_active"] === true],
  ["deceased_or_sii_pending", (l) => l["deceased_or_sii_pending"] === true],
  ["transfer_out_pending", (l) => l["transfer_out_pending"] === true],
  ["delinquent", (l) => Number(l["regx_days_delinquent"]) > 0],
];
const LIMITS: Readonly<Record<string, number>> = {
  primary: 9700,
  second_home: 9000,
  investment: 7500,
};
const SUPPRESSIONS = ["cooldown", "frequency_cap", "marketing_suppression"];

/** Steps 1 to 11 over a payload whose `loan` is the review's row; a variant reuses it once it has built the row. */
export function* reviewSteps(p: Json, call: Call): Step<Json> {
  const loan = p["loan"] as Json;
  const date = p["review_date"] as string;
  const quote = p["quote"] as Json | null;
  const history = p["offer_history"] as { declined_on: string | null; offered_at: string[] };
  const exceptions = p["tape_exceptions"] as string[];
  const s = (k: string) => String(loan[k]);
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const big = (x: string) => BigInt(x);

  // Step 1
  for (const [code, applies] of EXCLUSIONS) {
    if (applies(loan))
      return { verdict: "excluded", reasons: [code], offer: null, watch_rate_pct: null };
  }

  // Step 2
  let suppression: string | null = null;
  if (loan["refi_do_not_solicit"] === true) suppression = "marketing_suppression";
  else if (history.declined_on) {
    const opens = yield* call<string>("date_add", { date: history.declined_on, days: 90 }, "date");
    if (date < opens) suppression = "cooldown";
  }
  if (!suppression) {
    const since = yield* call<string>("date_add", { date, months: -12 }, "date");
    if (history.offered_at.filter((d) => d > since && d <= date).length >= 2)
      suppression = "frequency_cap";
  }

  // Step 3
  const consummation = yield* call<string>("date_add", { date, days: 36 }, "date");
  const disbursement = yield* call<string>("date_add", { date: consummation, days: 6 }, "date");

  // Step 4
  const r0 = s("note_rate_pct");
  const toDisbursement = yield* call<number>(
    "days_between",
    { from: s("next_due_date"), to: disbursement },
    "days",
  );
  const payoffDays = Math.max(0, toDisbursement);
  const perDiem = yield* call<string>(
    "per_diem",
    { balance_cents: s("upb_cents"), annual_rate_pct: r0 },
    "per_diem_cents",
  );
  const payoff = yield* calc(`${s("upb_cents")} + ${perDiem} * ${payoffDays}`);
  const monthEnd = yield* call<string>("end_of_month", { date: disbursement }, "date");
  const prepaidDays =
    (yield* call<number>("days_between", { from: disbursement, to: monthEnd }, "days")) + 1;
  const prepaid = function* (amount: string): Step<string> {
    const pd = yield* call<string>(
      "per_diem",
      { balance_cents: amount, annual_rate_pct: r0 },
      "per_diem_cents",
    );
    return yield* calc(`${pd} * ${prepaidDays}`);
  };
  const cashBack = function* (amount: string): Step<string> {
    return yield* calc(`${amount} - ${payoff} - ${yield* prepaid(amount)}`);
  };
  const cap = (amount: string) => calc(`max(round(${amount} * 0.01), 200000)`);
  const raw = yield* calc(
    `${payoff} + ${yield* prepaid(payoff)} + ${s("net_escrow_deposit_estimate_cents")}`,
  );
  const rounded = yield* calc(`ceil(${raw} / 100000) * 100000`);
  const loanAmount = big(yield* cashBack(rounded)) <= big(yield* cap(rounded)) ? rounded : raw;
  const cashBackCents = yield* cashBack(loanAmount);
  const capCents = yield* cap(loanAmount);

  // Step 5
  const value = (loan["value_estimate"] as Json)["value_cents"] as number;
  const ltv = Number(yield* calc(`round(${loanAmount} * 10000 / ${value})`));
  const lowConfidence = (loan["value_estimate"] as Json)["confidence"] === "low";
  const prescreenOk = ltv <= (LIMITS[s("occupancy")] ?? 0) && !(lowConfidence && ltv > 9000);

  // Step 10, read now: it does not depend on the quote.
  const staleLine = yield* call<string>("date_add", { date, months: -24 }, "date");
  const stale = String((loan["value_estimate"] as Json)["as_of"]) < staleLine;
  const implausible = exceptions.includes("implausible_value");

  let collected: string[];
  let fired = false;
  let offer: Json | null = null;
  if (!quote) {
    // Step 6
    collected = [...(suppression ? [suppression] : []), "not_priceable", "not_priced"];
  } else {
    // Step 7
    const r1 = String(quote["note_rate_pct"]);
    const pi0 = s("pi_cents");
    const remaining = Number(loan["remaining_term_months"]);
    const newPi = yield* call<string>(
      "level_payment",
      { principal_cents: loanAmount, annual_rate_pct: r1, term_months: 360 },
      "payment_cents",
    );
    const miNew = ltv > 8000 ? String(quote["mi_monthly_cents"] ?? 0) : "0";
    const miExisting = loan["mi_status"] === "bpmi_active" ? s("mi_monthly_cents") : "0";
    const piDelta = yield* calc(`${pi0} - ${newPi}`);
    const paymentDelta = yield* calc(`${piDelta} + ${miExisting} - ${miNew}`);
    const rateDelta = yield* calc(`round((${r0} - ${r1}) * 100, 1)`);
    const lifeExisting = yield* calc(`${pi0} * ${remaining} - ${s("upb_cents")}`);
    const lifeNew = yield* calc(`${newPi} * 360 - ${loanAmount}`);
    const samePi = yield* call<string>(
      "level_payment",
      { principal_cents: loanAmount, annual_rate_pct: r1, term_months: remaining },
      "payment_cents",
    );
    const sameLife = yield* calc(`${samePi} * ${remaining} - ${loanAmount}`);
    const npv = yield* call<string>(
      "present_value",
      { monthly_amount_cents: paymentDelta, annual_rate_pct: r1, months: 84 },
      "present_value_cents",
    );
    const sameDelta = yield* calc(`${pi0} - ${samePi} + ${miExisting} - ${miNew}`);
    const sameNpv = yield* call<string>(
      "present_value",
      { monthly_amount_cents: sameDelta, annual_rate_pct: r1, months: 84 },
      "present_value_cents",
    );
    const balExisting = yield* call<string>(
      "balance_after",
      {
        start_balance_cents: s("upb_cents"),
        annual_rate_pct: r0,
        payment_cents: pi0,
        payments: 84,
      },
      "balance_cents",
    );
    const balNew = yield* call<string>(
      "balance_after",
      { start_balance_cents: loanAmount, annual_rate_pct: r1, payment_cents: newPi, payments: 84 },
      "balance_cents",
    );
    const seven = yield* calc(`(${pi0} * 84 + ${balExisting}) - (${newPi} * 84 + ${balNew})`);

    // Step 8
    let statePass = true;
    if (s("property_state") === "MA") {
      const months = yield* call<number>(
        "whole_months_between",
        { from: s("consummation_date"), to: consummation },
        "months",
      );
      if (months < 60) statePass = big(piDelta) > 0n || Number(rateDelta) > 0;
    }

    // Step 9
    collected = [];
    if (Number(rateDelta) < 25) collected.push("rate_delta_below_floor");
    if (big(npv) <= 0n) collected.push("npv_not_positive");
    if (big(seven) <= 0n) collected.push("seven_year_not_lower");
    if (!prescreenOk) collected.push("prescreen_failed");
    if (!statePass) collected.push("state_rule_failed");
    if (suppression) collected.push(suppression);
    let presentSameTermFirst = false;
    if (big(yield* calc(`${lifeNew} - ${lifeExisting}`)) > 0n) {
      if (big(sameNpv) > 0n) presentSameTermFirst = true;
      else collected.push("reset_costs_more");
    }
    fired = collected.length === 0;
    offer = {
      loan_amount_cents: loanAmount,
      new_pi_cents: newPi,
      pi_delta_cents: piDelta,
      rate_delta_bps: Number(rateDelta),
      cash_back_cents: cashBackCents,
      cash_back_cap_cents: capCents,
      lifetime_interest_existing_cents: lifeExisting,
      lifetime_interest_new_cents: lifeNew,
      same_term_pi_cents: samePi,
      same_term_lifetime_interest_cents: sameLife,
      npv_cents: npv,
      seven_year_total_cost_delta_cents: seven,
      present_same_term_first: presentSameTermFirst,
    };
  }

  // Step 11
  if (fired && !stale && !implausible) {
    return {
      verdict: "candidate",
      reasons: [
        "rate_delta",
        "npv_positive",
        "seven_year_delta_positive",
        "prescreen",
        "state_rule",
      ],
      offer,
      watch_rate_pct: null,
    };
  }
  if (stale || implausible || collected.some((c) => SUPPRESSIONS.includes(c))) {
    return {
      verdict: "not_now",
      reasons: [
        ...collected,
        ...(implausible ? ["implausible_value"] : []),
        ...(stale ? ["value_stale"] : []),
      ],
      offer: null,
      watch_rate_pct: null,
    };
  }
  const watch = yield* calc(`floor((${r0} - 0.25) * 8) / 8`);
  return {
    verdict: "watching",
    reasons: collected,
    offer: null,
    watch_rate_pct: Number(watch).toFixed(3),
  };
}

/** A policy that plays a solver: the solver yields tool calls and returns the submission. */
export class ScriptedPolicy implements Policy {
  constructor(
    readonly id: string,
    private readonly solve: (payload: Json, call: Call) => Step<Json>,
    private readonly submitTool: string = SUBMIT_TOOL,
  ) {}

  start(episode: { readonly user: string }): PolicySession {
    let n = 0;
    const call = function* <R>(name: string, input: Json, key: string): Step<R> {
      const id = `ref-${++n}`;
      const [obs] = yield [{ id, name, input }];
      if (!obs || obs.call_id !== id) throw new Error(`no observation for ${id}`);
      if (obs.is_error) throw new Error(`${name} failed: ${obs.content}`);
      return (JSON.parse(obs.content) as Record<string, R>)[key] as R;
    };
    const steps = this.solve(payloadOf(episode.user), call);
    let started = false;
    let submitted = false;
    return {
      act: async (observations): Promise<PolicyTurn> => {
        if (submitted) return { calls: [], text: "", stop: "end" };
        const next = started ? steps.next(observations) : steps.next();
        started = true;
        if (!next.done) return { calls: next.value, text: "", stop: "tool_calls" };
        submitted = true;
        return {
          calls: [{ id: `ref-${++n}`, name: this.submitTool, input: next.value }],
          text: "",
          stop: "tool_calls",
        };
      },
    };
  }
}

export class ReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", reviewSteps);
  }
}
