/**
 * The servicing platform, over its machine door.
 *
 * `apps/servicing` is Doug's runtime, and this is how our API asks it about
 * a loan: five reads on his `/v1`, each with the bearer his door takes — the
 * shared token outside production, a principal's token in it — and never a
 * database. Nothing of his is imported; the shapes below are what his door
 * answered on 21 September 2026, and the test beside this file replays them.
 *
 *   GET  /v1/partner-book/imports              the servicer's tapes, newest first
 *   GET  /v1/partner-book/imports/{id}         each tape's loan lines: his loan id per servicer number
 *   GET  /v1/loans/{id}/events                 the record: what was loaded, reviewed, offered
 *   GET  /v1/loans/{id}/timers                 the open clocks
 *   POST /v1/loans/{id}/tools/33.2/review.facts     the review's reasons in words (as a system actor)
 *   POST /v1/loans/{id}/tools/33.3/readiness.read   what a refinance still needs
 *
 * The lookup is by the servicer's own loan number, which his schema holds
 * unique, so the servicer slug on the ref is carried and not needed. His
 * §34 read tools would answer all of this in one call and are staff-session
 * only by his rule, which is why this reads the events instead; when he
 * exposes a machine read of the book, this adapter shrinks.
 *
 * Rates cross as the decimal fractions he stores ("0.06375") and leave as the
 * percent strings the rest of this product uses ("6.375").
 */

import type { ServicingRecord, ServicingReviewVerdict } from "@hm/shared";
import type { ConnectorResult, ServicingConnector, ServicingLoanRef } from "../ports/index.js";

export class ServicingUnavailableError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`The servicing platform answered ${status} to ${path}: ${detail}`);
    this.name = "ServicingUnavailableError";
  }
}

export interface SupermortgageOptions {
  /** His API's origin, e.g. http://localhost:8090. */
  readonly baseUrl: string;
  /** The bearer his /v1 door takes. */
  readonly token: string;
  /** The system actor his tool routes record. */
  readonly actorId?: string;
  /** Newest events kept on the record. */
  readonly maxEvents?: number;
  /** The imports scanned for a loan number before giving up. */
  readonly maxImports?: number;
  readonly fetch?: typeof fetch;
  /**
   * A Google identity token for his URL, when his service sits behind Cloud
   * Run's own IAM gate; sent on `X-Serverless-Authorization`, the header
   * Cloud Run reserves for a caller whose `Authorization` is spoken for —
   * here by his bearer. Null means send nothing, which is a local runtime.
   */
  readonly identityToken?: () => Promise<string | null>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : null;
const cents = (v: unknown): bigint | null =>
  typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** "0.06375" → "6.375"; a rate his events carry as a fraction, as a percent to three decimals. */
export function fractionToPct(fraction: string): string {
  const n = Number(fraction);
  if (!Number.isFinite(n)) throw new Error(`not a rate: ${fraction}`);
  return (Math.round(n * 100 * 1000) / 1000).toFixed(3);
}

const VERDICTS: readonly ServicingReviewVerdict[] = [
  "candidate",
  "watching",
  "not_now",
  "excluded",
];
const verdictOf = (v: unknown): ServicingReviewVerdict | null =>
  typeof v === "string" && (VERDICTS as readonly string[]).includes(v)
    ? (v as ServicingReviewVerdict)
    : null;

interface HisEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Json;
}

export function supermortgageServicingConnector(options: SupermortgageOptions): ServicingConnector {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const actor = { kind: "system", id: options.actorId ?? "homestead-api" };
  const maxEvents = options.maxEvents ?? 25;
  const maxImports = options.maxImports ?? 50;

  async function gate(): Promise<Record<string, string>> {
    const token = options.identityToken ? await options.identityToken() : null;
    return token ? { "x-serverless-authorization": `Bearer ${token}` } : {};
  }

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(await gate()),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new ServicingUnavailableError(res.status, path, text.slice(0, 300));
    return JSON.parse(text) as T;
  }

  /** A tool on his bus, as the system actor. A refusal is null rather than a throw: the record stands without it. */
  async function tool(loanId: string, spec: string): Promise<Json | null> {
    const res = await fetchImpl(`${base}/v1/loans/${encodeURIComponent(loanId)}/tools/${spec}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(await gate()),
        "content-type": "application/json",
      },
      body: JSON.stringify({ actor, input: {} }),
    });
    const text = await res.text();
    if (res.status === 409 || res.status === 403 || res.status === 404 || res.status === 501)
      return null;
    if (!res.ok)
      throw new ServicingUnavailableError(
        res.status,
        `/v1/loans/{id}/tools/${spec}`,
        text.slice(0, 300),
      );
    return obj(obj(JSON.parse(text) as unknown)["output"]);
  }

  /** A loan's events and timers, or null when his door says it holds no such loan. */
  async function eventsAndTimers(
    loanId: string,
  ): Promise<{ rawEvents: unknown; rawTimers: unknown } | null> {
    try {
      const [{ events: rawEvents }, { timers: rawTimers }] = await Promise.all([
        call<{ events?: unknown }>("GET", `/v1/loans/${encodeURIComponent(loanId)}/events`),
        call<{ timers?: unknown }>("GET", `/v1/loans/${encodeURIComponent(loanId)}/timers`),
      ]);
      return { rawEvents, rawTimers };
    } catch (err) {
      if (err instanceof ServicingUnavailableError && err.status === 404) return null;
      throw err;
    }
  }

  /** The loan's id and its events, by the remembered id first and the number second. */
  async function resolve(
    ref: ServicingLoanRef,
  ): Promise<{ id: string; held: { rawEvents: unknown; rawTimers: unknown } } | null> {
    if (ref.externalLoanId) {
      const held = await eventsAndTimers(ref.externalLoanId);
      if (held) return { id: ref.externalLoanId, held };
    }
    const id = await lookup(ref.servicerLoanNumber);
    if (!id) return null;
    const held = await eventsAndTimers(id);
    return held ? { id, held } : null;
  }

  async function lookup(servicerLoanNumber: string): Promise<string | null> {
    const list = await call<{ imports?: unknown }>("GET", "/v1/partner-book/imports");
    const imports = Array.isArray(list.imports) ? list.imports.map(obj) : [];
    for (const imp of imports.slice(0, maxImports)) {
      const id = str(imp["import_id"]);
      if (!id) continue;
      const detail = await call<{ loans?: unknown }>(
        "GET",
        `/v1/partner-book/imports/${encodeURIComponent(id)}`,
      );
      const lines = Array.isArray(detail.loans) ? detail.loans.map(obj) : [];
      const hit = lines.find((l) => l["servicer_loan_number"] === servicerLoanNumber);
      const loanId = hit ? str(hit["loan_id"]) : null;
      if (loanId) return loanId;
    }
    return null;
  }

  return {
    capabilities: { provider: "supermortgage", mode: "sandbox", satisfies: [] },

    async fetchRecord(ref: ServicingLoanRef): Promise<ConnectorResult<ServicingRecord> | null> {
      // By the id the caller kept, when it kept one; by the number when it did
      // not, or when the platform no longer answers the id it once gave. A
      // stale id is one extra pair of calls, never a wrong loan: his ids are
      // uuids he mints, and a loan he has forgotten is looked up afresh.
      const found = await resolve(ref);
      if (!found) return null;
      const { id, held } = found;
      const { rawEvents, rawTimers } = held;
      const [facts, readiness] = await Promise.all([
        tool(id, "33.2/review.facts"),
        tool(id, "33.3/readiness.read"),
      ]);

      const events: HisEvent[] = (Array.isArray(rawEvents) ? rawEvents.map(obj) : [])
        .map((e) => ({
          type: str(e["type"]) ?? "",
          occurredAt: str(e["occurredAt"]) ?? "",
          payload: obj(e["payload"]),
        }))
        .filter((e) => e.type && e.occurredAt);
      const newest = (type: string): HisEvent | undefined =>
        [...events].reverse().find((e) => e.type === type);

      const loaded = newest("partner_book.loan.loaded");
      const written = newest("partner_book.review.written");
      const ready = newest("refi.opportunity.offer_ready");
      const offered = newest("refi.opportunity.offered");
      const boarded = events.some((e) => e.type === "loan.boarded");

      const verdict = written ? verdictOf(written.payload["verdict"]) : null;
      const review: ServicingRecord["review"] =
        written && verdict
          ? {
              asOf: str(written.payload["as_of_date"]) ?? written.occurredAt.slice(0, 10),
              verdict,
              reasons: strings(written.payload["reasons"]),
              reasonsInWords:
                facts && verdictOf(facts["verdict"]) === verdict
                  ? strings(facts["reasons_text"])
                  : [],
            }
          : null;

      const timers = (Array.isArray(rawTimers) ? rawTimers.map(obj) : []).filter(
        (t) => t["status"] === "armed",
      );
      const openClocks = timers
        .map((t) => ({ code: str(t["code"]) ?? "", dueOn: str(t["dueDate"]) }))
        .filter((c) => c.code);

      let offer: ServicingRecord["offer"] = null;
      if (ready) {
        const b = obj(ready.payload["benefit_disclosure"]);
        const current = str(b["current_rate"]);
        const next = str(b["new_rate"]) ?? str(ready.payload["note_rate"]);
        if (current && next) {
          const expiry = openClocks.find((c) => c.code === "SM_REFI_OPPORTUNITY_EXPIRY_30");
          offer = {
            detectedAt: str(ready.payload["detected_at"]) ?? ready.occurredAt,
            offeredAt: offered ? (str(offered.payload["offered_at"]) ?? offered.occurredAt) : null,
            expiresOn: expiry?.dueOn ?? null,
            currentRatePct: fractionToPct(current),
            offeredRatePct: fractionToPct(next),
            rateDeltaBps: num(b["rate_delta_bps"]) ?? num(ready.payload["rate_delta_bps"]) ?? 0,
            currentPiCents: cents(b["current_pi_cents"]),
            offeredPiCents: cents(b["new_pi_cents"]) ?? cents(ready.payload["pi_cents"]),
            piDeltaCents: cents(b["pi_delta_cents"]),
            remainingTermMonths: num(b["remaining_term_months"]),
            newTermMonths: num(b["new_term_months"]),
          };
        }
      }

      const readinessRecord: ServicingRecord["readiness"] =
        readiness && readiness["found"] === true
          ? {
              asOf: str(readiness["as_of_date"]) ?? "",
              items: (Array.isArray(readiness["items"]) ? readiness["items"].map(obj) : [])
                .map((i) => ({ item: str(i["item"]) ?? "", status: str(i["status"]) ?? "" }))
                .filter((i) => i.item),
            }
          : null;

      const record: ServicingRecord = {
        externalLoanId: id,
        servicerLoanNumber: ref.servicerLoanNumber,
        relationship: boarded && !loaded ? "serviced" : "monitored",
        loadedAsOf: loaded ? str(loaded.payload["as_of_date"]) : null,
        review,
        offer,
        readiness: readinessRecord,
        openClocks,
        events: [...events]
          .reverse()
          .slice(0, maxEvents)
          .map((e) => ({ at: e.occurredAt, type: e.type })),
      };
      return {
        data: record,
        provider: "supermortgage",
        retrievedAt: new Date().toISOString(),
        externalId: id,
      };
    },
  };
}
