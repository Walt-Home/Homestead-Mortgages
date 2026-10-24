/**
 * The tools: reading a file of the package, looking up the layout's code
 * lists, and refi's exact-decimal calculator. None of them checks a cell,
 * compares two files or returns a verdict: finding the defects is the task.
 *
 * `read_file` needs the task, so it is answered with it (`execute`'s third
 * argument): the episode loop passes the task it is running.
 */

import type { ToolSpec } from "../episode.js";
import { HANDLINGS } from "../life/defects.js";
import { PACKAGE_FILES, type PackageFile } from "../life/transfer-package.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import { columnsOf, FORMATS } from "./layout.js";
import { parseCsv, toCsv } from "./ported/tape-codec.js";
import { RESTRICTED, type BoardingTask } from "./task.js";

export const BOARDING_SUBMIT_TOOL = "submit_triage";

const REUSED = ["calculate"];
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const READABLE = PACKAGE_FILES.filter((f) => !RESTRICTED.includes(f));
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

export const BOARDING_TOOLS: readonly ToolSpec[] = [
  {
    name: "read_file",
    description:
      "One file of the package as CSV text, header first: the whole file, or only the rows of one loan (by transferor loan number; for fnma_position.csv and mers_lookup.csv, the row of that loan's Fannie Mae number or MIN on the tape). The fair-lending file is restricted and cannot be read.",
    input_schema: object(
      {
        file: { type: "string", enum: [...READABLE] },
        loan: { type: "string", description: "A transferor loan number; omit for the whole file." },
      },
      ["file"],
    ),
  },
  {
    name: "code_list",
    description:
      "The layout's code list for a file's columns: each column's format (id, text, money, date, percent, bps, count, yes_no or code), its codes when it is coded, the layout's note, and for the final tape the MISMO path and the gate rules that read it. Name a column for one, or omit it for every column of the file.",
    input_schema: object(
      {
        file: { type: "string", enum: [...PACKAGE_FILES] },
        column: { type: "string" },
      },
      ["file"],
    ),
  },
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: BOARDING_SUBMIT_TOOL,
    description:
      "Submit the review: every defect found, one finding per cell, with its handling. A loan with no finding is passed as it is. An empty list passes every loan. A valid submission ends the task.",
    input_schema: object({
      findings: {
        type: "array",
        maxItems: 40,
        items: object({
          loan: { type: "string", description: "The transferor loan number." },
          file: { type: "string", enum: [...PACKAGE_FILES] },
          field: {
            type: "string",
            description: "The column of the cell that is wrong or missing.",
          },
          row: orNull({
            type: "string",
            description:
              'In a file with several rows per loan, the row: payment_history.csv its due_date, escrow_history.csv its line_type, images_manifest.csv its document_type, correspondence_file.csv its sent_on and kind ("2027-03-18 periodic_statement"); null for a file of one row per loan.',
          }),
          says: orNull({
            type: "string",
            description: 'The cell exactly as the file has it; "" for a blank.',
          }),
          truth: orNull({
            type: "string",
            description:
              "What the rest of the package says the cell should hold, written as the column writes it; null when it cannot say.",
          }),
          handling: { type: "string", enum: [...HANDLINGS] },
        }),
      },
    }),
  },
];

const KEY_COLUMN: Readonly<Partial<Record<PackageFile, string>>> = {
  "fnma_position.csv": "fnma_loan_number",
  "mers_lookup.csv": "min",
};

function readFile(task: BoardingTask, input: Record<string, unknown>): string {
  const file = input["file"];
  if (typeof file !== "string" || !(PACKAGE_FILES as readonly string[]).includes(file))
    throw new RangeError(`file must be one of ${READABLE.join(", ")}`);
  if (RESTRICTED.includes(file as PackageFile))
    throw new RangeError(
      `${file} is restricted (access-logged fair-lending data) and is not read in a boarding review`,
    );
  const text = task.files[file as PackageFile];
  const loan = input["loan"];
  if (loan === undefined) return text;
  if (typeof loan !== "string" || !task.loans.includes(loan.trim()))
    throw new RangeError(
      `no loan ${JSON.stringify(loan)} in this package; its loans are ${task.loans.join(", ")}`,
    );
  const rows = parseCsv(text);
  const header = text.slice(0, text.indexOf("\n")).split(",");
  const keyCol = KEY_COLUMN[file as PackageFile];
  let match = (r: Record<string, string>) => r["transferor_loan_number"] === loan.trim();
  if (keyCol) {
    const tape = parseCsv(task.files["boarding_tape.final.csv"]).find(
      (r) => r["transferor_loan_number"] === loan.trim(),
    )!;
    const k = tape[keyCol];
    match = (r) => r[keyCol] === k;
  }
  return toCsv(header, rows.filter(match));
}

function codeList(input: Record<string, unknown>): string {
  const file = input["file"];
  const column = input["column"];
  if (typeof file !== "string") throw new RangeError("file must be a file of the package");
  if (column !== undefined && typeof column !== "string")
    throw new RangeError("column must be a column's name, or omitted for every column");
  const cols = columnsOf(file, column);
  return JSON.stringify({
    file,
    formats: column === undefined ? FORMATS : undefined,
    columns: cols.map((c) => ({
      column: c.column,
      format: c.format,
      codes: c.codes,
      note: c.note,
      ...(c.mismo ? { mismo: c.mismo, read_by: c.read_by } : {}),
    })),
  });
}

export function executeBoardingTool(name: string, raw: unknown, task?: BoardingTask): string {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  if (name === "read_file") {
    if (!task)
      throw new Error("read_file reads the task's own package, and was called without one");
    return readFile(task, input);
  }
  if (name === "code_list") return codeList(input);
  if (!REUSED.includes(name))
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${BOARDING_TOOLS.map((t) => t.name).join(", ")}`,
    );
  return executeTool(name, raw);
}
