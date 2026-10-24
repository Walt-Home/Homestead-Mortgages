/**
 * The tools: reading rows of the two tapes, comparing them cell by cell,
 * parsing a date as the reader does, looking up the layout, and refi's
 * exact-decimal calculator. None of them checks a rule or returns a verdict:
 * finding the defects is the task. A comparison says which cells differ, not
 * whether they should.
 *
 * Reading the tapes needs the task, so the tools are answered with it
 * (`execute`'s third argument).
 */

import { plainDate } from "@hm/kernel/calendar";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { ASKS, INTAKE_DEFECTS, VERDICTS } from "./grader.js";
import { LAYOUT, layoutColumn, letterOf, normalizeHeader } from "./layout.js";
import { parseDateIso } from "./ported/m3-v1.js";
import type { IntakeFile, TapeIntakeTask } from "./task.js";

export const INTAKE_SUBMIT_TOOL = "submit_intake";

const REUSED = ["calculate"];
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const FILES = ["delivery", "last_loaded"] as const;
const COLUMNS = {
  type: "array",
  maxItems: 118,
  items: { type: "string" },
  description: "Columns by letter (A to DN) or by the header the file has; omit for every column.",
};

export const INTAKE_TOOLS: readonly ToolSpec[] = [
  {
    name: "read_rows",
    description:
      "Rows of the delivery or of the last tape loaded, cells exactly as the file has them: every row, or the rows of some loans (by the partner's loan number, column C), and every column or some (by letter, or by the file's own header). Each row comes with its row number in the file, from 1.",
    input_schema: object(
      {
        file: { type: "string", enum: [...FILES] },
        loans: { type: "array", maxItems: 200, items: { type: "string" } },
        columns: COLUMNS,
      },
      ["file"],
    ),
  },
  {
    name: "compare_months",
    description:
      "The delivery beside the last tape loaded, column by column (by position, A to DN). Without a loan: the headers that differ, the loans on one tape and not the other (by the partner's loan number, column C), and for each loan on both, the columns whose cells differ, or that none do. With a loan: each cell that differs, last tape's and the delivery's. Columns narrow it, by letter or by header.",
    input_schema: object({ loan: { type: "string" }, columns: COLUMNS }, []),
  },
  {
    name: "parse_date",
    description:
      "What the m3-v1 reader reads a date cell as, read on a day (default the day the delivery was received): the ISO date, or null when it cannot read it, and the form it read it in (m/d/yyyy, m/d/yy with the year in the century nearest the day, an Excel serial day number, yyyy-mm-dd, yyyy/mm/dd or yyyymmdd).",
    input_schema: object(
      {
        cell: { type: "string", maxLength: 40 },
        read_on: { type: "string", description: "YYYY-MM-DD" },
      },
      ["cell"],
    ),
  },
  {
    name: "lookup_layout",
    description:
      "The m3-v1 layout: each column's letter, header, type, whether the reader requires it, the form the partner's export writes it in, and the rules its dates keep from month to month. Name a column (letter or header) for one, or omit it for all 118.",
    input_schema: object({ column: { type: "string" } }, []),
  },
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: INTAKE_SUBMIT_TOOL,
    description:
      "Submit the review: the verdict on the delivery and every defect found, one finding per defect, column and loan as the rulebook says. An empty list with load passes a clean delivery. A valid submission ends the task.",
    input_schema: object({
      verdict: { type: "string", enum: [...VERDICTS] },
      findings: {
        type: "array",
        maxItems: 40,
        items: object({
          defect: { type: "string", enum: [...INTAKE_DEFECTS] },
          month: {
            type: "string",
            description: "YYYY-MM: the month of the tape it is on, or the month never delivered.",
          },
          loan: orNull({
            type: "string",
            description: "The partner's loan number; null for a defect in the file as a whole.",
          }),
          column: orNull({
            type: "string",
            description: "The layout's header of the column; null for a defect in no one column.",
          }),
          says: orNull({
            type: "string",
            description: "What the tape says, exactly as the file has it.",
          }),
          truth: orNull({
            type: "string",
            description:
              "What is true, written as the layout writes it; null when the delivery cannot say.",
          }),
          ask: { type: "string", enum: [...ASKS] },
        }),
      },
    }),
  },
];

/* ── reading ─────────────────────────────────────────────────────────────── */

const LOAN = 2; // column C, the partner's loan number

function fileOf(task: TapeIntakeTask, name: unknown): IntakeFile {
  if (name === "delivery") return task.delivery;
  if (name === "last_loaded") return task.last_loaded;
  throw new RangeError(`file must be one of ${FILES.join(", ")}`);
}

/** The positions of the columns asked for, in the file's own headers or by letter. */
function positions(f: IntakeFile, columns: unknown): number[] {
  if (columns === undefined) return f.headers.map((_, i) => i);
  if (!Array.isArray(columns)) throw new RangeError("columns must be a list of letters or headers");
  return columns.map((c) => {
    if (typeof c !== "string") throw new RangeError("a column is a letter or a header");
    const t = c.trim();
    const byLetter = f.headers.findIndex((_, i) => letterOf(i) === t.toUpperCase());
    if (byLetter >= 0) return byLetter;
    const byHeader = f.headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(t));
    if (byHeader >= 0) return byHeader;
    throw new RangeError(
      `no column ${JSON.stringify(c)} in ${f.name}: name it by letter (A to ${letterOf(f.headers.length - 1)}) or by a header the file has`,
    );
  });
}

function loansOf(f: IntakeFile, loans: unknown): Set<string> | null {
  if (loans === undefined) return null;
  if (!Array.isArray(loans) || loans.some((l) => typeof l !== "string"))
    throw new RangeError("loans must be a list of the partner's loan numbers");
  const want = new Set((loans as string[]).map((l) => l.trim()));
  const on = new Set(f.rows.map((r) => r[LOAN] ?? ""));
  const missing = [...want].filter((l) => !on.has(l));
  if (missing.length) throw new RangeError(`no loan ${missing.join(", ")} on ${f.name}`);
  return want;
}

function readRows(task: TapeIntakeTask, input: Record<string, unknown>): string {
  const f = fileOf(task, input["file"]);
  const at = positions(f, input["columns"]);
  const loans = loansOf(f, input["loans"]);
  return JSON.stringify({
    file: f.name,
    columns: at.map((i) => ({ letter: letterOf(i), header: f.headers[i] })),
    rows: f.rows.flatMap((r, k) =>
      loans && !loans.has(r[LOAN] ?? "") ? [] : [{ row: k + 1, cells: at.map((i) => r[i] ?? "") }],
    ),
  });
}

/** Columns to compare: every one, or those asked for (by letter, or by a header either file has). */
function compared(task: TapeIntakeTask, columns: unknown): number[] {
  if (columns === undefined) return task.delivery.headers.map((_, i) => i);
  const d = task.delivery;
  const l = task.last_loaded;
  if (!Array.isArray(columns)) throw new RangeError("columns must be a list of letters or headers");
  return columns.map((c) => {
    try {
      return positions(d, [c])[0]!;
    } catch {
      return positions(l, [c])[0]!;
    }
  });
}

function compareMonths(task: TapeIntakeTask, input: Record<string, unknown>): string {
  const d = task.delivery;
  const l = task.last_loaded;
  const at = compared(task, input["columns"]);
  const byLoan = (f: IntakeFile) => new Map(f.rows.map((r) => [r[LOAN] ?? "", r]));
  const D = byLoan(d);
  const L = byLoan(l);
  const loan = input["loan"];
  if (loan !== undefined) {
    if (typeof loan !== "string") throw new RangeError("loan must be the partner's loan number");
    const n = loan.trim();
    const a = L.get(n);
    const b = D.get(n);
    if (!a && !b) throw new RangeError(`no loan ${n} on either tape`);
    return JSON.stringify({
      loan: n,
      on_last_loaded: !!a,
      on_delivery: !!b,
      cells:
        a && b
          ? at.flatMap((i) =>
              (a[i] ?? "") === (b[i] ?? "")
                ? []
                : [
                    {
                      letter: letterOf(i),
                      header: LAYOUT[i]?.header ?? null,
                      last_loaded: a[i] ?? "",
                      delivery: b[i] ?? "",
                    },
                  ],
            )
          : [],
    });
  }
  const both = [...D.keys()].filter((n) => L.has(n));
  const differing = both.flatMap((n) => {
    const cols = at.filter((i) => (L.get(n)![i] ?? "") !== (D.get(n)![i] ?? ""));
    return cols.length ? [{ loan: n, columns: cols.map(letterOf) }] : [];
  });
  return JSON.stringify({
    delivery: d.name,
    last_loaded: l.name,
    headers_differing: at.flatMap((i) =>
      (l.headers[i] ?? "") === (d.headers[i] ?? "")
        ? []
        : [
            {
              letter: letterOf(i),
              last_loaded: l.headers[i] ?? null,
              delivery: d.headers[i] ?? null,
            },
          ],
    ),
    loans_only_on_last_loaded: [...L.keys()].filter((n) => !D.has(n)),
    loans_only_on_delivery: [...D.keys()].filter((n) => !L.has(n)),
    loans_differing: differing,
    loans_the_same: both.filter((n) => !differing.some((x) => x.loan === n)),
  });
}

/* ── dates and the layout ────────────────────────────────────────────────── */

/** The form the reader's `parseDateIso` reads a cell in, by the branch it takes (m3-v1.ts). */
function dateForm(cell: string): string | null {
  const s = cell.trim();
  if (/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.test(s)) return "yyyy-mm-dd";
  if (/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.test(s)) return "yyyy/mm/dd";
  if (/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ].*)?$/.test(s)) return "m/d/yyyy";
  if (/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})(?:[T ].*)?$/.test(s)) return "m/d/yy";
  if (/^(\d{4})(\d{2})(\d{2})$/.test(s)) return "yyyymmdd";
  if (/^(\d{1,7})(?:\.\d*)?$/.test(s)) return "excel serial";
  return null;
}

function parseDate(task: TapeIntakeTask, input: Record<string, unknown>): string {
  const cell = input["cell"];
  if (typeof cell !== "string") throw new RangeError("cell must be the date cell's text");
  const on = input["read_on"] ?? task.delivery.received_on;
  if (typeof on !== "string") throw new RangeError("read_on must be YYYY-MM-DD");
  const day = plainDate(on);
  const reads = parseDateIso(cell, new Date(`${day}T12:00:00Z`));
  return JSON.stringify({
    cell,
    read_on: day,
    reads_as: reads,
    form: reads === null ? null : dateForm(cell),
  });
}

function lookupLayout(input: Record<string, unknown>): string {
  const name = input["column"];
  if (name !== undefined && typeof name !== "string")
    throw new RangeError("column must be a letter or a header, or omitted for all");
  const cols = name === undefined ? LAYOUT : [layoutColumn(name)];
  if (cols[0] === null)
    throw new RangeError(`no column ${JSON.stringify(name)} in the m3-v1 layout`);
  return JSON.stringify({
    layout: "m3-v1",
    rows: "one per loan the partner services at the month-end, or closed in the month",
    as_of: "the month's last day, on every row",
    columns: cols,
  });
}

export function executeIntakeTool(name: string, raw: unknown, task?: TapeIntakeTask): string {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  if (name === "lookup_layout") return lookupLayout(input);
  if (name === "read_rows" || name === "compare_months" || name === "parse_date") {
    if (!task) throw new Error(`${name} reads the task's own tapes, and was called without one`);
    if (name === "read_rows") return readRows(task, input);
    if (name === "compare_months") return compareMonths(task, input);
    return parseDate(task, input);
  }
  if (!REUSED.includes(name))
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${INTAKE_TOOLS.map((t) => t.name).join(", ")}`,
    );
  return executeTool(name, raw);
}
