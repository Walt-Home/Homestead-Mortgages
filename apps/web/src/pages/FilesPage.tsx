/**
 * The front door, and now the marketing page.
 *
 * It used to be a file manager, then a pitch in a text column. It is now
 * Doug's front page from supermortgage.com: the promise in Georgia on solid
 * black, one white button, and the street underneath. See docs/brand.md.
 *
 * The headline is the prototype's, verbatim. The ACTIONS are not, and cannot
 * be — the prototype offers a waitlist to a stranger, and everybody who
 * reaches this page has already signed in and can start an application right
 * now. So the layout, type and scene match, and the button says what it does.
 *
 * The file lists stay, demoted to below the scene. They are where a person
 * comes back to, and where the team's shared sample borrowers live; losing
 * them would mean arranging a UUID by hand again.
 */

import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { HomeHero } from "../components/HomeHero.js";
import { StatusPill } from "../components/StatusPill.js";
import { StreetScene } from "../components/StreetScene.js";
import { entryFor } from "../lib/states.js";
import type { FileRow } from "../lib/file.js";
import { NO_APPLICATION, timelineDate } from "../lib/ledger.js";
import { canStart, screenFor } from "../lib/home.js";

/**
 * The row shape and the two rules this page used to declare.
 *
 * They moved to the lib when the resolver that joins a state to a screen
 * needed them, and they are re-exported here because a rule the front door
 * depends on should still be something a test of the front door can hold.
 */
export type { FileRow };
export { canStart, screenFor };

/**
 * The file to offer to pick up, if there is one.
 *
 * When there is an application, it is the whole answer. It knows things the
 * stage cannot: a withdrawn or declined file sits at whatever screen it
 * reached, because a stage only ever moves forward, and it also knows a file
 * is still live after the borrower walked to the end of the flow — a
 * submitted file is not finished with, it is waiting on us, and it is where
 * they should land when they come back.
 *
 * The stage is the fallback, and only that: it is all a file made before
 * applications existed can say about itself.
 */
export function resumable(files: readonly FileRow[]): FileRow | undefined {
  return files.find((f) =>
    f.applicationState ? !f.applicationState.terminal : f.stage !== "complete",
  );
}

export function FilesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["files"],
    queryFn: () => api.get<{ files: FileRow[] }>("/files"),
  });

  const files = data?.files ?? [];
  const mine = files.filter((f) => f.mine);
  const demos = files.filter((f) => f.isDemo && !f.mine);
  const inProgress = resumable(mine);

  return (
    <>
      <HomeHero>
        {canStart(user) && (
          <button className="super-cta" onClick={() => navigate("/f/new/property")}>
            {inProgress ? "Start another" : "Start now"}
          </button>
        )}

        {inProgress && (
          <Link
            className="super-link-cta text-base"
            to={`/f/${inProgress.id}/${screenFor(inProgress)}`}
          >
            {/*
              "Or" only when there is a button above it to be an alternative
              to. A sample borrower cannot start a file, so this link is the
              whole of what the page offers them, and an "Or" there points at
              nothing.
            */}
            {canStart(user) ? "Or pick up" : "Pick up"} the one you started
            {inProgress.propertyCity ? ` in ${inProgress.propertyCity}` : ""}
            {inProgress.propertyState ? `, ${inProgress.propertyState}` : ""}
          </Link>
        )}
      </HomeHero>

      <StreetScene />

      {/*
        Below the scene, so the marketing page ends at the street and the
        lists do not sit inside it.
      */}
      {(isLoading || mine.length > 0 || demos.length > 0) && (
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-5 pt-8 sm:px-6">
          {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}
          {mine.length > 0 && <FileList title="Yours" files={mine} />}
          {demos.length > 0 && <FileList title="Sample borrowers" files={demos} />}
        </div>
      )}
    </>
  );
}

function FileList({ title, files }: { title: string; files: readonly FileRow[] }) {
  return (
    <details>
      <summary className="super-link-quiet cursor-pointer list-none text-xs">
        {title} ({files.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Link className="super-link text-sm" to={`/f/${f.id}/${screenFor(f)}`}>
              {f.borrowers[0] ? `${f.borrowers[0].firstName} ${f.borrowers[0].lastName}` : "A file"}
              {f.propertyCity ? ` — ${f.propertyCity}, ${f.propertyState}` : ""}
            </Link>
            <Standing state={f.applicationState} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A row's pill, or the sentence for a file that has no application.
 *
 * A file created before applications existed gets a plain, faint line rather
 * than a pill. "You've started" over a file that finished months ago would be
 * the list inventing a state nobody recorded.
 */
export function Standing({ state }: { state: FileRow["applicationState"] }) {
  if (!state) return <span className="text-xs text-ink-faint">{NO_APPLICATION}</span>;
  const entry = entryFor(state.status);
  return (
    <>
      {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
      <span className="text-xs text-ink-faint">since {timelineDate(state.statusEnteredAt)}</span>
    </>
  );
}
