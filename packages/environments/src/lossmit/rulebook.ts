/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's evaluation of a complete loss-mitigation
 * application under Fannie Mae's workout hierarchy (spec §12.2, with §12.4
 * forbearance, §12.5 repayment plans and §12.6 payment deferral) as its
 * engines and the conventions around them compute it, written out in their
 * order with every rounding said where it is made. The grader is the ported
 * engine, so a sentence here that disagrees with it is a task nobody can
 * pass; the reference policy follows these words through the tools alone and
 * is held to the engine on every generated task. Where the engine departs
 * from its spec, v1 does not draw the file (docs/environments.md). Change
 * this text and the environment's version changes with it.
 */

export const LOSSMIT_RULEBOOK = `# Evaluating a complete loss-mitigation application

You evaluate one delinquent Fannie Mae loan's complete loss-mitigation application on its evaluation date, the day it became complete. Work out the arrears, walk Fannie Mae's workout hierarchy to the retention option offered, set that option's terms, and give Regulation X's decision and acceptance windows. Follow these rules exactly and in order. Use the tools for every amount of money and every date; never estimate.

Conventions:
- Money is integer cents ("158017" is $1,580.17). Dates are YYYY-MM-DD.
- "Round" means round half up (half away from zero) to a whole cent. "Floor" means round down, "ceil" round up.
- PITI is loan.pi_cents + loan.escrow_cents: the full contractual monthly payment.
- Comparing two dates or two amounts is reading, and so is counting months and adding or subtracting counts of months. Working out an amount of money or a date is a tool call. "X + n months" is date_add with months n, which keeps the day of the month or uses the month's last day when it is shorter.
- The 1st of a date's month is the date with its day set to 01.

## Step 1. The arrears

- months_delinquent is the number of installments due from loan.next_due_date through evaluation_date, both included. Installments fall due on the 1st of each month, so it is whole_months_between(next_due_date, evaluation_date) + 1.
- late_charges = loan.unpaid_late_charges × loan.late_charge_cents.
- arrears = months_delinquent × PITI + late_charges.

## Step 2. The workout hierarchy

Test the options in this order. The first that holds is the one offered, and nothing after it is tested.
- (a) reinstatement, when borrower.funds_available_cents is at least the arrears, whatever the hardship.
- (b) forbearance, when borrower.hardship is temporary_unresolved.
- (c) repayment_plan, when borrower.hardship is resolved and Step 4 finds a plan.
- (d) payment_deferral, when borrower.hardship is resolved and Step 5's screen is eligible.
- (e) flex_mod, when flexmod_eligible is true.
A permanent hardship passes (c) and (d) without testing them. Every file in this environment is offered one of the five.

## Step 3. Forbearance terms (only when forbearance is offered)

- The term starts on the 1st of the month after the evaluation month. The months delinquent at the start are months_delinquent: nothing else falls due before the start.
- The caps, in this order: increment_3 = 3; requested = forbearance.requested_months; cumulative_12 = 12 − forbearance.forborne_months; delinquency_12 = 12 − months_delinquent.
- months = the smallest cap (never below 0).
- capped_by = the names of the caps equal to months, in the order above, leaving out requested (it is never named). Ties name every cap that ties; when only requested is that small, capped_by is empty.
- exception_required is true when requested_months is more than months.
- term_start is the start; term_end is the last day of the month of term_start + (months − 1) months.
- regx_short_term is true when forborne_months + months is 6 or less.

## Step 4. The repayment plan (when the walk reaches (c) with a resolved hardship)

- For a term of m months: installment = ceil(arrears ÷ m); total = PITI + installment. The term is allowed when 2 × total is at most 3 × PITI (150% of PITI or less, tested on the rounded-up installment).
- The plan is the smallest m from 1 to 12 that is allowed and whose total is at most borrower.capacity_cents. When no m qualifies there is no plan. (The installment only falls as m grows.)
- final_installment = arrears − installment × (m − 1).
- pct_of_contractual = floor(total × 10000 ÷ PITI) ÷ 100, written with two decimals: truncated, never rounded ("151.04", "150.00").
- regx_short_term is true when floor(arrears ÷ PITI) is 3 or less and m is 6 or less.

## Step 5. The payment deferral screen (when the walk reaches (d) with a resolved hardship)

Test these in order; the first that fails is the reason, and the screen is not eligible:
1. evaluation_date is before loan.origination_date + 12 months: INV_FNMA_D23204_SEASONING_12M.
2. months_delinquent is below 2 or above 6: INV_FNMA_D23204_DELQ_WINDOW.
3. history.last_deferral_effective is given and evaluation_date is before it + 12 months: INV_FNMA_D23204_PRIOR_DEFERRAL_12M. A disaster deferral (history.last_disaster_deferral_effective) never counts here.
4. months_to_maturity = whole_months_between(evaluation_date, loan.maturity_date) is below 36: INV_FNMA_D23204_MATURITY.
5. history.active_arrangements is not empty: INV_FNMA_D23204_CONFLICTING_ARRANGEMENT.
6. history.last_failed_trial_on or history.last_modification_effective is given and evaluation_date is before it + 12 months: INV_FNMA_D23204_TRIAL_OR_MOD_12M.
When none fails, the screen is eligible and the deferral is offered. (Exactly 12 months on is not "before": a date 12 months back passes.)

## Step 6. The deferral's terms (only when the deferral is offered)

- after = history.cumulative_deferred_months + months_delinquent.
- months_deferred = months_delinquent when after is 12 or less; otherwise 12 − cumulative_deferred_months (the cumulative cap of 12 months).
- installments_to_pay = months_delinquent − months_deferred: what the cap leaves to be paid.
- contractual_payment_required is true when months_delinquent is 6, or after is more than 12.
- cumulative_months_after = cumulative_deferred_months + months_deferred.
- nib (the non-interest-bearing balance) = months_deferred × loan.pi_cents + deferral.escrow_advances_cents + deferral.servicing_advances_cents. It takes P&I, not PITI; late charges and the escrow shortage are never in it.
- late_charges_waived = late_charges from Step 1: every unpaid late charge is waived.
- shortage_monthly = round(deferral.escrow_shortage_cents ÷ 60).
- new_payment = loan.pi_cents + loan.escrow_cents + shortage_monthly.

## Step 7. The deferral's completion clock (only when the deferral is offered)

- processing_month is deferral.processing_month_elected (the partner elects one only when the evaluation falls after the 15th).
- entry_deadline is the last day of the evaluation month, or of the month after it when processing_month is true.
- lar_deadline = add_business_days(entry_deadline, −1, fannie_mae): one Fannie Mae business day before the entry deadline, whatever day the deadline falls on.
- effective is the day after entry_deadline (the 1st of the next month). custodian_by = effective + 25 days.

## Step 8. Regulation X's windows (every file)

- The tier: ge_90 when scheduled_sale_on is null or days_between(evaluation_date, scheduled_sale_on) is 90 or more; lt_90 when it is 38 to 89; le_37 when it is 37 or less.
- decision_due = evaluation_date + 30 days, a calendar date, never moved.
- window_days is 14 at ge_90 (30 when state is NY), and 7 at lt_90 or le_37.
- accept_by = notice_provided_on + window_days, a calendar date: not moved off a weekend or holiday.
- deemed_rejected_on = accept_by + 3 days when window_days is 7, and + 5 days otherwise.
- appeal_rights is true at ge_90, false otherwise.

## Submitting

Call submit_evaluation once with:
- arrears: months_delinquent, late_charges_cents, arrears_cents;
- offered: reinstatement, forbearance, repayment_plan, payment_deferral or flex_mod;
- terms: for forbearance, months, capped_by, exception_required, term_start, term_end and regx_short_term; for a repayment plan, months, installment_cents, final_installment_cents, total_monthly_cents, pct_of_contractual and regx_short_term; for a payment deferral, months_deferred, installments_to_pay, contractual_payment_required, cumulative_months_after, nib_cents, late_charges_waived_cents, shortage_monthly_cents and new_payment_cents; null for reinstatement and flex_mod;
- deferral_screen: eligible and reason (null when eligible) whenever the walk reaches (d) with a resolved hardship, null otherwise;
- deferral_timeline: processing_month, entry_deadline, lar_deadline, effective and custodian_by when the deferral is offered, null otherwise;
- regx: tier, decision_due, window_days, accept_by, appeal_rights and deemed_rejected_on.
A section given where it is not called for is graded wrong, the same as one left out. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
