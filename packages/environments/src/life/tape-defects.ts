/**
 * Defects in the tape stream: what happens to a partner's monthly files
 * between its servicing system and our reader, planted in the files the tape
 * writer writes and labeled where they land.
 *
 * The family is apart from the 47 in docs/synthetic-data-defects.md. Those
 * are wrong values in a servicer's records, planted in the history and seen
 * on the tape because the history carries them; these are the delivery
 * mangling right values. Five are named, and all five are built:
 *
 *   T-01  a month missing from the stream, or last month's sent again;
 *   T-02  a renamed column;
 *   T-03  leading zeros stripped from a column of codes;
 *   T-04  a column of dates mangled by a spreadsheet: two-digit years, serial numbers, the day first;
 *   T-05  an as-of date that drifts from the month-end: the export date, or last month's.
 *
 * A definition plants itself in a stream. It is handed every file, the months
 * it reaches with the form it takes in each (`variants`), and a key its draws
 * hang off, so a defect that drops, repeats or renames a file has the stream
 * to do it in, and the same request plants the same cells. It returns the
 * planted stream and the root causes (`root_cause: true`): each value it
 * changed, where, and what it was. The symptoms are found by difference, as
 * a twin's are (defects.ts): `tapeSymptomLabels` reads each planted month's
 * clean and planted files with the reader it is handed and labels every
 * difference in what the reader made of them (`root_cause: false`). The
 * reader is handed in because it is `@hm/partner-book`'s, which this module
 * cannot import (tape.ts says why).
 *
 * **Two defects in one month are merged.** Each is planted where it happens
 * to a delivery (`stage`): the partner's export writes the as-of date and the
 * headers, then a spreadsheet rewrites codes and dates. They rewrite different
 * parts of the file, and a real delivery carries several at once: the
 * spreadsheet that strips a ZIP code's zero also rewrites a date column. A
 * symptom of a merged month belongs to each defect that shows it planted
 * alone, and to the pair when neither does, as a twin's do. T-01 is the
 * exception: it replaces the month's file whole, so nothing else can be
 * planted in it. A defect drawn at a rate for a month T-01 is in is skipped,
 * and so is a T-01 drawn at a rate for a month another defect was asked for by
 * name; both are reported in `skipped`. Two asked for by name, T-01 among
 * them, are refused.
 */

import {
  addBusinessDays,
  addMonths,
  daysBetween,
  endOfMonth,
  parts,
  plainDate,
  servicer as servicerCalendar,
  type PlainDate,
} from "@hm/kernel/calendar";
import { toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import type { DefectLabel } from "./defects.js";
import type { LifeBook } from "./generate.js";
import { TAPE_COLUMNS, TAPE_VERSION, tapeColumnIndex, type TapeFile } from "./tape.js";

/** A label on a tape stream: a `DefectLabel` that also names the file. */
export interface TapeDefectLabel extends DefectLabel {
  /** The file: for a root cause, the one planted; for a symptom, the one whose reading differs. */
  readonly tape: string;
}

/** Whether a delivery that carries the defect can be loaded: as delivered, once corrected from the delivery itself, or not until the partner sends again. */
export type TapeLoading = "as_delivered" | "corrected" | "resend";

/** The form a defect takes in one month, and the column it reaches there (by the layout's header) when it reaches one. */
export interface TapePlacement {
  readonly variant: string;
  readonly column: string | null;
}

export interface TapeDefectDefinition {
  readonly id: string;
  readonly title: string;
  /**
   * Where it happens to a delivery, which is the order merged defects are
   * planted in: 0 the file itself (T-01), 1 and 2 the partner's export (the
   * as-of date, the headers), 3 and 4 a spreadsheet (codes, dates).
   */
  readonly stage: number;
  /** The share of a stream's tapes the defect reaches when a request names no months: a design choice. */
  readonly default_rate: number;
  /** The forms it takes; a request may name one, and otherwise one is drawn for each month. */
  readonly variants: readonly string[];
  /**
   * The columns, by the layout's header, a defect that reaches one column can
   * reach in a form; a request may name one, and otherwise one is drawn for
   * each month. Null for a defect that reaches no one column.
   */
  columns(variant: string): readonly string[] | null;
  /**
   * Plant the defect in the files of each month of `months`, in the form and
   * the column its entry names, drawing anything else it needs from streams
   * under `key`. Every other file comes back as it was. The labels are the
   * root causes.
   */
  plant(
    stream: readonly TapeFile[],
    months: ReadonlyMap<string, TapePlacement>,
    key: string,
  ): { readonly stream: readonly TapeFile[]; readonly labels: readonly TapeDefectLabel[] };
  /** What a reader of the stream should do about the root cause, in each form. */
  handling(variant: string): string;
  /** Whether a delivery carrying it loads, in each form. The tests hold each to the reader. */
  loading(variant: string): TapeLoading;
  /** What it should do about a symptom in this table and field. */
  symptomHandling(table: string, field: string): string;
}

/** The tables a reading names (`TapeReading.rows[].tables`), and so a symptom's `file_or_table`. */
export const READ_TABLES = {
  /** What the reader made of a row on the partner-feed contract: `ImportedLoanRecord`. */
  record: "imported_loan_record",
  /** The facts it kept from the row, by the profile's keys. */
  facts: "tape_facts",
  /** The cells it kept under a header the profile does not know, verbatim. */
  raw: "tape_raw",
  /** The exceptions it raised, by code and column, counted. */
  exceptions: "tape_exceptions",
  /** A row read from one file and not the other. */
  rows: "tape_rows",
  /** The file refused whole. */
  file: "tape_import",
} as const;

/* ── cells ───────────────────────────────────────────────────────────────── */

/** A date as the writer writes one: m/d/yyyy, no padding (tape.ts). */
export const tapeDate = (d: PlainDate): string => {
  const p = parts(d);
  return `${p.m}/${p.d}/${p.y}`;
};
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** A cell the writer wrote as a date, read back; null for any other text. */
function readTapeDate(cell: string): PlainDate | null {
  const m = MDY.exec(cell);
  if (!m) return null;
  return plainDate(`${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
}
const lastDay = (month: string): PlainDate => endOfMonth(plainDate(`${month}-01`));
const previousMonth = (month: string): string =>
  addMonths(plainDate(`${month}-01`), -1).slice(0, 7);

/** The root cause at one cell of one file. */
function cellLabel(
  f: TapeFile,
  k: number,
  i: number,
  id: string,
  trueValue: string | null,
  plantedValue: string | null,
  handling: string,
): TapeDefectLabel {
  return {
    loan: f.loans[k] ?? "*",
    defect_id: id,
    file_or_table: f.filename,
    field: TAPE_COLUMNS[i]!.header,
    row: f.rows[k]?.[tapeColumnIndex("servicer_loan_number")] ?? "",
    on: f.as_of,
    true_value: trueValue,
    planted_value: plantedValue,
    expected_handling: handling,
    root_cause: true,
    tape: f.filename,
  };
}

/** Rewrite each cell of the placed column in the files of `months`, labeling every one that changes. */
function rewriteColumn(
  stream: readonly TapeFile[],
  months: ReadonlyMap<string, TapePlacement>,
  id: string,
  rewrite: (cell: string, month: string, variant: string) => string,
  handling: (variant: string) => string,
): { stream: TapeFile[]; labels: TapeDefectLabel[] } {
  const labels: TapeDefectLabel[] = [];
  const out = stream.map((f) => {
    const placement = months.get(f.month);
    if (placement === undefined) return f;
    const variant = placement.variant;
    const i = TAPE_COLUMNS.findIndex((c) => c.header === placement.column);
    if (i < 0) throw new RangeError(`${id} has no column ${placement.column} to reach`);
    const rows = f.rows.map((row, k) => {
      const cell = row[i] ?? "";
      const planted = cell === "" ? cell : rewrite(cell, f.month, variant);
      if (planted === cell) return row;
      labels.push(cellLabel(f, k, i, id, cell, planted, handling(variant)));
      return row.map((c, j) => (j === i ? planted : c));
    });
    return { ...f, rows };
  });
  return { stream: out, labels };
}

/* ── T-01 ────────────────────────────────────────────────────────────────── */

const T01_HANDLING: Readonly<Record<string, string>> = {
  missing:
    "Ask the partner for the month's tape. Each tape is the whole book as of its month-end, so the next month's " +
    "loads without it, but the month's observations (the review's evidence for that month) are missing until it comes.",
  resent:
    "Do not load it: the delivery is last month's tape again, file and rows as they were, and loading it would " +
    "record last month's book as this month's. Ask the partner for this month's tape.",
  relabeled:
    "Do not load it: last month's rows came under this month's name, every row as it was on last month's tape. " +
    "Ask the partner for this month's tape.",
};

/**
 * T-01: the month's file never comes (`missing`), or last month's comes in
 * its place, under its own name (`resent`) or under this month's
 * (`relabeled`). The delivery is the stream's slot for the month: `month` on
 * a planted file is the month it was delivered for, and its rows and as-of
 * are whatever came.
 */
export const T01: TapeDefectDefinition = {
  id: "T-01",
  title: "A month missing from the stream, or last month's tape sent again",
  stage: 0,
  // A partner misses or repeats about one month in four years.
  default_rate: 1 / 48,
  variants: ["missing", "resent", "relabeled"],
  columns: () => null,
  plant(stream, months) {
    const labels: TapeDefectLabel[] = [];
    const out: TapeFile[] = [];
    for (const f of stream) {
      const variant = months.get(f.month)?.variant;
      if (variant === undefined) {
        out.push(f);
        continue;
      }
      const handling = T01_HANDLING[variant]!;
      const label = (planted: string | null): TapeDefectLabel => ({
        loan: "*",
        defect_id: "T-01",
        file_or_table: f.filename,
        field: "file",
        row: f.month,
        on: f.as_of,
        true_value: `${f.filename} as of ${f.as_of}`,
        planted_value: planted,
        expected_handling: handling,
        root_cause: true,
        tape: f.filename,
      });
      if (variant === "missing") {
        labels.push(label(null));
        continue;
      }
      const before = previousMonth(f.month);
      const prior = stream.find((g) => g.month === before);
      if (!prior)
        throw new RangeError(
          `T-01 cannot send ${before} again for ${f.month}: the stream has no tape for ${before}`,
        );
      const sent: TapeFile = {
        ...prior,
        month: f.month,
        filename: variant === "resent" ? prior.filename : f.filename,
      };
      labels.push(label(`${sent.filename} as of ${prior.as_of}`));
      out.push(sent);
    }
    return { stream: out, labels };
  },
  handling: (v) => T01_HANDLING[v]!,
  loading: () => "resend",
  symptomHandling: (table) =>
    table === READ_TABLES.rows
      ? "A row the month's tape carries and the delivery does not, or the other way round: it comes right when the month's tape is sent."
      : "Read off last month's rows: it comes right when the month's tape is sent.",
};

/* ── T-02 ────────────────────────────────────────────────────────────────── */

/**
 * Headers an export renames, each to words a partner's system might use. None
 * reads as another of the profile's headers, the way the reader compares them
 * (trimmed, spaces collapsed, any case): a test holds that, because a rename
 * onto another column's header would be a different defect.
 */
export const T02_RENAMES: Readonly<Record<string, readonly string[]>> = {
  "Servicer Loan Number": ["Loan Number", "Loan No"],
  "Interest Bearing UPB": ["Current UPB", "Principal Balance"],
  "Current Interest Rate": ["Note Rate", "Interest Rate"],
  "Current P&I Payment Amt": ["P&I Payment", "Principal and Interest"],
  "Next Due Date": ["Next Payment Due Date", "Due Date"],
  "Date Maturity": ["Maturity Date", "Maturity"],
  "Property Zip Code": ["Zip Code", "Postal Code"],
  "Orig Date Closing": ["Closing Date", "Note Date"],
  Term: ["Original Term", "Loan Term"],
  "Pay String": ["Payment History", "Pay History String"],
  "SRV Asset Escrow Balance": ["Escrow Balance", "Escrow Bal"],
  "Current T&I Payment Amt": ["T&I Payment", "Escrow Payment"],
  "Total Due": ["Total Payment Due", "Total Monthly Payment"],
  IPD: ["Interest Paid To Date", "Paid To Date"],
  "Last Payment Date": ["Last Pmt Date", "Last Paid Date"],
  "MBA Delinquency Status": ["Delinquency Status", "MBA Status"],
  "Servicing Status": ["Loan Status", "Status"],
};

const T02_HANDLING: Readonly<Record<string, string>> = {
  required:
    "Do not load it: the reader refuses a file missing a required header, by name. The column's cells are intact; " +
    "ask the partner to export it under the layout's header.",
  optional:
    "Read the column as the layout's: its cells are intact, but the reader keeps them under the renamed header and " +
    "leaves the fact empty on every row. Ask the partner to export it under the layout's header.",
};

/**
 * T-02: the export writes one header in other words. A `required` header (the
 * profile marks it so) gets the file refused by name; any other leaves its
 * fact empty on every row and keeps the cells under `raw`. The cells
 * themselves are untouched, and the header stays where the layout puts it.
 */
export const T02: TapeDefectDefinition = {
  id: "T-02",
  title: "A renamed column",
  stage: 2,
  // An export's configuration changes about once in three years.
  default_rate: 1 / 36,
  variants: ["required", "optional"],
  columns: (variant) =>
    Object.keys(T02_RENAMES).filter(
      (h) =>
        (TAPE_COLUMNS[tapeColumnIndex(keyOfHeader(h))]!.required === true) ===
        (variant === "required"),
    ),
  plant(stream, months, key) {
    const labels: TapeDefectLabel[] = [];
    const out = stream.map((f) => {
      const placement = months.get(f.month);
      if (placement === undefined) return f;
      const variant = placement.variant;
      const header = placement.column!;
      const renamed = rngFor(`${key}/${f.month}`).pick(T02_RENAMES[header]!);
      const i = tapeColumnIndex(keyOfHeader(header));
      labels.push({
        loan: "*",
        defect_id: "T-02",
        file_or_table: f.filename,
        field: header,
        row: "header",
        on: f.as_of,
        true_value: header,
        planted_value: renamed,
        expected_handling: T02_HANDLING[variant]!,
        root_cause: true,
        tape: f.filename,
      });
      return { ...f, headers: f.headers.map((h, j) => (j === i ? renamed : h)) };
    });
    return { stream: out, labels };
  },
  handling: (v) => T02_HANDLING[v]!,
  loading: (v) => (v === "required" ? "resend" : "corrected"),
  symptomHandling: (table) =>
    table === READ_TABLES.file
      ? "The reader refused the file for a required header it could not find: restore the header and read it again."
      : table === READ_TABLES.raw
        ? "The column's cells, kept under the renamed header: read them as the layout's column."
        : "The fact the renamed column carries, empty on every row: it comes back when the column is read under the layout's header.",
};

/** The profile key of a header the layout has once. */
function keyOfHeader(header: string): string {
  const cols = TAPE_COLUMNS.filter((c) => c.header === header);
  if (cols.length !== 1)
    throw new RangeError(`the layout has ${cols.length} columns headed ${header}`);
  return cols[0]!.key;
}

/* ── T-03 ────────────────────────────────────────────────────────────────── */

/** Every character a digit and the first a zero, with more after it: what a spreadsheet reads as a number and writes back shorter. */
const LEADING_ZERO = /^0\d+$/;

const T03_HANDLING =
  "Read a column of codes as text, never as a number: pad the ZIP back to five digits and the pay string " +
  "to its twelve months, and ask the partner to export those columns as text. A spreadsheet that opens the " +
  "file reads them as numbers and writes them back without their leading zeros, and the reader takes the " +
  "shorter text as it stands.";

/**
 * T-03: the file went through a spreadsheet that read every column of digits
 * as a number, so each code that starts with a zero lost it. On the m3 tape
 * that is a ZIP code that starts with 0 (New England, New Jersey) and every
 * pay string that starts with a current month: "000000000000" becomes "0".
 * Only the layout's text columns are touched (by position, so a renamed
 * header does not hide one), and only a cell of two or more digits that
 * starts with 0; a money or date cell a spreadsheet would also rewrite reads
 * back the same, and the other rewrites belong to T-04.
 */
export const T03: TapeDefectDefinition = {
  id: "T-03",
  title: "Leading zeros stripped from a column of codes",
  stage: 3,
  // One tape in two years goes through a spreadsheet on its way to us.
  default_rate: 1 / 24,
  variants: ["stripped"],
  columns: () => null,
  plant(stream, months) {
    const labels: TapeDefectLabel[] = [];
    const out = stream.map((f) => {
      if (!months.has(f.month)) return f;
      const isText = f.headers.map(
        (_, i) => f.headers.length === TAPE_COLUMNS.length && TAPE_COLUMNS[i]!.type === "text",
      );
      const rows = f.rows.map((row, k) =>
        row.map((cell, i) => {
          if (!isText[i] || !LEADING_ZERO.test(cell)) return cell;
          const planted = cell.replace(/^0+(?=\d)/, "");
          labels.push(cellLabel(f, k, i, "T-03", cell, planted, T03_HANDLING));
          return planted;
        }),
      );
      return { ...f, rows };
    });
    return { stream: out, labels };
  },
  handling: () => T03_HANDLING,
  loading: () => "corrected",
  symptomHandling: (table, field) => {
    if (field === "property.postalCode" || field === "property_zip")
      return "The property's ZIP code lost its leading zero: restore it to five digits before the loan is matched to an address.";
    if (field === "pay_string" || field === "mba_pay_string")
      return "The pay string lost its oldest months: pad it back to twelve characters; anything that reads it by position misplaces every month.";
    if (table === READ_TABLES.exceptions)
      return "The reader flagged a cell the stripped zeros made unreadable: read the column as text and read the row again.";
    return "Downstream of the stripped zeros: corrects when the column is read as text.";
  },
};

/* ── T-04 ────────────────────────────────────────────────────────────────── */

/** The date columns a spreadsheet reformats here: each carries a date on every live loan's row. The As of Date is T-05's. */
export const T04_COLUMNS: readonly string[] = [
  "IPD",
  "Next Due Date",
  "Date Maturity",
  "Date Payment Due First",
  "Orig Date Closing",
  "Orig Maturity Date",
];

/** Excel's serial day number (the 1900 system, day 1 = 1900-01-01) of a date after 1900-02-28. */
export function excelSerial(d: PlainDate): number {
  return daysBetween(plainDate("1899-12-30"), d);
}

const T04_HANDLING: Readonly<Record<string, string>> = {
  two_digit_year:
    "Nothing read wrong: the reader puts a two-digit year in the century nearest the day it reads it, which is " +
    "right for every date on a tape read near its month. Ask the partner to export dates with four-digit years, " +
    "the layout's form, so the reading does not depend on the day.",
  serial:
    "Nothing read wrong: the reader converts an Excel serial number to its date. Ask the partner to export the " +
    "column as dates, the layout's form, not as the spreadsheet's numbers.",
  day_first:
    "Read the column day first: the reader takes a date as month first, so a day of 12 or less reads as the month " +
    "(the date silently wrong) and a day over 12 is unreadable. Ask the partner to export dates month first, the " +
    "layout's form.",
};

/**
 * T-04: a spreadsheet rewrote one date column: with two-digit years
 * (`two_digit_year`, "5/1/57"), as Excel serial numbers (`serial`,
 * "57100"), or day first (`day_first`, "1/5/2057" for 1 May). The column is
 * drawn for each month from `T04_COLUMNS`. A day-first date whose day and
 * month are the same reads the same, and is not changed.
 */
export const T04: TapeDefectDefinition = {
  id: "T-04",
  title: "A column of dates mangled by a spreadsheet",
  stage: 4,
  default_rate: 1 / 24,
  variants: ["two_digit_year", "serial", "day_first"],
  columns: () => T04_COLUMNS,
  plant(stream, months) {
    return rewriteColumn(
      stream,
      months,
      "T-04",
      (cell, _month, variant) => {
        const d = readTapeDate(cell);
        if (d === null) return cell;
        const p = parts(d);
        if (variant === "two_digit_year")
          return `${p.m}/${p.d}/${String(p.y % 100).padStart(2, "0")}`;
        if (variant === "serial") return String(excelSerial(d));
        return `${p.d}/${p.m}/${p.y}`;
      },
      (v) => T04_HANDLING[v]!,
    );
  },
  handling: (v) => T04_HANDLING[v]!,
  loading: (v) => (v === "day_first" ? "corrected" : "as_delivered"),
  symptomHandling: (table) =>
    table === READ_TABLES.exceptions
      ? "A date the reader could not read, day first with a day over 12: read the column day first."
      : "A date read with its day and month swapped: read the column day first.",
};

/* ── T-05 ────────────────────────────────────────────────────────────────── */

const T05_HANDLING: Readonly<Record<string, string>> = {
  export_date:
    "Set the as-of to the month-end the rows are measured on: the export wrote the day it ran. The reader takes " +
    "the tape's own as-of when it carries one, and the review counts days delinquent to it. Ask the partner to " +
    "write the month-end.",
  prior_month_end:
    "Set the as-of to this month's end: the rows moved on from last month's tape, and the export wrote last " +
    "month's date on them. The reader takes the tape's own as-of when it carries one. Ask the partner to write " +
    "the month-end.",
};

/**
 * T-05: the export writes an as-of date that is not the month-end on every
 * row: the day it ran, one to four business days after (`export_date`), or
 * last month's end (`prior_month_end`). The rows are this month's,
 * measured on its last day.
 */
export const T05: TapeDefectDefinition = {
  id: "T-05",
  title: "An as-of date that drifts from the month-end",
  stage: 1,
  default_rate: 1 / 36,
  variants: ["export_date", "prior_month_end"],
  columns: () => ["As of Date"],
  plant(stream, months, key) {
    const asOf = new Map<string, string>();
    for (const [month, { variant }] of months) {
      const end = lastDay(month);
      asOf.set(
        month,
        tapeDate(
          variant === "export_date"
            ? addBusinessDays(end, rngFor(`${key}/${month}`).int(1, 4), servicerCalendar)
            : lastDay(previousMonth(month)),
        ),
      );
    }
    return rewriteColumn(
      stream,
      months,
      "T-05",
      (_cell, month) => asOf.get(month)!,
      (v) => T05_HANDLING[v]!,
    );
  },
  handling: (v) => T05_HANDLING[v]!,
  loading: () => "corrected",
  symptomHandling: () =>
    "Read on the wrong date: the observation is filed under the as-of the tape carries. It comes right when the as-of is the month-end.",
};

export const TAPE_DEFECTS: Readonly<Record<string, TapeDefectDefinition>> = {
  "T-01": T01,
  "T-02": T02,
  "T-03": T03,
  "T-04": T04,
  "T-05": T05,
};

export function tapeDefectById(id: string): TapeDefectDefinition {
  const def = TAPE_DEFECTS[id];
  if (!def)
    throw new RangeError(
      `no tape defect ${id}; this wave plants ${Object.keys(TAPE_DEFECTS).join(", ")}`,
    );
  return def;
}

/* ── planting ────────────────────────────────────────────────────────────── */

/**
 * A tape defect to plant: its id, and either the months it reaches or a rate
 * over the stream's months; the form it takes (`variant`), and the column it
 * reaches when it reaches one (`column`, by the layout's header), or each
 * drawn for each month.
 */
export type TapeDefectRequest =
  | string
  | {
      readonly id: string;
      readonly months?: readonly string[];
      readonly rate?: number;
      readonly variant?: string;
      readonly column?: string;
    };

/** One defect in one month, in the form it took and the column it reached. */
export interface PlacedTapeDefect extends TapePlacement {
  readonly month: string;
  readonly defect_id: string;
}

export interface PlantedTapes {
  readonly clean: readonly TapeFile[];
  readonly planted: readonly TapeFile[];
  /** Each defect in each month it was planted in, by month and then by stage. */
  readonly placed: readonly PlacedTapeDefect[];
  /** A defect drawn for a month it could not be planted in (beside T-01), and why. */
  readonly skipped: readonly (PlacedTapeDefect & { readonly reason: string })[];
  /** The root causes. `tapeSymptomLabels` finds what each one reaches. */
  readonly labels: readonly TapeDefectLabel[];
  /** For a month with more than one defect, each planted alone in the clean stream: what its symptoms are told apart by. */
  readonly alone: readonly (PlacedTapeDefect & { readonly files: readonly TapeFile[] })[];
}

/**
 * Plant `requests` in a stream the tape writer wrote from `book`. A request
 * that names no months reaches each tape at its rate (or the defect's
 * `default_rate`), drawn from a stream of its own keyed by the book, the
 * defect and the month, so the months a defect reaches move with nothing
 * else. Nothing in `stream` is changed; the planted stream is a new one. Two
 * defects in one month are merged, and T-01 shares a month with nothing (the
 * header says how a collision is settled).
 */
export function plantTapeDefects(
  book: LifeBook,
  stream: readonly TapeFile[],
  requests: readonly TapeDefectRequest[],
): PlantedTapes {
  const key = `life/${book.version}/${book.seed}/tape/${TAPE_VERSION}`;
  const keyOf = (id: string) => `${key}/defects/${id}`;
  const months = [...new Set(stream.map((f) => f.month))].sort();
  const inStream = new Set(months);
  const drawn = new Map<string, (PlacedTapeDefect & { named: boolean })[]>();
  for (const req of requests) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = tapeDefectById(r.id);
    if (r.variant !== undefined && !def.variants.includes(r.variant))
      throw new RangeError(
        `${def.id} takes the forms ${def.variants.join(", ")}, not ${r.variant}`,
      );
    if (r.column !== undefined && r.variant === undefined)
      throw new RangeError(`${def.id}: name the form a column is asked for in`);
    if (r.column !== undefined && !def.columns(r.variant!)?.includes(r.column))
      throw new RangeError(
        `${def.id} ${r.variant} reaches ${def.columns(r.variant!)?.join(", ") ?? "no one column"}, not ${r.column}`,
      );
    const rate = r.rate ?? def.default_rate;
    const named = r.months !== undefined;
    const targets = r.months ?? months.filter((m) => rngFor(`${keyOf(def.id)}/${m}`).next() < rate);
    for (const m of targets) {
      if (!inStream.has(m)) throw new RangeError(`${def.id}: the stream has no tape for ${m}`);
      const list = drawn.get(m) ?? [];
      if (list.some((x) => x.defect_id === def.id)) continue;
      const variant = r.variant ?? rngFor(`${keyOf(def.id)}/${m}/variant`).pick(def.variants);
      const columns = def.columns(variant);
      const column =
        columns === null
          ? null
          : (r.column ?? rngFor(`${keyOf(def.id)}/${m}/column`).pick(columns));
      list.push({ month: m, defect_id: def.id, variant, column, named });
      drawn.set(m, list);
    }
  }
  // T-01 replaces a month's file whole: it keeps the month alone, or gives way to a defect asked for by name there.
  const placed: PlacedTapeDefect[] = [];
  const skipped: (PlacedTapeDefect & { reason: string })[] = [];
  const stageOf = (x: PlacedTapeDefect) => tapeDefectById(x.defect_id).stage;
  for (const m of [...drawn.keys()].sort()) {
    const list = drawn.get(m)!.sort((a, b) => stageOf(a) - stageOf(b));
    const t01 = list.find((x) => x.defect_id === "T-01");
    let keep = list;
    if (t01 && list.length > 1) {
      const others = list.filter((x) => x !== t01);
      if (t01.named && others.some((x) => x.named))
        throw new RangeError(
          `T-01 replaces the tape for ${m} whole, and cannot share it with ${others.find((x) => x.named)!.defect_id}`,
        );
      keep = t01.named || !others.some((x) => x.named) ? [t01] : others;
      for (const x of list.filter((y) => !keep.includes(y)))
        skipped.push({
          month: m,
          defect_id: x.defect_id,
          variant: x.variant,
          column: x.column,
          reason:
            x === t01
              ? `T-01 would replace the tape for ${m} whole, and ${others.map((y) => y.defect_id).join(" and ")} was asked for in it by name`
              : `T-01 replaces the tape for ${m} whole, so there is no file of the month's to plant ${x.defect_id} in`,
        });
    }
    for (const x of keep)
      placed.push({ month: x.month, defect_id: x.defect_id, variant: x.variant, column: x.column });
  }
  let planted: readonly TapeFile[] = stream;
  const labels: TapeDefectLabel[] = [];
  const ids = [...new Set(placed.map((x) => x.defect_id))].sort(
    (a, b) => tapeDefectById(a).stage - tapeDefectById(b).stage,
  );
  for (const id of ids) {
    const res = tapeDefectById(id).plant(
      planted,
      new Map(placed.filter((x) => x.defect_id === id).map((x) => [x.month, x])),
      keyOf(id),
    );
    planted = res.stream;
    labels.push(...res.labels);
  }
  const merged = new Set(
    placed
      .filter((x, _i, all) => all.filter((y) => y.month === x.month).length > 1)
      .map((x) => x.month),
  );
  const alone = placed
    .filter((x) => merged.has(x.month))
    .map((x) => ({
      ...x,
      files: tapeDefectById(x.defect_id)
        .plant(stream, new Map([[x.month, x]]), keyOf(x.defect_id))
        .stream.filter((f) => f.month === x.month),
    }));
  return { clean: stream, planted, placed, skipped, labels, alone };
}

/* ── what the reader made of it ──────────────────────────────────────────── */

/** What a reader made of one file, in plain data, so this module needs no reader of its own. */
export interface TapeReading {
  /** Why the reader refused the whole file, or null when it read it. */
  readonly rejected: string | null;
  /** Each row it kept, by the tape's loan number, with what it made of the row table by table (`READ_TABLES`). */
  readonly rows: readonly {
    readonly servicer_loan_number: string;
    readonly tables: Readonly<Record<string, unknown>>;
  }[];
  readonly exceptions: readonly {
    readonly servicer_loan_number: string | null;
    readonly code: string;
    readonly column?: string;
  }[];
}

export type TapeReader = (file: TapeFile) => TapeReading;

/** A value as a label carries it: scalars as they print, nothing as null. */
const leaf = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : typeof v === "string"
      ? v
      : typeof v === "bigint" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : toJsonLine(v);

/**
 * Every leaf of a value by its dotted path ("property.postalCode",
 * "parties.0.dateOfBirth"). An empty table has no leaves, so a row with
 * nothing kept under `raw` compares as one key against a row with something.
 */
function flatten(v: unknown, path = "", out = new Map<string, string | null>()) {
  if (v !== null && typeof v === "object" && typeof v !== "bigint") {
    const entries = Array.isArray(v)
      ? v.map((x, i) => [String(i), x] as const)
      : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0 && path !== "") out.set(path, leaf(v));
    for (const [k, x] of entries) flatten(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, leaf(v));
  return out;
}

interface Gathered {
  readonly rejected: string | null;
  readonly rows: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly exceptions: ReadonlyMap<string, number>;
}

/** What `read` made of one month's files together: rows by loan number (a repeat as `number#2`), exceptions counted. */
function gather(files: readonly TapeFile[], read: TapeReader): Gathered {
  const rs = files.map(read);
  const rejected = rs.flatMap((r) => (r.rejected === null ? [] : [r.rejected]));
  const rows = new Map<string, Readonly<Record<string, unknown>>>();
  for (const r of rs)
    for (const x of r.rows) {
      let k = x.servicer_loan_number;
      for (let n = 2; rows.has(k); n++) k = `${x.servicer_loan_number}#${n}`;
      rows.set(k, x.tables);
    }
  const exceptions = new Map<string, number>();
  for (const r of rs)
    for (const e of r.exceptions) {
      const k = `${e.servicer_loan_number ?? "*"}\u0000${e.code}${e.column ? `:${e.column}` : ""}`;
      exceptions.set(k, (exceptions.get(k) ?? 0) + 1);
    }
  return { rejected: rejected.length ? rejected.join("; ") : null, rows, exceptions };
}

/** One difference in what the reader made of a month: the table and field, the row, and the two readings. */
interface ReadDifference {
  readonly table: string;
  readonly field: string;
  readonly row: string;
  readonly true_value: string | null;
  readonly planted_value: string | null;
}

/** Every difference between what `read` made of two sets of one month's files. */
function readDifferences(
  clean: readonly TapeFile[],
  planted: readonly TapeFile[],
  tape: string,
  read: TapeReader,
): ReadDifference[] {
  const out: ReadDifference[] = [];
  const a = gather(clean, read);
  const b = gather(planted, read);
  if (a.rejected !== b.rejected)
    out.push({
      table: READ_TABLES.file,
      field: "rejected",
      row: tape,
      true_value: a.rejected,
      planted_value: b.rejected,
    });
  for (const k of [...new Set([...a.rows.keys(), ...b.rows.keys()])]) {
    const ra = a.rows.get(k);
    const rb = b.rows.get(k);
    if (!ra || !rb) {
      out.push({
        table: READ_TABLES.rows,
        field: "*",
        row: k,
        true_value: ra ? toJsonLine(ra) : null,
        planted_value: rb ? toJsonLine(rb) : null,
      });
      continue;
    }
    for (const t of [...new Set([...Object.keys(ra), ...Object.keys(rb)])]) {
      const fa = flatten(ra[t]);
      const fb = flatten(rb[t]);
      for (const f of [...new Set([...fa.keys(), ...fb.keys()])]) {
        const va = fa.get(f) ?? null;
        const vb = fb.get(f) ?? null;
        if (va !== vb) out.push({ table: t, field: f, row: k, true_value: va, planted_value: vb });
      }
    }
  }
  for (const k of [...new Set([...a.exceptions.keys(), ...b.exceptions.keys()])]) {
    const ca = a.exceptions.get(k) ?? 0;
    const cb = b.exceptions.get(k) ?? 0;
    if (ca === cb) continue;
    const [row, field] = k.split("\u0000") as [string, string];
    out.push({
      table: READ_TABLES.exceptions,
      field,
      row,
      true_value: String(ca),
      planted_value: String(cb),
    });
  }
  return out;
}

/**
 * Every difference between what `read` made of each planted month's clean
 * files and its planted ones, as symptom labels of the defect planted there:
 * the file refused or read, a row read from one and not the other, each
 * field of each table that differs, and each exception raised a different
 * number of times. A row is keyed by its loan number, a repeat of it as
 * `number#2`, and its `loan` is the generator's id for that number. In a
 * month with two defects, a symptom is labeled for each defect whose own
 * plant shows it, and for the pair ("T-03+T-04") when neither does alone.
 */
export function tapeSymptomLabels(p: PlantedTapes, read: TapeReader): TapeDefectLabel[] {
  const loanCol = tapeColumnIndex("servicer_loan_number");
  const out: TapeDefectLabel[] = [];
  for (const month of [...new Set(p.placed.map((x) => x.month))]) {
    const here = p.placed.filter((x) => x.month === month);
    const clean = p.clean.filter((f) => f.month === month);
    const planted = p.planted.filter((f) => f.month === month);
    const ref = clean[0] ?? planted[0];
    if (!ref) continue;
    const tape = planted[0]?.filename ?? ref.filename;
    const loanOf = new Map<string, string>();
    for (const f of [...clean, ...planted])
      f.rows.forEach((r, k) => {
        const n = r[loanCol];
        if (n && !loanOf.has(n)) loanOf.set(n, f.loans[k] ?? "*");
      });
    const label = (
      x: ReadDifference,
      defect_id: string,
      expected_handling: string,
    ): TapeDefectLabel => ({
      loan: loanOf.get(x.row.replace(/#\d+$/, "")) ?? "*",
      defect_id,
      file_or_table: x.table,
      field: x.field,
      row: x.row,
      on: ref.as_of,
      true_value: x.true_value,
      planted_value: x.planted_value,
      expected_handling,
      root_cause: false,
      tape,
    });
    const diffs = readDifferences(clean, planted, tape, read);
    if (here.length === 1) {
      const def = tapeDefectById(here[0]!.defect_id);
      for (const x of diffs) out.push(label(x, def.id, def.symptomHandling(x.table, x.field)));
      continue;
    }
    const place = (x: ReadDifference) => `${x.table}|${x.row}|${x.field}`;
    const alone = here.map((x) => ({
      def: tapeDefectById(x.defect_id),
      at: new Set(
        readDifferences(
          clean,
          p.alone.find((y) => y.month === month && y.defect_id === x.defect_id)!.files,
          tape,
          read,
        ).map(place),
      ),
    }));
    const pair = here.map((x) => x.defect_id).join("+");
    for (const x of diffs) {
      const owners = alone.filter((a) => a.at.has(place(x))).map((a) => a.def);
      if (owners.length === 0)
        out.push(
          label(
            x,
            pair,
            `Downstream of ${here.map((y) => y.defect_id).join(" and ")} together: corrects when both are.`,
          ),
        );
      for (const def of owners) out.push(label(x, def.id, def.symptomHandling(x.table, x.field)));
    }
  }
  return out;
}
