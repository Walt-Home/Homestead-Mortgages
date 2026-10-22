/**
 * The rules a model is given, and graded against.
 *
 * This is the shadow AUS (`underwrite` in `@hm/underwriting`) written out in
 * the engine's order: every figure it computes that a decision turns on,
 * every finding it adds, every requirement it blocks on these files, and the
 * recommendation and outcome it reaches. It states what the engine does in
 * the region the generator draws and nothing else: where the engine raises a
 * question of policy (docs/decisions.md, "Seasoning is counted in UTC, and
 * the record that decides is the one tested"), the files stay out of it, and
 * the rule is stated only as far as these files reach it. The grader is the
 * engine, so a sentence here that disagrees with it is a task nobody can
 * pass; the reference policy follows these words through the tools alone and
 * is held to the engine on every generated task. Change this text and the
 * environment's version changes with it.
 *
 * Every number the rules state is in `AUS_RULES`, which the text is written
 * from and the reference reads. A number changed there moves the reference
 * with the text, so the tests that hold the reference to the engine fail on
 * the files it decides; the test that pins the text sentence by sentence
 * fails on the rest.
 */

/** The numbers the rulebook states, which the reference policy reads as well. */
export const AUS_RULES = {
  minimumScore: 620,
  seasoningMonths: {
    chapter13: 24,
    otherBankruptcy: 48,
    foreclosure: 84,
    shortSaleOrDeedInLieu: 48,
  },
  transcriptTolerancePct: "10.00",
  dtiCeilingPct: "50.00",
  dtiElevatedOverPct: "45.00",
  maxLtvPct: {
    primary_residence: 97,
    second_home: 90,
    investment: 85,
    refinance: 97,
    nonOccupant: 95,
  },
  fees: { pointsPct: "0.5", flatCents: [109_500, 49_500] },
  aprRefusedOverLtvPct: 80,
  aporTermsMonths: [120, 180, 240, 360],
  reserveMonths: { primary_residence: 0, second_home: 2, investment: 6, perExtraFinanced: 2 },
  retirementCountsPct: 60,
  ipcCapPct: {
    investment: 2,
    bands: [
      { fromLtvPct: "90.01", cap: 3 },
      { fromLtvPct: "75.01", cap: 6 },
    ],
    otherwise: 9,
  },
  thresholdYear: 2026,
  /** By the first tier the loan amount reaches. */
  qmPointsAndFees: [
    { fromCents: 13_795_800, percent: 3 },
    { fromCents: 8_277_500, cents: 413_900 },
    { fromCents: 2_759_200, percent: 5 },
    { fromCents: 1_724_500, cents: 138_000 },
    { fromCents: 0, percent: 8 },
  ],
  generalQm: {
    manufacturedBelowCents: 13_795_800,
    manufacturedPct: "6.5",
    /** By the first tier the loan amount reaches. */
    tiers: [
      { fromCents: 13_795_800, pct: "2.25" },
      { fromCents: 8_277_500, pct: "3.5" },
      { fromCents: 0, pct: "6.5" },
    ],
  },
  hpml: { pct: "1.5", jumboPct: "2.5", jumboOverCents: 83_275_000 },
  hoepa: {
    feePct: 5,
    smallBelowCents: 2_759_200,
    smallPct: 8,
    smallCapCents: 138_000,
    rateSpreadOverPct: "6.5",
  },
  recoupWithinMonths: "60.0",
} as const;

const R = AUS_RULES;
/** Whole dollars, with thousands separators: 13795800 cents is "$137,958". */
const money = (cents: number): string =>
  `$${String(cents / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const either = (xs: readonly (string | number)[]): string =>
  `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
const feeLimit = (t: (typeof R.qmPointsAndFees)[number]): string =>
  "percent" in t ? `${t.percent}% of the total loan amount` : money(t.cents);
/** Tiers by the first the loan amount reaches, the last open below the one before it. */
const tiers = <T extends { readonly fromCents: number }>(
  xs: readonly T[],
  say: (t: T) => string,
): string =>
  xs
    .map((t, k) =>
      t.fromCents > 0
        ? `${money(t.fromCents)} or more: ${say(t)}.`
        : `Below ${money(xs[k - 1]!.fromCents)}: ${say(t)}.`,
    )
    .join(" ");
const S = R.seasoningMonths;
const L = R.maxLtvPct;
const M = R.reserveMonths;
const [band90, band75] = R.ipcCapPct.bands;

export const AUS_RULEBOOK = `# The automated underwriting decision

You decide one loan file the way the lender's automated underwriting system decides it: the credit scores and seasoning, income and the debt-to-income ratios, loan-to-value, the fees and the Regulation Z price tests, funds to close and reserves, interested-party contributions, a refinance's net tangible benefit, and then the findings, what could not be computed, the recommendation and the outcome. Follow these rules exactly and in order. Use the tools for every calculation; never estimate. Where a rule says a figure cannot be computed, its answer is null and the requirement named with it is blocked: "we could not compute this" is never the same answer as "it passed".

Conventions:
- Money is integer cents ("41234500" is $412,345.00). Rates and ratios are percentages.
- "Round" means round half up, at the step that says so and nowhere else; "to two places" means to two decimal places. A rounded figure is compared with its limit as rounded.
- The loan amount is loan.amount_cents and the value is property.value_cents. The housing payment (lender_estimates.housing_payment_cents) and the closing costs (lender_estimates.closing_costs_cents) are the lender's own estimates: use them exactly as given.
- The decision date is the first ten characters of decided_at, a date in UTC.
- The household is the borrowers, in the order listed.
- A tradeline on two borrowers' credit reports with the same creditor, type and opened_on is one joint debt, counted once. An account on two borrowers' asset reports with the same institution, type and mask is one joint account, counted once.
- A finding is a code with a category: credit, income, asset or eligibility. A blocked requirement is an id such as CRD-002. Keep both lists as you go.

## Step 1. Credit scores (CRD-002, UW-010)

Each borrower's own score is the middle of their scores when their report has three, the lower when it has two, and the one when it has one.
- When any borrower has no credit report (credit is null), or a report with no scores, CRD-002 and UW-010 are blocked, and representative_fico and fico_for_minimum are null.
- Otherwise representative_fico is the lowest own score in the household. fico_for_minimum is the representative score when there is one borrower, and the average of the own scores, rounded to a whole number, when there are two.
Every borrower's own score on these files is ${R.minimumScore} or more, which meets the ${R.minimumScore} minimum.

## Step 2. Revolving utilization (CRD-016)

When any borrower has no credit report, CRD-016 is blocked. A report with no scores does not block it.

## Step 3. Seasoning (CRD-006, CRD-007)

The months since a date are whole_months_between(that date, the decision date).
- Bankruptcies, on every borrower's report: a bankruptcy's reference date is its discharged_on, or its date when it has no discharge. Its minimum is ${S.chapter13} months when its chapter is "13", and ${S.otherBankruptcy} months for any other chapter or none. Its margin is its months − its minimum. The bankruptcy with the smallest margin decides: bankruptcy_seasoning_months is its months, and when they are fewer than its minimum, add BANKRUPTCY_SEASONING (credit). With no bankruptcy, bankruptcy_seasoning_months is null.
- Foreclosures, short sales and deeds in lieu, the same way: the reference date is the record's date; the minimum is ${S.foreclosure} months for a foreclosure and ${S.shortSaleOrDeedInLieu} for a short sale or a deed in lieu; the one with the smallest margin decides; derogatory_seasoning_months is its months, and when they are fewer than its minimum, add DEROGATORY_SEASONING (credit). With none, null.
No two records of one kind on these files have the same margin.

## Step 4. Income (INC-009)

- Every household here has at least one income source of type base_wage.
- qualifying_income_cents is the sum of monthly_cents over the income sources whose continuance_established is true. A source whose continuance is false or null counts nothing, a base wage included.
- The transcript check (INC-009) runs only when every borrower has at least one transcript. Then documented = 12 × the sum of monthly_cents over every income source, whatever its continuance, and wages = the sum, over the borrowers, of each borrower's latest tax year's wages_cents. transcript_variance_pct = (documented − wages) ÷ wages × 100, rounded to two places. When it is more than ${R.transcriptTolerancePct} or less than −${R.transcriptTolerancePct}, add TRANSCRIPT_VARIANCE (income). When the check does not run, transcript_variance_pct is null.

## Step 5. Debts and debt-to-income (UW-004)

- When any borrower has no credit report, UW-004 is blocked and monthly_liabilities_cents is null. Otherwise monthly_liabilities_cents is the sum of monthly_payment_cents over the household's tradelines whose dti_exclusion is null, a joint debt once.
- When qualifying income is 0, UW-004 is blocked, and dti_front_pct and dti_back_pct are null.
- Otherwise dti_front_pct = the housing payment ÷ qualifying income × 100, rounded to two places. dti_back_pct = (the housing payment + monthly liabilities) ÷ qualifying income × 100, rounded to two places, when monthly liabilities are known, and null when they are not.
- Every back-end ratio on these files is ${R.dtiCeilingPct} or less. When dti_back_pct is more than ${R.dtiElevatedOverPct}, add DTI_ELEVATED (income).
- atr_documented (ability to repay) is true when dti_back_pct was computed and the borrowers' asset reports are on file, and false otherwise. On these files either every borrower has an asset report or none does.

## Step 6. Loan-to-value (UW-005)

- ltv_pct = the loan amount ÷ the value × 100; cltv_pct = (the loan amount + loan.junior_lien_balance_cents) ÷ the value × 100; hcltv_pct = (the loan amount + loan.junior_lien_credit_limit_cents) ÷ the value × 100; each rounded to two places.
- max_ltv_pct: for a purchase, ${L.primary_residence} for a primary_residence, ${L.second_home} for a second_home and ${L.investment} for an investment property; for a rate_term_refinance, ${L.refinance} (every refinance here is of a primary residence). When any borrower has occupies_property false, the maximum is the lower of that and ${L.nonOccupant}.
- When ltv_pct is more than max_ltv_pct, add LTV_EXCEEDS_MAXIMUM (eligibility).

## Step 7. Fees, APOR and APR (UW-007, UW-008)

- The lender's fee schedule: points_and_fees_cents = round(the loan amount × ${R.fees.pointsPct} ÷ 100) + ${R.fees.flatCents.join(" + ")}, and the prepaid finance charges are that same amount. total_loan_amount_cents = the loan amount − the prepaid finance charges.
- The rate was set on new_york_date(product.rate_set_at). The APOR is null when product.amortization is not "Fixed", when term_months is not ${either(R.aporTermsMonths)}, or when apor(that date, the term in years) answers that the table does not hold the date. Otherwise apor_week_of and apor_pct are what apor answers. When the APOR is null, apor_week_of and apor_pct are null and UW-008 is blocked.
- The APR is null when the amortization is not "Fixed", or when the loan amount × 100 is more than the value × ${R.aprRefusedOverLtvPct}, exactly (not the rounded LTV: the loan then carries mortgage insurance). Otherwise apr_pct = annual_percentage_rate(the loan amount, the note rate, term_months, the prepaid finance charges). When the APR is null, UW-008 is blocked.
- When both are known, the spread is the APR − the APOR, exactly, and spread_pct is it to three places (an APR has three and an APOR two, so nothing is rounded). When either is null, spread_pct is null.

## Step 8. Funds to close and reserves (AST-002, AST-003, AST-004)

- funds_to_close_cents = (the value on a purchase, or existing_loan.balance_cents on a refinance) + the closing costs − loan.interested_party_contributions_cents − the loan amount.
- required_reserve_months: ${M.primary_residence} for a primary_residence, ${M.second_home} for a second_home, ${M.investment} for an investment property, plus ${M.perExtraFinanced} for each financed property beyond one (${M.perExtraFinanced} × (financed_properties − 1)).
- When no borrower has an asset report, AST-004 is blocked, and actual_reserve_months and reserves_satisfied are null.
- Otherwise the eligible assets are the household's accounts whose used_to_qualify is true, a joint account once: a retirement account counts ${R.retirementCountsPct}% of its vested_balance_cents, any other account its balance_cents. The eligible assets on these files always cover the funds to close. actual_reserve_months = (the eligible assets − funds to close) ÷ the housing payment, rounded to one place. reserves_satisfied is true when actual_reserve_months is required_reserve_months or more; otherwise it is false, and add RESERVES_INSUFFICIENT (asset).

## Step 9. Interested-party contributions (AST-016)

- ipc_cap_pct is ${R.ipcCapPct.investment} for an investment property; otherwise ${band90.cap} when ltv_pct is ${band90.fromLtvPct} or more, ${band75.cap} when it is ${band75.fromLtvPct} or more, and ${R.ipcCapPct.otherwise} below that.
- ipc_ratio_pct = loan.interested_party_contributions_cents ÷ the value × 100, rounded to two places. When it is more than ipc_cap_pct, add IPC_EXCEEDS_LIMIT (asset).

## Step 10. The thresholds

Regulation Z's thresholds are held for ${R.thresholdYear} alone. They apply when the rate-set date (Step 7) is in ${R.thresholdYear}; when it is not, the year's thresholds are missing. The ${R.thresholdYear} thresholds, by the loan amount:
- QM points-and-fees limit, by the first tier the loan amount reaches: ${tiers(R.qmPointsAndFees, feeLimit)} A percentage limit in cents is round(total_loan_amount_cents × the percent ÷ 100).
- General QM threshold, in points of spread: for a manufactured home with a loan amount below ${money(R.generalQm.manufacturedBelowCents)}, ${R.generalQm.manufacturedPct}, whatever tier its amount reaches. Any other loan takes the first tier its amount reaches: ${tiers(R.generalQm.tiers, (t) => t.pct)}
- HPML threshold: ${R.hpml.pct} points of spread; ${R.hpml.jumboPct} when the loan amount is more than ${money(R.hpml.jumboOverCents)}.
- HOEPA fee limit: ${R.hoepa.feePct}% of the total loan amount when the loan amount is ${money(R.hoepa.smallBelowCents)} or more; below that, the lesser of ${R.hoepa.smallPct}% of the total loan amount and ${money(R.hoepa.smallCapCents)}.

## Step 11. Qualified mortgage (UW-006)

- When the APR or the APOR is null, or the year's thresholds are missing, qm_status and qm_threshold_pct are null and UW-006 is blocked.
- Otherwise qm_threshold_pct is the loan's General QM threshold (Step 10), and qm_status is "qm" when atr_documented is true and the spread is less than that threshold.
No file here reaches "non_qm": every file with an APR, an APOR and the year's thresholds has ability to repay documented and a spread under its General QM threshold.

## Step 12. Points and fees (UW-007)

When the year's thresholds are missing, points_and_fees_pass is null and UW-007 is blocked. Otherwise points_and_fees_pass is true when points_and_fees_cents is the QM points-and-fees limit or less; when it is more, points_and_fees_pass is false, and add POINTS_AND_FEES_EXCEEDED (eligibility).

## Step 13. Higher-priced (HPML)

- When the APR or the APOR is null, is_hpml and hpml_threshold_pct are null.
- When property.occupancy is not "primary_residence", both are null: the rule reaches only a consumer's principal dwelling.
- When the year's thresholds are missing, both are null and UW-008 is blocked.
- Otherwise hpml_threshold_pct is the loan's HPML threshold (Step 10), and is_hpml is true when the spread is that threshold or more, and false when it is less. Every spread tested here is under its HPML threshold.

## Step 14. High-cost (HOEPA, UW-009)

When property.occupancy is not "primary_residence", is_high_cost is null and nothing is blocked: the rule reaches only a consumer's principal dwelling. On a primary residence there are three triggers:
- the rate trigger: null when the APR or the APOR is null; otherwise true when the spread is more than ${R.hoepa.rateSpreadOverPct}, else false;
- the fee trigger: null when the year's thresholds are missing; otherwise true when points_and_fees_cents is more than the HOEPA fee limit, else false;
- the penalty trigger: false when product.prepayment_penalty is false, and null when it is true (the penalty's term and cap, which decide it, are not on the file).
is_high_cost is true when any trigger is true, false when all three are false, and null otherwise; when it is null, UW-009 is blocked. When it is true, add HOEPA_HIGH_COST (eligibility).

## Step 15. Net tangible benefit (APP-019)

A purchase has none: ntb_recoup_months and ntb_satisfied are null. Every refinance here is one whose investor requires a net tangible benefit, with the closing costs recouped within ${Number(R.recoupWithinMonths)} months. On a refinance:
- When existing_loan.payment_basis is not "principal_and_interest", both are null and APP-019 is blocked: a scheduled payment may include escrow, so the saving cannot be measured.
- Otherwise the new payment is level_payment(the loan amount, the note rate, term_months), and the monthly saving is existing_loan.monthly_payment_cents − the new payment.
- A saving of 0 or less: ntb_recoup_months is null and ntb_satisfied is false.
- Otherwise ntb_recoup_months = the closing costs ÷ the saving, rounded to one place, and ntb_satisfied is true when that is ${R.recoupWithinMonths} or less.
When ntb_satisfied is false, add NTB_NOT_SATISFIED (eligibility).

## Step 16. The decision

- findings: every finding added above, each once.
- blocked: every requirement blocked above, each once. UW-010 is blocked exactly when CRD-002 is.
- recommendation: "approve_ineligible" when any finding is in the eligibility category; otherwise "refer" when any requirement is blocked; otherwise "refer_with_caution" when there is any finding; otherwise "approve_eligible".
- outcome: "denied" when is_high_cost is true; otherwise "counteroffer" for approve_ineligible, "referred" for refer, "approved_with_conditions" for refer_with_caution, and "clear_to_close" for approve_eligible.

## Submitting

Call submit_decision once with every field below. A whole number is a JSON number; cents are a string of digits ("41234500"); a rate, ratio or count of months is a string with exactly the decimals given; a date is YYYY-MM-DD. Null only where it says so.
- representative_fico, fico_for_minimum: whole numbers, or null.
- bankruptcy_seasoning_months, derogatory_seasoning_months: whole numbers, or null.
- qualifying_income_cents: cents. transcript_variance_pct: two decimals, or null. monthly_liabilities_cents: cents, or null.
- dti_front_pct, dti_back_pct: two decimals, or null. atr_documented: true or false.
- ltv_pct, cltv_pct, hcltv_pct: two decimals. max_ltv_pct: a whole number.
- ipc_ratio_pct: two decimals. ipc_cap_pct: a whole number.
- funds_to_close_cents: cents.
- required_reserve_months: a whole number. actual_reserve_months: one decimal, or null. reserves_satisfied: true, false or null.
- points_and_fees_cents, total_loan_amount_cents: cents. points_and_fees_pass, is_high_cost: true, false or null.
- apor_week_of: a date, or null. apor_pct: two decimals, or null.
- apr_pct, spread_pct: three decimals, or null. qm_threshold_pct, hpml_threshold_pct: two decimals, or null. qm_status: "qm", "non_qm" or null. is_hpml: true, false or null.
- ntb_recoup_months: one decimal, or null. ntb_satisfied: true, false or null.
- findings, blocked: lists, empty when there are none.
- recommendation, outcome: one of the values Step 16 names.
A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
