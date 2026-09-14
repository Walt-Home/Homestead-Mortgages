/**
 * The loan file, shared by every screen.
 *
 * Screens used to know nothing about the file they were on — `ConnectorStep`
 * began every render at `status: "idle"` and offered a Connect button whether
 * or not the connector had already run. Going back to a completed step showed
 * a fresh form, and clicking it re-pulled. State that lives only in a
 * component dies on refresh; state that lives on the server survives a closed
 * laptop, which is the entire point of "resume where you left off".
 */

import { useQuery } from "@tanstack/react-query";
import type {
  ApplicationReceipt,
  BorrowerDeclaration,
  BorrowerResidence,
  DecisionOutcome,
  Ratios,
} from "@hm/shared";
import { api, ApiError } from "./api.js";

export type { FlowStage } from "./flow.js";
import type { FlowStage } from "./flow.js";

/**
 * The four figures a screen reads off a recorded decision, each null when the
 * engine could not compute it.
 *
 * A `Pick` rather than four fields written out again. The engine records eight
 * ratios and the API sends all eight; four is what the screens read, not what
 * a decision holds. The `Pick` keeps these four bound to `Ratios`, so a figure
 * whose type changes in `@hm/shared` changes here with it, and four fields
 * written out by hand would be this app's second answer to what a ratios block
 * is. A fifth figure is one more name in the list.
 */
export type DecisionRatios = Pick<
  Ratios,
  "housingPitia" | "dtiBack" | "ltv" | "totalQualifyingIncome"
>;

/**
 * The part of the stored decision a screen reads. `outcome` is the word the
 * engine reached, and it — not the arithmetic — decides which ending renders.
 *
 * It lives beside the file rather than on the screen that reads it because
 * `LoanFileView.decision` is typed as it: the review screen and the bank
 * screen each used to cast the same `unknown` to a private shape of its own,
 * one of them carrying the outcome and one of them holding only the ratios, so
 * the two screens did not agree on whether a decision has an outcome at all.
 */
export interface DecisionView {
  outcome: DecisionOutcome;
  ratios: DecisionRatios;
  adverseActionReasons?: string[];
}

export interface LoanFileView {
  id: string;
  stage: FlowStage;
  isDemo: boolean;
  borrowers: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    ssn: { last4: string };
    currentAddress: { line1: string; city: string; state: string; postalCode: string };
    maritalStatus: string;
    citizenship: string | null;
    /** Null until screen 3 asks; derived there from the residence answer. */
    currentHousing: string | null;
    monthlyRent?: number;
    firstTimeHomebuyer: boolean | null;
    /** Present once a verification has been started, whatever its outcome. */
    identityVerification: {
      verificationId: string;
      status: "pending" | "verified" | "failed";
      verifiedAt?: string;
    } | null;
    /**
     * Section 5 and the residence history, as THIS person answered them on
     * screen 3. Null until they have been asked — which the review screen says
     * out loud rather than rendering as a set of clean answers.
     *
     * Per person, because the questions are about the person answering. The
     * review screen showed one file-level copy under whichever name it was
     * rendering, so a co-borrower's block would have read back the applicant's
     * answers above a signature.
     */
    declaration: BorrowerDeclaration | null;
    residences: BorrowerResidence[];
  }[];
  /*
   * There is deliberately no file-level `declaration` or `residences` here,
   * and there is none to leave out: Section 5 and the residence history sit on
   * each borrower above, because there is one set of answers per person and
   * the questions are about the person answering.
   *
   * `LoanFile` used to carry borrower 1's two values at the top as well, and
   * the engine read them from there. A screen that shows answers back is
   * always showing one person's, so that copy rendered under a second name was
   * one borrower's statement attributed to another. It came off the domain
   * type, off the projection and off the wire together, and the engine walks
   * `borrowers` instead — so a reader that reached for the file-level copy
   * today would not compile anywhere, not just here.
   */
  consents: { kind: string; grantedAt: string; revokedAt?: string }[];
  loan: {
    purpose: string;
    loanAmount: number;
    downPayment: number;
    cashToBorrower?: number;
    cashOutPurpose?: string;
  } | null;
  property: {
    address: { line1: string; city: string; state: string; postalCode: string };
    propertyType: string;
    occupancy: string;
    valueOrPrice: number;
  } | null;
  propertyRecord: {
    apn: string;
    county: string;
    propertyType: string;
    priorOwnershipInLastThreeYears: boolean;
    monthlyAssociationDues?: number;
  } | null;
  valuation: unknown | null;
  flood: unknown | null;
  sanctions: unknown | null;
  lienSearch: unknown | null;
  identityVerification: unknown | null;
  credit: unknown | null;
  assets: unknown | null;
  payroll: unknown | null;
  /**
   * Which retrieval last wrote each row `ratios.totalQualifyingIncome` is the
   * sum of. The two screens that put a label on that figure read it, because
   * `assets` above stops being its source the moment a payroll pull replaces
   * the rows.
   */
  qualifyingIncomeReportedBy?: ("bank" | "payroll" | null)[];
  transcripts: unknown[];
  documents: { id: string; filename: string; satisfiesRequirementId: string; bytes: number }[];
  links: { kind: string; provider: string; persistentMonitoringEnabled: boolean }[];
  decision: DecisionView | null;
  /**
   * APP-002's input: when the six pieces were received, and which of them the
   * application holds. Null until the receipt has been stamped, and for a file
   * made before applications existed. Only the debug surface renders it.
   */
  application: ApplicationReceipt | null;
  applicationSignedAt: string | null;
  intentToProceedAt: string | null;
}

/**
 * Where the credit request stands, as the API answers it.
 *
 * Mirrors `apps/api/src/services/standing.ts` minus `causedBy`: that field
 * carries requirement ids and snapshot ids, and nothing in the borrower flow
 * renders one. The debug surface fetches those separately.
 */
export interface ApplicationStandingView {
  id: string;
  status: string;
  statusEnteredAt: string;
  terminal: boolean;
  ledger: {
    seq: number;
    from: string | null;
    to: string;
    event: string;
    reasonCode: string | null;
    actorKind: string;
    occurredAt: string;
  }[];
  clocks: {
    kind: string;
    statuteCitation: string;
    startedAt: string;
    dueAt: string;
    tolledFrom: string | null;
    tollingReason: string | null;
    tolledUntil: string | null;
    satisfiedAt: string | null;
    breachedAt: string | null;
  }[];
  loanEstimate: { dueAt: string; tolled: boolean; tollingReason: string | null } | null;
  /**
   * The terms the application is currently being decided against, in dollars.
   * The counteroffer ending renders them, and `origin` is what makes it
   * honest: `BORROWER` is the loan they asked for, and any other origin is one
   * we proposed.
   */
  scenario: {
    seq: number;
    origin: string;
    loanAmount: number;
    downPayment: number;
    valueEstimate: number | null;
  } | null;
}

/**
 * One file as `GET /api/files` answers it.
 *
 * The list's wire shape, which is a different and much smaller thing than the
 * single file's: no borrower facts, no connector snapshots, no ledger and no
 * clocks. It lives beside `LoanFileView` because both are what a route sends
 * rather than what a component wants, and because the rules that read a row —
 * which screen it resumes to, which of the three groups it ranks in — are not
 * the property of whichever page happens to render a list this week.
 */
export interface FileRow {
  id: string;
  /**
   * The domain spelling, which is now the only one the client sees.
   *
   * Typed rather than left as a bare string because this row is what
   * `STAGE_TO_SCREEN` is indexed with, and a `string` is what let the file
   * list key the map on the spelling the list route sent while every other
   * reader looked it up with the spelling the single-file route sent.
   */
  stage: FlowStage;
  isDemo: boolean;
  /** Whose file it is. A sample borrower's file is a demo file that is theirs. */
  mine: boolean;
  createdAt: string;
  /**
   * The raw enum, not words. `PURCHASE`, `RATE_TERM_REFINANCE`,
   * `CASH_OUT_REFINANCE` — the column untranslated, and null until screen 1 is
   * saved. Turning it into something a borrower reads is this app's job, here
   * and not on the wire: the API writes no copy, and a route that started
   * would be a second place borrower words live.
   */
  purpose: string | null;
  /**
   * Decimal columns, and they arrive as STRINGS: Prisma's `Decimal` serializes
   * through `toJSON`, so `450000.00` crosses the wire as `"450000"`. Typed
   * honestly rather than as a number a reader would then do arithmetic on.
   *
   * Typed because the route sends them, not because anything wants them: no
   * list of files puts a dollar figure next to a loan that has not been priced
   * yet, and there is no formatter here to do it with.
   */
  loanAmount: string | null;
  valueOrPrice: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  borrowers: { firstName: string; lastName: string }[];
  /**
   * The newest decision, or an empty array. At most one — the list takes one
   * row per file — and a word this app has no copy for is dropped server-side
   * rather than failing the request, so the file lists with no decision on it.
   */
  decisions: { outcome: DecisionOutcome; ausRecommendation: string }[];
  applicationState: { status: string; statusEnteredAt: string; terminal: boolean } | null;
  /**
   * Whether the application has been signed.
   *
   * No status says so: `esign` is outside the obligations the reconciler
   * tracks, so a file waiting for a signature and a file waiting for us are
   * both `in_underwriting`, and they are opposite situations — one of them is
   * the borrower's move.
   */
  signed: boolean;
  /**
   * What the file is waiting on the borrower for, as the ledger row rather
   * than as a sentence.
   *
   * These are the three arguments `wordsFor` takes, and they arrive unrendered
   * so that a screen listing files says what the file's own screens say rather
   * than reading a sentence the server chose. Null unless the application is
   * `awaiting_borrower`: the row stays on the ledger forever, and read in any
   * other state it names something already done.
   */
  owes: { event: string; reasonCode: string | null; to: string } | null;
}

export interface LoanFileResponse {
  file: LoanFileView;
  /** Null for a file made before applications existed. Never a draft. */
  applicationState: ApplicationStandingView | null;
}

export function useLoanFile(fileId: string | undefined) {
  return useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.get<LoanFileResponse>(`/files/${fileId}`),
    enabled: Boolean(fileId),
    // A 404 here means "not yours or not there" and will never become a 200.
    // Neither will a projection failure: retrying it only delays the redirect
    // to the repair screen by the backoff.
    retry: (count, err) =>
      !(err instanceof ApiError && err.status === 404) && !needsRepair(err) && count < 2,
  });
}

/**
 * Did the file fail to load because the person behind it will not project?
 *
 * A required identity fact — name, address, SSN token and so on — is missing
 * or blank, so every read of the file throws before any screen gets data.
 * That is not a lost file and not a server outage: saving screen 2 again
 * rewrites the facts and clears it. The shell routes there on this answer,
 * because a screen with no file data has nothing to offer and no button on
 * it can do the rewrite.
 */
export function needsRepair(error: unknown): boolean {
  return error instanceof ApiError && error.code === "PROJECTION_ERROR";
}

/**
 * The screen a file has to be on instead of the one that was asked for.
 *
 * Null is "leave it where it is". The only answer this gives is the review
 * screen, and only for an application that has ended or is held: a withdrawn,
 * canceled or declined file opened at the bank screen asks the borrower to
 * connect a bank for a request that is over, and a file suspended on a
 * sanctions near-match asks the same for one that is stopped. The work would
 * not land either: `pinTridPieces` refuses an application that has ended, so a
 * save on one writes a row and moves nothing.
 *
 * `screen` is the last path segment, not the step the shell is highlighting —
 * a branch path renders under the review step and would otherwise look like it
 * had already landed. The review screen itself is exempt, or the redirect
 * would have nowhere to go.
 */
export function landingScreen(
  application: { readonly status: string; readonly terminal: boolean } | null | undefined,
  screen: string,
): "review" | null {
  return hasStopped(application) && screen !== "review" ? "review" : null;
}

/**
 * Whether there is any more work to do on this file.
 *
 * An application that has ended, or is held on somebody else's answer, is a
 * file nothing may be added to — which is why the shell will not open one on
 * a working screen. The step indicator asks the same question: a row of
 * segments with one lit says a borrower is partway through something, and a
 * withdrawn or funded file painted that line directly above the pill saying
 * otherwise.
 *
 * `undefined` is a file that has not been read yet and answers false, the
 * same as everywhere else: a claim about a regulated record cannot be made
 * while the record is still loading.
 */
export function hasStopped(
  application: { readonly status: string; readonly terminal: boolean } | null | undefined,
): boolean {
  if (!application) return false;
  // A declined file awaiting its notice is stopped for the borrower even
  // though the machine keeps it live until the notice is delivered: there is
  // no step left for them to take, so it must not wear a progress bar and must
  // not be resumable into a step screen.
  return (
    application.terminal ||
    application.status === "suspended" ||
    application.status === "adverse_action_pending"
  );
}

export function hasConsent(file: LoanFileView | undefined, kind: string): boolean {
  return Boolean(file?.consents.some((c) => c.kind === kind && !c.revokedAt));
}
