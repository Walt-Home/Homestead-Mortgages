/**
 * A state, as a pill.
 *
 * The ONE place a tone becomes a class. Everything else in the app carries a
 * `Tone` — a meaning — so that adding a state cannot accidentally introduce a
 * colour, and so the mapping can be changed in one edit rather than found by
 * grepping for `super-pill-warn`.
 *
 * The bare `.super-pill` is the neutral, and most states use it. Colour is
 * reserved for "something is now true about the outcome": approved, funded,
 * declined. A file that is merely in progress is distinguished by its words,
 * which is the precedent the decision screen already set by rendering all five
 * outcomes as prose with no colour at all. Painting every state would make the
 * three that matter stop reading as different.
 */

import type { Tone } from "../lib/states.js";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "super-pill",
  ok: "super-pill super-pill-ok",
  warn: "super-pill super-pill-warn",
  danger: "super-pill super-pill-danger",
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={TONE_CLASS[tone]}>{children}</span>;
}
