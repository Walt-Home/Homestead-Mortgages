/**
 * The reference policy for metro2-furnishing: the rulebook followed
 * literally, through the tools. Reading a date, a status, a flag or a
 * figure's dollars is reading; every sum, product, quotient, rounding, day
 * count and month-end is a tool call. Independent calls go together in one
 * turn, as a model may make them. Held to the grader on every generated
 * task, it is the proof that each window can be furnished from the
 * rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { METRO2_SUBMIT_TOOL } from "./tools.js";

/** Independent calls made together in one turn, as a model may make them; read back by id. */
let batches = 0;
function* together(
  asks: readonly { readonly name: string; readonly input: Json; readonly key: string }[],
): Step<unknown[]> {
  if (asks.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = asks.map((a, k) => ({
    id: `each-${batch}-${k}`,
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
function* each<R>(name: string, inputs: readonly Json[], key: string): Step<R[]> {
  return (yield* together(inputs.map((input) => ({ name, input, key })))) as R[];
}

/** The same calculation asked once, however many times it is needed. */
function* calcAll(expressions: readonly string[]): Step<Map<string, string>> {
  const distinct = [...new Set(expressions)];
  const values = yield* each<string>(
    "calculate",
    distinct.map((expression) => ({ expression })),
    "value",
  );
  return new Map(distinct.map((e, k) => [e, values[k]!]));
}

const BUCKETS: readonly [number, string, string][] = [
  [180, "84", "6"],
  [150, "83", "5"],
  [120, "82", "4"],
  [90, "80", "3"],
  [60, "78", "2"],
  [30, "71", "1"],
  [0, "11", "0"],
];
const statusFor = (days: number) => BUCKETS.find(([d]) => days >= d)![1];
const ratingFor = (days: number) => BUCKETS.find(([d]) => days >= d)![2];
const PHP_CHAR: Readonly<Record<string, string>> = {
  "11": "0",
  "71": "1",
  "78": "2",
  "80": "3",
  "82": "4",
  "83": "5",
  "84": "6",
};
const CLOSINGS = ["payoff", "short_sale", "foreclosure_sale", "deed_in_lieu"];

/** YYYY-MM-DD → MMDDYYYY; none → 00000000. Reading. */
const m2date = (d: string | null) =>
  d === null ? "00000000" : `${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(0, 4)}`;
const fromM2 = (s: string): string | null =>
  s === "00000000" ? null : `${s.slice(4, 8)}-${s.slice(0, 2)}-${s.slice(2, 4)}`;

interface Event {
  kind: string;
  [k: string]: unknown;
}
interface MonthIn {
  month: string;
  books: Record<string, unknown>;
  in_force: Event[];
}

export function* metro2Steps(p: Json, call: Call): Step<Json> {
  const big = (x: string | number) => BigInt(x);
  const policy = p["policy"] as Record<string, string>;
  const loan = p["loan"] as Record<string, unknown>;
  const consumers = p["consumers"] as Record<string, unknown>[];
  const installments = (p["installments"] as Record<string, unknown>[])
    .map((i) => String(i["due_date"]))
    .sort();
  const receipts = (p["receipts"] as Record<string, unknown>[])
    .map((r, k) => ({ on: String(r["received_on"]), amount: String(r["amount_cents"]), k }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.k - b.k));
  const last = p["last_record"] as Record<string, string> | null;
  const months = p["months"] as MonthIn[];
  const round = policy["metro2_rounding"] === "round";

  // P, and each month's last day: independent, so asked together.
  const first = yield* together([
    {
      name: "calculate",
      input: { expression: `${String(loan["pi_cents"])} + ${String(loan["escrow_cents"])}` },
      key: "value",
    },
    ...months.map((m) => ({ name: "end_of_month", input: { date: `${m.month}-01` }, key: "date" })),
  ]);
  const P = first[0] as string;
  const asOfs = first.slice(1) as string[];

  // Step 1: the ledger, once; a month-end's ledger is its receipts' prefix, read off the satisfied dates.
  const satisfied: (string | null)[] = installments.map(() => null);
  let pool = "0";
  let next = 0;
  for (const r of receipts) {
    pool =
      pool === "0"
        ? r.amount
        : yield* call<string>("calculate", { expression: `${pool} + ${r.amount}` }, "value");
    if (big(pool) < big(P) || next >= installments.length) continue;
    if (pool === P) {
      satisfied[next++] = r.on;
      pool = "0";
      continue;
    }
    const n = Number(
      yield* call<string>("calculate", { expression: `floor(${pool} / ${P})` }, "value"),
    );
    const paid = Math.min(n, installments.length - next);
    for (let k = 0; k < paid; k++) satisfied[next++] = r.on;
    pool = yield* call<string>("calculate", { expression: `${pool} - ${paid} * ${P}` }, "value");
  }
  const unpaidAt = (d: string) =>
    installments.filter((due, k) => due <= d && (satisfied[k] === null || satisfied[k]! > d));
  const E = (d: string) => unpaidAt(d)[0] ?? null;

  const inForce = (m: MonthIn, kind: string) => m.in_force.find((e) => e.kind === kind);
  const closingOf = (m: MonthIn) => m.in_force.find((e) => CLOSINGS.includes(e.kind));

  // The forbearance entry dates (under the freeze), each the day before its plan took effect.
  const freeze = policy["forbearance_status"] === "freeze";
  const effective = [
    ...new Set(
      months
        .map((m) => inForce(m, "forbearance_plan"))
        .filter((e) => e !== undefined && freeze)
        .map((e) => String(e!["effective_on"])),
    ),
  ];
  const before = yield* each<string>(
    "date_add",
    effective.map((date) => ({ date, days: -1 })),
    "date",
  );
  const entryDay = new Map(effective.map((e, k) => [e, before[k]!]));

  // Every day count the months need, together: at each as_of, at each entry day, at each closing.
  const dayPoints = [
    ...asOfs,
    ...before,
    ...months
      .map((m) => closingOf(m))
      .filter((e) => e !== undefined)
      .map((e) => String(e!["closed_on"])),
  ].filter((d) => E(d) !== null);
  const distinctPoints = [...new Set(dayPoints)];
  const counted = yield* each<number>(
    "days_between",
    distinctPoints.map((d) => ({ from: E(d)!, to: d })),
    "days",
  );
  const daysAt = (d: string) => {
    const k = distinctPoints.indexOf(d);
    return k < 0 ? 0 : counted[k]!;
  };

  // Every sum and product the months need, together.
  const apdExpr = (d: string) => {
    const n = unpaidAt(d).length;
    return n >= 2 ? `${n} * ${P}` : null;
  };
  const apdOf = (d: string, values: Map<string, string>) => {
    const n = unpaidAt(d).length;
    return n === 0 ? "0" : n === 1 ? P : values.get(apdExpr(d)!)!;
  };
  const balanceExpr = (m: MonthIn) => {
    const parts = ["upb_cents", "deferred_principal_cents", "forborne_principal_cents"]
      .map((k) => String(m.books[k]))
      .filter((v) => v !== "0");
    return parts.length >= 2 ? parts.join(" + ") : null;
  };
  const balanceOf = (m: MonthIn, values: Map<string, string>) => {
    const parts = ["upb_cents", "deferred_principal_cents", "forborne_principal_cents"]
      .map((k) => String(m.books[k]))
      .filter((v) => v !== "0");
    return parts.length === 0 ? "0" : parts.length === 1 ? parts[0]! : values.get(balanceExpr(m)!)!;
  };
  const paidIn = (m: MonthIn, asOf: string) => {
    const amounts = receipts
      .filter((r) => r.on.slice(0, 7) === m.month && r.on <= asOf)
      .map((r) => r.amount);
    const payoff = inForce(m, "payoff");
    if (payoff) amounts.push(String(payoff["payoff_funds_cents"]));
    return amounts;
  };
  const sums = yield* calcAll(
    months.flatMap((m, k) => {
      const asOf = asOfs[k]!;
      const amounts = paidIn(m, asOf);
      const fb = inForce(m, "forbearance_plan");
      return [
        apdExpr(asOf),
        fb && freeze ? apdExpr(entryDay.get(String(fb["effective_on"]))!) : null,
        balanceExpr(m),
        amounts.length >= 2 ? amounts.join(" + ") : null,
      ].filter((x): x is string => x !== null);
    }),
  );

  // Steps 2 to 6, month by month, in cents; the dollars come after.
  interface Built {
    month: string;
    status: string;
    rating: string;
    closed: string | null;
    apd: string;
    dofd: string | null;
    php: string;
    special: string;
    balance: string;
    scheduled: string;
    terms: number;
    k4: { due: string; amount: string } | null;
    actual: string;
    lastPaid: string | null;
    errors: string[];
  }
  const built: Built[] = [];
  let priorStatus: string | null = last ? last["account_status"]! : null;
  let priorFurnished = true;
  let priorDofd: string | null = last ? fromM2(last["date_of_first_delinquency"]!) : null;
  let priorPhp: string | null = last
    ? (last["payment_history_profile"]! + "B".repeat(24)).slice(0, 24)
    : null;
  for (const [k, m] of months.entries()) {
    const asOf = asOfs[k]!;
    const books = m.books;
    let status = statusFor(daysAt(asOf));
    let rating = "";
    let special = "";
    let apd = apdOf(asOf, sums);
    let scheduled = P;
    let balance = balanceOf(m, sums);
    let closed: string | null = null;
    let terms =
      policy["terms_duration"] === "original"
        ? Number(loan["original_term_months"])
        : Number(books["remaining_term_months"]);
    let k4: Built["k4"] = null;
    const closing = closingOf(m);
    const referral = inForce(m, "foreclosure_referral");
    for (const e of m.in_force) {
      if (e.kind === "forbearance_plan") {
        special = "CP";
        scheduled = String(e["plan_payment_cents"]);
        if (freeze) {
          const day = entryDay.get(String(e["effective_on"]))!;
          status = statusFor(daysAt(day));
          apd = apdOf(day, sums);
        }
      } else if (e.kind === "repayment_plan") {
        apd = String(e["remaining_arrears_cents"]);
        if (big(String(e["plan_payment_cents"])) < big(P)) special = "AC";
      } else if (e.kind === "trial_plan") {
        special = "AC";
      } else if (e.kind === "modification") {
        status = "11";
        special = "CO";
        apd = "0";
        scheduled = String(e["new_piti_cents"]);
        terms = Number(e["new_term_months"]);
        if (big(String(books["forborne_principal_cents"])) > 0n)
          k4 = {
            due: String(books["maturity_date"]),
            amount: String(books["forborne_principal_cents"]),
          };
      } else if (e.kind === "payment_deferral") {
        status = "11";
        apd = "0";
        k4 = {
          due: String(books["maturity_date"]),
          amount: String(books["deferred_principal_cents"]),
        };
      }
    }
    if (closing) {
      const on = String(closing["closed_on"]);
      closed = on;
      apd = "0";
      rating = ratingFor(daysAt(on));
      if (closing.kind === "payoff") {
        status = "13";
        if (closing["by_refinance"] === true) special = "AS";
        balance = "0";
      } else if (closing.kind === "short_sale") {
        status = referral ? "65" : "13";
        special = "AU";
        balance = "0";
      } else {
        status = closing.kind === "foreclosure_sale" ? "94" : "89";
        if (closing["deficiency_pursued"] !== true) balance = "0";
      }
    }
    if (!closing && referral && special === "") special = "BO";

    // Step 4
    const oldest = E(asOf);
    const dofd =
      oldest === null || status === "11"
        ? null
        : priorDofd !== null && priorDofd <= oldest
          ? priorDofd
          : oldest;
    // Step 5
    const php =
      priorPhp === null
        ? "B".repeat(24)
        : (
            (priorFurnished && priorStatus !== null ? (PHP_CHAR[priorStatus] ?? "0") : "D") +
            priorPhp
          ).slice(0, 24);
    // Step 6
    const amounts = paidIn(m, asOf);
    const actual =
      amounts.length === 0
        ? "0"
        : amounts.length === 1
          ? amounts[0]!
          : sums.get(amounts.join(" + "))!;
    const dates = receipts.filter((r) => r.on <= asOf).map((r) => r.on);
    const payoff = inForce(m, "payoff");
    if (payoff) dates.push(String(payoff["closed_on"]));
    const lastPaid = dates.length ? [...dates].sort().at(-1)! : null;
    const errors: string[] = [];
    if (status === "11" && dofd !== null) errors.push("STATUS_11_WITH_DOFD");
    if (
      ["71", "78", "80", "82", "83", "84", "89", "94", "97", "65"].includes(status) &&
      dofd === null
    )
      errors.push("DOFD_REQUIRED");
    if (["13", "65", "89", "94", "05"].includes(status) && rating === "")
      errors.push("PAYMENT_RATING_REQUIRED");
    if (big(apd) > 0n && ["13", "94", "89"].includes(status)) errors.push("APD_WITH_CLOSED_STATUS");
    const min = books["min"];
    if (min === null) errors.push("K3_MIN_MISSING");
    else if (!/^\d{18}$/.test(String(min))) errors.push("MIN_NOT_18_DIGITS");
    if (!/^\d{10}$/.test(String(books["fnma_loan_number"]))) errors.push("K3_FNMA_LOAN_NUMBER");
    if (!consumers.some((c) => c["successor_in_interest"] !== true))
      errors.push("NO_CONSUMER_SEGMENT");
    built.push({
      month: m.month,
      status,
      rating,
      closed,
      apd,
      dofd,
      php,
      special,
      balance,
      scheduled,
      terms,
      k4,
      actual,
      lastPaid,
      errors: errors.sort(),
    });
    priorStatus = status;
    priorFurnished = errors.length === 0;
    priorDofd = dofd;
    priorPhp = php;
  }

  // The dollars: dropping the cents is reading; under "round", a dollar is added when they were 50 or more.
  const toRound = round
    ? built
        .filter((b) => b.errors.length === 0)
        .flatMap((b) => [b.apd, b.balance, b.scheduled, b.actual, ...(b.k4 ? [b.k4.amount] : [])])
        .filter((c) => big(c) % 100n >= 50n)
        .map((c) => `${(big(c) / 100n).toString()} + 1`)
    : [];
  const rounded = yield* calcAll(toRound);
  const money = (c: string) => {
    const dollars = (big(c) / 100n).toString();
    const whole = round && big(c) % 100n >= 50n ? rounded.get(`${dollars} + 1`)! : dollars;
    return whole.padStart(9, "0").slice(-9);
  };

  const records = built.map((b) =>
    b.errors.length > 0
      ? { month: b.month, furnished: false, hard_errors: b.errors }
      : {
          month: b.month,
          furnished: true,
          account_status: b.status,
          payment_rating: b.rating,
          date_closed: m2date(b.closed),
          amount_past_due: money(b.apd),
          date_of_first_delinquency: m2date(b.dofd),
          payment_history_profile: b.php,
          special_comment: b.special,
          current_balance: money(b.balance),
          scheduled_monthly_payment: money(b.scheduled),
          terms_duration: String(b.terms).padStart(3, "0"),
          k4: b.k4
            ? { balloon_due_date: m2date(b.k4.due), balloon_amount: money(b.k4.amount) }
            : null,
          actual_payment_amount: money(b.actual),
          date_of_last_payment: m2date(b.lastPaid),
        },
  );

  // Step 7, for the last month furnished.
  const lastFurnished = [...built].reverse().find((b) => b.errors.length === 0);
  const segments = lastFurnished
    ? consumers
        .filter((c) => c["successor_in_interest"] !== true)
        .sort((a, b) => Number(a["position"]) - Number(b["position"]))
        .map((c) => ({
          party_id: String(c["party_id"]),
          segment:
            Number(c["position"]) === 1 ? "base" : c["same_address_as_base"] === true ? "J1" : "J2",
          ecoa:
            c["never_liable"] === true
              ? "Z"
              : c["deceased"] === true
                ? "X"
                : c["released"] === true
                  ? "T"
                  : c["liability"] === "guarantor"
                    ? "5"
                    : c["liability"] === "joint"
                      ? "2"
                      : "1",
          special_comment: c["released"] === true ? "H" : lastFurnished.special,
        }))
    : [];
  return { records, consumers: segments };
}

export class Metro2ReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:metro2-rulebook", metro2Steps, METRO2_SUBMIT_TOOL);
  }
}
