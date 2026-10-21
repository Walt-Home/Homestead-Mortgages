/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's mortgage-insurance administration (spec §10.1
 * borrower-requested cancellation, §10.2 automatic termination at 78%,
 * §10.3 final termination at the midpoint, §10.5 the unearned-premium
 * refund) as its engine computes it — buildSchedule, armResetVersion,
 * scheduledDateForPct, midpoint, pendingTriggerDate, applyFifo,
 * evaluateCancellation, automaticTermination, finalizationClocks and
 * unearnedEstimate — with the service conventions the grader restates,
 * written out in the engine's order and limited to what v1's tasks reach.
 * The grader is the engine; the reference policy follows these words
 * through the tools and is held to it on every generated task. Change this
 * text and the environment's version changes with it.
 */

export const PMI_RULEBOOK = `# Reviewing a loan's mortgage insurance

You review one loan's mortgage insurance (MI) on the evaluation date, as_of, under the Homeowners Protection Act as the servicer administers it. First you state the loan's MI position: its original value, whether the 78% rule reaches it, the amortization schedule in effect, the date that schedule first reaches 78% of the original value, the midpoint, and the trigger date. Then you decide what as_of calls for: a borrower's written request to cancel, when the task has one; otherwise the automatic termination at the trigger, once as_of has reached it; or, for lender-paid MI, the notice about it. Where the MI ends, you set its effective date, the clocks that run from it and the unearned premium. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("31200000" is $312,000.00). Rates are annual percentages ("6.500"). Dates are YYYY-MM-DD, and every due date is the 1st of a month.
- "Round" means round half up (half away from zero) to a whole cent, at the step that says so and nowhere else. "Floor" means round down to a whole number.
- "+ n months" and "+ n days" mean date_add. Adding months to the 1st of a month always lands on the 1st.
- Comparing two dates, or two amounts, is reading: it needs no tool. Working one out does.
- "Later" and "earlier" compare dates; "the latest of" several dates is the last of them.

## Step 1. The original value and the 78% rule

- The original value is appraised_value_cents for a refinance (is_refinance true), and otherwise the lesser of sales_price_cents and appraised_value_cents.
- rule_78_applies is true when consummation is on or after 1999-07-29, units is 1 and occupancy_at_origination is "principal" or "second_home"; otherwise false.
- The property class (Step 7 uses it): "investment" when occupancy_at_origination is "investment"; otherwise "one-unit" when units is 1; otherwise "two-to-four".

## Step 2. The schedule in effect

The note's schedule has io_months + amortizing_term_months rows, the payments numbered from 1; row n is due first_payment_due + (n − 1) months.
- P&I = level_payment(original_principal_cents, note_rate_pct, amortizing_term_months).
- Rows 1 to io_months pay interest only: the balance after each is original_principal_cents.
- The balance after an amortizing row n (n above io_months) is balance_after(original_principal_cents, note_rate_pct, P&I, n − io_months).

Each rate change, in the order listed, replaces the schedule in effect from its payment_number k on:
- start = the balance after row k − 1 of the schedule in effect before the change.
- remaining = io_months + amortizing_term_months − (k − 1).
- Its P&I = level_payment(start, new_rate_pct, remaining).
- Its rows are numbered from k and keep the note's due dates; the balance after its row n is balance_after(start, new_rate_pct, its P&I, n − k + 1). It has no rows before k.

A modification replaces the schedule entirely:
- Its rows are numbered from 1; its row n is due first_modified_due + (n − 1) months.
- Its P&I = level_payment(ib_upb_cents, rate_pct, term_months); the balance after its row n is balance_after(ib_upb_cents, rate_pct, its P&I, n).
- Its forborne_principal_cents is added to every row's balance in Step 3.

The schedule in effect is the last of these: the modification's when there is one, otherwise the last rate change's, otherwise the note's. pi_cents is its P&I.

## Step 3. The 78% date

- threshold = round(original value × 78 ÷ 100).
- The 78% row is the first row of the schedule in effect whose balance after, plus the modification's forborne_principal_cents (0 without a modification), is at or below the threshold. scheduled_78_payment_number is its number and scheduled_78_date its due date. When no row qualifies, both are null.
- This is found for every loan, whether or not the 78% rule applies.
- (A row's balance never rises from one row to the next, so the first row at or below the threshold can be found by halving the range of rows rather than going through them one by one.)

## Step 4. The midpoint

- The governing first due and term are first_modified_due and term_months when there is a modification; otherwise first_payment_due and io_months + amortizing_term_months. A rate change never moves the midpoint.
- The amortization start is the governing first due − 1 month. The midpoint is the amortization start + (term ÷ 2) months. midpoint_termination_date is the 1st of the month after the midpoint.

## Step 5. The trigger

trigger_date is midpoint_termination_date when rule_78_applies is false or scheduled_78_date is null. Otherwise it is scheduled_78_date when that is earlier than midpoint_termination_date, and midpoint_termination_date when it is not.

## Step 6. The ledger

Apply the receipts to the installments, oldest first:
- Take the receipts in order of received_on (in the order listed when two share a date), starting with nothing held. Add each receipt's amount to what is held; then, while what is held is at least the amount of the oldest installment not yet satisfied, that installment is satisfied on the receipt's received_on and its amount comes out of what is held.
- Two cases are reading and need no tool: a receipt added to nothing held leaves its own amount held, and an installment taken out of an equal amount leaves nothing held. Any other sum or difference is worked out with calculate.
- An installment no receipt satisfies is unsatisfied. Every installment due before ledger.from was satisfied on its due date; none of them fails any test below.

## Step 7. A request (only when the task has one)

as_of is the date the request is decided; it is before the trigger.
1. decision_due = the later of received_on and evidence_satisfied_on (when it is given) + 30 days.
2. The loan's age is the largest whole number n for which consummation + n months is on or before received_on.
3. The evaluation balance of an interest-bearing balance B is B + balance.deferred_principal_cents + balance.forborne_principal_cents. evaluation_upb_cents is the evaluation balance of the last posting's upb_after_cents, or of upb_on_receipt_cents when there are no postings. The LTV of a balance against a value is floor(balance × 10000 ÷ value), in basis points.
4. On the original_value path, the threshold is 8000 for the one-unit class and 7000 otherwise, against the original value. The threshold was reached on received_on when the evaluation balance of upb_on_receipt_cents has an LTV at or below it; otherwise on the posted_on of the first posting whose evaluation balance does; otherwise it was not reached. On the current_value path it is not reached. D is the date it was reached when that is later than received_on, and received_on otherwise.
5. The payment history. bStart = D − (the lesser of 12 and the loan's age) months; aStart = D − (the lesser of 24 and the loan's age) months. Look at the installments due on or after aStart and before D, leaving out those listed in disaster_excluded. Each one's days late is days_between(its due date, the date it was satisfied), or days_between(its due date, D) when it is unsatisfied. (A due date is the 1st, so an installment satisfied on or before the 28th of its due month is at most 27 days late, and needs no tool.)
   - late30_12m is how many of them are due on or after bStart and are 30 or more days late.
   - late60_24m is how many of them are 60 or more days late, wherever they fall.
   - The history reason is PAYMENT_HISTORY_30_12M when late30_12m is above 0; otherwise PAYMENT_HISTORY_60_24M when one due before bStart is 60 or more days late; otherwise there is none.
6. fnma_current: take the last day of the month before received_on's month. It is true when every installment due before that day was satisfied on or before it, and false otherwise.
7. When there is a valuation and as_of is later than its delivered_on + 120 days, the request is refused: result "refused", reasons ["VALUATION_EXPIRED"], decision_due as in 1, and every other request field null. Nothing more is decided on the request.
8. The threshold and the value:
   - original_value path: threshold_bps as in 4; the value is the original value.
   - current_value path: for the one-unit class, threshold_bps is 8000 when improvements_accepted is true, otherwise 8000 when the loan's age is 60 or more, otherwise 7500 when it is 24 or more, otherwise null. For the other classes it is 7000 when the age is 24 or more, otherwise null. When there is no valuation: result "value_check_needed", reasons ["VALUATION_REQUIRED"], ltv_bps null, and the other fields as found; nothing more is decided. Otherwise the value is valuation.value_cents.
   - ltv_bps is the LTV of evaluation_upb_cents against the value.
9. The reasons, in this order: SEASONING_INSUFFICIENT when threshold_bps is null, or else LTV_ABOVE_THRESHOLD (original_value path) or LTV_ABOVE_THRESHOLD_CURRENT (current_value path) when ltv_bps is above threshold_bps; then NOT_CURRENT when fnma_current is false; then the history reason. Any reason makes the result "ineligible", and nothing more is decided.
10. Otherwise, on the original_value path: the value checked is valuation.value_cents when there is a valuation, and avm_cents otherwise. When it is null or below the original value: result "value_check_needed", reasons ["VALUE_DECLINED_OR_UNKNOWN"]. Otherwise the result is "eligible" with reasons []: the effective date is the latest of received_on, the date the threshold was reached (when it was) and evidence_satisfied_on (when given), and the LAR 89 code is 51.
11. Otherwise, on the current_value path: the result is "eligible" with reasons []: the effective date is the later of received_on and valuation.delivered_on, and the LAR 89 code is 52.
12. For an eligible request, the premium-stop anchor is the later of received_on and evidence_satisfied_on (when given).
The automatic section is null when the task has a request.

## Step 8. The automatic termination (no request, MI not lender-paid)

When as_of is before trigger_date, nothing has happened yet: automatic and termination are null. Otherwise, with T the trigger date:
- The test month is the month before T's month. current_on_trigger is true when every installment due on or before the 1st of the test month was satisfied on or before the last day of the test month.
- Current: not_current_installments [], not_current_notice_due null and cure_on null; the effective date is T.
- Not current: not_current_installments lists every installment due on or before the 1st of the test month that was unsatisfied, or satisfied after the last day of the test month. not_current_notice_due = T + 30 days. Then find cure_on, starting with c = T:
  - if any installment due on or before c is unsatisfied, there is no cure: cure_on is null, there is no effective date, and termination is null;
  - otherwise let L be the latest of T and the dates the installments due on or before c were satisfied. When L is on or before c, cure_on is c. Otherwise set c to L and repeat.
  The effective date is the 1st of the month after cure_on's month (a cure on a 1st still moves to the 1st of the next month).
- The LAR 89 code is 53, and the premium-stop anchor is the effective date.

## Step 9. Lender-paid MI (plan "lender_paid")

Lender-paid MI is never cancelled, terminated or refunded: request, automatic and termination are null. When as_of is on or after trigger_date, lpmi_options_notice_due = trigger_date + 30 days; otherwise it is null. For every other plan lpmi_options_notice_due is null.

## Step 10. The termination

When Step 7 or Step 8 set an effective date E (and only then), report:
- lar89_action_code (51, 52 or 53) and lar89_action_date, E written MMDDYY (2035-07-01 is "070135").
- notice_due = E + 30 days. premium_stop_by = the premium-stop anchor + 30 days. refund_due = E + 45 days.
- insurer_notice_due = add_business_days(E, 2). escrow_interim_analysis_due = add_business_days(E, 10).
- unearned_premium_cents, by mi.plan:
  - "monthly": days = days_between(the 1st of E's month, E), at most 30. unearned = round(premium_cents × (30 − days) ÷ 30).
  - "annual": the anniversary is the latest of coverage_start + (12 × k) months, for k = 0, 1, 2, …, that is on or before E. days = days_between(the anniversary, E), at most 365. unearned = round(premium_cents × (365 − days) ÷ 365).
  - "single": the months in force are the largest whole number n for which coverage_start + n months is on or before E. The schedule row is the refund_schedule row with the largest months_in_force_from at or below that. unearned = round(premium_cents × its refund_pct ÷ 100).

## Submitting

Call submit_mi_review once with:
- position: original_value_cents, rule_78_applies, pi_cents, scheduled_78_payment_number, scheduled_78_date, midpoint_termination_date, trigger_date;
- request: null without a request; otherwise evaluation_upb_cents, threshold_bps, ltv_bps, fnma_current, late30_12m, late60_24m, result, reasons, decision_due;
- automatic: null unless Step 8 ran its test; otherwise current_on_trigger, not_current_installments, not_current_notice_due, cure_on;
- termination: null without an effective date; otherwise effective_on, lar89_action_code, lar89_action_date, notice_due, premium_stop_by, refund_due, insurer_notice_due, escrow_interim_analysis_due, unearned_premium_cents;
- lpmi_options_notice_due.
The sections must agree with one another, as these rules tie them: a request or a sweep, never both; an eligible request with no reasons, an ineligible one with reasons from 7.9 only, a value check needed or a refusal with its one reason (and a refusal's other evaluated fields null); a sweep that found the loan current with no installments, notice or cure, and one that did not with both; a termination exactly when the request is eligible or the sweep found the loan current or cured, coded 51 or 52 for a request and 53 for a sweep; and lpmi_options_notice_due only with the other three sections null.
A submission that does not fit the tool's schema, or whose sections do not agree, comes back as an error to be corrected; a valid one ends the task.
`;
