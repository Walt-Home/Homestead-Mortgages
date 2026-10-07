/**
 * How a charge is computed, and when the loans are analyzed — the two
 * sentences under a statement's figures, on our billing page and on the
 * servicer's. The numbers are the sheet's, read off the answer (`terms`),
 * never typed here; the cadence is the job's own schedule in words.
 */

import type { Cadence, MeterTerms } from "../lib/billing.js";

/** "a token is a cent", or the rate when it is not one. */
export function tokenPriceWords(terms: MeterTerms): string {
  const cents = Number(terms.tokenCents);
  if (cents === 1) return "a token is a cent";
  return `a token is ${cents.toLocaleString("en-US")}¢`;
}

export function ChargeExplainer({
  terms,
  cadence,
  running,
}: {
  terms: MeterTerms;
  cadence: Cadence;
  /** The month is still running: the figure counts through today. */
  running: boolean;
}) {
  const perYear = terms.tokensPer100kPerYear.toLocaleString("en-US");
  const perTouch = terms.touchTokens.toLocaleString("en-US");
  const monthly = terms.rows.filter((r) => r.cadence === "loan_month").length;
  const annual = terms.rows.filter((r) => r.cadence === "loan_year").length;
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-line-2 bg-surface-2 p-4 text-sm text-fg-2">
      <p>
        <span className="font-medium text-fg">How the charge is computed.</span> Each loan on the
        book consumes the standard servicing cycle, the {terms.rows.length} rows of the price
        sheet&rsquo;s section A listed on the statement below, which add to{" "}
        {terms.basisPointsPerYear} basis points a year on its interest-bearing unpaid principal
        balance ({perYear} tokens per $100,000 per loan-year). The {monthly} monthly rows are
        charged per loan-month and the {annual} annual rows a twelfth each month, on the balance the
        newest tape reports, pro-rated by calendar day from the day it is billed from until a tape
        reports it paid off, transferred, charged off or matured, plus {perTouch} tokens per offer
        touch. Every row is rounded once per loan, and the total is the sum of the rows;{" "}
        {tokenPriceWords(terms)}.{running ? " This month counts through today." : ""}
      </p>
      <p>
        <span className="font-medium text-fg">When the analysis runs.</span> Every loan on the book
        is reviewed {cadence.review.words}, and the charge accrues by calendar day whether or not a
        morning&rsquo;s review changes a verdict. The month is closed {cadence.billingClose.words},
        and the invoice is drawn from that statement.
      </p>
    </div>
  );
}
