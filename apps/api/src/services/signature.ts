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
 */

import { prisma, type AuthorizationPurpose } from "@hm/db";

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
 * The consent row that makes `kind` already signed on this file, or null when
 * signing should proceed. Null covers three cases on purpose: no row on this
 * file, a row whose mirrored grant has lapsed, and a row whose grant was
 * revoked. Each of them is fixed by the same thing — a new signature.
 */
export async function signedOn(
  loanFileId: string,
  partyId: string,
  kind: string,
): Promise<SignedRecord | null> {
  const row = await prisma.consent.findFirst({
    where: { loanFileId, kind, revokedAt: null },
    orderBy: { grantedAt: "desc" },
    select: { id: true, kind: true, grantedAt: true },
  });
  if (!row) return null;

  const purpose = PURPOSE_FOR_KIND[kind];
  if (!purpose) return row;

  const grant = await prisma.authorization.findFirst({
    where: { partyId, purpose, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return grant ? row : null;
}
