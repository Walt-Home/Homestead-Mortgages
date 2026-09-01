/** What screen 8 computes, and how it explains itself. */

/**
 * The AUS recommendation.
 *
 * V1 produces these from our own engine (`@sm/underwriting`) rather than from
 * Desktop Underwriter, because a real DU submission needs a seller/servicer
 * number and returns a verdict we cannot decompose for the borrower. The shape
 * matches DU's so a real submission can replace the shadow engine behind the
 * same interface — see `docs/decisions.md`.
 */
export type AusRecommendation =
  | "approve_eligible"
  | "approve_ineligible"
  | "refer"
  | "refer_with_caution"
  | "out_of_scope";

export interface AusFinding {
  /** The requirement this finding maps to, where one exists (UW-003). */
  readonly requirementId?: string;
  readonly code: string;
  readonly message: string;
  readonly category: "credit" | "income" | "asset" | "property" | "eligibility";
}

export interface AusResult {
  readonly casefileId: string;
  readonly submittedAt: string;
  readonly recommendation: AusRecommendation;
  readonly findings: readonly AusFinding[];
  /** "shadow" until a real DU or LPA integration is wired in. */
  readonly engine: "shadow" | "du" | "lpa";
  readonly engineVersion: string;
}

/**
 * One step of a computation, kept so the decision screen can show its work.
 *
 * Drew's note on screen 8 is "show the reasoning, not just a verdict", and
 * this is the mechanism. Every derived number in the product carries the
 * inputs it came from and the requirement that demanded it.
 */
export interface Derivation {
  readonly requirementId: string;
  readonly label: string;
  readonly value: number | string | boolean | null;
  readonly formula: string;
  readonly inputs: Readonly<Record<string, number | string | boolean | null>>;
  /** Set when the value could not be computed, naming what is missing. */
  readonly blockedBy?: readonly string[];
}

export interface Ratios {
  readonly dtiFront: number | null;
  readonly dtiBack: number | null;
  readonly ltv: number | null;
  readonly cltv: number | null;
  readonly hcltv: number | null;
  readonly housingPitia: number | null;
  readonly totalMonthlyDebt: number | null;
  readonly totalQualifyingIncome: number | null;
}

export interface ReserveAssessment {
  readonly requiredMonths: number | null;
  readonly actualMonths: number | null;
  readonly eligiblePostCloseAssets: number | null;
  readonly satisfied: boolean | null;
}

export type ConditionStatus = "open" | "submitted" | "cleared" | "waived";

/**
 * A tracked condition. Every AUS verification message becomes one (UW-003),
 * and clearing all of them is what UW-017 means by Clear to Close.
 */
export interface LoanCondition {
  readonly id: string;
  readonly requirementId: string;
  readonly description: string;
  readonly status: ConditionStatus;
  readonly issuedAt: string;
  readonly clearedAt?: string;
  readonly documentIds: readonly string[];
  /** Who has to act. Drives whether it shows on the borrower's list at all. */
  readonly owner: "borrower" | "lender" | "third_party";
}

export interface ComplianceTests {
  readonly atrDetermination: "documented" | "not_documented" | null;
  readonly qmStatus: "qm" | "non_qm" | null;
  readonly qmType?: string;
  readonly pointsAndFeesRatio: number | null;
  readonly pointsAndFeesPass: boolean | null;
  readonly hpmlSpread: number | null;
  readonly isHpml: boolean | null;
  readonly isHighCost: boolean | null;
  /** Refi only, where state or investor requires it (APP-019). */
  readonly netTangibleBenefit?: {
    readonly paymentDelta: number;
    readonly rateDelta: number;
    readonly recoupMonths: number;
    readonly thresholdMonths: number;
    readonly satisfied: boolean;
  };
}

export type DecisionOutcome =
  | "pending"
  | "approved_with_conditions"
  | "clear_to_close"
  | "counteroffer"
  | "denied";

export interface Decision {
  readonly outcome: DecisionOutcome;
  readonly computedAt: string;
  readonly aus: AusResult | null;
  readonly ratios: Ratios;
  readonly reserves: ReserveAssessment;
  readonly compliance: ComplianceTests;
  readonly pricing: {
    readonly llpaTotalBps: number | null;
    readonly adjustments: readonly { reason: string; bps: number }[];
  };
  readonly conditions: readonly LoanCondition[];
  /** The full audit trail behind every number above. */
  readonly derivations: readonly Derivation[];
  /** Principal reasons, required on a denial or counteroffer (UW-016). */
  readonly adverseActionReasons?: readonly string[];
}

/** Disclosure delivery, tracked because three of them are on a clock. */
export interface DisclosureRecord {
  readonly kind:
    | "loan_estimate"
    | "written_list_of_service_providers"
    | "homeownership_counseling_list"
    | "home_loan_toolkit"
    | "adverse_action";
  readonly deliveredAt: string;
  readonly method: "electronic" | "mail";
  readonly documentId: string;
}
