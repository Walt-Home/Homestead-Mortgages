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
  intentToProceedAt: string | null;
}

export interface LoanFileResponse {
  file: LoanFileView;
  loanEstimateDueAt: string | null;
}

export function useLoanFile(fileId: string | undefined) {
  return useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.get<LoanFileResponse>(`/files/${fileId}`),
    enabled: Boolean(fileId),
    // A 404 here means "not yours or not there" and will never become a 200.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

export function hasConsent(file: LoanFileView | undefined, kind: string): boolean {
  return Boolean(file?.consents.some((c) => c.kind === kind && !c.revokedAt));
}
