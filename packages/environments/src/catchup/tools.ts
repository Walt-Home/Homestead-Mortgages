/**
 * The tools: refi's exact calculator, and a submit tool shaped like the
 * posting. Every date comparison the rules make is reading, so there is no
 * date tool. Nothing here caps a charge or posts a payment.
 */

import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const CATCHUP_SUBMIT_TOOL = "submit_posting";

const PRIMITIVES = ["calculate"];
const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "158017".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };

export const CATCHUP_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => PRIMITIVES.includes(t.name)),
  {
    name: CATCHUP_SUBMIT_TOOL,
    description:
      "Submit the posting. Call it once, when every figure is computed; a valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
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
            required: ["due_date", "kind", "interest_cents", "principal_cents", "escrow_cents"],
            additionalProperties: false,
          },
        },
        late_charge_paid_cents: CENTS,
        to_suspense_cents: CENTS,
        late_charges: {
          type: "array",
          items: {
            type: "object",
            properties: { installment_due_date: DATE, allowed_cents: CENTS },
            required: ["installment_due_date", "allowed_cents"],
            additionalProperties: false,
          },
        },
        refund_due_cents: CENTS,
        late_charges_due_after_cents: CENTS,
        upb_after_cents: CENTS,
        lpi_after: { anyOf: [DATE, { type: "null" }] },
        current_after_posting: { type: "boolean" },
      },
      required: [
        "installments",
        "late_charge_paid_cents",
        "to_suspense_cents",
        "late_charges",
        "refund_due_cents",
        "late_charges_due_after_cents",
        "upb_after_cents",
        "lpi_after",
        "current_after_posting",
      ],
      additionalProperties: false,
    },
  },
];

/** Runs the calculator; anything else is an error naming this environment's tools. */
export function executeCatchupTool(name: string, raw: unknown): string {
  if (!PRIMITIVES.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${CATCHUP_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
