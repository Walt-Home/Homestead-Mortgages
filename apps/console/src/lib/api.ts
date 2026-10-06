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

export interface Call {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | null | undefined>;
  /** Act as this role for this one call, e.g. after ROLE_REQUIRED. */
  readonly role?: string;
  readonly signal?: AbortSignal;
  /** Which door, when a hook that takes a path cannot say: billing's, say. */
  readonly door?: Door;
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
  // Our own API's envelope: `{ error: { message, code } }`.
  const nested = body.error;
  if (
    nested &&
    typeof nested === "object" &&
    typeof (nested as { message?: unknown }).message === "string"
  ) {
    return (nested as { message: string }).message;
  }
  const error = body.error;
  if (typeof error === "string" && error && error !== "refused" && error !== error.toLowerCase())
    return error;
  if (typeof error === "string" && error && !/^[a-z_]+$/.test(error)) return error;
  const code = body.code;
  if (typeof code === "string") return code.replace(/_/g, " ").toLowerCase();
  if (typeof error === "string") return error.replace(/_/g, " ");
  return `Request failed (${status})`;
}

/**
 * Where a call goes. The servicing app's console API answers `/console/api`;
 * our own API answers `/console/hm/tape` — the tape desk —
 * `/console/hm/billing` and `/console/hm/staff` — the invitation sent
 * again — behind the same session, checked with the servicing app on
 * every call.
 */
export type Door = "servicing" | "hm" | "billing" | "staff";
const BASE: Record<Door, string> = {
  servicing: "/console/api",
  hm: "/console/hm/tape",
  billing: "/console/hm/billing",
  staff: "/console/hm/staff",
};

export async function call<T>(
  path: string,
  init: Call = {},
  door: Door = "servicing",
): Promise<Answer<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  // The console has one role. No acting role rides a call unless the call
  // names one: the servicing app runs a read as the least of the four roles
  // an admin holds that opens it, and an act it refuses is sent again as
  // the role it names (`act.ts`).
  if (init.role) headers["x-staff-role"] = init.role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE[init.door ?? door]}${path}${qs(init.query)}`, {
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
    const nestedCode = (b.error as { code?: unknown } | undefined)?.code;
    const actAs = Array.isArray(b.act_as) ? (b.act_as as string[]) : [];
    throw new ApiError(
      response.status,
      messageOf(b, response.status),
      code ?? (typeof nestedCode === "string" ? nestedCode : null),
      actAs,
      b,
    );
  }
  return { data: body as T, actedAs };
}

/** The common case: just the data. */
export async function api<T>(path: string, init: Call = {}): Promise<T> {
  return (await call<T>(path, init)).data;
}

/** The same, at our own door. */
export async function hm<T>(path: string, init: Call = {}): Promise<T> {
  return (await call<T>(path, init, "hm")).data;
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
  if (init.role) headers["x-staff-role"] = init.role;
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

/**
 * A long write at our own door, told as it goes: the server answers
 * newline-delimited JSON — a line per progress report, then the plain
 * answer or the refusal as the last line — and each progress line reaches
 * `onProgress` as it arrives. Resolves with the last line's value; a
 * refusal, on the last line or before the stream started, is an ApiError
 * like any other call's.
 */
export async function stream<T, P>(
  path: string,
  body: unknown,
  onProgress: (progress: P) => void,
  init: { role?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/x-ndjson, application/json",
    "content-type": "application/json",
  };
  if (init.role) headers["x-staff-role"] = init.role;
  const response = await fetch(`${BASE.hm}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal: init.signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    let b: Record<string, unknown> = {};
    try {
      b = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      b = { error: text.slice(0, 200) };
    }
    const nestedCode = (b.error as { code?: unknown } | undefined)?.code;
    const code = typeof b.code === "string" ? b.code : null;
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: { code } }));
    }
    throw new ApiError(
      response.status,
      messageOf(b, response.status),
      code ?? (typeof nestedCode === "string" ? nestedCode : null),
      [],
      b,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let last: Record<string, unknown> | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.kind === "progress") {
      const { kind: _kind, ...progress } = event;
      void _kind;
      onProgress(progress as P);
    } else {
      last = event;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffered.indexOf("\n")) >= 0) {
      take(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
  }
  buffered += decoder.decode();
  take(buffered);
  if (!last) throw new ApiError(0, "The stream ended without an answer.", "STREAM_ENDED");
  const end = last as Record<string, unknown>;
  if (end.kind === "error") {
    throw new ApiError(
      Number(end.status) || 500,
      String(end.message ?? "Something went wrong."),
      typeof end.code === "string" ? end.code : null,
    );
  }
  const status = Number(end.status) || 200;
  if (status >= 400) {
    const value = (end.value ?? {}) as Record<string, unknown>;
    throw new ApiError(status, messageOf(value, status), null, [], value);
  }
  return end.value as T;
}
