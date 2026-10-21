/**
 * The tools: refi's date steps, whole months, per diem and exact calculator,
 * and the business-day calendars the engine counts its clocks on (the
 * servicer's, Regulation X's federal one, and Fannie Mae's; by default the
 * same days). None of them computes a deadline, a payoff figure, a
 * disposition or a share: putting those together is the task.
 */

import {
  addBusinessDays,
  fannieEt,
  federal,
  plainDate,
  servicer,
  type Calendar,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { DISPOSITIONS } from "./grader.js";

export const PAYOFF_SUBMIT_TOOL = "submit_payoff";

const REUSED = ["date_add", "days_between", "whole_months_between", "per_diem", "calculate"];
const CENTS = {
  type: "string",
  pattern: "^-?\\d+$",
  description: 'Integer cents, e.g. "25039082".',
};
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

const CALENDARS: Readonly<Record<string, Calendar>> = {
  servicer,
  federal,
  fannie_mae: fannieEt,
};
const CALENDAR = {
  type: "string",
  enum: Object.keys(CALENDARS),
  description:
    "servicer: the servicer's office days; federal: Regulation X's business days; fannie_mae: Fannie Mae's business days. Each is Monday to Friday except the federal legal public holidays as observed (a Saturday holiday on the Friday before, a Sunday holiday on the Monday after).",
};

export const PAYOFF_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: "add_business_days",
    description:
      "A date moved by a number of business days on a calendar. Only business days are counted: the first business day after the date is day 1, whatever day the date itself is. 0 returns the date unchanged; a negative number walks back.",
    input_schema: {
      type: "object",
      properties: {
        date: DATE,
        days: { type: "integer", minimum: -400, maximum: 400 },
        calendar: CALENDAR,
      },
      required: ["date", "days", "calendar"],
      additionalProperties: false,
    },
  },
  {
    name: "is_business_day",
    description: "Whether a date is a business day on a calendar.",
    input_schema: {
      type: "object",
      properties: { date: DATE, calendar: CALENDAR },
      required: ["date", "calendar"],
      additionalProperties: false,
    },
  },
  {
    name: PAYOFF_SUBMIT_TOOL,
    description:
      "Submit the statement, the reconciliation and Fannie Mae's share. Call it once, when every field is decided; a figure the rulebook says is null is null. A valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
        federal_due: DATE,
        state_due: orNull(DATE),
        governing: { type: "string", enum: ["federal", "state"] },
        governing_due: DATE,
        valid_until: DATE,
        months_full: { type: "integer" },
        days_partial: { type: "integer" },
        interest_full_cents: CENTS,
        interest_partial_cents: CENTS,
        per_diem_cents: CENTS,
        nib_line_cents: CENTS,
        total_cents: CENTS,
        alt_applies: { type: "boolean" },
        alt_if_posts_total_cents: orNull(CENTS),
        payoff_date: DATE,
        exact_total_cents: CENTS,
        variance_cents: CENTS,
        disposition: { type: "string", enum: [...DISPOSITIONS] },
        escrow_refund_by: DATE,
        fnma_principal_cents: CENTS,
        fnma_interest_cents: CENTS,
        servicing_fee_cents: orNull(CENTS),
        ss_interest_gap_cents: orNull(CENTS),
        fnma_total_cents: CENTS,
      },
      required: [
        "federal_due",
        "state_due",
        "governing",
        "governing_due",
        "valid_until",
        "months_full",
        "days_partial",
        "interest_full_cents",
        "interest_partial_cents",
        "per_diem_cents",
        "nib_line_cents",
        "total_cents",
        "alt_applies",
        "alt_if_posts_total_cents",
        "payoff_date",
        "exact_total_cents",
        "variance_cents",
        "disposition",
        "escrow_refund_by",
        "fnma_principal_cents",
        "fnma_interest_cents",
        "servicing_fee_cents",
        "ss_interest_gap_cents",
        "fnma_total_cents",
      ],
      additionalProperties: false,
    },
  },
];

const calendarOf = (v: unknown): Calendar => {
  const c = typeof v === "string" ? CALENDARS[v] : undefined;
  if (!c) throw new TypeError(`calendar must be one of ${Object.keys(CALENDARS).join(", ")}`);
  return c;
};
const dateOf = (v: unknown): PlainDate => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new TypeError("date must be YYYY-MM-DD");
  return plainDate(v);
};

export function executePayoffTool(name: string, raw: unknown): string {
  const i = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  if (name === "add_business_days") {
    const n = i["days"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < -400 || n > 400)
      throw new TypeError("days must be a whole number from -400 to 400");
    // The kernel's own count (business.ts addBusinessDays), the one every clock here runs on.
    return JSON.stringify({
      date: addBusinessDays(dateOf(i["date"]), n, calendarOf(i["calendar"])),
    });
  }
  if (name === "is_business_day") {
    return JSON.stringify({
      business_day: calendarOf(i["calendar"]).isBusinessDay(dateOf(i["date"])),
    });
  }
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${PAYOFF_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
