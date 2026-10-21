/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's ARM adjustment (spec §7.2, Regulation Z
 * §1026.20(c); spec §7.3, §1026.20(d), for the first change's initial
 * notice) as its engines and its ARM service compute it, written out in their
 * order with every rounding and every boundary said where it is made: the
 * look-back, the index, the margin, the eighth with its midpoint rule, the
 * caps in the engine's order and the limit that binds, the scheduled balance
 * at the old rate, the payment, the notice's kind and window, which notice
 * goes, the send check, and the initial notice. The grader is the ported
 * engine, so a sentence here that disagrees with it is a task nobody can
 * pass; the reference policy follows these words through the tools alone and
 * is held to the engine on every generated task. Change this text and the
 * environment's version changes with it.
 */

export const ARM_RULEBOOK = `# The ARM interest-rate and payment change

You work one adjustable-rate mortgage's interest-rate change on its change date, the way the servicer's ARM engine works it: the index the note looks back to, the new rate under the note's rounding, caps and floor, the balance the note expects and the new payment, the Regulation Z §1026.20(c) notice that goes with the change and whether the proposed send date is inside its window, and, on the loan's first change, the §1026.20(d) initial notice's duty and window. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents ("247644" is $2,476.44). Dates are YYYY-MM-DD.
- Rates are annual percentages. Every rate in the task has three decimals ("5.750"), and so does every rate you report except the unrounded rate, which has five ("6.39883"). Index values have five decimals, and you report the one you use exactly as it is given.
- "Round" means round half up (half away from zero) to a whole cent, at the step that says so and nowhere else.
- "Whole months from A to B" counts by year and month alone: from 2021-12-01 to 2026-11-01 is 59. Every due date and change date here falls on the 1st, so whole_months_between gives it.
- Comparing two dates, two rates or two amounts is reading: it needs no tool. Working one out does.
- The first change is the one whose change_date is loan.first_change_date; every other is a later change.

## Step 1. The dates

- index_date = change_date − lookback_days days.
- first_new_payment_due is the first payment due date after change_date. Payments fall due on the day of the month of first_payment_due, which here is the 1st, as change_date is: so it is change_date + 1 month.
- maturity = first_payment_due + (term_months − 1) months.
- remaining_term_months = whole months from first_new_payment_due to maturity, + 1 (both ends count).
- next_change_date = change_date + adjustment_period_months months.

## Step 2. The index

Take the index_series entry with the latest effective_date on or before index_date. An entry dated on the index date counts; an entry dated after it never does. index_effective_date and index_value are that entry's.

## Step 3. The unrounded rate

unrounded = index_value + margin_pct, exactly. Report it as unrounded_pct, with five decimals.

## Step 4. Rounding to the nearest eighth

Let q = unrounded × 8, f = floor(q), and the remainder = q − f.
- A remainder above 0.5 rounds up: rounded = (f + 1) ÷ 8.
- A remainder below 0.5 rounds down: rounded = f ÷ 8.
- A remainder of exactly 0.5 is a midpoint. It rounds down under rounding_rule nearest_eighth_half_down and up under nearest_eighth_half_up.
midpoint_flag is true exactly when the remainder is 0.5. Report rounded_pct with three decimals.

## Step 5. Caps and floor, in this order

The prior rate is current_rate_pct. The cap is initial_cap_pct on the first change and periodic_cap_pct on a later change. Start with rate = rounded and bound = "none".
1. If rate is above prior + cap, it becomes prior + cap; if it is below prior − cap, it becomes prior − cap. Either way bound = "initial" on the first change and "periodic" on a later change.
2. The lifetime ceiling is initial_note_rate_pct + lifetime_cap_pct. If rate is above it, it becomes the ceiling and bound = "lifetime".
3. The floor is margin_pct. If rate is below it, it becomes margin_pct and bound = "floor".
A rate equal to a limit is neither above nor below it: the rate stays, and bound is left as it was. Report new_rate_pct with three decimals.

## Step 6. The expected balance

The balance the note expects on the change date is the scheduled balance after the payment due on the change date, every scheduled payment made, worked from schedule_basis (upb_cents, rate_pct, pi_cents, from_due_date): the note itself on the first change, and what the last change left on a later one. It is never worked from original_upb_cents.
- When interest_only_until is not null and change_date is on or before it, the expected balance is schedule_basis.upb_cents.
- Otherwise n = whole months from schedule_basis.from_due_date to change_date, + 1 (the payment due on the change date counts), and the expected balance is balance_after(schedule_basis.upb_cents, schedule_basis.rate_pct, schedule_basis.pi_cents, n).

## Step 7. The new payment

- When interest_only_until is not null and first_new_payment_due is on or before it, the payment is interest only: new_pi = round(expected balance × new_rate_pct ÷ 1200).
- Otherwise new_pi = level_payment(expected balance, new_rate_pct, remaining_term_months).

## Step 8. The notice's timing

notice_kind is the first of these that applies:
1. term_months is 12 or less: fnma_only.
2. The first change, first_new_payment_due no more than 210 days after consummation_date (days_between), and initial_disclosure_estimate false: fnma_only.
3. The first change, change_date no more than 60 days after consummation_date, and initial_disclosure_estimate true: c_first_25.
4. adjustment_period_months is 2 or less, or consummation_date is before 2015-01-10 and lookback_days is under 45: c_25_120.
5. Otherwise: c_60_120.
notice_window_open is first_new_payment_due − 120 days for c_60_120 and c_25_120, and null for c_first_25 and fnma_only.
notice_due_by is first_new_payment_due − 60 days for c_60_120, first_new_payment_due − 25 days for c_25_120 and c_first_25, and change_date − 25 days for fnma_only.

## Step 9. Which notice

The rate changed when new_rate_pct differs from current_rate_pct; the payment changed when new_pi differs from current_pi_cents.
- NTC_REGZ_20C_ARM_ADJ (the §1026.20(c) notice) goes when both changed, notice_kind is not fnma_only, and the loan does not have fdcpa_cease_on_file and fdcpa_debt_collector both true.
- Otherwise NTC_FNMA_C2_1_02_RATE_CHANGE (Fannie Mae's rate-change notice) goes when either changed.
- Otherwise no notice goes: notice_template is null.

## Step 10. The send check

Check proposed_send_on against the notice that goes:
- NTC_REGZ_20C_ARM_ADJ: for c_60_120 and c_25_120 the window opens on notice_window_open, and a send before it is "blocked" (c_first_25 has no opening). The deadline is notice_due_by: a send after it is "late", and days_late = days_between(the deadline, proposed_send_on). Any other send is "on_time".
- NTC_FNMA_C2_1_02_RATE_CHANGE: "late" when proposed_send_on is after change_date − 25 days, and "on_time" otherwise. It has no opening.
- No notice: send_outcome is null.
days_late is null unless a Reg Z notice is late.

## Step 11. The initial notice

On the first change only, the §1026.20(d) initial notice:
- initial_notice_status is exempt_short_term when term_months is 12 or less; otherwise originator_duty when first_new_payment_due is no more than 210 days after consummation_date; otherwise servicer.
- initial_notice_window_open = first_new_payment_due − 240 days, and initial_notice_due_by = first_new_payment_due − 210 days.
On a later change all three are null.

## Submitting

Call submit_adjustment once with index_date, index_effective_date, index_value, unrounded_pct, rounded_pct, midpoint_flag, new_rate_pct, bound, expected_upb_cents, first_new_payment_due, remaining_term_months, next_change_date, new_pi_cents, notice_kind, notice_window_open, notice_due_by, notice_template, send_outcome, days_late, initial_notice_status, initial_notice_window_open and initial_notice_due_by: every field, null where the rules say null. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
