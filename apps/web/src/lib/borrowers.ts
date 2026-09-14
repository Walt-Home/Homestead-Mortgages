/**
 * Which person on a file a screen means.
 *
 * Every screen in this app used to write `file.borrowers[0]` and mean one of
 * two different things by it: "the person signed in", which is screens 2 and
 * 5, or "the first of however many there are", which is a list. While a file
 * could only ever hold one borrower the two were the same subscript and there
 * was nothing to tell apart. A file with a co-borrower on it separates them,
 * and an index says which position was read rather than which person was
 * meant — so the intent is named here instead.
 *
 * The API sends borrowers in DOCUMENT order: `application_parties`
 * `borrower_ordinal` is the position in the submission, and the projection
 * sorts on it. So the primary borrower is the first element for a structural
 * reason rather than a hopeful one, and everybody after them is somebody else.
 */

import type { LoanFileView } from "./file.js";

/** One person on a file, as the API sends them. */
export type BorrowerView = LoanFileView["borrowers"][number];

type WithBorrowers = Pick<LoanFileView, "borrowers"> | undefined;

/**
 * The person whose request this is — DU's Borrower 1.
 *
 * Undefined before screen 2 has been saved, which is a real state: screen 1
 * creates a file with nobody on it, and a screen that reads this has to be
 * able to say so rather than render a blank name.
 */
export function primaryBorrower(file: WithBorrowers): BorrowerView | undefined {
  return file?.borrowers[0];
}

/**
 * Everybody else on the file, in document order.
 *
 * Empty for the ordinary file, which is the one this flow builds. Four are
 * permitted by the schema; what renders them is a list, so the count is the
 * database's business and not a screen's.
 */
export function coBorrowers(file: WithBorrowers): readonly BorrowerView[] {
  return file?.borrowers.slice(1) ?? [];
}

/** What to call somebody on screen. Their own name, never a position. */
export function borrowerName(borrower: BorrowerView): string {
  return `${borrower.firstName} ${borrower.lastName}`;
}
