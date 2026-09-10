/**
 * Every state, side by side.
 *
 * A GALLERY, not a dashboard. None of this is a live account: most of these
 * states have no column behind them yet, and a page that implied otherwise
 * would be asserting something the schema cannot record — see docs/states.md,
 * which marks what is built and what is designed.
 *
 * It exists so the copy can be judged at its real length, in the real
 * typeface, next to its neighbours. Reading nineteen headings in a row is the
 * only reliable way to notice that two of them say the same thing, or that the
 * one for a declined borrower is cheerier than the one for an approved one.
 *
 * Not a borrower surface. The figures on these cards are invented, and a
 * person who has a file of their own has no way to read 34 of them as anything
 * but figures about it — so the route exists only for a session that holds no
 * sample borrower, on a deployment carrying both STATE_GALLERY and
 * DEMO_PERSONAS. Sign-in alone was never enough of a test: it is open to any
 * Google account. See `stateGalleryVisible` in lib/auth.tsx.
 */

import { STATE_GROUPS } from "../lib/states.js";
import { StatusPill } from "../components/StatusPill.js";

export function StatesGalleryPage() {
  const total = STATE_GROUPS.reduce((n, g) => n + g.states.length, 0);

  // `Chrome` already renders the header, the footer and the page frame, so
  // this returns a section rather than a screen.
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink">Every state, and its words</h1>
      <p className="mt-4 max-w-prose text-base text-ink-soft">
        {total} states a person can be in, written out so they can be read next to each other.
        Figures are made up. Most of these have no column behind them yet — this is a design
        surface, not an account.
      </p>

      {STATE_GROUPS.map((group) => (
        <section key={group.id} className="mt-14">
          <h2 className="font-display text-2xl text-ink">{group.title}</h2>
          <p className="mt-2 max-w-prose text-sm text-ink-faint">{group.note}</p>

          <div className="mt-6 flex flex-col gap-4">
            {group.states.map((state) => (
              <article key={state.id} className="rounded-lg border border-rule bg-surface p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill tone={state.tone}>{state.pill}</StatusPill>
                  <code className="text-xs text-ink-faint">{state.id}</code>
                  {state.terminal && <span className="text-xs text-ink-faint">terminal</span>}
                </div>

                <h3 className="mt-4 font-display text-xl text-ink">{state.heading}</h3>
                <p className="mt-2 max-w-prose text-base text-ink-soft">{state.body}</p>

                {state.action ? (
                  <p className="mt-4">
                    <span className="super-btn super-btn-outline">{state.action}</span>
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-ink-faint">No control — nothing to press.</p>
                )}

                <p className="mt-5 border-t border-rule-soft pt-4 text-sm text-ink-muted">
                  {state.meaning}
                </p>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
