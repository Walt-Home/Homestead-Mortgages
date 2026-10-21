/**
 * The reference policy for payoff-statement: the rulebook followed
 * literally, through the tools. Reading a date, a state or a flag, and
 * comparing two of them, is reading; every date worked out and every figure
 * is a tool call. Calls that do not depend on each other go together in one
 * turn, as a model may make them, so a whole payoff is about eight turns.
 * Held to the grader on every generated task, it is the proof that each
 * payoff can be worked from the rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { PAYOFF_SUBMIT_TOOL } from "./tools.js";

/** One tool call to make in a batch: its name, its input, and the key its answer is read from. */
type Ask = readonly [name: string, input: Json, key: string];

/** Independent calls made together in one turn; each answer read back by id, null where nothing was asked. */
let batches = 0;
function* together(asks: readonly (Ask | null)[]): Step<unknown[]> {
  const batch = ++batches;
  const calls: (ToolCall & { key: string })[] = [];
  const slots = asks.map((a, k) => {
    if (!a) return null;
    const c = { id: `payoff-${batch}-${k}`, name: a[0], input: a[1], key: a[2] };
    calls.push(c);
    return c;
  });
  if (calls.length === 0) return asks.map(() => null);
  const observations = yield calls.map(({ id, name, input }) => ({ id, name, input }));
  return slots.map((c) => {
    if (!c) return null;
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return (JSON.parse(o.content) as Record<string, unknown>)[c.key];
  });
}

const STATE_RULES: Readonly<Record<string, readonly ["calendar" | "business", number]>> = {
  CA: ["calendar", 21],
  FL: ["calendar", 10],
  NY: ["calendar", 30],
  NC: ["calendar", 10],
  MA: ["business", 5],
  TX: ["business", 7],
  CT: ["business", 7],
};

export function* payoffSteps(p: Json, _call: Call): Step<Json> {
  const req = p["request"] as Record<string, string>;
  const loan = p["loan"] as Record<string, unknown>;
  const next = p["next_installment"] as {
    due_on: string;
    principal_cents: number;
    autodraft: boolean;
  } | null;
  const funds = p["funds"] as {
    received_on: string;
    amount_cents: number;
    installment_due_on: string;
  };
  const inv = p["investor"] as {
    remittance_type: "AA" | "SA" | "SS";
    ptr_pct: string;
    mbs_pool: boolean;
    reported_on: string;
  };
  const n = (k: string) => String(loan[k]);
  const upb = n("upb_cents");
  const rate = n("rate_pct");
  const ptr = inv.ptr_pct;
  const lpi = n("lpi_due");
  const dsi = loan["accrual_method"] === "daily_simple_365";
  const {
    received_on: received,
    state,
    issued_on: issued,
    good_through: gt,
  } = req as {
    received_on: string;
    state: string;
    issued_on: string;
    good_through: string;
  };
  const type = inv.remittance_type;
  const calc = (expression: string): Ask => ["calculate", { expression }, "value"];
  const months = (from: string, to: string): Ask => [
    "whole_months_between",
    { from, to },
    "months",
  ];
  const days = (from: string, to: string): Ask => ["days_between", { from, to }, "days"];
  const addDays = (date: string, d: number): Ask => ["date_add", { date, days: d }, "date"];
  const addMonths = (date: string, m: number): Ask => ["date_add", { date, months: m }, "date"];
  const addBd = (date: string, d: number, calendar: string): Ask => [
    "add_business_days",
    { date, days: d, calendar },
    "date",
  ];
  const isBd = (date: string, calendar: string): Ask => [
    "is_business_day",
    { date, calendar },
    "business_day",
  ];
  const full = (balance: string, r: string, m: number) =>
    calc(`${m} * round(${balance} * ${r} / 1200)`);
  const partial = (balance: string, r: string, d: number) =>
    calc(`round(${balance} * ${r} * ${d} / 36500)`);
  const total = (balance: string, f: string, pt: string, nib: string) =>
    calc(
      `${balance} + ${f} + ${pt} + ${nib} + ${n("late_charges_cents")} + ${n("fees_cents")} + ${n("corporate_advances_cents")} + ${n("escrow_advance_cents")} + ${n("recording_fee_cents")} + ${n("mi_premium_cents")} - ${n("buydown_credit_cents")} - ${n("suspense_credit_cents")}`,
    );
  const altApplies = next !== null && next.due_on > issued && next.due_on <= gt;
  const rule = STATE_RULES[state];
  const shareWalk = type !== "SA";

  // Steps 1, 2 and 3's first reads, the per diem, the NIB line, and Step 6's due-date test.
  const [
    federalDue,
    stateFloor,
    maFloor,
    stmtSpan,
    perDiem,
    nib,
    dueIsBd,
    dueNextBd,
    altUpb,
    altSpan,
  ] = yield* together([
    addBd(received, 7, "servicer"),
    rule
      ? rule[0] === "calendar"
        ? addDays(received, rule[1])
        : addBd(received, rule[1], "servicer")
      : null,
    state === "MA" ? addDays(issued, 30) : null,
    dsi ? days(lpi, gt) : months(lpi, gt),
    ["per_diem", { balance_cents: upb, annual_rate_pct: rate }, "per_diem_cents"],
    calc(`${n("nib_deferred_cents")} + ${n("nib_forborne_cents")}`),
    isBd(funds.installment_due_on, "servicer"),
    addBd(funds.installment_due_on, 1, "servicer"),
    altApplies ? calc(`${upb} - ${next.principal_cents}`) : null,
    altApplies ? (dsi ? days(next.due_on, gt) : months(next.due_on, gt)) : null,
  ]);

  // Step 1
  const stateDue =
    rule === undefined
      ? null
      : state === "CT"
        ? gt >= (stateFloor as string)
          ? gt
          : (stateFloor as string)
        : (stateFloor as string);
  const governing = stateDue !== null && stateDue < (federalDue as string) ? "state" : "federal";
  // Step 2
  const validUntil = state === "MA" && (maFloor as string) > gt ? (maFloor as string) : gt;
  // Step 6: the payoff date
  const payoff =
    dueIsBd === false && funds.received_on === dueNextBd
      ? funds.installment_due_on
      : funds.received_on;
  const firstOfPayoffMonth = `${payoff.slice(0, 7)}-01`;
  const mbsTest = type === "SS" && inv.mbs_pool;

  const [
    stmtCursor,
    altCursor,
    payoffSpan,
    monthlyPayoffMonths,
    escrowBy,
    fnmaPrincipal,
    halfOrFull,
    firstIsBd,
    firstPlus1,
    firstPlus2,
  ] = yield* together([
    dsi ? null : addMonths(lpi, stmtSpan as number),
    altApplies && !dsi ? addMonths(next.due_on, altSpan as number) : null,
    dsi ? days(lpi, payoff) : months(lpi, payoff),
    dsi && shareWalk ? months(lpi, payoff) : null,
    addBd(payoff, 20, "federal"),
    calc(`${upb} + ${nib as string}`),
    type === "SA"
      ? calc(`round(${upb} * ${ptr} / 2400)`)
      : type === "SS"
        ? calc(`round(${upb} * ${ptr} / 1200)`)
        : null,
    mbsTest ? isBd(firstOfPayoffMonth, "fannie_mae") : null,
    mbsTest ? addBd(firstOfPayoffMonth, 1, "fannie_mae") : null,
    mbsTest ? addBd(firstOfPayoffMonth, 2, "fannie_mae") : null,
  ]);

  // The monthly walk to the payoff date: Step 6's for a monthly loan, Step 9's for every loan.
  const walkMonths = dsi ? (monthlyPayoffMonths as number | null) : (payoffSpan as number);
  const [stmtDays, altDays, walkCursor] = yield* together([
    dsi ? null : days(stmtCursor as string, gt),
    altApplies && !dsi ? days(altCursor as string, gt) : null,
    walkMonths === null ? null : addMonths(lpi, walkMonths),
  ]);

  // Step 3 for the statement and for the alternative figure
  const stmtMonths = dsi ? 0 : (stmtSpan as number);
  const stmtPartialDays = dsi ? (stmtSpan as number) : (stmtDays as number);
  const altMonths = dsi ? 0 : (altSpan as number);
  const altPartialDays = dsi ? (altSpan as number) : (altDays as number);

  const [walkDays, stmtFull, stmtPartial, altFull, altPartial] = yield* together([
    walkMonths === null ? null : days(walkCursor as string, payoff),
    dsi ? null : full(upb, rate, stmtMonths),
    partial(upb, rate, stmtPartialDays),
    altApplies && !dsi ? full(altUpb as string, rate, altMonths) : null,
    altApplies ? partial(altUpb as string, rate, altPartialDays) : null,
  ]);
  const interestFull = dsi ? "0" : (stmtFull as string);

  // Step 6: the exact figure, from the payoff date's day count
  const exactMonths = dsi ? 0 : (payoffSpan as number);
  const exactDays = dsi ? (payoffSpan as number) : (walkDays as number);
  const [exactFull, exactPartial, stmtTotal, altTotal, ptrFull, ptrPartial] = yield* together([
    dsi ? null : full(upb, rate, exactMonths),
    partial(upb, rate, exactDays),
    total(upb, interestFull, stmtPartial as string, nib as string),
    altApplies
      ? total(
          altUpb as string,
          dsi ? "0" : (altFull as string),
          altPartial as string,
          nib as string,
        )
      : null,
    type === "AA" ? full(upb, ptr, walkMonths as number) : null,
    shareWalk ? partial(upb, ptr, walkDays as number) : null,
  ]);
  const exactInterestFull = dsi ? "0" : (exactFull as string);

  // Step 9: Fannie Mae's interest
  let fnmaInterest: string;
  let gapAsk: Ask | null = null;
  const [exactTotal, aaInterest, collected] = yield* together([
    total(upb, exactInterestFull, exactPartial as string, nib as string),
    type === "AA" ? calc(`${ptrFull as string} + ${ptrPartial as string}`) : null,
    type === "AA" ? calc(`${exactInterestFull} + ${exactPartial as string}`) : null,
  ]);
  if (type === "AA") fnmaInterest = aaInterest as string;
  else if (type === "SA") fnmaInterest = halfOrFull as string;
  else {
    const bd1 = firstIsBd === true ? firstOfPayoffMonth : (firstPlus1 as string);
    const bd2 = firstIsBd === true ? (firstPlus1 as string) : (firstPlus2 as string);
    fnmaInterest =
      mbsTest && payoff === bd1 && inv.reported_on <= bd2 ? "0" : (halfOrFull as string);
    if (fnmaInterest !== "0") gapAsk = calc(`${fnmaInterest} - ${ptrPartial as string}`);
  }

  // Steps 6, 7 and 9's sums
  const [variance, fee, gap, fnmaTotal] = yield* together([
    calc(`${funds.amount_cents} - ${exactTotal as string}`),
    type === "AA" ? calc(`${collected as string} - ${fnmaInterest}`) : null,
    gapAsk,
    calc(`${fnmaPrincipal as string} + ${fnmaInterest}`),
  ]);
  const v = BigInt(variance as string);
  const reliance = ["FL", "TX", "CA"].includes(state) && payoff <= gt;
  const disposition =
    v === 0n
      ? "paid_in_full"
      : v > 100n
        ? "paid_in_full_overage_refund_10bd"
        : v >= -5000n
          ? "paid_in_full_tolerance_expense"
          : reliance
            ? "reliance_absorbed"
            : "short_payoff_demand_1bd";
  const ssGap =
    type !== "SS" ? null : gap === null ? "0" : BigInt(gap as string) < 0n ? "0" : (gap as string);

  return {
    federal_due: federalDue,
    state_due: stateDue,
    governing,
    governing_due: governing === "state" ? stateDue : federalDue,
    valid_until: validUntil,
    months_full: stmtMonths,
    days_partial: stmtPartialDays,
    interest_full_cents: interestFull,
    interest_partial_cents: stmtPartial,
    per_diem_cents: perDiem,
    nib_line_cents: nib,
    total_cents: stmtTotal,
    alt_applies: altApplies,
    alt_if_posts_total_cents: altApplies ? altTotal : null,
    payoff_date: payoff,
    exact_total_cents: exactTotal,
    variance_cents: variance,
    disposition,
    escrow_refund_by: escrowBy,
    fnma_principal_cents: fnmaPrincipal,
    fnma_interest_cents: fnmaInterest,
    servicing_fee_cents: type === "AA" ? fee : null,
    ss_interest_gap_cents: ssGap,
    fnma_total_cents: fnmaTotal,
  };
}

export class PayoffReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:payoff-rulebook", payoffSteps, PAYOFF_SUBMIT_TOOL);
  }
}
