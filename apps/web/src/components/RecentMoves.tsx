/**
 * The last three things that happened to one application.
 *
 * It is the one thing on the home page that tells competence from silence. A
 * file with us says "nothing is needed from you right now" and then says the
 * same thing tomorrow, because nothing about it changed — and three dated rows
 * saying the application was received, the bank was connected and it was sent
 * for a decision are the difference between a product working and a product
 * that has forgotten.
 *
 * The full history is a screen of its own, and this is deliberately not it: no
 * clocks, no pagination, no promise. The card above renders the clocks once,
 * and a link beside this goes to the record.
 *
 * What never reaches the DOM: an event name, a reason code, a principal id, a
 * requirement id. `wordsFor` and `actorWords` are the whole translation, the
 * same two the timeline uses, and a test renders this to prove none of them
 * leak.
 */

import { StatusPill } from "./StatusPill.js";
import type { ApplicationStandingView } from "../lib/file.js";
import { entryFor } from "../lib/states.js";
import { actorWords, timelineDate, wordsFor } from "../lib/ledger.js";
import { RECENT_MOVES } from "../lib/home-copy.js";

/** How many of them. Three is what fits under a card without becoming the card. */
const SHOWN = 3;

export function RecentMoves({ ledger }: { ledger: ApplicationStandingView["ledger"] }) {
  if (ledger.length === 0) return null;

  // Newest first, which is the other way round from the timeline. A history
  // read from the top reads downward; a card is read from the top for what is
  // true NOW, and the newest move is the one nearest the thing the card is
  // saying about the file.
  const moves = ledger.slice(-SHOWN).reverse();

  return (
    <section className="mt-6 border-t border-rule-soft pt-5">
      <h2 className="font-display text-base text-ink">{RECENT_MOVES}</h2>

      <ol className="mt-3 flex flex-col gap-2">
        {moves.map((move) => {
          const entry = entryFor(move.to);
          return (
            <li key={move.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-ink-faint">{timelineDate(move.occurredAt)}</span>
              {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
              <span className="text-sm text-ink-soft">
                {wordsFor(move.event, move.reasonCode, move.to)}
              </span>
              <span className="text-xs text-ink-faint">{actorWords(move.actorKind)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
