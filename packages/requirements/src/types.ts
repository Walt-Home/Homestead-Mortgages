/**
 * The shape of a single underwriting requirement.
 *
 * One row of `data/v1-build.csv` becomes one of these. The registry in
 * `generated.ts` is the only place they are constructed; everything else in
 * the product reads them.
 */

/** The ten screens of the onboarding flow, in order. */
export type ScreenId =
  | "property_loan"
  | "identity"
  | "credit"
  | "declarations"
  | "bank"
  | "payroll"
  | "irs_transcript"
  | "upload_fallback"
  | "decision"
  | "persistent_consent";

/**
 * Where the evidence for a requirement comes from.
 *
 * This is the field that decides whether a requirement costs the borrower
 * typing, a connector handshake, a signature, or nothing at all. Screen 9's
 * 31 requirements are almost entirely `derived` — they are the payoff for
 * everything collected on screens 1–8.
 */
export type RequirementSource =
  | "borrower_input"
  | "connect_credit"
  | "connect_bank"
  | "connect_payroll"
  | "connect_irs"
  | "esign"
  | "third_party_order"
  | "document_upload"
  | "derived";

/** What happens if the requirement is not satisfied. Drives triage order. */
export type FailureSeverity =
  "regulatory_violation" | "repurchase_unsaleable" | "financial_loss" | "rework_delay";

/**
 * Whether a connector can satisfy this on day one without human follow-up.
 * Drew's "Day 1 Certainty" column. Eight requirements carry it, and they are
 * the ones that make the instant-decision claim credible.
 */
export type DayOneCertainty = "assets" | "income" | "employment";

/** Machine key for the `Applies when` column. Predicates live in conditions.ts. */
export type ConditionKey =
  | "universal"
  | "purchase"
  | "refinance"
  | "cash_out_refinance"
  | "community_property_state"
  | "electronic_delivery"
  | "borrower_lep"
  | "borrowed_funds_used"
  | "prior_significant_derogatory"
  | "dispute_flag"
  | "large_deposit_present"
  | "retirement_assets_used"
  | "thin_credit_file"
  | "asset_report_available"
  | "renter_limited_mortgage_history"
  | "wage_earner"
  | "retirement_income_used"
  | "investment_income_used"
  | "variable_income_present"
  | "employment_gap"
  | "military_borrower"
  | "self_employed_variable_or_rental"
  | "gift_funds_used"
  | "prior_bankruptcy"
  | "recent_derogatory"
  | "recent_inquiries"
  | "ssn_mismatch_or_fraud_alert"
  | "support_income_used"
  | "equity_comp_used"
  | "refi_ntb_required"
  | "reserves_required"
  | "ipc_present"
  | "aus_refer_or_ineligible"
  | "overlays_exist"
  | "denial_or_counteroffer"
  | "declared_homeowner_past_three_years"
  | "declared_bankruptcy"
  | "current_residence_under_two_years"
  | "current_employment";

/** Named moments the flow can be timed against, independent of any requirement. */
export type TimingEvent =
  | "application"
  | "application_and_before_funding"
  | "any_verification_pull"
  | "first_electronic_disclosure"
  | "closing"
  | "le_receipt"
  | "le_delivery"
  | "intake_complete";

/**
 * When a requirement must be satisfied.
 *
 * `before`/`after` with `refs` are what make the registry a graph rather than
 * a list — see `graph.ts`. `deadline` is a clock the product has to run: the
 * three-business-day Loan Estimate deadline is a `regulatory_violation` row,
 * so missing it is not a soft failure.
 */
export type TimingConstraint =
  | { kind: "at"; event: TimingEvent; prose: string }
  | { kind: "with"; event: TimingEvent; prose: string }
  | { kind: "before"; event: TimingEvent; prose: string }
  | { kind: "before"; refs: readonly string[]; prose: string }
  | { kind: "after"; event: TimingEvent; prose: string }
  | { kind: "after"; refs: readonly string[]; prose: string }
  | { kind: "starts_clock"; clock: "le_3_business_day"; prose: string }
  | {
      kind: "deadline";
      from: "application" | "complete_application" | "requirement";
      refs?: readonly string[];
      amount: number;
      unit: "business_days" | "calendar_days";
      prose: string;
    };

export interface Requirement {
  /** e.g. "APP-002". Stable across sheet revisions; treat as the public key. */
  readonly id: string;
  /** "APP" | "AST" | "CRD" | "INC" | "UW" — the prefix, kept for grouping. */
  readonly family: string;
  readonly screen: ScreenId;
  readonly screenOrdinal: number;
  readonly source: RequirementSource;
  /** Drew's one-line statement of the requirement. Safe to show a borrower. */
  readonly statement: string;
  /** The data points that satisfy it, as written in the sheet. */
  readonly fields: string;
  /** Acceptable evidence, split on the sheet's semicolons. Any one suffices. */
  readonly evidence: readonly string[];
  readonly condition: ConditionKey;
  /** The `Applies when` cell verbatim, for explaining the ask to a borrower. */
  readonly conditionProse: string;
  readonly dayOneCertainty: DayOneCertainty | null;
  readonly failureSeverity: FailureSeverity;
  readonly timing: TimingConstraint;
}

/** A timing reference to a requirement that no row in the sheet defines. */
export interface DanglingReference {
  readonly from: string;
  readonly to: string;
}
