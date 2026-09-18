/**
 * The API client. Thin on purpose — the interesting logic lives on the server,
 * where the requirement engine and the underwriting engine can be tested
 * without a browser.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requirementId?: string,
    /**
     * Only on `PROJECTION_ERROR`: which identity fact the server could not
     * read. Screen 2 turns it into the field to check; the message itself
     * names a borrower id and a predicate, and neither belongs on a screen.
     */
    readonly predicate?: string,
  ) {
    super(message);
  }
}

/**
 * Fired when the server says the session is gone.
 *
 * A session that expires mid-flow used to be unrecoverable: every request
 * failed, each screen showed its own local error, and nothing anywhere routed
 * back to sign-in. The auth context listens for this and flips the whole app
 * to the sign-in page, which is the only screen that can fix the problem.
 */
export const SESSION_EXPIRED = "hm:session-expired";

/**
 * Fired when the server says the session is identified but not yet
 * authenticated — a Google sign-in with the second step still to do. The
 * auth context listens and renders that step in place of whatever was asked
 * for. It carries which step: "enroll" when there is no authenticator yet,
 * "verify" when there is one to hear from.
 */
export const SECOND_FACTOR_REQUIRED = "hm:second-factor-required";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  // 204 has no body; parsing it would throw and turn a success into an error.
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (
      body as {
        error?: { message?: string; code?: string; requirementId?: string; predicate?: string };
      }
    ).error;
    // Not for /auth/*: /auth/me 401s as its normal "nobody is signed in"
    // answer during startup, and announcing that would bounce a visitor who
    // was never signed in to begin with. The second-factor routes refuse a
    // wrong code with a 401 of their own, which the screen handles itself.
    if (response.status === 401 && !path.startsWith("/auth/")) {
      if (error?.code === "SIGN_IN_REQUIRED") {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED));
      } else if (
        error?.code === "SECOND_FACTOR_REQUIRED" ||
        error?.code === "SECOND_FACTOR_ENROLLMENT_REQUIRED"
      ) {
        window.dispatchEvent(
          new CustomEvent(SECOND_FACTOR_REQUIRED, {
            detail: { standing: error.code === "SECOND_FACTOR_REQUIRED" ? "verify" : "enroll" },
          }),
        );
      }
    }
    throw new ApiError(
      response.status,
      error?.message ?? `Request failed with ${response.status}`,
      error?.code,
      error?.requirementId,
      error?.predicate,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/* ── Response shapes the UI reads ───────────────────────────────────────── */

export interface OutstandingItem {
  id: string;
  screen: string;
  source: string;
  /** "borrower" items are things a person can act on; "lender" items are not. */
  actor: "borrower" | "lender";
  statement: string;
  severity: "regulatory_violation" | "repurchase_unsaleable" | "financial_loss" | "rework_delay";
  appliesBecause: string;
  applicabilityKnown: boolean;
  missing: string | null;
  waitingFor: string | null;
}

export interface Assessment {
  progress: {
    applicable: number;
    satisfied: number;
    outstanding: number;
    blocked: number;
    undetermined: number;
    borrowerOutstanding: number;
    lenderOutstanding: number;
  };
  outstanding: OutstandingItem[];
  blocked: { id: string; statement: string; rootCauses: string[] }[];
  leverage: { source: string; outstandingCount: number }[];
}
