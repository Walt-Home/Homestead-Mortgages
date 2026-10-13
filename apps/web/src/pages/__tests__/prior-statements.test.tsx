/**
 * What a person told us before, offered back as one line and never as an
 * answer.
 *
 * Screen 1 offers the income a person last stated, served about the person
 * because a new application has no file to read; screen 2 offers the phone
 * they gave on an earlier application, served beside the file until they have
 * a row on it. Both are a `Found` line under an empty field with "Use it", and
 * the field is never filled on the person's behalf. The offer card asks for
 * the same income before a file exists, and renders the same line.
 */

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Suggestion } from "@hm/shared";
import { IdentityPage } from "../IdentityPage.js";
import { PropertyLoanPage } from "../PropertyLoanPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import { outcomeFor, sameValue } from "../../lib/autofill.js";

const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => params.value,
}));
vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => ({ user: { email: "dana@example.test" }, config: null }),
}));

const INCOME: Suggestion = {
  key: "stated_monthly_income",
  screen: "property",
  mode: "suggest",
  target: { kind: "fact", predicate: "monthly_income" },
  value: 9_400,
  source: "prior_statement",
  tag: "What you told us before",
  basis: "$9,400 a month, in March 2026",
  evidence: { kind: "fact", id: "f-income", at: "2026-03-14T15:00:00Z" },
  evidenceTier: "attested",
  partyId: "p1",
};

const PHONE: Suggestion = {
  key: "phone",
  screen: "identity",
  mode: "suggest",
  target: { kind: "fact", predicate: "phone" },
  value: "512-555-0142",
  source: "prior_statement",
  tag: "What you told us before",
  basis: "512-555-0142",
  evidence: { kind: "fact", id: "f-phone", at: "2026-03-14T15:00:00Z" },
  evidenceTier: "attested",
  partyId: "p1",
};

function render(node: React.ReactNode, seed: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("screen 1, for a returning person", () => {
  it("offers the income they last stated under an empty field", () => {
    params.value = {};
    const markup = render(<PropertyLoanPage />, (c) => c.setQueryData(["suggestions"], [INCOME]));
    expect(markup).toContain(`${INCOME.basis} · ${INCOME.tag}`);
    expect(markup).toContain("Use it");
    expect(markup).toContain("It's changed");
    // The field is the person's: empty until they tap or type.
    expect(markup).toMatch(/id="income"[^>]*value=""/);
  });

  it("offers nothing to somebody it has nothing for", () => {
    params.value = {};
    const markup = render(<PropertyLoanPage />, (c) => c.setQueryData(["suggestions"], []));
    expect(markup).not.toContain("What you told us before");
    expect(markup).not.toContain("Use it");
  });
});

describe("screen 2, for a returning person", () => {
  const file = (suggestions: Suggestion[]) =>
    ({
      file: {
        id: "f1",
        isDemo: false,
        stage: "identity",
        borrowers: [],
        invitedBorrowers: [],
        consents: [],
        links: [],
        loan: { purpose: "purchase" },
        property: { address: { line1: "1 Main St", city: "Austin", state: "TX" } },
      },
      you: null,
      owner: true,
      applicationState: null,
      suggestions,
    }) as unknown as LoanFileResponse;

  it("offers the phone they gave before under an empty field", () => {
    params.value = { fileId: "f1" };
    const markup = render(<IdentityPage />, (c) => c.setQueryData(["file", "f1"], file([PHONE])));
    expect(markup).toContain(`${PHONE.basis} · ${PHONE.tag}`);
    expect(markup).toContain("Not this number");
    expect(markup).toMatch(/id="phone"[^>]*value=""/);
  });

  it("offers nothing when the server has nothing to offer", () => {
    params.value = { fileId: "f1" };
    const markup = render(<IdentityPage />, (c) => c.setQueryData(["file", "f1"], file([])));
    expect(markup).not.toContain("What you told us before");
  });
});

describe("the offer card", () => {
  it("renders the same income line, from the same person-scoped suggestion", () => {
    // The card's field renders only after "yes", which a static render cannot
    // press; this holds the wiring the API test then exercises end to end.
    const card = readFileSync(new URL("../LoanPage.tsx", import.meta.url), "utf8");
    expect(card).toContain("usePersonSuggestions()");
    expect(card).toContain('suggestionFor(personal, "stated_monthly_income")');
    expect(card).toMatch(/<Found[\s\S]{0,200}incomeFound/);
  });
});

describe("what the save reports", () => {
  it("compares a phone by its digits and a figure by its value", () => {
    expect(sameValue("512-555-0142", "(512) 555-0142")).toBe(true);
    expect(sameValue("512-555-0142", "512-555-0143")).toBe(false);
    expect(sameValue(9_400, 9_400)).toBe(true);
    expect(sameValue(9_400, null)).toBe(false);
  });

  it("names the evidence the line was computed from", () => {
    expect(outcomeFor(PHONE, "512-555-0142", false)).toEqual({
      key: "phone",
      evidenceId: "f-phone",
      outcome: "accepted",
      proposed: "512-555-0142",
      given: "512-555-0142",
    });
    expect(outcomeFor(INCOME, 10_200, false)).toMatchObject({
      outcome: "corrected",
      given: 10_200,
    });
    expect(outcomeFor(INCOME, null, true)).toMatchObject({ outcome: "dismissed" });
  });
});
