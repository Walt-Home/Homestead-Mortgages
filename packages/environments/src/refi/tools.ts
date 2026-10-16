/**
 * The tools: arithmetic and dates, and never the engine.
 *
 * Each tool is one primitive the rulebook names — a level payment, a
 * balance after payments, a per diem, a present value, a date step, an
 * exact calculator — and the money ones are the engine's own exported
 * primitives, so a model that composes them as the rulebook says lands on
 * the engine's figure to the cent and the two can never drift apart. None
 * of them takes a loan or returns a verdict: putting the review together
 * is the task.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  plainDate,
  type PlainDate,
} from "@hm/kernel/calendar";
import {
  balanceAfter,
  levelPaymentPct,
  monthsBetween,
  npvOfDelta,
  perDiem365,
} from "@hm/refi-review";
import { calculate } from "../calculate.js";
import type { ToolSpec } from "../episode.js";

const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "340262".' };
const RATE = {
  type: "string",
  pattern: "^\\d{1,2}(\\.\\d{1,4})?$",
  description: 'Annual percentage, e.g. "6.125".',
};
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const MONTHS = { type: "integer", minimum: 1, maximum: 600 };

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SUBMIT_TOOL = "submit_review";

const OFFER_FIELDS = [
  "loan_amount_cents",
  "new_pi_cents",
  "pi_delta_cents",
  "cash_back_cents",
  "cash_back_cap_cents",
  "lifetime_interest_existing_cents",
  "lifetime_interest_new_cents",
  "same_term_pi_cents",
  "same_term_lifetime_interest_cents",
  "npv_cents",
  "seven_year_total_cost_delta_cents",
] as const;
export type OfferCentsField = (typeof OFFER_FIELDS)[number];
export { OFFER_FIELDS };

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "level_payment",
    description:
      "The level monthly payment that pays off a principal at an annual rate over a term: P × r ÷ (1 − (1 + r)^−n) with r = rate ÷ 12, rounded half up to the cent.",
    input_schema: object({ principal_cents: CENTS, annual_rate_pct: RATE, term_months: MONTHS }),
  },
  {
    name: "balance_after",
    description:
      "The balance after a number of scheduled payments. Each month the interest is the balance × rate ÷ 12 rounded half up to the cent, and the payment less that interest comes off the balance; it stops at zero.",
    input_schema: object({
      start_balance_cents: CENTS,
      annual_rate_pct: RATE,
      payment_cents: CENTS,
      payments: { type: "integer", minimum: 0, maximum: 600 },
    }),
  },
  {
    name: "per_diem",
    description: "One day's interest: balance × rate ÷ 365, rounded half up to the cent.",
    input_schema: object({ balance_cents: CENTS, annual_rate_pct: RATE }),
  },
  {
    name: "present_value",
    description:
      "The present value of the same amount paid at the end of every month for a number of months, discounted monthly at the annual rate ÷ 12; exact until one final rounding half up to the cent.",
    input_schema: object({ monthly_amount_cents: CENTS, annual_rate_pct: RATE, months: MONTHS }),
  },
  {
    name: "date_add",
    description:
      "A date moved by whole months and then by days. Adding months keeps the day of the month, or uses the month's last day when it is shorter (Jan 31 + 1 month = Feb 28 or 29). Either may be negative.",
    input_schema: object(
      {
        date: DATE,
        months: { type: "integer", minimum: -1200, maximum: 1200 },
        days: { type: "integer", minimum: -40000, maximum: 40000 },
      },
      ["date"],
    ),
  },
  {
    name: "days_between",
    description: "Calendar days from one date to another: positive when `to` is later.",
    input_schema: object({ from: DATE, to: DATE }),
  },
  {
    name: "end_of_month",
    description: "The last day of the date's month.",
    input_schema: object({ date: DATE }),
  },
  {
    name: "whole_months_between",
    description:
      "Whole months from one date to another: the difference in months, less one when `to`'s day of the month is before `from`'s (Feb 6, 2023 to Nov 6, 2026 is 45).",
    input_schema: object({ from: DATE, to: DATE }),
  },
  {
    name: "calculate",
    description:
      "Exact decimal arithmetic. Numbers, + - * /, parentheses, and round(x, places) (half up; places defaults to 0), floor(x), ceil(x), abs(x), max(a, b, ...), min(a, b, ...). Sums and products are exact; a quotient is exact to 30 decimal places. Nothing is rounded unless you round it.",
    input_schema: object({ expression: { type: "string", maxLength: 500 } }),
  },
  {
    name: SUBMIT_TOOL,
    description:
      "Submit the review. Call it once, when every figure is computed; a valid submission ends the review.",
    input_schema: object({
      verdict: { type: "string", enum: ["candidate", "watching", "not_now", "excluded"] },
      reasons: { type: "array", items: { type: "string" } },
      offer: {
        anyOf: [
          object({
            ...Object.fromEntries(OFFER_FIELDS.map((f) => [f, CENTS])),
            rate_delta_bps: { type: "number" },
            present_same_term_first: { type: "boolean" },
          }),
          { type: "null" },
        ],
      },
      watch_rate_pct: {
        anyOf: [{ type: "string", pattern: "^\\d{1,2}\\.\\d{3}$" }, { type: "null" }],
      },
    }),
  },
];

/* ── input checking: a malformed call is an error, never a guess ───────── */

type Input = Readonly<Record<string, unknown>>;

const asInput = (v: unknown): Input => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new TypeError("the input must be an object");
  return v as Input;
};
const cents = (i: Input, k: string): bigint => {
  const v = i[k];
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError(`${k} must be integer cents as a string, e.g. "340262"`);
};
const rate = (i: Input, k: string): string => {
  const v = i[k];
  if (typeof v === "string" && /^\d{1,2}(\.\d{1,4})?$/.test(v.trim())) return v.trim();
  if (typeof v === "number" && v >= 0 && v < 100) return String(v);
  throw new TypeError(`${k} must be an annual percentage as a string, e.g. "6.125"`);
};
const int = (i: Input, k: string, lo: number, hi: number, dflt?: number): number => {
  const v = i[k] ?? dflt;
  if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) return v;
  throw new TypeError(`${k} must be a whole number from ${lo} to ${hi}`);
};
const date = (i: Input, k: string): PlainDate => {
  const v = i[k];
  if (typeof v !== "string") throw new TypeError(`${k} must be a date, YYYY-MM-DD`);
  return plainDate(v.trim());
};

/** Runs one tool; throws on a malformed call, which the loop returns to the model as an error. */
export function executeTool(name: string, raw: unknown): string {
  const i = asInput(raw);
  switch (name) {
    case "level_payment":
      return JSON.stringify({
        payment_cents: levelPaymentPct(
          cents(i, "principal_cents"),
          rate(i, "annual_rate_pct"),
          int(i, "term_months", 1, 600),
        ).toString(),
      });
    case "balance_after":
      return JSON.stringify({
        balance_cents: balanceAfter(
          cents(i, "start_balance_cents"),
          rate(i, "annual_rate_pct"),
          cents(i, "payment_cents"),
          int(i, "payments", 0, 600),
        ).toString(),
      });
    case "per_diem":
      return JSON.stringify({
        per_diem_cents: perDiem365(
          cents(i, "balance_cents"),
          rate(i, "annual_rate_pct"),
        ).toString(),
      });
    case "present_value":
      return JSON.stringify({
        present_value_cents: npvOfDelta(
          cents(i, "monthly_amount_cents"),
          rate(i, "annual_rate_pct"),
          int(i, "months", 1, 600),
        ).toString(),
      });
    case "date_add":
      return JSON.stringify({
        date: addDays(
          addMonths(date(i, "date"), int(i, "months", -1200, 1200, 0)),
          int(i, "days", -40000, 40000, 0),
        ),
      });
    case "days_between":
      return JSON.stringify({ days: daysBetween(date(i, "from"), date(i, "to")) });
    case "end_of_month":
      return JSON.stringify({ date: endOfMonth(date(i, "date")) });
    case "whole_months_between":
      return JSON.stringify({ months: monthsBetween(date(i, "from"), date(i, "to")) });
    case "calculate": {
      const e = i["expression"];
      if (typeof e !== "string") throw new TypeError("expression must be a string");
      return JSON.stringify({ value: calculate(e) });
    }
    default:
      throw new TypeError(
        `no tool named ${JSON.stringify(name)}; the tools are ${TOOLS.map((t) => t.name).join(", ")}`,
      );
  }
}
