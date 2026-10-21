/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's Flex Modification evaluation (spec §12.8,
 * Fannie Mae F-1-27 and D2-3.2-06) as its engine and service compute it,
 * written out in their order with every rounding said where it is made. The
 * grader is the ported engine, so a sentence here that disagrees with it is
 * a task nobody can pass; the reference policy follows these words through
 * the tools alone and is held to the engine on every generated task.
 * Change this text and the environment's version changes with it.
 */

export const FLEX_RULEBOOK = `# The Flex Modification evaluation

You evaluate one delinquent Fannie Mae loan for a Flex Modification on the evaluation date: decide whether it is denied before the waterfall, run the waterfall's five steps to set the modified terms, decide whether the result is eligible, and, for an offer, set the trial period plan and the modification's dates. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("126413" is $1,264.13). Rates are annual percentages with three decimals ("6.500"). Dates are YYYY-MM-DD.
- "Round" means round half up (half away from zero), at the step that says so and nowhere else. "Floor" means round down.
- P&I(balance, rate, months) means level_payment(balance, rate, months): the level monthly payment, rounded half up to the cent. Every comparison of a P&I with a target uses that rounded figure.

## Step 1. Denials before the waterfall

Check these in order; the first that applies ends the evaluation. The decision is "denied" with that denial_reason, and every other field is null.
1. last_trial_failed_on is given and fewer than 365 days before evaluation_on (days_between): FNMA_D23206_TRIAL_FAILED_12M.
2. prior_modifications is 3 or more: FNMA_D23206_THREE_PRIOR_MODS.

## Step 2. The Modification Interest Rate (MIR)

The MIR is the rate_pct of the mir_table row with the latest effective date on or before evaluation_on (a row effective on evaluation_on counts; a later row does not).

## Step 3. Gross balance, MTMLTV and the target payment

- gross = ib_upb + accrued_interest + escrow_advances + servicing_advances + prior_nib − buydown_funds.
- MTMLTV = gross × 100 ÷ value, rounded to two decimals. Every later test of MTMLTV uses this rounded figure.
- target = floor(pre_mod_pi × 80 ÷ 100), less 1 cent when pre_mod_pi × 80 is an exact multiple of 100: the largest cent strictly below 80% of the pre-modification P&I.

## Step 4. The rate (waterfall step 2)

The rate is contract_rate_pct. When is_arm_not_final is true, it is the larger of contract_rate_pct and the MIR. The term is remaining_term_months. P&I is P&I(gross, rate, term).

## Step 5. Rate reduction (waterfall step 3)

Only when MTMLTV is 50.00 or more and the rate is above the MIR:
- While P&I is above the target and the rate less 0.125 is at or above the MIR: lower the rate by 0.125 and recompute P&I(gross, rate, term).
- Then, if P&I is still above the target and the rate is still above the MIR, set the rate to the MIR exactly and recompute P&I.
A rate at or below the MIR is never lowered. A fixed rate is lowered too. (P&I falls as the rate falls, so the eighth-point step it stops at can be found by halving rather than stepping.)

## Step 6. Term extension (waterfall step 4)

Only when P&I is above the target and the term is below 480: the term becomes the smallest number of months above remaining_term_months, and no more than 480, at which P&I(gross, rate, months) is at or below the target; if there is none, it becomes 480. P&I is P&I(gross, rate, term) at the new term. (P&I falls as the term grows, so the smallest such term can be found by halving the range rather than counting.)

## Step 7. Principal forbearance (waterfall step 5)

Only when P&I is still above the target and MTMLTV is above 50.00 (50.00 itself does not qualify):
- (a) Start from annuity_principal(target, rate, term). While P&I(that balance, rate, term) is above the target, lower the balance by 1 cent. a = gross − that balance. (The balance is only ever lowered from the floored closed form, never raised.)
- (b) b = gross − floor(value ÷ 2).
- (c) c = round(gross × 30 ÷ 100).
- forborne = the least of a, b and c. The interest-bearing balance ib_upb = gross − forborne, and P&I is P&I(ib_upb, rate, term).
Otherwise forborne is 0 and ib_upb is gross.

## Step 8. Eligibility and the reported figures

- The loan is eligible when P&I is at or below the target. When it is not, it is still eligible when P&I is at or below pre_mod_pi for a loan with delinquent_31_plus true, or below pre_mod_pi for one with delinquent_31_plus false.
- A loan that is not eligible is "denied" with denial_reason INV_FNMA_F127_PI_RULE: report mir_pct and the waterfall's figures (gross through post_mod_ib_mtmltv), and null for exhaustion_offer and everything after it.
- reduction_pct = (pre_mod_pi − P&I) × 100 ÷ pre_mod_pi, rounded to four decimals (negative when P&I is above pre_mod_pi).
- post_mod_ib_mtmltv = ib_upb × 100 ÷ value, rounded to two decimals.

## Step 9. The offer

An eligible loan is an "offer" with denial_reason null:
- exhaustion_offer is true when P&I is above the target (the waterfall was exhausted), false otherwise.
- trial_months is 3 when delinquent_31_plus is true, 4 when it is false.
- The first trial payment is due on the 1st of the month after the month of trial.notice_sent_on when the notice's day of the month is 15 or less, and on the 1st of the month after that when it is 16 or more. The trial payments fall due on the 1st of consecutive months; last_trial_due_on is the last of them.
- trial_payment = P&I + trial.ti_monthly_cents + round(trial.escrow_shortage_cents ÷ 60).
- effective_on = last_trial_due_on + 1 month. capitalization_on = effective_on − 1 month. maturity_on = effective_on + (term − 1) months.
- incentive_deadline = the last day of the month two months after last_trial_due_on.

## Submitting

Call submit_evaluation once with: decision, denial_reason, mir_pct, gross_upb_cents, mtmltv_pct, target_pi_cents, rate_pct, term_months, forborne_cents, ib_upb_cents, pi_cents, reduction_pct, post_mod_ib_mtmltv_pct, exhaustion_offer, trial_months, first_trial_due_on, last_trial_due_on, trial_payment_cents, effective_on, capitalization_on, maturity_on and incentive_deadline; null for every field the evaluation does not reach. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
