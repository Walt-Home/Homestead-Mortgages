/**
 * Five steps, and a count.
 *
 * The previous stepper rendered nine pills that wrapped to three rows on a
 * phone and named internal stages at the borrower. This one is a progress
 * line: which step you are on, out of how many, plus the ability to go back to
 * something you have finished.
 *
 * Conditional branches are deliberately absent. A borrower sent to confirm
 * their employer is still on step 4 of 5 — the branch is work inside a step,
 * not a step of its own, and showing it here would turn "five screens" into
 * "five screens, or seven, depending".
 */

import { Link } from "react-router-dom";
import clsx from "clsx";
import {
  SCREENS,
  reachedIndex,
  screenIndex,
  type FlowStage,
  type ScreenPath,
} from "../lib/flow.js";

export function Stepper({
  current,
  fileId,
  reached,
}: {
  current: ScreenPath;
  fileId?: string;
  reached?: FlowStage;
}) {
  const currentIndex = screenIndex(current);
  // No stage, nothing to go back to. Undefined is a file not yet read, and
  // a co-borrower's shell, which passes none on purpose: the stage is the
  // applicant's, and the screens behind the dots before their own are the
  // applicant's to edit. `reachedIndex(undefined)` answers 0 — the first
  // step — which would still have linked the property screen.
  const reachedAt = reached === undefined ? -1 : reachedIndex(reached);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <ol className="flex items-center gap-1.5">
        {SCREENS.map((screen, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
          // Only backwards, and only to somewhere already finished. A stepper
          // that lets you skip ahead is a stepper that lands you on a screen
          // whose data does not exist yet.
          const linkable = Boolean(fileId) && state === "done" && i <= reachedAt;

          const dot = (
            <span
              className={clsx(
                "block h-1.5 w-8 rounded-pill transition-colors sm:w-10",
                state === "done" && "bg-ok",
                state === "current" && "bg-accent",
                // `raised` is only a shade off the ground, which on a 1.5px
                // track reads as no dot at all — and a progress line that
                // hides its remaining steps stops being a progress line.
                state === "upcoming" && "bg-rule",
              )}
            />
          );

          return (
            <li key={screen.path} className="flex items-center">
              {linkable ? (
                <Link
                  to={`/f/${fileId}/${screen.path}`}
                  aria-label={`Back to ${screen.label}`}
                  className="block py-1"
                >
                  {dot}
                </Link>
              ) : (
                <span className="block py-1" aria-hidden="true">
                  {dot}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-ink-muted">
        Step {currentIndex + 1} of {SCREENS.length}
        <span className="text-ink-faint"> · {SCREENS[currentIndex]?.label}</span>
      </p>
    </div>
  );
}
