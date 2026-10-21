/**
 * The tape reader's rules, written out, in front of the review's.
 *
 * Step 0 is `universeLoanOf` in `@hm/refi-review` as instructions, field by
 * field, for every field the review reads; the rest is refi-review's
 * rulebook unchanged. The grader runs the same function and then the
 * review, and the reference policy follows these words through the tools
 * alone, held to the grader on every generated task.
 */

import { RULEBOOK } from "../refi/rulebook.js";

const STEP_ZERO = `# Reading the loan from the servicer's tape

Before the review, build the loan's row from two inputs: \`loan_record\` (our record of the loan) and \`tape\` (the servicer's newest observation: its date \`as_of\`, its typed columns, and \`facts\`, the tape's own fields). For each row field below, take the first source that is present and readable.

What counts as readable:
- A date is YYYY-MM-DD; only its first 10 characters are read.
- Money is integer cents, as a number or a string of digits.
- A rate is a number, or a string of one or two digits with up to three decimals ("6.125", "55"); a PMI rate may have three digits ("100"). It is written with three decimals ("6.125", "55.000", "100.000").
- A yes/no is true or false, or one of y, yes, true, 1 (yes) or n, no, false, 0 (no), in any case.
Anything else counts as absent.

## Step 0. The row

- first_payment_date: loan_record.first_payment_on, else facts.first_payment_date. If neither, the loan cannot be reviewed: answer verdict "not_reviewable" with reasons ["no_first_payment_date"] and stop.
- original_term: facts.original_term_months, else loan_record.term_months.
- consummation_date: loan_record.originated_on, else facts.origination_date, else first_payment_date.
- maturity: facts.maturity_date, else loan_record.maturity_on, else first_payment_date + (original_term − 1) months.
- next_due_date: tape.next_payment_due_on, else facts.next_due_date. If neither: k = the whole months from first_payment_date to the review date (0 if negative); candidate = first_payment_date + k months; next_due_date is the candidate if it is after the review date, otherwise first_payment_date + (k + 1) months.
- remaining_term_months: if next_due_date is on or before maturity, the whole months from next_due_date to maturity, plus 1; otherwise facts.remaining_term_months (0 if absent).
- note_rate_pct: facts.note_rate_pct, else tape.current_rate_pct, else loan_record.note_rate_bps ÷ 100; written with three decimals.
- upb_cents: facts.upb_cents, else tape.principal_balance_cents. If it is not above 0, answer "not_reviewable" with ["no_upb"] and stop.
- pi_cents: facts.pi_cents, else the level payment of (facts.original_upb_cents, else loan_record.original_principal_cents) at note_rate_pct over original_term.
- regx_days_delinquent: the days from next_due_date to the tape's as_of date if next_due_date is before it, else 0. If that is 0 and facts.pay_string ends in 3, 6, 9 or F (any case), or facts.mba_delinquency_status is text that is a whole number above 0 or contains "late" or "delinq" (any case), it is 30. Both are read only as text. If tape.delinquency_days is larger than the result, it is tape.delinquency_days.
- value_estimate: consider facts.fmv_cents (dated facts.fmv_date) and facts.bpo_value_cents (dated facts.bpo_date), each only if above 0, each dated the tape's as_of date when its own date is absent; take the one with the later date, the FMV on a tie. If neither, facts.appraised_value_cents if above 0, dated facts.origination_date, else consummation_date. If none of the three, answer "not_reviewable" with ["no_value"] and stop. Its confidence is "medium" when its date is on or after (review date − 12 months), "low" otherwise.
- mi_status: "bpmi_active" if facts.pmi_flag is yes, else "none". mi_monthly_cents: with the flag yes and a PMI rate above 0, round(upb_cents × rate% ÷ 12), where the rate is facts.pmi_rate_pct, divided by 100 (to three decimals) when it is above 5, because then it is in basis points; otherwise 0.
- status: "active" if loan_record.state is "monitoring_only" or "active", otherwise "not_active".
- bankruptcy_active: facts.bk_status is yes; or facts.bk_filed_date is present, facts.bk_discharged is not yes, and facts.bk_dismissed_date is absent.
- foreclosure_referred: facts.fc_status is yes, or facts.fc_referral_date is present.
- lossmit_plan_active: facts.modification_flag is yes.
- transfer_out_pending: facts.servicing_status contains "transfer", "sold", or "service" and "released" joined by a space, an underscore, a hyphen or nothing, in any case.
- deceased_or_sii_pending and refi_do_not_solicit: false; the tape does not carry them.
- net_escrow_deposit_estimate_cents: 2 × facts.ti_cents when that is above 0, else 0.
- occupancy: from loan_record.occupancy, else facts.occupancy: "second_home" if it starts with "second", "investment" if it starts with "invest", otherwise "primary" (any case).
- property_state: loan_record.property_state, else facts.property_state.

Then review the row exactly as the rules below say.

`;

const ANSWER_ADDENDUM = `
For a loan the tape cannot describe (Step 0), submit verdict "not_reviewable" with its one reason code, offer null and watch_rate_pct null.
`;

export const TAPE_RULEBOOK = `${STEP_ZERO}${RULEBOOK}${ANSWER_ADDENDUM}`;
