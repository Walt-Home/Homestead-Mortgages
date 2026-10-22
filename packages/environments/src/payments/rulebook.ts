/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's cashiering (spec §2.1, §2.2, §2.4, §2.7) as
 * its engine computes it — `allocate` and `assessLateCharge` — with the
 * daily convention the servicing app runs them in, written out in the
 * engine's order and limited to what v1's months reach. Where the engine
 * departs from its own spec, the generator and `paymentsInScope` keep those
 * months out, so what this says the engine computes is never a figure the
 * spec calls wrong. Two places are close to the line:
 *   - suspense counts toward an installment's late-charge test. That is
 *     2.7-Q1's default, which the engine documents as its decision, so it is
 *     stated as the rule. Step 2 counts a balance once, oldest installment
 *     first, as 2.7 rule 1 does; the engine counts the whole balance toward
 *     each unpaid installment, and a month where that decides is kept out
 *     (cashiering-4);
 *   - designated principal on a current loan is a separate curtailment
 *     (2.4 rule 2). A receipt that could have carried the next installment,
 *     or that would pool earlier suspense, is kept out (cashiering-9).
 * The grader is the engine; the reference policy follows these words
 * through the tools and is held to it on every generated task. Change this
 * text and the environment's version changes with it.
 */

export const PAYMENTS_RULEBOOK = `# Posting a month of payments

You post one loan's payments for the days in window (from through through, both included), the way the servicer's cashiering does: each day's late-charge run, then that day's receipts through the payment waterfall. Then you report where every receipt went, each late-charge decision, and where the loan stands at the end. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents. Dates are YYYY-MM-DD. "Round" means round half up (half away from zero) to a whole cent.
- The loan's installments are its projected payments, each with a due_date, pi_cents, escrow_cents and a status: due, satisfied or prepaid. "Open" installments are those with status due, oldest first.
- The loan state changes as you go: each step works on the state the step before left.
- Comparing two dates, or two amounts, is reading: it needs no tool. Working one out does.
- Settings the loan does not carry take these values: late_charge_pct "5", late_charge_grace_days 15, late_charge_cap_cents null (no cap), late_charge_basis "pi", fees [], overlays [], transfer_shield_until null.

## Step 1. The days

For each day d from window.from through window.through, in order: first the late-charge run for d (Step 2), then each receipt whose received_on is d, in the order the receipts are listed (Steps 3 to 9). A receipt is credited the day it is received.
Only two kinds of day change anything: the day after an installment's grace end (its run) and a day a receipt arrives. So find each installment's run day once, and visit just those days and the receipts' days, in date order; every other day can be skipped.

## Step 2. The late-charge run on day d

An installment's grace end is its due_date + late_charge_grace_days calendar days, moved forward to the next servicer business day when that is not one (next_business_day). On day d, take every installment, in the order the loan lists them, whose grace end is d − 1 day, whatever its status, and decide it:
1. A late_charge fee already in loan.fees for that installment's due date: not_assessed (once per installment).
2. Its basis is pi_cents (pi_cents + escrow_cents when late_charge_basis is "piti"). The amount received toward it is the basis when the installment is satisfied or prepaid (it was credited by then). Otherwise it is the suspense held for it: funds in suspense count as received, though they have not been applied, and one balance is counted once, oldest installment first. So take suspense_unapplied_cents, less the basis of each installment with status due whose due_date is earlier than this one's; when nothing is left it is 0, and it is never more than the basis. Received ≥ basis: not_assessed (paid within grace).
3. transfer_shield_until is set and the due date is on or before it: not_assessed.
4. The first forbearance_active overlay whose from is on or before the due date covers it when its to is null or on or after the due date, and it has no defaulted_on or the due date is before defaulted_on: not_assessed.
5. A bankruptcy_active overlay active on the due date (from ≤ due date, and to null or ≥ due date): accrued_suspended, for the amount below. It is recorded but adds nothing to late_charges_due_cents.
6. A foreclosure_referred overlay active on the due date: not_assessed.
7. Otherwise assessed: amount = round(basis × late_charge_pct ÷ 100), but no more than late_charge_cap_cents when that is set. It is recorded, and late_charges_due_cents rises by the amount.
Report each decision as a late-charge run: the installment's due date, run_on d, the outcome, and the amount (null when not_assessed).

## Step 3. A refused instruction

An instruction_text that mentions a second, 2nd, subordinate, junior or heloc lien in any form is refused: report refused_instruction true (whatever happens to the receipt next), and post the receipt as if it carried no instruction.

## Step 4. Holds and trials

When loan.holds is not empty, the whole receipt goes to suspense: suspense_unapplied_cents rises by the amount; the outcome is held_bk for a bankruptcy hold, held_fc for foreclosure_post_referral, held_dispute for noe_dispute, held_other for any other. When loan.trial_active is true, the same with outcome held_trial. Either way to_suspense is the amount, suspense_used is 0, and nothing else happens to the receipt.

## Step 5. The pool

The pool is the receipt's amount plus the loan's suspense_unapplied_cents; suspense_used is that suspense balance, and suspense_unapplied_cents becomes 0.

## Step 6. The installments

The loan is current when no open installment is due on or before received_on. A receipt designated "curtailment" on a current loan is a separate curtailment: skip this step entirely.
Otherwise take the open installments oldest first. For each, P = its pi_cents + escrow_cents. The funds available for it are the pool, less curtailment_cents when the receipt carries curtailment_cents and the installment is due after received_on. When the funds available are less than P, stop; never skip ahead. Otherwise take P from the pool and apply the installment:
- interest = round(upb_cents × note_rate_pct ÷ 1200); principal = pi_cents − interest; escrow = escrow_cents.
- upb_cents falls by principal; lpi_date becomes its due date.
- It is contractual when due on or before received_on, and prepaid when due after; its status becomes satisfied or prepaid accordingly.

## Step 7. A payment short of the next installment

When Step 6 applied nothing and there is an open installment (and it was not a separate curtailment), the receipt is a partial. Take the oldest open installment and its P; the shortfall is P − the pool.
- The $50 rule applies when the shortfall is 5000 or less, the loan is escrowed, its instrument_date is 1999-03-01 or later, its lien is "first", partial_count_12m is less than 3, and it has not opted_out_of_50_rule. Then apply that installment as in Step 6 (contractual or prepaid by its due date), but with escrow = escrow_cents − shortfall; the pool becomes 0 and partial_count_12m rises by 1.
- Otherwise the whole pool goes back to suspense: suspense_unapplied_cents becomes the pool; the outcome is unapplied, partial_hold is true, to_suspense is the receipt's amount, suspense_used is 0 (the suspense was returned), and nothing more happens to the receipt.

## Step 8. What is left

When the pool is empty, nothing happens here. Otherwise:
The receipt carries a principal instruction when it is designated "curtailment", or carries curtailment_cents above 0, or its instruction_text (not refused) mentions principal or curtail.
- With a principal instruction, when an installment due on or before received_on is still open: redirected_curtailment is true and nothing is curtailed; what is left goes to suspense.
- With a principal instruction otherwise: the curtailment is curtailment_cents when that is above 0 and less than the pool, and otherwise the whole pool. upb_cents falls by it. What is left after it goes to suspense.
- Without a principal instruction: late charges due take what they can (the least of the pool and late_charges_due_cents), and late_charges_due_cents falls by it (late_charge_paid). What is left goes to suspense.
What goes to suspense here raises suspense_unapplied_cents and is the receipt's to_suspense.

## Step 9. The outcome

Unless Step 4 held the receipt or Step 7 sent it to suspense: when no installment was applied, the outcome is curtailment if Step 8 curtailed, and unapplied otherwise. When installments were applied, it is prepaid if every one applied was prepaid (the $50 rule included); otherwise applied_with_50_rule if the $50 rule applied one; otherwise applied.

## Submitting

Call submit_posting once with:
- receipts: one entry per receipt, in order, each with payment_id, outcome, installments (each applied installment in order: due_date, kind (contractual or prepaid), interest_cents, principal_cents, escrow_cents), late_charge_paid_cents, curtailment_cents, to_suspense_cents, suspense_used_cents, partial_hold, redirected_curtailment and refused_instruction;
- late_charge_runs: every decision of Step 2 (installment_due_date, run_on, outcome, amount_cents or null), or an empty list;
- final: upb_cents, lpi_date, suspense_cents (suspense_unapplied_cents), late_charges_due_cents, partial_count_12m, and installments (every installment's due_date and status).
A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
