/**
 * The arithmetic behind screen 8.
 *
 * Every function takes the loan file and a `DerivationLog`, and every number
 * it produces goes through the log. Functions return `null` rather than
 * guessing when an input is missing — a DTI computed against an assumed income
 * is worse than no DTI, because it looks like an answer.
 */

import type { LoanFile } from "@sm/shared";
import { DerivationLog, round } from "./derive.js";
import { GUIDELINES } from "./guidelines.js";

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
const ESCROW_ASSUMPTION = {
  annualTaxRate: 0.011,
  annualInsuranceRate: 0.0035,
};

/** Middle score per borrower; lowest of those across borrowers (CRD-002). */
export function representativeFico(file: LoanFile, log: DerivationLog): number | null {
  if (!file.credit || file.credit.scores.length === 0) {
    return log.blocked("CRD-002", "Representative FICO", ["credit report"]);
  }
  const scores = [...file.credit.scores].map((s) => s.score).sort((a, b) => a - b);
  // Three bureaus → the middle one. Two → the lower. One → itself.
  const middle = scores.length >= 3 ? scores[1] : scores[0];
  if (middle === undefined) {
    return log.blocked("CRD-002", "Representative FICO", ["credit report scores"]);
  }
  return log.record(
    "CRD-002",
    "Representative FICO",
    middle,
    scores.length >= 3
      ? "middle of three bureau scores"
      : `lowest of ${scores.length} available bureau score(s)`,
    Object.fromEntries(file.credit.scores.map((s) => [s.bureau, s.score])),
  );
}

export function revolvingUtilization(file: LoanFile, log: DerivationLog): number | null {
  if (!file.credit) return log.blocked("CRD-016", "Revolving utilization", ["credit report"]);
  const revolving = file.credit.tradelines.filter((t) => t.type === "revolving" || t.type === "heloc");
  const limit = revolving.reduce((sum, t) => sum + (t.creditLimit ?? 0), 0);
  if (limit === 0) {
    return log.record("CRD-016", "Revolving utilization", 0, "no revolving limit on file", {
      revolvingLines: revolving.length,
    });
  }
  const balance = revolving.reduce((sum, t) => sum + t.balance, 0);
  return log.record(
    "CRD-016",
    "Revolving utilization",
    round((balance / limit) * 100),
    "revolving_balance / revolving_limit",
    { revolving_balance: balance, revolving_limit: limit },
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
function monthlyPrincipalAndInterest(amount: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return amount / termMonths;
  return (amount * r) / (1 - Math.pow(1 + r, -termMonths));
}

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
  return log.record(
    "UW-004",
    "Housing PITIA",
    round(pi + taxes + insurance),
    "P&I + escrowed taxes and insurance (ESTIMATED from national averages — no tax bill or insurance quote is collected)",
    {
      principal_and_interest: round(pi),
      estimated_monthly_taxes: round(taxes),
      estimated_monthly_insurance: round(insurance),
      note_rate: file.product.noteRate,
      term_months: file.product.termMonths,
    },
  );
}

/** Monthly liabilities from the credit report, less anything excluded. */
export function monthlyLiabilities(file: LoanFile, log: DerivationLog): number | null {
  if (!file.credit) return log.blocked("UW-004", "Monthly liabilities", ["credit report"]);
  const counted = file.credit.tradelines.filter((t) => !t.exclusionReasonCode);
  const total = counted.reduce((sum, t) => sum + t.monthlyPayment, 0);
  return log.record(
    "UW-004",
    "Monthly liabilities",
    round(total),
    "sum of tradeline monthly payments, excluding those with a reason code",
    {
      tradelines_counted: counted.length,
      tradelines_excluded: file.credit.tradelines.length - counted.length,
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
    log.blocked("UW-004", "DTI", [
      income === null || income === 0 ? "qualifying income" : null,
      pitia === null ? "housing payment" : null,
    ].filter((x): x is string => x !== null));
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
    ltv: log.record("UW-005", "LTV", round((file.loan.loanAmount / value) * 100), "loan_amount / value", inputs),
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

export interface ReserveResult {
  readonly requiredMonths: number | null;
  readonly actualMonths: number | null;
  readonly eligiblePostCloseAssets: number | null;
  readonly satisfied: boolean | null;
}

export function reserves(
  file: LoanFile,
  pitia: number | null,
  fundsNeeded: number | null,
  log: DerivationLog,
): ReserveResult {
  if (!file.property) {
    log.blocked("AST-003", "Reserve requirement", ["property"]);
    return { requiredMonths: null, actualMonths: null, eligiblePostCloseAssets: null, satisfied: null };
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

  if (!file.assets || pitia === null || fundsNeeded === null) {
    log.blocked("AST-004", "Reserves satisfied", [
      !file.assets ? "bank connection" : null,
      pitia === null ? "housing payment" : null,
      fundsNeeded === null ? "funds to close" : null,
    ].filter((x): x is string => x !== null));
    return { requiredMonths, actualMonths: null, eligiblePostCloseAssets: null, satisfied: null };
  }

  // Retirement money counts at a haircut because liquidating it costs
  // penalties and tax; the vested balance is not what actually arrives.
  const RETIREMENT_HAIRCUT = 0.6;
  const eligible = file.assets.accounts
    .filter((a) => a.usedForQualifying)
    .reduce(
      (sum, a) =>
        sum +
        (a.type === "retirement"
          ? (a.vestedBalance ?? 0) * RETIREMENT_HAIRCUT
          : a.currentBalance),
      0,
    );

  const postClose = Math.max(0, eligible - fundsNeeded);
  const eligiblePostCloseAssets = log.record(
    "AST-004",
    "Eligible post-close assets",
    round(postClose),
    "eligible assets - funds to close (retirement counted at 60%)",
    { eligible_assets: round(eligible), funds_to_close: fundsNeeded },
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
