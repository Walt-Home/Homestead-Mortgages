/**
 * The tools: the three lookups a person running these tests would reach for
 * — the calendar date an instant falls on in New York, the APOR for a week,
 * the Appendix J solve — each the engine's own function, plus refi's level
 * payment and exact calculator. None of them classifies a fee, picks a tier
 * or decides a test: that is the task.
 */

import { calendarDateIn, RATE_SET_TIME_ZONE } from "@hm/shared";
import { APOR_TABLE, annualPercentageRate, lookupApor } from "@hm/underwriting";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const REGZ_SUBMIT_TOOL = "submit_tests";

const REUSED = ["level_payment", "calculate"];
const CENTS = {
  type: "string",
  pattern: "^-?\\d+$",
  description: 'Integer cents, e.g. "41234500".',
};
const RATE = {
  type: "string",
  pattern: "^\\d{1,2}(\\.\\d{1,4})?$",
  description: 'Annual percentage, e.g. "6.125".',
};
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

export const REGZ_TOOLS: readonly ToolSpec[] = [
  {
    name: "new_york_date",
    description: `The calendar date an instant falls on in ${RATE_SET_TIME_ZONE} (Eastern time, daylight saving included).`,
    input_schema: obj({
      instant: {
        type: "string",
        description: 'An ISO 8601 instant, e.g. "2026-03-16T02:30:00.000Z".',
      },
    }),
  },
  {
    name: "apor",
    description:
      "The average prime offer rate, fixed-rate, for the FFIEC week containing a calendar date (weeks begin on Monday), from the table this lender holds: terms of 10, 15, 20 and 30 years. Returns the week's Monday and the rate in percent; an error for a term or a date the table does not hold.",
    input_schema: obj({ date: DATE, term_years: { type: "integer", minimum: 1, maximum: 40 } }),
  },
  {
    name: "annual_percentage_rate",
    description:
      "Regulation Z Appendix J for a fixed-rate, fully amortizing loan with monthly payments: the amount financed is the loan amount less the prepaid finance charges, the payment is the level payment at the note rate, and the APR is the monthly rate discounting those payments back to the amount financed, times 12, in percent to three decimals. It does not know whether a loan may be given an APR at all.",
    input_schema: obj({
      loan_amount_cents: CENTS,
      note_rate_pct: RATE,
      term_months: { type: "integer", minimum: 1, maximum: 600 },
      prepaid_finance_charges_cents: CENTS,
    }),
  },
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: REGZ_SUBMIT_TOOL,
    description:
      "Submit the tests. Call it once, when every field is decided; null is the answer for a test that cannot be decided on this file. A valid submission ends the task.",
    input_schema: obj({
      closing_cost_total_cents: CENTS,
      points_and_fees_cents: CENTS,
      prepaid_finance_charges_cents: CENTS,
      total_loan_amount_cents: CENTS,
      apr_pct: orNull({ type: "string", pattern: "^\\d{1,3}\\.\\d{3}$" }),
      apor_pct: orNull({ type: "string", pattern: "^\\d{1,2}\\.\\d{2}$" }),
      qm_status: orNull({ type: "string", enum: ["qm", "non_qm"] }),
      points_and_fees_limit_cents: CENTS,
      points_and_fees_pass: { type: "boolean" },
      is_hpml: orNull({ type: "boolean" }),
      hoepa_apr_trigger: orNull({ type: "boolean" }),
      hoepa_fee_trigger: { type: "boolean" },
      hoepa_prepayment_penalty_trigger: orNull({ type: "boolean" }),
      is_high_cost: orNull({ type: "boolean" }),
      ntb_recoup_months: orNull({ type: "string", pattern: "^\\d{1,4}\\.\\d$" }),
      ntb_satisfied: orNull({ type: "boolean" }),
    }),
  },
];

type Input = Readonly<Record<string, unknown>>;
const asInput = (v: unknown): Input => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new TypeError("the input must be an object");
  return v as Input;
};
const centsIn = (i: Input, k: string): number => {
  const v = i[k];
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new TypeError(`${k} must be integer cents as a string, e.g. "41234500"`);
};
const text = (i: Input, k: string, shape: RegExp, what: string): string => {
  const v = i[k];
  if (typeof v === "string" && shape.test(v.trim())) return v.trim();
  if (typeof v === "number" && shape.test(String(v))) return String(v);
  throw new TypeError(`${k} must be ${what}`);
};
const whole = (i: Input, k: string, lo: number, hi: number): number => {
  const v = i[k];
  if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) return v;
  throw new TypeError(`${k} must be a whole number from ${lo} to ${hi}`);
};

export function executeRegzTool(name: string, raw: unknown): string {
  const i = asInput(raw);
  switch (name) {
    case "new_york_date": {
      const instant = new Date(
        text(i, "instant", /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/, "an ISO 8601 instant"),
      );
      if (!Number.isFinite(instant.getTime())) throw new TypeError("instant is not a valid time");
      return JSON.stringify({ date: calendarDateIn(instant) });
    }
    case "apor": {
      const date = text(i, "date", /^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
      const years = whole(i, "term_years", 1, 40);
      // Midday in New York on that date, so the engine's own lookup matches the week on it.
      const found = lookupApor(APOR_TABLE, new Date(`${date}T17:00:00.000Z`), years * 12, "Fixed");
      if (!found.found) throw new TypeError(`no APOR: ${found.reason}`);
      return JSON.stringify({ week_of: found.weekOf, apor_pct: found.rate.toFixed(2) });
    }
    case "annual_percentage_rate": {
      const result = annualPercentageRate({
        loanAmount: centsIn(i, "loan_amount_cents") / 100,
        noteRate: Number(
          text(i, "note_rate_pct", /^\d{1,2}(\.\d{1,4})?$/, 'an annual percentage, e.g. "6.125"'),
        ),
        termMonths: whole(i, "term_months", 1, 600),
        amortization: "Fixed",
        prepaidFinanceCharges: centsIn(i, "prepaid_finance_charges_cents") / 100,
        mortgageInsuranceApplies: false,
      });
      if (!result.computed) throw new TypeError(`no APR: ${result.reason}`);
      return JSON.stringify({
        apr_pct: result.apr.toFixed(3),
        amount_financed_cents: String(Math.round(result.amountFinanced * 100)),
        monthly_payment_cents: String(Math.round(result.monthlyPayment * 100)),
      });
    }
    case "level_payment":
    case "calculate":
      return executeTool(name, raw);
    default:
      throw new TypeError(
        `no tool named ${JSON.stringify(name)}; the tools are ${REGZ_TOOLS.map((t) => t.name).join(", ")}`,
      );
  }
}
