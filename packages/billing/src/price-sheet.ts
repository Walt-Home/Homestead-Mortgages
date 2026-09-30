/**
 * The Supermortgage price sheet, as data.
 *
 * Doug's sheet — version 1.0, 28 September 2026, "for team review" — is
 * the source of truth for what a customer is charged, the way
 * `data/v1-build.csv` is for what a borrower must satisfy. Every row on it
 * is here with its section, its process references, the sheet's own word
 * for when it fires, and its tokens, and nothing here says a number the
 * sheet does not. A copy of the sheet is `docs/Supermortgage-Price-Sheet-v1.0.pdf`.
 *
 * Two denominations. Section A, the standard servicing cycle, is priced
 * per $100,000 of unpaid principal balance, so a standard loan consumes
 * 25,000 tokens a year — 25 basis points — at any loan size. Everything
 * else is flat tokens per action. One token is one cent, and the tests
 * hold the sheet's own arithmetic: section A sums to 25,000, the standard
 * refinance run to 60,000, and the five worked examples in section E
 * reproduce to the token.
 *
 * The one rule that decides a servicer's bill is the sheet's last line of
 * section A, kept as `MONITORED_BOOK_CODES`: a monitored loan on a
 * partner's book consumes the self-improving mortgage row and offer
 * touches from the day it is loaded, and the servicing rows start the day
 * the loan boards. A servicer's own book never boards here, so the tape
 * meter (`meter.ts`) reads exactly those two rows and no other.
 */

export const PRICE_SHEET = {
  title: "Supermortgage price sheet",
  version: "1.0",
  date: "2026-09-28",
  /** 1 token = $0.01. */
  tokenCents: 1n,
  /** Section A is priced per this much unpaid principal balance: $100,000. */
  balanceUnitCents: 10_000_000n,
} as const;

/**
 * The sheet's sections. `A_FEATURE` is section A's second table — the rows
 * a loan consumes on top of the cycle when it has the feature — and
 * `B_EXTRA` is section B's second table, the extras metered on top of a run.
 */
export type Section = "A" | "A_FEATURE" | "B" | "B_EXTRA" | "C" | "D";

/** Per $100,000 of balance, or flat tokens per action. */
export type Basis = "per_100k" | "flat";

/**
 * How a row is counted. The sheet's `fires` column says it in words; this
 * is the same thing a meter can switch on.
 */
export type Cadence = "loan_month" | "loan_year" | "run" | "event";

export interface PriceRow {
  /** Stable, ours: the section letter and a slug. Never the sheet's row order. */
  readonly code: string;
  readonly section: Section;
  /** The action, in the sheet's words. */
  readonly action: string;
  /** The process references in parentheses on the sheet: numbers in the platform specification. */
  readonly processes: readonly string[];
  /** The sheet's own word for when it fires: "per loan-month", "per touch, flat", "per event". */
  readonly fires: string;
  readonly basis: Basis;
  readonly cadence: Cadence;
  readonly tokens: number;
  /** Section B's "Standard run" column: how many times the standard refinance run consumes the row. */
  readonly standardRun?: number;
  /** The sheet's dagger: a licensed or dual-control person is in the loop today. */
  readonly humanInLoop?: boolean;
}

const row = (
  code: string,
  section: Section,
  action: string,
  processes: readonly string[],
  fires: string,
  basis: Basis,
  cadence: Cadence,
  tokens: number,
  extra: { standardRun?: number; humanInLoop?: boolean } = {},
): PriceRow => ({ code, section, action, processes, fires, basis, cadence, tokens, ...extra });

/** Section A's monthly rows, per $100,000, "billed per loan-month". */
const A_MONTHLY: readonly PriceRow[] = [
  row(
    "A.self_improving_mortgage",
    "A",
    "Self-improving mortgage: daily rate review, refinance readiness kept current, an offer when the borrower benefits",
    ["20.1", "33.3"],
    "daily; per loan-month",
    "per_100k",
    "loan_month",
    1750,
  ),
  row(
    "A.payment_processing",
    "A",
    "Payment processed and applied: cashiering cycle, ACH and lockbox, allocation",
    ["2.1", "2.3", "35.5"],
    "daily; per loan-month",
    "per_100k",
    "loan_month",
    125,
  ),
  row(
    "A.investor_reporting",
    "A",
    "Investor report and remittance to Fannie Mae; custodial account reconciliation",
    ["5.1", "5.2", "6.3", "6.4"],
    "per loan-month",
    "per_100k",
    "loan_month",
    75,
  ),
  row(
    "A.escrow_monitoring",
    "A",
    "Tax, insurance and flood monitoring; escrow disbursements",
    ["9.1", "9.6", "3.7"],
    "per loan-month",
    "per_100k",
    "loan_month",
    50,
  ),
  row(
    "A.statements",
    "A",
    "Periodic statement and household communications",
    ["7.1", "32.8"],
    "per loan-month",
    "per_100k",
    "loan_month",
    50,
  ),
  row(
    "A.credit_furnishing",
    "A",
    "Credit bureau furnishing, Metro 2",
    ["8.1"],
    "per loan-month",
    "per_100k",
    "loan_month",
    25,
  ),
];

/** Section A's annual rows, per $100,000, "per loan-year". */
const A_ANNUAL: readonly PriceRow[] = [
  row(
    "A.escrow_analysis",
    "A",
    "Annual escrow analysis and statement, surplus and shortage",
    ["3.2–3.6"],
    "per loan-year",
    "per_100k",
    "loan_year",
    60,
  ),
  row(
    "A.year_end_tax",
    "A",
    "Year-end tax reporting, Forms 1098 and 1099-INT",
    ["35.4"],
    "per loan-year",
    "per_100k",
    "loan_year",
    40,
  ),
];

/** "On top of the cycle, when the loan has the feature." */
const A_FEATURE: readonly PriceRow[] = [
  row(
    "A.mi_administration",
    "A_FEATURE",
    "Mortgage insurance administration: 78% and midpoint termination checks, annual disclosure",
    ["10.2–10.4"],
    "per loan-month",
    "per_100k",
    "loan_month",
    25,
  ),
  row(
    "A.arm_administration",
    "A_FEATURE",
    "Adjustable-rate administration: adjustment notices",
    ["7.2", "7.3"],
    "per loan-month",
    "per_100k",
    "loan_month",
    25,
  ),
  row(
    "A.offer_touch",
    "A_FEATURE",
    "Offer touch to a homeowner: e-mail, text or AI voice through consent and do-not-call gates",
    ["20.2"],
    "per touch, flat",
    "flat",
    "event",
    100,
  ),
];

const run = (
  code: string,
  action: string,
  processes: readonly string[],
  tokens: number,
  standardRun: number,
  humanInLoop = false,
): PriceRow =>
  row(code, "B", action, processes, "per run", "flat", "run", tokens, {
    standardRun,
    ...(humanInLoop ? { humanInLoop } : {}),
  });

/** Section B: "Origination — one run per closed loan, flat." The rows the standard run covers. */
const B_RUN: readonly PriceRow[] = [
  run(
    "B.lead_intake",
    "Lead intake: identity, E-SIGN and TCPA consents, soft credit pull, pre-qualification, six-item detection",
    ["20.3"],
    2000,
    1,
    true,
  ),
  run("B.rate_quote", "Rate quote", ["20.4"], 100, 2),
  run(
    "B.application",
    "Application: conversational Form 1003, MLO-of-record review",
    ["21.1"],
    3000,
    1,
    true,
  ),
  run("B.loan_estimate", "Loan Estimate", ["21.2"], 1000, 1),
  run("B.early_disclosures", "Companion early disclosures", ["21.3"], 500, 1),
  run("B.rate_lock", "Rate lock", ["21.4"], 1000, 1, true),
  run("B.revised_loan_estimate", "Revised Loan Estimate and tolerance test", ["21.5"], 500, 2),
  run(
    "B.document_processed",
    "Document classified, extracted, integrity- and freshness-checked",
    ["22.1"],
    100,
    10,
  ),
  run("B.needs_list_cycle", "Needs-list cycle", ["22.1"], 200, 2),
  run("B.credit_pull", "Credit pull and analysis", ["22.2"], 1000, 1),
  run("B.undisclosed_debt", "Undisclosed-debt monitoring and pre-close refresh", ["22.2"], 500, 1),
  run(
    "B.income_employment",
    "Income and employment verified, including verbal VOE by AI voice",
    ["22.3"],
    1500,
    1,
  ),
  run("B.asset_verified", "Asset account verified", ["22.4"], 500, 1),
  run("B.liabilities_dti", "Liabilities and debt-to-income computed", ["22.5"], 200, 2),
  run("B.identity_fraud_screen", "Identity, fraud, OFAC and Red Flags screen", ["22.6"], 300, 2),
  run(
    "B.du_submission",
    "DU submission: assemble, preflight, submit",
    ["23.1", "23.5–23.7"],
    1500,
    3,
  ),
  run("B.findings_interpreted", "Findings interpreted, conditions opened", ["23.2"], 500, 3),
  run("B.conditional_approval", "Conditional approval issued", ["23.3"], 1000, 1),
  run("B.condition_cleared", "Condition cleared", ["23.3"], 150, 14),
  run("B.clear_to_close", "Clear to close", ["23.3"], 1000, 1),
  run("B.atr_qm", "ATR/QM, HPML, HOEPA and state high-cost determination", ["23.4"], 200, 4),
  run("B.valuation_ordered", "Valuation ordered", ["24.1"], 500, 1),
  run("B.property_eligibility", "Property eligibility", ["24.3"], 500, 1),
  run(
    "B.title_file",
    "Title file: commitment, curative, agent vetting, closing protection letter, wire verification",
    ["24.4"],
    2500,
    1,
  ),
  run("B.existing_lien", "Existing lien paid off or resubordinated", ["24.4"], 500, 1),
  run("B.flood_hazard", "Flood determination and notice; hazard evidence", ["24.5"], 500, 1),
  run("B.compliance_test", "Compliance test run and gate", ["25.1"], 200, 7),
  run("B.closing_disclosure", "Closing Disclosure", ["25.2"], 1500, 1),
  run("B.ucd", "Uniform Closing Dataset submitted", ["25.2"], 300, 1),
  run("B.rescission", "Rescission administered", ["25.3"], 500, 1),
  run("B.closing_package_notices", "Closing-package and post-closing notices", ["25.4"], 500, 1),
  run(
    "B.closing_documents",
    "Closing document set, document QC, closing instructions",
    ["26.1"],
    2500,
    1,
  ),
  run("B.signing_session", "Signing session", ["26.2"], 2000, 1),
  run("B.enote", "eNote sealed, registered, Secured Party named", ["26.2"], 750, 1),
  run("B.erecording", "eRecording", ["26.2"], 500, 1),
  run("B.funding", "Funding: conditions, worksheet, wire, release", ["26.3"], 3000, 1, true),
  run(
    "B.post_closing_collateral",
    "Post-closing collateral: MERS registration, custody, trailing documents",
    ["26.4"],
    1500,
    1,
  ),
  run("B.warehouse_advance", "Warehouse advance", ["27.1"], 1000, 1, true),
  run("B.warehouse_day", "Warehouse day: accrual, aging, borrowing base", ["27.1"], 50, 7),
  run(
    "B.purchase_settlement",
    "Purchase settlement, gain on sale, MSR hand-off",
    ["27.2"],
    2000,
    1,
  ),
  run("B.commitment", "Commitment", ["29.1"], 500, 1),
  run("B.uldd", "ULDD build, EarlyCheck, package freeze", ["29.3"], 1000, 1),
  run(
    "B.loan_delivery",
    "Loan Delivery, custodian certification, purchase advice",
    ["29.4"],
    3500,
    1,
    true,
  ),
  run("B.hmda", "HMDA record", ["28.3"], 200, 1),
  run("B.boarded", "Boarded onto servicing at funding", ["30.2"], 1500, 1),
  run("B.escrow_established", "Escrow account established", ["30.3"], 500, 1),
  run("B.fnma_post_purchase", "Fannie Mae post-purchase setup", ["30.1"], 1000, 1),
  run("B.first_90_days", "First-90-days hand-off", ["30.4"], 1500, 1),
  run(
    "B.prior_loan_closed",
    "Prior loan closed out: payoff, lien release, escrow refund",
    ["35.10"],
    2500,
    1,
    true,
  ),
];

const extra = (
  code: string,
  section: Section,
  action: string,
  processes: readonly string[],
  fires: string,
  tokens: number,
  humanInLoop = false,
): PriceRow =>
  row(code, section, action, processes, fires, "flat", "event", tokens, {
    ...(humanInLoop ? { humanInLoop } : {}),
  });

/** "Extras, metered per action on top of the run." */
const B_EXTRA: readonly PriceRow[] = [
  extra(
    "B.lock_extension",
    "B_EXTRA",
    "Lock extension, relock or float-down",
    ["21.4"],
    "per event",
    500,
  ),
  extra("B.tolerance_cure", "B_EXTRA", "Tolerance cure and refund", ["21.5"], "per cure", 1000),
  extra(
    "B.notice_incompleteness",
    "B_EXTRA",
    "Notice of incompleteness, counteroffer or denial",
    ["21.6"],
    "per notice",
    2000,
    true,
  ),
  extra("B.deposit_sourced", "B_EXTRA", "Deposit or gift sourced", ["22.4"], "per item", 300),
  extra(
    "B.additional_borrower",
    "B_EXTRA",
    "Additional borrower: screens, credit, income and assets",
    ["22.2–22.6"],
    "per borrower",
    3000,
  ),
  extra(
    "B.fraud_investigation",
    "B_EXTRA",
    "Fraud investigation",
    ["22.6"],
    "per investigation",
    5000,
  ),
  extra(
    "B.appraisal_reviewed",
    "B_EXTRA",
    "Appraisal reviewed, UCDP and Collateral Underwriter, copy delivered",
    ["24.2"],
    "per report",
    1500,
  ),
  extra(
    "B.reconsideration_of_value",
    "B_EXTRA",
    "Reconsideration of value",
    ["24.2"],
    "per request",
    2500,
    true,
  ),
  extra(
    "B.project_review",
    "B_EXTRA",
    "Condo or PUD project review",
    ["24.3"],
    "per project",
    2000,
    true,
  ),
  extra(
    "B.mi_ordered",
    "B_EXTRA",
    "Mortgage insurance ordered and activated",
    ["24.6"],
    "per order",
    1500,
  ),
  extra(
    "B.corrected_cd",
    "B_EXTRA",
    "Corrected Closing Disclosure after consummation",
    ["25.2"],
    "per event",
    1000,
  ),
  extra(
    "B.unwind",
    "B_EXTRA",
    "Rescission or funding unwind",
    ["25.3", "26.3"],
    "per unwind",
    5000,
    true,
  ),
  extra(
    "B.warehouse_day_extra",
    "B_EXTRA",
    "Warehouse day beyond the seventh",
    ["27.1"],
    "per day",
    50,
  ),
  extra(
    "B.commitment_modification",
    "B_EXTRA",
    "Commitment modification, pair-off or extension",
    ["29.1"],
    "per event",
    250,
    true,
  ),
  extra(
    "B.post_delivery_correction",
    "B_EXTRA",
    "Post-delivery correction or adjustment",
    ["29.4", "27.2"],
    "per event",
    1500,
    true,
  ),
  extra(
    "B.prefunding_qc",
    "B_EXTRA",
    "Prefunding quality-control review",
    ["28.1"],
    "per selected loan",
    3000,
    true,
  ),
  extra(
    "B.post_closing_qc",
    "B_EXTRA",
    "Post-closing quality-control review",
    ["28.2"],
    "per selected loan",
    5000,
    true,
  ),
  extra(
    "B.self_report",
    "B_EXTRA",
    "Suspicious-activity, OFAC or Fannie Mae self-report",
    ["28.4"],
    "per case",
    10000,
    true,
  ),
];

/** "C. Exceptions on a performing loan — flat." */
const C: readonly PriceRow[] = [
  extra(
    "C.partial_payment",
    "C",
    "Partial payment or suspense resolved",
    ["2.2"],
    "per event",
    500,
  ),
  extra("C.late_charge", "C", "Late charge assessed", ["2.7"], "per event", 100),
  extra(
    "C.unapplied_funds",
    "C",
    "Unidentified or unapplied funds resolved",
    ["6.5"],
    "per receipt",
    500,
  ),
  extra("C.escrow_waiver", "C", "Escrow waiver request", ["3.8"], "per request", 500),
  extra(
    "C.notice_of_error",
    "C",
    "Notice of Error, Request for Information or complaint",
    ["4.1", "4.2", "4.5"],
    "per case",
    2500,
  ),
  extra("C.successor_in_interest", "C", "Successor in interest", ["4.4"], "per case", 2500),
  extra("C.credit_dispute", "C", "Credit dispute through e-OSCAR", ["8.2"], "per dispute", 1000),
  extra(
    "C.force_placed_notice",
    "C",
    "Force-placed insurance notice",
    ["9.2–9.4"],
    "per notice",
    500,
  ),
  extra(
    "C.force_placed_cancellation",
    "C",
    "Force-placed insurance cancellation and refund",
    ["9.5"],
    "per event",
    500,
  ),
  extra("C.loss_draft", "C", "Loss draft or insurance claim", ["9.7"], "per claim", 5000),
  extra(
    "C.mi_cancellation",
    "C",
    "Mortgage insurance cancellation request, refund or denial",
    ["10.1", "10.5", "10.6"],
    "per request",
    1000,
  ),
  extra("C.payoff_statement", "C", "Payoff statement", ["16.1"], "per request", 250),
  extra(
    "C.payoff_processed",
    "C",
    "Payoff processed: proceeds remitted, lien released, MERS deactivated",
    ["16.2–16.4"],
    "per payoff",
    2500,
    true,
  ),
  extra("C.transfer_in", "C", "Servicing transfer in", ["1.1–1.7"], "per loan", 2500, true),
  extra("C.transfer_out", "C", "Servicing transfer out", ["17.1–17.4"], "per loan", 2500, true),
];

/** "D. Distressed loan — flat, on top of the cycle." */
const D: readonly PriceRow[] = [
  row(
    "D.delinquent_loan_month",
    "D",
    "Delinquent loan-month: counters, default case progressed daily, delinquent status reported",
    ["35.9", "5.7"],
    "per loan-month",
    "flat",
    "loan_month",
    1000,
  ),
  extra(
    "D.early_intervention_notice",
    "D",
    "Written early-intervention notice",
    ["11.2"],
    "per notice",
    500,
  ),
  extra(
    "D.right_party_contact",
    "D",
    "Right-party contact achieved; attempts by AI voice and text under FDCPA gates included",
    ["11.1", "11.3", "11.4"],
    "per episode",
    3000,
  ),
  extra(
    "D.continuity_of_contact",
    "D",
    "Continuity-of-contact personnel assigned",
    ["4.3"],
    "per episode",
    500,
  ),
  extra("D.imminent_default", "D", "Imminent-default evaluation", ["11.5"], "per evaluation", 1500),
  extra("D.property_inspection", "D", "Property inspection", ["9.8"], "per inspection", 500),
  extra(
    "D.property_preservation",
    "D",
    "Property preservation action",
    ["9.9"],
    "per action",
    1000,
  ),
  extra(
    "D.stop_advance",
    "D",
    "Stop delinquency advance or guaranty-fee relief filed",
    ["5.4", "5.5"],
    "per event",
    500,
  ),
  extra(
    "D.lossmit_acknowledged",
    "D",
    "Loss-mitigation application acknowledged",
    ["12.1"],
    "per application",
    500,
  ),
  extra(
    "D.complete_application_evaluation",
    "D",
    "Complete-application evaluation",
    ["12.2"],
    "per evaluation",
    5000,
    true,
  ),
  extra("D.appeal", "D", "Appeal handled", ["12.3"], "per appeal", 3000),
  extra("D.forbearance", "D", "Forbearance plan", ["12.4"], "per plan", 5000),
  extra("D.repayment_plan", "D", "Repayment plan", ["12.5"], "per plan", 5000),
  extra(
    "D.payment_deferral",
    "D",
    "Payment deferral, including disaster deferral",
    ["12.6", "12.7"],
    "per deferral",
    10000,
  ),
  extra(
    "D.flex_modification",
    "D",
    "Flex Modification completed, trial through permanent",
    ["12.8", "2.6"],
    "per modification",
    30000,
  ),
  extra(
    "D.short_sale",
    "D",
    "Short sale or Mortgage Release completed",
    ["12.9"],
    "per liquidation",
    30000,
  ),
  extra(
    "D.pre_referral_review",
    "D",
    "Pre-referral review: 120-day and dual-tracking checks",
    ["13.1", "13.2", "13.4"],
    "per review",
    3000,
  ),
  extra("D.foreclosure_referral", "D", "Foreclosure referral", ["13.3"], "per referral", 5000),
  extra(
    "D.foreclosure_case_month",
    "D",
    "Foreclosure case-month: milestones, allowable timeframes, compensatory-fee tracking, law-firm reconciliation",
    ["13.5", "13.6", "35.9"],
    "per case-month",
    2500,
  ),
  extra(
    "D.environmental_litigation",
    "D",
    "Environmental hazard or non-routine litigation",
    ["13.7"],
    "per event",
    5000,
  ),
  extra("D.scra", "D", "SCRA protection or interest cap", ["13.8", "13.9"], "per request", 2000),
  extra(
    "D.liquidation_reported",
    "D",
    "Liquidation reported to Fannie Mae",
    ["5.3"],
    "per event",
    1000,
  ),
  extra(
    "D.bankruptcy_filing",
    "D",
    "Bankruptcy filing: case opened, reporting suspended, proof of claim prepared",
    ["14.1", "14.4"],
    "per filing",
    7500,
    true,
  ),
  extra(
    "D.bankruptcy_case_month",
    "D",
    "Bankruptcy case-month: docket sync, monitoring, statement in bankruptcy",
    ["14.1", "14.3"],
    "per case-month",
    2000,
  ),
  extra(
    "D.payment_change_notice",
    "D",
    "Payment change notice under Rule 3002.1",
    ["14.2"],
    "per notice",
    1000,
  ),
  extra("D.reogram", "D", "REOgram or conveyance to Fannie Mae", ["15.1"], "per event", 5000),
  extra(
    "D.expense_reimbursement",
    "D",
    "Expense reimbursement submission",
    ["15.2"],
    "per submission",
    2500,
  ),
  extra("D.mi_claim", "D", "Mortgage insurance claim", ["15.3"], "per claim", 5000),
  extra(
    "D.delinquency_advance_reimbursement",
    "D",
    "Delinquency advance reimbursement, Form 4828",
    ["15.4"],
    "per submission",
    2500,
  ),
  extra("D.repurchase_reported", "D", "Repurchase reported", ["5.6"], "per event", 1000),
];

/** Every row on the sheet, in the sheet's order. */
export const PRICE_ROWS: readonly PriceRow[] = [
  ...A_MONTHLY,
  ...A_ANNUAL,
  ...A_FEATURE,
  ...B_RUN,
  ...B_EXTRA,
  ...C,
  ...D,
];

const BY_CODE: ReadonlyMap<string, PriceRow> = new Map(PRICE_ROWS.map((r) => [r.code, r]));

/** The row by its code; a code the sheet does not carry is an error, never a default. */
export function priceRow(code: string): PriceRow {
  const r = BY_CODE.get(code);
  if (!r) throw new Error(`The price sheet has no row ${code}.`);
  return r;
}

export function rowsIn(section: Section): readonly PriceRow[] {
  return PRICE_ROWS.filter((r) => r.section === section);
}

/**
 * The one rule the tape meter runs on, from the foot of section A: "A
 * monitored loan on a partner's book consumes the self-improving mortgage
 * row and offer touches from the day it is loaded; the servicing rows
 * start the day the loan boards."
 */
export const MONITORED_BOOK_CODES = ["A.self_improving_mortgage", "A.offer_touch"] as const;

/** Section A's own arithmetic: the monthly subtotal, the annual rows, and the standard year. */
export function standardCycleTokensPer100k(): {
  readonly monthly: number;
  readonly annual: number;
  readonly year: number;
} {
  const monthly = A_MONTHLY.reduce((n, r) => n + r.tokens, 0);
  const annual = A_ANNUAL.reduce((n, r) => n + r.tokens, 0);
  return { monthly, annual, year: monthly * 12 + annual };
}

/** Section B's standard refinance run: every included row at its standard quantity. */
export function standardRefinanceRunTokens(): number {
  return B_RUN.reduce((n, r) => n + r.tokens * (r.standardRun ?? 0), 0);
}

/**
 * Section B's purchase run: "it swaps rescission and the prior-loan
 * close-out for the appraisal review", and adds the mortgage insurance
 * order when the loan carries it.
 */
export function standardPurchaseRunTokens(opts: { readonly mortgageInsurance: boolean }): number {
  const swappedOut = priceRow("B.rescission").tokens + priceRow("B.prior_loan_closed").tokens;
  const swappedIn = priceRow("B.appraisal_reviewed").tokens;
  const mi = opts.mortgageInsurance ? priceRow("B.mi_ordered").tokens : 0;
  return standardRefinanceRunTokens() - swappedOut + swappedIn + mi;
}

/** Tokens to cents, at the sheet's one rate. */
export function centsOfTokens(tokens: bigint): bigint {
  return tokens * PRICE_SHEET.tokenCents;
}
