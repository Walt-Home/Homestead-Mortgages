/**
 * The reference policy for lossmit-retention: the rulebook followed
 * literally, through the tools. Comparing two dates or two amounts, and
 * counting months, is reading; every amount of money and every date is a
 * tool call. Calls that do not depend on each other go together in one
 * turn, as a model may make them. Held to the grader on every generated
 * task, it is the proof that each file can be evaluated from the rulebook
 * and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { LOSSMIT_SUBMIT_TOOL } from "./tools.js";

/** One call of a batch: the tool, its input, and the key its answer is read back by. */
type Want = readonly [name: string, input: Json, key: string];

/** Independent calls made together in one turn, read back by id; a null leaves its place empty. */
let batches = 0;
function* together(wants: readonly (Want | null)[]): Step<unknown[]> {
  const live = wants.filter((w): w is Want => w !== null);
  if (live.length === 0) return wants.map(() => null);
  const batch = ++batches;
  const calls: ToolCall[] = live.map(([name, input], k) => ({
    id: `lossmit-${batch}-${k}`,
    name,
    input,
  }));
  const observations = yield calls;
  const answers = calls.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return (JSON.parse(o.content) as Record<string, unknown>)[live[k]![2]];
  });
  let next = 0;
  return wants.map((w) => (w === null ? null : answers[next++]));
}

/** Reading: whether a whole number of cents is at most a positive exact decimal ("315001.5"). */
const atMost = (whole: string, decimal: string): boolean =>
  BigInt(whole) <= BigInt(decimal.split(".")[0]!);

export function* lossmitSteps(p: Json, call: Call): Step<Json> {
  const big = (x: string | number) => BigInt(x);
  const loan = p["loan"] as Json;
  const borrower = p["borrower"] as Json;
  const forbearance = p["forbearance"] as Json;
  const history = p["history"] as Json;
  const deferral = p["deferral"] as Json;
  const evaluation = String(p["evaluation_date"]);
  const provided = String(p["notice_provided_on"]);
  const sale = (p["scheduled_sale_on"] ?? null) as string | null;
  const s = (o: Json, k: string) => String(o[k]);
  const firstOf = (date: string) => `${date.slice(0, 7)}-01`;

  // Step 1, and what Step 5 and Step 8 need that depends on nothing else.
  const [sinceDue, piti, lateCharges, toMaturity, decisionDue, saleDays] = yield* together([
    ["whole_months_between", { from: s(loan, "next_due_date"), to: evaluation }, "months"],
    ["calculate", { expression: `${s(loan, "pi_cents")} + ${s(loan, "escrow_cents")}` }, "value"],
    [
      "calculate",
      { expression: `${s(loan, "unpaid_late_charges")} * ${s(loan, "late_charge_cents")}` },
      "value",
    ],
    ["whole_months_between", { from: evaluation, to: s(loan, "maturity_date") }, "months"],
    ["date_add", { date: evaluation, days: 30 }, "date"],
    sale ? ["days_between", { from: evaluation, to: sale }, "days"] : null,
  ]);
  const md = Number(sinceDue) + 1;
  const PITI = String(piti);
  const LC = String(lateCharges);

  // Step 8's tier and window are reading once the days to the sale are known.
  const days = saleDays === null ? null : Number(saleDays);
  const tier = days === null || days >= 90 ? "ge_90" : days > 37 ? "lt_90" : "le_37";
  const window = tier === "ge_90" ? (p["state"] === "NY" ? 30 : 14) : 7;
  const [arrearsValue, acceptBy] = yield* together([
    ["calculate", { expression: `${md} * ${PITI} + ${LC}` }, "value"],
    ["date_add", { date: provided, days: window }, "date"],
  ]);
  const arrears = String(arrearsValue);
  const deemed = yield* call<string>(
    "date_add",
    { date: String(acceptBy), days: window === 7 ? 3 : 5 },
    "date",
  );
  const regx = {
    tier,
    decision_due: String(decisionDue),
    window_days: window,
    accept_by: String(acceptBy),
    appeal_rights: tier === "ge_90",
    deemed_rejected_on: deemed,
  };
  const answer = (rest: Json): Json => ({
    arrears: { months_delinquent: md, late_charges_cents: LC, arrears_cents: arrears },
    terms: null,
    deferral_screen: null,
    deferral_timeline: null,
    regx,
    ...rest,
  });

  // Step 2 (a) and (b)
  if (big(s(borrower, "funds_available_cents")) >= big(arrears))
    return answer({ offered: "reinstatement" });
  const hardship = s(borrower, "hardship");
  if (hardship === "temporary_unresolved") {
    // Step 3
    const forborne = Number(forbearance["forborne_months"]);
    const requested = Number(forbearance["requested_months"]);
    const caps: [string, number][] = [
      ["increment_3", 3],
      ["requested", requested],
      ["cumulative_12", 12 - forborne],
      ["delinquency_12", 12 - md],
    ];
    const months = Math.max(0, Math.min(...caps.map((c) => c[1])));
    const [start, lastMonth] = yield* together([
      ["date_add", { date: firstOf(evaluation), months: 1 }, "date"],
      ["date_add", { date: firstOf(evaluation), months }, "date"],
    ]);
    const end = yield* call<string>("end_of_month", { date: String(lastMonth) }, "date");
    return answer({
      offered: "forbearance",
      terms: {
        months,
        capped_by: caps.filter(([n, c]) => c === months && n !== "requested").map(([n]) => n),
        exception_required: requested > months,
        term_start: String(start),
        term_end: end,
        regx_short_term: forborne + months <= 6,
      },
    });
  }
  if (hardship !== "resolved") return answer({ offered: "flex_mod" });

  // Step 4: every term's total, and 150% of PITI, side by side.
  const terms = Array.from({ length: 12 }, (_, k) => k + 1);
  const found = yield* together([
    ["calculate", { expression: `${PITI} * 3 / 2` }, "value"],
    ...terms.map((m): Want => [
      "calculate",
      { expression: `${PITI} + ceil(${arrears} / ${m})` },
      "value",
    ]),
  ]);
  const cap = String(found[0]);
  const capacity = s(borrower, "capacity_cents");
  const plan = terms.find((m) => {
    const total = String(found[m]);
    return atMost(total, cap) && big(total) <= big(capacity);
  });
  if (plan !== undefined) {
    const total = String(found[plan]);
    const [installment, last, pct, monthsOfArrears] = yield* together([
      ["calculate", { expression: `ceil(${arrears} / ${plan})` }, "value"],
      [
        "calculate",
        { expression: `${arrears} - ceil(${arrears} / ${plan}) * ${plan - 1}` },
        "value",
      ],
      ["calculate", { expression: `floor(${total} * 10000 / ${PITI}) / 100` }, "value"],
      ["calculate", { expression: `floor(${arrears} / ${PITI})` }, "value"],
    ]);
    return answer({
      offered: "repayment_plan",
      terms: {
        months: plan,
        installment_cents: String(installment),
        final_installment_cents: String(last),
        total_monthly_cents: total,
        pct_of_contractual: Number(pct).toFixed(2),
        regx_short_term: Number(monthsOfArrears) <= 3 && plan <= 6,
      },
    });
  }

  // Step 5: each date the screen compares, side by side.
  const dated = (k: string) => (history[k] ?? null) as string | null;
  const twelve = (date: string | null): Want | null =>
    date ? ["date_add", { date, months: 12 }, "date"] : null;
  const [seasoned, priorEnds, trialEnds, modEnds] = (yield* together([
    twelve(s(loan, "origination_date")),
    twelve(dated("last_deferral_effective")),
    twelve(dated("last_failed_trial_on")),
    twelve(dated("last_modification_effective")),
  ])) as (string | null)[];
  const before = (date: string | null | undefined) => typeof date === "string" && evaluation < date;
  const arrangements = (history["active_arrangements"] ?? []) as string[];
  const reason = before(seasoned)
    ? "INV_FNMA_D23204_SEASONING_12M"
    : md < 2 || md > 6
      ? "INV_FNMA_D23204_DELQ_WINDOW"
      : before(priorEnds)
        ? "INV_FNMA_D23204_PRIOR_DEFERRAL_12M"
        : Number(toMaturity) < 36
          ? "INV_FNMA_D23204_MATURITY"
          : arrangements.length > 0
            ? "INV_FNMA_D23204_CONFLICTING_ARRANGEMENT"
            : before(trialEnds) || before(modEnds)
              ? "INV_FNMA_D23204_TRIAL_OR_MOD_12M"
              : null;
  if (reason !== null)
    return answer({
      offered: p["flexmod_eligible"] === true ? "flex_mod" : "none",
      deferral_screen: { eligible: false, reason },
    });

  // Step 6
  const cumulative = Number(history["cumulative_deferred_months"]);
  const after = cumulative + md;
  const deferred = after <= 12 ? md : Math.max(0, 12 - cumulative);
  const processing = deferral["processing_month_elected"] === true;
  const [nib, shortage, entryMonth] = yield* together([
    [
      "calculate",
      {
        expression: `${deferred} * ${s(loan, "pi_cents")} + ${s(deferral, "escrow_advances_cents")} + ${s(deferral, "servicing_advances_cents")}`,
      },
      "value",
    ],
    ["calculate", { expression: `round(${s(deferral, "escrow_shortage_cents")} / 60)` }, "value"],
    processing ? ["date_add", { date: firstOf(evaluation), months: 1 }, "date"] : null,
  ]);
  // Step 7
  const entry = yield* call<string>(
    "end_of_month",
    { date: entryMonth === null ? evaluation : String(entryMonth) },
    "date",
  );
  const [payment, lar, effective] = yield* together([
    [
      "calculate",
      { expression: `${s(loan, "pi_cents")} + ${s(loan, "escrow_cents")} + ${String(shortage)}` },
      "value",
    ],
    ["add_business_days", { date: entry, days: -1, calendar: "fannie_mae" }, "date"],
    ["date_add", { date: entry, days: 1 }, "date"],
  ]);
  const custodian = yield* call<string>("date_add", { date: String(effective), days: 25 }, "date");
  return answer({
    offered: "payment_deferral",
    terms: {
      months_deferred: deferred,
      installments_to_pay: md - deferred,
      contractual_payment_required: md === 6 || after > 12,
      cumulative_months_after: cumulative + deferred,
      nib_cents: String(nib),
      late_charges_waived_cents: LC,
      shortage_monthly_cents: String(shortage),
      new_payment_cents: String(payment),
    },
    deferral_screen: { eligible: true, reason: null },
    deferral_timeline: {
      processing_month: processing,
      entry_deadline: entry,
      lar_deadline: String(lar),
      effective: String(effective),
      custodian_by: custodian,
    },
  });
}

export class LossmitReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:lossmit-rulebook", lossmitSteps, LOSSMIT_SUBMIT_TOOL);
  }
}
