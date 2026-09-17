/**
 * How a named co-borrower is reached, and how they arrive.
 *
 * The applicant names a person; this is the link that person follows. An
 * invitation is a token that exists in exactly one place — the emailed URL —
 * and a row holding its hash, the address it went to, and when it stops
 * being good. Nothing here logs the token, returns it, or keeps it: a copy
 * of the database is not a way in, and neither is a log.
 *
 * Arriving is a merge, not a flip. The named person is a PROVISIONAL party
 * the applicant asserted two facts about, and the trigger lets such a party
 * go to CLAIM_PENDING or MERGED and nowhere else. So the person signs in —
 * with Google, the only way in — which finds or mints THEIR party, CLAIMED,
 * and the named party folds into it: the borrower row, the membership and
 * everything hanging off them move to the survivor in one transaction. The
 * survivor then has a name and an email under the applicant's principal and
 * nothing else, and stays listed as invited until they have said who they
 * are on a screen of their own.
 *
 * Never an email match at sign-in. The address the applicant typed is where
 * the link was sent, not who may take it: whoever holds the link is whoever
 * the applicant's email reached, which is the same trust the link itself
 * carries, and a stricter rule would refuse a person whose Google account is
 * not the address their partner had for them. `docs/states.md` says the same
 * of the Grander claim, for the same reason.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@hm/db";
import type { MailConnector } from "@hm/connectors";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { primaryBorrowerRow } from "./borrower-order.js";
import { ownsTransaction, type Db } from "./db.js";
import { assertFacts, mergePartyInto, partyForUser, principalForParty } from "./party.js";
import { recordEvent } from "./repository.js";

/** Seven days. Long enough to be found in an inbox; short enough to be dead by the time a file is. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Base64url of 32 random bytes: 256 bits, and safe in a URL without escaping. */
export function mintInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The URL in the email. The token rides in the FRAGMENT: a browser never
 * sends the part after `#` to a server, so it reaches neither our request
 * logs nor the platform's, which record every path. As a path segment it
 * was written to both on every open, and a log is not where a bearer secret
 * belongs. The page reads it off `location.hash` and posts it in a body.
 */
export function claimUrl(token: string): string {
  return `${config.publicOrigin.replace(/\/$/, "")}/claim#${token}`;
}

/** What the email says. Plain text, one link, no names the recipient did not already know. */
export function invitationMessage(input: {
  readonly to: string;
  readonly coBorrowerFirstName: string;
  readonly applicantName: string;
  readonly link: string;
  readonly expiresAt: Date;
}) {
  const until = input.expiresAt.toISOString().slice(0, 10);
  return {
    to: input.to,
    subject: `${input.applicantName} added you to a mortgage application`,
    text: [
      `Hi ${input.coBorrowerFirstName},`,
      "",
      `${input.applicantName} is applying for a mortgage with Supermortgage and named you as a co-borrower.`,
      "You complete your own part — your details and your permissions stay yours, and",
      `${input.applicantName} does not see them.`,
      "",
      "Start here:",
      input.link,
      "",
      `This link is good until ${until} and works once. If you were not expecting it, ignore it and nothing happens.`,
    ].join("\n"),
  };
}

export interface Invited {
  readonly invitationId: string;
  readonly sentTo: string;
  readonly expiresAt: string;
  /**
   * The link, ONLY where developer sign-in is available — no OAuth client and
   * not production, the exact gate `/auth/developer` sits behind. That is the
   * one environment with no email to open, and the same one where a session
   * can be had for the asking anyway. Absent everywhere else.
   */
  readonly link?: string;
}

/**
 * Send a named person their link.
 *
 * The applicant's to do, and only while the person has not arrived. A
 * re-send revokes the live invitation and mints another, so an address
 * corrected on the second try leaves the first link dead rather than
 * leaving two ways in. The party moves to CLAIM_PENDING on the first send,
 * which is what the file lists as "invited".
 */
export async function inviteCoBorrower(
  loanFileId: string,
  borrowerId: string,
  mail: MailConnector,
  db: Db = prisma,
): Promise<Invited> {
  const developerEchoAllowed = config.nodeEnv !== "production" && !config.googleClientId;
  if (mail.capabilities.mode === "fixture" && config.nodeEnv === "production") {
    // Saying "we invited them" over a mailer that keeps messages in memory
    // would be the API lying to the applicant. Refuse instead, and say why.
    throw new AppError(
      503,
      "Invitations cannot be sent from this deployment yet.",
      "MAIL_NOT_CONFIGURED",
    );
  }

  const token = mintInvitationToken();
  const tokenHash = hashInvitationToken(token);

  // The row is minted in one boundary and the email goes AFTER it: a send
  // that fails leaves a row and a ledger line saying so, which is what the
  // applicant is told and what a re-send revokes. The boundary is opened
  // here only when the caller brought none — the persona seed walks a whole
  // household inside a single transaction and hands it in, and Prisma cannot
  // nest interactive transactions; inside a caller's boundary the send is
  // inside it too, which for the one such caller is a fixture outbox.
  const minted = ownsTransaction(db)
    ? await prisma.$transaction((tx) => mintInvitation(tx, loanFileId, borrowerId, tokenHash))
    : await mintInvitation(db, loanFileId, borrowerId, tokenHash);

  const link = claimUrl(token);
  const outcome = await mail.send(
    invitationMessage({
      to: minted.email,
      coBorrowerFirstName: minted.coBorrowerFirstName,
      applicantName: minted.applicantName,
      link,
      expiresAt: minted.expiresAt,
    }),
  );
  if (outcome.status === "sent") {
    // "Invited" means the link went. A row minted and never delivered leaves
    // the person named, not invited, and a re-send is what moves them.
    await db.party.updateMany({
      where: { id: minted.partyId, claimStatus: "PROVISIONAL" },
      data: { claimStatus: "CLAIM_PENDING" },
    });
  }
  if (outcome.status !== "sent") {
    // The row exists and the email did not go. Recorded as such, and refused
    // as such — the applicant is told the truth and can try again, which
    // revokes this one.
    await recordEvent(
      loanFileId,
      "co_borrower_invitation_not_delivered",
      "system",
      {
        borrowerId,
        invitationId: minted.invitationId,
        reason: outcome.reason,
      },
      undefined,
      db,
    );
    throw new AppError(502, "We could not send the invitation. Try again.", "MAIL_NOT_DELIVERED");
  }
  await recordEvent(
    loanFileId,
    "co_borrower_invited",
    "borrower",
    {
      borrowerId,
      invitationId: minted.invitationId,
      provider: outcome.provider,
      expiresAt: minted.expiresAt.toISOString(),
    },
    undefined,
    db,
  );
  return {
    invitationId: minted.invitationId,
    sentTo: minted.email,
    expiresAt: minted.expiresAt.toISOString(),
    ...(developerEchoAllowed ? { link } : {}),
  };
}

/**
 * The row, the revocation of the last one, and the party's move to
 * CLAIM_PENDING — everything about an invitation except the email. Returns
 * what the email needs, so the send can happen after the commit.
 */
async function mintInvitation(tx: Db, loanFileId: string, borrowerId: string, tokenHash: string) {
  const row = await tx.borrower.findFirst({
    where: { id: borrowerId, loanFileId },
    select: {
      id: true,
      partyId: true,
      ssnLast4: true,
      party: { select: { claimStatus: true } },
    },
  });
  if (!row) throw new AppError(404, "That person is not on this file.", "NOT_FOUND");
  const primary = await primaryBorrowerRow(tx, loanFileId);
  if (!primary) throw new AppError(409, "Tell us who you are first.", "NO_BORROWER");
  if (primary.id === row.id) {
    throw new AppError(
      409,
      "You are the applicant; there is nobody to invite here.",
      "APPLICANT_STAYS",
    );
  }
  if (row.party.claimStatus === "CLAIMED" || row.party.claimStatus === "MERGED") {
    throw new AppError(409, "They have already signed in.", "CO_BORROWER_ARRIVED");
  }
  // A person whose identity was stated on their behalf — the paper joint
  // URLA, `appendCoBorrowerWithFacts` — is not somebody to invite: a claim
  // would merge that stated identity into a party that carries none of it,
  // and every read of the file would then throw on the hole.
  if (row.ssnLast4 !== null) {
    throw new AppError(
      409,
      "Their details were stated on this application already; there is nothing to invite them to.",
      "IDENTITY_ALREADY_STATED",
    );
  }

  // The two things the applicant said about them, which are the two things
  // the email needs.
  const facts = await tx.fact.findMany({
    where: {
      partyId: row.partyId,
      predicate: { in: ["legal_name", "email"] },
      supersededById: null,
      retractedAt: null,
    },
    select: { predicate: true, value: true },
  });
  const name = (facts.find((f) => f.predicate === "legal_name")?.value ?? {}) as {
    first?: string;
    last?: string;
  };
  const email = facts.find((f) => f.predicate === "email")?.value;
  if (typeof email !== "string" || !email) {
    throw new AppError(409, "There is no email on file for them.", "NO_EMAIL");
  }
  const applicantName = await tx.fact.findFirst({
    where: {
      partyId: primary.partyId,
      predicate: "legal_name",
      supersededById: null,
      retractedAt: null,
    },
    select: { value: true },
  });
  const applicant = (applicantName?.value ?? {}) as { first?: string; last?: string };

  // Dead before the new one is live, so the partial unique index never sees two.
  await tx.coBorrowerInvitation.updateMany({
    where: { borrowerId: row.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const invitation = await tx.coBorrowerInvitation.create({
    data: {
      loanFileId,
      borrowerId: row.id,
      partyId: row.partyId,
      tokenHash,
      sentToEmail: email,
      invitedByPrincipalId: await principalForParty(tx, primary.partyId),
      expiresAt,
    },
    select: { id: true },
  });
  return {
    invitationId: invitation.id,
    partyId: row.partyId,
    email,
    expiresAt,
    coBorrowerFirstName: name.first ?? "",
    applicantName: `${applicant.first ?? ""} ${applicant.last ?? ""}`.trim() || "Your co-applicant",
  };
}

/** What a stranger holding a link is shown before signing in. No ids. */
export interface ClaimPreview {
  readonly coBorrowerFirstName: string;
  readonly applicantFirstName: string;
  readonly propertyCity: string | null;
  readonly expiresAt: string;
}

async function liveInvitation(db: Db, token: string) {
  return db.coBorrowerInvitation.findFirst({
    where: {
      tokenHash: hashInvitationToken(token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      loanFileId: true,
      borrowerId: true,
      partyId: true,
      loanFile: { select: { propertyCity: true } },
    },
  });
}

/**
 * Look a link up. Null for anything that is not a live invitation — unknown,
 * expired, revoked, already taken — and the route answers all four the same
 * way, because which of them it was is information about a file the holder
 * has not proven anything about.
 */
export async function previewClaim(token: string, db: Db = prisma): Promise<ClaimPreview | null> {
  const invitation = await liveInvitation(db, token);
  if (!invitation) return null;
  const primary = await primaryBorrowerRow(db, invitation.loanFileId);
  const names = await db.fact.findMany({
    where: {
      partyId: { in: [invitation.partyId, ...(primary ? [primary.partyId] : [])] },
      predicate: "legal_name",
      supersededById: null,
      retractedAt: null,
    },
    select: { partyId: true, value: true },
  });
  const first = (partyId: string) =>
    ((names.find((n) => n.partyId === partyId)?.value ?? {}) as { first?: string }).first ?? "";
  const row = await db.coBorrowerInvitation.findUniqueOrThrow({
    where: { id: invitation.id },
    select: { expiresAt: true },
  });
  return {
    coBorrowerFirstName: first(invitation.partyId),
    applicantFirstName: primary ? first(primary.partyId) : "",
    propertyCity: invitation.loanFile.propertyCity ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface Claimed {
  readonly loanFileId: string;
  readonly borrowerId: string;
}

/**
 * Take the invitation, as the person signed in.
 *
 * One transaction: the link is re-checked under a lock, the claimant's own
 * party is found or minted CLAIMED, the named party folds into it, the two
 * facts the applicant stated are restated on the survivor under the same
 * principal so the name does not vanish behind the merge pointer, and the
 * invitation is marked taken by whom. A second press finds no live
 * invitation and is refused like any other dead link.
 */
export async function acceptClaim(
  token: string,
  userId: string,
  db: Db = prisma,
): Promise<Claimed> {
  // The lock below needs a transaction around it, and there is one either
  // way: opened here when the caller brought none, or the caller's own —
  // the persona seed claims inside the transaction that walks the household,
  // and Prisma cannot nest interactive transactions. Same idiom as
  // `recordDeclaration`.
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => acceptClaim(token, userId, tx));
  }
  const [locked] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM co_borrower_invitations
     WHERE token_hash = ${hashInvitationToken(token)}
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     FOR UPDATE`;
  const invitation = locked ? await liveInvitation(db, token) : null;
  if (!invitation) throw new AppError(404, "That link is not good any more.", "NOT_FOUND");

  const claimant = await partyForUser(db, userId);
  if (claimant === invitation.partyId) {
    throw new AppError(409, "This invitation is for somebody else.", "NOT_YOURS");
  }
  // The applicant taking their own co-borrower's link, or a person already
  // on this file twice over. One person holds one role on one mortgage.
  const already = await db.borrower.findFirst({
    where: { loanFileId: invitation.loanFileId, partyId: claimant },
    select: { id: true },
  });
  if (already) {
    throw new AppError(409, "You are already on this application.", "ALREADY_ON_FILE");
  }

  const stated = await db.fact.findMany({
    where: {
      partyId: invitation.partyId,
      predicate: { in: ["legal_name", "email"] },
      supersededById: null,
      retractedAt: null,
    },
    select: { predicate: true, value: true, assertedByPrincipalId: true },
  });

  await mergePartyInto(db, invitation.partyId, claimant);

  // Restated on the survivor, under the principal that stated them — the
  // applicant's — and only where the survivor has nothing of its own. A
  // person who already had a legal name on their party keeps it; the
  // co-borrower's own screen 2 supersedes either.
  for (const fact of stated) {
    const own = await db.fact.findFirst({
      where: {
        partyId: claimant,
        predicate: fact.predicate,
        supersededById: null,
        retractedAt: null,
      },
      select: { id: true },
    });
    if (own) continue;
    await assertFacts(db, claimant, fact.assertedByPrincipalId, [
      { predicate: fact.predicate, value: fact.value as never },
    ]);
  }

  await db.coBorrowerInvitation.update({
    where: { id: invitation.id },
    data: { acceptedAt: new Date(), acceptedByPartyId: claimant },
  });
  await recordEvent(
    invitation.loanFileId,
    "co_borrower_claimed",
    "borrower",
    { borrowerId: invitation.borrowerId },
    undefined,
    db,
  );
  return { loanFileId: invitation.loanFileId, borrowerId: invitation.borrowerId };
}
