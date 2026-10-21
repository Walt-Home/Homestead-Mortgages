/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's payoff engine (spec §16.1, §7.6's
 * 1026.36(c)(3) clock, §16.2 and §5.2 rule 6) as `quote.ts`, `remit.ts` and
 * `investor/remittance.ts` compute it, with the conventions the grader
 * restates from the ops layer, written out in the engine's order and limited
 * to what v1's loans reach. Where the engine and its spec disagree inside
 * that scope, this says what the engine does (the shortage is the exact
 * recomputation, never the per-diem instruction). The regions where the
 * engine departs from its own spec are never drawn. The grader is the
 * engine; the reference policy follows these words through the tools and is
 * held to it on every generated task. Change this text and the
 * environment's version changes with it.
 */

export const PAYOFF_RULEBOOK = `# The payoff statement, the funds, and Fannie Mae's share

You handle one Fannie Mae loan's payoff the way the servicer's payoff engine does: issue the statement for the written request (its deadline, how long it is good, the payoff interest, every component, the total, the per diem, and the figure if the next installment posts), reconcile the funds that arrived against the exact figure on the payoff date, and split what is owed to Fannie Mae. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("25039082" is $250,390.82). Rates are annual percentages ("6.500"). Dates are YYYY-MM-DD.
- "Round" means round half up (half away from zero) to a whole cent, once, at the step that says so and nowhere else. A rounded figure is never rounded again.
- UPB is loan.upb_cents (interest-bearing principal only); the rate is loan.rate_pct; PTR is investor.ptr_pct, the pass-through rate.
- Business days. A servicer business day is Monday to Friday except the federal legal public holidays as observed: New Year's Day, Martin Luther King Jr.'s Birthday, Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving Day and Christmas Day, a holiday on a Saturday observed the Friday before and one on a Sunday the Monday after. Federal (Regulation X) business days and Fannie Mae business days are the same days. "N business days after a date" counts only business days strictly after it: the first business day after the date is day 1, whatever day the date itself is (add_business_days).
- Comparing two dates, or two amounts, is reading: it needs no tool. Working one out does.

## Step 1. The statement's deadlines

- federal_due = 7 servicer business days after request.received_on (Regulation Z 1026.36(c)(3)).
- state_due, by request.state, counted from request.received_on:
  - CA 21, FL 10, NY 30, NC 10 calendar days after it (date_add). Never moved off a weekend or holiday.
  - MA 5, TX 7 servicer business days after it.
  - CT: the floor is 7 servicer business days after it. state_due is request.good_through when that is on or after the floor, otherwise the floor.
  - Any other state: null.
- governing is "state" when state_due is not null and is strictly earlier than federal_due; otherwise "federal" (a tie is federal). governing_due is the governing date.

## Step 2. How long the statement is good

valid_until is request.good_through. In MA it is the later of request.good_through and request.issued_on + 30 calendar days.

## Step 3. The day count

The statement is computed as if the funds arrive on the good-through date: interest runs from loan.lpi_due up to, but not including, the payoff date (for the statement, the payoff date is request.good_through).
- monthly_30_360_partial_365: step from loan.lpi_due one month at a time while the next step is on or before the payoff date. months_full is the number of steps; the last step is loan.lpi_due + months_full months; days_partial = the payoff date − the last step, in days. (loan.lpi_due is always the 1st of a month, so months_full is whole_months_between(loan.lpi_due, the payoff date).)
- daily_simple_365: months_full = 0 and days_partial = the payoff date − loan.lpi_due, in days.

## Step 4. The interest, the per diem and the total

- interest_full = months_full × round(UPB × rate ÷ 1200): one month's interest, rounded, times the months (0 when months_full is 0, and always 0 for daily_simple_365).
- interest_partial = round(UPB × rate × days_partial ÷ 36500), rounded once.
- per_diem = round(UPB × rate ÷ 36500). It is printed for each day after the good-through date and is never multiplied into any figure here.
- nib_line = loan.nib_deferred_cents + loan.nib_forborne_cents (non-interest-bearing principal, due at payoff).
- total = UPB + interest_full + interest_partial + nib_line + late_charges + fees + corporate_advances + escrow_advance + recording_fee + mi_premium − buydown_credit − suspense_credit (each loan.<name>_cents; the two credits are positive amounts taken off). loan.escrow_balance_cents is refunded separately and is never netted. There is no prepayment premium.

## Step 5. The figure if the next installment posts

alt_applies is true when next_installment is not null and its due_on is strictly after request.issued_on and on or before request.good_through. Then alt_if_posts_total is the total of Steps 3 and 4 recomputed with UPB less next_installment.principal_cents and with interest running from next_installment.due_on instead of loan.lpi_due, through the same good-through date; everything else is unchanged (autodraft or not makes no difference). Otherwise alt_applies is false and alt_if_posts_total is null.

## Step 6. The payoff date and the exact figure

The borrower pays directly, and the funds are credited the day they arrive.
- payoff_date is funds.received_on, except when funds.installment_due_on is not a servicer business day and funds.received_on is the first servicer business day after it: then payoff_date is funds.installment_due_on (the funds are deemed received on the due date).
- exact_total is the total of Steps 3 and 4 recomputed with payoff_date in place of request.good_through (the same loan; nothing posts in between).
- variance = funds.amount_cents − exact_total. The variance is always against this exact recomputation, never against the statement's total plus per diems.

## Step 7. The disposition

- variance 0: paid_in_full.
- variance above 100 (more than $1.00 over): paid_in_full_overage_refund_10bd.
- variance from −5000 to 100, other than 0 ($50.00 short to $1.00 over): paid_in_full_tolerance_expense.
- variance below −5000 (more than $50.00 short): reliance_absorbed when request.state is FL, TX or CA and payoff_date is on or before request.good_through; otherwise short_payoff_demand_1bd.

## Step 8. The escrow refund

escrow_refund_by = 20 federal business days after payoff_date.

## Step 9. Fannie Mae's share

The loan is 100 % Fannie Mae's, and the servicer processes the payoff on payoff_date.
- fnma_principal = UPB + nib_line.
- fnma_interest, by investor.remittance_type, at PTR on UPB:
  - AA: from loan.lpi_due up to payoff_date, with Step 3's monthly stepping whatever the loan's accrual method: months × round(UPB × PTR ÷ 1200) + round(UPB × PTR × days ÷ 36500), where months and days are Step 3's months_full and days_partial for payoff_date under monthly_30_360_partial_365.
  - SA: half a month, round(UPB × PTR ÷ 2400).
  - SS: a full month, round(UPB × PTR ÷ 1200); but 0 when investor.mbs_pool is true, payoff_date is the first Fannie Mae business day of its month (the 1st when the 1st is a business day, otherwise the first business day after it), and investor.reported_on is on or before the second Fannie Mae business day of that month (the first business day after the first one).
- servicing_fee (AA only) = the note-rate interest in the exact figure (the interest_full + interest_partial of Step 6's recomputation for payoff_date) − fnma_interest. For SA and SS it is null.
- ss_interest_gap (SS only) = fnma_interest − round(UPB × PTR × days ÷ 36500), with days as in AA above (the partial days of the payoff month); 0 when fnma_interest is 0, and never below 0. For AA and SA it is null.
- fnma_total = fnma_principal + fnma_interest.

## Submitting

Call submit_payoff once with: federal_due, state_due, governing, governing_due, valid_until, months_full, days_partial, interest_full_cents, interest_partial_cents, per_diem_cents, nib_line_cents, total_cents, alt_applies, alt_if_posts_total_cents, payoff_date, exact_total_cents, variance_cents, disposition, escrow_refund_by, fnma_principal_cents, fnma_interest_cents, servicing_fee_cents, ss_interest_gap_cents and fnma_total_cents (months_full, days_partial, interest_full_cents and interest_partial_cents are the statement's, Step 3 for request.good_through); null only where a step says null. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
