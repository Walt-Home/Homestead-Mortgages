/**
 * Where this file stands, in the header of every screen.
 *
 * One pill, when it entered that state, and one line of words. The pill's tone
 * comes from the catalog and becomes a class only inside `StatusPill`, which
 * is still the one place a tone becomes a color.
 *
 * A file with no application says so and shows NO pill. That is deliberate: a
 * file made before the join has none, and painting it "You've started" would
 * tell somebody whose file was decided months ago that they had just begun.
 * Faint ink, one sentence, no badge.
 */

import { StatusPill } from "./StatusPill.js";
import type { ApplicationStandingView } from "../lib/file.js";
import { entryFor } from "../lib/states.js";
import { NO_APPLICATION, timelineDate, wordsFor } from "../lib/ledger.js";

export function ApplicationStanding({
  standing,
}: {
  standing: ApplicationStandingView | null | undefined;
}) {
  // Undefined is "not read yet", null is "read, and there is none". Collapsing
  // the two painted "No application on record" on every cold load of a file
  // page, and permanently whenever the read failed for any reason but a 404 —
  // a claim about a regulated record, made before the record was looked at.
  if (standing === undefined) return null;
  if (!standing) return <p className="text-xs text-ink-faint">{NO_APPLICATION}</p>;

  const entry = entryFor(standing.status);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
      <span className="text-sm text-ink-soft">{headline(standing)}</span>
      <span className="text-xs text-ink-faint">since {timelineDate(standing.statusEnteredAt)}</span>
    </div>
  );
}

/**
 * The line beside the pill.
 *
 * For a file waiting on the borrower it comes from the LEDGER rather than from
 * the catalog: the state's own heading is a worked example written for the
 * gallery, and the newest `borrower_owes` row says which specific thing is
 * outstanding. Everywhere else the state's heading is exactly right, because
 * there is nothing more specific to say.
 */
function headline(standing: ApplicationStandingView): string {
  if (standing.status === "awaiting_borrower") {
    const owed = [...standing.ledger].reverse().find((row) => row.event === "borrower_owes");
    if (owed) return wordsFor(owed.event, owed.reasonCode, owed.to);
  }
  return entryFor(standing.status)?.heading ?? "";
}
