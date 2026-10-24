/**
 * The desk's reading of a delivery: what the m3-v1 reader makes of the file
 * before anyone looks at it, as the tape desk shows it beside the review.
 *
 * It is `parseBook`'s gate (packages/partner-book/src/book.ts) over the ported
 * profile: the required headers the file is refused for, each row's
 * exceptions from `mapTapeRow`, and a loan number seen twice. The supplement
 * is not part of a delivery here, and `deriveRecord` refuses none of the rows
 * the life generator writes (every name splits, every row has an address and
 * a term), so neither is run. A test reads every task's delivery with
 * `readBook` itself and holds this reading to it.
 */

import { M3_V1, mapTapeRow, profileHeadersPresent } from "./ported/m3-v1.js";

export interface DeskException {
  /** 1-based data row of the delivery. */
  readonly row: number;
  readonly servicer_loan_number: string | null;
  readonly code: string;
  readonly column: string | null;
}

export interface DeskReading {
  /** The required headers the reader could not find, refusing the file; null when it read it. */
  readonly refused: { readonly missing_headers: readonly string[] } | null;
  readonly rows_in_file: number;
  /** The rows it read: every row with a loan number, a state, a balance and a rate, and a loan number not seen before. */
  readonly rows_read: number;
  readonly exceptions: readonly DeskException[];
}

export function deskReading(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): DeskReading {
  const present = profileHeadersPresent(M3_V1, headers);
  if (!present.ok)
    return {
      refused: { missing_headers: present.missing },
      rows_in_file: rows.length,
      rows_read: 0,
      exceptions: [],
    };
  const exceptions: DeskException[] = [];
  const seen = new Set<string>();
  let read = 0;
  rows.forEach((r, k) => {
    const m = mapTapeRow(M3_V1, headers, r, k + 1);
    for (const e of m.exceptions)
      exceptions.push({
        row: e.row,
        servicer_loan_number: e.servicer_loan_number,
        code: e.code,
        column: e.column ?? null,
      });
    if (m.skip) return;
    const loan = String(m.facts[M3_V1.loanNumber]).trim();
    if (seen.has(loan)) {
      exceptions.push({
        row: k + 1,
        servicer_loan_number: loan,
        code: "duplicate_row",
        column: null,
      });
      return;
    }
    seen.add(loan);
    read++;
  });
  return { refused: null, rows_in_file: rows.length, rows_read: read, exceptions };
}
