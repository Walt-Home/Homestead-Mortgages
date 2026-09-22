/**
 * A mortgage on the home page: the lead card when it is the only thing a
 * person has, a row when it sits under an application.
 *
 * The same frame the application's card uses, so a person who has read one
 * recognizes the other; the difference is in the words, and in what the one
 * control does — it opens the mortgage's own page, because a figure belongs
 * where the record behind it can be read. No balance and no rate reach the
 * home page, for the reason the application card carries none.
 */

import { Link } from "react-router-dom";
import { StatusPill } from "./StatusPill.js";
import { addressLine, loanEntry, type LoanRow } from "../lib/loan.js";
import { SEE_THIS_MORTGAGE, mortgageBody, mortgageLead } from "../lib/loan-copy.js";

export function MortgageLead({ loan }: { loan: LoanRow }) {
  const entry = loanEntry(loan.state);
  const servicer = loan.servicer?.displayName ?? null;
  return (
    <>
      <p className="super-eyebrow mb-3">{addressLine(loan.property)}</p>
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">
          {mortgageLead(loan.state, servicer)}
        </h1>
        <p className="mt-3 max-w-measure-prose text-base text-ink-soft">
          {mortgageBody(loan.state, servicer)}
        </p>
        <Link to={`/loans/${loan.id}`} className="super-btn super-btn-outline mt-6 inline-block">
          {SEE_THIS_MORTGAGE}
        </Link>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-rule-soft pt-5">
          {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
          <ServicerLine loan={loan} />
        </div>
      </div>
    </>
  );
}

export function MortgageRow({ loan }: { loan: LoanRow }) {
  const entry = loanEntry(loan.state);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-rule-soft bg-ground p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-base font-medium text-ink">{addressLine(loan.property)}</p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
          <ServicerLine loan={loan} />
        </div>
      </div>
      <Link to={`/loans/${loan.id}`} className="super-link shrink-0">
        {SEE_THIS_MORTGAGE}
      </Link>
    </li>
  );
}

/** Who services it and the number they know it by, in the small type beside the pill. */
function ServicerLine({ loan }: { loan: LoanRow }) {
  const parts = [loan.servicer?.displayName, loan.servicerLoanNumber].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="text-xs text-ink-faint">{parts.join(" · ")}</span>;
}
