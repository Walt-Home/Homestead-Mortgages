/**
 * The reference policy for flexmod-terms: the rulebook followed literally,
 * through the tools. Comparing two figures is reading; every payment, sum,
 * rounding and date is a tool call. The term search halves the range, as
 * Step 6 allows, so a long extension costs about nine payments, not a
 * hundred and seventy.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { FLEX_SUBMIT_TOOL } from "./tools.js";

const NULLS = {
  mir_pct: null,
  gross_upb_cents: null,
  mtmltv_pct: null,
  target_pi_cents: null,
  rate_pct: null,
  term_months: null,
  forborne_cents: null,
  ib_upb_cents: null,
  pi_cents: null,
  reduction_pct: null,
  post_mod_ib_mtmltv_pct: null,
  exhaustion_offer: null,
  trial_months: null,
  first_trial_due_on: null,
  last_trial_due_on: null,
  trial_payment_cents: null,
  effective_on: null,
  capitalization_on: null,
  maturity_on: null,
  incentive_deadline: null,
};

export function* flexSteps(p: Json, call: Call): Step<Json> {
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const big = (x: string | number) => BigInt(x);
  const dateAdd = (date: string, months: number, days = 0) =>
    call<string>("date_add", { date, months, days }, "date");
  const pi = (balance: string, rate: string, months: number) =>
    call<string>(
      "level_payment",
      { principal_cents: balance, annual_rate_pct: rate, term_months: months },
      "payment_cents",
    );
  // Comparing two figures is reading: rates have three decimals, so compare them in thousandths.
  const milli = (x: string) => Math.round(Number(x) * 1000);
  const cmp = (a: string, b: string) => Math.sign(milli(a) - milli(b));
  const loan = p["loan"] as Record<string, unknown>;
  const s = (k: string) => String(loan[k]);
  const evaluation = String(p["evaluation_on"]);

  // Step 1
  const failed = p["last_trial_failed_on"] as string | null;
  if (failed) {
    const days = yield* call<number>("days_between", { from: failed, to: evaluation }, "days");
    if (days < 365)
      return { decision: "denied", denial_reason: "FNMA_D23206_TRIAL_FAILED_12M", ...NULLS };
  }
  if (Number(p["prior_modifications"]) >= 3)
    return { decision: "denied", denial_reason: "FNMA_D23206_THREE_PRIOR_MODS", ...NULLS };

  // Step 2
  const table = (p["mir_table"] as { effective: string; rate_pct: string }[])
    .filter((r) => r.effective <= evaluation)
    .sort((a, b) => (a.effective < b.effective ? 1 : -1));
  const mir = Number(table[0]!.rate_pct).toFixed(3);

  // Step 3
  const gross = yield* calc(
    `${s("ib_upb_cents")} + ${s("accrued_interest_cents")} + ${s("escrow_advances_cents")} + ${s("servicing_advances_cents")} + ${s("prior_nib_cents")} - ${s("buydown_funds_cents")}`,
  );
  const mtmltv = Number(yield* calc(`round(${gross} * 100 / ${s("value_cents")}, 2)`)).toFixed(2);
  const pre = s("pre_mod_pi_cents");
  const eighty = big(yield* calc(`${pre} * 80`));
  const target = (
    eighty % 100n === 0n
      ? big(yield* calc(`${eighty} / 100 - 1`))
      : big(yield* calc(`floor(${eighty} / 100)`))
  ).toString();

  // Step 4
  let rate = Number(s("contract_rate_pct")).toFixed(3);
  if (loan["is_arm_not_final"] === true && cmp(mir, rate) > 0) rate = mir;
  let term = Number(loan["remaining_term_months"]);
  let payment = yield* pi(gross, rate, term);

  // Step 5: P&I falls as the rate falls, so the eighth-point step is found by halving.
  if (cmp(mtmltv, "50") >= 0 && cmp(rate, mir) > 0 && big(payment) > big(target)) {
    const steps = Math.floor((milli(rate) - milli(mir)) / 125);
    const at = (k: number) => calc(`${rate} - ${k} * 0.125`);
    if (steps >= 1) {
      const lowest = Number(yield* at(steps)).toFixed(3);
      const atLowest = yield* pi(gross, lowest, term);
      if (big(atLowest) > big(target)) {
        rate = lowest;
        payment = atLowest;
      } else {
        let lo = 0; // above the target
        let hi = steps; // at or below it
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (big(yield* pi(gross, Number(yield* at(mid)).toFixed(3), term)) <= big(target))
            hi = mid;
          else lo = mid;
        }
        rate = Number(yield* at(hi)).toFixed(3);
        payment = yield* pi(gross, rate, term);
      }
    }
    if (big(payment) > big(target) && cmp(rate, mir) > 0) {
      rate = mir;
      payment = yield* pi(gross, rate, term);
    }
  }

  // Step 6
  if (big(payment) > big(target) && term < 480) {
    let lo = term; // known above the target
    let hi = 480;
    const at480 = yield* pi(gross, rate, 480);
    if (big(at480) > big(target)) {
      term = 480;
      payment = at480;
    } else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (big(yield* pi(gross, rate, mid)) <= big(target)) hi = mid;
        else lo = mid;
      }
      term = hi;
      payment = yield* pi(gross, rate, term);
    }
  }

  // Step 7
  let forborne = "0";
  let ib = gross;
  if (big(payment) > big(target) && cmp(mtmltv, "50") > 0) {
    let solved = yield* call<string>(
      "annuity_principal",
      { payment_cents: target, annual_rate_pct: rate, months: term },
      "principal_cents",
    );
    while (big(yield* pi(solved, rate, term)) > big(target)) solved = yield* calc(`${solved} - 1`);
    const a = yield* calc(`${gross} - ${solved}`);
    const b = yield* calc(`${gross} - floor(${s("value_cents")} / 2)`);
    const c = yield* calc(`round(${gross} * 30 / 100)`);
    forborne = [a, b, c].reduce((x, y) => (big(y) < big(x) ? y : x));
    ib = yield* calc(`${gross} - ${forborne}`);
    payment = yield* pi(ib, rate, term);
  }

  // Step 8
  const delinquent = loan["delinquent_31_plus"] === true;
  const eligible =
    big(payment) <= big(target) ||
    (delinquent ? big(payment) <= big(pre) : big(payment) < big(pre));
  const reduction = yield* calc(`round((${pre} - ${payment}) * 100 / ${pre}, 4)`);
  const figures = {
    mir_pct: mir,
    gross_upb_cents: gross,
    mtmltv_pct: mtmltv,
    target_pi_cents: target,
    rate_pct: rate,
    term_months: term,
    forborne_cents: forborne,
    ib_upb_cents: ib,
    pi_cents: payment,
    reduction_pct: Number(reduction).toFixed(4),
    post_mod_ib_mtmltv_pct: Number(
      yield* calc(`round(${ib} * 100 / ${s("value_cents")}, 2)`),
    ).toFixed(2),
  };
  if (!eligible)
    return { ...NULLS, decision: "denied", denial_reason: "INV_FNMA_F127_PI_RULE", ...figures };

  // Step 9
  const trial = p["trial"] as Record<string, unknown>;
  const notice = String(trial["notice_sent_on"]);
  const months = delinquent ? 3 : 4;
  const firstOfNotice = `${notice.slice(0, 7)}-01`;
  const first = yield* dateAdd(firstOfNotice, Number(notice.slice(8, 10)) <= 15 ? 1 : 2);
  const last = yield* dateAdd(first, months - 1);
  const shortage = yield* calc(`round(${String(trial["escrow_shortage_cents"])} / 60)`);
  const trialPayment = yield* calc(
    `${payment} + ${String(trial["ti_monthly_cents"])} + ${shortage}`,
  );
  const effective = yield* dateAdd(last, 1);
  const capitalization = yield* dateAdd(effective, -1);
  const maturity = yield* dateAdd(effective, term - 1);
  const incentive = yield* call<string>("end_of_month", { date: yield* dateAdd(last, 2) }, "date");
  return {
    decision: "offer",
    denial_reason: null,
    ...figures,
    exhaustion_offer: big(payment) > big(target),
    trial_months: months,
    first_trial_due_on: first,
    last_trial_due_on: last,
    trial_payment_cents: trialPayment,
    effective_on: effective,
    capitalization_on: capitalization,
    maturity_on: maturity,
    incentive_deadline: incentive,
  };
}

export class FlexReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:flexmod-rulebook", flexSteps, FLEX_SUBMIT_TOOL);
  }
}
