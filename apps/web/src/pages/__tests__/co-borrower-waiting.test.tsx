/**
 * A named co-borrower who has not finished, on the review screen.
 *
 * The applicant names them on screen 2; they complete their own profile in
 * their own session. Until they have, the server refuses the signature with
 * "Your co-borrower needs to finish." — and the review screen has to say so
 * before a button does, by name, in place of the signing panel rather than
 * beside it. A screen that still offered "Continue to sign" would send the
 * applicant into a refusal for something that is not theirs to do.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../ReviewPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import { SIGNING_COPY, WAITING_COPY } from "../../lib/outcomes.js";

const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));
vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ fileId: "f1" }),
}));

const DANA = {
  id: "b1",
  firstName: "Dana",
  lastName: "Whitfield",
  ssn: { last4: "1234" },
  declaration: null,
  residences: [],
  identityVerification: null,
};

const THEO = {
  id: "b2",
  partyId: "p2",
  firstName: "Theo",
  lastName: "Okafor",
  email: "theo@example.test",
  occupiesProperty: true,
  status: "named",
};

/** As much of the wire shape as this screen reads. */
const response = (over: Record<string, unknown>): LoanFileResponse =>
  ({
    file: {
      id: "f1",
      isDemo: false,
      stage: "decision",
      borrowers: [DANA],
      invitedBorrowers: [],
      vestings: [],
      consents: [],
      documents: [],
      transcripts: [],
      links: [],
      loan: { purpose: "purchase", loanAmount: 450_000, downPayment: 90_000 },
      property: { occupancy: "primary_residence" },
      decision: { outcome: "approve_eligible", ratios: {} },
      applicationSignedAt: null,
      intentToProceedAt: null,
      ...over,
    },
    applicationState: null,
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

describe("while a named co-borrower has not finished", () => {
  it("waits, by name, instead of asking for a signature", () => {
    const markup = render(response({ invitedBorrowers: [THEO] }));
    expect(markup).toContain(WAITING_COPY.title);
    expect(markup).toContain(WAITING_COPY.body(["Theo Okafor"]));
    expect(markup).not.toContain("Continue to sign");
    expect(markup).not.toContain(SIGNING_COPY.signButton);
  });

  it("names everybody who has not", () => {
    const marisol = { ...THEO, id: "b3", partyId: "p3", firstName: "Marisol", lastName: "Vega" };
    const markup = render(response({ invitedBorrowers: [THEO, marisol] }));
    expect(markup).toContain(WAITING_COPY.body(["Theo Okafor", "Marisol Vega"]));
  });

  it("says nothing about waiting on a file with nobody named", () => {
    const markup = render(response({}));
    expect(markup).not.toContain(WAITING_COPY.title);
    expect(markup).toContain("Continue to sign");
  });

  it("renders no requirement id", () => {
    expect(render(response({ invitedBorrowers: [THEO] }))).not.toMatch(
      /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/,
    );
  });
});
