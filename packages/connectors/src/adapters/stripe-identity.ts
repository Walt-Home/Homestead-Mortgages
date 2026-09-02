/**
 * Identity verification, from Stripe Identity.
 *
 * The borrower photographs a government ID and their face; Stripe matches them
 * and returns what the document says. That is the evidence APP-001 asks for
 * ("Government photo ID") and typed fields have never been.
 *
 * ── On test mode ──────────────────────────────────────────────────────────
 *
 * This adapter refuses a live key unless `allowLiveMode` is set explicitly,
 * and nothing in the repo sets it. That is not squeamishness about spending a
 * few dollars:
 *
 *   · Live mode collects a real government ID and a real face scan from every
 *     person who walks the flow — friends and family included.
 *   · Face geometry is biometric data. Illinois BIPA, Texas CUBI and
 *     Washington's equivalent attach specific consent, notice and retention
 *     duties to collecting it, and BIPA carries a private right of action.
 *   · This product has no retention policy and no privacy notice worth the
 *     name yet, which is documented in docs/decisions.md.
 *
 * Collecting real biometrics into a prototype is the one integration mistake
 * that cannot be undone by deleting a row. Test mode proves the whole
 * integration with Stripe's own sample documents and collects nothing real.
 */

import type { Address, IdentityVerification, LoanFile } from "@hm/shared";
import type { ConnectorCapabilities, IdentityConnector } from "../ports/index.js";

export interface StripeIdentityOptions {
  readonly secretKey: string;
  /**
   * Origin the borrower is returned to. The return URL is built per session as
   * `{origin}/f/{fileId}/identity/return` — it has to carry the file, because
   * the borrower comes back to a fresh page load with no memory of which
   * application they were filling in.
   */
  readonly origin: string;
  /**
   * Permit an `sk_live_` key. Deliberately awkward: see the note above. A
   * caller setting this is asserting that real biometric collection is
   * intended and lawful for this deployment.
   */
  readonly allowLiveMode?: boolean;
  readonly fetchImpl?: typeof fetch;
}

const API = "https://api.stripe.com/v1";

interface StripeSession {
  id?: string;
  url?: string;
  status?: "requires_input" | "processing" | "verified" | "canceled";
  last_error?: { code?: string; reason?: string };
  verified_outputs?: {
    first_name?: string;
    last_name?: string;
    dob?: { day?: number; month?: number; year?: number };
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
    };
  };
}

/** Stripe speaks form-encoded, including for nested keys. */
function form(params: Record<string, string | undefined>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return body.toString();
}

function toIsoDate(dob: NonNullable<StripeSession["verified_outputs"]>["dob"]): string | undefined {
  if (!dob?.year || !dob.month || !dob.day) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dob.year}-${pad(dob.month)}-${pad(dob.day)}`;
}

function toAddress(a: NonNullable<StripeSession["verified_outputs"]>["address"]): Address | undefined {
  // A partial address is worse than none: screen 2 prefills from this, and a
  // half-filled form is a form nobody proofreads.
  if (!a?.line1 || !a.city || !a.state || !a.postal_code) return undefined;
  return {
    line1: a.line1,
    line2: a.line2 || undefined,
    city: a.city,
    state: a.state,
    postalCode: a.postal_code,
  };
}

/**
 * Stripe's status is not enough on its own.
 *
 * `requires_input` means two opposite things, and the difference is
 * `last_error`. With no error it is a session nobody has started — which is
 * exactly what a freshly created one looks like. WITH an error, Stripe has
 * seen the document and rejected it, and the borrower has to do something.
 *
 * Collapsing both into "pending" told a borrower whose ID had been refused
 * that it "is being reviewed" — indefinitely, with a spinner, and no way
 * forward. That is the same failure this codebase guards against everywhere
 * else, running the other way: an answer we HAVE, rendered as an answer we
 * are still waiting for.
 */
const STATUS: Record<string, IdentityVerification["status"]> = {
  requires_input: "pending",
  processing: "pending",
  verified: "verified",
  canceled: "failed",
};

export function statusFor(
  stripeStatus: string | undefined,
  lastError: { code?: string; reason?: string } | null | undefined,
): IdentityVerification["status"] {
  const mapped = STATUS[stripeStatus ?? ""] ?? "pending";
  if (mapped === "pending" && stripeStatus === "requires_input" && lastError?.code) {
    return "failed";
  }
  return mapped;
}

export function stripeIdentityConnector(options: StripeIdentityOptions): IdentityConnector {
  const live = options.secretKey.startsWith("sk_live_");
  if (live && !options.allowLiveMode) {
    throw new Error(
      "Refusing a live Stripe key for identity verification. Live mode collects real " +
        "government IDs and face scans — biometric data with statutory duties under BIPA " +
        "and equivalents — and this deployment has no retention policy. Use " +
        "STRIPE_SECRET_KEY_SANDBOX, or pass allowLiveMode deliberately.",
    );
  }

  const doFetch = options.fetchImpl ?? fetch;

  async function call(path: string, init?: RequestInit): Promise<StripeSession | null> {
    const res = await doFetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...init?.headers,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as StripeSession;
  }

  const capabilities: ConnectorCapabilities = {
    provider: live ? "stripe-identity (LIVE)" : "stripe-identity (test)",
    mode: live ? "production" : "sandbox",
    satisfies: ["APP-001"],
  };

  return {
    capabilities,

    async createVerificationSession(file: LoanFile, borrowerId: string) {
      const session = await call("/identity/verification_sessions", {
        method: "POST",
        body: form({
          type: "document",
          return_url: `${options.origin}/f/${file.id}/identity/return`,
          // Ties the session back to the borrower without putting anything
          // identifying in Stripe's metadata.
          "metadata[borrower_id]": borrowerId,
          // The selfie check is what makes the ID belong to the person holding
          // it; without it this verifies a document, not a human.
          "options[document][require_matching_selfie]": "true",
          "options[document][require_live_capture]": "true",
        }),
      });
      if (!session?.id || !session.url) {
        throw new Error("Stripe did not return a verification session.");
      }
      return { verificationId: session.id, verificationUrl: session.url };
    },

    async getVerification(verificationId: string): Promise<IdentityVerification | null> {
      // verified_outputs is not returned unless expanded, and without it a
      // verified session looks like a verification that told us nothing.
      const session = await call(
        `/identity/verification_sessions/${encodeURIComponent(verificationId)}?expand[]=verified_outputs`,
      );
      if (!session?.id) return null;

      const status = statusFor(session.status, session.last_error);
      const out = session.verified_outputs;
      const name = [out?.first_name, out?.last_name].filter(Boolean).join(" ") || undefined;

      return {
        verificationId: session.id,
        status,
        verifiedAt: status === "verified" ? new Date().toISOString() : undefined,
        documentName: name,
        documentDateOfBirth: toIsoDate(out?.dob),
        documentAddress: toAddress(out?.address),
        failureReason: session.last_error?.reason,
      };
    },
  };
}
