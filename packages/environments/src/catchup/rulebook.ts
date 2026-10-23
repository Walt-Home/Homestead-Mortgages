/**
 * The rules a model is given, and graded against.
 *
 * Step 1 is D-03's correction (docs/synthetic-data-defects.md): every late
 * charge held to the note's terms with the engine's own `lateChargeAmount`
 * (apps/servicing/src/domain/cashiering/latecharges.ts:40), what is still owed
 * reduced to that, and what was collected above it owed back. Steps 2 to 5
 * are cashiering's `allocate` on a receipt that pays at least one installment
 * in full, in the engine's order, with every rounding where the engine makes
 * it. The receipts are kept off the partial-payment paths that carry logged
 * engine defects (cashiering-4, -7, -10 and -13 in
 * docs/servicing-engine-defects.md): none pools suspense, none is short of the
 * oldest installment, and none leaves money for late charges while an
 * installment due is still unpaid. The grader is the engine; the reference
 * policy follows these words through the tools and is held to it on every
 * generated task. Change this text and the environment's version changes
 * with it.
 */

export const CATCHUP_RULEBOOK = `# Posting a catch-up payment

You post one payment on a loan that fell behind: money a borrower sent to catch up after missing an installment. Before you post it, you hold every late charge on the loan to the note, because the servicing system charges with the terms it boarded, and a boarding can lose the note's dollar cap on a late charge. Then you post the payment through the waterfall, say what is owed back to the borrower, and say whether the loan is current after posting. Follow these rules exactly and in order. Use the tools for every calculation; never estimate.

Conventions:
- Money is integer cents ("158017" is $1,580.17). Dates are YYYY-MM-DD. "Round" means round half up (half away from zero) to a whole cent.
- An installment is open when its status is due. Open installments are taken oldest first.
- Comparing two dates, or two amounts, is reading: it needs no tool. Working one out does.
- The history is there to read, as a servicer's screen shows it. Nothing in it is to be posted again.

## Step 1. Every late charge, held to the note

The note's terms are note.late_charge: pct, cap_cents (null when the note has no dollar cap) and basis "pi". The system charged with servicing.late_charge, its own copy of those terms; where the two differ, the note is right.

For each entry in late_charges:
- allowed = round(installment_pi_cents × pct ÷ 100), but no more than cap_cents when the note has a cap.
- still owed = allowed − collected_cents, or 0 when collected_cents is allowed or more.
- collected above the note = collected_cents − allowed, or 0 when collected_cents is not more than allowed.

late_charges_due is the sum of every charge's still owed: it replaces loan.late_charges_due_cents, which is the system's figure.
refund_due is the sum of every charge's collected above the note: the borrower is owed it back.

## Step 2. The pool

The pool is the payment's amount_cents plus loan.suspense_cents. From here on the suspense balance is 0 until Step 4 puts something in it.

## Step 3. The installments

Take the open installments oldest first. For each, P = its pi_cents + escrow_cents. When the pool is less than P, stop: never skip ahead. Otherwise take P from the pool and apply the installment:
- interest = round(upb_cents × note_rate_pct ÷ 1200), on the balance as it stands before this installment; principal = pi_cents − interest; escrow = escrow_cents.
- upb_cents falls by principal, and lpi_date (the installment the loan is paid through) becomes its due_date.
- Its kind is contractual when its due_date is on or before the payment's received_on, and prepaid when it is after; either way it is no longer open.
Every payment here pays at least the oldest open installment in full.

## Step 4. What is left

Whatever is left of the pool goes first to late charges: late_charge_paid is the smaller of what is left and late_charges_due (Step 1). Whatever is left after that goes to suspense (to_suspense).

## Step 5. After posting

- late_charges_due_after = late_charges_due − late_charge_paid.
- upb_after = upb_cents after Step 3, and lpi_after = lpi_date after Step 3.
- current_after_posting is true when no installment that is still open has a due_date on or before received_on, and false otherwise.

## Submitting

Call submit_posting once with:
- installments: each installment Step 3 applied, oldest first: due_date, kind (contractual or prepaid), interest_cents, principal_cents, escrow_cents;
- late_charge_paid_cents and to_suspense_cents;
- late_charges: every entry of late_charges, with its installment_due_date and its allowed_cents from Step 1;
- refund_due_cents;
- late_charges_due_after_cents, upb_after_cents, lpi_after and current_after_posting.
A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
