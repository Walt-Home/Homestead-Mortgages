/**
 * The console's client for Doug's console API, reached as `/console/api/*`
 * on the servicing hostname (apps/api/src/console-host.ts forwards it to his
 * `/ops/api/*`). The session is his `sm_staff` cookie; nothing about it is
 * held here.
 *
 * Two of his conventions are handled once, in this file, so no screen has
 * to know them: the acting role rides every request as `x-staff-role`, and
 * his refusals come in four envelope shapes, all folded into one ApiError.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    /** The roles this session could act as to be allowed, on ROLE_REQUIRED. */
    readonly actAs: readonly string[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the server says there is no session any more. */
export const SIGNED_OUT = "console:signed-out";

let actingRole: string | null = null;
/** Set by the auth context; read by every request. */
export function setActingRole(role: string | null): void {
  actingRole = role;
}

export interface Call {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | null | undefined>;
  /** Act as this role for this one call, e.g. after ROLE_REQUIRED. */
  readonly role?: string;
  readonly signal?: AbortSignal;
}

export interface Answer<T> {
  readonly data: T;
  /** His `x-acted-as`: the role the read actually ran under. */
  readonly actedAs: string | null;
}

function qs(query: Call["query"]): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function messageOf(body: Record<string, unknown>, status: number): string {
  const reason = body.reason;
  if (typeof reason === "string" && reason) return reason;
  const error = body.error;
  if (typeof error === "string" && error && error !== "refused" && error !== error.toLowerCase())
    return error;
  if (typeof error === "string" && error && !/^[a-z_]+$/.test(error)) return error;
  const code = body.code;
  if (typeof code === "string") return code.replace(/_/g, " ").toLowerCase();
  if (typeof error === "string") return error.replace(/_/g, " ");
  return `Request failed (${status})`;
}

export async function call<T>(path: string, init: Call = {}): Promise<Answer<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  const role = init.role ?? actingRole;
  if (role) headers["x-staff-role"] = role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/console/api${path}${qs(init.query)}`, {
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
    body = { error: text.slice(0, 200) };
  }
  const actedAs = response.headers.get("x-acted-as");
  if (!response.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : null;
    if (
      response.status === 401 &&
      (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED") &&
      !path.startsWith("/auth/") &&
      path !== "/me"
    ) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: { code } }));
    }
    const actAs = Array.isArray(b.act_as) ? (b.act_as as string[]) : [];
    throw new ApiError(response.status, messageOf(b, response.status), code, actAs, b);
  }
  return { data: body as T, actedAs };
}

/** The common case: just the data. */
export async function api<T>(path: string, init: Call = {}): Promise<T> {
  return (await call<T>(path, init)).data;
}

/**
 * A multipart upload — a tape and its supplement — with the acting role on
 * it like any other call, and his refusals folded the same way. The browser
 * sets the content type and boundary itself.
 */
export async function upload<T>(
  path: string,
  form: FormData,
  init: { role?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  const role = init.role ?? actingRole;
  if (role) headers["x-staff-role"] = role;
  const response = await fetch(`/console/api${path}`, {
    method: "POST",
    headers,
    body: form,
    credentials: "same-origin",
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!response.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : null;
    if (response.status === 401 && (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED")) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: { code } }));
    }
    const actAs = Array.isArray(b.act_as) ? (b.act_as as string[]) : [];
    throw new ApiError(response.status, messageOf(b, response.status), code, actAs, b);
  }
  return body as T;
}
