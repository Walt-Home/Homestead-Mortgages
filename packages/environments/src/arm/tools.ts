/**
 * The tools: refi's level payment, scheduled balance, date steps, month
 * count and exact calculator, and nothing new. level_payment and
 * balance_after are the kernel's own amortization, the same arithmetic as
 * the engine's payment and scheduled balance, so a model that composes them
 * as the rulebook says lands on the engine's figure to the cent. There is no
 * index lookup (the model reads the series), no rounding to an eighth, no cap
 * test and no window: those are the task.
 */

import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { BOUNDS, NOTICE_KINDS, TEMPLATES } from "./grader.js";

export const ARM_SUBMIT_TOOL = "submit_adjustment";

const REUSED = [
  "level_payment",
  "balance_after",
  "date_add",
  "days_between",
  "whole_months_between",
  "calculate",
];
const CENTS = { type: "string", pattern: "^\\d+$", description: 'Integer cents, e.g. "247644".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const RATE3 = {
  type: "string",
  pattern: "^\\d{1,2}\\.\\d{3}$",
  description: 'A rate with three decimals, e.g. "6.375".',
};
const RATE5 = {
  type: "string",
  pattern: "^\\d{1,2}\\.\\d{5}$",
  description: 'Five decimals, e.g. "6.39883".',
};
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

const SUBMIT_FIELDS = {
  index_date: DATE,
  index_effective_date: DATE,
  index_value: RATE5,
  unrounded_pct: RATE5,
  rounded_pct: RATE3,
  midpoint_flag: { type: "boolean" },
  new_rate_pct: RATE3,
  bound: { type: "string", enum: BOUNDS },
  expected_upb_cents: CENTS,
  first_new_payment_due: DATE,
  remaining_term_months: { type: "integer", minimum: 1 },
  next_change_date: DATE,
  new_pi_cents: CENTS,
  notice_kind: { type: "string", enum: NOTICE_KINDS },
  notice_window_open: orNull(DATE),
  notice_due_by: DATE,
  notice_template: orNull({ type: "string", enum: Object.values(TEMPLATES) }),
  send_outcome: orNull({ type: "string", enum: ["blocked", "on_time", "late"] }),
  days_late: orNull({ type: "integer", minimum: 1 }),
  initial_notice_status: orNull({
    type: "string",
    enum: ["servicer", "originator_duty", "exempt_short_term"],
  }),
  initial_notice_window_open: orNull(DATE),
  initial_notice_due_by: orNull(DATE),
};

export const ARM_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: ARM_SUBMIT_TOOL,
    description:
      "Submit the adjustment. Call it once, when every field is decided; a field the change does not have is null. A valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: SUBMIT_FIELDS,
      required: Object.keys(SUBMIT_FIELDS),
      additionalProperties: false,
    },
  },
];

export function executeArmTool(name: string, raw: unknown): string {
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${ARM_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
