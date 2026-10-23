/**
 * The tools: refi's date step and day count, and payments-posting's
 * business-day roll on the servicer's calendar, the one the outbound
 * cadence's deadlines move on. None of them opens a window, decides a leg,
 * reviews a cycle, finds a delinquency or counts a call: putting those
 * together is the task.
 */

import type { ToolSpec } from "../episode.js";
import { PAYMENTS_TOOLS, executePaymentsTool } from "../payments/tools.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import {
  BK_STATUSES,
  CONTINUITY_STATUSES,
  CYCLE_OUTCOMES,
  LIVE_STATUSES,
  NOTICE_STATUSES,
  PERSONS,
  REPEAT_STATUSES,
} from "./grader.js";

export const EI_SUBMIT_TOOL = "submit_clocks";

const REUSED = ["date_add", "days_between"];
const BUSINESS = ["next_business_day"];
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const COUNT = { type: "integer", minimum: 0, maximum: 1000 };

export const EI_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  ...PAYMENTS_TOOLS.filter((t) => BUSINESS.includes(t.name)),
  {
    name: EI_SUBMIT_TOOL,
    description:
      "Submit where every clock stands. Call it once, when every section is decided; a section the loan does not have is null, and a list it has none of is empty. A valid submission ends the task.",
    input_schema: object({
      regx_days_delinquent: { type: "integer", minimum: 0, maximum: 100000 },
      windows: {
        type: "array",
        items: object({
          due_date: DATE,
          live_due: DATE,
          live: { type: "string", enum: [...LIVE_STATUSES] },
          live_late: { type: "boolean" },
          notice_due: DATE,
          notice: { type: "string", enum: [...NOTICE_STATUSES] },
          notice_late: { type: "boolean" },
        }),
      },
      cycles: {
        type: "array",
        items: object({
          provided_on: DATE,
          cycle_end: DATE,
          outcome: { type: "string", enum: [...CYCLE_OUTCOMES] },
          next_required_by: orNull(DATE),
          repeat: orNull({ type: "string", enum: [...REPEAT_STATUSES] }),
        }),
      },
      bk_notice: orNull(
        object({ due: orNull(DATE), status: { type: "string", enum: [...BK_STATUSES] } }),
      ),
      episodes: {
        type: "array",
        items: object({
          day_1: DATE,
          ended_on: orNull(DATE),
          continuity: object({
            assign_by: orNull(DATE),
            basis: orNull({ type: "string", enum: ["day_45", "ei_notice"] }),
            status: { type: "string", enum: [...CONTINUITY_STATUSES] },
          }),
          outbound: orNull(
            object({
              start_due: DATE,
              missed: { type: "array", items: DATE },
              next_due: orNull(DATE),
            }),
          ),
        }),
      },
      regf: orNull(
        object({
          counted_last_7: object({ borrower: COUNT, co_borrower: COUNT }),
          over_cap: {
            type: "array",
            items: object({ on: DATE, person: { type: "string", enum: [...PERSONS] } }),
          },
        }),
      ),
    }),
  },
];

export function executeEiTool(name: string, raw: unknown): string {
  if (BUSINESS.includes(name)) return executePaymentsTool(name, raw);
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${EI_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
