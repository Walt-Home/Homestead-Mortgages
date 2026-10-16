/**
 * The rules a model is given, and graded against.
 *
 * This is `reviewLoan` in `@hm/refi-review` written out as instructions, in
 * the engine's own order, with every rounding the engine makes said where
 * it makes it. The grader is the engine itself, so a sentence here that
 * disagrees with the engine is a task nobody can pass; the reference policy
 * (`reference.ts`) follows these words through the tools alone and is held
 * to the engine on every generated task, which is what keeps the two equal.
 * Change this text and the environment's version changes with it.
 */

export const RULEBOOK = `# The daily refinance review

You review one mortgage loan, on one review date, for a refinance offer: a new 30-year fixed-rate loan at today's quoted rate. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("340262" is $3,402.62). Rates are annual percentages ("6.125"). Dates are YYYY-MM-DD.
- "Round" means round half up, at the step that says so and nowhere else.
- Program constants: rate floor 25 basis points; holding period H = 84 months; new term 360 months; Massachusetts window 60 months.

## Step 1. Exclusions

Check these in order. The first one true ends the review: the verdict is "excluded" and the reasons are that one code.
1. status is not "active": not_active
2. bankruptcy_active: bankruptcy_active
3. foreclosure_referred: foreclosure_referred
4. lossmit_plan_active: lossmit_plan_active
5. deceased_or_sii_pending: deceased_or_sii_pending
6. transfer_out_pending: transfer_out_pending
7. regx_days_delinquent is greater than 0: delinquent

## Step 2. Suppression

At most one suppression applies: the first of these that is true. It does not end the review; it is carried into Step 9.
1. refi_do_not_solicit is true: marketing_suppression
2. offer history declined_on is set, and the review date is before declined_on + 90 days: cooldown
3. Count the offer history's offered_at dates that are after (review date minus 12 months) and on or before the review date. Two or more: frequency_cap

## Step 3. The schedule

- consummation = review date + 36 days
- disbursement = consummation + 6 days

## Step 4. The candidate loan

- payoff_days = days from next_due_date to disbursement, or 0 if that is negative.
- per_diem = round(upb_cents × note_rate_pct% ÷ 365) to the cent. payoff = upb_cents + per_diem × payoff_days.
- prepaid_days = days from disbursement to the last day of disbursement's month, plus 1.
- For an amount A, prepaid(A) = round(A × note_rate_pct% ÷ 365) × prepaid_days. This uses the EXISTING loan's note rate.
- raw = payoff + prepaid(payoff) + net_escrow_deposit_estimate_cents.
- rounded = raw rounded UP to the next multiple of 100000 cents ($1,000); a multiple already is unchanged.
- For an amount A: cash_back(A) = A − payoff − prepaid(A), and cap(A) = the larger of round(A × 1%) and 200000.
- loan_amount = rounded if cash_back(rounded) ≤ cap(rounded), otherwise raw.
- cash_back = cash_back(loan_amount); cash_back_cap = cap(loan_amount).

## Step 5. The prescreen

- ltv_x10000 = round(loan_amount × 10000 ÷ value_estimate.value_cents) to a whole number.
- The limit is 9700 for occupancy "primary", 9000 for "second_home", 7500 for "investment".
- The prescreen passes when ltv_x10000 ≤ the limit, unless value_estimate.confidence is "low" and ltv_x10000 > 9000, which fails it.

## Step 6. No quote

If there is no quote today, skip Steps 7, 8 and 9. The reasons are the Step 2 suppression code if there is one, then not_priceable, then not_priced. Go to Step 10.

## Step 7. The benefit

With r0 = note_rate_pct, pi0 = pi_cents, r1 = the quote's note_rate_pct:
- new_pi = level payment of loan_amount at r1 over 360 months.
- mi_new = the quote's mi_monthly_cents if ltv_x10000 > 8000 (0 when the quote gives none); otherwise 0.
- mi_existing = mi_monthly_cents if mi_status is "bpmi_active"; otherwise 0.
- pi_delta = pi0 − new_pi. payment_delta = pi_delta + (mi_existing − mi_new).
- rate_delta_bps = (r0 − r1) × 100, rounded to one decimal place.
- lifetime_interest_existing = pi0 × remaining_term_months − upb_cents.
- lifetime_interest_new = new_pi × 360 − loan_amount.
- same_term_pi = level payment of loan_amount at r1 over remaining_term_months.
- same_term_lifetime_interest = same_term_pi × remaining_term_months − loan_amount.
- npv = the present value of payment_delta every month for H months at r1.
- same_term_npv = the present value of (pi0 − same_term_pi + mi_existing − mi_new) every month for H months at r1.
- balance_existing_H = the balance of upb_cents at r0 after H payments of pi0.
- balance_new_H = the balance of loan_amount at r1 after H payments of new_pi.
- seven_year_total_cost_delta = (pi0 × H + balance_existing_H) − (new_pi × H + balance_new_H).

## Step 8. The Massachusetts rule

It applies only when property_state is "MA" and the whole months from the loan's consummation_date to the Step 3 consummation are fewer than 60. When it applies it passes if pi_delta > 0 or rate_delta_bps > 0, and fails otherwise. When it does not apply it passes.

## Step 9. The fire rule

Collect these reason codes, in this order:
1. rate_delta_bps < 25: rate_delta_below_floor
2. npv ≤ 0: npv_not_positive
3. seven_year_total_cost_delta ≤ 0: seven_year_not_lower
4. the prescreen failed: prescreen_failed
5. the Massachusetts rule failed: state_rule_failed
6. the Step 2 suppression code, if there is one
7. if lifetime_interest_delta = lifetime_interest_new − lifetime_interest_existing is greater than 0: when same_term_npv > 0, present_same_term_first is true and nothing is added; otherwise add reset_costs_more.
The loan fires when no code was collected. present_same_term_first is false unless item 7 made it true.

## Step 10. The value checks

- The value is stale when value_estimate.as_of is before (review date minus 24 months).
- The value is implausible when the tape exceptions include "implausible_value".

## Step 11. The verdict

Take the first that holds:
1. The loan fired and the value is neither stale nor implausible: "candidate". The reasons are exactly rate_delta, npv_positive, seven_year_delta_positive, prescreen, state_rule.
2. The value is stale or implausible, or the collected codes include cooldown, frequency_cap or marketing_suppression: "not_now". The reasons are the collected codes (or the Step 6 codes), then implausible_value if implausible, then value_stale if stale.
3. Otherwise: "watching". The reasons are the collected codes (or the Step 6 codes).

For "watching", the watch rate is r0 − 0.25, rounded DOWN to a multiple of 0.125, written with three decimals ("6.750").

## Answer

Call submit_review exactly once, with:
- verdict and reasons (the codes, in any order).
- offer: for "candidate", the figures below; otherwise null. Cents are integer strings.
  loan_amount_cents, new_pi_cents, pi_delta_cents, rate_delta_bps (a number, such as 87.5), cash_back_cents, cash_back_cap_cents, lifetime_interest_existing_cents, lifetime_interest_new_cents, same_term_pi_cents, same_term_lifetime_interest_cents, npv_cents, seven_year_total_cost_delta_cents, present_same_term_first.
- watch_rate_pct: for "watching", the watch rate; otherwise null.

A submission that does not fit the tool's schema is returned to you as an error, and you may submit again. A valid submission ends the review.
`;
