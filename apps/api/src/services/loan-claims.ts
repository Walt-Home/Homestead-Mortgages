/**
 * How a mortgage a tape wrote becomes somebody's.
 *
 * The tape makes an `imported_unclaimed` loan on a PROVISIONAL party and
 * carries no email, so nothing can match a sign-in to it and nothing should:
 * a loan appearing in an account without a claim is the oracle the 404 rule
 * suppresses. What makes it somebody's is a token — minted here through the
 * partner's key for one loan, delivered by the servicer over its own channel
 * to the person its records say the loan belongs to, and taken by whoever
 * holds it after signing in with the only sign-in there is.
 *
 * Taking it is a merge and a move, in one transaction. The claimant's own
 * party is found or minted CLAIMED, the tape's provisional party folds into
 * it through the merge the co-borrower claim uses (the loan follows the
 * party), the loan moves `imported_unclaimed → monitoring_only` as
 * `claim_confirmed` under the claim flow's principal with the claim row
 * naming who took it, and the review turns on — the one move a person
 * causes on a loan, and the one the database refuses to let happen any
 * other way.
 *
 * The token exists in the link and here as its hash, like an invitation's.
 * Good once and for thirty days; a second mint for the same loan revokes the
 * first, so a servicer that re-sends has one live link out. Nothing here
 * logs the token, keeps it, or returns it twice.
 *
 * What the link shows a stranger is what the servicer's own notice already
 * said: which servicer, and the city. Never the loan number and never a
 * name — his invitation names the servicer and the loan's last four before
 * anyone has proven anything, and that is the design this one refuses.
 */

import { prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { ownsTransaction, type Db } from "./db.js";
import { claimUrl, hashInvitationToken, mintInvitationToken } from "./invitations.js";
import { moveLoanIfLegal, toDomainLoanState } from "./loan-transition.js";
import { mergePartyInto, partyForUser, servicePrincipal } from "./party.js";
import { deliverOpenOffer } from "./refi-offers.js";

/** Thirty days: a servicer's notice is read on a statement's cadence, not an inbox's. */
export const LOAN_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface MintedLoanClaim {
  readonly loanId: string;
  /** The token, once. The servicer delivers it; we never see it again. */
  readonly token: string;
  readonly link: string;
  readonly expiresAt: string;
}

/**
 * Mint a claim for one loan, as the partner whose tape wrote it.
 *
 * Refused for a loan that is not this servicer's (404, the same answer as a
 * loan that does not exist), one that is no longer unclaimed (409 — claimed
 * already, or ended before anyone claimed it, which the machine makes
 * final), and one whose party is somehow already somebody's (409).
 */
export async function mintLoanClaim(
  input: {
    readonly servicerId: string;
    readonly servicerLoanNumber: string;
    readonly principalId: string;
  },
  db: Db = prisma,
): Promise<MintedLoanClaim> {
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => mintLoanClaim(input, tx));
  }
  const loan = await db.loan.findFirst({
    where: { servicerId: input.servicerId, servicerLoanNumber: input.servicerLoanNumber },
    select: {
      id: true,
      status: true,
      parties: {
        where: { role: "PRIMARY_BORROWER" },
        select: { partyId: true, party: { select: { claimStatus: true } } },
        take: 1,
      },
    },
  });
  if (!loan) throw new AppError(404, "Loan not found", "NOT_FOUND");
  if (toDomainLoanState(loan.status) !== "imported_unclaimed") {
    throw new AppError(409, "This loan is not waiting to be claimed.", "NOT_CLAIMABLE");
  }
  const named = loan.parties[0];
  if (!named) throw new AppError(409, "This loan has nobody to claim it.", "NOT_CLAIMABLE");
  if (named.party.claimStatus === "CLAIMED" || named.party.claimStatus === "MERGED") {
    throw new AppError(409, "This loan has already been claimed.", "ALREADY_CLAIMED");
  }

  // One live link out. The last one is revoked rather than left good, so a
  // servicer that re-sends is not leaving two ways in.
  await db.loanClaim.updateMany({
    where: { loanId: loan.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const token = mintInvitationToken();
  const expiresAt = new Date(Date.now() + LOAN_CLAIM_TTL_MS);
  await db.loanClaim.create({
    data: {
      loanId: loan.id,
      partyId: named.partyId,
      tokenHash: hashInvitationToken(token),
      issuedByPrincipalId: input.principalId,
      expiresAt,
    },
  });
  if (named.party.claimStatus === "PROVISIONAL") {
    await db.party.update({ where: { id: named.partyId }, data: { claimStatus: "CLAIM_PENDING" } });
  }
  return { loanId: loan.id, token, link: claimUrl(token), expiresAt: expiresAt.toISOString() };
}

export interface LoanClaimPreview {
  readonly kind: "mortgage";
  readonly servicerDisplayName: string | null;
  readonly propertyCity: string | null;
  readonly propertyState: string | null;
  readonly expiresAt: string;
}

/** A live claim's row, or null for every way a link can be bad. */
async function liveClaim(db: Db, token: string) {
  return db.loanClaim.findFirst({
    where: {
      tokenHash: hashInvitationToken(token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      loanId: true,
      partyId: true,
      expiresAt: true,
      loan: {
        select: {
          status: true,
          propertyCity: true,
          propertyState: true,
          servicer: { select: { displayName: true } },
        },
      },
    },
  });
}

/** What a stranger holding the link sees: the servicer and the city, and nothing that names anyone. */
export async function previewLoanClaim(
  token: string,
  db: Db = prisma,
): Promise<LoanClaimPreview | null> {
  const row = await liveClaim(db, token);
  if (!row || toDomainLoanState(row.loan.status) !== "imported_unclaimed") return null;
  return {
    kind: "mortgage",
    servicerDisplayName: row.loan.servicer?.displayName ?? null,
    propertyCity: row.loan.propertyCity,
    propertyState: row.loan.propertyState,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface ClaimedLoan {
  readonly kind: "mortgage";
  readonly loanId: string;
}

/**
 * Take the claim, as the person signed in.
 *
 * One transaction: the link is re-checked under a lock, the loan is checked
 * to be still unclaimed (it can end before anyone claims it, and then it can
 * never be claimed), the claimant's party is found or minted CLAIMED, the
 * tape's party folds into it, the loan moves, the review turns on, and the
 * claim is marked taken by whom. A second press finds no live claim and is
 * refused like any other dead link.
 */
export async function acceptLoanClaim(
  token: string,
  userId: string,
  db: Db = prisma,
): Promise<ClaimedLoan> {
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => acceptLoanClaim(token, userId, tx));
  }
  const [locked] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM loan_claims
     WHERE token_hash = ${hashInvitationToken(token)}
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     FOR UPDATE`;
  const claim = locked ? await liveClaim(db, token) : null;
  if (!claim) throw new AppError(404, "That link is not good any more.", "NOT_FOUND");
  if (toDomainLoanState(claim.loan.status) !== "imported_unclaimed") {
    throw new AppError(409, "This mortgage can no longer be claimed.", "NOT_CLAIMABLE");
  }

  const claimant = await partyForUser(db, userId);
  if (claimant === claim.partyId) {
    throw new AppError(409, "This link is for somebody else.", "NOT_YOURS");
  }
  const already = await db.loanParty.findFirst({
    where: { loanId: claim.loanId, partyId: claimant },
    select: { id: true },
  });
  if (already) throw new AppError(409, "This mortgage is already yours.", "ALREADY_YOURS");

  await mergePartyInto(db, claim.partyId, claimant);
  // Under the claim flow's own principal, not the claimant's: a loan outlives
  // its parties, and the ledger refuses a principal that dies with one. Who
  // took it is on the claim row the `causedBy` names.
  const moved = await moveLoanIfLegal(
    {
      id: claim.loanId,
      event: "borrower_claimed",
      actorPrincipalId: await servicePrincipal(db, "claim_flow"),
      reasonCode: "claim_confirmed",
      causedBy: `loan_claim:${claim.id}`,
    },
    db,
  );
  if ("skipped" in moved) {
    throw new AppError(409, "This mortgage can no longer be claimed.", "NOT_CLAIMABLE");
  }
  // The review has been on since the book was loaded; the claim is the door.
  // What it opens: the offer the review made while nobody could see it is
  // delivered now, and its thirty days start today. The review is due again
  // tomorrow either way.
  const now = new Date();
  await db.loan.update({
    where: { id: claim.loanId },
    data: { monitoringEnabled: true, nextReviewDueAt: now },
  });
  await deliverOpenOffer(db, claim.loanId, now);
  await db.loanClaim.update({
    where: { id: claim.id },
    data: { acceptedAt: now, acceptedByPartyId: claimant },
  });
  return { kind: "mortgage", loanId: claim.loanId };
}

/** Which door a token opens: a co-borrower's invitation or a mortgage's claim. Null for neither. */
export async function claimKindOf(
  token: string,
  db: Db = prisma,
): Promise<"mortgage" | "co_borrower" | null> {
  const hash = hashInvitationToken(token);
  if (await db.loanClaim.findUnique({ where: { tokenHash: hash }, select: { id: true } })) {
    return "mortgage";
  }
  if (
    await db.coBorrowerInvitation.findUnique({ where: { tokenHash: hash }, select: { id: true } })
  ) {
    return "co_borrower";
  }
  return null;
}
