/** Loan terms, the subject property, and the product being underwritten. */

import type { PropertyEstateType } from "./declaration.js";

export type LoanPurpose = "purchase" | "rate_term_refinance" | "cash_out_refinance";
export type OccupancyType = "primary_residence" | "second_home" | "investment";
export type PropertyType =
  "single_family" | "condo" | "townhouse" | "two_to_four_unit" | "manufactured" | "co_op";

/** US state, two letters. Kept as a string so the sheet's community-property
 *  and state-NTB lists stay data rather than a type-level enumeration. */
export type StateCode = string;

export interface Address {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state: StateCode;
  readonly postalCode: string;
}

export interface SubjectProperty {
  readonly address: Address;
  /** True once the address has been matched against public record (APP-004). */
  readonly deliverableAddressVerified: boolean;
  readonly propertyType: PropertyType;
  /**
   * Fee simple, or a leasehold on land somebody else owns.
   *
   * Null until screen 3 asks (APP-028). Nothing retrieves it — no assessor
   * record, valuation or flood determination carries it, and the title
   * commitment that settles it does not exist when a casefile is submitted —
   * so the third state is "not asked yet" rather than "fee simple".
   */
  readonly estateType: PropertyEstateType | null;
  readonly occupancy: OccupancyType;
  /** Purchase price, or estimated value on a refinance. */
  readonly valueOrPrice: number;
  /** Where `valueOrPrice` came from — an ATTOM estimate is not an appraisal. */
  readonly valuationSource: "borrower_stated" | "attom_estimate" | "appraisal" | "avm";
  /** Count of financed properties the borrower owns. Drives reserve tiers. */
  readonly financedPropertyCount: number;
  /**
   * HOA or condo association dues. The A in PITIA, and part of the housing
   * payment DTI is measured against — assuming zero for a condo understates
   * the payment by a few hundred dollars a month.
   */
  readonly monthlyAssociationDues?: number;
}

export interface ExistingLoan {
  readonly servicer: string;
  readonly loanNumber: string;
  readonly balance: number;
  readonly rate: number;
  readonly monthlyPayment: number;
}

export interface LoanTerms {
  readonly purpose: LoanPurpose;
  readonly loanAmount: number;
  readonly downPayment: number;
  /** Set on a cash-out refi. Distinguishes limited from true cash-out (AST-012). */
  readonly cashToBorrower?: number;
  readonly cashOutPurpose?: string;
  /** Junior liens behind this one, for CLTV/HCLTV (UW-005). */
  readonly juniorLienBalance: number;
  readonly juniorLienCreditLimit: number;
  /** Seller and lender credits, for the IPC limit test (AST-016). */
  readonly interestedPartyContributions: number;
  /** Populated on a refinance from the credit pull or a mortgage statement. */
  readonly existingLoan?: ExistingLoan;
}

/**
 * How the loan amortizes, spelled the way Desktop Underwriter spells it.
 *
 * The product row holds the DU enumeration itself rather than a word of ours,
 * so there is nothing to translate between the column and the element. GEM and
 * GPM are products this lender does not offer; the set is Fannie Mae's, and
 * trimming it would go stale the day somebody quotes one.
 */
export type AmortizationType = "AdjustableRate" | "Fixed" | "GEM" | "GPM" | "Other";

export interface ProductSelection {
  readonly productCode: string;
  readonly termMonths: number;
  /**
   * Read off the product, not off the file. A rate and a term are quoted per
   * borrower; whether the loan amortizes at all is what the product IS, and the
   * indicators beside it — balloon, interest-only, negative amortization — live
   * on the same row so they cannot contradict it.
   */
  readonly amortization: AmortizationType;
  readonly noteRate: number;
  /** Lender/investor overlays beyond the agency guide. Empty means none apply. */
  readonly overlays: readonly string[];
}
