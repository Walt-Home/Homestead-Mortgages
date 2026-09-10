/**
 * The draft that survives a trip to the identity vendor.
 *
 * The bug these exist for: a hosted check navigates the whole document away,
 * so everything typed on screen 2 is gone on return unless it was saved
 * first. The borrower does not experience that as a redirect — they
 * experience it as the form being wiped.
 */

import { describe, expect, it } from "vitest";
import {
  clearDraft,
  readDraft,
  saveDraft,
  type DraftStore,
  type IdentityDraft,
} from "../identity.js";

function store(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const draft: IdentityDraft = {
  phone: "512-555-0142",
  citizenship: "permanent_resident",
  maritalStatus: "married",
  authorized: true,
  econsent: true,
  statedIncome: 9_500,
};

describe("the screen 2 draft", () => {
  it("round-trips everything the redirect would have destroyed", () => {
    const s = store();
    saveDraft("file-1", draft, s);
    expect(readDraft("file-1", s)).toEqual(draft);
  });

  it("carries the income screen 1 passed on router state", () => {
    // Router state does not survive a full page navigation either, and
    // without this the borrower's income silently becomes zero.
    const s = store();
    saveDraft("file-1", draft, s);
    expect(readDraft("file-1", s)?.statedIncome).toBe(9_500);
  });

  it("keeps two files apart", () => {
    const s = store();
    saveDraft("file-1", draft, s);
    expect(readDraft("file-2", s)).toBeNull();
  });

  it("never contains anything resembling an SSN", () => {
    // The one field on that screen that must not sit in browser storage.
    const s = store();
    saveDraft("file-1", draft, s);
    const raw = [...s.map.values()].join("");
    expect(raw).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    expect(Object.keys(draft)).not.toContain("ssn");
  });

  it("survives a corrupted record rather than throwing on a screen", () => {
    const s = store();
    s.setItem("hm.identity.draft.v1.file-1", "{not json");
    expect(readDraft("file-1", s)).toBeNull();
  });

  it("clears once the screen is submitted", () => {
    const s = store();
    saveDraft("file-1", draft, s);
    clearDraft("file-1", s);
    expect(readDraft("file-1", s)).toBeNull();
  });
});
