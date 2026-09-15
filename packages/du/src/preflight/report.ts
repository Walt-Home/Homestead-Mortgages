/**
 * What the gate says when it refuses, and the one rule every message follows.
 *
 * **A finding names the destination and the defect and never the value.** The
 * document holds up to four cleartext taxpayer identifiers and a date of birth
 * for each borrower, and a refusal is a string that gets thrown, caught,
 * logged and pasted into a ticket. A message that quoted the value it did not
 * like would put the one thing this system keeps out of Postgres into a log
 * line — so a length overrun reports the XPath and the count of characters, a
 * malformed date reports the XPath, and neither reports what was there.
 *
 * **There is one severity, and it is refusal.** A preflight that warned would
 * be a second lint beside `xmllint`, and the reason this exists is that the
 * schema accepts documents Desktop Underwriter rejects: a dangling arc, a
 * duplicate label, an invented arcrole and a missing `RELATIONSHIPS` container
 * all validate. Anything that belongs in a warning belongs in a check that has
 * not been written yet.
 */

/** Which check found it. The message says what; this says which predicate. */
export type DuPreflightCheck =
  /** An `xlink:from` or `xlink:to` naming a label the document does not carry. */
  | "arc-endpoint-unresolved"
  /** Two containers under one `xlink:label`. */
  | "label-not-unique"
  /** An `xlink:arcrole` that is not one of the eleven the specification names. */
  | "arcrole-unknown"
  /** An arc whose end lands on a container the arcrole does not put there. */
  | "arc-endpoint-wrong-container"
  /** An asset, liability or expense that no arc leaves: a row belonging to nobody. */
  | "container-has-no-arc"
  /** Two siblings of one element name under one `SequenceNumber`. */
  | "sequence-number-not-unique"
  /** A container the specification requires in a place where the document has none. */
  | "container-below-minimum"
  /** More of a container than the specification admits. */
  | "container-above-maximum"
  /** One borrower with two income items of one DU income type. */
  | "income-type-repeated"
  /** A data point the specification requires wherever its container appears. */
  | "required-data-point-absent"
  /** A conditional data point whose condition holds and which is not there. */
  | "conditional-data-point-absent"
  /** A value that is not written the way its format is written. */
  | "value-malformed"
  /** A value longer than the maximum for the destination it is written to. */
  | "value-too-long"
  /** A figure the document states twice, disagreeing with itself. */
  | "derived-figure-disagrees"
  /** A live row whose identity key says the matcher could not tell it from another. */
  | "identity-unmatched";

export interface DuPreflightFinding {
  readonly check: DuPreflightCheck;
  /** Where the defect is: an XPath, a label, or a row id. Never a borrower's value. */
  readonly where: string;
  /** What is wrong with it, in words a person resolving it can act on. */
  readonly message: string;
}

/** What a preflight run answers. Empty findings is the only way to emit. */
export interface DuPreflightReport {
  readonly ok: boolean;
  readonly findings: readonly DuPreflightFinding[];
}

/** Where a check writes what it found. */
export interface Findings {
  add(check: DuPreflightCheck, where: string, message: string): void;
}

export function collectFindings(): Findings & { readonly found: DuPreflightFinding[] } {
  const found: DuPreflightFinding[] = [];
  return {
    found,
    add(check, where, message) {
      found.push({ check, where, message });
    },
  };
}
