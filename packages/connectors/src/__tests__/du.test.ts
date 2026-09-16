/**
 * Nothing is submitted for somebody who did not authorize it.
 *
 * `guard.test.ts` is about one retrieval about one person. This is about a
 * document that carries up to four people at once and leaves the building, so
 * the failure it rules out is bigger by exactly that factor: an applicant's
 * signature carrying a co-borrower's tax and credit data to Fannie Mae.
 *
 * The check is asserted against the ADAPTERS — the fixture and the real one —
 * rather than against a route, because a route can be written tomorrow by
 * somebody who has not read this file. The last block is the one that says so,
 * and it asserts WHICH error each refusal is rather than that there was one:
 * the adapter that transmits refuses an unauthorized submission with an
 * authorization error and a blank one with an emptiness error. A test content
 * with "it threw" would have kept passing on the day the transport landed
 * underneath.
 *
 * **And the transport has landed, so that block's `fetchImpl` now throws.** The
 * ordering claim used to be made against an adapter that refused everything,
 * which proved it against nothing. Every refusal there is now asserted against
 * an adapter that would really send — the stub fails the test if it is reached
 * — so the claim is about the order of two things that both work.
 */

import { describe, expect, it } from "vitest";
import {
  mintPurposeToken,
  type DataCategory,
  type DuResponse,
  type Grant,
  type PurposeToken,
} from "@hm/shared";
import {
  AuthorizationError,
  DuTransportError,
  DuTransportNotWiredError,
  EmptyDuDocumentError,
  duConnector,
  fixtureDuConnector,
  PURPOSE_FOR,
  type DuOptions,
  type DuResponseReader,
  type DuSubmission,
} from "../index.js";

const APPLICANT = "11111111-1111-1111-1111-111111111111";
const CO_BORROWER = "22222222-2222-2222-2222-222222222222";
const A_STRANGER = "99999999-9999-9999-9999-999999999999";
/** The file this casefile is assembled from, and the only one its tokens count on. */
const FILE = "ffffffff-0000-4000-8000-000000000001";
/** The same people's second application, where they also signed everything. */
const ANOTHER_FILE = "ffffffff-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-14T12:00:00.000Z");

/** The two origination grants a borrower who has signed everything holds. */
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
  {
    id: `grant-4506c-${partyId}`,
    partyId,
    purpose: "irs_4506c",
    dataCategories: ["tax_transcript"],
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-30T00:00:00.000Z",
    revokedAt: null,
  },
];

function token(partyId: string, category: DataCategory, fileId = FILE): PurposeToken {
  const minted = mintPurposeToken({
    partyId,
    fileId,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: grantsFor(partyId),
    now: NOW,
  });
  if (!minted.ok) throw new Error(`test setup: ${minted.message}`);
  return minted.token;
}

/** Whatever the emitter produced. Nothing here reads it. */
const DOCUMENT = "<MESSAGE/>";

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

const du = fixtureDuConnector({ latencyMs: 0 });

describe("a casefile goes nowhere without every borrower's permission", () => {
  it("submits for a borrower who authorized what the casefile carries", async () => {
    const answer = await du.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(answer.data.status).toBe("answered");
    if (answer.data.status !== "answered") throw new Error("unreachable");
    expect(answer.data.recommendation).toBe("Approve/Eligible");
    expect(answer.data.duCasefileId).toHaveLength(10);
  });

  it("refuses when the co-borrower has authorized nothing", async () => {
    // The whole reason this guard takes a set. The applicant holds the only
    // session on a joint file and has signed everything asked of them; the
    // second person's social security number, income and liabilities are in the
    // same document, on a signature they never gave.
    const joint = submission({
      borrowers: [
        { partyId: APPLICANT, borrowerOrdinal: 1, dataCategories: ["credit_report"] },
        { partyId: CO_BORROWER, borrowerOrdinal: 2, dataCategories: ["credit_report"] },
      ],
    });
    await expect(du.submit(joint, [token(APPLICANT, "credit_report")])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("sends the joint casefile once both of them have signed", async () => {
    // The refusal above is not a wall. It is a signature apiece.
    const joint = submission({
      borrowers: [
        { partyId: APPLICANT, borrowerOrdinal: 1, dataCategories: ["credit_report"] },
        { partyId: CO_BORROWER, borrowerOrdinal: 2, dataCategories: ["credit_report"] },
      ],
    });
    const answer = await du.submit(joint, [
      token(APPLICANT, "credit_report"),
      token(CO_BORROWER, "credit_report"),
    ]);
    expect(answer.data.status).toBe("answered");
  });

  it("refuses transcript income on an APP-005 token alone", async () => {
    // The permission behind a 4506-C is not the permission behind a credit
    // pull, and a casefile carrying the IRS's answer under the latter is
    // sharing it under a grant that does not mention the IRS.
    const withTranscripts = submission({
      borrowers: [
        {
          partyId: APPLICANT,
          borrowerOrdinal: 1,
          dataCategories: ["credit_report", "tax_transcript"],
        },
      ],
    });
    const call = du.submit(withTranscripts, [token(APPLICANT, "credit_report")]);
    await expect(call).rejects.toBeInstanceOf(AuthorizationError);
    await expect(call).rejects.toMatchObject({ requirementId: "INC-008" });
  });

  it("cites APP-005 when the missing permission is the written instruction", async () => {
    const call = du.submit(submission(), []);
    await expect(call).rejects.toMatchObject({ requirementId: "APP-005" });
  });

  it("refuses a token for somebody this casefile does not carry", async () => {
    // A real permission belonging to a real person on a different loan. Ignoring
    // it rather than refusing would let a submission pass its guard on a
    // permission that has nothing to do with it.
    await expect(
      du.submit(submission(), [
        token(APPLICANT, "credit_report"),
        token(A_STRANGER, "credit_report"),
      ]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a borrower nothing was retrieved about", async () => {
    // DU underwrites each borrower's credit, so a borrower on a casefile has
    // had something checked. A row claiming otherwise is an assembly error, and
    // transmitting it would put a person in the document with no permission to
    // check against.
    const empty = submission({
      borrowers: [{ partyId: APPLICANT, borrowerOrdinal: 1, dataCategories: [] }],
    });
    await expect(du.submit(empty, [token(APPLICANT, "credit_report")])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses a casefile with nobody on it", async () => {
    await expect(du.submit(submission({ borrowers: [] }), [])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses an empty document rather than sending a blank casefile", async () => {
    await expect(
      du.submit(submission({ document: "   " }), [token(APPLICANT, "credit_report")]),
    ).rejects.toBeInstanceOf(EmptyDuDocumentError);
  });

  it("refuses a permission this borrower signed on a different application", async () => {
    // The case the party check above cannot see, because it is the same person
    // both times. A grant belongs to the borrower and outlives the file it was
    // signed on, so somebody with two applications holds one row that reads as
    // covering both — and the permission a casefile goes out under has to be
    // the one signed on the casefile's own application.
    const call = du.submit(submission(), [token(APPLICANT, "credit_report", ANOTHER_FILE)]);
    await expect(call).rejects.toBeInstanceOf(AuthorizationError);
    await expect(call).rejects.toThrow(/different application/);
  });

  it("refuses when only the co-borrower's permission came from somewhere else", async () => {
    // The applicant's is right, so a check that stopped at the first token
    // would pass this. The second person's data is the half that leaves the
    // building on a signature that was never made here.
    const joint = submission({
      borrowers: [
        { partyId: APPLICANT, borrowerOrdinal: 1, dataCategories: ["credit_report"] },
        { partyId: CO_BORROWER, borrowerOrdinal: 2, dataCategories: ["credit_report"] },
      ],
    });
    await expect(
      du.submit(joint, [
        token(APPLICANT, "credit_report"),
        token(CO_BORROWER, "credit_report", ANOTHER_FILE),
      ]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("names no file in the refusal", async () => {
    // Same rule as the party half: a caller who may not transmit must not learn
    // from the refusal which application the permission it holds belongs to.
    try {
      await du.submit(submission(), [token(APPLICANT, "credit_report", ANOTHER_FILE)]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as Error).message).not.toContain(ANOTHER_FILE);
      expect((err as Error).message).not.toContain(FILE);
    }
  });
});

describe("the identifier DU minted", () => {
  it("answers one loan with one casefile however often it is submitted", async () => {
    // `applications.du_casefile_id` is write-once, so a fixture that invented a
    // fresh identifier per answer would make an ordinary resubmission raise.
    const first = await du.submit(submission(), [token(APPLICANT, "credit_report")]);
    const second = await du.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(first.data.duCasefileId).toBe(second.data.duCasefileId);
  });

  it("carries back the case it was given on a resubmission", async () => {
    const resubmitted = submission({ duCasefileId: "1234567890" });
    const answer = await du.submit(resubmitted, [token(APPLICANT, "credit_report")]);
    expect(answer.data.duCasefileId).toBe("1234567890");
  });

  it("gives two loans two casefiles", async () => {
    const other = submission({ ausCasefileId: "bb1b2c3d-0000-4000-8000-000000000002" });
    const a = await du.submit(submission(), [token(APPLICANT, "credit_report")]);
    const b = await du.submit(other, [token(APPLICANT, "credit_report")]);
    expect(a.data.duCasefileId).not.toBe(b.data.duCasefileId);
  });
});

describe("an answer that is not a verdict", () => {
  it("returns no recommendation when DU could not evaluate the casefile", async () => {
    // "DU could not evaluate this" and "DU evaluated it" are two shapes rather
    // than one nullable field, so nothing downstream can read the first as a
    // decision not to approve.
    const errored = fixtureDuConnector({ latencyMs: 0, du: "error" });
    const answer = await errored.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(answer.data.status).toBe("errored");
    // Null, not a case number: DU refused before opening one, and a
    // resubmission has to be able to tell that from a case that exists.
    expect(answer.data.duCasefileId).toBeNull();
    expect(answer.data.messages.length).toBeGreaterThan(0);
  });

  it("can be asked for a recommendation that is not an approval", async () => {
    const referred = fixtureDuConnector({ latencyMs: 0, du: "Refer/Ineligible" });
    const answer = await referred.submit(submission(), [token(APPLICANT, "credit_report")]);
    if (answer.data.status !== "answered") throw new Error("unreachable");
    expect(answer.data.recommendation).toBe("Refer/Ineligible");
  });
});

describe("the adapter that transmits", () => {
  /**
   * The whole point of this harness: a `fetchImpl` that FAILS the test if it is
   * reached.
   *
   * These cases used to prove the ordering against an adapter with no transport
   * at all, which proved it against nothing. Now every refusal below is
   * asserted against an adapter that would send if it got that far — so a
   * future edit that sends first and checks after fails here rather than
   * passing.
   */
  const refusesToSend: typeof fetch = () => {
    throw new Error("the adapter reached the wire before it finished checking");
  };
  const refusesToRead: DuResponseReader = () => {
    throw new Error("the adapter read an answer it should never have asked for");
  };

  const real = (overrides: Partial<DuOptions> = {}) =>
    duConnector({
      sellerServicerNumber: "GRNDR1",
      environment: "test",
      endpoint: "https://example.invalid/du",
      credential: { scheme: "bearer", token: "a-test-token" },
      readResponse: refusesToRead,
      fetchImpl: refusesToSend,
      ...overrides,
    });

  it("refuses to be built without a seller/servicer number", () => {
    // A credential discovered at the first borrower's request is a credential
    // discovered in front of a borrower.
    expect(() => real({ sellerServicerNumber: "  " })).toThrow(DuTransportNotWiredError);
  });

  it("refuses to be built without a credential", () => {
    expect(() => real({ credential: { scheme: "bearer", token: "  " } })).toThrow(
      DuTransportNotWiredError,
    );
    expect(() =>
      real({ credential: { scheme: "basic", username: "grander", password: "" } }),
    ).toThrow(DuTransportNotWiredError);
    expect(() => real({ credential: { scheme: "header", name: "", value: "x" } })).toThrow(
      DuTransportNotWiredError,
    );
  });

  it("refuses an endpoint that is not https", () => {
    // The casefile carries up to four cleartext social security numbers. There
    // is no development shortcut: a test stub gets a fetchImpl, never an http
    // URL.
    expect(() => real({ endpoint: "http://example.invalid/du" })).toThrow(
      DuTransportNotWiredError,
    );
    expect(() => real({ endpoint: "not a url" })).toThrow(DuTransportNotWiredError);
  });

  it("refuses production unless somebody said production", () => {
    expect(() => real({ environment: "production" })).toThrow(DuTransportNotWiredError);
    expect(() => real({ environment: "production", allowProduction: true })).not.toThrow();
  });

  it("runs the guard BEFORE it reaches the wire", async () => {
    // The assertion that matters in this file. An unauthorized submission fails
    // on the permission and `refusesToSend` is never called, so there is no
    // version of this adapter that sends first and checks after.
    await expect(real().submit(submission(), [])).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("sends an authorized one and hands back what the reader read", async () => {
    const answered: DuResponse = {
      status: "answered",
      duCasefileId: "1234567890",
      recommendation: "Approve/Eligible",
      messages: [{ category: "Findings", code: "0001", text: "Eligible for delivery." }],
      respondedAt: "2026-09-16T12:00:00.000Z",
    };
    const port = real({
      fetchImpl: async () =>
        new Response("<MESSAGE/>", {
          status: 200,
          headers: { "content-type": "application/xml" },
        }),
      readResponse: () => answered,
    });
    const result = await port.submit(submission(), [token(APPLICANT, "credit_report")]);
    expect(result.data).toEqual(answered);
    expect(result.provider).toBe("desktop-underwriter (test)");
    expect(result.retrievedAt).toBe(answered.respondedAt);
    expect(result.externalId).toBe("1234567890");
  });

  it("refuses a blank casefile on the emptiness, not on anything the wire said", async () => {
    // The same ordering argument as the guard, applied to the one check that
    // only matters in the adapter that can send. Asserting merely that it
    // throws would pass on a transport refusal too — and a blank casefile
    // reaching Fannie Mae arrives as a malformed one rather than as an error
    // anybody here could read.
    const call = real().submit(submission({ document: "   " }), [
      token(APPLICANT, "credit_report"),
    ]);
    await expect(call).rejects.toBeInstanceOf(EmptyDuDocumentError);
    await expect(call).rejects.not.toBeInstanceOf(DuTransportError);
  });

  it("refuses a permission signed on a different application", async () => {
    // And on the authorization rather than on anything the wire said, for the
    // same reason the case above is written this way.
    const call = real().submit(submission(), [token(APPLICANT, "credit_report", ANOTHER_FILE)]);
    await expect(call).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("claims to satisfy nothing", async () => {
    // UW-001 behind a POST to an endpoint nobody has ever answered would read
    // as a submission path this system has.
    expect(real().capabilities.satisfies).toEqual([]);
  });
});
