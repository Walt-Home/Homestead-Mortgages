/**
 * The portal's client for our own door, `/api/servicer`, on the same origin
 * the portal is served from. The session is our cookie; nothing about it is
 * held here. Every refusal is our envelope, `{ error: { message, code,
 * ...facts } }`, folded into one error the pages can read.
 */

export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    /** Facts beside the code, e.g. `locked_until`. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the server says there is no session any more. */
export const PORTAL_SIGNED_OUT = "partners:signed-out";

export interface PortalCall {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | null | undefined>;
  readonly signal?: AbortSignal;
}

function qs(query: PortalCall["query"]): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function portal<T>(path: string, init: PortalCall = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/api/servicer${path}${qs(init.query)}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    signal: init.signal,
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: { message: text.slice(0, 200) } };
  }
  if (!response.ok) {
    const error = ((body as { error?: Record<string, unknown> }).error ?? {}) as Record<
      string,
      unknown
    >;
    const code = typeof error.code === "string" ? error.code : null;
    if (response.status === 401 && !path.startsWith("/auth/") && path !== "/me") {
      window.dispatchEvent(new CustomEvent(PORTAL_SIGNED_OUT));
    }
    const { message, code: _code, ...extra } = error;
    void _code;
    throw new PortalError(
      response.status,
      typeof message === "string" && message ? message : `Request failed (${response.status})`,
      code,
      extra,
    );
  }
  return body as T;
}

/* ── what the door answers ─────────────────────────────────────────────────── */

export interface PortalMe {
  user: { id: string; email: string; name: string | null };
  servicer: { slug: string; displayName: string };
}

export interface PortalBook {
  servicer: { slug: string; displayName: string };
  book: {
    imports: number;
    lastAsOf: string | null;
    loans: { total: number; byState: Record<string, number> };
    analysis: { asOf: string; verdicts: Record<string, number> } | null;
  };
  team: { active: number };
}

export interface PortalLoan {
  id: string;
  number: string;
  borrower: string | null;
  property: string | null;
  state: string;
  noteRatePct: string;
  balanceCents: string | null;
  review: { verdict: string; asOf: string } | null;
  offer: { status: string; deliveredAt: string | null; validUntil: string | null } | null;
  claim: {
    deliveredTo: string | null;
    deliveredAt: string | null;
    acceptedAt: string | null;
    expiresAt: string;
  } | null;
}

export interface PortalTeamMember {
  id: string;
  email: string;
  name: string | null;
  standing: "invited" | "active" | "disabled" | "expired";
  invitedAt: string;
  inviteExpiresAt: string | null;
  inviteDeliveredAt: string | null;
  acceptedAt: string | null;
  lastSignedInAt: string | null;
}

export const PORTAL_PAGE = 100;
