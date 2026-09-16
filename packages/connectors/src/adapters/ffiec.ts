/**
 * The CFPB's survey, from the CFPB.
 *
 * `https://files.ffiec.cfpb.gov/apor/SurveyTable.csv` is a plain file on a
 * plain file server: no credential, no API key, an ETag and a Last-Modified,
 * and a 304 when asked conditionally. It is updated on Thursdays, when the
 * week's survey data are available, and the average prime offer rates computed
 * from that row take effect the following Monday.
 *
 * This adapter fetches and checks; it does not parse. A body that does not
 * begin with the survey's header row is refused here, so that an outage page
 * or a redirect to a sign-in form never reaches the parser as "a survey with
 * zero rows".
 */

import type { AporSeriesConnector } from "../ports/index.js";

export const FFIEC_SURVEY_URL = "https://files.ffiec.cfpb.gov/apor/SurveyTable.csv";
export const FFIEC_YIELD_TABLE_FIXED_URL = "https://files.ffiec.cfpb.gov/apor/YieldTableFixed.txt";
/** The rate-spread calculator's endpoint. `amortizationType` is "FixedRate" there, not "Fixed". */
export const FFIEC_RATE_SPREAD_URL = "https://ffiec.cfpb.gov/public/rateSpread";

export interface FfiecOptions {
  /** The survey's URL; the published table's is `tableUrl`. */
  readonly url?: string;
  readonly tableUrl?: string;
  readonly rateSpreadUrl?: string;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function ffiecAporSeriesConnector(options: FfiecOptions = {}): AporSeriesConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const fetcher =
    (url: string, mustStartWith: string, what: string): AporSeriesConnector["fetchSurvey"] =>
    async (opts = {}) => {
      const headers: Record<string, string> = { accept: "text/csv, text/plain, */*;q=0.5" };
      if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
      if (opts.ifModifiedSince) headers["if-modified-since"] = opts.ifModifiedSince;
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (response.status === 304) {
        return { status: "unchanged", etag: opts.ifNoneMatch ?? null };
      }
      if (response.status !== 200) {
        throw new Error(
          `The CFPB ${what} at ${url} answered ${response.status}; nothing was ingested.`,
        );
      }
      const csv = await response.text();
      if (!csv.replace(/^\uFEFF/, "").startsWith(mustStartWith)) {
        throw new Error(
          `The document at ${url} does not begin with the ${what}'s header row ` +
            `(got ${JSON.stringify(csv.slice(0, 40))}); nothing was ingested.`,
        );
      }
      return {
        status: "fetched",
        document: {
          csv,
          url,
          retrievedAt: new Date().toISOString(),
          lastModified: response.headers.get("last-modified"),
          etag: response.headers.get("etag"),
        },
      };
    };

  return {
    capabilities: {
      provider: "ffiec-survey",
      mode: "production",
      satisfies: ["UW-008"],
    },
    fetchTable: fetcher(
      options.tableUrl ?? FFIEC_YIELD_TABLE_FIXED_URL,
      "Term of Loan in Years|1|2|",
      "published table",
    ),
    fetchSurvey: fetcher(options.url ?? FFIEC_SURVEY_URL, "Date,", "survey"),
    async rateSpreadCheck({ weekOf, termYears }) {
      // The calculator returns APR minus APOR for the week `lockInDate` falls
      // in. At an APR of exactly 10.000 the APOR is 10 minus the answer; any
      // APR would do, and a round one keeps the arithmetic legible in a log.
      const APR = 10;
      try {
        const response = await fetchImpl(options.rateSpreadUrl ?? FFIEC_RATE_SPREAD_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            actionTakenType: 1,
            loanTerm: termYears,
            amortizationType: "FixedRate",
            lockInDate: weekOf,
            apr: APR,
            reverseMortgage: 2,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200) {
          return { status: "unavailable", reason: `the calculator answered ${response.status}` };
        }
        const body = (await response.json()) as { rateSpread?: unknown };
        const spread = Number(body.rateSpread);
        if (!Number.isFinite(spread)) {
          return {
            status: "unavailable",
            reason: `the calculator answered ${JSON.stringify(body).slice(0, 80)}`,
          };
        }
        return { status: "answered", apor: Math.round((APR - spread) * 1000) / 1000 };
      } catch (err) {
        return { status: "unavailable", reason: err instanceof Error ? err.message : "unknown" };
      }
    },
  };
}
