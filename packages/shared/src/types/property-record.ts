/**
 * Public-record and screening data — everything retrieved *about* a property
 * or a person rather than supplied by them.
 *
 * The four-screen flow exists because of this file. Screen 1 asks six fields
 * and displays sixteen, and the difference is `PropertyRecord`, `AvmEstimate`
 * and `FloodDetermination`. Screen 4's derived declarations replace seven URLA
 * questions, and the difference is `LienSearch` plus `PropertyRecord.priorOwnership`.
 *
 * A borrower asked to type their own APN is a borrower who will get it wrong.
 */

import type { Address, PropertyType } from "./loan.js";

/* ── Address ────────────────────────────────────────────────────────────── */

/**
 * One autocomplete candidate. Unguarded on purpose — this runs on screen 1,
 * before any consent exists, and it carries nothing but a partial address the
 * borrower is in the middle of typing.
 */
export interface AddressSuggestion {
  readonly id: string;
  /** Single-line form, as shown in the dropdown. */
  readonly label: string;
  readonly address: Address;
}

/* ── Assessor / public record ───────────────────────────────────────────── */

export interface PropertySale {
  readonly soldOn: string;
  readonly price: number;
}

/**
 * What the county knows. Everything here is displayed for confirmation on
 * screen 1 and none of it is typed.
 *
 * `annualPropertyTax` is the interesting one: `calculations.ts` currently
 * estimates taxes at 1.1% of value nationally, and `docs/decisions.md` calls
 * replacing that "the single highest-value accuracy improvement available".
 * This field is where a real number would come from. The engine is not
 * rewired to prefer it here — that is a decision change, not a flow change —
 * but the data now arrives.
 */
export interface PropertyRecord {
  readonly apn: string;
  readonly county: string;
  readonly legalDescription: string;
  readonly propertyType: PropertyType;
  readonly units: number;
  readonly yearBuilt: number;
  readonly squareFeet: number;
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly lotSizeSqFt: number;
  readonly assessedValue: number;
  readonly annualPropertyTax: number;
  readonly hoaExists: boolean;
  readonly monthlyAssociationDues?: number;
  readonly ownerOfRecord: string;
  readonly lastSale?: PropertySale;
  /**
   * Whether this borrower held an ownership interest in a principal residence
   * in the prior three years. Answers the first-time-homebuyer question and
   * one of screen 4's five derived declarations, so it is never asked.
   */
  readonly priorOwnershipInLastThreeYears: boolean;
}

/* ── Valuation ──────────────────────────────────────────────────────────── */

/**
 * An automated valuation. Not an appraisal, and `SubjectProperty.valuationSource`
 * carries the distinction all the way into the decision — a file valued at
 * `"avm"` has not had a human look at the property.
 */
export interface AvmEstimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
  /** 0–100. Below roughly 70 an appraisal is not optional. */
  readonly confidence: number;
  readonly asOf: string;
}

/* ── Flood ──────────────────────────────────────────────────────────────── */

/**
 * FEMA determination. Zones beginning A or V are Special Flood Hazard Areas,
 * where insurance is mandatory on a federally related mortgage — which is why
 * `insuranceRequired` is recorded rather than inferred at render time.
 */
export interface FloodDetermination {
  readonly zone: string;
  readonly communityId: string;
  readonly inSpecialFloodHazardArea: boolean;
  readonly nfipParticipating: boolean;
  readonly insuranceRequired: boolean;
  readonly determinedOn: string;
}

/* ── Screening ──────────────────────────────────────────────────────────── */

export interface SanctionsMatch {
  readonly listName: string;
  readonly matchedName: string;
  /** 0–100. A near-match needs clearing by a human before the file moves. */
  readonly score: number;
}

/**
 * OFAC/SDN screening (CRD-010). `clear` false with an empty `matches` is not a
 * representable state: a screen that failed to run leaves the loan file's
 * `sanctionsScreenClear` null instead, because "not screened" and "screened
 * and matched" are different facts and only one of them blocks a file.
 */
export interface SanctionsScreening {
  readonly clear: boolean;
  readonly matches: readonly SanctionsMatch[];
  readonly listsChecked: readonly string[];
  readonly screenedAt: string;
}

/* ── Liens ──────────────────────────────────────────────────────────────── */

export type LienKind =
  "mortgage" | "heloc" | "tax_lien" | "judgment" | "mechanics_lien" | "federal_debt" | "other";

export interface LienRecord {
  readonly kind: LienKind;
  readonly holder: string;
  readonly recordedOn: string;
  readonly amount: number;
  readonly position?: number;
  readonly released: boolean;
}

/**
 * An ownership-and-encumbrance search against the APN from screen 1.
 *
 * Two of screen 4's derived declarations come from here — delinquent federal
 * debt, and foreclosure or short sale in the property history — so this is
 * what lets the review screen state five facts instead of asking seven
 * questions.
 */
export interface LienSearch {
  readonly apn: string;
  readonly liens: readonly LienRecord[];
  readonly delinquentFederalDebt: boolean;
  readonly foreclosureOrShortSaleInHistory: boolean;
  readonly searchedAt: string;
}

/* ── Identity ───────────────────────────────────────────────────────────── */

export type IdentityDocumentType = "drivers_license" | "passport" | "state_id";

/**
 * The result of a document scan and selfie check.
 *
 * Name, date of birth and address come off the document, which is why screen 2
 * asks for seven items rather than the eleven the old identity screen asked
 * for. Unguarded, for the same reason the e-sign adapter is: this runs before
 * the verification authorization is signed, and guarding it would make the
 * authorization unobtainable.
 */
export interface IdentityVerification {
  readonly documentType: IdentityDocumentType;
  readonly documentExpiresOn: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly address: Address;
  /** 0–100 liveness score from the selfie comparison. */
  readonly selfieLiveness: number;
  readonly documentAuthentic: boolean;
  readonly verifiedAt: string;
}
