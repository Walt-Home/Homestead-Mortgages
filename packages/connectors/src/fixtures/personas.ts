/**
 * Fixture borrowers.
 *
 * These are not test data in the throwaway sense — they are the product's
 * only borrowers until vendor contracts exist, so each one is built to
 * exercise a different branch of the requirement graph. Between them they
 * turn on 20 of the 35 condition predicates.
 *
 * Dates are generated relative to a reference date rather than hardcoded,
 * because half the conditions in the sheet are recency windows ("inquiries in
 * last 90 days", "gap over 30 days in 2 years"). A fixture with a frozen 2026
 * date would quietly stop exercising them.
 */

import type { AssetReport, CreditReport, PayrollData, TaxTranscript } from "@hm/shared";

export type PersonaId = "clean_w2" | "thin_file_renter" | "variable_income";

/**
 * The loan each persona is meant to be paired with.
 *
 * Fixture data without a matching loan is only half a fixture: a borrower
 * earning $7,843 a month against a $520,000 loan produces a 58% DTI and a
 * decline, which tells you nothing about whether the happy path works. Each
 * scenario is sized so the persona lands where they are supposed to land —
 * `clean_w2` approves, `thin_file_renter` clears with elevated DTI,
 * `variable_income` reaches the decision carrying conditions.
 */
export interface PersonaScenario {
  readonly purpose: "purchase" | "rate_term_refinance" | "cash_out_refinance";
  readonly valueOrPrice: number;
  readonly downPayment: number;
  readonly loanAmount: number;
  readonly propertyType: "single_family" | "condo" | "townhouse" | "two_to_four_unit";
  readonly occupancy: "primary_residence" | "second_home" | "investment";
  readonly state: string;
  /** Where this scenario is meant to end up, so a drifting fixture is visible. */
  readonly expectation: string;
}

export interface Persona {
  readonly id: PersonaId;
  readonly label: string;
  /** What this persona is here to exercise. */
  readonly exercises: string;
  readonly scenario: PersonaScenario;
  readonly credit: (ref: Date) => CreditReport;
  readonly assets: (ref: Date) => AssetReport;
  readonly payroll: (ref: Date) => PayrollData;
  readonly transcripts: (ref: Date) => readonly TaxTranscript[];
}

/** ISO date `months` before the reference date. */
function monthsBefore(ref: Date, months: number): string {
  const d = new Date(ref);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function daysBefore(ref: Date, days: number): string {
  const d = new Date(ref);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** `count` months of clean payment history, newest first. */
function cleanHistory(count: number): string[] {
  return Array.from({ length: count }, () => "0");
}

function balanceHistory(ref: Date, months: number, base: number, drift: number) {
  return Array.from({ length: months }, (_, i) => ({
    month: monthsBefore(ref, i).slice(0, 7),
    balance: base - i * drift,
  }));
}

/* ── Persona 1 · the clean W-2 borrower ─────────────────────────────────── */
// The happy path. Everything connects, nothing needs an upload, and the
// decision screen should be reachable without a single document.

const cleanW2: Persona = {
  id: "clean_w2",
  label: "Dana Whitfield — W-2, 740 FICO, 20% down",
  exercises: "the path where all four connectors succeed and no fallback is needed",
  scenario: {
    purpose: "purchase",
    valueOrPrice: 415_000,
    downPayment: 83_000,
    loanAmount: 332_000,
    propertyType: "single_family",
    occupancy: "primary_residence",
    state: "TX",
    expectation:
      "approves — DTI around 40%, 80% LTV, no conditions beyond blocked compliance inputs",
  },
  credit: (ref) => ({
    reportId: "fixture-credit-clean",
    reportDate: ref.toISOString().slice(0, 10),
    pullType: "soft",
    scores: [
      { bureau: "equifax", score: 742, model: "FICO 5" },
      { bureau: "experian", score: 738, model: "FICO 2" },
      { bureau: "transunion", score: 751, model: "FICO 4" },
    ],
    tradelines: [
      {
        id: "tl-1",
        creditorName: "Fixture Auto Finance",
        type: "auto",
        balance: 14_200,
        monthlyPayment: 389,
        openedDate: monthsBefore(ref, 31),
        disputed: false,
        paymentHistory: cleanHistory(24),
        maxDelinquency: 0,
      },
      {
        id: "tl-2",
        creditorName: "Fixture Card",
        type: "revolving",
        balance: 2_140,
        monthlyPayment: 45,
        creditLimit: 12_000,
        openedDate: monthsBefore(ref, 71),
        disputed: false,
        paymentHistory: cleanHistory(24),
        maxDelinquency: 0,
      },
      {
        id: "tl-3",
        creditorName: "Fixture Student Loans",
        type: "student",
        balance: 8_900,
        monthlyPayment: 142,
        openedDate: monthsBefore(ref, 96),
        disputed: false,
        paymentHistory: cleanHistory(24),
        maxDelinquency: 0,
      },
    ],
    publicRecords: [],
    inquiries: [],
    fraudAlert: false,
    ssnMismatch: false,
  }),
  assets: (ref) => ({
    reportId: "fixture-assets-clean",
    generatedAt: ref.toISOString(),
    monthsCovered: 12,
    vendorAuthorizedForDu: true,
    accounts: [
      {
        id: "acct-1",
        institution: "Fixture Savings Bank",
        type: "checking",
        mask: "4471",
        currentBalance: 18_430,
        balanceHistory: balanceHistory(ref, 12, 18_430, 220),
        usedForQualifying: true,
      },
      {
        id: "acct-2",
        institution: "Fixture Savings Bank",
        type: "savings",
        mask: "9902",
        currentBalance: 71_500,
        balanceHistory: balanceHistory(ref, 12, 71_500, 1_100),
        usedForQualifying: true,
      },
    ],
    largeDeposits: [],
    cashFlowAssessmentResult: "positive",
    alternativeReferences: [
      {
        kind: "rent",
        payeeName: "Fixture Property Management",
        monthsOfHistory: 12,
        monthlyAmount: 2_150,
        onTime: true,
      },
      {
        kind: "utility",
        payeeName: "Fixture Energy",
        monthsOfHistory: 12,
        monthlyAmount: 141,
        onTime: true,
      },
      {
        kind: "insurance",
        payeeName: "Fixture Mutual",
        monthsOfHistory: 12,
        monthlyAmount: 96,
        onTime: true,
      },
    ],
    identifiedRentPayments: 12,
    identifiedMonthlyRent: 2_150,
    gifts: [],
    borrowedFunds: [],
    earnestMoneyVerified: true,
  }),
  payroll: (ref) => ({
    connectionId: "fixture-payroll-clean",
    employments: [
      {
        employerName: "Fixture Health Systems",
        employerEin: "00-0000001",
        position: "Registered Nurse",
        startDate: monthsBefore(ref, 52),
        status: "active",
        isMilitary: false,
        verificationMethod: "payroll_connector",
      },
    ],
    paystubs: [
      { payPeriodEnd: daysBefore(ref, 6), grossPay: 3_620, ytdGross: 68_780 },
      { payPeriodEnd: daysBefore(ref, 20), grossPay: 3_620, ytdGross: 65_160 },
      { payPeriodEnd: daysBefore(ref, 34), grossPay: 3_620, ytdGross: 61_540 },
    ],
    gaps: [],
    incomeSources: [
      {
        type: "base_wage",
        monthlyAmount: 7_843,
        historyMonths: 52,
        continuanceEstablished: true,
        evidenceDocumentIds: [],
      },
    ],
  }),
  transcripts: (ref) => [
    {
      taxYear: ref.getFullYear() - 1,
      agi: 91_400,
      wages: 91_400,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
    {
      taxYear: ref.getFullYear() - 2,
      agi: 87_900,
      wages: 87_900,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
  ],
};

/* ── Persona 2 · the thin-file renter ───────────────────────────────────── */
// Two tradelines and no mortgage history. This is the borrower CRD-013 and
// CRD-018 exist for, and the one where the 12-month bank report is the only
// thing standing between them and a decline.

const thinFileRenter: Persona = {
  id: "thin_file_renter",
  label: "Marcus Adeyemi — thin file, 12 months of on-time rent",
  exercises: "non-traditional credit (CRD-013), rent history (CRD-018), cash flow (CRD-017)",
  scenario: {
    purpose: "purchase",
    // Resized when mortgage insurance was added to PITIA. At the original
    // $340,000 this persona sat at 46.4% DTI only because MI was missing
    // entirely; with it he was at 50.35% and failed outright. A 95% LTV
    // borrower pays MI, and the fixture has to be a borrower who actually
    // qualifies if it is going to demonstrate a thin file being made lendable.
    valueOrPrice: 299_000,
    downPayment: 14_950,
    loanAmount: 284_050,
    propertyType: "condo",
    occupancy: "primary_residence",
    state: "GA",
    expectation:
      "qualifies with an elevated-DTI finding at 95% LTV, mortgage insurance included; the 12-month bank report and four alternative references are what make the thin file workable",
  },
  credit: (ref) => ({
    reportId: "fixture-credit-thin",
    reportDate: ref.toISOString().slice(0, 10),
    pullType: "soft",
    scores: [
      { bureau: "equifax", score: 663, model: "FICO 5" },
      { bureau: "experian", score: 671, model: "FICO 2" },
      { bureau: "transunion", score: 658, model: "FICO 4" },
    ],
    tradelines: [
      {
        id: "tl-1",
        creditorName: "Fixture Secured Card",
        type: "revolving",
        balance: 410,
        monthlyPayment: 25,
        creditLimit: 1_000,
        openedDate: monthsBefore(ref, 19),
        disputed: false,
        paymentHistory: cleanHistory(19),
        maxDelinquency: 0,
      },
      {
        id: "tl-2",
        creditorName: "Fixture Retail",
        type: "revolving",
        balance: 0,
        monthlyPayment: 0,
        creditLimit: 2_500,
        openedDate: monthsBefore(ref, 14),
        disputed: false,
        paymentHistory: cleanHistory(14),
        maxDelinquency: 0,
        // A zero-balance line still has to be reconciled (CRD-003), and this
        // is what an exclusion with a reason looks like.
        exclusionReasonCode: "zero_balance_no_payment",
      },
    ],
    publicRecords: [],
    inquiries: [
      { creditorName: "Fixture Credit Union", date: daysBefore(ref, 41), resultedInNewDebt: null },
    ],
    fraudAlert: false,
    ssnMismatch: false,
  }),
  assets: (ref) => ({
    reportId: "fixture-assets-thin",
    generatedAt: ref.toISOString(),
    monthsCovered: 12,
    vendorAuthorizedForDu: true,
    accounts: [
      {
        id: "acct-1",
        institution: "Fixture Credit Union",
        type: "checking",
        mask: "3310",
        currentBalance: 9_240,
        balanceHistory: balanceHistory(ref, 12, 9_240, 90),
        usedForQualifying: true,
      },
    ],
    largeDeposits: [
      {
        accountId: "acct-1",
        date: daysBefore(ref, 52),
        amount: 6_000,
        description: "TRANSFER FROM FIXTURE BROKERAGE",
        // Deliberately unsourced — this is what makes AST-005 fire.
      },
    ],
    cashFlowAssessmentResult: "positive",
    // Four references, which is the whole point of this persona: a thin credit
    // file that the 12-month bank report can still make lendable.
    alternativeReferences: [
      {
        kind: "rent",
        payeeName: "Fixture Residential",
        monthsOfHistory: 12,
        monthlyAmount: 1_680,
        onTime: true,
      },
      {
        kind: "utility",
        payeeName: "Fixture Power & Light",
        monthsOfHistory: 12,
        monthlyAmount: 118,
        onTime: true,
      },
      {
        kind: "insurance",
        payeeName: "Fixture Renters Insurance",
        monthsOfHistory: 12,
        monthlyAmount: 22,
        onTime: true,
      },
      {
        kind: "phone",
        payeeName: "Fixture Mobile",
        monthsOfHistory: 12,
        monthlyAmount: 65,
        onTime: true,
      },
    ],
    identifiedRentPayments: 12,
    identifiedMonthlyRent: 1_680,
    gifts: [],
    borrowedFunds: [],
    earnestMoneyVerified: false,
  }),
  payroll: (ref) => ({
    connectionId: "fixture-payroll-thin",
    employments: [
      {
        employerName: "Fixture Logistics",
        employerEin: "00-0000002",
        position: "Dispatch Supervisor",
        startDate: monthsBefore(ref, 26),
        status: "active",
        isMilitary: false,
        verificationMethod: "payroll_connector",
      },
    ],
    paystubs: [
      { payPeriodEnd: daysBefore(ref, 4), grossPay: 2_410, ytdGross: 43_380 },
      { payPeriodEnd: daysBefore(ref, 18), grossPay: 2_410, ytdGross: 40_970 },
    ],
    gaps: [],
    incomeSources: [
      {
        type: "base_wage",
        monthlyAmount: 5_222,
        historyMonths: 26,
        continuanceEstablished: true,
        evidenceDocumentIds: [],
      },
    ],
  }),
  transcripts: (ref) => [
    {
      taxYear: ref.getFullYear() - 1,
      agi: 61_200,
      wages: 61_200,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
    {
      taxYear: ref.getFullYear() - 2,
      agi: 58_400,
      wages: 58_400,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
  ],
};

/* ── Persona 3 · commission income and a gap ────────────────────────────── */
// Variable income, an employment gap, a gift, and a disputed tradeline. This
// is the persona that should NOT reach a decision without screen 7.

const variableIncome: Persona = {
  id: "variable_income",
  label: "Priya Raman — commission income, 4-month gap, gift funds",
  exercises: "variable income (INC-005), gap (INC-006), gift (AST-006), dispute (CRD-014)",
  scenario: {
    purpose: "purchase",
    valueOrPrice: 420_000,
    downPayment: 84_000,
    loanAmount: 336_000,
    propertyType: "single_family",
    occupancy: "primary_residence",
    state: "CA",
    expectation:
      "reaches the decision carrying conditions — her commission has 9 months of history, so it does not count toward qualifying income",
  },
  credit: (ref) => ({
    reportId: "fixture-credit-variable",
    reportDate: ref.toISOString().slice(0, 10),
    pullType: "soft",
    scores: [
      { bureau: "equifax", score: 704, model: "FICO 5" },
      { bureau: "experian", score: 698, model: "FICO 2" },
      { bureau: "transunion", score: 712, model: "FICO 4" },
    ],
    tradelines: [
      {
        id: "tl-1",
        creditorName: "Fixture Card",
        type: "revolving",
        balance: 8_900,
        monthlyPayment: 220,
        creditLimit: 15_000,
        openedDate: monthsBefore(ref, 44),
        disputed: true,
        paymentHistory: ["0", "0", "1", ...cleanHistory(21)],
        maxDelinquency: 1,
      },
      {
        id: "tl-2",
        creditorName: "Fixture Auto Finance",
        type: "auto",
        balance: 21_300,
        monthlyPayment: 512,
        openedDate: monthsBefore(ref, 17),
        disputed: false,
        paymentHistory: cleanHistory(17),
        maxDelinquency: 0,
      },
    ],
    publicRecords: [],
    inquiries: [
      { creditorName: "Fixture Bank", date: daysBefore(ref, 12), resultedInNewDebt: null },
      { creditorName: "Fixture Auto Finance", date: daysBefore(ref, 63), resultedInNewDebt: true },
    ],
    fraudAlert: false,
    ssnMismatch: false,
  }),
  assets: (ref) => ({
    reportId: "fixture-assets-variable",
    generatedAt: ref.toISOString(),
    monthsCovered: 12,
    vendorAuthorizedForDu: true,
    accounts: [
      {
        id: "acct-1",
        institution: "Fixture National",
        type: "checking",
        mask: "7781",
        currentBalance: 24_100,
        balanceHistory: balanceHistory(ref, 12, 24_100, 400),
        usedForQualifying: true,
      },
      {
        id: "acct-2",
        institution: "Fixture National",
        type: "retirement",
        mask: "2203",
        currentBalance: 88_000,
        balanceHistory: balanceHistory(ref, 12, 88_000, 700),
        vestedBalance: 88_000,
        outstandingPlanLoans: 0,
        withdrawalEligible: true,
        usedForQualifying: true,
      },
    ],
    largeDeposits: [
      {
        accountId: "acct-1",
        date: daysBefore(ref, 28),
        amount: 20_000,
        description: "GIFT — R RAMAN",
        sourceType: "gift",
      },
    ],
    cashFlowAssessmentResult: "positive",
    alternativeReferences: [
      {
        kind: "rent",
        payeeName: "Fixture Lofts",
        monthsOfHistory: 12,
        monthlyAmount: 2_900,
        onTime: true,
      },
      {
        kind: "utility",
        payeeName: "Fixture Utilities",
        monthsOfHistory: 12,
        monthlyAmount: 173,
        onTime: true,
      },
    ],
    identifiedRentPayments: 12,
    identifiedMonthlyRent: 2_900,
    gifts: [
      {
        amount: 20_000,
        donorName: "Raj Raman",
        donorRelationship: "parent",
        transferDate: daysBefore(ref, 28),
        // No donor ability evidence — AST-006 fires, and screen 7 asks for it.
      },
    ],
    borrowedFunds: [],
    earnestMoneyVerified: true,
  }),
  payroll: (ref) => ({
    connectionId: "fixture-payroll-variable",
    employments: [
      {
        employerName: "Fixture Software",
        employerEin: "00-0000003",
        position: "Account Executive",
        startDate: monthsBefore(ref, 14),
        status: "active",
        isMilitary: false,
        verificationMethod: "payroll_connector",
      },
      {
        employerName: "Fixture Media",
        employerEin: "00-0000004",
        position: "Sales Manager",
        startDate: monthsBefore(ref, 40),
        endDate: monthsBefore(ref, 18),
        status: "ended",
        isMilitary: false,
        verificationMethod: "payroll_connector",
      },
    ],
    paystubs: [
      { payPeriodEnd: daysBefore(ref, 8), grossPay: 5_800, ytdGross: 104_400 },
      { payPeriodEnd: daysBefore(ref, 22), grossPay: 4_100, ytdGross: 98_600 },
    ],
    gaps: [
      {
        startDate: monthsBefore(ref, 18),
        endDate: monthsBefore(ref, 14),
        days: 122,
        // No reason code — INC-006 fires.
      },
    ],
    incomeSources: [
      {
        type: "base_wage",
        monthlyAmount: 7_083,
        historyMonths: 14,
        continuanceEstablished: true,
        evidenceDocumentIds: [],
      },
      {
        type: "commission",
        monthlyAmount: 3_240,
        // Under 12 months at this employer — INC-005 fires.
        historyMonths: 9,
        continuanceEstablished: null,
        evidenceDocumentIds: [],
      },
    ],
  }),
  transcripts: (ref) => [
    {
      taxYear: ref.getFullYear() - 1,
      agi: 141_800,
      wages: 138_200,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
    {
      taxYear: ref.getFullYear() - 2,
      agi: 96_300,
      wages: 96_300,
      transcriptType: "return",
      retrievedAt: ref.toISOString(),
    },
  ],
};

export const PERSONAS: Record<PersonaId, Persona> = {
  clean_w2: cleanW2,
  thin_file_renter: thinFileRenter,
  variable_income: variableIncome,
};

export const DEFAULT_PERSONA: PersonaId = "clean_w2";
