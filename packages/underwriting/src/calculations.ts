/**
 * The arithmetic behind screen 8.
 *
 * Every function takes the loan file and a `DerivationLog`, and every number
 * it produces goes through the log. Functions return `null` rather than
 * guessing when an input is missing — a DTI computed against an assumed income
 * is worse than no DTI, because it looks like an answer.
 */

import type { LoanFile, ReserveAssessment } from "@hm/shared";
import { household, householdAccounts, householdTradelines } from "@hm/shared";
import { DerivationLog, round } from "./derive.js";
import { GUIDELINES, mortgageInsuranceRate } from "./guidelines.js";

/**
 * Escrow estimate, as a fraction of property value per year.
 *
 * ⚠ ASSUMPTION, and a load-bearing one: PITIA drives DTI, and DTI drives the
 * recommendation. The flow collects no tax bill and no insurance quote, so
 * these national averages stand in. They are wrong for any specific property —
 * a Texas property tax bill is roughly double this — and every derivation
 * that uses them says so in its formula string.
 *
 * Replacing this with a real tax and insurance lookup is the single highest-
 * value accuracy improvement available to the decision engine.
 */
export const ESCROW_ASSUMPTION = {
  annualTaxRate: 0.011,
  annualInsuranceRate: 0.0035,
};

export interface CreditScores {
  /** The loan's representative score: the lowest of the borrowers' own. What pricing reads. */
  readonly representative: number;
  /**
   * What the minimum is tested against: the representative score on a
   * one-borrower loan, the average of the borrowers' own scores on a loan
   * with more than one.
   */
  readonly forEligibility: number;
  /** Null on a one-borrower loan, where there is nothing to average. */
  readonly averageMedian: number | null;
}

/**
 * Each borrower's own score, then the loan's (CRD-002).
 *
 * Per borrower: the middle of three bureau scores, the lower of two, the one
 * (Selling Guide B3-5.1-02). The loan's representative score is the LOWEST of
 * those, and it is what pricing reads on every loan. The minimum is tested
 * against the representative score on a one-borrower loan and against the
 * AVERAGE of the borrowers' own scores on a loan with more than one — the
 * guide's rule for a manually underwritten loan, and the nearest rule there
 * is for a shadow engine, since DU runs its own model and states no score.
 *
 * Blocked, naming the person, while ANY borrower has no credit report. A
 * lowest-of-one on a two-person loan looks exactly like the loan's score and
 * is not, and the DTI downstream would be short one person's debts.
 */
export function representativeFico(file: LoanFile, log: DerivationLog): CreditScores | null {
  const members = household(file);
  const missing = members.filter((m) => !m.credit || m.credit.scores.length === 0);
  if (members.length === 0 || missing.length > 0) {
    return log.blocked(
      "CRD-002",
      "Representative FICO",
      members.length <= 1 ? ["credit report"] : missing.map((m) => `credit report for ${m.name}`),
    );
  }

  // Three bureaus → the middle one. Two → the lower. One → itself.
  const own = members.map((member) => {
    const sorted = [...member.credit!.scores].map((s) => s.score).sort((a, b) => a - b);
    return {
      member,
      score: sorted.length >= 3 ? sorted[1]! : sorted[0]!,
      formula:
        sorted.length >= 3
          ? "middle of three bureau scores"
          : `lowest of ${sorted.length} available bureau score(s)`,
      bureaus: Object.fromEntries(member.credit!.scores.map((s) => [s.bureau, s.score])),
    };
  });

  if (own.length === 1) {
    const only = own[0]!;
    const score = log.record("CRD-002", "Representative FICO", only.score, only.formula, only.bureaus);
    return { representative: score, forEligibility: score, averageMedian: null };
  }

  for (const o of own) {
    log.record("CRD-002", `Representative FICO (${o.member.name})`, o.score, o.formula, {
      borrower: o.member.name,
      ...o.bureaus,
    });
  }
  const byName = Object.fromEntries(own.map((o) => [o.member.name, o.score]));
  const representative = log.record(
    "CRD-002",
    "Representative FICO",
    Math.min(...own.map((o) => o.score)),
    "lowest of the borrowers' own scores (Selling Guide B3-5.1-02); what pricing reads",
    byName,
  );
  const averageMedian = log.record(
    "CRD-002",
    "Average median credit score",
    Math.round(own.reduce((sum, o) => sum + o.score, 0) / own.length),
    "average of the borrowers' own scores, rounded to the nearest whole number; " +
      "what the minimum is tested against on a loan with more than one borrower",
    byName,
  );
  return { representative, forEligibility: averageMedian, averageMedian };
}

/** Who is still to pull credit, as a blocked derivation names them. */
function creditWaitingFor(file: LoanFile): readonly string[] {
  const { withoutCredit } = householdTradelines(file);
  return household(file).length <= 1
    ? ["credit report"]
    : withoutCredit.map((m) => `credit report for ${m.name}`);
}

export function revolvingUtilization(file: LoanFile, log: DerivationLog): number | null {
  const lines = householdTradelines(file);
  if (lines.withCredit.length === 0 || lines.withoutCredit.length > 0) {
    return log.blocked("CRD-016", "Revolving utilization", creditWaitingFor(file));
  }
  const revolving = lines.tradelines.filter((t) => t.type === "revolving" || t.type === "heloc");
  const limit = revolving.reduce((sum, t) => sum + (t.creditLimit ?? 0), 0);
  if (limit === 0) {
    return log.record("CRD-016", "Revolving utilization", 0, "no revolving limit on file", {
      revolvingLines: revolving.length,
      joint_tradelines_deduplicated: lines.deduplicated,
    });
  }
  const balance = revolving.reduce((sum, t) => sum + t.balance, 0);
  return log.record(
    "CRD-016",
    "Revolving utilization",
    round((balance / limit) * 100),
    "revolving_balance / revolving_limit, across every borrower's report, a joint line once",
    {
      revolving_balance: balance,
      revolving_limit: limit,
      borrowers_with_credit: lines.withCredit.length,
      joint_tradelines_deduplicated: lines.deduplicated,
    },
  );
}

export function totalQualifyingIncome(file: LoanFile, log: DerivationLog): number | null {
  if (file.incomeSources.length === 0) {
    return log.blocked("INC-026", "Total qualifying monthly income", [
      "no income sources verified",
    ]);
  }
  // Only sources with an established continuance count. INC-027 is what sets
  // that flag, and a source still under review is not yet qualifying income.
  const approved = file.incomeSources.filter((s) => s.continuanceEstablished === true);
  const pending = file.incomeSources.length - approved.length;
  const total = approved.reduce((sum, s) => sum + s.monthlyAmount, 0);
  return log.record(
    "INC-026",
    "Total qualifying monthly income",
    round(total),
    "sum of income sources with an established continuance",
    {
      ...Object.fromEntries(approved.map((s) => [s.type, s.monthlyAmount])),
      sources_pending_continuance: pending,
    },
  );
}

export function monthlyBaseIncome(file: LoanFile, log: DerivationLog): number | null {
  const base = file.incomeSources.filter((s) => s.type === "base_wage");
  if (base.length === 0) return log.blocked("INC-004", "Base monthly income", ["wage income"]);
  const total = base.reduce((sum, s) => sum + s.monthlyAmount, 0);
  return log.record("INC-004", "Base monthly income", round(total), "sum of base wage sources", {
    sources: base.length,
  });
}

/** Principal and interest on a fully amortizing fixed-rate loan. */
export function monthlyPrincipalAndInterest(
  amount: number,
  annualRate: number,
  termMonths: number,
): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return amount / termMonths;
  return (amount * r) / (1 - Math.pow(1 + r, -termMonths));
}

/**
 * Housing PITIA — principal, interest, taxes, insurance, and Association dues.
 *
 * The A is association dues, and mortgage insurance belongs here too. Omitting
 * both understated the payment for exactly the borrowers whose DTI is
 * tightest: anyone above 80% LTV pays MI, and any condo owner pays dues. The
 * `thin_file_renter` fixture sits at 95% LTV, so its DTI was wrong by the
 * entire MI premium.
 */
export function housingPitia(file: LoanFile, log: DerivationLog): number | null {
  if (!file.loan || !file.product || !file.property) {
    return log.blocked("UW-004", "Housing PITIA", ["loan terms", "product", "property"]);
  }
  const pi = monthlyPrincipalAndInterest(
    file.loan.loanAmount,
    file.product.noteRate,
    file.product.termMonths,
  );
  const taxes = (file.property.valueOrPrice * ESCROW_ASSUMPTION.annualTaxRate) / 12;
  const insurance = (file.property.valueOrPrice * ESCROW_ASSUMPTION.annualInsuranceRate) / 12;

  const ltv =
    file.property.valueOrPrice === 0
      ? 0
      : (file.loan.loanAmount / file.property.valueOrPrice) * 100;
  const miRate = mortgageInsuranceRate(ltv);
  const mortgageInsurance = (file.loan.loanAmount * miRate) / 12;

  const hoa = file.property.monthlyAssociationDues ?? 0;

  return log.record(
    "UW-004",
    "Housing PITIA",
    round(pi + taxes + insurance + mortgageInsurance + hoa),
    "P&I + escrowed taxes and insurance + mortgage insurance + association dues " +
      "(taxes, insurance and MI are ESTIMATED — no tax bill, insurance quote or MI rate card is collected)",
    {
      principal_and_interest: round(pi),
      estimated_monthly_taxes: round(taxes),
      estimated_monthly_insurance: round(insurance),
      estimated_mortgage_insurance: round(mortgageInsurance),
      mortgage_insurance_applies: miRate > 0,
      ltv: round(ltv),
      association_dues: round(hoa),
      note_rate: file.product.noteRate,
      term_months: file.product.termMonths,
    },
  );
}

/**
 * Monthly liabilities from every borrower's credit report, less anything
 * excluded, a joint account once. Blocked while anybody's report is missing:
 * a DTI short one person's debts is a number that looks like an answer.
 */
export function monthlyLiabilities(file: LoanFile, log: DerivationLog): number | null {
  const lines = householdTradelines(file);
  if (lines.withCredit.length === 0 || lines.withoutCredit.length > 0) {
    return log.blocked("UW-004", "Monthly liabilities", creditWaitingFor(file));
  }
  const counted = lines.tradelines.filter((t) => !t.exclusionReasonCode);
  const total = counted.reduce((sum, t) => sum + t.monthlyPayment, 0);
  return log.record(
    "UW-004",
    "Monthly liabilities",
    round(total),
    "sum of tradeline monthly payments across every borrower's report, a joint account once, " +
      "excluding those with a reason code",
    {
      tradelines_counted: counted.length,
      tradelines_excluded: lines.tradelines.length - counted.length,
      borrowers_with_credit: lines.withCredit.length,
      joint_tradelines_deduplicated: lines.deduplicated,
    },
  );
}

export interface DtiResult {
  readonly front: number | null;
  readonly back: number | null;
  readonly pitia: number | null;
  readonly totalDebt: number | null;
  readonly income: number | null;
}

export function debtToIncome(file: LoanFile, log: DerivationLog): DtiResult {
  const income = totalQualifyingIncome(file, log);
  const pitia = housingPitia(file, log);
  const liabilities = monthlyLiabilities(file, log);

  if (income === null || income === 0 || pitia === null) {
    log.blocked(
      "UW-004",
      "DTI",
      [
        income === null || income === 0 ? "qualifying income" : null,
        pitia === null ? "housing payment" : null,
      ].filter((x): x is string => x !== null),
    );
    return { front: null, back: null, pitia, totalDebt: null, income };
  }

  const front = log.record(
    "UW-004",
    "Front-end DTI",
    round((pitia / income) * 100),
    "housing_PITIA / total_qualifying_income",
    { housing_PITIA: pitia, total_qualifying_income: income },
  );

  if (liabilities === null) return { front, back: null, pitia, totalDebt: null, income };

  const totalDebt = round(pitia + liabilities);
  const back = log.record(
    "UW-004",
    "Back-end DTI",
    round((totalDebt / income) * 100),
    "(housing_PITIA + monthly_liabilities) / total_qualifying_income",
    { housing_PITIA: pitia, monthly_liabilities: liabilities, total_qualifying_income: income },
  );

  return { front, back, pitia, totalDebt, income };
}

export interface LtvResult {
  readonly ltv: number | null;
  readonly cltv: number | null;
  readonly hcltv: number | null;
}

export function loanToValue(file: LoanFile, log: DerivationLog): LtvResult {
  if (!file.loan || !file.property) {
    log.blocked("UW-005", "LTV / CLTV / HCLTV", ["loan terms", "property value"]);
    return { ltv: null, cltv: null, hcltv: null };
  }
  const value = file.property.valueOrPrice;
  if (value === 0) {
    log.blocked("UW-005", "LTV / CLTV / HCLTV", ["property value is zero"]);
    return { ltv: null, cltv: null, hcltv: null };
  }

  const inputs = {
    loan_amount: file.loan.loanAmount,
    value: value,
    junior_lien_balance: file.loan.juniorLienBalance,
    junior_lien_credit_limit: file.loan.juniorLienCreditLimit,
    valuation_source: file.property.valuationSource,
  };

  return {
    ltv: log.record(
      "UW-005",
      "LTV",
      round((file.loan.loanAmount / value) * 100),
      "loan_amount / value",
      inputs,
    ),
    cltv: log.record(
      "UW-005",
      "CLTV",
      round(((file.loan.loanAmount + file.loan.juniorLienBalance) / value) * 100),
      "(loan_amount + junior_liens) / value",
      inputs,
    ),
    // HCLTV uses the junior lien's full credit LINE, not its drawn balance —
    // an undrawn HELOC is capacity the borrower can use the day after closing.
    hcltv: log.record(
      "UW-005",
      "HCLTV",
      round(((file.loan.loanAmount + file.loan.juniorLienCreditLimit) / value) * 100),
      "(loan_amount + junior_lien_credit_limit) / value",
      inputs,
    ),
  };
}

export function fundsToClose(
  file: LoanFile,
  estimatedFees: number,
  estimatedPrepaids: number,
  log: DerivationLog,
): number | null {
  if (!file.loan || !file.property) {
    return log.blocked("AST-002", "Funds to close", ["loan terms", "property"]);
  }
  const base =
    file.loan.purpose === "purchase"
      ? file.property.valueOrPrice
      : (file.loan.existingLoan?.balance ?? 0);
  const credits = file.loan.interestedPartyContributions;
  const total = base + estimatedFees + estimatedPrepaids - credits - file.loan.loanAmount;
  return log.record(
    "AST-002",
    "Funds to close",
    round(total),
    "price_or_payoff + fees + prepaids - credits - loan_amount",
    {
      price_or_payoff: base,
      fees: estimatedFees,
      prepaids: estimatedPrepaids,
      credits,
      loan_amount: file.loan.loanAmount,
    },
  );
}

export function reserves(
  file: LoanFile,
  pitia: number | null,
  fundsNeeded: number | null,
  log: DerivationLog,
): ReserveAssessment {
  if (!file.property) {
    log.blocked("AST-003", "Reserve requirement", ["property"]);
    return {
      requiredMonths: null,
      actualMonths: null,
      eligiblePostCloseAssets: null,
      satisfied: null,
    };
  }

  const g = GUIDELINES.reserves;
  const byOccupancy =
    file.property.occupancy === "primary_residence"
      ? g.primaryResidenceMonths
      : file.property.occupancy === "second_home"
        ? g.secondHomeMonths
        : g.investmentMonths;
  const additional = Math.max(0, file.property.financedPropertyCount - 1);
  const requiredMonths = log.record(
    "AST-003",
    "Required reserve months",
    byOccupancy + additional * g.perAdditionalFinancedPropertyMonths,
    "occupancy base + per additional financed property",
    {
      occupancy: file.property.occupancy,
      occupancy_base_months: byOccupancy,
      additional_financed_properties: additional,
    },
  );

  // Every borrower's accounts, a joint account once. Computed on whoever has
  // connected a bank: assets only add, so a co-borrower who has not linked
  // one leaves the household with fewer reserves rather than with none, and
  // the derivation says how many of them counted.
  const banks = householdAccounts(file);
  if (banks.withAssets.length === 0 || pitia === null || fundsNeeded === null) {
    log.blocked(
      "AST-004",
      "Reserves satisfied",
      [
        banks.withAssets.length === 0 ? "bank connection" : null,
        pitia === null ? "housing payment" : null,
        fundsNeeded === null ? "funds to close" : null,
      ].filter((x): x is string => x !== null),
    );
    return { requiredMonths, actualMonths: null, eligiblePostCloseAssets: null, satisfied: null };
  }

  // Retirement money counts at a haircut because liquidating it costs
  // penalties and tax; the vested balance is not what actually arrives.
  const RETIREMENT_HAIRCUT = 0.6;
  const eligible = banks.accounts
    .filter((a) => a.usedForQualifying)
    .reduce(
      (sum, a) =>
        sum +
        (a.type === "retirement" ? (a.vestedBalance ?? 0) * RETIREMENT_HAIRCUT : a.currentBalance),
      0,
    );

  const postClose = Math.max(0, eligible - fundsNeeded);
  const eligiblePostCloseAssets = log.record(
    "AST-004",
    "Eligible post-close assets",
    round(postClose),
    "eligible assets across every connected bank, a joint account once, - funds to close " +
      "(retirement counted at 60%)",
    {
      eligible_assets: round(eligible),
      funds_to_close: fundsNeeded,
      borrowers_with_assets: banks.withAssets.length,
      borrowers_without_assets: banks.withoutAssets.length,
      joint_accounts_deduplicated: banks.deduplicated,
    },
  );

  const actualMonths =
    pitia === 0
      ? 0
      : log.record(
          "AST-004",
          "Actual reserve months",
          round(postClose / pitia, 1),
          "eligible_post_close_assets / monthly_PITIA",
          { eligible_post_close_assets: eligiblePostCloseAssets, monthly_PITIA: pitia },
        );

  return {
    requiredMonths,
    actualMonths,
    eligiblePostCloseAssets,
    satisfied: actualMonths >= requiredMonths,
  };
}
