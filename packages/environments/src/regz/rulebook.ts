/**
 * The rules a model is given, and graded against.
 *
 * This is the shadow AUS's Regulation Z price tests (`runComplianceTests`
 * and the market figures `resolveMarketInputs` derives for them, in
 * `@hm/underwriting`) written out in the engine's order, with every
 * threshold for 2026 — the one year the engine holds — and every refusal to
 * decide stated where the engine makes it. The grader is the engine, so a
 * sentence here that disagrees with it is a task nobody can pass; the
 * reference policy follows these words through the tools alone and is held
 * to the engine on every generated task. Change this text and the
 * environment's version changes with it.
 */

export const REGZ_RULEBOOK = `# Regulation Z price tests

You test one quoted mortgage loan the way an underwriter must before a decision: the General QM price and points-and-fees tests (§1026.43), the higher-priced mortgage test (§1026.35), the high-cost mortgage (HOEPA) triggers (§1026.32), and, on a refinance, the net tangible benefit. Follow these rules exactly and in order. Use the tools for every calculation; never estimate. Where a rule says a test cannot be decided, its answer is null: "we could not decide this" is never the same answer as "it passed".

Conventions:
- Money is integer cents ("41234500" is $412,345.00). Rates are annual percentages.
- "Round" means round half up, at the step that says so and nowhere else.
- The loan amount is loan.amount_cents, the note amount; it chooses every tier below. The total loan amount (Step 2) is what a percentage limit is a percentage of.

The 2026 thresholds (every task's rate was set in 2026):
- QM points-and-fees limit, by loan amount: $137,958 or more: 3% of the total loan amount. $82,775 or more: $4,139. $27,592 or more: 5% of the total loan amount. $17,245 or more: $1,380. Below $17,245: 8% of the total loan amount.
- General QM threshold (points of APR over APOR), by loan amount: $137,958 or more: 2.25. $82,775 or more: 3.5. Below $82,775: 6.5. A manufactured home with a loan amount below $137,958: 6.5.
- Higher-priced (HPML) threshold: 1.5 points; 2.5 when the loan amount is more than $832,750 (the conforming loan limit).
- HOEPA rate trigger: APR more than 6.5 points over APOR. HOEPA fee trigger: points and fees more than 5% of the total loan amount when the loan amount is $27,592 or more; below that, more than the lesser of 8% of the total loan amount and $1,380.
- Net tangible benefit: the closing costs must be recouped within 60 months.
- A percentage limit in cents is round(total loan amount in cents × percent ÷ 100).

## Step 1. The fees

Each fee line's amount is its amount_cents, or, for a line stated as percent_of_loan_amount, round(loan amount in cents × percent ÷ 100).
A line paid to the lender or to the lender's affiliate is kept by the lender: it is a prepaid finance charge and it counts in points and fees. A line paid to an unaffiliated third_party or to a government office is neither.
- closing_cost_total = every line.
- points_and_fees = the lines paid to the lender or an affiliate.
- prepaid_finance_charges = the lines paid to the lender or an affiliate.

## Step 2. The total loan amount

total_loan_amount = loan amount − prepaid_finance_charges.

## Step 3. The APR

There is no APR (null) when loan.amortization is not "Fixed", or when the loan carries mortgage insurance, which it does when the loan amount is more than 80% of property.value_cents (loan amount × 100 > value × 80). Otherwise the APR is annual_percentage_rate(loan amount, note rate, term_months, prepaid_finance_charges).

## Step 4. The APOR

The rate was set on the calendar date rate_quoted_at falls on in New York (new_york_date). There is no APOR (null) when loan.amortization is not "Fixed", or when term_months is not 10, 15, 20 or 30 years exactly. Otherwise the APOR is apor(that date, term in years).

When both are known, the spread is APR − APOR, exactly.

## Step 5. QM status

- APR or APOR is null: null (cannot be decided).
- Otherwise, atr_documented is false: "non_qm".
- Otherwise "qm" when the spread is less than the General QM threshold for the loan, and "non_qm" when it is that or more.

## Step 6. The points-and-fees test

points_and_fees_limit = the QM points-and-fees limit for the loan amount, in cents. points_and_fees_pass is true when points_and_fees is the limit or less.

## Step 7. Higher-priced (HPML)

- APR or APOR is null: null.
- property.occupancy is not "primary_residence": null (the rule reaches only a consumer's principal dwelling).
- Otherwise true when the spread is the HPML threshold or more, else false.

## Step 8. High-cost (HOEPA)

- hoepa_apr_trigger: null when APR or APOR is null or occupancy is not "primary_residence"; otherwise true when the spread is more than 6.5.
- hoepa_fee_trigger: true when points_and_fees is more than the HOEPA fee limit, else false. It is computed whatever the occupancy.
- hoepa_prepayment_penalty_trigger: false when loan.prepayment_penalty is false; null when it is true (the penalty's term and cap, which decide the trigger, are not on the file).
- is_high_cost: null when occupancy is not "primary_residence". Otherwise true when any of the three triggers is true; false when all three are false; and null otherwise.

## Step 9. Net tangible benefit

A purchase has none: both answers null. On a refinance:
- existing_loan.payment_basis is not "principal_and_interest": both null (a scheduled payment may include escrow, so the saving cannot be measured).
- Otherwise the new payment is level_payment(loan amount, note rate, term_months), and the monthly saving is existing_loan.monthly_payment_cents − the new payment.
- A saving of 0 or less: ntb_satisfied false, ntb_recoup_months null.
- Otherwise ntb_recoup_months = closing_cost_total ÷ the saving, rounded to one decimal place, and ntb_satisfied is true when that is 60 or less.

## Submitting

Call submit_tests once with: closing_cost_total_cents, points_and_fees_cents, prepaid_finance_charges_cents, total_loan_amount_cents, apr_pct (three decimals, or null), apor_pct (two decimals, or null), qm_status, points_and_fees_limit_cents, points_and_fees_pass, is_hpml, hoepa_apr_trigger, hoepa_fee_trigger, hoepa_prepayment_penalty_trigger, is_high_cost, ntb_recoup_months (one decimal, or null) and ntb_satisfied. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
