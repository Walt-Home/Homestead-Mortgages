/**
 * The review screen a co-borrower sees.
 *
 * Their own half: their answers, one signature, and nothing of the
 * applicant's — the server sends a co-borrower none of it, and the screen
 * would not render it if it did. After the signature the screen says they
 * are done and who finishes the rest.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CoBorrowerReviewPage } from "../CoBorrowerReviewPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import { CO_BORROWER_REVIEW_COPY, SIGNING_COPY } from "../../lib/outcomes.js";

const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));
vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ fileId: "f1" }),
}));

const DECLARED = {
  intentToOccupy: "Yes",
  homeownerPastThreeYears: "No",
  priorPropertyUsage: null,
  priorPropertyTitle: null,
  fhaSecondaryResidence: null,
  specialBorrowerSellerRelationship: false,
  undisclosedBorrowedFunds: false,
  undisclosedBorrowedFundsAmount: null,
  undisclosedMortgageApplication: false,
  undisclosedCreditApplication: false,
  propertyProposedCleanEnergyLien: false,
  undisclosedComakerOfNote: false,
  outstandingJudgments: false,
  presentlyDelinquent: false,
  partyToLawsuit: false,
  priorPropertyDeedInLieuConveyed: false,
  priorPropertyShortSaleCompleted: false,
  priorPropertyForeclosureCompleted: false,
  bankruptcy: false,
  bankruptcyChapters: [],
  explanations: null,
};

/** The applicant, as a co-borrower is sent her: a name and nothing private. */
const DANA = {
  id: "b1",
  firstName: "Dana",
  lastName: "Whitfield",
  dateOfBirth: "",
  ssn: { last4: "" },
  declaration: null,
  residences: [],
  identityVerification: null,
};

const THEO = (over: Record<string, unknown> = {}) => ({
  id: "b2",
  firstName: "Theo",
  lastName: "Okafor",
  email: "theo@example.test",
  phone: "5555550188",
  dateOfBirth: "1984-02-19",
  ssn: { last4: "8765" },
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "married",
  citizenship: "us_citizen",
  currentHousing: "own",
  firstTimeHomebuyer: false,
  declaration: DECLARED,
  residences: [
    {
      residencyType: "Current",
      basis: "Own",
      durationMonths: 90,
      monthlyRent: null,
      addressLineText: null,
      addressUnit: null,
      cityName: null,
      stateCode: null,
      postalCode: null,
      countryCode: null,
    },
  ],
  identityVerification: null,
  ...over,
});

const response = (over: Record<string, unknown>, consents: unknown[] = []): LoanFileResponse =>
  ({
    file: {
      id: "f1",
      isDemo: false,
      stage: "bank",
      borrowers: [DANA, THEO()],
      invitedBorrowers: [],
      vestings: [],
      consents,
      documents: [],
      transcripts: [],
      links: [],
      loan: { purpose: "purchase", loanAmount: 450_000, downPayment: 90_000 },
      property: { occupancy: "primary_residence" },
      decision: null,
      applicationSignedAt: null,
      intentToProceedAt: null,
      ...over,
    },
    you: "b2",
    owner: false,
    applicationState: null,
  }) as unknown as LoanFileResponse;

function render(file: LoanFileResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["file", "f1"], file);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CoBorrowerReviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("a co-borrower's review", () => {
  it("shows their own answers and one signature, and names the applicant only as a name", () => {
    const markup = render(response({}));
    expect(markup).toContain(CO_BORROWER_REVIEW_COPY.title);
    expect(markup).toContain(CO_BORROWER_REVIEW_COPY.lead("Dana"));
    expect(markup).toContain("I own it, 90 months");
    expect(markup).toContain(CO_BORROWER_REVIEW_COPY.signButton);
    expect(markup).not.toContain(SIGNING_COPY.signButton);
    expect(markup).not.toContain("Sign and submit");
  });

  it("asks for their answers before offering the signature", () => {
    const markup = render(
      response({ borrowers: [DANA, THEO({ declaration: null, residences: [] })] }),
    );
    expect(markup).toContain(SIGNING_COPY.unanswered);
    expect(markup).toContain("/f/f1/declarations");
  });

  it("says they are done once they have signed", () => {
    const markup = render(
      response({}, [{ kind: "application_signature", borrowerId: "b2", grantedAt: "2026-09-16" }]),
    );
    expect(markup).toContain(CO_BORROWER_REVIEW_COPY.doneTitle);
    expect(markup).toContain(CO_BORROWER_REVIEW_COPY.doneBody("Dana"));
    expect(markup).not.toContain(CO_BORROWER_REVIEW_COPY.signButton);
  });

  it("renders no requirement id", () => {
    expect(render(response({}))).not.toMatch(/\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/);
  });
});
