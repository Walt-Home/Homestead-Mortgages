/**
 * A mailer that sends only to addresses on the domains it was told: every
 * other message is answered "not delivered", with the reason, and never
 * leaves. It wraps a real adapter on a deployment that is real enough to
 * have one and not real enough to write to strangers — staging, which holds
 * a servicer's whole book with the homeowners' addresses on the supplement.
 * A refusal here is the same outcome a mailer that is off gives, so the
 * desk shows the link to hand over, exactly as it does today.
 *
 * The domain is what comes after the last `@`, compared without case; a
 * tagged address (`joe+northlight@…`) is its domain's, as it should be.
 */

import type {
  ConnectorCapabilities,
  MailConnector,
  MailMessage,
  MailOutcome,
} from "../ports/index.js";

export interface MailFenceOptions {
  /** Domains mail may go to, e.g. ["supermortgage.com", "trywalt.ai"]. */
  readonly allowedDomains: readonly string[];
  /** Whole addresses that may have mail too — a tester's personal inbox, never a domain. */
  readonly allowedAddresses?: readonly string[];
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

export function fencedMailConnector(
  inner: MailConnector,
  options: MailFenceOptions,
): MailConnector {
  const allowed = new Set(
    options.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean),
  );
  const addresses = new Set(
    (options.allowedAddresses ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean),
  );
  if (allowed.size === 0)
    throw new Error("fencedMailConnector: at least one allowed domain is required");
  const list = [...allowed].sort().join(", ");
  const capabilities: ConnectorCapabilities = {
    ...inner.capabilities,
    provider: `${inner.capabilities.provider} (${list} only)`,
  };
  return {
    capabilities,
    async send(message: MailMessage): Promise<MailOutcome> {
      const to = message.to.trim().toLowerCase();
      if (!allowed.has(domainOf(to)) && !addresses.has(to)) {
        return {
          status: "not_delivered",
          reason: `This deployment sends mail only to ${list} addresses.`,
        };
      }
      return inner.send(message);
    },
  };
}

/**
 * The switch that holds borrower mail. Joe, 5 October 2026: "We are NOT
 * sending emails to borrowers yet. Ensure this is always a clear and manual
 * step." The tape desk honored that on its own; this makes the port honor
 * it, so every message to a borrower or a homeowner — a co-borrower's
 * invitation, a claim link, whatever comes next — is answered "not
 * delivered" while the deployment's switch is off, whichever route sent it
 * and whatever mailer stands behind it. Staff and servicer mail passes:
 * those people asked to be written to, and the second factor of their
 * sign-in is the message.
 *
 * `on` is read per send rather than at build, because a deployment reads
 * its switch from the environment once and a test flips it in place.
 */
export interface BorrowerMailSwitchOptions {
  readonly on: () => boolean;
}

export const BORROWER_MAIL_OFF_REASON =
  "This deployment does not e-mail borrowers or homeowners (HOMEOWNER_MAIL is off).";

export function borrowerMailSwitch(
  inner: MailConnector,
  options: BorrowerMailSwitchOptions,
): MailConnector {
  return {
    // Everything the inner mailer is — the fixture's outbox included, which
    // is how a test reads what went — with one answer changed.
    ...inner,
    capabilities: inner.capabilities,
    async send(message: MailMessage): Promise<MailOutcome> {
      if (message.audience === "borrower" && !options.on()) {
        return { status: "not_delivered", reason: BORROWER_MAIL_OFF_REASON };
      }
      return inner.send(message);
    },
  };
}
