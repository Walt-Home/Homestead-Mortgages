/** What screen 8 computes, and how it explains itself. */

/**
 * The AUS recommendation.
 *
 * V1 produces these from our own engine (`@hm/underwriting`) rather than from
 * Desktop Underwriter, because a real DU submission needs a seller/servicer
 * number and returns a verdict we cannot decompose for the borrower. The shape
 * matches DU's so a real submission can replace the shadow engine behind the
 * same interface — see `docs/decisions.md`.
 */
export const AUS_RECOMMENDATIONS = [
  "approve_eligible",
  "approve_ineligible",
  "refer",
  "refer_with_caution",
  "out_of_scope",
] as const;

export type AusRecommendation = (typeof AUS_RECOMMENDATIONS)[number];

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

/**
 * The shadow AUS's ratios.
 *
 * Every figure here is one Desktop Underwriter derives for itself from the
 * inputs we send — the loan amount, the note rate, the value, each liability's
 * payment and balance, each asset's value, each income item — and none has a
 * destination in the DU Map: the schema admits the MISMO elements, the Map
 * lists none of them, and no sample carries one. So these are ours to show a
 * borrower where they stand and never ours to assert to DU. `DU_DERIVED_FIGURES`
 * below is that boundary as data, and a test in `packages/du` holds the Map to
 * it. Null is "could not compute"; the derivation log says what was missing.
 */
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

/** What the engine writes when nothing could be computed: every figure null. */
export const UNCOMPUTED_RATIOS: Ratios = {
  dtiFront: null,
  dtiBack: null,
  ltv: null,
  cltv: null,
  hcltv: null,
  housingPitia: null,
  totalMonthlyDebt: null,
  totalQualifyingIncome: null,
};

export const UNCOMPUTED_RESERVES: ReserveAssessment = {
  requiredMonths: null,
  actualMonths: null,
  eligiblePostCloseAssets: null,
  satisfied: null,
};

/**
 * The compute boundary, figure by figure.
 *
 * `mismo` is the element MISMO defines for the figure — the one Desktop
 * Underwriter would have to list in its Map for us to assert it, and does
 * not; null where MISMO has no single element for it. `from` names the data
 * points in the Map that DU derives it from, which is what the assembler
 * sends instead. `packages/du/src/__tests__/boundary.test.ts` checks both
 * columns against the generated Map: none of the `mismo` names is listed, and
 * every `from` name is.
 *
 * What is NOT here has no DU counterpart of any kind: the compliance block,
 * the pricing, the outcome, the adverse-action reasons and the derivations
 * are ours alone. And none of it is a `DERIVED` fact: a decision is an
 * append-only snapshot with its own provenance columns, and `decisions` is
 * where derived figures live; `FactSourceKind.DERIVED` stays unused on
 * purpose.
 */
export const DU_DERIVED_FIGURES: Readonly<
  Record<
    keyof Ratios | keyof ReserveAssessment,
    { readonly mismo: string | null; readonly from: readonly string[] }
  >
> = {
  dtiFront: {
    mismo: "HousingExpenseRatioPercent",
    from: ["CurrentIncomeMonthlyTotalAmount", "BaseLoanAmount", "NoteRatePercent"],
  },
  dtiBack: {
    mismo: "TotalDebtExpenseRatioPercent",
    from: ["CurrentIncomeMonthlyTotalAmount", "LiabilityMonthlyPaymentAmount", "BaseLoanAmount"],
  },
  ltv: { mismo: "LTVRatioPercent", from: ["BaseLoanAmount", "PropertyEstimatedValueAmount"] },
  cltv: {
    mismo: "CombinedLTVRatioPercent",
    from: ["BaseLoanAmount", "LiabilityUnpaidBalanceAmount", "PropertyEstimatedValueAmount"],
  },
  hcltv: {
    mismo: "HomeEquityCombinedLTVRatioPercent",
    from: ["BaseLoanAmount", "HELOCMaximumBalanceAmount", "PropertyEstimatedValueAmount"],
  },
  // The proposed housing payment. MISMO carries it as HOUSING_EXPENSE rows
  // by component rather than as one figure, and those rows are the lender's
  // to state (docs/du-readiness.md, the tables not yet modeled).
  housingPitia: { mismo: null, from: ["BaseLoanAmount", "NoteRatePercent"] },
  totalMonthlyDebt: {
    mismo: "TotalLiabilitiesMonthlyPaymentAmount",
    from: ["LiabilityMonthlyPaymentAmount"],
  },
  // Ours narrows the sum by continuance (INC-026); the assembler sends every
  // income item unfiltered and DU applies its own.
  totalQualifyingIncome: {
    mismo: "BorrowerQualifyingIncomeAmount",
    from: ["CurrentIncomeMonthlyTotalAmount"],
  },
  requiredMonths: { mismo: "BorrowerReservesMonthlyPaymentCount", from: ["BaseLoanAmount"] },
  actualMonths: {
    mismo: "BorrowerReservesMonthlyPaymentCount",
    from: ["AssetCashOrMarketValueAmount", "BaseLoanAmount", "NoteRatePercent"],
  },
  eligiblePostCloseAssets: { mismo: null, from: ["AssetCashOrMarketValueAmount"] },
  satisfied: { mismo: null, from: ["AssetCashOrMarketValueAmount", "BaseLoanAmount"] },
};

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
  /**
   * HOEPA's three triggers, carried rather than re-derived.
   *
   * §1026.32(a)(1) has three: the rate, the points and fees, and the
   * prepayment penalty. `isHighCost` is their OR, and an OR loses which side
   * was true — so `adverseActionReasonsFor` used to recompute them from
   * `hpmlSpread` and `pointsAndFeesRatio`, both of which are ROUNDED for the
   * screen. A ratio of 4.996 records as 5.00, and a Regulation B notice then
   * told a borrower the fees were above a limit they were under. A notice that
   * names the wrong reason is worse than one that names none.
   *
   * Three-valued for the same reason `isHighCost` is: `null` is a trigger that
   * was not asked, and the prepayment-penalty one is null whenever the product
   * carries a penalty, because a bare boolean cannot say whether it is
   * chargeable past 36 months or above 2% of the amount prepaid.
   *
   * Optional only so a decision stored before this existed still parses.
   */
  readonly hoepaTriggers?: {
    readonly apr: boolean | null;
    readonly pointsAndFees: boolean | null;
    readonly prepaymentPenalty: boolean | null;
  };
  /** Refi only, where state or investor requires it (APP-019). */
  readonly netTangibleBenefit?: {
    readonly paymentDelta: number;
    /**
     * Old rate minus new, or null when nothing on file carries the old one.
     *
     * A credit bureau's mortgage tradeline has a balance and a payment and no
     * interest rate. The credit pull wrote `0` into the column regardless, so
     * this published −6.25 on every refinance that came off a real report — a
     * figure with no derivation behind it, on a decision where every number is
     * supposed to have one.
     */
    readonly rateDelta: number | null;
    /**
     * Months to recoup the closing costs out of the monthly saving, or null
     * when there is no saving to recoup them from.
     *
     * Null rather than Infinity because this object is stored as jsonb and JSON
     * cannot carry an infinity — it arrived back from Postgres as null anyway,
     * having claimed to be a number the whole way. A null here is not "we did
     * not compute it": a test that did not run leaves `netTangibleBenefit`
     * undefined entirely, and a null recoup always sits beside a `paymentDelta`
     * at or below zero.
     */
    readonly recoupMonths: number | null;
    readonly thresholdMonths: number;
    readonly satisfied: boolean;
  };
}

/**
 * What the engine last concluded, as a closed set.
 *
 * `referred` is the one that had to be added: the engine could not compute at
 * least one input it needed (recommendation `refer`) and no computed result
 * overrides it. It is NOT a credit decision — nobody has looked at this file —
 * so the application does not leave `in_underwriting` on it and no adverse
 * action is owed. Before it existed, `determineOutcome` fell through to
 * `approved_with_conditions`, which told a borrower whose APR and APOR were
 * never known that they had been approved.
 *
 * The database holds the same list as a CHECK constraint
 * (`20260909130000_decisions_outcome_is_closed`), so a misspelled word is a
 * failed insert rather than a pill that renders nothing.
 */
export const DECISION_OUTCOMES = [
  "pending",
  "referred",
  "approved_with_conditions",
  "clear_to_close",
  "counteroffer",
  "denied",
] as const;

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/**
 * What the priced tests were measured against.
 *
 * A stored decision saying "not high-cost" that cannot name the week it
 * compared a rate to, or the schedule it priced the fees off, is an audit
 * record of a legal determination with the determination's inputs missing.
 * Both of those move — the FFIEC publishes a new week every Monday and a fee
 * schedule is replaced rather than edited — so recomputing a year later would
 * answer the same question differently and nothing on the old row would say
 * why.
 *
 * `aporSource` is `"stated"` when a caller supplied the rate instead of the
 * engine looking one up, which is the persona seed and nothing else. It is a
 * value rather than a null for the reason `AusResult.engine` is: no stored
 * decision may be ambiguous about what produced it.
 *
 * The database holds this as a CHECK: a decision carrying an APR spread must
 * name an APOR source, and one carrying a points-and-fees ratio must name a
 * fee schedule.
 */
export interface PricedAgainst {
  /** The FFIEC week the APOR was read from, as an ISO date. */
  readonly aporWeekOf: string | null;
  /** Which table answered, or "stated". Null when no APOR was obtained. */
  readonly aporSource: string | null;
  /** Which fee schedule priced the totals, or "stated". */
  readonly feeScheduleVersion: string | null;
}

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
  /** Where the APR spread and the fee ratio above were measured from. */
  readonly pricedAgainst: PricedAgainst;
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
