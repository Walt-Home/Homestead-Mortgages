/**
 * A small phrase grammar, so one move can be said a few hundred ways.
 *
 *   [a|b|c]   one of the alternatives, uniformly; `[a|]` is "a" or nothing
 *   {name}    a slot, filled from the slots given (a missing slot throws,
 *             so a template can never say a figure the record lacks)
 *
 * Alternatives nest. After expansion the spacing and the punctuation around
 * an empty alternative are tidied, and the first letter is capitalized.
 * Every choice draws from the rng handed in, so a call is a function of its
 * stream.
 */

import type { Rng } from "../rng.js";

export type Slots = Readonly<Record<string, string>>;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "|" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function expandRaw(r: Rng, t: string, slots: Slots): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "[") {
      let depth = 1;
      let j = i + 1;
      for (; j < t.length && depth > 0; j++) {
        if (t[j] === "[") depth++;
        else if (t[j] === "]") depth--;
      }
      if (depth !== 0) throw new SyntaxError(`unclosed [ in ${JSON.stringify(t)}`);
      const alts = splitTop(t.slice(i + 1, j - 1));
      out += expandRaw(r, alts[r.int(0, alts.length - 1)]!, slots);
      i = j - 1;
    } else if (ch === "{") {
      const j = t.indexOf("}", i);
      if (j < 0) throw new SyntaxError(`unclosed { in ${JSON.stringify(t)}`);
      const name = t.slice(i + 1, j);
      const v = slots[name];
      if (v === undefined) throw new RangeError(`slot {${name}} has no value`);
      out += v;
      i = j;
    } else out += ch;
  }
  return out;
}

/** Tidy what an empty alternative leaves behind. */
export function tidy(s: string): string {
  let x = s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.?!;:])/g, "$1")
    .replace(/,([.?!])/g, "$1")
    .replace(/([.?!]),/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/\.{2,}/g, ".")
    .replace(/^[\s,.]+/, "")
    .trim();
  x = x.replace(/(^|[.?!]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return x;
}

export function expand(r: Rng, template: string, slots: Slots = {}): string {
  return tidy(expandRaw(r, template, slots));
}

/** One of several templates, expanded. */
export function say(r: Rng, templates: readonly string[], slots: Slots = {}): string {
  return expand(r, r.pick(templates), slots);
}

/** Shuffle a copy, from the rng. */
export function shuffled<T>(r: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
