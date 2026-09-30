/**
 * A servicer's team: who they are, how they are invited, how they sign in.
 *
 * Ops invites a servicer's people from the tape desk. Each invitation is a
 * token that exists in exactly one place — the mailed link — and a row
 * holding its hash; taking it is what sets the password. From then on a
 * sign-in is two factors, always: a six-digit code to the address on the
 * row (possession) and the password (knowledge). A code alone opens nothing
 * and a password alone opens nothing, which is the pattern the servicing
 * app's own staff door keeps and the Safeguards Rule asks for.
 *
 * What is deliberately simple, for now: one address belongs to one
 * servicer; there are no roles, every member sees the servicer's whole book
 * and changes nothing but its team — a member invites colleagues as ops
 * does, and removes one, though never themselves. Each of those is a
 * column away when it is wanted.
 *
 * Existence is not a signal. Asking for a code answers the same for an
 * address that is not on any team, and a wrong code and a dead code answer
 * alike. The one exception is deliberate: where the mailer is a stand-in,
 * the code is echoed so the flow can be walked at all, and it is echoed
 * only for an address that was invited — the same shape the servicing
 * app's door has on a fake mailer.
 */

import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { prisma, Prisma } from "@hm/db";
import type { ServicerUser } from "@hm/db";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { connectors } from "./connectors.js";
import { ownsTransaction, type Db } from "./db.js";
import { hashInvitationToken, mintInvitationToken } from "./invitations.js";
import { reasonsInWords } from "@hm/refi-review";
import { listPartnerBookImports, partnerBookStatus } from "./partner-book.js";
import { toDomainLoanState } from "./loan-transition.js";
import { dayEt, offerStanding } from "./refi-offers.js";

const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCallback(password, salt, keyLength, cost, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** Seven days: long enough to be found in an inbox, short enough to be dead by the time it is forwarded. */
export const SERVICER_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Ten minutes, one sign-in. */
export const SIGN_IN_CODE_TTL_MS = 10 * 60 * 1000;
export const SIGN_IN_CODE_ATTEMPTS = 5;
export const PASSWORD_MIN_LENGTH = 12;
/** Five wrong passwords within an hour lock the account for fifteen minutes. */
export const PASSWORD_ATTEMPTS = 5;
export const PASSWORD_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ── passwords ─────────────────────────────────────────────────────────────── */

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertPasswordStrength(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(422, `Use at least ${PASSWORD_MIN_LENGTH} characters.`, "PASSWORD_WEAK");
  }
}

/* ── mail ──────────────────────────────────────────────────────────────────── */

/** The link in the invitation. The token rides in the fragment, as a claim's does: a fragment never reaches a request log. */
export function servicerInvitationUrl(token: string): string {
  return `${config.servicing.consoleOrigin}/console/accept#${token}`;
}

export function servicerInvitationMessage(input: {
  readonly to: string;
  readonly name: string | null;
  readonly servicerName: string;
  readonly link: string;
  readonly expiresAt: Date;
}) {
  const until = input.expiresAt.toISOString().slice(0, 10);
  return {
    to: input.to,
    subject: `${input.servicerName}'s book on Supermortgage`,
    text: [
      `Hi${input.name ? ` ${input.name}` : ""},`,
      "",
      `Supermortgage watches ${input.servicerName}'s loans for a better rate and tells each homeowner when one is worth a look. This is your sign-in to see that book: every loan, what the daily review found, and where each homeowner's invitation stands.`,
      "",
      "Set your password here:",
      input.link,
      "",
      `The link works once and is good until ${until}. Signing in after that is a code to this address and your password.`,
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

export function signInCodeMessage(input: { readonly to: string; readonly code: string }) {
  return {
    to: input.to,
    subject: `Your Supermortgage sign-in code: ${input.code}`,
    text: [
      `Your sign-in code is ${input.code}.`,
      "",
      "It is good for ten minutes and one sign-in. If you did not ask for it, ignore this message; nobody can sign in with the code alone.",
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/** Saying "sent" over a mailer that keeps messages in memory would be lying; on a real deployment the fixture sends nothing. */
function mailIsOff(): boolean {
  return connectors().mail.capabilities.mode === "fixture" && config.nodeEnv === "production";
}

/** Where the mailer is a stand-in and this is not a real deployment, the code is shown instead of sent. */
function codeEchoAllowed(): boolean {
  return (
    connectors().mail.capabilities.mode === "fixture" &&
    (config.nodeEnv !== "production" || config.demoPersonasEnabled)
  );
}

/* ── the team ──────────────────────────────────────────────────────────────── */

export type TeamInvitationOutcome =
  | { readonly email: string; readonly status: "sent"; readonly expiresAt: string }
  | {
      readonly email: string;
      readonly status: "not_delivered";
      readonly reason: string;
      readonly link: string;
      readonly expiresAt: string;
    }
  | { readonly email: string; readonly status: "already_member" }
  | { readonly email: string; readonly status: "on_another_team" }
  | { readonly email: string; readonly status: "invalid" };

/**
 * Invite people onto a servicer's team, one outcome per address. A person
 * already invited gets a fresh link and the old one dies; a person who has
 * taken theirs is left alone.
 */
export async function inviteServicerTeam(
  input: {
    readonly servicerSlug: string;
    readonly invitations: readonly { readonly email: string; readonly name?: string | null }[];
    /** Who sent them — a console staff id, or `member:<id>` — recorded, never trusted for anything. */
    readonly invitedBy: string | null;
  },
  db: Db = prisma,
): Promise<readonly TeamInvitationOutcome[]> {
  const servicer = await db.servicer.findUnique({
    where: { slug: input.servicerSlug },
    select: { id: true, displayName: true },
  });
  if (!servicer) throw new AppError(404, "No such servicer.", "NOT_FOUND");
  const mail = connectors().mail;
  const off = mailIsOff();

  const out: TeamInvitationOutcome[] = [];
  const seen = new Set<string>();
  for (const inv of input.invitations) {
    const email = normalizeEmail(inv.email);
    if (!EMAIL.test(email) || seen.has(email)) {
      out.push({ email: inv.email, status: "invalid" });
      continue;
    }
    seen.add(email);
    const existing = await db.servicerUser.findUnique({
      where: { email },
      select: { id: true, servicerId: true, acceptedAt: true, disabledAt: true },
    });
    if (existing && existing.servicerId !== servicer.id) {
      out.push({ email, status: "on_another_team" });
      continue;
    }
    if (existing?.acceptedAt && !existing.disabledAt) {
      out.push({ email, status: "already_member" });
      continue;
    }
    const token = mintInvitationToken();
    const expiresAt = new Date(Date.now() + SERVICER_INVITATION_TTL_MS);
    const name = inv.name?.trim() || null;
    const fields = {
      inviteTokenHash: hashInvitationToken(token),
      inviteExpiresAt: expiresAt,
      invitedAt: new Date(),
      invitedBy: input.invitedBy,
      inviteDeliveredTo: null,
      inviteDeliveredAt: null,
      inviteDelivery: Prisma.JsonNull,
      // A removed member re-invited is a member again once they take it.
      disabledAt: null,
      disabledBy: null,
      acceptedAt: null,
      passwordHash: null,
      ...(name ? { name } : {}),
    };
    const user = existing
      ? await db.servicerUser.update({ where: { id: existing.id }, data: fields })
      : await db.servicerUser.create({ data: { servicerId: servicer.id, email, ...fields } });

    const link = servicerInvitationUrl(token);
    const message = servicerInvitationMessage({
      to: email,
      name: user.name,
      servicerName: servicer.displayName,
      link,
      expiresAt,
    });
    const outcome = off
      ? { status: "not_delivered" as const, reason: "Mail is not configured on this deployment." }
      : await mail.send(message).catch((e: unknown) => ({
          status: "not_delivered" as const,
          reason: e instanceof Error ? e.message : String(e),
        }));
    await db.servicerUser.update({
      where: { id: user.id },
      data: {
        inviteDeliveredTo: email,
        inviteDeliveredAt: outcome.status === "sent" ? new Date() : null,
        inviteDelivery: outcome as unknown as Prisma.InputJsonValue,
      },
    });
    out.push(
      outcome.status === "sent"
        ? { email, status: "sent", expiresAt: expiresAt.toISOString() }
        : {
            email,
            status: "not_delivered",
            reason: outcome.reason,
            link,
            expiresAt: expiresAt.toISOString(),
          },
    );
  }
  return out;
}

export type TeamMemberStanding = "invited" | "active" | "disabled" | "expired";

export interface TeamMember {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly standing: TeamMemberStanding;
  readonly invitedAt: string;
  readonly inviteExpiresAt: string | null;
  readonly inviteDeliveredAt: string | null;
  readonly acceptedAt: string | null;
  readonly lastSignedInAt: string | null;
}

const standingOf = (u: {
  acceptedAt: Date | null;
  disabledAt: Date | null;
  inviteExpiresAt: Date | null;
}): TeamMemberStanding =>
  u.disabledAt
    ? "disabled"
    : u.acceptedAt
      ? "active"
      : u.inviteExpiresAt && u.inviteExpiresAt.getTime() < Date.now()
        ? "expired"
        : "invited";

export async function listServicerTeam(servicerId: string, db: Db = prisma): Promise<TeamMember[]> {
  const rows = await db.servicerUser.findMany({
    where: { servicerId },
    orderBy: [{ acceptedAt: { sort: "asc", nulls: "last" } }, { invitedAt: "asc" }],
  });
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    standing: standingOf(u),
    invitedAt: u.invitedAt.toISOString(),
    inviteExpiresAt: u.inviteExpiresAt?.toISOString() ?? null,
    inviteDeliveredAt: u.inviteDeliveredAt?.toISOString() ?? null,
    acceptedAt: u.acceptedAt?.toISOString() ?? null,
    lastSignedInAt: u.lastSignedInAt?.toISOString() ?? null,
  }));
}

/**
 * Take somebody off a servicer's team. The row stays, marked: their sign-in
 * stops on the next request (`requireServicerUser` reads the mark every
 * time), an invitation not yet taken dies with its link, and a fresh
 * invitation is the way back. Somebody on another servicer's team, or
 * nobody at all, is a 404 — the id is never confirmed to a stranger.
 */
export async function removeServicerMember(
  input: {
    readonly servicerId: string;
    readonly memberId: string;
    /** Who removed them — a console staff id, or `member:<id>` — recorded, never trusted for anything. */
    readonly removedBy: string;
  },
  db: Db = prisma,
): Promise<void> {
  const gone = await db.servicerUser.updateMany({
    where: { id: input.memberId, servicerId: input.servicerId, disabledAt: null },
    data: {
      disabledAt: new Date(),
      disabledBy: input.removedBy,
      inviteTokenHash: null,
      inviteExpiresAt: null,
    },
  });
  if (gone.count === 0) throw new AppError(404, "Nobody by that id on this team.", "NOT_FOUND");
  // A code already mailed opens nothing for them now; spend it anyway.
  await db.servicerSignInCode.updateMany({
    where: { userId: input.memberId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

/* ── the invitation, taken ─────────────────────────────────────────────────── */

export interface ServicerInvitationPreview {
  readonly servicerName: string;
  readonly email: string;
  readonly name: string | null;
  readonly expiresAt: string;
}

async function liveInvitation(db: Db, token: string) {
  return db.servicerUser.findFirst({
    where: {
      inviteTokenHash: hashInvitationToken(token),
      acceptedAt: null,
      disabledAt: null,
      inviteExpiresAt: { gt: new Date() },
    },
    include: { servicer: { select: { displayName: true } } },
  });
}

/** What a stranger holding a link is shown before setting a password. Null for any link that is not live. */
export async function previewServicerInvitation(
  token: string,
  db: Db = prisma,
): Promise<ServicerInvitationPreview | null> {
  const user = await liveInvitation(db, token);
  if (!user) return null;
  return {
    servicerName: user.servicer.displayName,
    email: user.email,
    name: user.name,
    expiresAt: user.inviteExpiresAt!.toISOString(),
  };
}

/** Take the invitation: the link is the first factor, the password just chosen the second. */
export async function acceptServicerInvitation(
  token: string,
  password: string,
  db: Db = prisma,
): Promise<ServicerUser> {
  assertPasswordStrength(password);
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => acceptServicerInvitation(token, password, tx));
  }
  const [locked] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM servicer_users
     WHERE invite_token_hash = ${hashInvitationToken(token)}
       AND accepted_at IS NULL AND disabled_at IS NULL AND invite_expires_at > now()
     FOR UPDATE`;
  const user = locked ? await liveInvitation(db, token) : null;
  if (!user) throw new AppError(404, "That link is not good any more.", "NOT_FOUND");
  return db.servicerUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      acceptedAt: new Date(),
      inviteTokenHash: null,
      inviteExpiresAt: null,
      lastSignedInAt: new Date(),
    },
  });
}

/* ── sign-in ───────────────────────────────────────────────────────────────── */

const codeHash = (userId: string, code: string): string =>
  createHash("sha256").update(`${userId}:${code}`).digest("hex");

async function activeUser(db: Db, email: string) {
  return db.servicerUser.findFirst({
    where: { email: normalizeEmail(email), acceptedAt: { not: null }, disabledAt: null },
  });
}

/**
 * Ask for a code. Answers the same for an address that is nobody's; where
 * the mailer is a stand-in the code comes back in the answer instead, for
 * an invited address only.
 */
export async function requestSignInCode(
  email: string,
  db: Db = prisma,
): Promise<{ readonly fakeCode: string | null }> {
  if (!EMAIL.test(normalizeEmail(email))) {
    throw new AppError(422, "That doesn't look like an e-mail address.", "EMAIL_INVALID");
  }
  const user = await activeUser(db, email);
  if (!user) return { fakeCode: null };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.servicerSignInCode.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await db.servicerSignInCode.create({
    data: {
      userId: user.id,
      codeHash: codeHash(user.id, code),
      expiresAt: new Date(Date.now() + SIGN_IN_CODE_TTL_MS),
    },
  });
  if (!mailIsOff()) {
    await connectors()
      .mail.send(signInCodeMessage({ to: user.email, code }))
      .catch(() => undefined);
  }
  return { fakeCode: codeEchoAllowed() ? code : null };
}

/** The code, checked and spent. A wrong one, a dead one and an unknown address answer alike. */
export async function verifySignInCode(
  email: string,
  code: string,
  db: Db = prisma,
): Promise<ServicerUser> {
  const invalid = () => new AppError(401, "That code didn't match.", "OTP_INVALID");
  const user = await activeUser(db, email);
  if (!user) throw invalid();
  const row = await db.servicerSignInCode.findFirst({
    where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw invalid();
  if (row.attempts >= SIGN_IN_CODE_ATTEMPTS) {
    throw new AppError(429, "Too many tries against that code.", "OTP_TOO_MANY_ATTEMPTS");
  }
  await db.servicerSignInCode.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });
  const expected = Buffer.from(row.codeHash, "hex");
  const actual = Buffer.from(codeHash(user.id, String(code).trim()), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  await db.servicerSignInCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  return user;
}

/** The password, after the code. Five wrong within an hour lock the account for fifteen minutes. */
export async function signInWithPassword(
  userId: string,
  password: string,
  db: Db = prisma,
): Promise<ServicerUser> {
  const user = await db.servicerUser.findFirst({
    where: { id: userId, acceptedAt: { not: null }, disabledAt: null },
  });
  if (!user || !user.passwordHash) {
    throw new AppError(401, "Sign in to continue.", "SIGN_IN_REQUIRED");
  }
  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil.getTime() > now) {
    throw new AppError(
      423,
      "This account is locked after too many wrong answers.",
      "ACCOUNT_LOCKED",
      {
        locked_until: user.lockedUntil.toISOString(),
      },
    );
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const inWindow =
      user.failedPasswordAt && now - user.failedPasswordAt.getTime() < PASSWORD_ATTEMPT_WINDOW_MS;
    const count = (inWindow ? user.failedPasswordCount : 0) + 1;
    const lock = count >= PASSWORD_ATTEMPTS;
    const lockedUntil = lock ? new Date(now + PASSWORD_LOCK_MS) : null;
    await db.servicerUser.update({
      where: { id: user.id },
      data: {
        failedPasswordCount: lock ? 0 : count,
        failedPasswordAt: inWindow ? user.failedPasswordAt : new Date(now),
        lockedUntil,
      },
    });
    throw new AppError(
      401,
      "Wrong password.",
      "PASSWORD_WRONG",
      lockedUntil ? { locked_until: lockedUntil.toISOString() } : undefined,
    );
  }
  return db.servicerUser.update({
    where: { id: user.id },
    data: {
      failedPasswordCount: 0,
      failedPasswordAt: null,
      lockedUntil: null,
      lastSignedInAt: new Date(now),
    },
  });
}

/* ── the book, as the team sees it ─────────────────────────────────────────── */

export async function servicerBook(servicerId: string, db: Db = prisma) {
  const [servicer, book, team] = await Promise.all([
    db.servicer.findUniqueOrThrow({
      where: { id: servicerId },
      select: { slug: true, displayName: true },
    }),
    partnerBookStatus(servicerId, db),
    db.servicerUser.count({ where: { servicerId, acceptedAt: { not: null }, disabledAt: null } }),
  ]);
  return { servicer, book, team: { active: team } };
}

export interface ServicerBookLoan {
  readonly id: string;
  readonly number: string;
  readonly borrower: string | null;
  readonly property: string | null;
  readonly state: string;
  readonly noteRatePct: string;
  readonly balanceCents: string | null;
  readonly review: { readonly verdict: string; readonly asOf: string } | null;
  readonly offer: {
    readonly status: string;
    readonly deliveredAt: string | null;
    readonly validUntil: string | null;
  } | null;
  readonly claim: {
    readonly deliveredTo: string | null;
    readonly deliveredAt: string | null;
    readonly acceptedAt: string | null;
    readonly expiresAt: string;
  } | null;
}

export const SERVICER_BOOK_PAGE = 100;

/** The borrower's name, off the primary party's newest `legal_name` fact. */
const BORROWER_NAME = {
  where: { role: "PRIMARY_BORROWER" },
  take: 1,
  select: {
    party: {
      select: {
        facts: {
          where: { predicate: "legal_name", supersededById: null, retractedAt: null },
          orderBy: { observedAt: "desc" },
          take: 1,
          select: { value: true },
        },
      },
    },
  },
} as const satisfies Prisma.Loan$partiesArgs;

function borrowerName(parties: readonly { party: { facts: { value: unknown }[] } }[]) {
  const name = (parties[0]?.party.facts[0]?.value ?? null) as {
    given?: string;
    first?: string;
    surname?: string;
    last?: string;
  } | null;
  return name
    ? [name.given ?? name.first, name.surname ?? name.last].filter(Boolean).join(" ") || null
    : null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** The servicer's loans, a page at a time, newest review and offer and claim beside each. */
export async function servicerBookLoans(
  servicerId: string,
  opts: { readonly q?: string; readonly offset?: number; readonly limit?: number } = {},
  db: Db = prisma,
): Promise<{ readonly total: number; readonly rows: ServicerBookLoan[] }> {
  const q = opts.q?.trim();
  const where: Prisma.LoanWhereInput = {
    servicerId,
    ...(q
      ? {
          OR: [
            { servicerLoanNumber: { contains: q, mode: "insensitive" } },
            { propertyCity: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, loans] = await Promise.all([
    db.loan.count({ where }),
    db.loan.findMany({
      where,
      orderBy: { servicerLoanNumber: "asc" },
      skip: Math.max(0, opts.offset ?? 0),
      take: Math.min(Math.max(1, opts.limit ?? SERVICER_BOOK_PAGE), SERVICER_BOOK_PAGE),
      select: {
        id: true,
        servicerLoanNumber: true,
        status: true,
        noteRateBps: true,
        propertyCity: true,
        propertyState: true,
        parties: BORROWER_NAME,
        observations: {
          orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
          take: 1,
          select: { principalBalanceCents: true },
        },
        reviews: { orderBy: { asOf: "desc" }, take: 1, select: { verdict: true, asOf: true } },
        offers: {
          orderBy: { offeredAt: "desc" },
          take: 1,
          select: { status: true, deliveredAt: true, validUntil: true },
        },
        claims: {
          where: { revokedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { deliveredTo: true, deliveredAt: true, acceptedAt: true, expiresAt: true },
        },
      },
    }),
  ]);
  return {
    total,
    rows: loans.map((l) => {
      const borrower = borrowerName(l.parties);
      const review = l.reviews[0];
      const offer = l.offers[0];
      const claim = l.claims[0];
      return {
        id: l.id,
        number: l.servicerLoanNumber ?? "",
        borrower,
        property: [l.propertyCity, l.propertyState].filter(Boolean).join(", ") || null,
        state: toDomainLoanState(l.status),
        noteRatePct: (l.noteRateBps / 100).toFixed(3),
        balanceCents: l.observations[0]?.principalBalanceCents.toString() ?? null,
        review: review ? { verdict: review.verdict.toLowerCase(), asOf: day(review.asOf) } : null,
        offer: offer
          ? {
              status: offer.status.toLowerCase(),
              deliveredAt: offer.deliveredAt?.toISOString() ?? null,
              validUntil: offer.validUntil?.toISOString() ?? null,
            }
          : null,
        claim: claim
          ? {
              deliveredTo: claim.deliveredTo,
              deliveredAt: claim.deliveredAt?.toISOString() ?? null,
              acceptedAt: claim.acceptedAt?.toISOString() ?? null,
              expiresAt: claim.expiresAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

/** How much of a loan's history one page carries: two years of monthly tapes, a quarter of daily reviews. */
export const SERVICER_LOAN_TAPES = 24;
export const SERVICER_LOAN_REVIEWS = 90;

export interface ServicerLoanDetail {
  readonly id: string;
  readonly number: string;
  readonly borrower: string | null;
  readonly state: string;
  /** The day the loan was first loaded, which is the day we began watching it. */
  readonly watchedSince: string;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  };
  readonly terms: {
    readonly rateType: string;
    readonly noteRatePct: string;
    readonly termMonths: number;
    readonly originalPrincipalCents: string;
    readonly originatedOn: string | null;
    readonly firstPaymentOn: string | null;
    readonly maturityOn: string | null;
  };
  /** What each tape said about the loan, newest first. */
  readonly tapes: readonly {
    readonly asOf: string;
    readonly status: string;
    readonly principalBalanceCents: string;
    readonly escrowBalanceCents: string | null;
    readonly scheduledPaymentCents: string | null;
    readonly currentRatePct: string | null;
    readonly nextPaymentDueOn: string | null;
    readonly delinquencyDays: number | null;
  }[];
  /** The daily review's verdicts, newest first, each with its reasons in words. */
  readonly reviews: readonly {
    readonly asOf: string;
    readonly verdict: string;
    readonly reasons: readonly string[];
    readonly candidateRatePct: string | null;
  }[];
  /** Every offer made on the loan, newest first, with the figures the homeowner is shown. */
  readonly offers: readonly {
    readonly id: string;
    readonly status: string;
    readonly detectedOn: string;
    readonly deliveredAt: string | null;
    readonly validUntil: string | null;
    readonly answeredAt: string | null;
    readonly currentRatePct: string | null;
    readonly newRatePct: string;
    readonly currentPaymentCents: string | null;
    readonly newPaymentCents: string | null;
    readonly monthlySavingsCents: string | null;
  }[];
  readonly claim: ServicerBookLoan["claim"];
}

/**
 * One loan on the servicer's book, as their team sees it: what their own
 * tapes said, what each morning's review concluded, the offers it made and
 * where the homeowner's invitation stands. Null for a loan that is not on
 * this servicer's book — a stranger's loan is a missing one.
 *
 * Nothing here comes from the homeowner's side of a claim: no sign-in, no
 * application, no answer beyond where an offer stands.
 */
export async function servicerBookLoan(
  servicerId: string,
  loanId: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ServicerLoanDetail | null> {
  const l = await db.loan.findFirst({
    where: { id: loanId, servicerId, servicerLoanNumber: { not: null } },
    select: {
      id: true,
      servicerLoanNumber: true,
      status: true,
      createdAt: true,
      rateType: true,
      noteRateBps: true,
      termMonths: true,
      originalPrincipalCents: true,
      originatedOn: true,
      firstPaymentOn: true,
      maturityOn: true,
      propertyLine1: true,
      propertyLine2: true,
      propertyCity: true,
      propertyState: true,
      propertyPostalCode: true,
      parties: BORROWER_NAME,
      observations: {
        orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
        take: SERVICER_LOAN_TAPES,
        select: {
          asOf: true,
          status: true,
          principalBalanceCents: true,
          escrowBalanceCents: true,
          scheduledPaymentCents: true,
          currentRatePct: true,
          nextPaymentDueOn: true,
          delinquencyDays: true,
        },
      },
      reviews: {
        orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
        take: SERVICER_LOAN_REVIEWS,
        select: { asOf: true, verdict: true, reasons: true, candidateRatePct: true },
      },
      offers: {
        orderBy: [{ offeredAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          status: true,
          detectedOn: true,
          deliveredAt: true,
          validUntil: true,
          answeredAt: true,
          candidateRatePct: true,
          disclosure: true,
        },
      },
      claims: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { deliveredTo: true, deliveredAt: true, acceptedAt: true, expiresAt: true },
      },
    },
  });
  if (!l) return null;
  const claim = l.claims[0];
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    id: l.id,
    number: l.servicerLoanNumber ?? "",
    borrower: borrowerName(l.parties),
    state: toDomainLoanState(l.status),
    watchedSince: dayEt(l.createdAt),
    address: {
      line1: l.propertyLine1,
      line2: l.propertyLine2,
      city: l.propertyCity,
      state: l.propertyState,
      postalCode: l.propertyPostalCode,
    },
    terms: {
      rateType: l.rateType.toLowerCase(),
      noteRatePct: (l.noteRateBps / 100).toFixed(3),
      termMonths: l.termMonths,
      originalPrincipalCents: l.originalPrincipalCents.toString(),
      originatedOn: l.originatedOn ? day(l.originatedOn) : null,
      firstPaymentOn: l.firstPaymentOn ? day(l.firstPaymentOn) : null,
      maturityOn: l.maturityOn ? day(l.maturityOn) : null,
    },
    tapes: l.observations.map((o) => ({
      asOf: day(o.asOf),
      status: o.status.toLowerCase(),
      principalBalanceCents: o.principalBalanceCents.toString(),
      escrowBalanceCents: o.escrowBalanceCents?.toString() ?? null,
      scheduledPaymentCents: o.scheduledPaymentCents?.toString() ?? null,
      currentRatePct: o.currentRatePct?.toFixed(3) ?? null,
      nextPaymentDueOn: o.nextPaymentDueOn ? day(o.nextPaymentDueOn) : null,
      delinquencyDays: o.delinquencyDays,
    })),
    reviews: l.reviews.map((r) => ({
      asOf: day(r.asOf),
      verdict: r.verdict.toLowerCase(),
      reasons: reasonsInWords(Array.isArray(r.reasons) ? (r.reasons as string[]) : []),
      candidateRatePct: r.candidateRatePct?.toFixed(3) ?? null,
    })),
    offers: l.offers.map((o) => {
      const d = (o.disclosure ?? {}) as Record<string, unknown>;
      return {
        id: o.id,
        status: offerStanding(o, now),
        detectedOn: day(o.detectedOn),
        deliveredAt: o.deliveredAt?.toISOString() ?? null,
        validUntil: o.validUntil?.toISOString() ?? null,
        answeredAt: o.answeredAt?.toISOString() ?? null,
        currentRatePct: text(d.current_rate_pct),
        newRatePct: o.candidateRatePct.toFixed(3),
        currentPaymentCents: text(d.current_pi_cents),
        newPaymentCents: text(d.new_pi_cents),
        monthlySavingsCents: text(d.pi_delta_cents),
      };
    }),
    claim: claim
      ? {
          deliveredTo: claim.deliveredTo,
          deliveredAt: claim.deliveredAt?.toISOString() ?? null,
          acceptedAt: claim.acceptedAt?.toISOString() ?? null,
          expiresAt: claim.expiresAt.toISOString(),
        }
      : null,
  };
}

export async function servicerBookImports(servicerId: string, db: Db = prisma) {
  const rows = await listPartnerBookImports(servicerId, db);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
