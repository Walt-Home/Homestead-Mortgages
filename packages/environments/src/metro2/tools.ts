/**
 * The tools: refi's date steps and exact calculator, and nothing more. A
 * Metro 2 record needs no amortization (the balances are the servicer's
 * books), so the level-payment and balance tools are not given. None of
 * them applies a receipt, counts days past due into a status, carries a
 * PHP, formats a field or validates a record: each of those is graded.
 */

import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const METRO2_SUBMIT_TOOL = "submit_records";

const REUSED = ["date_add", "days_between", "end_of_month", "calculate"];
const MONEY = {
  type: "string",
  pattern: "^\\d{9}$",
  description: 'Whole dollars, 9 digits: "000002459".',
};
const DATE8 = {
  type: "string",
  pattern: "^\\d{8}$",
  description: 'MMDDYYYY, or "00000000" when there is none.',
};
const MONTH = { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "YYYY-MM." };
const SPECIAL = {
  type: "string",
  enum: ["", "CP", "AC", "CO", "AW", "BO", "AU", "AS", "BA", "H", "AZ"],
};

const FURNISHED = {
  type: "object",
  properties: {
    month: MONTH,
    furnished: { type: "boolean", enum: [true] },
    account_status: {
      type: "string",
      enum: ["11", "71", "78", "80", "82", "83", "84", "13", "65", "89", "94", "97", "05"],
    },
    payment_rating: { type: "string", enum: ["", "0", "1", "2", "3", "4", "5", "6"] },
    date_closed: DATE8,
    amount_past_due: MONEY,
    date_of_first_delinquency: DATE8,
    payment_history_profile: { type: "string", pattern: "^[0-6GHJKLBDE]{24}$" },
    special_comment: SPECIAL,
    current_balance: MONEY,
    scheduled_monthly_payment: MONEY,
    terms_duration: { type: "string", pattern: "^\\d{3}$" },
    k4: {
      anyOf: [
        {
          type: "object",
          properties: { balloon_due_date: DATE8, balloon_amount: MONEY },
          required: ["balloon_due_date", "balloon_amount"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    actual_payment_amount: MONEY,
    date_of_last_payment: DATE8,
  },
  required: [
    "month",
    "furnished",
    "account_status",
    "payment_rating",
    "date_closed",
    "amount_past_due",
    "date_of_first_delinquency",
    "payment_history_profile",
    "special_comment",
    "current_balance",
    "scheduled_monthly_payment",
    "terms_duration",
    "k4",
    "actual_payment_amount",
    "date_of_last_payment",
  ],
  additionalProperties: false,
};

const OMITTED = {
  type: "object",
  properties: {
    month: MONTH,
    furnished: { type: "boolean", enum: [false] },
    hard_errors: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "string",
        enum: [
          "STATUS_11_WITH_DOFD",
          "DOFD_REQUIRED",
          "PAYMENT_RATING_REQUIRED",
          "PHP_LENGTH",
          "APD_WITH_CLOSED_STATUS",
          "K3_MIN_MISSING",
          "MIN_NOT_18_DIGITS",
          "K3_FNMA_LOAN_NUMBER",
          "NO_CONSUMER_SEGMENT",
        ],
      },
    },
  },
  required: ["month", "furnished", "hard_errors"],
  additionalProperties: false,
};

export const METRO2_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: METRO2_SUBMIT_TOOL,
    description:
      "Submit the month's records. Call it once, when every month is built; a valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
        records: { type: "array", items: { anyOf: [FURNISHED, OMITTED] } },
        consumers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              party_id: { type: "string" },
              segment: { type: "string", enum: ["base", "J1", "J2"] },
              ecoa: { type: "string", enum: ["1", "2", "5", "X", "Z", "T"] },
              special_comment: SPECIAL,
            },
            required: ["party_id", "segment", "ecoa", "special_comment"],
            additionalProperties: false,
          },
        },
      },
      required: ["records", "consumers"],
      additionalProperties: false,
    },
  },
];

export function executeMetro2Tool(name: string, raw: unknown): string {
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${METRO2_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
