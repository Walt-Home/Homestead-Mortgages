/** Everything the four connectors bring back, in the shape the engine wants. */

/* ── Credit ─────────────────────────────────────────────────────────────── */

export type Bureau = "equifax" | "experian" | "transunion";

export interface CreditScore {
  readonly bureau: Bureau;
  readonly score: number;
  readonly model: string;
}

export type TradelineType =
  "mortgage" | "revolving" | "installment" | "auto" | "student" | "heloc" | "other";

export interface Tradeline {
  readonly id: string;
  readonly creditorName: string;
  readonly type: TradelineType;
  readonly balance: number;
  readonly monthlyPayment: number;
  readonly creditLimit?: number;
  readonly openedDate: string;
  readonly disputed: boolean;
  /** Most recent 24 months, newest first. "0" current, "1"=30d, "2"=60d, … */
  readonly paymentHistory: readonly string[];
  readonly maxDelinquency: number;
  /**
   * Set when the liability is deliberately left out of DTI (CRD-003). A
   * tradeline with neither a monthly payment in DTI nor a reason code here is
   * the unreconciled state that makes a loan unsaleable.
   */
  readonly exclusionReasonCode?: string;
}

export type PublicRecordType =
  "bankruptcy" | "foreclosure" | "short_sale" | "deed_in_lieu" | "judgment" | "tax_lien";

export interface PublicRecord {
  readonly type: PublicRecordType;
  readonly date: string;
  readonly status: string;
  /** Chapter 7 / 11 / 13, on a bankruptcy. Drives the seasoning minimum. */
  readonly chapter?: string;
  readonly dischargeDate?: string;
}

export interface CreditInquiry {
  readonly creditorName: string;
  readonly date: string;
  /** Resolved by the borrower: did this inquiry produce new debt? */
  readonly resultedInNewDebt: boolean | null;
}

export interface CreditReport {
  readonly reportId: string;
  readonly reportDate: string;
  readonly pullType: "soft" | "hard";
  readonly scores: readonly CreditScore[];
  readonly tradelines: readonly Tradeline[];
  readonly publicRecords: readonly PublicRecord[];
  readonly inquiries: readonly CreditInquiry[];
  readonly fraudAlert: boolean;
  readonly ssnMismatch: boolean;
}

/* ── Assets ─────────────────────────────────────────────────────────────── */

export type DepositAccountType =
  "checking" | "savings" | "money_market" | "brokerage" | "retirement";

export interface DepositAccount {
  readonly id: string;
  readonly institution: string;
  readonly type: DepositAccountType;
  readonly mask: string;
  readonly currentBalance: number;
  /** Month-end balances, newest first. Two months is the documented minimum. */
  readonly balanceHistory: readonly { month: string; balance: number }[];
  /** Retirement only — what the borrower could actually withdraw. */
  readonly vestedBalance?: number;
  readonly outstandingPlanLoans?: number;
  readonly withdrawalEligible?: boolean;
  /** Whether the borrower is using this account to qualify. */
  readonly usedForQualifying: boolean;
}

export interface Deposit {
  readonly accountId: string;
  readonly date: string;
  readonly amount: number;
  readonly description: string;
  readonly sourceType?: string;
  readonly evidenceDocumentId?: string;
}

export interface GiftFunds {
  readonly amount: number;
  readonly donorName: string;
  readonly donorRelationship: string;
  readonly transferDate: string;
  readonly donorAbilityEvidenceId?: string;
}

export interface BorrowedFunds {
  readonly amount: number;
  readonly securedBy: string;
  readonly monthlyPayment: number;
  readonly agreementDocumentId?: string;
}

/** A recurring payment that can stand in for a tradeline on a thin file. */
export interface AlternativeReference {
  readonly kind: "rent" | "utility" | "insurance" | "phone" | "other";
  readonly payeeName: string;
  readonly monthsOfHistory: number;
  readonly monthlyAmount: number;
  readonly onTime: boolean;
}

/**
 * The 12-month bank connection. Drew calls this "the one that matters" and the
 * sheet agrees — 13 requirements name it as their source, and it is the only
 * connector that produces assets, income, employment, cash flow and rent
 * history from a single handshake.
 */
export interface AssetReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly monthsCovered: number;
  /** Only a DU-authorized vendor's report satisfies CRD-017. */
  readonly vendorAuthorizedForDu: boolean;
  readonly accounts: readonly DepositAccount[];
  readonly largeDeposits: readonly Deposit[];
  readonly cashFlowAssessmentResult?: string;
  /** Consecutive on-time rent payments the report could identify (CRD-018). */
  readonly identifiedRentPayments: number;
  /**
   * Recurring obligations the report can evidence as alternative credit —
   * rent, utilities, insurance, phone. CRD-013 wants three with twelve months
   * of history each, which is why this is a list and not a rent-only count.
   */
  readonly alternativeReferences: readonly AlternativeReference[];
  readonly identifiedMonthlyRent?: number;
  readonly gifts: readonly GiftFunds[];
  readonly borrowedFunds: readonly BorrowedFunds[];
  readonly earnestMoneyVerified: boolean;
}

/* ── Employment and income ──────────────────────────────────────────────── */

export type IncomeSourceType =
  | "base_wage"
  | "overtime"
  | "bonus"
  | "commission"
  | "self_employment"
  | "rental"
  | "retirement"
  | "pension"
  | "social_security"
  | "investment"
  | "dividend"
  | "alimony"
  | "child_support"
  | "equity_compensation"
  | "military_entitlement";

export interface IncomeSource {
  readonly type: IncomeSourceType;
  readonly monthlyAmount: number;
  /** Months of history behind the figure. Variable income needs 12 or 24. */
  readonly historyMonths: number;
  /** ISO date the income is documented to continue to, where it ends. */
  readonly continuanceEndDate?: string;
  /** Set once INC-027 has run: does it continue at least 36 months? */
  readonly continuanceEstablished: boolean | null;
  readonly evidenceDocumentIds: readonly string[];
}

export interface EmploymentRecord {
  readonly employerName: string;
  readonly employerEin?: string;
  readonly position: string;
  readonly startDate: string;
  readonly endDate?: string;
  readonly status: "active" | "ended";
  readonly isMilitary: boolean;
  readonly verificationMethod: "voe" | "paystub_w2" | "payroll_connector" | "bank_inference";
}

export interface EmploymentGap {
  readonly startDate: string;
  readonly endDate: string;
  readonly days: number;
  readonly reasonCode?: string;
  readonly explanationDocumentId?: string;
}

export interface Paystub {
  readonly payPeriodEnd: string;
  readonly grossPay: number;
  readonly ytdGross: number;
}

export interface W2Record {
  readonly taxYear: number;
  readonly employerEin: string;
  readonly wages: number;
}

export interface PayrollData {
  readonly connectionId: string;
  readonly employments: readonly EmploymentRecord[];
  readonly paystubs: readonly Paystub[];
  readonly gaps: readonly EmploymentGap[];
  readonly incomeSources: readonly IncomeSource[];
}

/* ── IRS ────────────────────────────────────────────────────────────────── */

export interface TaxTranscript {
  readonly taxYear: number;
  readonly agi: number;
  readonly wages: number;
  readonly transcriptType: "return" | "wage_and_income" | "account";
  readonly retrievedAt: string;
}

/* ── Uploaded documents ─────────────────────────────────────────────────── */

export interface UploadedDocument {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly uploadedAt: string;
  /** Which requirement the borrower was asked to satisfy with this file. */
  readonly satisfiesRequirementId: string;
  readonly storageUri: string;
}
