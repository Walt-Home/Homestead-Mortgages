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
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/* ── Response shapes the UI reads ───────────────────────────────────────── */

export interface OutstandingItem {
  id: string;
  screen: string;
  source: string;
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
  };
  outstanding: OutstandingItem[];
  blocked: { id: string; statement: string; rootCauses: string[] }[];
  leverage: { source: string; outstandingCount: number }[];
}
