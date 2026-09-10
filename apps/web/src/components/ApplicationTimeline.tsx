/**
 * Everything that has happened to this application, in order.
 *
 * The ledger is already the record an examiner reads; this renders the same
 * rows for the person they happened to. Oldest first, because a history reads
 * downward, and the newest line is the one nearest what the screen is asking
 * for next.
 *
 * What never reaches the DOM here: an event name, a reason code, a principal
 * id, a requirement id. `wordsFor` and `actorWords` are the whole translation
 * and a test renders this component to prove none of them leak.
 *
 * Below the moves, the clocks. A tolled clock is rendered as both halves — the
 * date and why it is not running — because either half alone is a lie: the
 * date without the toll promises a delivery nothing in this repo can make, and
 * the toll without the date hides a deadline a person is entitled to know.
 */

import { StatusPill } from "./StatusPill.js";
import type { ApplicationStandingView } from "../lib/file.js";
import { entryFor } from "../lib/states.js";
import { pastDeciding } from "../lib/endings.js";
import { CLOCK_COPY, actorWords, timelineDate, wordsFor } from "../lib/ledger.js";

/**
 * `undefined` is the file not loaded yet and `null` is a file with no
 * application on record — the same three-state value the standing above this
 * reads. Collapsing them here would make the two disagree about what an empty
 * history means in the one expression that renders both.
 */
export function ApplicationTimeline({
  standing,
}: {
  standing: ApplicationStandingView | null | undefined;
}) {
  if (!standing || standing.ledger.length === 0) return null;

  const ecoa = standing.clocks.find((c) => c.kind === "ECOA_ADVERSE_ACTION_30D");

  return (
    <section className="mt-8 border-t border-rule-soft pt-6">
      <h2 className="font-display text-lg text-ink">What has happened so far</h2>

      <ol className="mt-4 flex flex-col gap-3">
        {standing.ledger.map((row) => {
          const entry = entryFor(row.to);
          return (
            <li key={row.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-ink-faint">{timelineDate(row.occurredAt)}</span>
              {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
              <span className="text-sm text-ink-soft">
                {wordsFor(row.event, row.reasonCode, row.to)}
              </span>
              <span className="text-xs text-ink-faint">{actorWords(row.actorKind)}</span>
            </li>
          );
        })}
      </ol>

      {/*
        The estimate's clock, only while there is still something to decide.
        The clock row survives the end of an application — it is a regulated
        record and nothing deletes it — so this block rendered on a funded
        loan, a withdrawn file and a denial alike, promising each of them a
        document by a date, under a pill that had already said it was over.
      */}
      {standing.loanEstimate && !pastDeciding(standing) && (
        <p className="mt-5 text-sm text-ink-muted">
          {CLOCK_COPY.loanEstimateDue(timelineDate(standing.loanEstimate.dueAt))}{" "}
          {standing.loanEstimate.tolled && CLOCK_COPY.loanEstimateOnHold}
        </p>
      )}

      {ecoa && (
        <p className="mt-3 text-sm text-ink-muted">
          {CLOCK_COPY.adverseActionDue(timelineDate(ecoa.dueAt))}{" "}
          {ecoa.tolledFrom !== null && ecoa.tolledUntil === null && CLOCK_COPY.adverseActionOnHold}
        </p>
      )}
    </section>
  );
}
