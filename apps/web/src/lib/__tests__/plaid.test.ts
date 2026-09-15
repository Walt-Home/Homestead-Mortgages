/**
 * The rules that decide whether a borrower can pick up where they left off.
 *
 * All of this runs against an injected store rather than a real localStorage,
 * which is why it runs at all — vitest's default environment has no DOM, and
 * the expiry rules are the part most worth testing.
 */

import { describe, expect, it } from "vitest";
import {
  classifyBankResponse,
  clearAttempt,
  findResumableAttempt,
  readAttempt,
  writeAttempt,
  LINK_TOKEN_GRACE_MS,
  type AttemptStore,
  type BankAttempt,
} from "../plaid.js";

function store(): AttemptStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function attempt(over: Partial<BankAttempt> = {}): BankAttempt {
  return {
    fileId: "file-1",
    linkToken: "link-sandbox-1",
    sessionId: "sess-1",
    expiresAt: new Date(NOW + 4 * 60 * 60_000).toISOString(),
    phase: "linking",
    startedAt: NOW,
    ...over,
  };
}

describe("classifying what the bank route answered", () => {
  it("reads a hand-off", () => {
    const r = classifyBankResponse({
      requiresClientHandoff: true,
      linkToken: "tok",
      sessionId: "s",
      expiresAt: "2026-09-02T16:00:00Z",
    });
    expect(r).toEqual({
      kind: "handoff",
      linkToken: "tok",
      sessionId: "s",
      expiresAt: "2026-09-02T16:00:00Z",
    });
  });

  it("reads a wait", () => {
    expect(classifyBankResponse({ pending: true, retryAfterMs: 4000 })).toEqual({
      kind: "pending",
      retryAfterMs: 4000,
    });
  });

  it("reads the fixture's report, which arrives from the very first POST", () => {
    // The path that must not regress: no handoff, no polling, no CDN script.
    const r = classifyBankResponse({ report: { accounts: [] }, provider: "fixture-bank" });
    expect(r.kind).toBe("ready");
  });

  it("does not mistake a hand-off with no token for one", () => {
    // A token-less handoff would put the screen into `linking` with nothing to
    // open, which is a dead end with no error.
    expect(classifyBankResponse({ requiresClientHandoff: true }).kind).toBe("ready");
  });
});

describe("the attempt record", () => {
  it("round-trips", () => {
    const s = store();
    writeAttempt(attempt(), s);
    expect(readAttempt("file-1", s, NOW)?.linkToken).toBe("link-sandbox-1");
  });

  it("keeps two files apart", () => {
    // A single global key meant two loan files open in two tabs overwrote
    // each other's in-flight handoff.
    const s = store();
    writeAttempt(attempt({ fileId: "file-1", linkToken: "a" }), s);
    writeAttempt(attempt({ fileId: "file-2", linkToken: "b" }), s);
    expect(readAttempt("file-1", s, NOW)?.linkToken).toBe("a");
    expect(readAttempt("file-2", s, NOW)?.linkToken).toBe("b");
  });

  it("discards a token that expires within the grace window", () => {
    // A token that dies while the borrower is on their bank's login page
    // surfaces to them as the bank refusing them.
    const s = store();
    writeAttempt(
      attempt({ expiresAt: new Date(NOW + LINK_TOKEN_GRACE_MS - 1000).toISOString() }),
      s,
    );
    expect(readAttempt("file-1", s, NOW)).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it("keeps a token with real time left", () => {
    const s = store();
    writeAttempt(attempt({ expiresAt: new Date(NOW + 60 * 60_000).toISOString() }), s);
    expect(readAttempt("file-1", s, NOW)).not.toBeNull();
  });

  it("keeps an assembling record past the token's own expiry", () => {
    // The link token is spent by then. What matters is the report, and it can
    // legitimately take longer than the token lives.
    const s = store();
    writeAttempt(attempt({ phase: "assembling", expiresAt: new Date(NOW - 1).toISOString() }), s);
    expect(readAttempt("file-1", s, NOW + 60_000)).not.toBeNull();
  });

  it("gives up on an assembling record after thirty minutes", () => {
    const s = store();
    writeAttempt(attempt({ phase: "assembling" }), s);
    expect(readAttempt("file-1", s, NOW + 31 * 60_000)).toBeNull();
  });

  it("refuses a record whose fileId does not match its key", () => {
    // Acting on it would attach one borrower's bank handoff to another
    // borrower's file.
    const s = store();
    s.setItem("hm.plaid.attempt.v1.file-1", JSON.stringify(attempt({ fileId: "file-2" })));
    expect(readAttempt("file-1", s, NOW)).toBeNull();
  });

  it("survives a corrupted record rather than throwing on a screen", () => {
    const s = store();
    s.setItem("hm.plaid.attempt.v1.file-1", "{not json");
    expect(readAttempt("file-1", s, NOW)).toBeNull();
  });

  it("clears", () => {
    const s = store();
    writeAttempt(attempt(), s);
    clearAttempt("file-1", s);
    expect(readAttempt("file-1", s, NOW)).toBeNull();
  });
});

describe("recovering the file id after an OAuth bank sends the borrower back", () => {
  it("finds the newest live attempt", () => {
    // Plaid forbids query parameters on the redirect URI, so the return page
    // has no file id in the URL and has to recover it from the record.
    const s = store();
    writeAttempt(attempt({ fileId: "old", startedAt: NOW - 60_000 }), s);
    writeAttempt(attempt({ fileId: "new", startedAt: NOW }), s);
    expect(findResumableAttempt(s, NOW)?.fileId).toBe("new");
  });

  it("ignores an expired one and returns the live older one", () => {
    const s = store();
    writeAttempt(
      attempt({ fileId: "dead", startedAt: NOW, expiresAt: new Date(NOW - 1).toISOString() }),
      s,
    );
    writeAttempt(attempt({ fileId: "live", startedAt: NOW - 60_000 }), s);
    expect(findResumableAttempt(s, NOW)?.fileId).toBe("live");
  });

  it("returns null when there is nothing to pick up", () => {
    expect(findResumableAttempt(store(), NOW)).toBeNull();
  });

  it("ignores unrelated keys in the same store", () => {
    const s = store();
    s.setItem("some.other.app.key", "whatever");
    expect(findResumableAttempt(s, NOW)).toBeNull();
  });
});
