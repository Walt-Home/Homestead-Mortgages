/**
 * The tools: refi-review's date steps and exact calculator, and a submit
 * tool shaped like the analysis. Nothing here projects a year or decides a
 * surplus: putting the analysis together is the task.
 */

import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { DECISIONS } from "./grader.js";

export const ESCROW_SUBMIT_TOOL = "submit_analysis";

const PRIMITIVES = [
  "date_add",
  "days_between",
  "end_of_month",
  "whole_months_between",
  "calculate",
];

const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "13833".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

export const ESCROW_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => PRIMITIVES.includes(t.name)),
  {
    name: ESCROW_SUBMIT_TOOL,
    description:
      "Submit the analysis. Call it once, when every figure is computed; a valid submission ends the analysis. A figure the decision does not have is null.",
    input_schema: {
      type: "object",
      properties: {
        annual_cents: CENTS,
        base_payment_cents: CENTS,
        required_start_cents: CENTS,
        cushion_cents: CENTS,
        target_at_start_cents: CENTS,
        projected_actual_cents: CENTS,
        decision: { type: "string", enum: [...DECISIONS] },
        surplus_cents: orNull(CENTS),
        shortage_cents: orNull(CENTS),
        deficiency_cents: orNull(CENTS),
        repayment_months: orNull({ type: "integer" }),
        installment_cents: orNull(CENTS),
        final_installment_cents: orNull(CENTS),
        deficiency_installment_cents: orNull(CENTS),
        deficiency_final_installment_cents: orNull(CENTS),
        lump_sum_option_offered: orNull({ type: "boolean" }),
        credit_monthly_cents: orNull(CENTS),
        first_month_extra_credit_cents: orNull(CENTS),
        refund_due_on: orNull(DATE),
        new_payment_cents: CENTS,
        first_month_payment_cents: CENTS,
        final_month_payment_cents: CENTS,
        effective_on: DATE,
        anomalies: { type: "array", items: { type: "string" } },
      },
      required: [
        "annual_cents",
        "base_payment_cents",
        "required_start_cents",
        "cushion_cents",
        "target_at_start_cents",
        "projected_actual_cents",
        "decision",
        "surplus_cents",
        "shortage_cents",
        "deficiency_cents",
        "repayment_months",
        "installment_cents",
        "final_installment_cents",
        "deficiency_installment_cents",
        "deficiency_final_installment_cents",
        "lump_sum_option_offered",
        "credit_monthly_cents",
        "first_month_extra_credit_cents",
        "refund_due_on",
        "new_payment_cents",
        "first_month_payment_cents",
        "final_month_payment_cents",
        "effective_on",
        "anomalies",
      ],
      additionalProperties: false,
    },
  },
];

/** Runs one primitive; anything else is an error naming this environment's tools. */
export function executeEscrowTool(name: string, raw: unknown): string {
  if (!PRIMITIVES.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${ESCROW_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
