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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  // 204 has no body; parsing it would throw and turn a success into an error.
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: string; requirementId?: string } })
      .error;
    if (response.status === 401 && error?.code === "SIGN_IN_REQUIRED") {
      // Not for /auth/me, which 401s as its normal "nobody is signed in"
      // answer during startup — announcing that would bounce a visitor who
      // was never signed in to begin with.
      if (!path.startsWith("/auth/")) {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED));
      }
    }
    throw new ApiError(
      response.status,
      error?.message ?? `Request failed with ${response.status}`,
      error?.code,
      error?.requirementId,
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
