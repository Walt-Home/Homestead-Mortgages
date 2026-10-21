/**
 * escrow-analysis's rulebook with a Step 0 in front: reading last year's
 * figures and the run-date balance off the ledger. Step 0 is `readHistory`
 * in words; Steps 1 to 10 are escrow-analysis's unchanged.
 */

import { ESCROW_RULEBOOK } from "../escrow/rulebook.js";

export const HISTORY_STEP_ZERO = `## Step 0. Reading the ledger

The lines here do not carry last year's figures, and the ledger does not carry its balance on the run date: you read both off the ledger first, and then follow Steps 1 to 10 exactly as written.

- Last year is the 12 months before year_start: from year_start minus 12 months, up to but not including year_start.
- A line's prior_disbursed_on is the dates of every ledger disbursement, posted or scheduled, whose line_type is that line's line_type and which falls in last year. Its prior_year_annual_cents is the sum of their amount_cents (0 when there are none). A disbursement in another year, or with no line_type, or with another line's, is not the line's, whatever its description says.
- ledger.balance_cents, the balance on as_of, is ledger.opened.balance_cents plus every posted deposit, minus every posted disbursement.
- In Step 6, the ledger's deposits and disbursements are its scheduled postings of each type. Posted ones are already in the balance.
`;

/** Step 0 is inserted before Step 1; everything else is escrow-analysis's. */
export const HISTORY_RULEBOOK = ESCROW_RULEBOOK.replace(
  "## Step 1. Each line's annual amount",
  `${HISTORY_STEP_ZERO}\n## Step 1. Each line's annual amount`,
);
