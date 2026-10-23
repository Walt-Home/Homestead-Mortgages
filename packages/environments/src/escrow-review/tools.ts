/**
 * The tools: escrow-analysis's date steps and exact calculator, and a submit
 * tool shaped like the review. Nothing here projects a year, decides a
 * surplus or raises a flag.
 */

import type { ToolSpec } from "../episode.js";
import { ESCROW_TOOLS, executeEscrowTool } from "../escrow/tools.js";
import { DECISIONS } from "../escrow/grader.js";

export const REVIEW_SUBMIT_TOOL = "submit_review";

const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "13833".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

const PRIMITIVES = ESCROW_TOOLS.filter((t) => t.name !== "submit_analysis");

export const REVIEW_TOOLS: readonly ToolSpec[] = [
  ...PRIMITIVES,
  {
    name: REVIEW_SUBMIT_TOOL,
    description:
      "Submit the review. Call it once, when every figure is computed; a valid submission ends the review. A figure the decision does not have is null.",
    input_schema: {
      type: "object",
      properties: {
        annual_cents: CENTS,
        base_payment_cents: CENTS,
        target_at_start_cents: CENTS,
        projected_actual_cents: CENTS,
        decision: { type: "string", enum: [...DECISIONS] },
        surplus_cents: orNull(CENTS),
        shortage_cents: orNull(CENTS),
        deficiency_cents: orNull(CENTS),
        repayment_months: orNull({ type: "integer" }),
        new_payment_cents: CENTS,
        effective_on: DATE,
        anomalies: { type: "array", items: { type: "string" } },
        flag_stands: { type: "boolean" },
      },
      required: [
        "annual_cents",
        "base_payment_cents",
        "target_at_start_cents",
        "projected_actual_cents",
        "decision",
        "surplus_cents",
        "shortage_cents",
        "deficiency_cents",
        "repayment_months",
        "new_payment_cents",
        "effective_on",
        "anomalies",
        "flag_stands",
      ],
      additionalProperties: false,
    },
  },
];

/** Runs one of escrow-analysis's primitives; anything else is an error naming this environment's tools. */
export function executeReviewTool(name: string, raw: unknown): string {
  if (!PRIMITIVES.some((t) => t.name === name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${REVIEW_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeEscrowTool(name, raw);
}
