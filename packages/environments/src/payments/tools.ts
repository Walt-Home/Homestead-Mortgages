/**
 * The tools: refi's date steps and exact calculator, and the servicer's
 * business-day calendar — the one the engine rolls a grace end forward on
 * (federal holidays as observed, Saturdays and Sundays closed). None of them
 * posts a receipt or decides a late charge.
 */

import { plainDate, rollForward, servicer } from "@hm/kernel/calendar";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const PAYMENTS_SUBMIT_TOOL = "submit_posting";

const REUSED = ["date_add", "days_between", "calculate"];
const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "219257".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };

export const PAYMENTS_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: "next_business_day",
    description:
      "The date itself when it is a servicer business day, otherwise the next one: Saturdays, Sundays and federal holidays as observed (a Saturday holiday on the Friday before, a Sunday holiday on the Monday after) are not business days.",
    input_schema: {
      type: "object",
      properties: { date: DATE },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: PAYMENTS_SUBMIT_TOOL,
    description:
      "Submit the posting. Call it once, when every receipt and run is posted; a valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
        receipts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              payment_id: { type: "string" },
              outcome: {
                type: "string",
                enum: [
                  "applied",
                  "applied_with_50_rule",
                  "curtailment",
                  "prepaid",
                  "unapplied",
                  "held_trial",
                  "held_bk",
                  "held_fc",
                  "held_dispute",
                  "held_other",
                ],
              },
              installments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    due_date: DATE,
                    kind: { type: "string", enum: ["contractual", "prepaid"] },
                    interest_cents: CENTS,
                    principal_cents: CENTS,
                    escrow_cents: CENTS,
                  },
                  required: [
                    "due_date",
                    "kind",
                    "interest_cents",
                    "principal_cents",
                    "escrow_cents",
                  ],
                  additionalProperties: false,
                },
              },
              late_charge_paid_cents: CENTS,
              curtailment_cents: CENTS,
              to_suspense_cents: CENTS,
              suspense_used_cents: CENTS,
              partial_hold: { type: "boolean" },
              redirected_curtailment: { type: "boolean" },
              refused_instruction: { type: "boolean" },
            },
            required: [
              "payment_id",
              "outcome",
              "installments",
              "late_charge_paid_cents",
              "curtailment_cents",
              "to_suspense_cents",
              "suspense_used_cents",
              "partial_hold",
              "redirected_curtailment",
              "refused_instruction",
            ],
            additionalProperties: false,
          },
        },
        late_charge_runs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              installment_due_date: DATE,
              run_on: DATE,
              outcome: { type: "string", enum: ["assessed", "accrued_suspended", "not_assessed"] },
              amount_cents: { anyOf: [CENTS, { type: "null" }] },
            },
            required: ["installment_due_date", "run_on", "outcome", "amount_cents"],
            additionalProperties: false,
          },
        },
        final: {
          type: "object",
          properties: {
            upb_cents: CENTS,
            lpi_date: { anyOf: [DATE, { type: "null" }] },
            suspense_cents: CENTS,
            late_charges_due_cents: CENTS,
            partial_count_12m: { type: "integer" },
            installments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  due_date: DATE,
                  status: { type: "string", enum: ["due", "satisfied", "prepaid"] },
                },
                required: ["due_date", "status"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "upb_cents",
            "lpi_date",
            "suspense_cents",
            "late_charges_due_cents",
            "partial_count_12m",
            "installments",
          ],
          additionalProperties: false,
        },
      },
      required: ["receipts", "late_charge_runs", "final"],
      additionalProperties: false,
    },
  },
];

export function executePaymentsTool(name: string, raw: unknown): string {
  if (name === "next_business_day") {
    const d = (raw as Record<string, unknown> | null)?.["date"];
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d))
      throw new TypeError("date must be YYYY-MM-DD");
    // The engine's own roll (latecharges.ts graceEnd): the date itself on a business day.
    return JSON.stringify({ date: rollForward(plainDate(d), servicer) });
  }
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${PAYMENTS_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
