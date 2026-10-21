/**
 * The refinance review as a policy, not a recipe.
 *
 * refi-tape's rulebook is a procedure: numbered steps, each saying what to
 * compute next, and frontier models follow a written procedure almost
 * without fail. This is the same content as a policy is written for people:
 * by topic, in defined terms, with precedence stated as precedence, and no
 * order of work given. Every fact the grading depends on is here — every
 * field, code, threshold and rounding of the step rulebook, which a test
 * holds — so a task is no less determined; the model must work out the
 * procedure itself.
 */

export const POLICY = `# Refinance review policy

This policy decides, for one mortgage loan on one review date, whether we offer the homeowner a refinance into a new 30-year fixed-rate loan at today's quoted rate, and if not, why not. You receive our loan record (\`loan_record\`) and the servicer's newest tape observation (\`tape\`: its date \`as_of\`, its typed columns, and \`facts\`, the tape's own fields), today's quote, the loan's offer history, and the tape's exceptions. Apply the policy and submit its outcome with submit_review. Compute every figure with the tools.

Money is integer cents. Rates are annual percentages written with three decimals. Dates are YYYY-MM-DD. Where this policy says round, it means round half up, at that point and nowhere else. The program's terms: a rate floor of 25 basis points, a holding period H of 84 months, a new term of 360 months, and a Massachusetts window of 60 months.

## How the tape is read

A value on the tape counts only when it has the right shape: a date is YYYY-MM-DD, of which only the first 10 characters are read; money is integer cents, as a number or a string of digits; a rate is a number, or a string of one or two digits with up to three decimals (a PMI rate may have three digits), and is written with three decimals; a yes/no is true or false or one of y, yes, true, 1 or n, no, false, 0, in any case. Anything else is absent. Where several sources are named for a figure, the first one present governs.

The loan's terms. The first payment date is loan_record.first_payment_on, or facts.first_payment_date. The original term is facts.original_term_months, or loan_record.term_months. The consummation date (consummation_date) is loan_record.originated_on, or facts.origination_date, or the first payment date. Maturity is facts.maturity_date, or loan_record.maturity_on, or the first payment date plus (original term − 1) months. The note rate is facts.note_rate_pct, or tape.current_rate_pct, or loan_record.note_rate_bps divided by 100. The scheduled payment (pi_cents) is facts.pi_cents, or the level payment of facts.original_upb_cents (or loan_record.original_principal_cents) at the note rate over the original term. The unpaid balance (upb_cents) is facts.upb_cents, or tape.principal_balance_cents.

The next due date is tape.next_payment_due_on, or facts.next_due_date. A tape that gives neither leaves it to be inferred from the first payment date and the review date: it is the first monthly anniversary of the first payment date that falls after the review date, counting whole months as the whole_months_between tool does (k whole months from the first payment date to the review date, never fewer than 0; the first payment date plus k months if that is after the review date, otherwise plus k + 1 months). The remaining term (remaining_term_months) is the whole months from the next due date to maturity plus one, when the next due date is not after maturity; otherwise it is facts.remaining_term_months, or 0.

Delinquency (regx_days_delinquent) is measured to the tape's own as_of date, never the review date: the days from the next due date to that date when the next due date is earlier, and otherwise 0. A tape that says the loan is late overrides a 0: a facts.pay_string ending in 3, 6, 9 or F, or a facts.mba_delinquency_status that is text and is either a whole number above 0 or contains "late" or "delinq", makes it 30 (in any case; both are read only as text). And tape.delinquency_days governs whenever it is larger.

The value (value_estimate) is the later-dated of facts.fmv_cents (dated facts.fmv_date) and facts.bpo_value_cents (dated facts.bpo_date), each counted only above 0 and, if undated, dated the tape's as_of date; on equal dates the FMV governs. With neither, it is facts.appraised_value_cents if above 0, dated facts.origination_date or, failing that, the consummation date. Its confidence is "medium" when it is dated on or after the review date less 12 months, and "low" otherwise.

Mortgage insurance is active (mi_status "bpmi_active") when facts.pmi_flag is yes, and otherwise "none". The PMI rate is facts.pmi_rate_pct; a rate above 5 is in basis points, and is divided by 100, to three decimals, to make it a percentage. The existing loan's monthly premium (the loan's own mi_monthly_cents, which the tape does not give and is figured here) is round(upb_cents × PMI rate% ÷ 12) when the insurance is active and the PMI rate is above 0, and 0 in every other case. The escrow deposit for a new loan (net_escrow_deposit_estimate_cents) is twice facts.ti_cents when that is above 0, and otherwise 0.

The loan is active (status "active") when loan_record.state is "monitoring_only" or "active", and "not_active" otherwise. A bankruptcy is active (bankruptcy_active) when facts.bk_status is yes, or when there is a facts.bk_filed_date with neither a yes in facts.bk_discharged nor a facts.bk_dismissed_date. A foreclosure is referred (foreclosure_referred) when facts.fc_status is yes or there is a facts.fc_referral_date. A loss-mitigation plan is active (lossmit_plan_active) when facts.modification_flag is yes. A transfer is pending (transfer_out_pending) when facts.servicing_status contains "transfer", "sold", or "service" and "released" with a space, an underscore, a hyphen or nothing between them, in any case. The tape carries neither a deceased or successor-in-interest matter (deceased_or_sii_pending) nor a do-not-solicit request (refi_do_not_solicit); both are false. Occupancy, from loan_record.occupancy or else facts.occupancy, is "second_home" when it starts with "second", "investment" when it starts with "invest", and "primary" otherwise, in any case. The state is loan_record.property_state, or facts.property_state.

A tape that gives no first payment date, an unpaid balance that is not above 0, or no value of any of the three kinds does not describe a loan this policy can review; the outcome is "not_reviewable", with the reason no_first_payment_date, no_upb or no_value respectively. When more than one applies, only the first in that order is the reason.

## Who is reviewed

A loan is excluded from the review if it is not active (not_active), has an active bankruptcy (bankruptcy_active), has been referred to foreclosure (foreclosure_referred), is in an active loss-mitigation plan (lossmit_plan_active), has a deceased or successor matter pending (deceased_or_sii_pending), has a transfer pending (transfer_out_pending), or is delinquent by any days at all (delinquent). An excluded loan is assessed no further, and only the first of these that applies, in the order given, is reported.

## When an offer is suppressed

An offer is suppressed, though the loan is still reviewed, when the homeowner asked not to be solicited (marketing_suppression); when they declined an offer and the review date is before 90 days after offer_history.declined_on (cooldown); or when offer_history.offered_at holds two or more offers dated after the review date less 12 months and on or before the review date (frequency_cap). Only the first of these that applies, in the order given, is reported.

## The candidate loan

Every review prices the same candidate: a new 30-year fixed loan that consummates 36 days after the review date and disburses 6 days after that.

The candidate pays off the existing loan through disbursement: the unpaid balance plus per diem interest for each day from the next due date to the disbursement date (payoff_days), or no days if the next due date is later, the per diem (per_diem) being round(upb_cents × note rate% ÷ 365). It also carries prepaid interest from the disbursement date through the last day of that month, both days counted (prepaid_days), at the existing loan's note rate: for an amount A, round(A × note rate% ÷ 365) per day. And it funds the escrow deposit.

The raw loan amount is the payoff, plus the prepaid interest on the payoff, plus the escrow deposit. The program rounds the amount up to the next multiple of 100000 cents ($1,000), a multiple being left as it is, but only while the cash back that results stays within the cap; otherwise it takes the raw amount. For an amount A the cash back is A less the payoff less the prepaid interest on A, and the cap is the larger of round(A × 1%) and 200000 cents.

The candidate is eligible (the prescreen passes) when its loan-to-value, round(loan amount × 10000 ÷ value) as a whole number (ltv_x10000), is no more than 9700 for a primary residence, 9000 for a second home or 7500 for an investment property; but a value of low confidence fails any loan-to-value above 9000.

## The benefit

The benefit compares the existing loan, at note rate r0 and payment pi0, with the candidate at the quoted rate r1. The candidate's payment (new_pi) is the level payment of the loan amount at r1 over 360 months. Its mortgage insurance (mi_new) is the quote's mi_monthly_cents when ltv_x10000 is above 8000 (0 if the quote gives none), and otherwise 0. The existing loan's (mi_existing) is the existing loan's monthly premium figured from the tape's PMI rate, as set out under how the tape is read, when its insurance is active, and otherwise 0; it is not a field of the quote.

The payment saving (pi_delta) is pi0 less new_pi; the monthly saving (payment_delta) adds the insurance saving to it, the existing premium less the new one. The rate reduction (rate_delta_bps) is (r0 − r1) × 100, rounded to one decimal place. The interest left on the existing loan (lifetime_interest_existing) is pi0 times the remaining term, less the unpaid balance; the new loan's (lifetime_interest_new) is new_pi × 360 less the loan amount. The same-term option is the loan amount repaid over the remaining term at r1: its payment (same_term_pi) is that level payment and its interest (same_term_lifetime_interest) is same_term_pi times the remaining term, less the loan amount.

The present value of the saving (npv) is the present value of payment_delta paid monthly for H months at r1; the same-term option's (same_term_npv) is that of pi0 less same_term_pi plus the insurance saving, likewise. The seven-year total cost difference (seven_year_total_cost_delta) is pi0 × H plus the existing loan's balance after H payments of pi0 at r0, less new_pi × H plus the new loan's balance after H payments of new_pi at r1.

## The Massachusetts rule

A Massachusetts loan (property_state "MA") consummated fewer than 60 whole months before the candidate's consummation date must be refinanced in the homeowner's interest: the rule is met only if pi_delta is above 0 or rate_delta_bps is above 0. Any other loan meets it.

## When an offer fires

An offer fires only if all of the following hold, and each that fails is reported by its code: a rate reduction of at least the floor (rate_delta_below_floor); an npv above 0 (npv_not_positive); a seven-year total cost difference above 0 (seven_year_not_lower); a passing prescreen (prescreen_failed); and a met Massachusetts rule (state_rule_failed). A suppression also stops it and is reported by its own code. A new full term may cost more interest than is left on the existing loan (lifetime_interest_new above lifetime_interest_existing, a lifetime_interest_delta above 0) only when the same-term option's npv is above 0, and then that option is presented first (present_same_term_first); otherwise reset_costs_more is reported.

Without a quote nothing is priced: the reasons are the suppression, if any, then not_priceable and not_priced.

## The value's age and soundness

A value dated before the review date less 24 months is stale (value_stale). A tape exception "implausible_value" makes it implausible (implausible_value).

## The outcome

The outcome is the first of these that applies:
- "not_reviewable" when the tape cannot describe the loan, as above;
- "excluded" when an exclusion applies, as above;
- "candidate" when an offer fires and the value is neither stale nor implausible; its reasons are always rate_delta, npv_positive, seven_year_delta_positive, prescreen and state_rule;
- "not_now" when the value is stale or implausible, or a suppression applies; its reasons are the codes reported, then implausible_value and value_stale where they apply;
- "watching" otherwise, with the codes reported as its reasons, and a watch rate of r0 less 0.25 rounded down to a multiple of 0.125, written with three decimals.

## What is submitted

Call submit_review once with the outcome as verdict and its reasons, in any order. For a candidate, the offer gives, in integer cents as strings: loan_amount_cents, new_pi_cents, pi_delta_cents, cash_back_cents, cash_back_cap_cents, lifetime_interest_existing_cents, lifetime_interest_new_cents, same_term_pi_cents, same_term_lifetime_interest_cents, npv_cents and seven_year_total_cost_delta_cents; with rate_delta_bps as a number and present_same_term_first. Otherwise offer is null. watch_rate_pct is the watch rate for "watching" and null otherwise. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the review.
`;
