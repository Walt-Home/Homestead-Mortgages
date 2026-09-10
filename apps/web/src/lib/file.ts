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
import type { ApplicationReceipt } from "@hm/shared";
import { api, ApiError } from "./api.js";

export type { FlowStage } from "./flow.js";
import type { FlowStage } from "./flow.js";

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
    currentHousing: string;
    monthlyRent?: number;
    firstTimeHomebuyer: boolean | null;
    /** Present once a verification has been started, whatever its outcome. */
    identityVerification: {
      verificationId: string;
      status: "pending" | "verified" | "failed";
      verifiedAt?: string;
    } | null;
  }[];
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
  transcripts: unknown[];
  documents: { id: string; filename: string; satisfiesRequirementId: string; bytes: number }[];
  links: { kind: string; provider: string; persistentMonitoringEnabled: boolean }[];
  decision: unknown | null;
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
 * a working screen. The step indicator asks the same question: four segments
 * with one lit says a borrower is partway through something, and a withdrawn
 * or funded file painted that line directly above the pill saying otherwise.
 *
 * `undefined` is a file that has not been read yet and answers false, the
 * same as everywhere else: a claim about a regulated record cannot be made
 * while the record is still loading.
 */
export function hasStopped(
  application: { readonly status: string; readonly terminal: boolean } | null | undefined,
): boolean {
  if (!application) return false;
  return application.terminal || application.status === "suspended";
}

export function hasConsent(file: LoanFileView | undefined, kind: string): boolean {
  return Boolean(file?.consents.some((c) => c.kind === kind && !c.revokedAt));
}
