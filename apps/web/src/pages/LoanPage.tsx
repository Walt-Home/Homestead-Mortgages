/**
 * `/loans/:loanId`: one mortgage, and the two things we know about it.
 *
 * The first section is the servicer's, dated: the newest observation the
 * tape wrote, rendered as figures because a recorded row stands behind each
 * one. The second is ours: what the servicing platform concluded when it
 * last compared this mortgage against the market, read live for this page.
 * The two never mix on one line — the balance is the tape's and the verdict
 * is the platform's, and a page that put them in one sentence would be
 * quoting two sources with two dates as one fact.
 *
 * The live half has four shapes and the page says which it is on. "We did
 * not ask" (the servicer is not wired that deep), "we asked and there is
 * nothing", "we asked and could not reach it" — with a retry, because that
 * one is about the network rather than the mortgage — and an answer. The
 * engine's reason codes, clock codes and event names never render; the
 * platform's own words for its reasons do.
 *
 * Read-only by construction: nothing on it writes, so a sample borrower and
 * the person it belongs to see the same page.
 */

import { Link, useParams } from "react-router-dom";
import { Figure } from "../components/Figure.js";
import { StatusPill } from "../components/StatusPill.js";
import { ApiError } from "../lib/api.js";
import {
  addressLine,
  calendarDate,
  dollars,
  loanEntry,
  ratePct,
  useLoanServicing,
  type LiveServicing,
  type ServicingObservation,
} from "../lib/loan.js";
import {
  BACK_TO_YOUR_MORTGAGES,
  BALANCE,
  DIFFERENCE_EACH_MONTH,
  IN_ESCROW,
  MONTHLY_PAYMENT,
  MORTGAGE_UNREAD_BODY,
  MORTGAGE_UNREAD_LEAD,
  NEXT_PAYMENT_DUE,
  NOT_HELD,
  NOT_REVIEWED_YET,
  NOT_YOUR_MORTGAGE_BODY,
  NOT_YOUR_MORTGAGE_LEAD,
  NO_TAPE_YET,
  PAYMENT_NOW,
  PAYMENT_THEN,
  RATE,
  RATE_NOW,
  RATE_THEN,
  READINESS,
  STANDING,
  UNREACHABLE,
  VERDICT,
  WATCHING,
  WHY,
  about,
  checkedOn,
  fromYourServicer,
  mortgageBody,
  mortgageLead,
  notWired,
  openUntil,
  readLiveAt,
  readinessItem,
  readinessStatus,
  standingWords,
} from "../lib/loan-copy.js";
import { FINDING_WHERE_YOU_STAND, TRY_AGAIN } from "../lib/home-copy.js";
import { timelineDate } from "../lib/ledger.js";

/** The same measure and gutter as the home page; the frame supplies neither. */
const CONTAINER = "mx-auto w-full max-w-2xl px-5 py-10 sm:px-6";

export function LoanPage() {
  const { loanId } = useParams();
  const read = useLoanServicing(loanId);

  if (read.isPending) {
    return (
      <div className={CONTAINER}>
        <p className="text-sm text-ink-faint">{FINDING_WHERE_YOU_STAND}</p>
      </div>
    );
  }

  if (read.isError) {
    // "Not yours" and "not there" are one answer on purpose, and it is not
    // the same answer as a read that failed: the first is about the link,
    // the second is about the network, and only the second is worth retrying.
    const gone = read.error instanceof ApiError && read.error.status === 404;
    return (
      <div className={CONTAINER}>
        <div className="super-card">
          <h1 className="font-display text-2xl text-ink sm:text-3xl">
            {gone ? NOT_YOUR_MORTGAGE_LEAD : MORTGAGE_UNREAD_LEAD}
          </h1>
          <p className="mt-3 max-w-measure-prose text-base text-ink-soft">
            {gone ? NOT_YOUR_MORTGAGE_BODY : MORTGAGE_UNREAD_BODY}
          </p>
          {gone ? (
            <Link to="/" className="super-link-quiet mt-6 inline-block text-sm">
              {BACK_TO_YOUR_MORTGAGES}
            </Link>
          ) : (
            <button
              className="super-btn super-btn-outline mt-6"
              onClick={() => void read.refetch()}
            >
              {TRY_AGAIN}
            </button>
          )}
        </div>
      </div>
    );
  }

  const { loan, servicer, observed, live } = read.data;
  const name = servicer?.displayName ?? null;
  const entry = loanEntry(loan.state);

  return (
    <div className={CONTAINER}>
      <p className="super-eyebrow mb-3">{addressLine(loan.property)}</p>
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">
          {mortgageLead(loan.state, name)}
        </h1>
        <p className="mt-3 max-w-measure-prose text-base text-ink-soft">
          {mortgageBody(loan.state, name)}
        </p>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-rule-soft pt-5">
          {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
          {(name || loan.servicerLoanNumber) && (
            <span className="text-xs text-ink-faint">
              {[name, loan.servicerLoanNumber].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="font-display text-base text-ink">
          {fromYourServicer(name, observed ? calendarDate(observed.asOf) : null)}
        </h2>
        {observed ? (
          <Observed observed={observed} />
        ) : (
          <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{NO_TAPE_YET}</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-base text-ink">{WATCHING}</h2>
        <Watching live={live} servicer={name} onRetry={() => void read.refetch()} />
      </section>
    </div>
  );
}

/** The tape's figures. A figure the tape did not carry is a dash, never a zero. */
function Observed({ observed }: { observed: ServicingObservation }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
      <Figure label={BALANCE} value={dollars(observed.principalBalanceCents)} />
      <Figure label={RATE} value={ratePct(observed.currentRatePct)} />
      <Figure label={NEXT_PAYMENT_DUE} value={calendarDate(observed.nextPaymentDueOn)} />
      <Figure label={MONTHLY_PAYMENT} value={dollars(observed.scheduledPaymentCents)} />
      {observed.escrowBalanceCents !== null && (
        <Figure label={IN_ESCROW} value={dollars(observed.escrowBalanceCents)} />
      )}
      <Figure label={STANDING} value={standingWords(observed.status, observed.delinquencyDays)} />
    </dl>
  );
}

function Watching({
  live,
  servicer,
  onRetry,
}: {
  live: LiveServicing;
  servicer: string | null;
  onRetry: () => void;
}) {
  switch (live.status) {
    case "not_wired":
      return (
        <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{notWired(servicer)}</p>
      );
    case "not_held":
      return <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{NOT_HELD}</p>;
    case "unavailable":
      return (
        <>
          <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{UNREACHABLE}</p>
          <button className="super-btn super-btn-outline mt-4" onClick={onRetry}>
            {TRY_AGAIN}
          </button>
        </>
      );
    case "fetched": {
      const { review, offer, readiness } = live.record;
      const words = review ? VERDICT[review.verdict] : null;
      return (
        <div className="mt-3">
          {review && words ? (
            <>
              <p className="text-lg text-ink">{words.lead}</p>
              <p className="mt-2 max-w-measure-prose text-base text-ink-soft">{words.body}</p>
              {review.reasonsInWords.length > 0 && (
                <>
                  <p className="mt-4 text-sm text-ink-faint">{WHY}</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
                    {review.reasonsInWords.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="mt-3 text-xs text-ink-faint">
                {checkedOn(calendarDate(review.asOf) ?? review.asOf)}
              </p>
            </>
          ) : (
            <p className="max-w-measure-prose text-base text-ink-soft">{NOT_REVIEWED_YET}</p>
          )}

          {offer && (
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-3">
              <Figure label={RATE_NOW} value={ratePct(offer.currentRatePct)} />
              <Figure
                label={RATE_THEN}
                value={ratePct(offer.offeredRatePct) && about(ratePct(offer.offeredRatePct)!)}
              />
              <Figure label={PAYMENT_NOW} value={dollars(offer.currentPiCents)} />
              <Figure
                label={PAYMENT_THEN}
                value={dollars(offer.offeredPiCents) && about(dollars(offer.offeredPiCents)!)}
                note={
                  offer.expiresOn
                    ? openUntil(calendarDate(offer.expiresOn) ?? offer.expiresOn)
                    : undefined
                }
              />
              <Figure
                label={DIFFERENCE_EACH_MONTH}
                value={dollars(offer.piDeltaCents) && about(dollars(offer.piDeltaCents)!)}
              />
            </dl>
          )}

          {readiness && readiness.items.length > 0 && (
            <>
              <p className="mt-6 text-sm text-ink-faint">{READINESS}</p>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-ink-soft">
                {readiness.items.map((i) => (
                  <li key={i.item}>
                    {readinessItem(i.item)} · {readinessStatus(i.status)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-4 text-xs text-ink-faint">
            {readLiveAt(timelineDate(live.retrievedAt))}
          </p>
        </div>
      );
    }
  }
}
