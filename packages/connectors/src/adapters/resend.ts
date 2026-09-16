/**
 * Mail through Resend, which is the decision `docs/decisions.md` records and
 * the first thing this repo sends.
 *
 * One call, `POST https://api.resend.com/emails`, a bearer key, and a JSON
 * body of the four fields a message has. The adapter refuses to be built
 * without a key and without a sender, because a mailer that silently drops a
 * co-borrower's invitation is worse than one that will not start: the
 * applicant would be told somebody had been invited who never was.
 *
 * Fetch is injectable so the adapter is tested against a stub rather than
 * against Resend, and so a test cannot send a real email by accident.
 */

import type {
  ConnectorCapabilities,
  MailConnector,
  MailMessage,
  MailOutcome,
} from "../ports/index.js";

export interface ResendOptions {
  readonly apiKey: string;
  /** "Supermortgage <no-reply@…>" — a verified sender on the Resend account. */
  readonly from: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendMailConnector(options: ResendOptions): MailConnector {
  if (!options.apiKey) throw new Error("resendMailConnector: an API key is required");
  if (!options.from) throw new Error("resendMailConnector: a verified sender is required");
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? RESEND_ENDPOINT;
  const capabilities: ConnectorCapabilities = {
    provider: "resend",
    mode: "production",
    satisfies: [],
  };
  return {
    capabilities,
    async send(message: MailMessage): Promise<MailOutcome> {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!res.ok) {
        // The body is Resend's own sentence about what was wrong with the
        // request; the token is not in it, because the token is in the body
        // we sent, not the one that came back.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        return { status: "not_delivered", reason: `resend ${res.status}: ${detail}` };
      }
      const body = (await res.json()) as { id?: string };
      return { status: "sent", externalId: body.id ?? "", provider: "resend" };
    },
  };
}
