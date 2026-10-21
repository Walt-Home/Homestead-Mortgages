/**
 * The tools: refi's date step, day count and exact calculator, and nothing
 * else. An underwriter needs no other primitive here: every figure is a sum,
 * a product or a quotient rounded where the rulebook says, and every date is
 * a step in months. None of them classifies a source, assesses a trend,
 * grosses anything up or decides continuance: that is the task.
 */

import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { EXCLUSIONS, METHODS, ROW_FIELDS, TRENDS } from "./grader.js";

export const INCOME_SUBMIT_TOOL = "submit_income";

const REUSED = ["date_add", "days_between", "calculate"];
const CENTS = {
  type: "string",
  pattern: "^\\d+$",
  description: 'Whole cents as a string of digits, e.g. "92143".',
};
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };

export const INCOME_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: INCOME_SUBMIT_TOOL,
    description:
      "Submit the income analysis. Call it once, when every source is worked; a valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          description: "One entry per income source on the file, each income_id once.",
          items: {
            type: "object",
            properties: {
              income_id: { type: "string", minLength: 1 },
              method: { type: "string", enum: [...METHODS] },
              trend: { anyOf: [{ type: "string", enum: [...TRENDS] }, { type: "null" }] },
              monthly_qualifying_cents: CENTS,
              nontaxable_cents: CENTS,
              gross_up_cents: CENTS,
              continuance_end_date: { anyOf: [DATE, { type: "null" }] },
              counted: { type: "boolean" },
              exclusion_reason: {
                anyOf: [{ type: "string", enum: [...EXCLUSIONS] }, { type: "null" }],
              },
              liability_added_cents: CENTS,
            },
            required: [...ROW_FIELDS],
            additionalProperties: false,
          },
        },
        total_qualifying_cents: CENTS,
        obligations_from_rental_cents: CENTS,
      },
      required: ["sources", "total_qualifying_cents", "obligations_from_rental_cents"],
      additionalProperties: false,
    },
  },
];

export function executeIncomeTool(name: string, raw: unknown): string {
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${INCOME_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
