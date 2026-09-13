/**
 * The screen that asks, and the screen that reads the answers back.
 *
 * Rendered to a string like every other component test here — there is no
 * jsdom in this repo — so what these hold is the markup: that all seventeen
 * questions are actually on the page rather than merely in a catalog, that a
 * follow-up stays off it until its trigger is answered, and that the review
 * screen puts the borrower's own answers above the signature.
 *
 * The last describe is the one that would have caught the defect this commit
 * exists to fix, if it had existed. `buildDeclarations` read a credit report,
 * a lien search, an asset report and a county record and wrote five
 * declarations in the borrower's voice; a file whose pulls had not run showed
 * all five clean. It is gone, and a grep is the only thing that can say it has
 * not come back under another name.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { BorrowerDeclaration, BorrowerResidence } from "@hm/shared";
import { DeclarationsPage } from "../DeclarationsPage.js";
import { ReviewPage } from "../ReviewPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import {
  BANKRUPTCY_CHAPTERS,
  HOMEOWNER_PAST_THREE_YEARS,
  INTENT_TO_OCCUPY,
  PRIOR_PROPERTY_USAGE,
  QUESTIONS,
} from "../../lib/declarations.js";
import { SIGNING_COPY } from "../../lib/outcomes.js";

const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));

vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));

vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ fileId: "f1" }),
}));

const RENTING: BorrowerResidence = {
  residencyType: "Current",
  basis: "Rent",
  durationMonths: 30,
  monthlyRent: 1_850,
  addressLineText: null,
  addressUnit: null,
  cityName: null,
  stateCode: null,
  postalCode: null,
  countryCode: null,
};

const DECLARED: BorrowerDeclaration = {
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

/** As much of the wire shape as these two screens read. */
const response = (over: Record<string, unknown>): LoanFileResponse =>
  ({
    file: {
      id: "f1",
      isDemo: false,
      stage: "declarations",
      borrowers: [],
      consents: [],
      documents: [],
      transcripts: [],
      links: [],
      loan: { purpose: "purchase", loanAmount: 450_000, downPayment: 90_000 },
      property: { occupancy: "primary_residence" },
      declaration: null,
      residences: [],
      decision: { outcome: "approve_eligible", ratios: {} },
      applicationSignedAt: null,
      intentToProceedAt: null,
      ...over,
    },
    applicationState: null,
  }) as unknown as LoanFileResponse;

function render(node: React.ReactNode, file: LoanFileResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["file", "f1"], file);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("the screen that asks", () => {
  it("puts every question on the page", async () => {
    const markup = render(<DeclarationsPage />, response({}));
    expect(markup).toContain(INTENT_TO_OCCUPY.prompt);
    for (const q of QUESTIONS) expect(markup, q.letter).toContain(q.prompt);
  });

  it("asks where the borrower lives, which no retrieval establishes", async () => {
    const markup = render(<DeclarationsPage />, response({}));
    expect(markup).toContain("Do you own, rent, or live there rent free?");
    expect(markup).toContain("How many months have you been there?");
  });

  it("keeps a follow-up off the page until its trigger is answered", async () => {
    // Rendered fresh, so nothing is answered. A follow-up shown under an
    // unanswered trigger is a question the route would refuse the answer to.
    const markup = render(<DeclarationsPage />, response({}));
    expect(markup).not.toContain(HOMEOWNER_PAST_THREE_YEARS);
    expect(markup).not.toContain(PRIOR_PROPERTY_USAGE);
    expect(markup).not.toContain(BANKRUPTCY_CHAPTERS);
  });

  it("renders no requirement id", async () => {
    expect(render(<DeclarationsPage />, response({}))).not.toMatch(
      /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/,
    );
  });
});

describe("the screen that reads them back", () => {
  it("shows the borrower's own answers above the signature", () => {
    const markup = render(
      <ReviewPage />,
      response({ declaration: DECLARED, residences: [RENTING] }),
    );
    expect(markup).toContain(SIGNING_COPY.heading);
    expect(markup).toContain(SIGNING_COPY.lead);
    expect(markup).toContain(INTENT_TO_OCCUPY.prompt);
    expect(markup).toContain("I rent it, 30 months, $1,850 a month");
  });

  it("states nothing on a file where nobody has been asked", () => {
    // The old screen's five declarations all read clean here, because the
    // connectors they were built from had not run.
    const markup = render(<ReviewPage />, response({}));
    expect(markup).toContain(SIGNING_COPY.unanswered);
    expect(markup).not.toContain("No bankruptcy");
    expect(markup).not.toContain("No undisclosed borrowed funds");
  });

  it("gives that sentence somewhere to go", () => {
    // It names work on another screen. Without the link the only thing on
    // this page that answers to it is a button refusing to be pressed, which
    // tells the borrower they are stuck rather than where to go.
    const markup = render(<ReviewPage />, response({}));
    expect(markup).toContain(SIGNING_COPY.answerThem);
    expect(markup).toContain('href="/f/f1/declarations"');
  });

  it("refuses the signature until there is something to attest to", () => {
    // The defect this commit exists to fix, inverted. With nothing stored,
    // "Continue to sign" opened a panel saying the answers above are true and
    // complete over an empty list — a signature on a statement the borrower
    // never made, with the inference removed and nothing put in its place.
    //
    // Not a primary residence, deliberately. On one, the demographics are
    // unanswered too and the button is disabled either way — which is exactly
    // how this passed against a screen that had no such refusal at all.
    const markup = render(<ReviewPage />, response({ property: { occupancy: "second_home" } }));
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Continue to sign<\/button>/);
    expect(markup).not.toContain(SIGNING_COPY.panelTerms);
  });

  it("offers it once the questions are answered", () => {
    // The other half: a gate that never opens is not a gate.
    const markup = render(
      <ReviewPage />,
      response({
        declaration: DECLARED,
        residences: [RENTING],
        property: { occupancy: "second_home" },
      }),
    );
    expect(markup).toContain("Continue to sign");
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Continue to sign<\/button>/);
    expect(markup).not.toContain(SIGNING_COPY.unanswered);
  });

  it("no longer claims to have found anything", () => {
    const markup = render(
      <ReviewPage />,
      response({ declaration: DECLARED, residences: [RENTING] }),
    );
    expect(markup).not.toContain("Here is what we found");
  });
});

/* ── The derivation, and that it is gone ────────────────────────────────── */

const SRC = new URL("../../", import.meta.url).pathname;

function sources(dir: string): { name: string; text: string }[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry)) return [];
    return [{ name: path.slice(SRC.length), text: readFileSync(path, "utf8") }];
  });
}

describe("nothing in the web app derives a declaration", () => {
  const FILES = sources(SRC).filter((f) => !f.name.includes("__tests__"));

  it("has no buildDeclarations anywhere", () => {
    expect(FILES.filter((f) => f.text.includes("buildDeclarations")).map((f) => f.name)).toEqual(
      [],
    );
  });

  it("reads no connector output into an answer", () => {
    // The four sources the five declarations were built from. Each is still a
    // legitimate thing for a screen to read — the bank screen renders the
    // asset report — so the rule is narrow: the module that words the
    // questions and the screen that puts them above a signature may not.
    const answerPath = FILES.filter(
      (f) => f.name === "lib/declarations.ts" || f.name === "pages/ReviewPage.tsx",
    );
    expect(answerPath).toHaveLength(2);
    for (const f of answerPath) {
      for (const source of ["publicRecords", "lienSearch", "borrowedFunds", "propertyRecord"]) {
        expect(f.text, `${f.name} reads ${source}`).not.toContain(source);
      }
    }
  });
});
