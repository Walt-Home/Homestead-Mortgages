/**
 * Defects in the tape stream: what happens to a partner's monthly files
 * between its servicing system and our reader, planted in the files the tape
 * writer writes and labeled where they land.
 *
 * The family is apart from the 47 in docs/synthetic-data-defects.md. Those
 * are wrong values in a servicer's records, planted in the history and seen
 * on the tape because the history carries them; these are the delivery
 * mangling right values. Five are named:
 *
 *   T-01  a month missing from the stream, or delivered twice;
 *   T-02  a renamed column;
 *   T-03  leading zeros stripped from a column of codes;
 *   T-04  dates mangled by a spreadsheet;
 *   T-05  an as-of date that drifts from the month-end.
 *
 * T-03 is built. Each of the others is one more `TapeDefectDefinition`.
 *
 * A definition plants itself in a stream. It is handed every file and the
 * months it reaches, so a defect that drops, repeats or renames a file has
 * the stream to do it in, and it returns the planted stream and the root
 * causes (`root_cause: true`): each value it changed, where, and what it was.
 * A month carries one tape defect. The symptoms are found by difference, as
 * a twin's are (defects.ts): `tapeSymptomLabels` reads each planted month's
 * clean and planted files with the reader it is handed and labels every
 * difference in what the reader made of them (`root_cause: false`). The
 * reader is handed in because it is `@hm/partner-book`'s, which this module
 * cannot import (tape.ts says why).
 */

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

export interface TapeDefectDefinition {
  readonly id: string;
  readonly title: string;
  /** The share of a stream's tapes the defect reaches when a request names no months: a design choice. */
  readonly default_rate: number;
  /**
   * Plant the defect in the files of `months`. Every other file comes back as
   * it was. The labels are the root causes.
   */
  plant(
    stream: readonly TapeFile[],
    months: ReadonlySet<string>,
  ): { readonly stream: readonly TapeFile[]; readonly labels: readonly TapeDefectLabel[] };
  /** What a reader of the stream should do about the root cause. */
  readonly handling: string;
  /** What it should do about a symptom in this table and field. */
  symptomHandling(table: string, field: string): string;
}

/** The tables a reading names (`TapeReading.rows[].tables`), and so a symptom's `file_or_table`. */
export const READ_TABLES = {
  /** What the reader made of a row on the partner-feed contract: `ImportedLoanRecord`. */
  record: "imported_loan_record",
  /** The facts it kept from the row, by the profile's keys. */
  facts: "tape_facts",
  /** The exceptions it raised, by code and column, counted. */
  exceptions: "tape_exceptions",
  /** A row read from one file and not the other. */
  rows: "tape_rows",
  /** The file refused whole. */
  file: "tape_import",
} as const;

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
 * Only text columns are touched, and only a cell of two or more digits that
 * starts with 0; a money or date cell a spreadsheet would also rewrite reads
 * back the same, and the other rewrites belong to T-04.
 */
export const T03: TapeDefectDefinition = {
  id: "T-03",
  title: "Leading zeros stripped from a column of codes",
  // One tape in two years goes through a spreadsheet on its way to us.
  default_rate: 1 / 24,
  plant(stream, months) {
    const loanCol = tapeColumnIndex("servicer_loan_number");
    const labels: TapeDefectLabel[] = [];
    const out = stream.map((f) => {
      if (!months.has(f.month)) return f;
      const isText = f.headers.map(
        (h, i) => TAPE_COLUMNS[i]?.header === h && TAPE_COLUMNS[i]!.type === "text",
      );
      const rows = f.rows.map((row, k) =>
        row.map((cell, i) => {
          if (!isText[i] || !LEADING_ZERO.test(cell)) return cell;
          const planted = cell.replace(/^0+(?=\d)/, "");
          labels.push({
            loan: f.loans[k] ?? "*",
            defect_id: "T-03",
            file_or_table: f.filename,
            field: f.headers[i]!,
            row: row[loanCol] ?? "",
            on: f.as_of,
            true_value: cell,
            planted_value: planted,
            expected_handling: T03_HANDLING,
            root_cause: true,
            tape: f.filename,
          });
          return planted;
        }),
      );
      return { ...f, rows };
    });
    return { stream: out, labels };
  },
  handling: T03_HANDLING,
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

export const TAPE_DEFECTS: Readonly<Record<string, TapeDefectDefinition>> = { "T-03": T03 };

export function tapeDefectById(id: string): TapeDefectDefinition {
  const def = TAPE_DEFECTS[id];
  if (!def)
    throw new RangeError(
      `no tape defect ${id}; this wave plants ${Object.keys(TAPE_DEFECTS).join(", ")}`,
    );
  return def;
}

/* ── planting ────────────────────────────────────────────────────────────── */

/** A tape defect to plant: its id, and either the months it reaches or a rate over the stream's months. */
export type TapeDefectRequest =
  string | { readonly id: string; readonly months?: readonly string[]; readonly rate?: number };

export interface PlantedTapes {
  readonly clean: readonly TapeFile[];
  readonly planted: readonly TapeFile[];
  /** The month each defect was planted in, oldest first. */
  readonly placed: readonly { readonly month: string; readonly defect_id: string }[];
  /** The root causes. `tapeSymptomLabels` finds what each one reaches. */
  readonly labels: readonly TapeDefectLabel[];
}

/**
 * Plant `requests` in a stream the tape writer wrote from `book`. A request
 * that names no months reaches each tape at its rate (or the defect's
 * `default_rate`), drawn from a stream of its own keyed by the book, the
 * defect and the month, so the months a defect reaches move with nothing
 * else. Nothing in `stream` is changed; the planted stream is a new one.
 */
export function plantTapeDefects(
  book: LifeBook,
  stream: readonly TapeFile[],
  requests: readonly TapeDefectRequest[],
): PlantedTapes {
  const key = `life/${book.version}/${book.seed}/tape/${TAPE_VERSION}`;
  const months = [...new Set(stream.map((f) => f.month))].sort();
  const inStream = new Set(months);
  const placed = new Map<string, string>();
  for (const req of requests) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = tapeDefectById(r.id);
    const rate = r.rate ?? def.default_rate;
    const targets =
      r.months ?? months.filter((m) => rngFor(`${key}/defects/${def.id}/${m}`).next() < rate);
    for (const m of targets) {
      if (!inStream.has(m)) throw new RangeError(`${def.id}: the stream has no tape for ${m}`);
      const already = placed.get(m);
      if (already && already !== def.id)
        throw new RangeError(
          `the tape for ${m} already carries ${already}; a month carries one tape defect`,
        );
      placed.set(m, def.id);
    }
  }
  let planted: readonly TapeFile[] = stream;
  const labels: TapeDefectLabel[] = [];
  for (const id of [...new Set(placed.values())].sort()) {
    const res = tapeDefectById(id).plant(
      planted,
      new Set([...placed].filter(([, d]) => d === id).map(([m]) => m)),
    );
    planted = res.stream;
    labels.push(...res.labels);
  }
  return {
    clean: stream,
    planted,
    placed: [...placed]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, defect_id]) => ({ month, defect_id })),
    labels,
  };
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

/** Every leaf of a value by its dotted path ("property.postalCode", "parties.0.dateOfBirth"). */
function flatten(v: unknown, path = "", out = new Map<string, string | null>()) {
  if (v !== null && typeof v === "object" && typeof v !== "bigint") {
    const entries = Array.isArray(v)
      ? v.map((x, i) => [String(i), x] as const)
      : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) out.set(path, leaf(v));
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

/**
 * Every difference between what `read` made of each planted month's clean
 * files and its planted ones, as symptom labels of the defect planted there:
 * the file refused or read, a row read from one and not the other, each
 * field of each table that differs, and each exception raised a different
 * number of times. A row is keyed by its loan number, a repeat of it as
 * `number#2`, and its `loan` is the generator's id for that number.
 */
export function tapeSymptomLabels(p: PlantedTapes, read: TapeReader): TapeDefectLabel[] {
  const loanCol = tapeColumnIndex("servicer_loan_number");
  const out: TapeDefectLabel[] = [];
  for (const { month, defect_id } of p.placed) {
    const def = tapeDefectById(defect_id);
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
      table: string,
      field: string,
      row: string,
      tv: string | null,
      pv: string | null,
    ): TapeDefectLabel => ({
      loan: loanOf.get(row.replace(/#\d+$/, "")) ?? "*",
      defect_id,
      file_or_table: table,
      field,
      row,
      on: ref.as_of,
      true_value: tv,
      planted_value: pv,
      expected_handling: def.symptomHandling(table, field),
      root_cause: false,
      tape,
    });
    const a = gather(clean, read);
    const b = gather(planted, read);
    if (a.rejected !== b.rejected)
      out.push(label(READ_TABLES.file, "rejected", tape, a.rejected, b.rejected));
    for (const k of [...new Set([...a.rows.keys(), ...b.rows.keys()])]) {
      const ra = a.rows.get(k);
      const rb = b.rows.get(k);
      if (!ra || !rb) {
        out.push(
          label(READ_TABLES.rows, "*", k, ra ? toJsonLine(ra) : null, rb ? toJsonLine(rb) : null),
        );
        continue;
      }
      for (const t of [...new Set([...Object.keys(ra), ...Object.keys(rb)])]) {
        const fa = flatten(ra[t]);
        const fb = flatten(rb[t]);
        for (const f of [...new Set([...fa.keys(), ...fb.keys()])]) {
          const va = fa.get(f) ?? null;
          const vb = fb.get(f) ?? null;
          if (va !== vb) out.push(label(t, f, k, va, vb));
        }
      }
    }
    for (const k of [...new Set([...a.exceptions.keys(), ...b.exceptions.keys()])]) {
      const ca = a.exceptions.get(k) ?? 0;
      const cb = b.exceptions.get(k) ?? 0;
      if (ca === cb) continue;
      const [row, field] = k.split("\u0000") as [string, string];
      out.push(label(READ_TABLES.exceptions, field, row, String(ca), String(cb)));
    }
  }
  return out;
}
