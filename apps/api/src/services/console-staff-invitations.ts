/**
 * The console's staff invitations, as this host remembers them.
 *
 * The servicing app owns the staff list and keeps each address hashed and
 * encrypted; its console API answers a masked copy and nothing more. Two
 * things on this host need the address itself:
 *
 * - **The staff door's code.** The servicing app mints and echoes a code for
 *   any address asked, known or not — that is its no-enumeration rule — so
 *   a proxy that mailed the code to whoever asked would be an open relay.
 *   The gate was "one of our own domains" from 5 October 2026 until Joe
 *   asked for staff on any address the next day. It is now "an address an
 *   admin invited through this console and has not removed, or one of
 *   ours", and this table is that list.
 * - **Sending the invitation again.** The servicing app re-invites an
 *   address it already holds as invited — same id, `reinvited: true` — but
 *   the console cannot ask it for the address to send to.
 *
 * So a successful invitation through the proxy writes the address here,
 * keyed on the staff id the servicing app answered, and a removal marks
 * it. The two databases are not joined; the id is a string it answered.
 * The messages are here too, so the proxy and the resend route mail the
 * same words.
 */

import { prisma } from "@hm/db";
import { config } from "../config.js";

export type InvitationMail = "sent" | "not_sent";

/** How an address is kept and compared: trimmed, lower-cased. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Whether an address is on one of our own domains (`INTERNAL_EMAIL_DOMAINS`). */
export function onOurDomains(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return config.internalEmailDomains.includes(
    email
      .slice(at + 1)
      .trim()
      .toLowerCase(),
  );
}

/**
 * Whether the staff door mails this address a code: one of ours, or one an
 * admin invited through this console and has not removed. Anything else is
 * answered as the servicing app answers it and mailed nothing.
 */
export async function mayMailStaffCode(email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  if (onOurDomains(address)) return true;
  const row = await prisma.consoleStaffInvitation.findUnique({
    where: { email: address },
    select: { removedAt: true },
  });
  return row !== null && row.removedAt === null;
}

export interface RememberedInvitation {
  readonly email: string;
  readonly name: string | null;
  /** The servicing app's staff id this address was invited as. */
  readonly staffUserId: string;
  /** What became of the invitation's mail, or null when none was attempted. */
  readonly mailed: InvitationMail | null;
}

/** A successful invitation, first or again: the address is kept, and a removal is undone by it. */
export async function rememberInvitation(input: RememberedInvitation): Promise<void> {
  const now = new Date();
  const email = normalizeEmail(input.email);
  const mail =
    input.mailed === null ? {} : { mailedAt: now, mailOutcome: input.mailed satisfies string };
  await prisma.consoleStaffInvitation.upsert({
    where: { email },
    create: {
      email,
      name: input.name,
      staffUserId: input.staffUserId,
      invitedAt: now,
      lastInvitedAt: now,
      ...mail,
    },
    update: {
      staffUserId: input.staffUserId,
      ...(input.name !== null ? { name: input.name } : {}),
      lastInvitedAt: now,
      removedAt: null,
      ...mail,
    },
  });
}

/** The member was removed through the console: the door stops mailing the address. */
export async function markInvitationRemoved(staffUserId: string): Promise<number> {
  const r = await prisma.consoleStaffInvitation.updateMany({
    where: { staffUserId, removedAt: null },
    data: { removedAt: new Date() },
  });
  return r.count;
}

export interface HeldInvitation {
  readonly email: string;
  readonly name: string | null;
  readonly staffUserId: string;
  readonly lastInvitedAt: Date;
  readonly mailedAt: Date | null;
  readonly mailOutcome: string | null;
  readonly removedAt: Date | null;
}

/** The invitation this console holds for a staff id, newest first; null when it was invited elsewhere or before this table. */
export async function heldInvitation(staffUserId: string): Promise<HeldInvitation | null> {
  const row = await prisma.consoleStaffInvitation.findFirst({
    where: { staffUserId },
    orderBy: { lastInvitedAt: "desc" },
    select: {
      email: true,
      name: true,
      staffUserId: true,
      lastInvitedAt: true,
      mailedAt: true,
      mailOutcome: true,
      removedAt: true,
    },
  });
  return row;
}

/**
 * The staff door's code, as we mail it.
 *
 * The servicing app answers a code request the same whether or not the
 * address is a staff member's, and mints a code either way, so this is
 * mailed to any address of ours that asks — including one nobody has
 * invited, whose code can never be accepted. The message has to say so,
 * because the page cannot: the first person to hit it was the owner,
 * signing in with the address he works under rather than the one the
 * deploy had made admin, holding a code that "didn't match" (5 October
 * 2026).
 */
export function staffSignInCodeMessage(input: { readonly to: string; readonly code: string }) {
  return {
    to: input.to,
    audience: "staff" as const,
    subject: `Your Supermortgage console sign-in code: ${input.code}`,
    text: [
      `Your sign-in code for the Supermortgage console is ${input.code}.`,
      "",
      "It is good for ten minutes and one sign-in, and only for an address an admin has invited to the console. If this address has not been invited, the code will not be accepted: sign in with the address that was invited, or ask an admin to invite this one from Staff & roles.",
      "",
      "If you did not ask for it, ignore this message; nobody can sign in with the code alone.",
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/**
 * The news that an admin invited somebody to the console, as we mail it.
 * The servicing app makes the account and tells nobody — its mailer is a
 * stand-in — so the first invitation made on production reached no inbox
 * (5 October 2026, Joe inviting his own second address). The link opens
 * the staff door itself, because since 6 October the address need not be
 * on one of our domains and the sign-in page's domain rule would send it
 * to the servicer door.
 */
export function staffInvitationMessage(input: {
  readonly to: string;
  readonly name: string | null;
  readonly signInUrl: string;
  /** Sent again, at an admin's word, to somebody who has not signed in yet. */
  readonly again?: boolean;
}) {
  return {
    to: input.to,
    audience: "staff" as const,
    subject: input.again
      ? "Your invitation to the Supermortgage console, sent again"
      : "You have been invited to the Supermortgage console",
    text: [
      `${input.name ? `${input.name}, you` : "You"} have been invited to the Supermortgage console as ${input.to}.`,
      "",
      `To sign in, go to ${input.signInUrl} and enter this address. That link opens the staff door whatever company your address is from. A six-digit code is mailed to you each time you sign in, and the first time you choose a password.`,
      "",
      "If you were not expecting this, ignore it; nothing happens until you sign in.",
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/** Where an invited person signs in: the staff door of the host that invited them. */
export function staffSignInUrl(host: string): string {
  return `https://${host}/console/?door=staff`;
}
