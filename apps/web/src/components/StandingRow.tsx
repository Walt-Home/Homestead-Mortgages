/**
 * One of a person's other files, as a row.
 *
 * The same resolver the card above it uses, rendered as one line instead of a
 * block — which is what makes "the shape does not change" true across a list
 * as well as across nineteen states. A row says what the file is called, what
 * state it is in, the state's own lead, and where to open it.
 *
 * What it deliberately does not carry is a control. A row has no file read
 * behind it, so it could never prove that a destination will render a payload,
 * and a label promising one off a row would be the drift the card's whole
 * payload rule exists to stop. There is one link and it names the destination.
 */

import { Link } from "react-router-dom";
import { StatusPill } from "./StatusPill.js";
import type { FileRow } from "../lib/file.js";
import { readOnly, screenFor, standingFor } from "../lib/home.js";
import { entryFor } from "../lib/states.js";
import { NO_APPLICATION } from "../lib/ledger.js";
import { OPEN_ROW, QUIET_LABELS } from "../lib/home-copy.js";

export function StandingRow({
  row,
  label,
  user,
}: {
  row: FileRow;
  /** What this file is called, made unique against everything rendering with it. */
  label: string;
  user: { persona: unknown } | null | undefined;
}) {
  // The row is what the resolver says about a file nothing has been read for,
  // which is exactly the `undefined` case: no clocks, no history, no control
  // that would need one.
  const { lead } = standingFor({ row, file: undefined, user });
  const screen = screenFor(row);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-rule-soft bg-ground p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-base font-medium text-ink">{label}</p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <StateBadge state={row.applicationState} />
          <span className="text-sm text-ink-soft">{lead}</span>
        </div>
      </div>
      {/*
        A sample file's link names what the reader will find rather than what
        the borrower would do with it. "Open" on somebody else's file asks a
        tester to take that borrower's next step, and the screen behind it
        would refuse the write anyway — so the demotion is a framing fix, and
        the destination is still one click away.
      */}
      <Link
        to={`/f/${row.id}/${screen}`}
        className={readOnly(row, user) ? "super-link-quiet shrink-0" : "super-link shrink-0"}
      >
        {readOnly(row, user) ? QUIET_LABELS[screen] : OPEN_ROW}
      </Link>
    </li>
  );
}

/**
 * A file's state at a glance, or the sentence for a file that has none.
 *
 * One component for the card's standing line and for a row, because it is one
 * claim: a file made before applications existed gets faint words and NO pill,
 * and painting "You've started" on it would invent a state nobody recorded.
 * Two copies of that rule is one of them eventually growing a badge.
 */
export function StateBadge({ state }: { state: FileRow["applicationState"] }) {
  if (!state) return <span className="text-xs text-ink-faint">{NO_APPLICATION}</span>;
  const entry = entryFor(state.status);
  return entry ? <StatusPill tone={entry.tone}>{entry.pill}</StatusPill> : null;
}
