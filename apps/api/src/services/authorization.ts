/**
 * Whose data a route is about to fetch, and whether it may.
 *
 * The only minter. Every person-keyed connector method takes a `PurposeToken`
 * naming one party, and this is where one comes from: the party's rows in
 * `authorizations`, and nothing else. There is no fallback to a loan file's
 * `consents` — that bridge came out with the borrower columns it read, and a
 * refusal here is attributable to exactly one table.
 *
 * `tokenFor` is handed a BORROWER, not a file. A token speaks for one person,
 * so whose data is being fetched is the caller's to say and cannot be changed
 * out from under it by a file growing a second borrower. `primaryBorrower` is
 * the only guess left in this module, and it is a named call rather than a
 * subscript so that every place that still mints a token without saying whose
 * it is can be found by grepping for it.
 */

import { prisma } from "@hm/db";
import {
  mintPurposeToken,
  type AuthorizationPurpose,
  type Borrower,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import { AuthorizationError, PURPOSE_FOR, REQUIREMENT_FOR } from "@hm/connectors";
import { AppError } from "../middleware/error-handler.js";
import type { Db } from "./db.js";

/** `FCRA_WRITTEN_INSTRUCTION` -> `fcra_written_instruction`. */
const lower = <T extends string>(s: string) => s.toLowerCase() as T;

/**
 * The borrower a retrieval is about when the caller has not said which.
 *
 * The first borrower row, and `loadLoanFile` sorts those into DOCUMENT order:
 * the person holding `application_parties.borrower_ordinal` 1, falling back to
 * creation order only for a file with no application, or a borrower not yet
 * put on one. So this is Borrower 1 as the submission means it, and a person
 * who replaced the applicant at ordinal 1 is the subject even though their row
 * is the newest on the file.
 *
 * On a file with a co-borrower it is still a guess about WHOSE data the caller
 * wanted, and that is why it has a name: `borrowers[0]` states nothing, while a
 * call to this one marks a place where the second person has yet to be decided
 * about.
 */
export function primaryBorrower(file: LoanFile): Borrower {
  const subject = file.borrowers[0];
  if (!subject) {
    // Reachable: every connector route runs after screen 2, but a file whose
    // borrower row was never written would otherwise reach the adapter with
    // nobody to name. A 409 rather than a 403 — nothing was refused, there is
    // simply nobody to refuse it about.
    throw new AppError(
      409,
      "This file has no borrower yet, so there is nobody to authorize a retrieval about.",
      "NO_SUBJECT",
    );
  }
  return subject;
}

/**
 * The party a person-keyed retrieval on this file is about.
 *
 * Exported so the evidence a pull records can be attributed to the same person
 * the pull was authorized for. It is `primaryBorrower` spelled as an id, so a
 * route cannot end up recording a snapshot against one person while the token
 * in the same handler names another.
 */
export function subjectPartyId(file: LoanFile): string {
  return primaryBorrower(file).partyId;
}

/**
 * Permission to retrieve `category` about one named borrower.
 *
 * Throws `AuthorizationError` (403, carrying the requirement id the client
 * routes on) when the permission is missing, revoked, expired or for
 * something else.
 *
 * Reads the grants through the caller's client, so a grant the consent
 * trigger mirrored a moment ago in the same transaction is visible to the
 * mint. Still the only minter; still reads `authorizations` and nothing else.
 *
 * One borrower's grants can never mint another's token: the party filter is
 * the subject's own id, and `mintPurposeToken` filters the rows again. Two
 * people on one file are two authorizations, and neither stands in for the
 * other.
 */
export async function tokenFor(
  subject: Borrower,
  category: DataCategory,
  db: Db = prisma,
): Promise<PurposeToken> {
  const rows = await db.authorization.findMany({
    where: { partyId: subject.partyId },
    select: {
      id: true,
      partyId: true,
      purpose: true,
      dataCategories: true,
      grantedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const grants: Grant[] = rows.map((r) => ({
    id: r.id,
    partyId: r.partyId,
    purpose: lower<AuthorizationPurpose>(r.purpose),
    dataCategories: r.dataCategories.map((c) => lower<DataCategory>(c)),
    grantedAt: r.grantedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }));

  const result = mintPurposeToken({
    partyId: subject.partyId,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants,
    now: new Date(),
  });
  if (result.ok) return result.token;
  throw new AuthorizationError(
    `No authorization to retrieve ${category} for this borrower: ${result.message}. ` +
      "No credit, income, employment or asset data may be pulled.",
    REQUIREMENT_FOR[category],
  );
}
