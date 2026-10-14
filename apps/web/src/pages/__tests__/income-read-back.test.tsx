/**
 * The income read-back on the review screen: what the applicant told us
 * beside what their own bank shows, above the signature, with nothing to take.
 *
 * Display only. The block names both figures, how many income streams the
 * bank's figure is made of, and which of the two the underwriting reads
 * (the verified one, which is true of the engine: no ratio reads the stated
 * figure). It offers no control and passes no judgment on the gap.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ReadBack } from "@hm/shared";
import { ReviewPage } from "../ReviewPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import { INCOME_READ_BACK_COPY } from "../../lib/outcomes.js";

vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ fileId: "f1" }),
}));

const BACK: ReadBack = {
  key: "stated_vs_found_income",
  screen: "review",
  stated: { value: 9_400, evidence: { kind: "fact", id: "f-income", at: "2026-03-14T15:00:00Z" } },
  found: {
    value: 7_670,
    streams: 2,
    evidence: { kind: "snapshot", id: "s1", at: "2026-10-12T12:00:00Z" },
  },
  tag: "From your bank activity",
  partyId: "p1",
};

const response = (readBacks: ReadBack[]): LoanFileResponse =>
  ({
    file: {
      id: "f1",
      isDemo: false,
      stage: "review",
      borrowers: [
        {
          id: "b1",
          partyId: "p1",
          firstName: "Dana",
          lastName: "Whitfield",
          ssn: { last4: "1234" },
          declaration: null,
          residences: [],
          identityVerification: null,
        },
      ],
      invitedBorrowers: [],
      vestings: [],
      consents: [],
      documents: [],
      transcripts: [],
      links: [],
      employment: [],
      loan: { purpose: "purchase", loanAmount: 450_000, downPayment: 90_000 },
      property: { occupancy: "second_home" },
      decision: { outcome: "approve_eligible", ratios: {} },
      applicationSignedAt: null,
      intentToProceedAt: null,
    },
    you: "b1",
    owner: true,
    applicationState: null,
    suggestions: [],
    readBacks,
  }) as unknown as LoanFileResponse;

function render(file: LoanFileResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["file", "f1"], file);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("the income read-back", () => {
  it("sets the two figures side by side, says which one counts, and where the second came from", () => {
    const markup = render(response([BACK]));
    expect(markup).toContain(INCOME_READ_BACK_COPY.heading);
    expect(markup).toContain(INCOME_READ_BACK_COPY.told);
    expect(markup).toContain("$9,400");
    expect(markup).toContain(INCOME_READ_BACK_COPY.beforeTax);
    expect(markup).toContain(INCOME_READ_BACK_COPY.found);
    expect(markup).toContain("$7,670");
    expect(markup).toContain(", from 2 sources");
    expect(markup).toContain(`${INCOME_READ_BACK_COPY.why} · From your bank activity`);
  });

  it("offers nothing to take: no control inside the block", () => {
    const markup = render(response([BACK]));
    const start = markup.indexOf('data-read-back="stated_vs_found_income"');
    const block = markup.slice(
      start,
      markup.indexOf("</div>", markup.indexOf("super-source", start)),
    );
    expect(block).not.toMatch(/<button|<input|<a /);
  });

  it("says one source without counting it", () => {
    const markup = render(response([{ ...BACK, found: { ...BACK.found, streams: 1 } }]));
    expect(markup).not.toContain("from 1 sources");
    expect(markup).not.toContain(", from");
  });

  it("is absent when the server has nothing to read back", () => {
    expect(render(response([]))).not.toContain(INCOME_READ_BACK_COPY.heading);
  });
});
