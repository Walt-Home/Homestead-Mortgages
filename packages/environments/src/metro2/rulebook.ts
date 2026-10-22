/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's monthly Metro 2 furnishing (spec §8.1) as its
 * engine computes it — `buildSnapshot`, `renderBase` and `validateSnapshot`
 * over the FIFO ledger — written out in the engine's order, with the
 * conventions the grader runs it under (each month's ledger, an omitted
 * month's carry, the forbearance entry figures, what counts as a payment in
 * the month) stated where they apply. Where the engine departs from its own
 * spec, v1 never draws the month (see the generator's scope guard), so
 * nothing here teaches a departure. The one exception is a choice the spec
 * leaves open: the engine uses the optional codes AS and H, which 8.1-Q10
 * leaves off until confirmed, and Step 3 says so. The reference policy
 * follows these words through the tools and is held to the engine on every
 * generated task. Change this text and the environment's version changes
 * with it.
 */

export const METRO2_RULEBOOK = `# Furnishing a loan's Metro 2 Base records

You furnish one mortgage loan's Metro 2 Base record for each month in months, in order, the way the servicer's credit reporting builds them at each month's end: the account status, payment rating, amount past due, date of first delinquency (DOFD), payment history profile (PHP), special comment, balance, terms and payments, and the consumers' segments. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money in the task is integer cents. Dates in the task are YYYY-MM-DD. In a record, a date is MMDDYYYY ("02012027" is 2027-02-01), and "00000000" when there is none.
- A record's money is whole dollars as 9 digits, zero-filled on the left: 245955 cents is "000002459". Under policy.metro2_rounding "truncate", drop the cents. Under "round", drop the cents, then add one dollar when the cents dropped were 50 or more.
- Comparing two dates or two amounts, dropping cents and zero-filling are reading: they need no tool. Working out a figure or a date — a sum, a product, a quotient, adding a dollar, a day count, a month's last day, a date a day earlier — is a calculation: use the tools.
- P is the installment amount, loan.pi_cents + loan.escrow_cents. Every installment listed is P.
- Each month's record is built on the record before it: the first month's on last_record, each later month's on the month before it in months.

## Step 1. The ledger

The ledger applies the receipts to the installments, oldest installment first. Nothing was owed before the first installment listed, and nothing was held in suspense.
Take the receipts in date order (receipts on the same date in the order listed). A pool starts at 0. Add each receipt to the pool; then, while the pool holds P or more, the oldest installment not yet satisfied is satisfied on that receipt's date and P leaves the pool. So after a receipt the pool pays floor(pool ÷ P) more installments, oldest first, and keeps the rest. A part payment waits in the pool; it never satisfies part of an installment. (Adding a receipt to an empty pool, a pool below P, which pays nothing, and a pool of exactly P, which pays one installment and empties, are reading.)
Note each installment's satisfied date, or none.

At a date D:
- an installment is unpaid when it is due on or before D and was not satisfied on or before D. A receipt dated after D does not count at D: the ledger at D holds only the receipts received on or before D;
- E(D) is the due date of the oldest unpaid installment at D, or none;
- the days past due are days_between(E(D), D), or 0 when E(D) is none;
- the amount past due is P × the number of unpaid installments at D. Money waiting in the pool does not reduce it.

## Step 2. Each month's end

A month's as_of is its last day (end_of_month). Its contractual status is the status for the days past due at as_of: 0 to 29 days "11"; 30 to 59 "71"; 60 to 89 "78"; 90 to 119 "80"; 120 to 149 "82"; 150 to 179 "83"; 180 or more "84".

## Step 3. What the month reports

Start from:
- account status: the contractual status; payment rating: none; special comment: blank;
- amount past due: the amount past due at as_of;
- scheduled payment: P;
- current balance: books.upb_cents + books.deferred_principal_cents + books.forborne_principal_cents;
- terms duration: loan.original_term_months under policy.terms_duration "original", books.remaining_term_months under "remaining";
- date closed: none; K4: none.

Then apply what is in force (in_force holds at most one of these, beside any foreclosure_referral):
- forbearance_plan: special comment "CP"; scheduled payment = plan_payment_cents. Under policy.forbearance_status "freeze", the account status and the amount past due are the plan's entry figures instead: the status for the days past due on the day before effective_on, and the amount past due on that day. Under "contractual_aging" both stay as they are.
- repayment_plan: amount past due = remaining_arrears_cents. Special comment "AC" when plan_payment_cents is less than P; blank otherwise.
- trial_plan: special comment "AC". Nothing else changes: the trial payments are receipts like any other.
- modification: account status "11"; special comment "CO"; amount past due 0; scheduled payment = new_piti_cents; terms duration = new_term_months, under either policy; K4 only when books.forborne_principal_cents is above 0: balloon due date books.maturity_date, balloon amount books.forborne_principal_cents.
- payment_deferral: account status "11"; amount past due 0; K4 always: balloon due date books.maturity_date, balloon amount books.deferred_principal_cents.
- A closing: date closed = closed_on; amount past due 0; payment rating = the rating for the days past due at closed_on, not at as_of: 0 to 29 days "0"; 30 to 59 "1"; 60 to 89 "2"; 90 to 119 "3"; 120 to 149 "4"; 150 to 179 "5"; 180 or more "6". Then:
  - payoff: account status "13"; special comment "AS" when by_refinance, blank otherwise (this servicer furnishes the optional codes AS and H, Step 7); current balance 0;
  - short_sale: account status "65" when a foreclosure_referral is in force, "13" otherwise; special comment "AU"; current balance 0;
  - foreclosure_sale: account status "94"; current balance 0 unless deficiency_pursued;
  - deed_in_lieu: account status "89"; current balance 0 unless deficiency_pursued.
Last: when no closing is in force and a foreclosure_referral is, a special comment still blank becomes "BO". "CP", "AC" and "CO" are never replaced by it.

## Step 4. The date of first delinquency

Take the first that applies:
1. No installment is unpaid at as_of: none.
2. The account status is "11": none, even with an amount past due.
3. The record before carries a DOFD on or before E(as_of): that DOFD. While a delinquency continues, its DOFD is never moved later.
4. Otherwise: E(as_of).
The record before is the previous month's, built in full even when it was not furnished (Step 6), or last_record for the first month ("00000000" is none). When last_record is null there is no record before, and rule 4 applies.

## Step 5. The payment history profile

The PHP is 24 characters; position 1 is the month before this one. It is the record before's PHP with one character put in front and its 24th character dropped. The character is the account status the record before reported: "11" 0, "71" 1, "78" 2, "80" 3, "82" 4, "83" 5, "84" 6; or D when the record before was not furnished (Step 6).
For the first month the record before is last_record. A last_record PHP shorter than 24 characters (a prior servicer's hand-off may be) is first padded on the right with B to 24. When last_record is null (the loan was boarded with no history), the first month's PHP is 24 B's.

## Step 6. Payments, and a record that is not furnished

- Actual payment: the receipts dated in the month, on or before as_of, added up, plus a payoff's payoff_funds_cents when a payoff is in force. 0 when there are none.
- Date of last payment: the latest receipt dated on or before as_of, or a payoff's closed_on when that is later; none when there is no receipt.
A record with any of these hard errors is not furnished:
- STATUS_11_WITH_DOFD: account status "11" with a DOFD;
- DOFD_REQUIRED: account status "71" to "84", "65", "89", "94" or "97" with no DOFD;
- PAYMENT_RATING_REQUIRED: account status "13", "65", "89", "94" or "05" with no payment rating;
- PHP_LENGTH: a PHP that is not 24 characters;
- APD_WITH_CLOSED_STATUS: an amount past due above 0 with account status "13", "94" or "89";
- K3_MIN_MISSING: books.min is null; MIN_NOT_18_DIGITS: books.min is present and not exactly 18 digits (a null MIN is K3_MIN_MISSING alone);
- K3_FNMA_LOAN_NUMBER: books.fnma_loan_number is not exactly 10 digits;
- NO_CONSUMER_SEGMENT: no consumer segments (Step 7).
Report such a month as not furnished, with every hard error it has. Its record is still built in full: the next month carries its DOFD and PHP, with D for it in the PHP.
Nothing else keeps a month from being furnished. A loan boarded with a payment already past due was sent its validation notice with the servicer's hello letter more than 14 days before the first month's end, and none came back undeliverable, so the debt-collector hold on furnishing it has lifted.

## Step 7. The consumers' segments

From consumers, in order of position, leaving out every successor_in_interest:
- segment: position 1 is "base"; any other is "J1" when same_address_as_base, "J2" otherwise;
- ECOA: "Z" when never_liable; otherwise "X" when deceased; otherwise "T" when released; otherwise "5" for liability guarantor, "2" for joint, "1" for individual;
- special comment: "H" when released, whatever the ECOA; otherwise the record's special comment.
Report the segments of the last month furnished.

## Submitting

Call submit_records once with:
- records: one per month, in any order. A furnished month: month, furnished true, account_status, payment_rating ("" when none), date_closed, amount_past_due, date_of_first_delinquency, payment_history_profile, special_comment ("" when blank), current_balance, scheduled_monthly_payment, terms_duration (3 digits, zero-filled: "360"), k4 (null, or balloon_due_date and balloon_amount), actual_payment_amount and date_of_last_payment. A month not furnished: month, furnished false and hard_errors;
- consumers: the last furnished month's segments, each with party_id, segment, ecoa and special_comment.
On a closing month (account status "13", "65", "89" or "94") the scheduled payment is not graded. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
