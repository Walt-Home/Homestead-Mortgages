/**
 * Regulation Z's price tests as a policy, not a procedure.
 *
 * regz-price-tests's rulebook is nine numbered steps. This is the same
 * content written the way a compliance policy is: by question, in defined
 * terms, with what decides each answer and when it cannot be decided, and
 * no order of work given. Every field, threshold and rounding of the step
 * rulebook is here — a test holds that — so a task is no less determined.
 */

export const REGZ_POLICY = `# Regulation Z price-test policy

Before a loan is decided, this policy answers five questions about it under Regulation Z: is it a General Qualified Mortgage (§1026.43), are its points and fees within the qualified-mortgage limit, is it a higher-priced mortgage loan (§1026.35), is it a high-cost mortgage (HOEPA, §1026.32), and, on a refinance, does it bring the borrower a net tangible benefit. You receive the quote as the file holds it: the loan, the property, the lender's itemized fees and who is paid each, when the rate was set, whether ability to repay was documented, and on a refinance the loan being paid off. Apply the policy and submit the answers with submit_tests. Compute every figure with the tools.

A question the file does not allow this policy to decide is answered null. Null means "could not be decided"; it is never the same answer as a pass.

Money is integer cents. Rates are annual percentages. To round is to round half up, and only where this policy says so.

## Terms

- The loan amount is the note amount, loan.amount_cents. It is what chooses every tier below.
- A fee is kept by the lender when it is paid to the lender or to the lender's affiliate. A kept fee is a prepaid finance charge and counts in points and fees. A fee paid to an unaffiliated third_party or to a government office is neither.
- Each fee costs its amount_cents, or, when it is stated as percent_of_loan_amount, round(loan amount in cents × percent ÷ 100).
- The closing cost total is every fee. Points and fees are the kept fees, and so are the prepaid finance charges.
- The total loan amount is the loan amount less the prepaid finance charges. A percentage limit is a percentage of the total loan amount, and in cents it is round(total loan amount in cents × percent ÷ 100).
- A loan carries mortgage insurance when its loan amount is more than 80% of property.value_cents (loan amount × 100 > value × 80).
- The rate-set date is the calendar date rate_quoted_at falls on in New York (new_york_date).

## Price

The APR is Regulation Z Appendix J's, as annual_percentage_rate gives it from the loan amount, the note rate, term_months and the prepaid finance charges. A loan has no APR (null) when its amortization is not "Fixed" or when it carries mortgage insurance.

The APOR is the one apor gives for the rate-set date and the loan's term in years. A loan has no APOR (null) when its amortization is not "Fixed" or when term_months is not exactly 10, 15, 20 or 30 years.

The spread is APR − APOR, exactly. A loan has a spread only when it has both.

## The 2026 thresholds

Every quote's rate was set in 2026, and these are the year's figures:
- The QM points-and-fees limit, by loan amount: at $137,958 or more, 3% of the total loan amount; at $82,775 or more, $4,139; at $27,592 or more, 5% of the total loan amount; at $17,245 or more, $1,380; below $17,245, 8% of the total loan amount.
- The General QM threshold, in points of spread: a manufactured home whose loan amount is below $137,958 has 6.5, whatever its tier. Any other loan has, by loan amount, 2.25 at $137,958 or more, 3.5 at $82,775 or more, and 6.5 below $82,775.
- The higher-priced threshold: 1.5 points, and 2.5 for a loan amount more than $832,750, the conforming loan limit.
- The HOEPA rate trigger: a spread of more than 6.5 points.
- The HOEPA fee limit: 5% of the total loan amount for a loan amount of $27,592 or more; for a smaller loan, the lesser of 8% of the total loan amount and $1,380. The fee trigger fires when points and fees are more than this limit.
- The net tangible benefit: the closing costs recouped within 60 months.

## Qualified mortgage

qm_status is null for a loan without a spread. A loan with a spread whose ability to repay was not documented (atr_documented false) is "non_qm". Any other loan with a spread is "qm" when the spread is less than its General QM threshold, and "non_qm" when the spread is that threshold or more.

The points-and-fees limit (points_and_fees_limit) is decided for every loan, and points and fees pass (points_and_fees_pass) when they are no more than it.

## Higher-priced and high-cost

The higher-priced and high-cost rules reach only a consumer's principal dwelling. For a property whose occupancy is not "primary_residence", is_hpml, hoepa_apr_trigger and is_high_cost are all null.

On a principal dwelling, is_hpml and hoepa_apr_trigger are null for a loan without a spread. For a loan with a spread, is_hpml is true when the spread is its higher-priced threshold or more, and hoepa_apr_trigger is true when the spread is more than 6.5.

hoepa_fee_trigger is decided for every loan, whatever its occupancy. hoepa_prepayment_penalty_trigger is false for a loan whose prepayment_penalty is false, and null for a loan with a prepayment penalty, because the penalty's term and cap, which decide the trigger, are not on the file.

On a principal dwelling, is_high_cost is true when any of the three triggers is true, false when all three are false, and null in every other case.

## Net tangible benefit

A purchase has no benefit test: ntb_recoup_months and ntb_satisfied are both null. A refinance whose existing_loan.payment_basis is not "principal_and_interest" cannot be measured, because a scheduled payment may include escrow: both are null.

For any other refinance, the saving is existing_loan.monthly_payment_cents less the new payment, level_payment of the loan amount at the note rate over term_months. A saving of 0 or less fails the test: ntb_satisfied is false and ntb_recoup_months is null. A positive saving recoups the closing cost total in closing cost total ÷ saving months, rounded to one decimal place (ntb_recoup_months), and the test passes (ntb_satisfied true) when that is 60 or less.

## What is submitted

Call submit_tests once, with: closing_cost_total_cents, points_and_fees_cents, prepaid_finance_charges_cents, total_loan_amount_cents, apr_pct (three decimals, or null), apor_pct (two decimals, or null), qm_status, points_and_fees_limit_cents, points_and_fees_pass, is_hpml, hoepa_apr_trigger, hoepa_fee_trigger, hoepa_prepayment_penalty_trigger, is_high_cost, ntb_recoup_months (one decimal, or null) and ntb_satisfied. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
