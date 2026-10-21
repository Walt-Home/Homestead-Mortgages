/**
 * The grader is the shadow AUS's own price tests.
 *
 * What a task should conclude is `@hm/underwriting` run on it, composed the
 * way `resolveMarketInputs` composes it — the fee schedule priced against
 * the loan, the APR by Appendix J (refused for a loan that is not fixed-rate
 * or carries mortgage insurance), the APOR for the week the rate was set in
 * New York — and then `runComplianceTests` itself. The one difference from
 * production is the schedule: each task carries its own lender's fees, and
 * each line's two flags follow from who is paid, the way the production
 * schedule's notes classify its own lines.
 */

import type { ComplianceTests, LoanFile } from "@hm/shared";
import {
  APOR_TABLE,
  DerivationLog,
  annualPercentageRate,
  closingCosts,
  hoepaPointsAndFeesLimit,
  lookupApor,
  mortgageInsuranceRate,
  pointsAndFeesLimit,
  round,
  runComplianceTests,
  thresholdsFor,
  type AporLookup,
  type AprResult,
  type ClosingCosts,
  type FeeSchedule,
  type MarketInputs,
  type RegulationZThresholds,
} from "@hm/underwriting";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import type { Payee, RegzTask } from "./task.js";

/** Who is paid decides both flags: what the lender or its affiliate keeps is a finance charge and in points and fees. */
export const KEPT_BY_LENDER: readonly Payee[] = ["lender", "affiliate"];

export function scheduleOf(task: RegzTask): FeeSchedule {
  return {
    version: `task:${task.id}`,
    effectiveFrom: "2026-01-01",
    lines: task.fees.map((f) => {
      const kept = KEPT_BY_LENDER.includes(f.payee);
      return {
        name: f.name,
        payee: f.payee,
        basis: f.percent_of_loan_amount !== undefined ? "percent_of_loan_amount" : "fixed",
        amount:
          f.percent_of_loan_amount !== undefined
            ? Number(f.percent_of_loan_amount)
            : (f.amount_cents ?? 0) / 100,
        financeCharge: kept,
        pointsAndFees: kept,
        basisNote: kept
          ? "kept by the lender or its affiliate"
          : "paid on to an unaffiliated party",
      };
    }),
  };
}

/** A LoanFile carrying exactly what the price tests read, and nothing they do not. */
export function fileOf(task: RegzTask): LoanFile {
  const l = task.loan;
  return {
    loan: {
      purpose: l.purpose,
      loanAmount: l.amount_cents / 100,
      downPayment: 0,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
      ...(task.existing_loan
        ? {
            existingLoan: {
              monthlyPayment: task.existing_loan.monthly_payment_cents / 100,
              paymentBasis: task.existing_loan.payment_basis,
              rate:
                task.existing_loan.rate_pct === null ? null : Number(task.existing_loan.rate_pct),
            },
          }
        : {}),
    },
    product: {
      productCode: "task",
      termMonths: l.term_months,
      amortization: l.amortization,
      noteRate: Number(l.note_rate_pct),
      rateQuotedAt: task.rate_quoted_at,
      prepaymentPenalty: l.prepayment_penalty,
      overlays: [],
    },
    property: {
      propertyType: task.property.property_type,
      occupancy: task.property.occupancy,
      valueOrPrice: task.property.value_cents / 100,
    },
    // Ability to repay is documented when income, assets and liabilities are verified and DTI computed.
    credit: task.atr_documented ? {} : null,
    assets: task.atr_documented ? {} : null,
    incomeSources: task.atr_documented ? [{}] : [],
  } as unknown as LoanFile;
}

export interface RegzAnalysis {
  readonly costs: ClosingCosts;
  readonly ltv: number;
  readonly apr: AprResult;
  readonly apor: AporLookup;
  readonly totalLoanAmount: number;
  readonly market: MarketInputs;
  readonly tests: ComplianceTests;
  readonly thresholds: RegulationZThresholds | null;
}

/** The engine's run over the task, every intermediate kept. */
export function analyzeRegz(task: RegzTask): RegzAnalysis {
  const file = fileOf(task);
  const loanAmount = task.loan.amount_cents / 100;
  const value = task.property.value_cents / 100;
  const costs = closingCosts(scheduleOf(task), loanAmount);
  if (costs === null) throw new RangeError(`${task.id}: no priced schedule`);
  const ltv = (loanAmount / value) * 100;
  const apr = annualPercentageRate({
    loanAmount,
    noteRate: Number(task.loan.note_rate_pct),
    termMonths: task.loan.term_months,
    amortization: task.loan.amortization,
    prepaidFinanceCharges: costs.prepaidFinanceCharges,
    mortgageInsuranceApplies: ltv > 80 || mortgageInsuranceRate(ltv) > 0,
  });
  const apor = lookupApor(
    APOR_TABLE,
    new Date(task.rate_quoted_at),
    task.loan.term_months,
    task.loan.amortization,
  );
  const totalLoanAmount = round(loanAmount - costs.prepaidFinanceCharges, 2);
  const market: MarketInputs = {
    ...(apr.computed ? { apr: apr.apr } : {}),
    ...(apor.found ? { apor: apor.rate } : {}),
    pointsAndFeesAmount: costs.pointsAndFees,
    totalLoanAmount,
    closingCostTotal: costs.total,
  };
  const tests = runComplianceTests(
    file,
    market,
    task.atr_documented ? 36 : null,
    new DerivationLog(),
  );
  const thresholds = apor.found ? thresholdsFor(apor.setOn) : null;
  return { costs, ltv, apr, apor, totalLoanAmount, market, tests, thresholds };
}

/** Cents as decimal strings; rates as the decimals the rules state them in; null where a test cannot be decided. */
export interface RegzAnswer {
  readonly closing_cost_total_cents: string;
  readonly points_and_fees_cents: string;
  readonly prepaid_finance_charges_cents: string;
  readonly total_loan_amount_cents: string;
  readonly apr_pct: string | null;
  readonly apor_pct: string | null;
  readonly qm_status: "qm" | "non_qm" | null;
  readonly points_and_fees_limit_cents: string;
  readonly points_and_fees_pass: boolean;
  readonly is_hpml: boolean | null;
  readonly hoepa_apr_trigger: boolean | null;
  readonly hoepa_fee_trigger: boolean;
  readonly hoepa_prepayment_penalty_trigger: boolean | null;
  readonly is_high_cost: boolean | null;
  readonly ntb_recoup_months: string | null;
  readonly ntb_satisfied: boolean | null;
}

const centsOf = (dollars: number): string => String(Math.round(dollars * 100));

export function expectedRegz(task: RegzTask): RegzAnswer {
  const a = analyzeRegz(task);
  const t = a.tests;
  // Every task is dated in 2026, the one year the engine holds thresholds for.
  const thresholds = thresholdsFor("2026-06-01")!;
  const loanAmount = task.loan.amount_cents / 100;
  const limit = pointsAndFeesLimit(loanAmount, a.totalLoanAmount, thresholds);
  const hoepaLimit = hoepaPointsAndFeesLimit(loanAmount, a.totalLoanAmount, thresholds);
  const ntb = t.netTangibleBenefit;
  return {
    closing_cost_total_cents: centsOf(a.costs.total),
    points_and_fees_cents: centsOf(a.costs.pointsAndFees),
    prepaid_finance_charges_cents: centsOf(a.costs.prepaidFinanceCharges),
    total_loan_amount_cents: centsOf(a.totalLoanAmount),
    apr_pct: a.apr.computed ? a.apr.apr.toFixed(3) : null,
    apor_pct: a.apor.found ? a.apor.rate.toFixed(2) : null,
    qm_status: t.qmStatus ?? null,
    points_and_fees_limit_cents: String(limit.limitCents),
    points_and_fees_pass: t.pointsAndFeesPass === true,
    is_hpml: t.isHpml,
    hoepa_apr_trigger: t.hoepaTriggers?.apr ?? null,
    // Priced from the task's own schedule, so never blocked; the engine's own figure, checked against its limit.
    hoepa_fee_trigger:
      t.hoepaTriggers?.pointsAndFees ??
      Math.round(a.costs.pointsAndFees * 100) > hoepaLimit.limitCents,
    hoepa_prepayment_penalty_trigger: t.hoepaTriggers?.prepaymentPenalty ?? null,
    is_high_cost: t.isHighCost,
    ntb_recoup_months: ntb && ntb.recoupMonths !== null ? ntb.recoupMonths.toFixed(1) : null,
    ntb_satisfied: ntb ? ntb.satisfied : null,
  };
}

export const REGZ_FIELDS: readonly (keyof RegzAnswer)[] = [
  "closing_cost_total_cents",
  "points_and_fees_cents",
  "prepaid_finance_charges_cents",
  "total_loan_amount_cents",
  "apr_pct",
  "apor_pct",
  "qm_status",
  "points_and_fees_limit_cents",
  "points_and_fees_pass",
  "is_hpml",
  "hoepa_apr_trigger",
  "hoepa_fee_trigger",
  "hoepa_prepayment_penalty_trigger",
  "is_high_cost",
  "ntb_recoup_months",
  "ntb_satisfied",
];

const shown = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));

export function gradeRegzAgainst(want: RegzAnswer, answer: RegzAnswer | null): Grade {
  const fields: FieldGrade[] = REGZ_FIELDS.map((f) => {
    const expected = shown(want[f]);
    const got = answer ? shown(answer[f]) : null;
    return { field: f, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeRegz = (task: RegzTask, answer: RegzAnswer | null): Grade =>
  gradeRegzAgainst(expectedRegz(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const CENTS = new Set<keyof RegzAnswer>([
  "closing_cost_total_cents",
  "points_and_fees_cents",
  "prepaid_finance_charges_cents",
  "total_loan_amount_cents",
  "points_and_fees_limit_cents",
]);
const NULLABLE_BOOL = new Set<keyof RegzAnswer>([
  "is_hpml",
  "hoepa_apr_trigger",
  "hoepa_prepayment_penalty_trigger",
  "is_high_cost",
  "ntb_satisfied",
]);
const RATES: Readonly<Partial<Record<keyof RegzAnswer, RegExp>>> = {
  apr_pct: /^\d{1,3}\.\d{3}$/,
  apor_pct: /^\d{1,2}\.\d{2}$/,
  ntb_recoup_months: /^\d{1,4}\.\d$/,
};

export function parseRegzSubmission(raw: unknown): Parsed<RegzAnswer> {
  const fail = (error: string): Parsed<RegzAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_tests again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of REGZ_FIELDS) {
    const v = s[f];
    if (CENTS.has(f)) {
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) out[f] = BigInt(v.trim()).toString();
      else if (typeof v === "number" && Number.isSafeInteger(v)) out[f] = String(v);
      else return fail(`${f} must be integer cents as a string, e.g. "412345"`);
    } else if (f === "points_and_fees_pass" || f === "hoepa_fee_trigger") {
      if (typeof v !== "boolean") return fail(`${f} must be true or false`);
      out[f] = v;
    } else if (NULLABLE_BOOL.has(f)) {
      if (v !== null && typeof v !== "boolean") return fail(`${f} must be true, false or null`);
      out[f] = v;
    } else if (f === "qm_status") {
      if (v !== null && v !== "qm" && v !== "non_qm")
        return fail(`${f} must be "qm", "non_qm" or null`);
      out[f] = v;
    } else {
      const shape = RATES[f]!;
      if (v === null) out[f] = null;
      else if (typeof v === "string" && shape.test(v.trim())) out[f] = v.trim();
      else
        return fail(
          `${f} must be a decimal string like ${f === "apor_pct" ? '"6.55"' : f === "apr_pct" ? '"6.838"' : '"23.4"'}, or null`,
        );
    }
  }
  return { ok: true, answer: out as unknown as RegzAnswer };
}
