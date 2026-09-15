/**
 * Who may retrieve what, about whom.
 *
 * The case that matters most is the second one: the guard this replaces takes
 * a loan file and no borrower, so it cannot tell borrower A's signature from
 * borrower B's data. Everything else here is about refusing precisely rather
 * than refusing vaguely.
 */

import { describe, expect, it } from "vitest";
import {
  AuthorizationDenied,
  mintPurposeToken,
  requirePurposeToken,
  type Grant,
  type PurposeToken,
} from "../authorization.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const ALICE = "11111111-1111-1111-1111-111111111111";
const FILE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "22222222-2222-2222-2222-222222222222";

function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: "grant-1",
    partyId: ALICE,
    purpose: "fcra_written_instruction",
    dataCategories: ["credit_report", "bank_transactions"],
    grantedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

const ask = (over: Record<string, unknown> = {}) =>
  mintPurposeToken({
    partyId: ALICE,
    fileId: FILE,
    purpose: "fcra_written_instruction",
    dataCategory: "credit_report",
    grants: [grant()],
    now: NOW,
    ...over,
  } as Parameters<typeof mintPurposeToken>[0]);

describe("minting", () => {
  it("issues a token when a live grant covers the category", () => {
    const r = ask();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token.partyId).toBe(ALICE);
      expect(r.token.authorizationId).toBe("grant-1");
    }
  });

  it("REFUSES to let one party's grant authorize a pull about another", () => {
    // The defect in `assertVerificationAuthorized(file)`, which takes no
    // borrower: on a two-borrower file, A's signature would pull B's credit.
    const r = mintPurposeToken({
      partyId: BOB,
      fileId: FILE,
      purpose: "fcra_written_instruction",
      dataCategory: "credit_report",
      grants: [grant({ partyId: ALICE })],
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("refuses a category the grant does not cover", () => {
    // Agreeing to a bank connection is not agreeing to a tax transcript.
    const r = ask({ dataCategory: "tax_transcript" });
    expect(r).toMatchObject({ ok: false, reason: "category_not_granted" });
  });

  it("refuses a different purpose under the same category", () => {
    // An origination pull and a monthly account review are different legal
    // bases. One does not imply the other.
    const r = ask({ purpose: "fcra_account_review" });
    expect(r).toMatchObject({ ok: false, reason: "no_grant" });
  });
});

describe("refusing precisely", () => {
  it("says expired when a grant lapsed", () => {
    const r = ask({ grants: [grant({ expiresAt: "2026-08-15T00:00:00.000Z" })] });
    expect(r).toMatchObject({ ok: false, reason: "expired" });
  });

  it("says revoked when the borrower withdrew it", () => {
    const r = ask({ grants: [grant({ revokedAt: "2026-09-01T00:00:00.000Z" })] });
    expect(r).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("says no_grant when nobody ever asked", () => {
    expect(ask({ grants: [] })).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("keeps revoked and expired apart", () => {
    // Four reasons rather than a boolean, because they are four different
    // conversations — a renewal is not an apology.
    const revoked = ask({ grants: [grant({ revokedAt: "2026-09-01T00:00:00.000Z" })] });
    const expired = ask({ grants: [grant({ expiresAt: "2026-08-15T00:00:00.000Z" })] });
    expect(revoked).not.toMatchObject({ reason: "expired" });
    expect(expired).not.toMatchObject({ reason: "revoked" });
  });

  it("prefers the live grant when history sits beside it", () => {
    const r = ask({
      grants: [
        grant({ id: "old", revokedAt: "2026-07-01T00:00:00.000Z" }),
        grant({ id: "current" }),
      ],
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.token.authorizationId).toBe("current");
  });

  it("expires exactly at the boundary rather than a moment after", () => {
    const r = ask({ grants: [grant({ expiresAt: NOW.toISOString() })] });
    expect(r).toMatchObject({ ok: false, reason: "expired" });
  });
});

describe("requirePurposeToken", () => {
  it("throws with the reason attached", () => {
    expect(() =>
      requirePurposeToken({
        partyId: BOB,
        fileId: FILE,
        purpose: "fcra_written_instruction",
        dataCategory: "credit_report",
        grants: [grant()],
        now: NOW,
      }),
    ).toThrow(AuthorizationDenied);
  });

  it("names the party and the category it refused, not just that it refused", () => {
    try {
      requirePurposeToken({
        partyId: ALICE,
        fileId: FILE,
        purpose: "irs_4506c",
        dataCategory: "tax_transcript",
        grants: [grant()],
        now: NOW,
      });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as AuthorizationDenied;
      expect(e.reason).toBe("no_grant");
      expect(e.dataCategory).toBe("tax_transcript");
      expect(e.message).toContain(ALICE);
    }
  });
});

describe("the token cannot be forged", () => {
  it("does not accept an object literal", () => {
    // The mechanism, checked by the compiler rather than at runtime: the brand
    // is a symbol `authorization.ts` does not export, so this is the only file
    // in the repo where the failure can even be written down. If this stops
    // erroring, the guard has quietly become a convention again.
    // @ts-expect-error a PurposeToken cannot be constructed outside its module
    const forged: PurposeToken = {
      partyId: ALICE,
      purpose: "fcra_written_instruction",
      dataCategory: "credit_report",
      authorizationId: "made-up",
      mintedAt: NOW.toISOString(),
    };
    expect(forged).toBeDefined();
  });
});
