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
import { household, householdPublicRecords } from "@hm/shared";
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
import type { AporTable } from "./apor.js";
import { runComplianceTests, type MarketInputs } from "./compliance.js";
import { closingCosts, FEE_SCHEDULE } from "./fee-schedule.js";
import { resolveMarketInputs, statedMarket } from "./market.js";
import { priceLoan } from "./pricing.js";

export const SHADOW_ENGINE_VERSION = "0.1.0";

export interface UnderwriteOptions {
  /**
   * Priced figures stated rather than derived, which is a seed's privilege and
   * nobody else's.
   *
   * `resolveMarketInputs` derives all four from the file whenever this is
   * absent, which is every path a borrower or a route can reach. What is left
   * is the persona seed, which stands a sample borrower at an outcome the
   * fixture rate sheet cannot produce — a HOEPA high-cost decline needs a rate
   * six and a half points over the market, and no sheet in this repository
   * quotes one.
   */
  readonly market?: MarketInputs;
  /**
   * Closing fees stated rather than priced. Absent, the dated fee schedule is
   * what funds-to-close is computed from.
   */
  readonly estimatedFees?: number;
  readonly estimatedPrepaids?: number;
  /**
   * The average prime offer rate series to compare against, or null when the
   * caller has none.
   *
   * Required rather than defaulted, and null rather than absent: a default
   * table is a checked-in file standing in for a weekly publication, and the
   * one thing this engine must never do is compare a loan against the week
   * somebody last ran a command. The API passes what it fetched; the tests pass
   * `APOR_TABLE`; a caller with nothing says so and UW-008 blocks.
   */
  readonly aporTable: AporTable | null;
  /** Deterministic id for the casefile. Supplied so results are reproducible. */
  readonly casefileId: string;
  readonly now: string;
}

function monthsBetween(iso: string, now: Date): number {
  const then = new Date(iso);
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
}

/** Whether anybody on the loan will not live in the home. */
export function hasNonOccupantCoBorrower(file: LoanFile): boolean {
  return file.borrowers.some((b) => b.occupiesProperty === false);
}

/**
 * The maximum LTV this loan's purpose and occupancy allow — and, when a
 * co-borrower will not occupy the property, the lower of that and 95
 * (Selling Guide B2-2-04).
 */
export function maxLtvFor(file: LoanFile): number | null {
  if (!file.loan || !file.property) return null;
  const g = GUIDELINES.ltv;
  const byPurpose =
    file.loan.purpose === "cash_out_refinance"
      ? g.cashOutRefinanceMax
      : file.loan.purpose === "rate_term_refinance"
        ? g.rateTermRefinanceMax
        : file.property.occupancy === "primary_residence"
          ? g.purchasePrimaryMax
          : file.property.occupancy === "second_home"
            ? g.purchaseSecondHomeMax
            : g.purchaseInvestmentMax;
  return hasNonOccupantCoBorrower(file)
    ? Math.min(byPurpose, g.nonOccupantCoBorrowerMax)
    : byPurpose;
}

export function underwrite(file: LoanFile, options: UnderwriteOptions): Decision {
  const log = new DerivationLog();
  const now = new Date(options.now);
  const findings: AusFinding[] = [];

  /* ── Credit ───────────────────────────────────────────────────────────── */
  const scores = representativeFico(file, log);
  const fico = scores?.representative ?? null;
  revolvingUtilization(file, log);

  if (scores !== null && scores.forEligibility < GUIDELINES.credit.minimumRepresentativeFico) {
    const tested = scores.averageMedian === null ? "Representative FICO" : "Average median credit score";
    findings.push({
      requirementId: "CRD-002",
      code: "FICO_BELOW_MINIMUM",
      message: `${tested} of ${scores.forEligibility} is below the ${GUIDELINES.credit.minimumRepresentativeFico} minimum.`,
      category: "credit",
    });
  }

  // Seasoning, across every borrower's report. Both are recorded only when
  // the derogatory actually exists, so a clean file does not carry a
  // derivation claiming it passed a test that was never relevant — and when
  // two people carry one, the derivation is about the more recent, which is
  // the one that decides.
  const records = householdPublicRecords(file);
  const bankruptcies = records
    .filter((r) => r.record.type === "bankruptcy")
    .map((r) => ({ ...r, reference: r.record.dischargeDate ?? r.record.date }))
    .sort((a, b) => (a.reference < b.reference ? 1 : -1));
  const bankruptcy = bankruptcies[0];
  if (bankruptcy) {
    const months = monthsBetween(bankruptcy.reference, now);
    const minimum =
      bankruptcy.record.chapter === "13"
        ? GUIDELINES.credit.bankruptcyChapter13SeasoningMonths
        : GUIDELINES.credit.bankruptcyChapter7SeasoningMonths;
    log.record(
      "CRD-006",
      "Bankruptcy seasoning",
      months,
      `months since discharge vs ${minimum} minimum`,
      {
        borrower: bankruptcy.member.name,
        chapter_type: bankruptcy.record.chapter ?? "unknown",
        discharge_date: bankruptcy.reference,
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

  const significant = records
    .filter(
      (r) =>
        r.record.type === "foreclosure" ||
        r.record.type === "short_sale" ||
        r.record.type === "deed_in_lieu",
    )
    .sort((a, b) => (a.record.date < b.record.date ? 1 : -1))[0];
  if (significant) {
    const months = monthsBetween(significant.record.date, now);
    const minimum =
      significant.record.type === "foreclosure"
        ? GUIDELINES.credit.foreclosureSeasoningMonths
        : GUIDELINES.credit.shortSaleOrDilSeasoningMonths;
    log.record(
      "CRD-007",
      "Derogatory seasoning",
      months,
      `months since event vs ${minimum} minimum`,
      {
        borrower: significant.member.name,
        event_type: significant.record.type,
        event_date: significant.record.date,
        minimum_months: minimum,
      },
    );
    if (months < minimum) {
      findings.push({
        requirementId: "CRD-007",
        code: "DEROGATORY_SEASONING",
        message: `${months} months since ${significant.record.type}; ${minimum} required.`,
        category: "credit",
      });
    }
  }

  /* ── Income ───────────────────────────────────────────────────────────── */
  monthlyBaseIncome(file, log);

  // INC-009 — transcripts against documented income, within tolerance.
  //
  // The income rows are the household's and carry no party, so the wages
  // they are checked against are the household's too: each person's latest
  // transcript, summed. Compared only once everybody's transcripts are in —
  // one person's wages against two people's income is a variance nobody
  // would recognize — and until then it is simply not computed, the same as
  // a one-person file with no transcript yet.
  const members = household(file);
  const latestByMember = members.map(
    (m) => [...m.transcripts].sort((a, b) => b.taxYear - a.taxYear)[0] ?? null,
  );
  if (members.length > 0 && latestByMember.every((t) => t !== null) && file.incomeSources.length > 0) {
    const latestTranscripts = latestByMember as NonNullable<(typeof latestByMember)[number]>[];
    const annualDocumented = file.incomeSources.reduce((s, i) => s + i.monthlyAmount, 0) * 12;
    const wages = latestTranscripts.reduce((s, t) => s + t.wages, 0);
    const year = Math.max(...latestTranscripts.map((t) => t.taxYear));
    const variance =
      annualDocumented === 0 || wages === 0 ? 0 : round(((annualDocumented - wages) / wages) * 100);
    const TOLERANCE_PERCENT = 10;
    log.record(
      "INC-009",
      "Transcript reconciliation",
      variance,
      `documented annual income vs transcript wages, ${TOLERANCE_PERCENT}% tolerance` +
        (members.length > 1 ? "; every borrower's latest transcript, summed" : ""),
      {
        documented_annual_income: round(annualDocumented),
        transcript_wages: wages,
        transcript_year: year,
        borrowers_with_transcripts: latestTranscripts.length,
      },
    );
    if (Math.abs(variance) > TOLERANCE_PERCENT) {
      findings.push({
        requirementId: "INC-009",
        code: "TRANSCRIPT_VARIANCE",
        message: `Documented income varies ${variance}% from ${year} transcript wages.`,
        category: "income",
      });
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

  /* ── What the loan is priced at ───────────────────────────────────────── */
  // Before assets, because funds to close is computed from the same schedule
  // the compliance tests are: a file whose closing costs are in one number on
  // the decision screen and another in the QM ratio is two answers about one
  // loan.
  const { inputs: market, pricedAgainst } = options.market
    ? statedMarket(options.market)
    : resolveMarketInputs(file, log, options.aporTable);

  /* ── Assets and reserves ──────────────────────────────────────────────── */
  // The fee schedule is this lender's own, not a market input, so a caller who
  // states an APOR has not un-charged it. Without this fallback a stated market
  // priced funds to close at zero — the seeded sample borrowers were told they
  // needed nothing at closing beyond the down payment, on a file whose own
  // decision screen listed the fees.
  const fees =
    options.estimatedFees ??
    market.closingCostTotal ??
    closingCosts(FEE_SCHEDULE, file.loan?.loanAmount ?? 0)?.total ??
    0;
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
  const compliance = runComplianceTests(file, market, dti.back, log);
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
      non_occupant_co_borrower: hasNonOccupantCoBorrower(file),
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
    pricedAgainst,
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
    // Which trigger fired, READ rather than re-derived. "High-cost" alone is a
    // classification, not a reason, and a notice that gives one is not a
    // notice — the borrower cannot tell whether it was the rate or the fees.
    //
    // This used to recompute both from `hpmlSpread` and `pointsAndFeesRatio`,
    // which are rounded to hundredths for the screen and are measured against
    // thresholds that are no longer flat: a ratio of 4.996 records as 5.00 and
    // read back as "the fees are above the limit" on a loan whose fees were
    // under it. The engine already knows which side fired, so it says so.
    const t = compliance.hoepaTriggers;
    const fired = [
      t?.apr === true ? "the rate" : null,
      t?.pointsAndFees === true ? "the fees" : null,
      t?.prepaymentPenalty === true ? "the prepayment penalty" : null,
    ].filter((x): x is string => x !== null);
    // A high-cost finding always has at least one trigger behind it — that is
    // what made it true — so an empty list here would be a bug elsewhere, and
    // the notice says the pricing rather than inventing a side.
    const trigger =
      fired.length === 0
        ? "the pricing is above the limit"
        : fired.length === 1
          ? `${fired[0]} is above the limit`
          : fired.length === 2
            ? `${fired[0]} and ${fired[1]} are both above the limit`
            : `${fired.slice(0, -1).join(", ")} and ${fired.at(-1)} are all above the limit`;
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
