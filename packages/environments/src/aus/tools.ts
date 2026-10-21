/**
 * The tools: regz-price-tests' New York calendar date and Appendix J solve,
 * an APOR lookup over the frozen table the grader reads, and refi's level
 * payment, month count and exact calculator. Each is one primitive the
 * rulebook names. None takes a file, reads a report, picks a threshold or
 * returns a finding: deciding the file is the task.
 */

import { lookupApor } from "@hm/underwriting";
import type { ToolSpec } from "../episode.js";
import { REGZ_TOOLS, executeRegzTool } from "../regz/tools.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { FROZEN_APOR_TABLE } from "./apor-frozen.js";
import { AUS_SHAPES, BLOCKABLE, FINDING_CODES, type AusAnswer } from "./grader.js";

export const AUS_SUBMIT_TOOL = "submit_decision";

const FROM_REGZ = ["new_york_date", "annual_percentage_rate"];
const FROM_REFI = ["level_payment", "whole_months_between", "calculate"];
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };

const WEEKS = FROZEN_APOR_TABLE.weeks;
const APOR_TOOL: ToolSpec = {
  name: "apor",
  description: `The average prime offer rate, fixed-rate, for the FFIEC week containing a calendar date (weeks begin on Monday), from the table this lender holds: terms of ${[...FROZEN_APOR_TABLE.termYears].sort((a, b) => a - b).join(", ")} years, weeks from ${WEEKS[0]!.weekOf} through ${WEEKS.at(-1)!.weekOf}, each answering for its Monday and the six days after it. Returns the week's Monday and the rate in percent; an error for a term or a date the table does not hold.`,
  input_schema: {
    type: "object",
    properties: { date: DATE, term_years: { type: "integer", minimum: 1, maximum: 40 } },
    required: ["date", "term_years"],
    additionalProperties: false,
  },
};

const orNull = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

/** The submission's JSON schema, read off the parser's own shapes so the two cannot differ. */
function schemaOf(key: keyof AusAnswer): Record<string, unknown> {
  const s = AUS_SHAPES[key];
  switch (s.kind) {
    case "int": {
      const base = { type: "integer", minimum: s.min, maximum: s.max };
      return s.nullable ? orNull(base) : base;
    }
    case "text": {
      const base = { type: "string", pattern: s.shape.source, description: `e.g. ${s.example}` };
      return s.nullable ? orNull(base) : base;
    }
    case "bool":
      return s.nullable ? orNull({ type: "boolean" }) : { type: "boolean" };
    case "enum": {
      const base = { type: "string", enum: [...s.among] };
      return s.nullable ? orNull(base) : base;
    }
    case "set":
      return {
        type: "array",
        items: { type: "string", enum: [...s.among] },
        uniqueItems: true,
      };
  }
}

const SUBMIT_KEYS = Object.keys(AUS_SHAPES) as (keyof AusAnswer)[];

export const AUS_TOOLS: readonly ToolSpec[] = [
  ...REGZ_TOOLS.filter((t) => FROM_REGZ.includes(t.name)),
  APOR_TOOL,
  ...TOOLS.filter((t) => FROM_REFI.includes(t.name)),
  {
    name: AUS_SUBMIT_TOOL,
    description: `Submit the decision. Call it once, when every field is decided; null is the answer for a figure that cannot be computed on this file. findings lists finding codes (${FINDING_CODES.length} are possible) and blocked lists requirement ids (${BLOCKABLE.length} are possible), each empty when there are none. A valid submission ends the task.`,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(SUBMIT_KEYS.map((k) => [k, schemaOf(k)])),
      required: SUBMIT_KEYS,
      additionalProperties: false,
    },
  },
];

type Input = Readonly<Record<string, unknown>>;

export function executeAusTool(name: string, raw: unknown): string {
  if (FROM_REGZ.includes(name)) return executeRegzTool(name, raw);
  if (FROM_REFI.includes(name)) return executeTool(name, raw);
  if (name === "apor") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("the input must be an object");
    const i = raw as Input;
    const date = i["date"];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
      throw new TypeError("date must be a date, YYYY-MM-DD");
    const years = i["term_years"];
    if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 40)
      throw new TypeError("term_years must be a whole number from 1 to 40");
    // Midday in New York on that date, so the engine's own lookup matches the week on it.
    const at = new Date(`${date.trim()}T17:00:00.000Z`);
    if (!Number.isFinite(at.getTime())) throw new TypeError("date is not a valid date");
    const found = lookupApor(FROZEN_APOR_TABLE, at, years * 12, "Fixed");
    if (!found.found) throw new TypeError(`no APOR: ${found.reason}`);
    return JSON.stringify({ week_of: found.weekOf, apor_pct: found.rate.toFixed(2) });
  }
  throw new TypeError(
    `no tool named ${JSON.stringify(name)}; the tools are ${AUS_TOOLS.map((t) => t.name).join(", ")}`,
  );
}
