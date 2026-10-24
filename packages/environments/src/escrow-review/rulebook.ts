/**
 * The rules a model is given, and graded against.
 *
 * escrow-analysis's rulebook from its conventions through Step 9, unchanged
 * (a test holds them), under a reviewer's opening; then Step 10, the
 * servicing app's anomaly triggers (spec §3.2 R10, `anomalies`,
 * apps/servicing/src/domain/escrow/analysis.ts:101-107) with the bill's
 * variance against last year added as the app's own
 * `compareBillToPriorYear` computes it (apps/servicing/src/app/tools/section03.ts:144),
 * and Step 11, whether the flag stands. The payment the new one is compared
 * with is the one billed today, the running shortage or credit spread in it,
 * as the servicing app compares it (`loan_terms.escrow_payment_cents`,
 * apps/servicing/src/domain/escrow/ops-3-6.ts:105-117); 1.0.0 handed the old
 * schedule's payment after the spread ran out. Change this text and the
 * environment's version changes with it.
 */

import { ESCROW_RULEBOOK } from "../escrow/rulebook.js";

/** escrow-analysis's conventions and Steps 1 to 9, word for word. */
export const ANALYSIS_STEPS = ESCROW_RULEBOOK.slice(
  ESCROW_RULEBOOK.indexOf("Conventions:"),
  ESCROW_RULEBOOK.indexOf("## Step 10. Anomalies"),
);

export const REVIEW_STEPS = `## Step 10. Anomalies

Besides the line anomalies of Step 1, compare new_payment with current_escrow_payment_cents, the escrow payment billed today: the escrow share of the next installment due, with any shortage or credit from last year's analysis still in it. The change is the difference either way:
- payment_change_gt_25pct: current_escrow_payment_cents is above 0 and the change × 100 is more than current_escrow_payment_cents × 25.
- payment_change_gt_150: the change is more than 15000.
- surplus_gt_2500: the decision is "refund" and the surplus is more than 250000.
- bill_variance_gt_20pct: a line's bills against last year. For each line that has known_bills and whose prior_year_annual_cents is above 0, its variance is floor(|the sum of its known bills' amount_cents − prior_year_annual_cents| × 10000 ÷ prior_year_annual_cents), in hundredths of a percent. Flag it once when any line's variance is more than 2000 (20 %). A line estimated from last year has no bill to compare, and is never flagged here.

## Step 11. The flag

The servicing app holds the analysis for anomaly review when Step 1 or Step 10 flagged anything. flag_stands is true when the anomalies list is not empty, and false when it is.

## Submitting

Call submit_review once with: annual_cents, base_payment_cents, target_at_start_cents, projected_actual_cents and decision; surplus_cents for refund, credit and retain; shortage_cents, deficiency_cents and repayment_months for a shortage; every one of those the decision does not have is null. Then new_payment_cents, effective_on, anomalies (every code flagged, in any order; an empty list if none) and flag_stands. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the review.
`;

export const REVIEW_RULEBOOK = `# Reviewing an annual escrow analysis

You review one escrowed mortgage loan's annual escrow analysis under RESPA (Regulation X §1024.17) before it is approved: you run it again from its inputs, find the shortage or surplus, the new monthly escrow payment, when it takes effect and how many months a shortage is spread over, and say whether the analysis is held for anomaly review, which it is when the payment or a bill moves too far or another trigger fires. The account's history comes with it, as the servicer's screen shows it: it explains what moved, and nothing in it changes the inputs. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

${ANALYSIS_STEPS}${REVIEW_STEPS}`;
