/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's annual escrow analysis (spec §3.2, R1–R10,
 * with §3.4's cushion) as its engine computes it, written out in the
 * engine's order with every rounding said where it is made. The grader is
 * the ported engine, so a sentence here that disagrees with it is a task
 * nobody can pass; the reference policy follows these words through the
 * tools alone and is held to the engine on every generated task.
 * Change this text and the environment's version changes with it.
 */

export const ESCROW_RULEBOOK = `# The annual escrow analysis

You run one escrowed mortgage loan's annual escrow analysis under RESPA (Regulation X §1024.17): project the coming computation year, set the balance the account must start it with, compare that with the balance it will actually have, decide what to do with the difference, and set the new monthly escrow payment. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("13833" is $138.33). Dates are YYYY-MM-DD.
- "Round" means round half up to a whole cent. "Floor" means round down to a whole cent. Each happens at the step that says so and nowhere else.
- The computation year runs 12 months from year_start (a month's first day): period 1 is year_start's month, period 12 the month before year_start plus 12 months. A date's period is its month counted from year_start's month (whole_months_between from year_start gives period − 1).
- Tax line types are tax_county, tax_city, tax_school, tax_special, tax_supplemental and tax_personal_property_mh. Every other line type (hazard, flood, mi_borrower_paid, ...) is not a tax line.

## Step 1. Each line's annual amount

For each line, the first of these that applies:
1. The line has known_bills (one or more): the sum of their amount_cents.
2. estimate_basis is "contract" and contract_annual_cents is given: contract_annual_cents.
3. estimate_basis is "comparable" and comparable_annual_cents is given: comparable_annual_cents.
4. estimate_basis is "prior_year_cpi" and the line is a tax line: round(prior_year_annual_cents × (100 + cpi_change_pct) ÷ 100).
5. Otherwise prior_year_annual_cents. In this case only, if prior_year_confirmed_on is given and is before as_of minus 24 months, flag the anomaly "<line_type>:estimate_basis_prior_year_gt_2y" (for example "hazard:estimate_basis_prior_year_gt_2y").

A line whose line_type is "mi_borrower_paid" and that has no terminates_on flags the anomaly "mi_borrower_paid:pmi_without_termination".

## Step 2. Each line's disbursements in the year

A line with known_bills disburses each bill's full amount_cents on its pay date: the bill's penalty_on if given, otherwise its due_on; moved earlier to discount.by if the bill has a discount and discount.by is before that date; then moved later to available_on if the bill has one and the date is before it. (The bill's full amount is disbursed even when the discount date is used.)

A line without known bills disburses n installments, where n is 1 for annual, 2 for semiannual, 4 for quarterly and 12 for monthly. Each installment is round(annual amount ÷ n), except the last, which is the annual amount less the others. The dates are the line's prior_disbursed_on dates, each moved forward 12 months at a time until it is on or after year_start, in date order; the k-th installment falls on the k-th date.

A line with terminates_on disburses nothing on or after terminates_on: drop those installments.

Keep only disbursements on or after year_start and before year_start plus 12 months.

## Step 3. The annual total and base payment

annual = the sum of every disbursement kept in Step 2.
base_payment = round(annual ÷ 12).

## Step 4. The trial running balance and the low point

Start a balance at 0. For each period 1 to 12 in order: add base_payment, then subtract every disbursement in that period, and note the balance at the period's end.
The low point is the lowest of those 12 balances and 0. required_start = minus the low point (0 when no balance goes below 0).

## Step 5. The cushion and the target

cap = floor(annual ÷ 6).
cushion months = the smallest of cushion.policy_months, cushion.instrument_months (if not null) and cushion.state_max_months (if not null).
cushion = the smaller of floor(annual × cushion months ÷ 12) and cap.
target_at_start = required_start + cushion.

## Step 6. The projected actual balance

projected_actual = ledger.balance_cents, plus every ledger deposit dated after as_of and before year_start, minus every ledger disbursement dated after as_of and before year_start. Postings on or before as_of are already in the balance; postings on or after year_start belong to the new year and are not counted. projected_actual may be negative.

## Step 7. The decision

The borrower is current when regx_days_delinquent is 30 or fewer.

If projected_actual is target_at_start or more, the surplus is projected_actual − target_at_start, and the decision is the first of:
1. surplus is 0: "balanced".
2. the borrower is not current: "retain" (the surplus stays in the account).
3. surplus is 5000 (fifty dollars) or more: "refund", due as_of + 30 days (refund_due_on).
4. otherwise "credit": credit_monthly = floor(surplus ÷ 12), and first_month_extra_credit = surplus − 12 × credit_monthly.

Otherwise the decision is "shortage":
- deficiency = minus projected_actual when projected_actual is below 0, else 0.
- shortage = target_at_start when projected_actual is below 0, else target_at_start − projected_actual.
- repayment_months is 12. In a workout analysis (workout true) it is 60, or, when borrower_election_months is given, the larger of 12 and borrower_election_months. An instrument's shortage cap (instrument_shortage_max_months) never takes the spread below 12 months, so outside a workout it is always 12.
- installment = round(shortage ÷ repayment_months); final_installment = shortage − installment × (repayment_months − 1).
- The deficiency is spread over 12 months: deficiency_installment = round(deficiency ÷ 12) and deficiency_final_installment = deficiency − deficiency_installment × 11; both are 0 when there is no deficiency.
- lump_sum_option_offered is true only when the borrower is current, shortage is less than base_payment, and it is not a workout analysis.

## Step 8. The new payment

- shortage: new_payment = base_payment + installment + deficiency_installment; the first month's is the same; the final month's is base_payment + final_installment + deficiency_final_installment.
- credit: new_payment = base_payment − credit_monthly; the final month's is the same; the first month's is base_payment − credit_monthly − first_month_extra_credit.
- balanced, refund, retain: new_payment, the first month's and the final month's are all base_payment.

## Step 9. The effective date

Start at year_start. While it is before statement_sent_on + 30 days, move it forward one month. The result is effective_on.

## Step 10. Anomalies

Besides the line anomalies of Step 1, compare new_payment with current_escrow_payment_cents (the payment today); the change is the difference either way:
- payment_change_gt_25pct: current_escrow_payment_cents is above 0 and the change × 100 is more than current_escrow_payment_cents × 25.
- payment_change_gt_150: the change is more than 15000.
- surplus_gt_2500: the decision is "refund" and the surplus is more than 250000.

## Submitting

Call submit_analysis once with every field: annual_cents, base_payment_cents, required_start_cents, cushion_cents, target_at_start_cents, projected_actual_cents, decision; surplus_cents for refund, credit and retain; shortage_cents, deficiency_cents, repayment_months, installment_cents, final_installment_cents, deficiency_installment_cents, deficiency_final_installment_cents and lump_sum_option_offered for a shortage; credit_monthly_cents and first_month_extra_credit_cents for a credit; refund_due_on for a refund; every field the decision does not have is null. Then new_payment_cents, first_month_payment_cents, final_month_payment_cents, effective_on, and anomalies (every code flagged, in any order; an empty list if none). A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the analysis.
`;
