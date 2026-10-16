/**
 * A seeded generator, so a task is a function of its name.
 *
 * Every task draws from its own stream, keyed by a string that names its
 * environment, version, split, suite seed and index. The same key always
 * gives the same task on any machine, any task can be regenerated alone,
 * and two splits can never draw the same stream because their keys differ.
 */

/** FNV-1a over the string's UTF-16 code units: a 32-bit seed from a key. */
export function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [lo, hi], both included. */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  weighted<T>(pairs: readonly (readonly [T, number])[]): T;
}

/** mulberry32: small, fast, and the same in every JavaScript engine. */
export function rngFor(key: string): Rng {
  let a = hash32(key);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (xs) => {
      if (xs.length === 0) throw new RangeError("pick from an empty list");
      return xs[int(0, xs.length - 1)] as (typeof xs)[number];
    },
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let x = next() * total;
      for (const [v, w] of pairs) {
        if (x < w) return v;
        x -= w;
      }
      const last = pairs[pairs.length - 1];
      if (!last) throw new RangeError("weighted pick from an empty list");
      return last[0];
    },
  };
}
