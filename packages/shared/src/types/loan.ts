/** Loan terms, the subject property, and the product being underwritten. */

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

export interface ProductSelection {
  readonly productCode: string;
  readonly termMonths: number;
  readonly amortization: "fixed" | "arm";
  readonly noteRate: number;
  /** Lender/investor overlays beyond the agency guide. Empty means none apply. */
  readonly overlays: readonly string[];
}
