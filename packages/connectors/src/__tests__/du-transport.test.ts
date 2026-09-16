/**
 * The exchange itself, against a stubbed server: what goes out, what comes
 * back, and what is never in an error.
 *
 * The `ffiec.test.ts` pattern — a `server(reply, seen)` that captures the
 * request and answers a canned reply — because the same thing is being asserted
 * for the same reason: an adapter's contract with the wire is small, and the
 * failures worth ruling out are the ones where something that is not an answer
 * is treated as one.
 *
 * It is a bigger claim here than there. The CFPB's survey is a public file; a
 * DU casefile carries up to four cleartext social security numbers and the
 * answer names people, their income and their debts. So this file also asserts
 * the negatives: the body is never in an error message, the credential is never
 * in one, and a redirect is never followed.
 *
 * **None of this proves the shape is right.** Nobody here has seen Desktop
 * Underwriter answer anything. What it proves is that the adapter does what it
 * says with whatever it is handed, which is the half that is knowable today.
 */

import { describe, expect, it } from "vitest";
import { mintPurposeToken, type DataCategory, type Grant, type PurposeToken } from "@hm/shared";
import {
  DuResponseFormatError,
  DuTransportError,
  authorizationHeaders,
  duConnector,
  mismoAusResponseReader,
  PURPOSE_FOR,
  type DuCredential,
  type DuSubmission,
} from "../index.js";

const APPLICANT = "11111111-1111-1111-1111-111111111111";
const FILE = "ffffffff-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-14T12:00:00.000Z");
const ENDPOINT = "https://du.example.invalid/casefiles";

const grantsFor = (partyId: string): Grant[] => [
  {
    id: `grant-app-005-${partyId}`,
    partyId,
    purpose: "fcra_written_instruction",
    dataCategories: ["credit_report", "bank_transactions", "payroll_income"],
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-30T00:00:00.000Z",
    revokedAt: null,
  },
];

function token(partyId: string, category: DataCategory): PurposeToken {
  const minted = mintPurposeToken({
    partyId,
    fileId: FILE,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: grantsFor(partyId),
    now: NOW,
  });
  if (!minted.ok) throw new Error(`test setup: ${minted.message}`);
  return minted.token;
}

/** A casefile with a borrower's name and social security number in it. */
const DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8"?><MESSAGE><BORROWER>' +
  "<FirstName>Amara</FirstName><TaxpayerIdentifier>412556789</TaxpayerIdentifier>" +
  "</BORROWER></MESSAGE>";

function submission(overrides: Partial<DuSubmission> = {}): DuSubmission {
  return {
    applicationId: "00000000-0000-0000-0000-000000000000",
    loanFileId: FILE,
    ausCasefileId: "aa1b2c3d-0000-4000-8000-000000000001",
    duCasefileId: null,
    borrowers: [{ partyId: APPLICANT, borrowerOrdinal: 1, dataCategories: ["credit_report"] }],
    document: DOCUMENT,
    ...overrides,
  };
}

interface Seen {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: string;
}

type Reply = { status: number; body?: string; headers?: Record<string, string> };

function server(reply: Reply, seen: Seen = {}, credential?: DuCredential) {
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.url = String(input);
    seen.method = init?.method;
    seen.headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    seen.body = typeof init?.body === "string" ? init.body : undefined;
    seen.redirect = init?.redirect;
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers });
  };
  return duConnector({
    sellerServicerNumber: "GRNDR1",
    environment: "test",
    endpoint: ENDPOINT,
    credential: credential ?? { scheme: "bearer", token: "a-test-token" },
    readResponse: mismoAusResponseReader,
    fetchImpl,
  });
}

/** A findings answer, in the shape `mismoAusResponseReader` is written for. */
const ANSWERED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas">' +
  "<DEAL_SETS><DEAL_SET><DEALS><DEAL><LOANS><LOAN><UNDERWRITING>" +
  "<AUTOMATED_UNDERWRITINGS><AUTOMATED_UNDERWRITING>" +
  "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>" +
  "<AutomatedUnderwritingRecommendationDescription>Approve/Eligible" +
  "</AutomatedUnderwritingRecommendationDescription>" +
  "</AUTOMATED_UNDERWRITING></AUTOMATED_UNDERWRITINGS>" +
  "</UNDERWRITING></LOAN></LOANS></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>";

describe("what the adapter puts on the wire", () => {
  it("POSTs the document, byte for byte, to the configured endpoint", async () => {
    const seen: Seen = {};
    const port = server(
      { status: 200, body: ANSWERED, headers: { "content-type": "application/xml" } },
      seen,
    );
    await port.submit(submission(), [token(APPLICANT, "credit_report")]);

    expect(seen.url).toBe(ENDPOINT);
    expect(seen.method).toBe("POST");
    // Byte for byte. An adapter that re-serialized the casefile would have
    // taken on a second copy of the emitter's assumptions, which is the thing
    // `DuSubmission.document` being opaque exists to prevent.
    expect(seen.body).toBe(DOCUMENT);
    expect(seen.headers?.["content-type"]).toBe("application/xml; charset=utf-8");
    expect(seen.headers?.["accept"]).toBe("application/xml");
  });

  it("never follows a redirect", async () => {
    // A redirect to a sign-in page, followed, is this adapter re-POSTing a
    // casefile AND the credential to a host nobody configured.
    const seen: Seen = {};
    const port = server(
      { status: 200, body: ANSWERED, headers: { "content-type": "application/xml" } },
      seen,
    );
    await port.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(seen.redirect).toBe("error");
  });

  it("carries the credential in whichever of the three schemes is configured", async () => {
    // Which one DU wants is in the integration guide. All three are built, and
    // the choice is configuration rather than a guess the adapter makes.
    expect(authorizationHeaders({ scheme: "bearer", token: "abc" })).toEqual({
      authorization: "Bearer abc",
    });
    expect(
      authorizationHeaders({ scheme: "basic", username: "grander", password: "s3cret" }),
    ).toEqual({ authorization: `Basic ${Buffer.from("grander:s3cret").toString("base64")}` });
    expect(authorizationHeaders({ scheme: "header", name: "X-Fannie-Key", value: "k" })).toEqual({
      "x-fannie-key": "k",
    });

    const seen: Seen = {};
    const port = server(
      { status: 200, body: ANSWERED, headers: { "content-type": "application/xml" } },
      seen,
      { scheme: "header", name: "X-Fannie-Key", value: "a-test-key" },
    );
    await port.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(seen.headers?.["x-fannie-key"]).toBe("a-test-key");
    expect(seen.headers?.["authorization"]).toBeUndefined();
  });

  it("hands back the reader's answer as a ConnectorResult", async () => {
    const port = server({
      status: 200,
      body: ANSWERED,
      headers: { "content-type": "application/xml" },
    });
    const result = await port.submit(submission(), [token(APPLICANT, "credit_report")]);

    expect(result.provider).toBe("desktop-underwriter (test)");
    expect(result.externalId).toBe("1234567890");
    expect(result.retrievedAt).toBe(result.data.respondedAt);
    expect(result.data.status).toBe("answered");
  });

  it("names OUR casefile when DU refused before opening one", async () => {
    // `externalId` is the audit trail's handle on this exchange, so it cannot
    // be empty just because DU declined to mint a number.
    const errored =
      '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas"><DEAL_SETS><DEAL_SET>' +
      "<DEALS><DEAL><SERVICES><SERVICE><AUTOMATED_UNDERWRITING_SYSTEM>" +
      "<AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE><AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGES>" +
      "<AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>" +
      "<AutomatedUnderwritingSystemMessageDescription>The casefile could not be evaluated." +
      "</AutomatedUnderwritingSystemMessageDescription>" +
      "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>" +
      "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGES></AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE>" +
      "</AUTOMATED_UNDERWRITING_SYSTEM></SERVICE></SERVICES></DEAL></DEALS></DEAL_SET>" +
      "</DEAL_SETS></MESSAGE>";
    const port = server({
      status: 200,
      body: errored,
      headers: { "content-type": "application/xml" },
    });
    const result = await port.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(result.data.status).toBe("errored");
    expect(result.data.duCasefileId).toBeNull();
    expect(result.externalId).toBe("du-aa1b2c3d-0000-4000-8000-000000000001");
  });
});

describe("what the adapter refuses to treat as an answer", () => {
  for (const status of [401, 403, 500, 503]) {
    it(`refuses a ${status} without repeating the body`, async () => {
      const port = server({
        status,
        body: "<html><body>Amara Okonkwo owes 412556789</body></html>",
        headers: { "content-type": "text/html" },
      });
      const call = port.submit(submission(), [token(APPLICANT, "credit_report")]);
      await expect(call).rejects.toBeInstanceOf(DuTransportError);
      await expect(call).rejects.toThrow(new RegExp(String(status)));
      // The status and the media type are an operator's; the body is a
      // borrower's.
      try {
        await port.submit(submission(), [token(APPLICANT, "credit_report")]);
      } catch (err) {
        expect((err as Error).message).toContain("text/html");
        expect((err as Error).message).not.toContain("Amara");
        expect((err as Error).message).not.toContain("412556789");
      }
    });
  }

  it("says a failed send MAY have opened a case, because it cannot know", async () => {
    // The single most expensive thing this adapter can get wrong. Nothing here
    // can tell a connection that failed on the way out from one that failed on
    // the way back, and a blind retry opens a second case for one loan.
    const port = duConnector({
      sellerServicerNumber: "GRNDR1",
      environment: "test",
      endpoint: ENDPOINT,
      credential: { scheme: "bearer", token: "a-test-token" },
      readResponse: mismoAusResponseReader,
      fetchImpl: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    });
    const call = port.submit(submission(), [token(APPLICANT, "credit_report")]);
    await expect(call).rejects.toBeInstanceOf(DuTransportError);
    await expect(call).rejects.toThrow(/MAY have been received/);
    await expect(call).rejects.toMatchObject({ mayHaveOpenedACase: true });
  });

  it("reports a non-2xx as a case that was NOT opened by this exchange", async () => {
    // The other half of the distinction above. DU answered, so the request
    // arrived and was declined; whether a case exists is DU's to say, and a
    // caller must not read "500" as "maybe".
    const port = server({ status: 500, headers: { "content-type": "text/plain" } });
    await expect(
      port.submit(submission(), [token(APPLICANT, "credit_report")]),
    ).rejects.toMatchObject({ mayHaveOpenedACase: false });
  });

  it("refuses a 200 that is an HTML page rather than findings", async () => {
    // A sign-in page, a WAF interstitial, a portal's error screen — all 200,
    // none of them a response. The same failure `ffiec.ts` refuses to hand its
    // parser as "a survey with zero rows".
    const port = server({
      status: 200,
      body: "<!doctype html><title>Sign in</title>",
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    await expect(
      port.submit(submission(), [token(APPLICANT, "credit_report")]),
    ).rejects.toBeInstanceOf(DuResponseFormatError);
  });

  it("refuses a body that declares itself larger than the cap, before reading it", async () => {
    const port = server({
      status: 200,
      body: ANSWERED,
      headers: { "content-type": "application/xml", "content-length": String(64 * 1024 * 1024) },
    });
    await expect(
      port.submit(submission(), [token(APPLICANT, "credit_report")]),
    ).rejects.toBeInstanceOf(DuTransportError);
  });
});
