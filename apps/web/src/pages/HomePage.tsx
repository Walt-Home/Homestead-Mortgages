/**
 * `/` for somebody who is signed in: their own application, not a pitch.
 *
 * This product has no delivery channel — no mailer, no SMTP, no SMS — so every
 * honest sentence in it ends the same way: the answer will be here on this
 * page. Those are promises only a page a person returns to can keep, and until
 * now that page was the marketing hero with the file underneath it as a
 * collapsed summary in the smallest type on the screen. **This page is the
 * delivery mechanism the copy already assumed existed**, which is why it is
 * designed around the borrower who has nothing to do — declined, held, timed
 * out, or sitting at "In review" on day three — and why the draft resuming in
 * one click falls out of it rather than driving it.
 *
 * It makes two requests and neither is new. `GET /files` carries every row,
 * including what each one is waiting on; `GET /files/:id` is made for the
 * primary file only and shares its key with the file screens, so opening one
 * costs nothing. There is no assessment fetch: the list already names all
 * three branches, so the 77 requirements are not evaluated to draw this.
 *
 * Everything it says comes out of `lib/home.ts`, which is pure and tested on
 * its own. What is decided here is only what a page decides: which file the
 * card is about, what the others are called, and which of the four shapes —
 * loading, a failed read, a person with no application, a person with one —
 * is on screen.
 */

import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { StandingCard } from "../components/StandingCard.js";
import { StandingRow } from "../components/StandingRow.js";
import { api } from "../lib/api.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import { useLoanFile, type FileRow } from "../lib/file.js";
import { NEW_APPLICATION, canStart, rankFiles, standingFor } from "../lib/home.js";
import {
  CLOSED_FILES,
  FINDING_WHERE_YOU_STAND,
  OTHER_APPLICATIONS,
  SAMPLE_BORROWERS,
  START_ANOTHER,
  START_BODY,
  START_LEAD,
  START_NOW,
  TRY_AGAIN,
  UNREAD_BODY,
  UNREAD_LEAD,
} from "../lib/home-copy.js";

/**
 * Its own container, because the frame does not supply one.
 *
 * `Chrome` renders a bare flex column so that the hero and the street can be
 * full-bleed, which means a page that assumed a measure and a gutter would
 * ship a card touching both edges of a phone. The width is the one every other
 * text surface in the app uses.
 */
const CONTAINER = "mx-auto w-full max-w-2xl px-5 py-10 sm:px-6";

export function HomePage() {
  const { user } = useAuth();
  const list = useQuery({
    queryKey: ["files"],
    queryFn: () => api.get<{ files: FileRow[] }>("/files"),
  });

  const ranked = rankFiles(list.data?.files ?? []);
  // Shares `["file", id]` with every file screen, so arriving from this card
  // does not fetch the file a second time.
  const read = useLoanFile(ranked.primary?.id);
  // The three-valued read the whole design turns on: `undefined` is a fetch
  // still out, `null` is a file that will not project. A card that collapsed
  // them would wait forever on the second and guess on the first.
  const file = read.isError ? null : read.data;

  // `isPending` rather than `isLoading`: the question is whether there is a
  // list yet, and `isLoading` also asks whether a request is in flight right
  // now — which is false in the instant before the fetch starts, and that is
  // an instant where this page would otherwise claim somebody has never
  // applied.
  if (list.isPending) {
    return (
      <div className={CONTAINER}>
        <p className="text-sm text-ink-faint">{FINDING_WHERE_YOU_STAND}</p>
      </div>
    );
  }

  /*
   * A failed read is never the empty state.
   *
   * "You have no applications" is a claim about a regulated record, and a
   * network error is not evidence for it. The retry is left at full weight for
   * a sample borrower too: it refetches a GET, which is the one thing that
   * session is allowed to do.
   */
  if (list.isError) {
    return (
      <div className={CONTAINER}>
        <div className="super-card">
          <h1 className="font-display text-2xl text-ink sm:text-3xl">{UNREAD_LEAD}</h1>
          <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{UNREAD_BODY}</p>
          <button className="super-btn super-btn-outline mt-6" onClick={() => void list.refetch()}>
            {TRY_AGAIN}
          </button>
        </div>
      </div>
    );
  }

  const { primary, live, closed, samples, labels } = ranked;
  // One file renders as one card and nothing else: no name above it, no
  // headings, no list of one. The name earns its place only once there is
  // something to tell this file apart FROM.
  const named = live.length + closed.length + samples.length > 0;

  return (
    <div className={CONTAINER}>
      {primary ? (
        <>
          <StandingCard
            row={primary}
            standing={standingFor({ row: primary, file, user })}
            file={file}
            user={user}
            label={named ? labels[primary.id] : undefined}
          />

          {live.length > 0 && (
            <Section title={OTHER_APPLICATIONS}>
              {live.map((f) => (
                <StandingRow key={f.id} row={f} label={labels[f.id]!} user={user} />
              ))}
            </Section>
          )}

          {/*
            Ended files get their own heading rather than the live list. Mixing
            a withdrawn file in among the open ones is how one word came to
            mean five different situations in the first place.
          */}
          {closed.length > 0 && (
            <Section title={CLOSED_FILES}>
              {closed.map((f) => (
                <StandingRow key={f.id} row={f} label={labels[f.id]!} user={user} />
              ))}
            </Section>
          )}

          {/*
            The honest offer for every ending at once, and the reason there is
            no separate "everything you have is closed" page: a person whose
            only application was withdrawn reads that file's own card, which is
            the record of what happened, and this underneath it.
          */}
          {canStart(user) && (
            <Link to={NEW_APPLICATION} className="super-link-quiet mt-8 inline-block text-sm">
              {START_ANOTHER}
            </Link>
          )}
        </>
      ) : (
        /*
         * Nobody's first sign-in should be a second pitch. They have already
         * signed in; the page becomes the start rather than a shrunken version
         * of itself, and the body is the delivery contract said up front,
         * where it happens to be provably true.
         */
        <div className="super-card">
          <h1 className="font-display text-2xl text-ink sm:text-3xl">{START_LEAD}</h1>
          <p className="mt-3 max-w-measure-prose text-base text-ink-soft">{START_BODY}</p>
          {canStart(user) ? (
            <Link to={NEW_APPLICATION} className="super-btn super-btn-primary mt-6 inline-block">
              {START_NOW}
            </Link>
          ) : (
            <p className="mt-6 text-sm text-ink-muted">{PERSONA_READ_ONLY}</p>
          )}
        </div>
      )}

      {/*
        The team's shared borrowers, collapsed. A new teammate came here for
        exactly these and nobody else should have to read past them.
      */}
      {samples.length > 0 && (
        <details className="mt-8">
          <summary className="super-link-quiet cursor-pointer list-none text-xs">
            {SAMPLE_BORROWERS} ({samples.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {samples.map((f) => (
              <StandingRow key={f.id} row={f} label={labels[f.id]!} user={user} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-base text-ink">{title}</h2>
      <ul className="mt-3 flex flex-col gap-3">{children}</ul>
    </section>
  );
}
