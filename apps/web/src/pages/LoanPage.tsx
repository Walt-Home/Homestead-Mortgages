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
 * Above both, when there is one, the offer: the day's candidate made into
 * something the person can answer. Its figures are the review's benefit
 * disclosure, copied once; the analyst's sentence under it is the model's
 * words with the engine's figures filled in; the checklist beside it is our
 * own requirement engine run dry over a file born from this loan. Three
 * answers: yes asks for the one thing screen 1 needs that no tape knows —
 * income — then opens the refinance in our five screens and lands on
 * screen 2; not now and never end the offer and change tomorrow's review.
 *
 * Read-only otherwise: nothing else on it writes, so a sample borrower and
 * the person it belongs to see the same page, and the sample borrower's
 * answer is refused in the words every screen uses for that.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Figure } from "../components/Figure.js";
import { StatusPill } from "../components/StatusPill.js";
import { api, ApiError } from "../lib/api.js";
import { PERSONA_READ_ONLY } from "../lib/auth.js";
import { SCREENS, STAGE_TO_SCREEN, type FlowStage } from "../lib/flow.js";
import {
  addressLine,
  answerOffer,
  calendarDate,
  dollars,
  loanEntry,
  ratePct,
  useLoanServicing,
  type LiveServicing,
  type LoanReviewWire,
  type OfferAnswer,
  type RefiOfferWire,
  type RefinanceReadinessWire,
  type ServicingObservation,
} from "../lib/loan.js";
import {
  ANSWERING,
  BACK_TO_YOUR_MORTGAGES,
  BALANCE,
  CONTINUE_THAT_APPLICATION,
  DIFFERENCE_EACH_MONTH,
  IN_ESCROW,
  IN_PLAIN_WORDS,
  KEEP_ASKING,
  MONTHLY_INCOME,
  MONTHLY_PAYMENT,
  MORTGAGE_UNREAD_BODY,
  MORTGAGE_UNREAD_LEAD,
  NEVER_ASK,
  NEVER_CONFIRM_BODY,
  NEVER_CONFIRM_LEAD,
  NEW_LOAN_AMOUNT,
  NEW_TERM,
  NEXT_PAYMENT_DUE,
  NOT_CHECKED_BODY,
  NOT_CHECKED_HERE,
  NOT_HELD,
  NOT_NOW,
  NOT_REVIEWED_YET,
  NOT_YOUR_MORTGAGE_BODY,
  NOT_YOUR_MORTGAGE_LEAD,
  NO_TAPE_YET,
  OFFER_BODY,
  OFFER_LEAD,
  OUR_READINESS,
  OUR_READINESS_BODY,
  PAYMENT_NOW,
  PAYMENT_THEN,
  PLATFORM_SAYS,
  RATE,
  RATE_NOW,
  RATE_THEN,
  READINESS,
  SAME_TERM_PAYMENT,
  SCREEN_READINESS,
  STANDING,
  START_THE_REFINANCE,
  STILL_NEEDED,
  UNMAPPED_WORDS,
  UNREACHABLE,
  VERDICT,
  WATCHING,
  WE_HAVE_IT,
  WHY,
  YES_BODY,
  YES_LEAD,
  YES_LOOK,
  YES_STOP_ASKING,
  about,
  checkedOn,
  fromYourServicer,
  mortgageBody,
  mortgageLead,
  notWired,
  offerAnswered,
  offerOpenUntil,
  openUntil,
  readLiveAt,
  readinessItem,
  readinessStatus,
  reviewedOn,
  standingWords,
  watchRateLine,
  yearsWords,
} from "../lib/loan-copy.js";
import { FINDING_WHERE_YOU_STAND, TRY_AGAIN } from "../lib/home-copy.js";
import { timelineDate } from "../lib/ledger.js";

/** The same measure and gutter as the home page; the frame supplies neither. */
const CONTAINER = "mx-auto w-full max-w-2xl px-5 py-10 sm:px-6";

/** The engine's costs statement is a clause; on a card it is a sentence. */
const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

/**
 * What an answer's refusal says. A sample borrower's session is refused in
 * the words every screen uses for that; a closed offer and any other
 * refusal the server names come through in its own sentence, which is
 * written for the person; a read that failed is the network's.
 */
function refusalWords(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "PERSONA_READ_ONLY") return PERSONA_READ_ONLY;
    return err.message;
  }
  return MORTGAGE_UNREAD_BODY;
}

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

  const { loan, servicer, observed, live, review, offer, readiness } = read.data;
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

      {/*
        The offer, while it stands: the one thing on this page the person
        can act on. After an answer, what they said, in a line.
      */}
      {offer && offer.status === "offered" && (
        <OfferCard
          loanId={loan.id}
          offer={offer}
          analyst={review?.analyst ?? null}
          readiness={readiness}
        />
      )}
      {offer && offer.status !== "offered" && <AnsweredOffer offer={offer} />}

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

      {/*
        Ours, when it exists: the ported engine's verdict over the tape's
        newest observation and today's sheet. The platform's own reading
        then sits under its own heading, never blended — two engines, two
        dates — and stands in for ours until the first review has run.
      */}
      <section className="mt-8">
        <h2 className="font-display text-base text-ink">{WATCHING}</h2>
        {review ? (
          <OurReview review={review} offerOpen={offer?.status === "offered"} />
        ) : (
          <Watching live={live} servicer={name} onRetry={() => void read.refetch()} />
        )}
      </section>
      {review && live.status !== "not_wired" && (
        <section className="mt-8">
          <h2 className="font-display text-base text-ink">{PLATFORM_SAYS}</h2>
          <Watching live={live} servicer={name} onRetry={() => void read.refetch()} />
        </section>
      )}
    </div>
  );
}

/** The offer's figures: the review's benefit disclosure, as a person reads it. */
function OfferFigures({ offer }: { offer: RefiOfferWire }) {
  const d = offer.disclosure;
  return (
    <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-3">
      <Figure label={RATE_NOW} value={ratePct(d.current_rate_pct)} />
      <Figure
        label={RATE_THEN}
        value={ratePct(d.new_rate_pct) && about(ratePct(d.new_rate_pct)!)}
      />
      <Figure label={PAYMENT_NOW} value={dollars(d.current_pi_cents)} />
      <Figure
        label={PAYMENT_THEN}
        value={dollars(d.new_pi_cents) && about(dollars(d.new_pi_cents)!)}
      />
      <Figure
        label={DIFFERENCE_EACH_MONTH}
        value={dollars(d.pi_delta_cents) && about(dollars(d.pi_delta_cents)!)}
      />
      <Figure
        label={NEW_LOAN_AMOUNT}
        value={dollars(d.loan_amount_cents) && about(dollars(d.loan_amount_cents)!)}
        note={`${NEW_TERM}: ${yearsWords(d.new_term_months)}`}
      />
      <Figure
        label={SAME_TERM_PAYMENT}
        value={dollars(d.same_term_pi_cents) && about(dollars(d.same_term_pi_cents)!)}
      />
    </dl>
  );
}

/**
 * What our engine would still ask for: the five screens, each either
 * answered from the servicer's records or still the person's to do. The
 * engine's screen names are folded onto the five the flow shows, the way
 * every other screen of the app folds them.
 */
function OurReadiness({ readiness }: { readiness: RefinanceReadinessWire }) {
  const pending = new Set(
    readiness.byScreen
      .filter((s) => s.outstanding > 0)
      .map((s) => STAGE_TO_SCREEN[s.screen as FlowStage])
      .filter(Boolean),
  );
  return (
    <div className="mt-6 border-t border-rule-soft pt-5">
      <p className="text-sm text-ink-faint">{OUR_READINESS}</p>
      <p className="mt-1 max-w-measure-prose text-sm text-ink-soft">{OUR_READINESS_BODY}</p>
      <ul className="mt-3 flex flex-col gap-1 text-sm text-ink-soft">
        {SCREENS.map((s) => (
          <li key={s.path}>
            {SCREEN_READINESS[s.path] ?? s.label} ·{" "}
            <span className={pending.has(s.path) ? "text-ink" : "text-ink-faint"}>
              {pending.has(s.path) ? STILL_NEEDED : WE_HAVE_IT}
            </span>
          </li>
        ))}
      </ul>
      {readiness.unmapped.length > 0 && (
        <>
          <p className="mt-4 text-sm text-ink-faint">{NOT_CHECKED_HERE}</p>
          <p className="mt-1 max-w-measure-prose text-xs text-ink-muted">{NOT_CHECKED_BODY}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {readiness.unmapped.map((u) => UNMAPPED_WORDS[u] ?? u.replace(/_/g, " ")).join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}

function OfferCard({
  loanId,
  offer,
  analyst,
  readiness,
}: {
  loanId: string;
  offer: RefiOfferWire;
  analyst: LoanReviewWire["analyst"];
  readiness: RefinanceReadinessWire | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"idle" | "yes" | "never">("idle");
  const [income, setIncome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const incomeNum = Number(income);

  const answer = useMutation({
    mutationFn: (body: { answer: OfferAnswer; statedMonthlyIncome?: number }) =>
      answerOffer(loanId, offer.id, body),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["loan", loanId, "servicing"] });
      await queryClient.invalidateQueries({ queryKey: ["loans"] });
      if (result.answer !== "yes") return;
      await queryClient.invalidateQueries({ queryKey: ["files"] });
      // The county record, exactly as screen 1 asks for it after its save:
      // best effort, and never something the person waits on.
      api.post(`/files/${result.fileId}/property-data`, {}).catch(() => undefined);
      // Screen 1 hands screen 2 the income on router state; so does this.
      // The person as the servicer named them comes back too, and screen 2
      // does not take it: it establishes who somebody is from their ID, and
      // a servicer's spelling of a name is not that.
      navigate(`/f/${result.fileId}/identity`, { state: { income: incomeNum } });
    },
    onError: (err) => setError(refusalWords(err)),
  });
  const busy = answer.isPending;

  return (
    <section className="mt-8">
      <div className="super-card">
        <h2 className="font-display text-xl text-ink sm:text-2xl">{OFFER_LEAD}</h2>
        <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{OFFER_BODY}</p>
        <OfferFigures offer={offer} />
        {offer.disclosure.costs_statement && (
          <p className="mt-4 max-w-measure-prose text-xs text-ink-muted">
            {sentence(offer.disclosure.costs_statement)}
          </p>
        )}
        {analyst && (
          <>
            <p className="mt-5 text-sm text-ink-faint">{IN_PLAIN_WORDS}</p>
            <p className="mt-1 max-w-measure-prose text-base text-ink">{analyst.rationale}</p>
          </>
        )}
        <p className="mt-4 text-xs text-ink-faint">
          {offer.validUntil
            ? offerOpenUntil(calendarDate(offer.validUntil.slice(0, 10)) ?? offer.validUntil)
            : null}
        </p>

        {readiness && <OurReadiness readiness={readiness} />}

        {mode === "idle" && (
          <div className="mt-6 flex flex-wrap gap-3 border-t border-rule-soft pt-5">
            <button
              type="button"
              className="super-btn super-btn-primary"
              onClick={() => {
                setError(null);
                setMode("yes");
              }}
              disabled={busy}
            >
              {YES_LOOK}
            </button>
            <button
              type="button"
              className="super-btn super-btn-outline"
              onClick={() => {
                setError(null);
                answer.mutate({ answer: "not_now" });
              }}
              disabled={busy}
            >
              {NOT_NOW}
            </button>
            <button
              type="button"
              className="super-link-quiet self-center text-sm"
              onClick={() => {
                setError(null);
                setMode("never");
              }}
              disabled={busy}
            >
              {NEVER_ASK}
            </button>
          </div>
        )}

        {mode === "yes" && (
          <form
            className="mt-6 border-t border-rule-soft pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!(incomeNum > 0)) return;
              setError(null);
              answer.mutate({ answer: "yes", statedMonthlyIncome: incomeNum });
            }}
          >
            <p className="text-lg text-ink">{YES_LEAD}</p>
            <p className="mt-2 max-w-measure-prose text-base text-ink-soft">{YES_BODY}</p>
            <label className="super-label mt-4 block" htmlFor="offer-income">
              {MONTHLY_INCOME}
            </label>
            <input
              id="offer-income"
              className="super-input mt-1 max-w-xs"
              type="number"
              inputMode="decimal"
              min={1}
              step={1}
              value={income}
              onChange={(e) => setIncome(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="submit"
                className="super-btn super-btn-primary"
                disabled={busy || !(incomeNum > 0)}
              >
                {busy ? ANSWERING : START_THE_REFINANCE}
              </button>
              <button
                type="button"
                className="super-btn super-btn-outline"
                onClick={() => setMode("idle")}
                disabled={busy}
              >
                {NOT_NOW}
              </button>
            </div>
          </form>
        )}

        {mode === "never" && (
          <div className="mt-6 border-t border-rule-soft pt-5">
            <p className="text-lg text-ink">{NEVER_CONFIRM_LEAD}</p>
            <p className="mt-2 max-w-measure-prose text-base text-ink-soft">{NEVER_CONFIRM_BODY}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="super-btn super-btn-outline"
                onClick={() => {
                  setError(null);
                  answer.mutate({ answer: "never" });
                }}
                disabled={busy}
              >
                {busy ? ANSWERING : YES_STOP_ASKING}
              </button>
              <button
                type="button"
                className="super-btn super-btn-primary"
                onClick={() => setMode("idle")}
                disabled={busy}
              >
                {KEEP_ASKING}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** After the answer: what was said, and for a yes, the way back to the application. */
function AnsweredOffer({ offer }: { offer: RefiOfferWire }) {
  if (offer.status === "offered") return null;
  const day =
    offer.status === "expired"
      ? calendarDate(offer.validUntil?.slice(0, 10))
      : calendarDate(offer.answeredAt?.slice(0, 10));
  const words = offerAnswered(offer.status, day);
  return (
    <section className="mt-8">
      <p className="text-lg text-ink">{words.lead}</p>
      <p className="mt-2 max-w-measure-prose text-base text-ink-soft">{words.body}</p>
      {offer.status === "engaged" && offer.applicationFileId && (
        <Link
          to={`/f/${offer.applicationFileId}`}
          className="super-btn super-btn-primary mt-4 inline-block"
        >
          {CONTINUE_THAT_APPLICATION}
        </Link>
      )}
    </section>
  );
}

/** Our review: the verdict in words, the engine's reasons in its words, and the figures a candidate carries. */
function OurReview({ review, offerOpen }: { review: LoanReviewWire; offerOpen: boolean }) {
  const words = VERDICT[review.verdict];
  const offer = review.offer;
  return (
    <div className="mt-3">
      <p className="text-lg text-ink">{words.lead}</p>
      <p className="mt-2 max-w-measure-prose text-base text-ink-soft">{words.body}</p>
      {review.reasonsInWords.length > 0 && (
        <>
          <p className="mt-4 text-sm text-ink-faint">{WHY}</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
            {review.reasonsInWords.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </>
      )}
      {/* The analyst's sentence sits on the offer card while one is open; here otherwise. */}
      {review.analyst && !offerOpen && (
        <>
          <p className="mt-4 text-sm text-ink-faint">{IN_PLAIN_WORDS}</p>
          <p className="mt-1 max-w-measure-prose text-base text-ink">{review.analyst.rationale}</p>
        </>
      )}
      {review.verdict === "watching" && review.facts.watch_rate_pct && (
        <p className="mt-3 max-w-measure-prose text-sm text-ink-soft">
          {watchRateLine(ratePct(review.facts.watch_rate_pct) ?? review.facts.watch_rate_pct)}
        </p>
      )}
      {offer && !offerOpen && (
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-3">
          <Figure label={RATE_NOW} value={ratePct(offer.current_rate_pct)} />
          <Figure
            label={RATE_THEN}
            value={ratePct(offer.new_rate_pct) && about(ratePct(offer.new_rate_pct)!)}
          />
          <Figure label={PAYMENT_NOW} value={dollars(offer.current_pi_cents)} />
          <Figure
            label={PAYMENT_THEN}
            value={dollars(offer.new_pi_cents) && about(dollars(offer.new_pi_cents)!)}
          />
          <Figure
            label={DIFFERENCE_EACH_MONTH}
            value={dollars(offer.pi_delta_cents) && about(dollars(offer.pi_delta_cents)!)}
          />
          <Figure
            label={SAME_TERM_PAYMENT}
            value={dollars(offer.same_term_pi_cents) && about(dollars(offer.same_term_pi_cents)!)}
          />
        </dl>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        {reviewedOn(calendarDate(review.asOf) ?? review.asOf)}
      </p>
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
