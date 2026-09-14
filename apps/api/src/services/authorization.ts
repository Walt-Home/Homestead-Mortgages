/**
 * Whose data a route is about to fetch, and whether it may.
 *
 * The only minter. Every person-keyed connector method takes a `PurposeToken`
 * naming one party, and this is where one comes from.
 *
 * `tokenFor` is handed a FILE and a BORROWER, and both halves are load-bearing.
 * A token speaks for one person, so whose data is being fetched is the
 * caller's to say and cannot be changed out from under it by a file growing a
 * second borrower; and it speaks on one application, because the grant a
 * consent mirrors to carries no loan file and lives 120 days. Read by party
 * alone it is one person's permission everywhere, forever — so a borrower who
 * signed a Form 4506-C on an application of their own had their transcripts
 * pulled onto a joint file they had signed nothing on, by the applicant who
 * holds the only session there. The file's own signature is what scopes it,
 * and it is asked here rather than in a route so that a new route cannot
 * forget it.
 *
 * `primaryBorrower` is the only guess left in this module, and it is a named
 * call rather than a subscript so that every place that still mints a token
 * without saying whose it is can be found by grepping for it.
 */

import { prisma, type AuthorizationPurpose as StoredPurpose } from "@hm/db";
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
import { partyForUser } from "./party.js";
import { signedOnFor } from "./signature.js";

/** `FCRA_WRITTEN_INSTRUCTION` -> `fcra_written_instruction`. */
const lower = <T extends string>(s: string) => s.toLowerCase() as T;

/** And back: the domain spelling of a purpose is the column's, lowercased. */
const upper = (s: string) => s.toUpperCase() as StoredPurpose;

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
 * The borrower a retrieval names, or the applicant when it names nobody.
 *
 * The other half of `primaryBorrower`: that one is the guess a route makes
 * when nothing said whose data this is, and this is how a caller says. A
 * tax-transcript pull is one taxpayer's, so the route that makes one takes a
 * borrower id and resolves it here — and an id that is not on this file is a
 * 404 rather than a 403, the same rule `assertFileAccess` keeps, because a 403
 * confirms the borrower exists somewhere.
 *
 * For a RETRIEVAL and not for a signature. Naming whose data to fetch is a
 * question the token then answers — the adapter refuses anything pulled under
 * a grant that person did not make — but naming whose signature to record
 * would be a capability rather than a question, and `signerOn` is the rule
 * there.
 *
 * It resolves against `file.borrowers`, which `loadLoanFile` has already put
 * in document order through `borrower-order.ts`. So a route that names a
 * borrower and a route that names none are reading the same list, and the
 * default is Borrower 1 as the submission means it rather than the oldest row.
 */
export function namedBorrower(file: LoanFile, borrowerId: string | undefined): Borrower {
  if (!borrowerId) return primaryBorrower(file);
  const named = file.borrowers.find((b) => b.id === borrowerId);
  if (!named) throw new AppError(404, "That borrower is not on this file.", "NOT_FOUND");
  return named;
}

/**
 * The borrower a retrieval this request triggers is about.
 *
 * `namedBorrower` when the request says whose, and otherwise the requester's
 * OWN row, resolved by party. Which is the difference between a pull about the
 * person who pressed the button and a pull about whoever holds ordinal 1: on a
 * file whose Borrower 1 has been replaced they are two people, and the
 * connector screens post no borrower id at all. Defaulting to the first row
 * refused the borrower who had signed here — her own screen told her we needed
 * a signature she had already given — and pulled a credit report, an asset
 * report and a payroll record about the other person, under a grant they had
 * signed on a different application. A retrieval a borrower triggers from
 * their own screen is about them.
 *
 * A requester who is not a borrower here has nothing of their own to fetch, so
 * the subject falls back to the applicant. Nothing in the flow builds that
 * shape — the owner is the person screen 2 wrote a row for — and a file with
 * no borrower row at all raises the 409 that says there is nobody to pull
 * about. `tokenFor` still has to find a signature of theirs on this file
 * either way, so the fallback names a subject rather than granting one.
 */
export async function retrievalSubject(
  file: LoanFile,
  userId: string,
  borrowerId?: string,
  db: Db = prisma,
): Promise<Borrower> {
  if (borrowerId) return namedBorrower(file, borrowerId);
  const partyId = await partyForUser(db, userId);
  return file.borrowers.find((b) => b.partyId === partyId) ?? primaryBorrower(file);
}

/**
 * The borrower on this file whose signature this request may make: the
 * requester's own row, and nobody else's.
 *
 * A signature is an act, not a lookup. The applicant owns a joint file and
 * holds the only session on it, so a route that let a request say whose
 * signature it was recording would let them sign the co-borrower's Form
 * 4506-C — a federal tax authorization, executed by somebody who is not the
 * taxpayer. `du_declarations_are_self_attested` makes the same refusal about
 * Section 5 and for the same reason; this is that rule where the signatures
 * are taken.
 *
 * Resolved by PARTY rather than by position, which is the difference on a file
 * whose Borrower 1 has been replaced: the person signed in is still a borrower
 * there, just not the first one, and signing as `borrowers[0]` would take
 * their signature and file it under the name of whoever now holds ordinal 1.
 *
 * `partyForUser` mints the party on first use, so a signed-in person always
 * has one to compare against; what they may not have is a borrower row on this
 * file, and that is a 409 rather than a 403 — nothing was refused, there is
 * simply nothing here for them to sign.
 */
export async function signerOn(file: LoanFile, userId: string, db: Db = prisma): Promise<Borrower> {
  const partyId = await partyForUser(db, userId);
  const mine = file.borrowers.find((b) => b.partyId === partyId);
  if (!mine) {
    throw new AppError(
      409,
      "You are not a borrower on this file, so there is nothing here for you to sign.",
      "NOT_A_BORROWER",
    );
  }
  return mine;
}

/**
 * The same rule, where the signer is already known by party.
 *
 * The e-sign completion resolves its borrower from the envelope rather than
 * from the request, and the consent route is handed a borrower id outright.
 * Both are recording a signature, so both ask this.
 */
export async function assertSignsForThemselves(
  userId: string,
  signerPartyId: string,
  db: Db = prisma,
): Promise<void> {
  const partyId = await partyForUser(db, userId);
  if (partyId !== signerPartyId) {
    throw new AppError(
      403,
      "A signature is the borrower's own, so we cannot record one for somebody else.",
      "NOT_THE_SIGNER",
    );
  }
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
 * Permission to retrieve `category` about one named borrower, on one file.
 *
 * Throws `AuthorizationError` (403, carrying the requirement id the client
 * routes on) when the permission is missing, revoked, expired, for something
 * else, or signed somewhere other than here.
 *
 * Reads the grants through the caller's client, so a grant the consent
 * trigger mirrored a moment ago in the same transaction is visible to the
 * mint. Still the only minter.
 *
 * TWO refusals, and both must pass. The grant is asked about first because it
 * is the one that can say HOW the permission fails — never granted, revoked,
 * lapsed — and a borrower whose signature on this file has merely expired has
 * to be told that rather than told they never signed here, since the screen
 * that renews it is the one that sentence would send them away from. Then this
 * file's own signature, because a grant outlives the application it was signed
 * on and belongs to the person rather than to the request: read by party alone
 * it is one person's permission everywhere for 120 days, which is how a
 * co-borrower's federal tax transcripts came to be pulled onto a joint file
 * they had signed nothing on. `signedOnFor` asks only about the row, which is
 * what the engine reads too, so `evaluateSatisfaction` and this agree about
 * the same file rather than disagreeing out loud.
 *
 * One borrower's grants can never mint another's token either: the party
 * filter is the subject's own id, and `mintPurposeToken` filters the rows
 * again. Two people on one file are two authorizations, and neither stands in
 * for the other.
 */
export async function tokenFor(
  file: LoanFile,
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
  if (!result.ok) {
    throw new AuthorizationError(
      `No authorization to retrieve ${category} for this borrower: ${result.message}. ` +
        "No credit, income, employment or asset data may be pulled.",
      REQUIREMENT_FOR[category],
    );
  }

  const signed = await signedOnFor(file.id, subject.partyId, upper(PURPOSE_FOR[category]), db);
  if (!signed) {
    throw new AuthorizationError(
      `No authorization on this application to retrieve ${category} for this borrower. ` +
        "A signature made elsewhere authorizes nothing here. " +
        "No credit, income, employment or asset data may be pulled.",
      REQUIREMENT_FOR[category],
    );
  }
  return result.token;
}
