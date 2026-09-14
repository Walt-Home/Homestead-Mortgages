/**
 * Whether a file already carries a signature, judged the one way that agrees
 * with everything else that reads it.
 *
 * Two tables have an opinion. The requirements engine satisfies APP-005 and
 * INC-008 from THIS FILE's consent rows (`satisfaction.ts`, `hasConsent`), and
 * the minter grants a retrieval from the PARTY's authorizations, which a
 * consent mirrors to by trigger and which expire after 120 days. Judging
 * "already signed" from either alone is wrong in a different direction. The
 * row alone said signed on a file whose grant had lapsed, so nothing ever
 * renewed it and the party had no way back in. The grant alone said signed on
 * a borrower's second file within 120 days, so that file never got a row, the
 * engine never saw the signature, and the sign button reported success while
 * the requirement stayed outstanding.
 *
 * So a file is signed for a kind only when it holds a live row of that kind
 * AND the party holds a live grant for the purpose the kind mirrors to.
 * Anything else proceeds to sign and writes this file's row, and the trigger
 * does the rest: it retires a lapsed grant and mints a fresh one, or does
 * nothing against a grant that is still live. Both are the right answer, and
 * the route does not need to know which it got.
 *
 * Both halves are read about ONE PERSON. The row half asked only whether the
 * FILE held a row of the kind, which on a file with one borrower is the same
 * question and on a file with two is not — and the grant half hid it, because
 * the person the wrong row was answered for usually held no grant either, so
 * the answer came out right for the wrong reason. It stops coming out right
 * the moment that person does hold one. A co-borrower who signed an earlier
 * file within 120 days, on a file where only the applicant has signed, is told
 * this file already carries their signature: no row of theirs is ever written,
 * the engine goes on reporting APP-005 outstanding, and the one control that
 * would fix it reports success every time it is pressed. A signature is one
 * person's act, and every question about it is asked with that person's name
 * in it.
 */

import { prisma, type AuthorizationPurpose } from "@hm/db";
import type { Db } from "./db.js";
import { liveGrant } from "./party.js";

/**
 * The grant each consent kind mirrors to — the trigger's CASE, in the same
 * words. A kind absent here mirrors to nothing, and its file row is the whole
 * record.
 */
const PURPOSE_FOR_KIND: Readonly<Partial<Record<string, AuthorizationPurpose>>> = {
  verification_authorization: "FCRA_WRITTEN_INSTRUCTION",
  form_4506c: "IRS_4506C",
  persistent_monitoring: "FCRA_ACCOUNT_REVIEW",
};

export interface SignedRecord {
  readonly id: string;
  readonly kind: string;
  readonly grantedAt: Date;
}

/**
 * The live row of `kind` this party signed on this file, and nothing about
 * whether their permission still stands.
 *
 * The signature half on its own, because the two readers below want it at
 * different strengths and a single answer that folded the grant in was wrong
 * for one of them.
 */
async function rowOn(
  loanFileId: string,
  partyId: string,
  kind: string,
  db: Db,
): Promise<SignedRecord | null> {
  return db.consent.findFirst({
    where: { loanFileId, kind, revokedAt: null, borrower: { partyId } },
    orderBy: { grantedAt: "desc" },
    select: { id: true, kind: true, grantedAt: true },
  });
}

/**
 * The consent row that makes `kind` already signed BY THIS PARTY on this file,
 * or null when signing should proceed. Null covers four cases on purpose: no
 * row of the kind on this file, a row of it signed by somebody else, a row
 * whose mirrored grant has lapsed, and a row whose grant was revoked. Each of
 * them is fixed by the same thing — this person signing.
 */
export async function signedOn(
  loanFileId: string,
  partyId: string,
  kind: string,
  db: Db = prisma,
): Promise<SignedRecord | null> {
  const row = await rowOn(loanFileId, partyId, kind, db);
  if (!row) return null;

  const purpose = PURPOSE_FOR_KIND[kind];
  if (!purpose) return row;

  const grant = await liveGrant(db, partyId, purpose);
  return grant ? row : null;
}

/**
 * The same question asked by PURPOSE rather than by kind: does this party hold
 * a live signature ON THIS FILE that licenses `purpose`?
 *
 * The minter asks it. A grant is one person's permission everywhere and lives
 * 120 days, so reading `authorizations` alone answered "yes" for a borrower
 * whose only signature was on somebody else's application — and with a named
 * retrieval subject that is the applicant pulling a co-borrower's federal tax
 * transcripts onto this file on a 4506-C signed for another one. The file's
 * own row is what scopes it, which is also the thing the engine reads: with
 * this, `evaluateSatisfaction` and the route agree about the same file.
 *
 * The ROW alone, unlike `signedOn` above, because the minter has already
 * settled the grant by the time it asks this — that is its first question, and
 * the one that can say whether a permission was never given, revoked or merely
 * lapsed. Asking again here would be a second query for an answer already in
 * hand, and it would put the two halves of one refusal in two places.
 *
 * `PURPOSE_FOR_KIND` read backwards, so there is still one table of which
 * signature mints which permission. A purpose no consent kind mirrors to has
 * no signature that licenses it and comes back null, which is the truthful
 * answer rather than a permissive default.
 */
export async function signedOnFor(
  loanFileId: string,
  partyId: string,
  purpose: AuthorizationPurpose,
  db: Db = prisma,
): Promise<SignedRecord | null> {
  for (const [kind, mirrorsTo] of Object.entries(PURPOSE_FOR_KIND)) {
    if (mirrorsTo !== purpose) continue;
    const row = await rowOn(loanFileId, partyId, kind, db);
    if (row) return row;
  }
  return null;
}
