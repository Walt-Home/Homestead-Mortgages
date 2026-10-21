/**
 * The grader is the shadow AUS itself.
 *
 * `underwrite` from `@hm/underwriting` is imported, not ported: the task is
 * built into the `LoanFile` the engine reads (every borrower's own reports
 * under `reports`, Borrower 1's mirrored onto the file-level fields the
 * screens read) and decided on the production path, as the decision route
 * calls it: no stated market, so the fee schedule, the APOR and the APR are
 * derived from the file and every block the engine can reach is recorded.
 * The two differences from production are the ones a grader needs to be
 * reproducible: the APOR table is a frozen copy pinned by its hash
 * (`apor-frozen.ts`) rather than whatever the database last fetched, and the
 * decision instant is the task's rather than the clock's.
 *
 * Every graded figure is read off the decision or its derivations: nothing
 * here recomputes what the engine computed. The two figures the task gives
 * (the housing payment and the closing cost total) are checked against the
 * engine's own before anything is graded, so a task can never state a
 * figure the engine did not use.
 */

import {
  assertRateSetTimeZoneAvailable,
  type Decision,
  type Derivation,
  type LoanFile,
} from "@hm/shared";
import { DerivationLog, maxLtvFor, resolveMarketInputs, underwrite } from "@hm/underwriting";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { FROZEN_APOR_TABLE } from "./apor-frozen.js";
import type { AusTask } from "./task.js";

// A small-ICU Node reads every instant as UTC, and a late-Sunday rate would move a week.
assertRateSetTimeZoneAvailable();

/* ── the task as the file the engine reads ───────────────────────────────── */

const dollars = (cents: number): number => cents / 100;
const partyOf = (i: number) => `party-${i + 1}`;

/** The `LoanFile` the decision route would hand `underwrite`: what it reads, and what the type demands beside it. */
export function fileOf(task: AusTask): LoanFile {
  const purchase = task.loan.purpose === "purchase";
  const reports = task.borrowers.map((b, i) => ({
    partyId: partyOf(i),
    credit: b.credit
      ? {
          reportId: `credit-${i + 1}`,
          reportDate: task.decided_at.slice(0, 10),
          pullType: "hard",
          scores: b.credit.scores.map((s) => ({ bureau: s.bureau, score: s.score, model: "FICO" })),
          tradelines: b.credit.tradelines.map((t, k) => ({
            id: `tradeline-${i + 1}-${k + 1}`,
            creditorName: t.creditor,
            type: t.type,
            balance: dollars(t.balance_cents),
            monthlyPayment: dollars(t.monthly_payment_cents),
            ...(t.credit_limit_cents === null
              ? {}
              : { creditLimit: dollars(t.credit_limit_cents) }),
            openedDate: t.opened_on,
            disputed: false,
            paymentHistory: [],
            maxDelinquency: 0,
            ...(t.dti_exclusion === null ? {} : { exclusionReasonCode: t.dti_exclusion }),
          })),
          publicRecords: b.credit.public_records.map((r) => ({
            type: r.type,
            date: r.date,
            status: r.discharged_on === null ? "reported" : "discharged",
            ...(r.chapter === null ? {} : { chapter: r.chapter }),
            ...(r.discharged_on === null ? {} : { dischargeDate: r.discharged_on }),
          })),
          inquiries: [],
          fraudAlert: false,
          ssnMismatch: false,
        }
      : null,
    assets: b.assets
      ? {
          reportId: `assets-${i + 1}`,
          generatedAt: task.decided_at,
          monthsCovered: 12,
          vendorAuthorizedForDu: true,
          accounts: b.assets.accounts.map((a, k) => ({
            id: `account-${i + 1}-${k + 1}`,
            institution: a.institution,
            type: a.type,
            mask: a.mask,
            currentBalance: dollars(a.balance_cents),
            balanceHistory: [],
            ...(a.vested_balance_cents === null
              ? {}
              : { vestedBalance: dollars(a.vested_balance_cents) }),
            usedForQualifying: a.used_to_qualify,
          })),
          largeDeposits: [],
          incomeSources: [],
          employments: [],
          incomeConfidence: "verified",
          identifiedRentPayments: 0,
          alternativeReferences: [],
          gifts: [],
          borrowedFunds: [],
          earnestMoneyVerified: true,
        }
      : null,
    payroll: null,
    transcripts: b.transcripts.map((t) => ({
      taxYear: t.tax_year,
      agi: dollars(t.wages_cents),
      wages: dollars(t.wages_cents),
      transcriptType: "wage_and_income",
      retrievedAt: task.decided_at,
    })),
  }));
  const first = reports[0]!;
  const existing = task.loan.existing_loan;
  return {
    id: task.id,
    createdAt: task.product.rate_set_at,
    updatedAt: task.decided_at,
    stage: "decision",
    property: {
      address: { line1: "1 Task Street", city: "Anytown", state: "OH", postalCode: "43004" },
      deliverableAddressVerified: true,
      propertyType: task.property.type,
      estateType: "fee_simple",
      occupancy: task.property.occupancy,
      valueOrPrice: dollars(task.property.value_cents),
      valuationSource: "appraisal",
      financedPropertyCount: task.property.financed_properties,
    },
    loan: {
      purpose: task.loan.purpose,
      loanAmount: dollars(task.loan.amount_cents),
      downPayment: purchase ? dollars(task.property.value_cents - task.loan.amount_cents) : 0,
      juniorLienBalance: dollars(task.loan.junior_lien_balance_cents),
      juniorLienCreditLimit: dollars(task.loan.junior_lien_credit_limit_cents),
      interestedPartyContributions: dollars(task.loan.interested_party_contributions_cents),
      ...(existing
        ? {
            existingLoan: {
              servicer: "Prior Servicer",
              loanNumber: "0000000001",
              balance: dollars(existing.balance_cents),
              rate: existing.rate_pct === null ? null : Number(existing.rate_pct),
              monthlyPayment: dollars(existing.monthly_payment_cents),
              paymentBasis: existing.payment_basis,
            },
          }
        : {}),
    },
    product: {
      productCode: "task",
      termMonths: task.product.term_months,
      amortization: task.product.amortization,
      noteRate: Number(task.product.note_rate_pct),
      rateQuotedAt: task.product.rate_set_at,
      prepaymentPenalty: task.product.prepayment_penalty,
      overlays: [],
    },
    borrowers: task.borrowers.map((b, i) => {
      const [firstName = b.name, ...rest] = b.name.split(" ");
      return {
        id: `borrower-${i + 1}`,
        partyId: partyOf(i),
        firstName,
        lastName: rest.join(" "),
        occupiesProperty: b.occupies_property,
      };
    }),
    invitedBorrowers: [],
    vestings: [],
    consents: [],
    application: null,
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
    reports,
    // Borrower 1's, by party, as the screens read them.
    credit: first.credit,
    assets: first.assets,
    payroll: null,
    transcripts: first.transcripts,
    incomeSources: task.income_sources.map((s) => ({
      type: s.type,
      monthlyAmount: dollars(s.monthly_cents),
      historyMonths: 24,
      continuanceEstablished: s.continuance_established,
      evidenceDocumentIds: [],
    })),
    employment: [],
    documents: [],
    disclosures: [],
    links: [],
    decision: null,
    sanctionsScreenClear: true,
    ssnValidatedWithSsa: null,
    fraudReviewComplete: true,
    applicationSignedAt: task.decided_at,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
  } as unknown as LoanFile;
}

/* ── the decision, on the production path ────────────────────────────────── */

export interface AusAnalysis {
  readonly file: LoanFile;
  readonly decision: Decision;
  readonly maxLtv: number | null;
  /** The §1026.32(b)(4) total loan amount the engine measured points and fees against. */
  readonly totalLoanAmount: number | null;
}

const cents = (dollarsValue: number): number => Math.round(dollarsValue * 100);

/** The engine's decision on the task, as the decision route would make it. */
export function decide(task: AusTask): Decision {
  return underwrite(fileOf(task), {
    aporTable: FROZEN_APOR_TABLE,
    casefileId: task.id,
    now: task.decided_at,
  });
}

/** The engine's run over the task, and the two figures beside it the decision does not carry. */
export function analyzeAus(task: AusTask): AusAnalysis {
  const file = fileOf(task);
  const decision = decide(task);
  const pitia = decision.ratios.housingPitia;
  if (pitia === null || cents(pitia) !== task.lender_estimates.housing_payment_cents)
    throw new RangeError(
      `${task.id}: the housing payment given (${task.lender_estimates.housing_payment_cents}) is not the engine's (${pitia})`,
    );
  const closing = derivation(decision, "UW-007", "Closing costs");
  if (
    typeof closing?.value !== "number" ||
    cents(closing.value) !== task.lender_estimates.closing_costs_cents
  )
    throw new RangeError(
      `${task.id}: the closing costs given (${task.lender_estimates.closing_costs_cents}) are not the engine's (${String(closing?.value)})`,
    );
  // Read from the same derivation the decision route runs, so it is the engine's figure.
  const market = resolveMarketInputs(file, new DerivationLog(), FROZEN_APOR_TABLE);
  return {
    file,
    decision,
    maxLtv: maxLtvFor(file),
    totalLoanAmount: market.inputs.totalLoanAmount ?? null,
  };
}

/** The one derivation a requirement recorded under a label, computed or blocked. */
export function derivation(d: Decision, requirementId: string, label: string): Derivation | null {
  const found = d.derivations.filter((x) => x.requirementId === requirementId && x.label === label);
  if (found.length > 1) throw new RangeError(`${requirementId} recorded "${label}" twice`);
  return found[0] ?? null;
}

const valueOf = (d: Decision, requirementId: string, label: string): number | null => {
  const x = derivation(d, requirementId, label);
  return x && !x.blockedBy?.length && typeof x.value === "number" ? x.value : null;
};

/* ── the answer ──────────────────────────────────────────────────────────── */

export const FINDING_CODES = [
  "BANKRUPTCY_SEASONING",
  "DEROGATORY_SEASONING",
  "TRANSCRIPT_VARIANCE",
  "DTI_ELEVATED",
  "LTV_EXCEEDS_MAXIMUM",
  "RESERVES_INSUFFICIENT",
  "IPC_EXCEEDS_LIMIT",
  "HOEPA_HIGH_COST",
  "POINTS_AND_FEES_EXCEEDED",
  "NTB_NOT_SATISFIED",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** Every requirement the rulebook says can block on these files. */
export const BLOCKABLE = [
  "CRD-002",
  "CRD-016",
  "INC-004",
  "UW-004",
  "AST-004",
  "UW-006",
  "UW-007",
  "UW-008",
  "UW-009",
  "APP-019",
  "UW-010",
] as const;
export type Blockable = (typeof BLOCKABLE)[number];

export const RECOMMENDATIONS = [
  "approve_eligible",
  "refer_with_caution",
  "refer",
  "approve_ineligible",
] as const;
export const OUTCOMES = [
  "clear_to_close",
  "approved_with_conditions",
  "referred",
  "counteroffer",
  "denied",
] as const;

/** Rates and ratios as the decimals the rulebook states them in, cents as decimal strings; null where the engine has no such figure. */
export interface AusAnswer {
  readonly representative_fico: number | null;
  readonly fico_for_minimum: number | null;
  readonly bankruptcy_seasoning_months: number | null;
  readonly derogatory_seasoning_months: number | null;
  readonly qualifying_income_cents: string;
  readonly transcript_variance_pct: string | null;
  readonly monthly_liabilities_cents: string | null;
  readonly dti_front_pct: string | null;
  readonly dti_back_pct: string | null;
  readonly atr_documented: boolean;
  readonly ltv_pct: string;
  readonly cltv_pct: string;
  readonly hcltv_pct: string;
  readonly max_ltv_pct: number;
  readonly ipc_ratio_pct: string;
  readonly ipc_cap_pct: number;
  readonly funds_to_close_cents: string;
  readonly required_reserve_months: number;
  readonly actual_reserve_months: string | null;
  readonly reserves_satisfied: boolean | null;
  readonly points_and_fees_cents: string;
  readonly total_loan_amount_cents: string;
  readonly points_and_fees_pass: boolean | null;
  readonly is_high_cost: boolean | null;
  readonly apor_week_of: string | null;
  readonly apor_pct: string | null;
  readonly apr_pct: string | null;
  readonly qm_status: "qm" | "non_qm" | null;
  readonly is_hpml: boolean | null;
  readonly ntb_recoup_months: string | null;
  readonly ntb_satisfied: boolean | null;
  readonly findings: readonly FindingCode[];
  readonly blocked: readonly Blockable[];
  readonly recommendation: (typeof RECOMMENDATIONS)[number];
  readonly outcome: (typeof OUTCOMES)[number];
}

const centsText = (dollarsValue: number): string => String(cents(dollarsValue));
const fixedOrNull = (x: number | null | undefined, places: number): string | null =>
  x === null || x === undefined ? null : x.toFixed(places);

export function answerOf(x: AusAnalysis): AusAnswer {
  const d = x.decision;
  const c = d.compliance;
  const r = d.ratios;
  const one = valueOf(d, "CRD-002", "Representative FICO");
  const average = valueOf(d, "CRD-002", "Average median credit score");
  const closing = derivation(d, "UW-007", "Closing costs")!;
  const ipc = derivation(d, "AST-016", "Interested party contributions")!;
  const funds = valueOf(d, "AST-002", "Funds to close");
  const ntb = c.netTangibleBenefit;
  if (r.totalQualifyingIncome === null || r.ltv === null || r.cltv === null || r.hcltv === null)
    throw new RangeError("income and LTV are always computed on these files");
  if (x.maxLtv === null || funds === null || d.reserves.requiredMonths === null)
    throw new RangeError("the maximum LTV, funds to close and the reserve requirement always are");
  if (x.totalLoanAmount === null) throw new RangeError("the total loan amount always is");
  return {
    representative_fico: one,
    fico_for_minimum: average ?? one,
    bankruptcy_seasoning_months: valueOf(d, "CRD-006", "Bankruptcy seasoning"),
    derogatory_seasoning_months: valueOf(d, "CRD-007", "Derogatory seasoning"),
    qualifying_income_cents: centsText(r.totalQualifyingIncome),
    transcript_variance_pct: fixedOrNull(valueOf(d, "INC-009", "Transcript reconciliation"), 2),
    monthly_liabilities_cents: (() => {
      const v = valueOf(d, "UW-004", "Monthly liabilities");
      return v === null ? null : centsText(v);
    })(),
    dti_front_pct: fixedOrNull(r.dtiFront, 2),
    dti_back_pct: fixedOrNull(r.dtiBack, 2),
    atr_documented: c.atrDetermination === "documented",
    ltv_pct: r.ltv.toFixed(2),
    cltv_pct: r.cltv.toFixed(2),
    hcltv_pct: r.hcltv.toFixed(2),
    max_ltv_pct: x.maxLtv,
    ipc_ratio_pct: (ipc.value as number).toFixed(2),
    ipc_cap_pct: ipc.inputs["cap_percent"] as number,
    funds_to_close_cents: centsText(funds),
    required_reserve_months: d.reserves.requiredMonths,
    actual_reserve_months: fixedOrNull(d.reserves.actualMonths, 1),
    reserves_satisfied: d.reserves.satisfied,
    points_and_fees_cents: centsText(closing.inputs["points_and_fees"] as number),
    total_loan_amount_cents: centsText(x.totalLoanAmount),
    points_and_fees_pass: c.pointsAndFeesPass,
    is_high_cost: c.isHighCost,
    apor_week_of: d.pricedAgainst?.aporWeekOf ?? null,
    apor_pct: fixedOrNull(valueOf(d, "UW-008", "Average prime offer rate"), 2),
    apr_pct: fixedOrNull(valueOf(d, "UW-008", "Annual percentage rate"), 3),
    qm_status: c.qmStatus,
    is_hpml: c.isHpml,
    ntb_recoup_months: fixedOrNull(ntb?.recoupMonths, 1),
    ntb_satisfied: ntb ? ntb.satisfied : null,
    findings: [...new Set((d.aus?.findings ?? []).map((f) => f.code as FindingCode))].sort(),
    blocked: [
      ...new Set(
        d.derivations.filter((v) => v.blockedBy?.length).map((v) => v.requirementId as Blockable),
      ),
    ].sort(),
    recommendation: d.aus!.recommendation as AusAnswer["recommendation"],
    outcome: d.outcome as AusAnswer["outcome"],
  };
}

export const expectedAus = (task: AusTask): AusAnswer => answerOf(analyzeAus(task));

/* ── grading ──────────────────────────────────────────────────────────────
 * A field per step of the decision, with the labels that are nearly always
 * the same graded beside the figures they come from: the scores with the
 * seasoning (nearly always none); qualifying income with the transcript
 * variance (most files carry no transcripts) and the monthly debts; the two
 * ratios with whether ability to repay was documented; the three
 * loan-to-value figures with the maximum and the contributions with their
 * cap (nearly always none, under 9%); the reserve months with the
 * requirement and the verdict; the fee figures with their two tests; the
 * APR with the two spread tests it decides. The engine's own result (its
 * findings, what it could not compute and its recommendation) is one
 * field, and the outcome another: on a file that clears to close all four
 * are empty or the commonest label, and grading them as four fields made an
 * answer that works nothing score 0.22 on the held-out suite. Now it scores
 * about 0.10. A refinance has a net tangible benefit field; one reported on
 * a purchase is a field of its own, so hedging is never cheaper than
 * committing.
 */

export const AUS_GROUPS = {
  credit: [
    "representative_fico",
    "fico_for_minimum",
    "bankruptcy_seasoning_months",
    "derogatory_seasoning_months",
  ],
  income_and_debts: [
    "qualifying_income_cents",
    "transcript_variance_pct",
    "monthly_liabilities_cents",
  ],
  dti: ["dti_front_pct", "dti_back_pct", "atr_documented"],
  collateral: ["ltv_pct", "cltv_pct", "hcltv_pct", "max_ltv_pct", "ipc_ratio_pct", "ipc_cap_pct"],
  funds_to_close_cents: ["funds_to_close_cents"],
  reserves: ["required_reserve_months", "actual_reserve_months", "reserves_satisfied"],
  fees: [
    "points_and_fees_cents",
    "total_loan_amount_cents",
    "points_and_fees_pass",
    "is_high_cost",
  ],
  apor: ["apor_week_of", "apor_pct"],
  apr: ["apr_pct", "qm_status", "is_hpml"],
  aus: ["findings", "blocked", "recommendation"],
  decision: ["outcome"],
} as const satisfies Record<string, readonly (keyof AusAnswer)[]>;
export const NTB = [
  "ntb_recoup_months",
  "ntb_satisfied",
] as const satisfies readonly (keyof AusAnswer)[];

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
const groupOf = (a: AusAnswer, keys: readonly (keyof AusAnswer)[]): string =>
  keys.length === 1
    ? canon(a[keys[0]!])
    : JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k] ?? null])));

export function gradeAusAgainst(
  want: AusAnswer,
  answer: AusAnswer | null,
  refinance: boolean,
): Grade {
  const fields: FieldGrade[] = Object.entries(AUS_GROUPS).map(([field, keys]) => {
    const expected = groupOf(want, keys);
    const got = answer ? groupOf(answer, keys) : null;
    return { field, expected, got, ok: got === expected };
  });
  if (refinance) {
    const expected = groupOf(want, NTB);
    const got = answer ? groupOf(answer, NTB) : null;
    fields.push({ field: "ntb", expected, got, ok: got === expected });
  } else if (answer !== null && NTB.some((k) => answer[k] !== null)) {
    fields.push({
      field: "ntb",
      expected: "none: not a refinance",
      got: groupOf(answer, NTB),
      ok: false,
    });
  }
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeAus = (task: AusTask, answer: AusAnswer | null): Grade =>
  gradeAusAgainst(expectedAus(task), answer, task.loan.purpose !== "purchase");

/* ── the submission, read strictly ──────────────────────────────────────── */

export const AUS_FIELDS: readonly (keyof AusAnswer)[] = [
  ...Object.values(AUS_GROUPS).flat(),
  ...NTB,
] as (keyof AusAnswer)[];

const CENTS = /^-?\d+$/;
const PCT2 = /^\d{1,3}\.\d{2}$/;
type Shape =
  | { kind: "int"; nullable: boolean; min: number; max: number }
  | { kind: "text"; nullable: boolean; shape: RegExp; example: string }
  | { kind: "bool"; nullable: boolean }
  | { kind: "enum"; nullable: boolean; among: readonly string[] }
  | { kind: "set"; among: readonly string[] };

const int = (nullable: boolean, min: number, max: number): Shape => ({
  kind: "int",
  nullable,
  min,
  max,
});
const text = (nullable: boolean, shape: RegExp, example: string): Shape => ({
  kind: "text",
  nullable,
  shape,
  example,
});
const bool = (nullable: boolean): Shape => ({ kind: "bool", nullable });

export const AUS_SHAPES: Readonly<Record<keyof AusAnswer, Shape>> = {
  representative_fico: int(true, 300, 900),
  fico_for_minimum: int(true, 300, 900),
  bankruptcy_seasoning_months: int(true, 0, 1200),
  derogatory_seasoning_months: int(true, 0, 1200),
  qualifying_income_cents: text(false, CENTS, '"1500000"'),
  transcript_variance_pct: text(true, /^-?\d{1,5}\.\d{2}$/, '"-12.34"'),
  monthly_liabilities_cents: text(true, CENTS, '"145000"'),
  dti_front_pct: text(true, PCT2, '"20.88"'),
  dti_back_pct: text(true, PCT2, '"36.10"'),
  atr_documented: bool(false),
  ltv_pct: text(false, PCT2, '"80.00"'),
  cltv_pct: text(false, PCT2, '"80.00"'),
  hcltv_pct: text(false, PCT2, '"80.00"'),
  max_ltv_pct: int(false, 0, 100),
  ipc_ratio_pct: text(false, PCT2, '"3.00"'),
  ipc_cap_pct: int(false, 0, 100),
  funds_to_close_cents: text(false, CENTS, '"10642500"'),
  required_reserve_months: int(false, 0, 100),
  actual_reserve_months: text(true, /^\d{1,5}\.\d$/, '"13.9"'),
  reserves_satisfied: bool(true),
  points_and_fees_cents: text(false, CENTS, '"359000"'),
  total_loan_amount_cents: text(false, CENTS, '"39641000"'),
  points_and_fees_pass: bool(true),
  is_high_cost: bool(true),
  apor_week_of: text(true, /^\d{4}-\d{2}-\d{2}$/, '"2026-06-15"'),
  apor_pct: text(true, /^\d{1,2}\.\d{2}$/, '"6.57"'),
  apr_pct: text(true, /^\d{1,2}\.\d{3}$/, '"6.587"'),
  qm_status: { kind: "enum", nullable: true, among: ["qm", "non_qm"] },
  is_hpml: bool(true),
  ntb_recoup_months: text(true, /^\d{1,4}\.\d$/, '"23.4"'),
  ntb_satisfied: bool(true),
  findings: { kind: "set", among: FINDING_CODES },
  blocked: { kind: "set", among: BLOCKABLE },
  recommendation: { kind: "enum", nullable: false, among: RECOMMENDATIONS },
  outcome: { kind: "enum", nullable: false, among: OUTCOMES },
};

export function parseAusSubmission(raw: unknown): Parsed<AusAnswer> {
  const fail = (error: string): Parsed<AusAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_decision again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).filter((k) => !(AUS_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return fail(`${unknown.join(", ")} is not a field of the submission`);
  const out: Record<string, unknown> = {};
  for (const f of AUS_FIELDS) {
    if (!(f in s)) return fail(`${f} is missing; give every field, null where the rulebook says`);
    const v = s[f];
    const shape = AUS_SHAPES[f];
    if (v === null && shape.kind !== "set" && shape.nullable) {
      out[f] = null;
      continue;
    }
    switch (shape.kind) {
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v) || v < shape.min || v > shape.max)
          return fail(`${f} must be a whole number${shape.nullable ? ", or null" : ""}`);
        out[f] = v;
        break;
      case "text":
        if (typeof v !== "string" || !shape.shape.test(v.trim()))
          return fail(
            `${f} must be a string like ${shape.example}${shape.nullable ? ", or null" : ""}`,
          );
        out[f] = shape.shape === CENTS ? BigInt(v.trim()).toString() : v.trim();
        break;
      case "bool":
        if (typeof v !== "boolean")
          return fail(`${f} must be true or false${shape.nullable ? ", or null" : ""}`);
        out[f] = v;
        break;
      case "enum":
        if (typeof v !== "string" || !shape.among.includes(v))
          return fail(
            `${f} must be one of ${shape.among.join(", ")}${shape.nullable ? ", or null" : ""}`,
          );
        out[f] = v;
        break;
      case "set": {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !shape.among.includes(x)))
          return fail(`${f} must be a list drawn from ${shape.among.join(", ")} (empty if none)`);
        if (new Set(v).size !== v.length) return fail(`${f} lists an entry twice`);
        out[f] = [...(v as string[])].sort();
        break;
      }
    }
  }
  return { ok: true, answer: out as unknown as AusAnswer };
}
