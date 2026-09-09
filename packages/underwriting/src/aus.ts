/**
 * The shadow AUS.
 *
 * Screen 8's 18 UW-* requirements all hang off a Desktop Underwriter or Loan
 * Product Advisor submission. V1 does not have one — a real submission needs a
 * seller/servicer number — so this computes the same shape from the same
 * inputs and stamps `engine: "shadow"` on the result.
 *
 * Two things follow from that and both are deliberate:
 *
 *   1. `engine` is on every AusResult, so no stored decision is ambiguous
 *      about what produced it. When DU is wired in, old files stay readable
 *      and comparable rather than retroactively looking authoritative.
 *   2. Every finding carries the requirement it came from. DU returns
 *      verification messages that a human maps to conditions by hand; here
 *      that mapping is the code path, which is what makes UW-003 satisfiable
 *      automatically and screen 8 explicable at all.
 *
 * This is NOT an agency recommendation and must never be presented as one.
 */

import type {
  AusFinding,
  AusRecommendation,
  AusResult,
  Decision,
  LoanCondition,
  LoanFile,
} from "@hm/shared";
import { DerivationLog, round } from "./derive.js";
import { GUIDELINES } from "./guidelines.js";
import {
  debtToIncome,
  fundsToClose,
  loanToValue,
  monthlyBaseIncome,
  representativeFico,
  reserves,
  revolvingUtilization,
} from "./calculations.js";
import { runComplianceTests, type MarketInputs } from "./compliance.js";
import { priceLoan } from "./pricing.js";

export const SHADOW_ENGINE_VERSION = "0.1.0";

export interface UnderwriteOptions {
  readonly market?: MarketInputs;
  /** Estimated closing fees, until a real fee schedule exists. */
  readonly estimatedFees?: number;
  readonly estimatedPrepaids?: number;
  /** Deterministic id for the casefile. Supplied so results are reproducible. */
  readonly casefileId: string;
  readonly now: string;
}

function monthsBetween(iso: string, now: Date): number {
  const then = new Date(iso);
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
}

/** The maximum LTV this loan's purpose and occupancy allow. */
function maxLtvFor(file: LoanFile): number | null {
  if (!file.loan || !file.property) return null;
  const g = GUIDELINES.ltv;
  if (file.loan.purpose === "cash_out_refinance") return g.cashOutRefinanceMax;
  if (file.loan.purpose === "rate_term_refinance") return g.rateTermRefinanceMax;
  return file.property.occupancy === "primary_residence"
    ? g.purchasePrimaryMax
    : file.property.occupancy === "second_home"
      ? g.purchaseSecondHomeMax
      : g.purchaseInvestmentMax;
}

export function underwrite(file: LoanFile, options: UnderwriteOptions): Decision {
  const log = new DerivationLog();
  const now = new Date(options.now);
  const findings: AusFinding[] = [];

  /* ── Credit ───────────────────────────────────────────────────────────── */
  const fico = representativeFico(file, log);
  revolvingUtilization(file, log);

  if (fico !== null && fico < GUIDELINES.credit.minimumRepresentativeFico) {
    findings.push({
      requirementId: "CRD-002",
      code: "FICO_BELOW_MINIMUM",
      message: `Representative FICO of ${fico} is below the ${GUIDELINES.credit.minimumRepresentativeFico} minimum.`,
      category: "credit",
    });
  }

  // Seasoning. Both are recorded only when the derogatory actually exists, so
  // a clean file does not carry a derivation claiming it passed a test that
  // was never relevant.
  if (file.credit) {
    const bankruptcy = file.credit.publicRecords.find((r) => r.type === "bankruptcy");
    if (bankruptcy) {
      const reference = bankruptcy.dischargeDate ?? bankruptcy.date;
      const months = monthsBetween(reference, now);
      const minimum =
        bankruptcy.chapter === "13"
          ? GUIDELINES.credit.bankruptcyChapter13SeasoningMonths
          : GUIDELINES.credit.bankruptcyChapter7SeasoningMonths;
      log.record(
        "CRD-006",
        "Bankruptcy seasoning",
        months,
        `months since discharge vs ${minimum} minimum`,
        {
          chapter_type: bankruptcy.chapter ?? "unknown",
          discharge_date: reference,
          minimum_months: minimum,
        },
      );
      if (months < minimum) {
        findings.push({
          requirementId: "CRD-006",
          code: "BANKRUPTCY_SEASONING",
          message: `${months} months since discharge; ${minimum} required.`,
          category: "credit",
        });
      }
    }

    const significant = file.credit.publicRecords.find(
      (r) => r.type === "foreclosure" || r.type === "short_sale" || r.type === "deed_in_lieu",
    );
    if (significant) {
      const months = monthsBetween(significant.date, now);
      const minimum =
        significant.type === "foreclosure"
          ? GUIDELINES.credit.foreclosureSeasoningMonths
          : GUIDELINES.credit.shortSaleOrDilSeasoningMonths;
      log.record(
        "CRD-007",
        "Derogatory seasoning",
        months,
        `months since event vs ${minimum} minimum`,
        {
          event_type: significant.type,
          event_date: significant.date,
          minimum_months: minimum,
        },
      );
      if (months < minimum) {
        findings.push({
          requirementId: "CRD-007",
          code: "DEROGATORY_SEASONING",
          message: `${months} months since ${significant.type}; ${minimum} required.`,
          category: "credit",
        });
      }
    }
  }

  /* ── Income ───────────────────────────────────────────────────────────── */
  monthlyBaseIncome(file, log);

  // INC-009 — transcripts against documented income, within tolerance.
  if (file.transcripts.length > 0 && file.incomeSources.length > 0) {
    const annualDocumented = file.incomeSources.reduce((s, i) => s + i.monthlyAmount, 0) * 12;
    const latest = [...file.transcripts].sort((a, b) => b.taxYear - a.taxYear)[0];
    if (latest) {
      const variance =
        annualDocumented === 0
          ? 0
          : round(((annualDocumented - latest.wages) / latest.wages) * 100);
      const TOLERANCE_PERCENT = 10;
      log.record(
        "INC-009",
        "Transcript reconciliation",
        variance,
        `documented annual income vs transcript wages, ${TOLERANCE_PERCENT}% tolerance`,
        {
          documented_annual_income: round(annualDocumented),
          transcript_wages: latest.wages,
          transcript_year: latest.taxYear,
        },
      );
      if (Math.abs(variance) > TOLERANCE_PERCENT) {
        findings.push({
          requirementId: "INC-009",
          code: "TRANSCRIPT_VARIANCE",
          message: `Documented income varies ${variance}% from ${latest.taxYear} transcript wages.`,
          category: "income",
        });
      }
    }
  }

  /* ── Ratios ───────────────────────────────────────────────────────────── */
  const dti = debtToIncome(file, log);
  const ltv = loanToValue(file, log);

  if (dti.back !== null && dti.back > GUIDELINES.ratios.maxDtiBack) {
    findings.push({
      requirementId: "UW-004",
      code: "DTI_EXCEEDS_MAXIMUM",
      message: `Back-end DTI of ${dti.back}% exceeds the ${GUIDELINES.ratios.maxDtiBack}% maximum.`,
      category: "income",
    });
  } else if (dti.back !== null && dti.back > GUIDELINES.ratios.dtiCautionThreshold) {
    findings.push({
      requirementId: "UW-004",
      code: "DTI_ELEVATED",
      message: `Back-end DTI of ${dti.back}% is above ${GUIDELINES.ratios.dtiCautionThreshold}% and needs compensating factors.`,
      category: "income",
    });
  }

  const maxLtv = maxLtvFor(file);
  if (ltv.ltv !== null && maxLtv !== null && ltv.ltv > maxLtv) {
    findings.push({
      requirementId: "UW-005",
      code: "LTV_EXCEEDS_MAXIMUM",
      message: `LTV of ${ltv.ltv}% exceeds the ${maxLtv}% maximum for this purpose and occupancy.`,
      category: "eligibility",
    });
  }

  /* ── Assets and reserves ──────────────────────────────────────────────── */
  const fees = options.estimatedFees ?? 0;
  const prepaids = options.estimatedPrepaids ?? 0;
  const funds = fundsToClose(file, fees, prepaids, log);
  const reserveResult = reserves(file, dti.pitia, funds, log);

  if (reserveResult.satisfied === false) {
    findings.push({
      requirementId: "AST-004",
      code: "RESERVES_INSUFFICIENT",
      message: `${reserveResult.actualMonths} months of reserves against ${reserveResult.requiredMonths} required.`,
      category: "asset",
    });
  }

  // AST-016 — interested party contributions against the LTV-banded cap.
  if (file.loan && file.property && ltv.ltv !== null) {
    const ipcTotal = file.loan.interestedPartyContributions;
    const cap =
      file.property.occupancy === "investment"
        ? GUIDELINES.ipc.investmentMaxPercent
        : (GUIDELINES.ipc.primaryAndSecondHome.find((b) => ltv.ltv! >= b.minLtv)?.maxPercent ?? 9);
    const ratio =
      file.property.valueOrPrice === 0 ? 0 : round((ipcTotal / file.property.valueOrPrice) * 100);
    log.record(
      "AST-016",
      "Interested party contributions",
      ratio,
      `ipc_total / sales_price vs a ${cap}% cap`,
      {
        ipc_total: ipcTotal,
        sales_price: file.property.valueOrPrice,
        cap_percent: cap,
        ltv: ltv.ltv,
      },
    );
    if (ratio > cap) {
      findings.push({
        requirementId: "AST-016",
        code: "IPC_EXCEEDS_LIMIT",
        message: `Interested party contributions of ${ratio}% exceed the ${cap}% limit.`,
        category: "asset",
      });
    }
  }

  /* ── Compliance and pricing ───────────────────────────────────────────── */
  const compliance = runComplianceTests(file, options.market ?? {}, dti.back, log);
  const pricing = priceLoan(file, fico, ltv.ltv, log);

  if (compliance.isHighCost === true) {
    findings.push({
      requirementId: "UW-009",
      code: "HOEPA_HIGH_COST",
      message: "Loan tests as a HOEPA high-cost mortgage and is ineligible.",
      category: "eligibility",
    });
  }
  if (compliance.pointsAndFeesPass === false) {
    findings.push({
      requirementId: "UW-007",
      code: "POINTS_AND_FEES_EXCEEDED",
      message: `Points and fees of ${compliance.pointsAndFeesRatio}% exceed the QM cap.`,
      category: "eligibility",
    });
  }
  if (compliance.netTangibleBenefit?.satisfied === false) {
    findings.push({
      requirementId: "APP-019",
      code: "NTB_NOT_SATISFIED",
      message: "The refinance does not meet the net tangible benefit threshold.",
      category: "eligibility",
    });
  }

  /* ── Eligibility and overlays ─────────────────────────────────────────── */
  const eligibilityFindings = findings.filter((f) => f.category === "eligibility");
  log.record(
    "UW-012",
    "Product eligibility",
    eligibilityFindings.length === 0 ? "eligible" : "ineligible",
    "every product parameter within its limit",
    {
      max_ltv: maxLtv,
      actual_ltv: ltv.ltv,
      max_dti: GUIDELINES.ratios.maxDtiBack,
      actual_dti: dti.back,
      minimum_fico: GUIDELINES.credit.minimumRepresentativeFico,
      actual_fico: fico,
    },
  );

  if (file.product && file.product.overlays.length > 0) {
    log.record(
      "UW-013",
      "Investor overlays",
      file.product.overlays.length,
      "overlays checked in addition to the agency guide",
      {
        overlays: file.product.overlays.join(", "),
      },
    );
  }

  /* ── Recommendation ───────────────────────────────────────────────────── */
  const blocking = log.all().filter((d) => d.blockedBy?.length);
  const recommendation = determineRecommendation(findings, blocking.length > 0);

  // `refer_with_caution` is on this list too. UW-011's own condition
  // (`aus_refer_or_ineligible`) counts it, so leaving it out recorded a
  // requirement as applicable with no derivation behind it — a number on the
  // decision screen with nothing to show for it.
  if (
    recommendation === "refer" ||
    recommendation === "refer_with_caution" ||
    recommendation === "approve_ineligible"
  ) {
    log.record("UW-011", "Manual underwrite", "required", "AUS returned Refer or Ineligible", {
      recommendation,
      finding_count: findings.length,
    });
  }

  const aus: AusResult = {
    casefileId: options.casefileId,
    submittedAt: options.now,
    recommendation,
    findings,
    engine: "shadow",
    engineVersion: SHADOW_ENGINE_VERSION,
  };

  /* ── Conditions (UW-003, UW-014) ──────────────────────────────────────── */
  const conditions: LoanCondition[] = findings.map((finding, index) => ({
    id: `${options.casefileId}-c${index + 1}`,
    requirementId: finding.requirementId ?? "UW-003",
    description: finding.message,
    status: "open",
    issuedAt: options.now,
    documentIds: [],
    owner: finding.category === "eligibility" ? "lender" : "borrower",
  }));

  const outcome = determineOutcome(recommendation, conditions, compliance);

  return {
    outcome,
    computedAt: options.now,
    aus,
    ratios: {
      dtiFront: dti.front,
      dtiBack: dti.back,
      ltv: ltv.ltv,
      cltv: ltv.cltv,
      hcltv: ltv.hcltv,
      housingPitia: dti.pitia,
      totalMonthlyDebt: dti.totalDebt,
      totalQualifyingIncome: dti.income,
    },
    reserves: reserveResult,
    compliance,
    pricing,
    conditions,
    derivations: log.all(),
    adverseActionReasons:
      outcome === "denied" || outcome === "counteroffer"
        ? adverseActionReasonsFor(findings, compliance)
        : undefined,
  };
}

/**
 * The principal reasons, on both of the outcomes that owe them.
 *
 * A counteroffer is an adverse action under Reg B — "creditworthy, wrong loan"
 * still refuses the loan that was asked for — and UW-016's condition is
 * `denial_or_counteroffer`, so leaving the array empty on a counteroffer made
 * a requirement that applies impossible to satisfy.
 *
 * The HOEPA line matters for the other half: a high-cost denial can carry no
 * eligibility finding at all, because the loan is fine and the PRICING is what
 * fails. Without it that borrower's notice would have no reasons in it.
 */
function adverseActionReasonsFor(
  findings: readonly AusFinding[],
  compliance: Decision["compliance"],
): string[] {
  const reasons = findings.filter((f) => f.category === "eligibility").map((f) => f.message);
  if (compliance.isHighCost === true) {
    // Which of the two triggers fired, named. "High-cost" alone is a
    // classification, not a reason, and a notice that gives one is not a
    // notice — the borrower cannot tell whether it was the rate or the fees.
    const byRate =
      compliance.hpmlSpread !== null && compliance.hpmlSpread > GUIDELINES.hoepa.firstLienAprSpread;
    const byFees =
      compliance.pointsAndFeesRatio !== null &&
      compliance.pointsAndFeesRatio > GUIDELINES.hoepa.pointsAndFeesPercent;
    const trigger =
      byRate && byFees
        ? "the rate and the fees are both above the limit"
        : byFees
          ? "the fees are above the limit"
          : "the rate is above the limit";
    reasons.push(`HOEPA high-cost: ${trigger}`);
  }
  return reasons;
}

function determineRecommendation(
  findings: readonly AusFinding[],
  hasBlockedInputs: boolean,
): AusRecommendation {
  const ineligible = findings.some((f) => f.category === "eligibility");
  if (ineligible) return "approve_ineligible";
  // A file with unresolved inputs is a Refer, not an Approve. The distinction
  // matters: "we could not compute this" and "we computed it and you passed"
  // must never collapse into the same green checkmark.
  if (hasBlockedInputs) return "refer";
  if (findings.length > 0) return "refer_with_caution";
  return "approve_eligible";
}

/**
 * The word for what just happened, and the order is the whole content.
 *
 * A high-cost denial comes first because `isHighCost` is `true` only when the
 * HOEPA test actually COMPUTED — with the APR, the APOR and the fees all
 * missing it is null, never true. So a loan we have computed to be high-cost
 * is a failure we found, and a failure we found outranks an input we could not
 * reach. `denied` and `referred` cannot coincide by accident.
 *
 * `approve_ineligible` comes next for the same reason: an eligibility finding
 * is computed from real inputs — an LTV over the cap, a failed net tangible
 * benefit — so "creditworthy, wrong loan" is a real answer even while the
 * pricing tests are blocked.
 *
 * Then `refer`, which is the engine saying it could not compute something it
 * needed. It used to fall through to `approved_with_conditions` at the bottom
 * of this function, which is how a borrower whose APR and APOR were never
 * known ended up reading "Approved with conditions". `referred` is not a
 * credit decision and nothing downstream may treat it as one.
 *
 * What is left at the bottom is now exactly `refer_with_caution` — findings we
 * did compute, which is what "approved with conditions" has always meant.
 */
function determineOutcome(
  recommendation: AusRecommendation,
  conditions: readonly LoanCondition[],
  compliance: Decision["compliance"],
): Decision["outcome"] {
  if (compliance.isHighCost === true) return "denied";
  if (recommendation === "approve_ineligible") return "counteroffer";
  if (recommendation === "refer") return "referred";
  const open = conditions.filter((c) => c.status !== "cleared" && c.status !== "waived");
  if (recommendation === "approve_eligible" && open.length === 0) return "clear_to_close";
  return "approved_with_conditions";
}
