/**
 * The live adapter against a stubbed server: what it hands on, what it refuses.
 *
 * Nothing here touches the network. The adapter's contract is small — a 200 is
 * a document, a 304 is "unchanged", anything else is an error — and the one
 * thing it must never do is hand a parser something that is not the survey and
 * let the parser discover that as "zero rows".
 */

import { describe, expect, it } from "vitest";
import { FFIEC_SURVEY, FFIEC_YIELD_TABLE_FIXED } from "@hm/shared";
import {
  FFIEC_RATE_SPREAD_URL,
  FFIEC_SURVEY_URL,
  FFIEC_YIELD_TABLE_FIXED_URL,
  ffiecAporSeriesConnector,
} from "../adapters/ffiec.js";

type Reply = { status: number; body?: string; headers?: Record<string, string> };

function server(reply: Reply, seen: { url?: string; headers?: Record<string, string> } = {}) {
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.url = String(input);
    seen.headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers });
  };
  return ffiecAporSeriesConnector({ fetchImpl });
}

describe("the FFIEC survey adapter", () => {
  it("fetches the published URL and hands the document on with the server's headers", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const port = server(
      {
        status: 200,
        body: FFIEC_SURVEY.csv,
        headers: { etag: '"abc"', "last-modified": "Thu, 10 Sep 2026 18:41:13 GMT" },
      },
      seen,
    );
    const fetched = await port.fetchSurvey();
    expect(seen.url).toBe(FFIEC_SURVEY_URL);
    expect(fetched.status).toBe("fetched");
    if (fetched.status !== "fetched") return;
    expect(fetched.document.csv).toBe(FFIEC_SURVEY.csv);
    expect(fetched.document.etag).toBe('"abc"');
    expect(fetched.document.lastModified).toBe("Thu, 10 Sep 2026 18:41:13 GMT");
    expect(fetched.document.url).toBe(FFIEC_SURVEY_URL);
  });

  it("asks conditionally with both headers, and reports 304 as unchanged", async () => {
    // The CFPB's server honors If-Modified-Since and ignores If-None-Match;
    // both go, so whichever a server respects is a 304 and not the file.
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const port = server({ status: 304 }, seen);
    const fetched = await port.fetchSurvey({
      ifNoneMatch: '"abc"',
      ifModifiedSince: "Thu, 10 Sep 2026 18:41:13 GMT",
    });
    expect(seen.headers?.["if-none-match"]).toBe('"abc"');
    expect(seen.headers?.["if-modified-since"]).toBe("Thu, 10 Sep 2026 18:41:13 GMT");
    expect(fetched).toEqual({ status: "unchanged", etag: '"abc"' });
  });

  it("refuses a non-200 rather than ingesting an error page", async () => {
    await expect(
      server({ status: 503, body: "<html>maintenance</html>" }).fetchSurvey(),
    ).rejects.toThrow(/answered 503/);
  });

  it("refuses a 200 whose body is not the survey", async () => {
    // A sign-in page, a WAF interstitial, a redirected index — all 200, none a
    // survey. The parser would call each of them "a survey with zero rows".
    await expect(
      server({ status: 200, body: "<!doctype html><title>Sign in</title>" }).fetchSurvey(),
    ).rejects.toThrow(/does not begin with the survey's header row/);
  });

  it("does not care about the content type, because the server sends octet-stream", async () => {
    const port = server({
      status: 200,
      body: FFIEC_SURVEY.csv,
      headers: { "content-type": "application/octet-stream" },
    });
    expect((await port.fetchSurvey()).status).toBe("fetched");
  });

  it("fetches the published table from its own URL and checks its own header row", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const port = server({ status: 200, body: FFIEC_YIELD_TABLE_FIXED.body }, seen);
    const fetched = await port.fetchTable();
    expect(seen.url).toBe(FFIEC_YIELD_TABLE_FIXED_URL);
    expect(fetched.status).toBe("fetched");
    await expect(server({ status: 200, body: FFIEC_SURVEY.csv }).fetchTable()).rejects.toThrow(
      /published table's header row/,
    );
  });

  it("asks the calculator with the field names it accepts, and turns a spread into an APOR", async () => {
    // Verified live: amortizationType is "FixedRate" (the form's "Fixed" is a
    // 400), and at an APR of 10.000 the week of 2026-09-14 answers 3.160.
    let sent: Record<string, unknown> = {};
    const port = ffiecAporSeriesConnector({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(FFIEC_RATE_SPREAD_URL);
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ rateSpread: "3.160" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const answer = await port.rateSpreadCheck({ weekOf: "2026-09-14", termYears: 30 });
    expect(sent).toMatchObject({
      amortizationType: "FixedRate",
      lockInDate: "2026-09-14",
      loanTerm: 30,
      apr: 10,
    });
    expect(answer).toEqual({ status: "answered", apor: 6.84 });
  });

  it("reports a calculator outage as unavailable, never as an answer", async () => {
    const down = ffiecAporSeriesConnector({
      fetchImpl: (async () => new Response("<html>", { status: 503 })) as typeof fetch,
    });
    expect(await down.rateSpreadCheck({ weekOf: "2026-09-14", termYears: 30 })).toMatchObject({
      status: "unavailable",
    });
    const odd = ffiecAporSeriesConnector({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: "nope" }), { status: 200 })) as typeof fetch,
    });
    expect(await odd.rateSpreadCheck({ weekOf: "2026-09-14", termYears: 30 })).toMatchObject({
      status: "unavailable",
    });
  });

  it("is honest about missing headers", async () => {
    const fetched = await server({ status: 200, body: FFIEC_SURVEY.csv }).fetchSurvey();
    if (fetched.status !== "fetched") throw new Error("expected a document");
    expect(fetched.document.etag).toBeNull();
    expect(fetched.document.lastModified).toBeNull();
  });
});
