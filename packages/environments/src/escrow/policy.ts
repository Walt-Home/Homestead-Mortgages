/**
 * The annual escrow analysis as a policy, not a procedure.
 *
 * escrow-analysis's rulebook is ten numbered steps, each saying what to
 * compute next. This is the same content written the way a servicer's
 * policy is: by topic, in defined terms, with precedence stated as
 * precedence and no order of work given. Every field, code, threshold and
 * rounding of the step rulebook is here — a test holds that — so a task is
 * no less determined; the model must work out the procedure itself. The
 * lesson of refi-policy 1.0.0 is kept: no sentence ends on an "otherwise"
 * that could attach to more than one condition.
 */

export const ESCROW_POLICY = `# Escrow analysis policy

Once a year, each escrowed loan's escrow account is analyzed under RESPA (Regulation X §1024.17): this policy sets the balance the account must hold for the coming computation year and decides what happens to the difference between that and the balance the account will actually have. You receive the account as it stands on the run date (as_of): its escrow lines, its ledger, the cushion allowed, the loan's delinquency and any workout, and today's escrow payment. Apply the policy and submit the analysis with submit_analysis. Compute every figure and date with the tools.

Money is integer cents. Dates are YYYY-MM-DD. To round is to round half up to a whole cent, and to floor is to round down to a whole cent; each happens only where this policy says so.

## The computation year

The computation year is the 12 months beginning year_start, which is a month's first day. Its periods are its months: a date belongs to the period of its month, the first period being year_start's month (whole_months_between from year_start gives the period less one). A disbursement belongs to the year only when it is on or after year_start and before year_start plus 12 months.

## What each line will cost

The tax lines are tax_county, tax_city, tax_school, tax_special, tax_supplemental and tax_personal_property_mh. No other line is a tax line, and the consumer price index never applies to one, insurance included.

A line's annual amount is the first of these that applies:
- the sum of its known_bills' amount_cents, when it has known bills;
- its contract_annual_cents, when its estimate_basis is "contract" and that figure is given;
- its comparable_annual_cents, when its estimate_basis is "comparable" and that figure is given;
- round(prior_year_annual_cents × (100 + cpi_change_pct) ÷ 100), when it is a tax line whose estimate_basis is "prior_year_cpi";
- its prior_year_annual_cents, when none of the above applies.

## When each line is paid

A known bill is paid in full, its whole amount_cents, even when its discount date is used. Its pay date is its penalty_on when it has one and its due_on when it has none; that date moves earlier to the discount's by date when the bill has a discount dated before it; and the result moves later to the bill's available_on when the bill has one dated after it.

A line without known bills is paid in n installments a year: 1 for annual, 2 for semiannual, 4 for quarterly, 12 for monthly. Each installment is round(annual amount ÷ n), except the last, which is the annual amount less all the others. The installments fall, in order, on the line's prior_disbursed_on dates, each moved forward 12 months at a time until it is on or after year_start, and taken in date order.

A line with terminates_on pays nothing on or after that date.

## The base payment and the required starting balance

The annual total (annual) is everything paid in the computation year, and base_payment is round(annual ÷ 12).

The trial balance starts at 0. In each period in turn the account receives base_payment and then pays that period's disbursements. The low point is the lowest of the twelve period-end balances, or 0 when none is lower than 0. required_start is the low point with its sign reversed.

## The cushion and the target

The cushion months are the smallest of cushion.policy_months, cushion.instrument_months and cushion.state_max_months, leaving out any that is null. The cap is floor(annual ÷ 6). The cushion is the smaller of floor(annual × cushion months ÷ 12) and the cap. target_at_start is required_start plus the cushion.

## The balance the account will start with

projected_actual is the ledger's balance_cents, plus its deposits dated after as_of and before year_start, less its disbursements dated after as_of and before year_start. A posting on or before as_of is already in the balance; a posting on or after year_start belongs to the new year. projected_actual may be negative.

## What is done with the difference

A borrower is current when regx_days_delinquent is 30 or fewer.

When projected_actual is target_at_start or more, the surplus is projected_actual − target_at_start, and the decision is the first of these that applies:
- "balanced", when the surplus is 0;
- "retain", when the borrower is not current: the surplus stays in the account;
- "refund", when the surplus is 5000 cents (fifty dollars) or more: it is due as_of + 30 days (refund_due_on);
- "credit", in every remaining case: credit_monthly is floor(surplus ÷ 12), and first_month_extra_credit is surplus − 12 × credit_monthly.

When projected_actual is below target_at_start, the decision is "shortage":
- The deficiency is minus projected_actual when projected_actual is below 0, and 0 when it is not.
- The shortage is target_at_start when projected_actual is below 0, and target_at_start − projected_actual when it is not.
- The shortage is spread over 12 months (repayment_months). A workout analysis (workout true) spreads it over 60 months, or, when borrower_election_months is given, over the larger of 12 and borrower_election_months. An instrument's shortage cap (instrument_shortage_max_months) never takes a spread below 12 months, so outside a workout the spread is always 12.
- Each installment is round(shortage ÷ repayment_months); the final installment is shortage − installment × (repayment_months − 1).
- A deficiency is spread over 12 months in the same way: deficiency_installment is round(deficiency ÷ 12), and deficiency_final_installment is deficiency − deficiency_installment × 11. Both are 0 when there is no deficiency.
- lump_sum_option_offered is true only for a current borrower whose shortage is less than base_payment, in an analysis that is not a workout.

## The new payment and when it starts

For a shortage, new_payment is base_payment + installment + deficiency_installment, the first month's payment is the same, and the final month's is base_payment + final installment + deficiency_final_installment. For a credit, new_payment is base_payment − credit_monthly, the final month's payment is the same, and the first month's is base_payment − credit_monthly − first_month_extra_credit. For balanced, refund and retain, new_payment and the first and final months' payments are all base_payment.

The new payment takes effect (effective_on) on the earliest of year_start and the first days of the months after it that is not before statement_sent_on + 30 days.

## Anomalies

An analysis flags, as anomalies:
- "<line_type>:estimate_basis_prior_year_gt_2y" (for example "hazard:estimate_basis_prior_year_gt_2y"), for a line whose annual amount is its prior_year_annual_cents because none of the other cases applied, and whose prior_year_confirmed_on is given and before as_of less 24 months;
- "mi_borrower_paid:pmi_without_termination", for a line of type mi_borrower_paid that has no terminates_on;
- payment_change_gt_25pct, when current_escrow_payment_cents is above 0 and the change between it and new_payment, either way, × 100 is more than current_escrow_payment_cents × 25;
- payment_change_gt_150, when that change is more than 15000;
- surplus_gt_2500, for a refund whose surplus is more than 250000.

## What is submitted

Call submit_analysis once, with: annual_cents, base_payment_cents, required_start_cents, cushion_cents, target_at_start_cents, projected_actual_cents and the decision; surplus_cents for a refund, credit or retain; shortage_cents, deficiency_cents, repayment_months, installment_cents, final_installment_cents, deficiency_installment_cents, deficiency_final_installment_cents and lump_sum_option_offered for a shortage; credit_monthly_cents and first_month_extra_credit_cents for a credit; refund_due_on for a refund; null for every field the decision does not have; and new_payment_cents, first_month_payment_cents, final_month_payment_cents, effective_on and anomalies (every code flagged, in any order, or an empty list). A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the analysis.
`;
