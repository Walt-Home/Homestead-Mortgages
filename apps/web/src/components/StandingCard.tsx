/**
 * The one file this page is about, in one frame with five slots.
 *
 * The frame never changes; the slots do. Somebody who has read "Withdrawn at
 * your request" recognizes the shape when they meet "This one timed out", and
 * the difference lands in the words — which is where this product already did
 * the work. Nine layouts for nine situations is the failure this replaces, and
 * a card tinted by state would make five endings read as five alarms.
 *
 * The order is load-bearing in two places:
 *
 * 1. **The adverse-action clock renders ABOVE the body.** The regulated
 *    sentence ends by pointing at the due date, and that is a claim about
 *    layout: true on the review screen, and false on a card that carried the
 *    date underneath. The resolver supplies the other sentence when there is
 *    no clock at all, so the referent is always where the copy says.
 * 2. **The lead is the only h1, and the standing line below the hairline never
 *    repeats it.** For most states the lead IS the state's heading, so a
 *    standing row printing the heading again would say the same words twice on
 *    one card in two sizes.
 *
 * No figure of any kind reaches this card — not a loan amount, not a payment,
 * not a ratio. Every number on it is a date or a step index. Figures live on
 * the file's own screens, where a recorded derivation is behind each one.
 */

import { Link } from "react-router-dom";
import { RecentMoves } from "./RecentMoves.js";
import { StateBadge } from "./StandingRow.js";
import type { FileRow, LoanFileResponse } from "../lib/file.js";
import { NEW_APPLICATION, readOnly, type Standing } from "../lib/home.js";
import { SCREENS, reachedIndex, type BranchPath, type ScreenPath } from "../lib/flow.js";
import { CLOCK_COPY, timelineDate } from "../lib/ledger.js";
import {
  ECOA_ON_HOLD,
  ESTIMATE_ON_HOLD,
  QUIET_LABELS,
  QUIET_REASONS,
  READ_THE_REASONS,
  SAMPLE_FILE,
} from "../lib/home-copy.js";
import { PERSONA_READ_ONLY } from "../lib/auth.js";

export function StandingCard({
  row,
  standing,
  file,
  user,
  label,
}: {
  row: FileRow;
  standing: Standing;
  /** `undefined` while the file's own read is out, `null` for one that will not project. */
  file: LoanFileResponse | null | undefined;
  user: { persona: unknown } | null | undefined;
  /** What this file is called. Absent when it is the only file on the page. */
  label?: string;
}) {
  const view = file?.applicationState ?? null;
  const ecoa = view?.clocks.find((c) => c.kind === "ECOA_ADVERSE_ACTION_30D");
  const estimate = view?.loanEstimate;
  const step = standing.showStep ? reachedIndex(row.stage) : -1;

  return (
    <>
      {label && <p className="super-eyebrow mb-3">{label}</p>}

      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">{standing.lead}</h1>

        {standing.clockAbove === "ecoa" && ecoa && (
          <p className="mt-3 text-sm text-ink-muted">
            {CLOCK_COPY.adverseActionDue(timelineDate(ecoa.dueAt))}{" "}
            {/* The same gate the review screen uses: a clock that is running
                needs no explanation, and one that is not needs its own. */}
            {ecoa.tolledFrom !== null && ecoa.tolledUntil === null && ECOA_ON_HOLD}
          </p>
        )}

        <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{standing.body}</p>

        {standing.clockBelow === "estimate" && estimate && (
          <p className="mt-3 text-sm text-ink-muted">
            {CLOCK_COPY.loanEstimateDue(timelineDate(estimate.dueAt))}{" "}
            {estimate.tolled && CLOCK_COPY.loanEstimateOnHold}
          </p>
        )}
        {standing.clockBelow === "estimate-lapsed" && (
          <p className="mt-3 text-sm text-ink-muted">{ESTIMATE_ON_HOLD}</p>
        )}

        <ActionArea row={row} standing={standing} user={user} />

        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-rule-soft pt-5">
          <StateBadge state={row.applicationState} />
          {row.applicationState && (
            <span className="text-xs text-ink-faint">
              since {timelineDate(row.applicationState.statusEnteredAt)}
            </span>
          )}
          {/*
            A sentence, never the step indicator. A row of segments with one
            lit says "you are on this step right now", which is false on a page
            nobody is stepping through — and a progress bar on a dashboard acts
            on nothing. It is a POSITION: the stage only moves forward and
            cannot say anything was finished.
          */}
          {step >= 0 && (
            <span className="text-xs text-ink-faint">
              Step {step + 1} of {SCREENS.length} · {SCREENS[step]?.label}
            </span>
          )}
        </div>

        {standing.showHistory && view && <RecentMoves ledger={view.ledger} />}
        {standing.quiet && (
          <Link to={standing.quiet.to} className="super-link-quiet mt-3 inline-block text-sm">
            {standing.quiet.label}
          </Link>
        )}
      </div>
    </>
  );
}

/**
 * The control, or the sentence saying why there is none, or nothing at all.
 *
 * Three states rather than two. The third is for one card only — an approved
 * file whose own read has not landed — because both defaults are wrong for
 * somebody there: a primary button that appears and vanishes, or "nothing is
 * waiting on you" printed over the only intent control in the product. An
 * empty action area is acceptable for the length of one fetch and is not
 * acceptable as a resting state, which is why the resolver enumerates it.
 *
 * A sample borrower is refused two different ways and the difference matters.
 * Starting an application is the one thing the server genuinely says no to, so
 * that control is gone before it reaches here and the sentence stands in for
 * it. Everything else is a GET a tester may read, so the control is demoted to
 * a link naming what the destination shows — never disabled, because a
 * full-contrast button that explains why it cannot be pressed is the shape
 * this product already decided against.
 */
function ActionArea({
  row,
  standing,
  user,
}: {
  row: FileRow;
  standing: Standing;
  user: { persona: unknown } | null | undefined;
}) {
  if (standing.pending) return null;

  const locked = readOnly(row, user);
  const control = standing.control;
  // The start control is refused rather than demoted, and it is already gone
  // by the time this renders. Naming it here keeps a quiet label off it if it
  // ever arrives on a file somebody may not act on.
  const demote = locked && control !== null && control.to !== NEW_APPLICATION;
  const note = row.isDemo ? SAMPLE_FILE : PERSONA_READ_ONLY;

  if (!control && !standing.noControl) return null;

  return (
    <div className="mt-6 flex flex-col items-start gap-2">
      {control &&
        (demote ? (
          <Link to={control.to} className="super-link-quiet text-sm">
            {quietLabel(control)}
          </Link>
        ) : (
          <Link
            to={control.to}
            className={`super-btn ${control.weight === "primary" ? "super-btn-primary" : "super-btn-outline"}`}
          >
            {control.label}
          </Link>
        ))}
      {standing.noControl && <p className="text-sm text-ink-muted">{standing.noControl}</p>}
      {/*
        One refusal, said once, and only where a control changed shape because
        of it. A card with no control at all has nothing to explain — the
        resolver has already put the account's own sentence where the one
        refused control was, and the banner in the header makes the
        session-wide claim on every screen.
      */}
      {demote && <p className="text-sm text-ink-muted">{note}</p>}
    </div>
  );
}

/**
 * What a demoted control is called, keyed on where it goes.
 *
 * One generic sentence nineteen times over is exactly what makes eight sample
 * borrowers side by side unreadable, and that team is who this is for. The one
 * exception is the control that named the recorded reasons: its destination is
 * the review screen, whose general label says where the file stands, and a
 * tester who pressed it was looking for the reasons.
 */
function quietLabel(control: NonNullable<Standing["control"]>): string {
  if (control.label === READ_THE_REASONS) return QUIET_REASONS;
  const screen = control.to.split("/").pop() as ScreenPath | BranchPath;
  return QUIET_LABELS[screen];
}
