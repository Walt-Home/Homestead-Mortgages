/**
 * A tape or supplement file as a header row and data rows, whichever of
 * `.xlsx` (first sheet) or `.csv` it is.
 *
 * The xlsx side is Doug's reader, vendored beside this file. The CSV side is
 * an RFC 4180 parser of our own — quoted fields, doubled quotes, CRLF or LF —
 * that keeps columns positional rather than keying them by header, because
 * the m3 tape carries "Current Occupancy" twice and a keyed parser would
 * collapse the pair.
 */

import { readXlsx } from "./vendored/xlsx.js";

export type ParsedFile = { readonly headers: string[]; readonly rows: string[][] };

const isXlsx = (filename: string, bytes: Uint8Array): boolean =>
  /\.xlsx$/i.test(filename) ||
  (bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04);

/** RFC 4180, positional. A trailing newline does not make an empty row. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Rows to CSV text, CRLF-terminated, every cell escaped as RFC 4180 wants. */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  return (
    rows.map((r) => r.map((c) => csvEscape(c === null ? "" : String(c))).join(",")).join("\r\n") +
    "\r\n"
  );
}

const trimRow = (r: readonly string[]): string[] => {
  const out = [...r];
  while (out.length && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
};

export function readTabular(filename: string, bytes: Uint8Array): ParsedFile {
  let rows: string[][];
  if (isXlsx(filename, bytes)) {
    const wb = readXlsx(bytes);
    rows = (wb.sheets[0]?.rows ?? []).map((r) => r.map((c) => c ?? ""));
  } else {
    const text = Buffer.from(bytes)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    rows = parseCsvRows(text);
  }
  rows = rows.map(trimRow).filter((r) => r.some((c) => c.trim() !== ""));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? "")) };
}
