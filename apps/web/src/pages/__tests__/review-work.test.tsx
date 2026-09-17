/**
 * URLA 1b, on the screen that asks it: what the borrower says about each job
 * they hold now, above the signature that attests to it.
 *
 * Asked on screen 5 rather than on screen 3 because there is nothing to ask
 * about until screen 4 has run — a job arrives with the bank or payroll pull,
 * and the questions are per job. So this is the one block on the flow whose
 * SUBJECT comes from a connector and whose ANSWERS cannot: a pull reports the
 * employer, the position and the dates, and no pull can report whether the
 * borrower owns the business or whether the employer is selling them the
 * house. That split is what these tests hold. A job with no declaration is
 * UNASKED, and the failure to guard against is the one the derived
 * declarations were — a screen printing "not self-employed" about a question
 * nobody put.
 *
 * Rendered to a string like every other component test here; there is no jsdom
 * in this repo. So the claims are about the markup and about the pure
 * functions behind it, and the two claims that need a click — the order of the
 * POSTs, and the path they go to — are made against the source of the handler
 * that makes them, the way `outcomes.test.ts` reads its endings.
 */

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { BorrowerDeclaration, BorrowerResidence, FileEmployment } from "@hm/shared";
import { ReviewPage } from "../ReviewPage.js";
import type { LoanFileResponse } from "../../lib/file.js";
import { CO_BORROWER_COPY, SIGNING_COPY, WORK_COPY } from "../../lib/outcomes.js";
import { answerFor, currentJobsFor, workAnswered, workBody, workLines } from "../../lib/work.js";

const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));

vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));

vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ fileId: "f1" }),
}));

const MY_PARTY = "p1";
const THEIR_PARTY = "p2";
const THEIR_NAME = "Theo Okafor";

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

/** Section 5, answered. These tests are about a different set of questions. */
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

/** One employment as the projection sends it. `declaration` null is unasked. */
const job = (over: Partial<FileEmployment> = {}): FileEmployment => ({
  id: "e1",
  partyId: MY_PARTY,
  employerId: "emp1",
  employerName: "Acme",
  position: "Operations lead",
  startDate: "2021-04-01",
  status: "active",
  isMilitary: false,
  verificationMethod: "payroll_connector",
  declaration: null,
  ...over,
});

const answeredJob = (over: Partial<FileEmployment> = {}): FileEmployment =>
  job({
    declaration: {
      selfEmployed: false,
      employedByPartyToTransaction: false,
      declaredAt: "2026-02-02T00:00:00.000Z",
    },
    ...over,
  });

const borrower = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  partyId: MY_PARTY,
  firstName: "Dana",
  lastName: "Whitfield",
  ssn: { last4: "1234" },
  declaration: DECLARED,
  residences: [RENTING],
  identityVerification: null,
  ...over,
});

const them = (over: Record<string, unknown> = {}) =>
  borrower({
    id: "b2",
    partyId: THEIR_PARTY,
    firstName: "Theo",
    lastName: "Okafor",
    ...over,
  });

/**
 * As much of the wire shape as this screen reads.
 *
 * Not a primary residence, deliberately, on every file below. On one the
 * demographics are unanswered too and "Continue to sign" is disabled either
 * way — which would let every assertion about the work gate pass against a
 * screen that had no such gate at all.
 */
const response = (over: Record<string, unknown>): LoanFileResponse =>
  ({
    file: {
      id: "f1",
      isDemo: false,
      stage: "review",
      borrowers: [borrower()],
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
      ...over,
    },
    you: "b1",
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
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2014;", "—");
}

const DISABLED_SIGN = /<button[^>]*disabled[^>]*>Continue to sign<\/button>/;

describe("a signer with no current job is asked nothing", () => {
  it("renders no block at all when the file has no employment", () => {
    const markup = render(response({}));
    expect(markup).not.toContain(WORK_COPY.heading);
    expect(markup).not.toContain(WORK_COPY.selfEmployed);
    expect(markup).not.toContain(WORK_COPY.partyToTransaction);
  });

  it("renders none for a job that has ended", () => {
    // URLA 1b is about current employment. A job that ended is history a pull
    // reported and nobody attests to — and an ended job in the block would
    // also be a job the route refuses an answer for.
    const markup = render(response({ employment: [job({ status: "ended" })] }));
    expect(markup).not.toContain(WORK_COPY.heading);
  });

  it("renders none for somebody else's job", () => {
    const markup = render(response({ employment: [job({ partyId: THEIR_PARTY })] }));
    expect(markup).not.toContain(WORK_COPY.heading);
  });

  it("lets them sign, because there is nothing outstanding", () => {
    // The other half. A gate that reads "unanswered" on an empty set would
    // hold the signature on a question nobody can be asked.
    const markup = render(response({}));
    expect(markup).toContain("Continue to sign");
    expect(markup).not.toMatch(DISABLED_SIGN);
    expect(markup).not.toContain(WORK_COPY.unanswered);
  });
});

describe("one block per current job, with both questions on it", () => {
  it("names the job and asks the two questions", () => {
    const markup = render(response({ employment: [job()] }));
    expect(markup).toContain(WORK_COPY.heading);
    expect(markup).toContain("Operations lead at Acme");
    expect(markup).toContain(WORK_COPY.selfEmployed);
    expect(markup).toContain(WORK_COPY.partyToTransaction);
  });

  it("asks both of them again for a second job", () => {
    // Per job, not per person: a borrower with two employers owns the business
    // at one of them and not the other, and one pair of controls standing for
    // both is an answer nobody gave about one of them.
    const markup = render(
      response({
        employment: [job(), job({ id: "e2", employerName: "Borealis", position: "Night shift" })],
      }),
    );
    expect(markup).toContain("Operations lead at Acme");
    expect(markup).toContain("Night shift at Borealis");
    expect(markup.split(WORK_COPY.selfEmployed)).toHaveLength(3);
    expect(markup.split(WORK_COPY.partyToTransaction)).toHaveLength(3);
    // And the radios are grouped per job, or answering one would answer both.
    expect(markup).toContain('name="work-self-e1"');
    expect(markup).toContain('name="work-self-e2"');
  });

  it("renders no requirement id", () => {
    expect(render(response({ employment: [job()] }))).not.toMatch(
      /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/,
    );
  });
});

describe("the signature waits for every job", () => {
  it("refuses it while a job is unanswered, and says why", () => {
    const markup = render(response({ employment: [job()] }));
    expect(markup).toMatch(DISABLED_SIGN);
    expect(markup).toContain(WORK_COPY.unanswered);
    expect(markup).not.toContain(SIGNING_COPY.panelTerms);
  });

  it("refuses it while the SECOND job is unanswered", () => {
    // The one a per-person answer would have let through.
    const markup = render(response({ employment: [answeredJob(), job({ id: "e2" })] }));
    expect(markup).toMatch(DISABLED_SIGN);
    expect(markup).toContain(WORK_COPY.unanswered);
  });

  it("offers it once every job is answered", () => {
    const markup = render(response({ employment: [answeredJob(), answeredJob({ id: "e2" })] }));
    expect(markup).toContain("Continue to sign");
    expect(markup).not.toMatch(DISABLED_SIGN);
    expect(markup).not.toContain(WORK_COPY.unanswered);
  });

  it("shows a stored answer as answered, on the first render", () => {
    // Prefilled from the declaration rather than seeded by an effect: a form
    // seeded from fetched data is empty on the first render, and the first
    // render is the one a borrower returning to this screen sees.
    const markup = render(
      response({
        employment: [
          answeredJob({
            declaration: {
              selfEmployed: true,
              employedByPartyToTransaction: false,
              declaredAt: "2026-02-02T00:00:00.000Z",
            },
          }),
        ],
      }),
    );
    expect(markup).toMatch(/name="work-self-e1" checked="" value="yes"/);
    expect(markup).toMatch(/name="work-party-e1" checked="" value="no"/);
    // And nothing else is ticked, or "answered" would mean "one of the two".
    expect(markup).not.toMatch(/name="work-self-e1" checked="" value="no"/);
    expect(markup).not.toMatch(/name="work-party-e1" checked="" value="yes"/);
  });

  it("still waits for Section 5, whatever the jobs say", () => {
    // Two gates, and neither stands in for the other.
    const markup = render(
      response({
        borrowers: [borrower({ declaration: null, residences: [] })],
        employment: [answeredJob()],
      }),
    );
    expect(markup).toMatch(DISABLED_SIGN);
    expect(markup).toContain(SIGNING_COPY.unanswered);
  });
});

describe("what gets posted, and when", () => {
  it("sends the whole set, one entry per job, as booleans", () => {
    const jobs = [answeredJob(), job({ id: "e2" })];
    const body = workBody(jobs, { e2: { selfEmployed: "no", partyToTransaction: "yes" } });
    expect(body).toEqual({
      answers: [
        { employmentId: "e1", selfEmployed: false, employedByPartyToTransaction: false },
        { employmentId: "e2", selfEmployed: false, employedByPartyToTransaction: true },
      ],
    });
  });

  it("names no borrower", () => {
    // The route reads an absent one as Borrower 1, which is the signer. Naming
    // somebody would be this screen claiming to speak for them, which is the
    // thing the co-borrower block exists to stop.
    expect(Object.keys(workBody([job()], {}))).toEqual(["answers"]);
  });

  const SOURCE = readFileSync(new URL("../ReviewPage.tsx", import.meta.url), "utf8");
  const HANDLER = SOURCE.slice(
    SOURCE.indexOf("async function saveAndContinue()"),
    SOURCE.indexOf("setReadyToSign(true)"),
  );

  it("posts the jobs from the handler that opens the signing panel", () => {
    expect(HANDLER.length).toBeGreaterThan(0);
    expect(HANDLER).toContain("/employment-declarations`, workBody(myJobs, work)");
  });

  it("posts them before the borrower, and only when there are jobs", () => {
    // Order, because a refusal arriving after the demographics were saved
    // would leave the file half-written with the signature already on offer.
    const jobs = HANDLER.indexOf("/employment-declarations");
    const borrowers = HANDLER.indexOf("/borrowers`");
    expect(jobs).toBeGreaterThan(-1);
    expect(borrowers).toBeGreaterThan(jobs);
    expect(HANDLER).toContain("if (myJobs.length > 0)");
  });

  it("refuses to open the panel on an unanswered set, not merely to enable the button", () => {
    expect(HANDLER).toContain("if (!workComplete) return;");
  });

  it("surfaces the server's refusal through the existing error path", () => {
    // The 422 names the job left out, which is a sentence a person can read.
    // Nothing here re-words it.
    const CATCH = SOURCE.slice(SOURCE.indexOf("async function saveAndContinue()"));
    expect(CATCH).toContain("setError(refusal(err) ?? (err instanceof Error ? err.message");
  });
});

describe("a co-borrower's jobs are theirs", () => {
  const joint = (over: Record<string, unknown> = {}) =>
    // Two names on title need a manner of holding before the signature is
    // offered, so the household states one.
    response({
      borrowers: [borrower(), them()],
      vestings: [
        {
          status: "Proposed",
          fullName: "Dana Whitfield and Theo Okafor",
          vestingType: "JointTenantsWithRightOfSurvivorship",
        },
      ],
      ...over,
    });

  it("shows their answered jobs back, without controls", () => {
    const markup = render(
      joint({
        employment: [
          answeredJob({ id: "e9", partyId: THEIR_PARTY, employerName: "Borealis Freight" }),
        ],
      }),
    );
    expect(markup).toContain(CO_BORROWER_COPY.workOf(THEIR_NAME));
    expect(markup).toContain(
      "Borealis Freight — not self-employed; not employed by a party to this transaction",
    );
    // The applicant has no job of their own here, so the questions must be
    // nowhere on the page: a control under somebody else's name would record
    // the applicant's answer about their employer.
    expect(markup).not.toContain(WORK_COPY.selfEmployed);
    expect(markup).not.toContain(WORK_COPY.partyToTransaction);
  });

  it("says whose answers are missing when they have not given any", () => {
    const markup = render(joint({ employment: [job({ id: "e9", partyId: THEIR_PARTY })] }));
    expect(markup).toContain(CO_BORROWER_COPY.noWorkAnswers(THEIR_NAME));
    expect(markup).not.toContain(WORK_COPY.unanswered);
  });

  it("does not hold the applicant's signature on them", () => {
    // Who signs what is not this screen's to change. A co-borrower answers
    // when they sign in, and until then the applicant's own set is complete.
    const markup = render(joint({ employment: [job({ id: "e9", partyId: THEIR_PARTY })] }));
    expect(markup).toContain("Continue to sign");
    expect(markup).not.toMatch(DISABLED_SIGN);
  });

  it("gives each of them their own jobs and nobody else's", () => {
    const markup = render(
      joint({
        employment: [
          job({ employerName: "Acme" }),
          answeredJob({ id: "e9", partyId: THEIR_PARTY, employerName: "Borealis Freight" }),
        ],
      }),
    );
    const at = markup.indexOf(CO_BORROWER_COPY.workOf(THEIR_NAME));
    expect(at, "the co-borrower's work block is not on the page").toBeGreaterThan(-1);
    expect(markup.slice(0, at)).toContain("Operations lead at Acme");
    expect(markup.slice(at)).not.toContain("Operations lead at Acme");
    expect(markup.slice(0, at)).not.toContain("Borealis Freight —");
  });
});

describe("the rules behind the block", () => {
  it("answers nothing for a file whose people have not loaded", () => {
    // Two undefined party ids compare equal, which would hand one borrower's
    // jobs to every reader of a file that has not loaded its people yet.
    expect(currentJobsFor({ employment: [job()] }, undefined)).toEqual([]);
    expect(currentJobsFor(undefined, MY_PARTY)).toEqual([]);
  });

  it("treats a half-answered job as unanswered", () => {
    const jobs = [job()];
    expect(workAnswered(jobs, { e1: { selfEmployed: "no" } })).toBe(false);
    expect(workAnswered(jobs, { e1: { selfEmployed: "no", partyToTransaction: "no" } })).toBe(true);
  });

  it("lets a change win over what is stored", () => {
    expect(answerFor(answeredJob(), { e1: { selfEmployed: "yes" } })).toEqual({
      selfEmployed: "yes",
      partyToTransaction: "no",
    });
  });

  it("reads back nothing for an unasked job", () => {
    // The derived declaration, with the subject changed: "not self-employed"
    // about a question nobody put is our statement in the borrower's voice.
    expect(workLines([job()])).toEqual([]);
    expect(workLines([answeredJob(), job({ id: "e2" })])).toEqual([
      "Acme — not self-employed; not employed by a party to this transaction",
    ]);
  });

  it("says the other answer in its own words", () => {
    expect(
      workLines([
        answeredJob({
          declaration: {
            selfEmployed: true,
            employedByPartyToTransaction: true,
            declaredAt: "2026-02-02T00:00:00.000Z",
          },
        }),
      ]),
    ).toEqual([
      "Acme — the business owner or self-employed; employed by a party to this transaction",
    ]);
  });
});

describe("the signature says it covers the work answers", () => {
  it("names them in the panel body and in what signing means", () => {
    expect(SIGNING_COPY.panelBody).toContain("what you told us about your work");
    expect(SIGNING_COPY.panelTerms).toContain("what you told us about your work");
  });
});
