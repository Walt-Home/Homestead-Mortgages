/**
 * The tools: refi's date steps, whole months and exact calculator, and the
 * business-day step payoff-statement gives (on Fannie Mae's calendar, the
 * one the deferral's reporting deadline is counted on). None of them walks
 * the hierarchy, applies a cap, searches a repayment term, screens a
 * deferral or sets a window: putting those together is the task.
 */

import type { ToolSpec } from "../episode.js";
import { PAYOFF_TOOLS, executePayoffTool } from "../payoff/tools.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { FORBEARANCE_CAPS, RETENTION, SCREEN_REASONS, TIERS } from "./grader.js";

export const LOSSMIT_SUBMIT_TOOL = "submit_evaluation";

const REUSED = ["date_add", "days_between", "end_of_month", "whole_months_between", "calculate"];
const BUSINESS = ["add_business_days"];
const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "158017".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const MONTHS = { type: "integer", minimum: 0, maximum: 600 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

export const LOSSMIT_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  ...PAYOFF_TOOLS.filter((t) => BUSINESS.includes(t.name)),
  {
    name: LOSSMIT_SUBMIT_TOOL,
    description:
      "Submit the evaluation. Call it once, when every section is decided; a section the evaluation does not have is null. A valid submission ends the task.",
    input_schema: object({
      arrears: object({
        months_delinquent: MONTHS,
        late_charges_cents: CENTS,
        arrears_cents: CENTS,
      }),
      offered: { type: "string", enum: [...RETENTION] },
      terms: {
        anyOf: [
          object({
            months: { type: "integer", minimum: 0, maximum: 3 },
            capped_by: {
              type: "array",
              items: { type: "string", enum: [...FORBEARANCE_CAPS] },
              uniqueItems: true,
            },
            exception_required: { type: "boolean" },
            term_start: DATE,
            term_end: DATE,
            regx_short_term: { type: "boolean" },
          }),
          object({
            months: { type: "integer", minimum: 1, maximum: 12 },
            installment_cents: CENTS,
            final_installment_cents: CENTS,
            total_monthly_cents: CENTS,
            pct_of_contractual: {
              type: "string",
              pattern: "^\\d{1,3}\\.\\d{2}$",
              description: 'Two decimals, truncated, e.g. "138.25".',
            },
            regx_short_term: { type: "boolean" },
          }),
          object({
            months_deferred: { type: "integer", minimum: 0, maximum: 12 },
            installments_to_pay: { type: "integer", minimum: 0, maximum: 12 },
            contractual_payment_required: { type: "boolean" },
            cumulative_months_after: { type: "integer", minimum: 0, maximum: 24 },
            nib_cents: CENTS,
            late_charges_waived_cents: CENTS,
            shortage_monthly_cents: CENTS,
            new_payment_cents: CENTS,
          }),
          { type: "null" },
        ],
      },
      deferral_screen: orNull(
        object({
          eligible: { type: "boolean" },
          reason: orNull({ type: "string", enum: [...SCREEN_REASONS] }),
        }),
      ),
      deferral_timeline: orNull(
        object({
          processing_month: { type: "boolean" },
          entry_deadline: DATE,
          lar_deadline: DATE,
          effective: DATE,
          custodian_by: DATE,
        }),
      ),
      regx: object({
        tier: { type: "string", enum: [...TIERS] },
        decision_due: DATE,
        window_days: { type: "integer", minimum: 1, maximum: 90 },
        accept_by: DATE,
        appeal_rights: { type: "boolean" },
        deemed_rejected_on: DATE,
      }),
    }),
  },
];

export function executeLossmitTool(name: string, raw: unknown): string {
  if (BUSINESS.includes(name)) return executePayoffTool(name, raw);
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${LOSSMIT_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
