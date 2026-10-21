/**
 * The tools: refi's level payment, balance after payments, date steps and
 * exact calculator, and the servicer's business-day calendar — the one the
 * engine counts the insurer's notice and the escrow analysis on (federal
 * holidays as observed, Saturdays and Sundays closed). None of them finds a
 * threshold's date, a midpoint, a cure or a refund: building the schedule
 * and reading it is the task.
 */

import { addBusinessDays, plainDate, servicer } from "@hm/kernel/calendar";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const PMI_SUBMIT_TOOL = "submit_mi_review";

const REUSED = [
  "level_payment",
  "balance_after",
  "date_add",
  "days_between",
  "end_of_month",
  "calculate",
];
const CENTS = { type: "string", pattern: "^\\d+$", description: 'Integer cents, e.g. "31200000".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const COUNT = { type: "integer", minimum: 0 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const PMI_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: "add_business_days",
    description:
      "A date moved forward by a number of servicer business days: each step goes to the next day that is one, and the date itself never counts. Saturdays, Sundays and federal holidays as observed (a Saturday holiday on the Friday before, a Sunday holiday on the Monday after) are not business days.",
    input_schema: {
      type: "object",
      properties: { date: DATE, days: { type: "integer", minimum: 1, maximum: 60 } },
      required: ["date", "days"],
      additionalProperties: false,
    },
  },
  {
    name: PMI_SUBMIT_TOOL,
    description:
      "Submit the review. Call it once, when every field is decided; a section the evaluation date does not call for is null, and so is a field the rulebook says is null. A valid submission ends the task.",
    input_schema: object({
      position: object({
        original_value_cents: CENTS,
        rule_78_applies: { type: "boolean" },
        pi_cents: CENTS,
        scheduled_78_payment_number: orNull(COUNT),
        scheduled_78_date: orNull(DATE),
        midpoint_termination_date: DATE,
        trigger_date: DATE,
      }),
      request: orNull(
        object({
          evaluation_upb_cents: orNull(CENTS),
          threshold_bps: orNull(COUNT),
          ltv_bps: orNull(COUNT),
          fnma_current: orNull({ type: "boolean" }),
          late30_12m: orNull(COUNT),
          late60_24m: orNull(COUNT),
          result: {
            type: "string",
            enum: ["eligible", "ineligible", "value_check_needed", "refused"],
          },
          reasons: {
            type: "array",
            description: "Each reason once.",
            items: {
              type: "string",
              enum: [
                "LTV_ABOVE_THRESHOLD",
                "LTV_ABOVE_THRESHOLD_CURRENT",
                "SEASONING_INSUFFICIENT",
                "NOT_CURRENT",
                "PAYMENT_HISTORY_30_12M",
                "PAYMENT_HISTORY_60_24M",
                "VALUE_DECLINED_OR_UNKNOWN",
                "VALUATION_REQUIRED",
                "VALUATION_EXPIRED",
              ],
            },
          },
          decision_due: DATE,
        }),
      ),
      automatic: orNull(
        object({
          current_on_trigger: { type: "boolean" },
          not_current_installments: {
            type: "array",
            description: "Each installment's due date once.",
            items: DATE,
          },
          not_current_notice_due: orNull(DATE),
          cure_on: orNull(DATE),
        }),
      ),
      termination: orNull(
        object({
          effective_on: DATE,
          lar89_action_code: { type: "string", enum: ["51", "52", "53"] },
          lar89_action_date: { type: "string", pattern: "^\\d{6}$", description: "MMDDYY." },
          notice_due: DATE,
          premium_stop_by: DATE,
          refund_due: DATE,
          insurer_notice_due: DATE,
          escrow_interim_analysis_due: DATE,
          unearned_premium_cents: CENTS,
        }),
      ),
      lpmi_options_notice_due: orNull(DATE),
    }),
  },
];

export function executePmiTool(name: string, raw: unknown): string {
  if (name === "add_business_days") {
    const i = (raw ?? {}) as Record<string, unknown>;
    const d = i["date"];
    const n = i["days"];
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d))
      throw new TypeError("date must be YYYY-MM-DD");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 60)
      throw new TypeError("days must be a whole number from 1 to 60");
    // The engine's own count (termination.ts finalizationClocks): addBusinessDays on the servicer calendar.
    return JSON.stringify({ date: addBusinessDays(plainDate(d), n, servicer) });
  }
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${PMI_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
