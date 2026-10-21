/**
 * Two policies on the same tasks: which scores better, and how sure we are.
 *
 * Phase 2's gate is a comparison — self-host only if the open model scores
 * at least as well as the one we use today — and a comparison of two pass
 * rates on 200 tasks is noise unless it says how much. So the runs are
 * paired by task, each side's rate carries a Wilson 95 % interval, and the
 * tasks the two disagree on are put to McNemar's exact test.
 *
 * An episode that ended in a transport error (`outcome: "error"`) is not the
 * model's answer and is not scored: a task's newest scored episode counts,
 * and a task with none on either side is left out of the pairing and named.
 * A refusal, a missing submission or a spent budget is the model's, and is
 * scored as a miss.
 */

import { readFileSync } from "node:fs";

export interface EpisodeLine {
  readonly task: { readonly id: string };
  readonly policy: { readonly id: string };
  readonly result: {
    readonly outcome: string;
    readonly finished_at: string;
    readonly grade: {
      readonly pass: boolean;
      readonly fields: readonly {
        readonly field: string;
        readonly expected: string;
        readonly ok?: boolean;
      }[];
    };
    readonly usage: {
      readonly input_tokens: number;
      readonly cache_read_input_tokens: number;
      readonly cache_creation_input_tokens: number;
      readonly output_tokens: number;
    };
  };
}

export interface Scored {
  readonly pass: boolean;
  readonly verdict: string;
  readonly cost: number | null;
  readonly missed: readonly string[];
}

/** USD per token, by policy id prefix, from each provider's published list price. */
const PRICES: readonly (readonly [
  string,
  { in: number; cacheRead: number; cacheWrite: number; out: number },
])[] = [
  // Google's billing catalog, Vertex AI SKUs for DeepSeek V4.1-Flash, global (19 Oct 2026).
  [
    "vertex:deepseek-ai/deepseek-v4.1-flash-maas",
    { in: 0.3e-6, cacheRead: 0.03e-6, cacheWrite: 0.3e-6, out: 1.2e-6 },
  ],
  // Anthropic's list price for Claude Opus 5.5; a cache write is 1.25 × input.
  ["anthropic:claude-opus-5-5", { in: 4e-6, cacheRead: 0.2e-6, cacheWrite: 5e-6, out: 20e-6 }],
];

export function costOf(policyId: string, u: EpisodeLine["result"]["usage"]): number | null {
  const p = PRICES.find(([prefix]) => policyId.startsWith(prefix))?.[1];
  if (!p) return null;
  return (
    u.input_tokens * p.in +
    u.cache_read_input_tokens * p.cacheRead +
    u.cache_creation_input_tokens * p.cacheWrite +
    u.output_tokens * p.out
  );
}

/** Each task's newest scored episode across the given lines; tasks that only errored are listed apart. */
export function scoreSide(lines: readonly EpisodeLine[]): {
  readonly byTask: ReadonlyMap<string, Scored>;
  readonly unscored: readonly string[];
  readonly policies: readonly string[];
} {
  const newest = new Map<string, EpisodeLine>();
  const seen = new Set<string>();
  for (const l of lines) {
    seen.add(l.task.id);
    if (l.result.outcome === "error") continue;
    const prev = newest.get(l.task.id);
    if (!prev || prev.result.finished_at < l.result.finished_at) newest.set(l.task.id, l);
  }
  const byTask = new Map<string, Scored>();
  for (const [id, l] of newest) {
    byTask.set(id, {
      pass: l.result.grade.pass,
      verdict:
        l.result.grade.fields.find((f) => f.field === "verdict" || f.field === "decision")
          ?.expected ?? "?",
      cost: costOf(l.policy.id, l.result.usage),
      missed: l.result.grade.fields.filter((f) => f.ok === false).map((f) => f.field),
    });
  }
  return {
    byTask,
    unscored: [...seen].filter((id) => !newest.has(id)).sort(),
    policies: [...new Set(lines.map((l) => l.policy.id))],
  };
}

/** Wilson score interval for k successes in n, at z = 1.96. */
export function wilson(
  k: number,
  n: number,
  z = 1.96,
): { readonly low: number; readonly high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** McNemar's exact two-sided p-value: the discordant pairs against a fair coin. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let term = Math.pow(0.5, n); // C(n, 0) / 2^n
  for (let i = 0; i <= k; i++) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

export interface Comparison {
  readonly tasks: number;
  readonly a: { readonly passed: number; readonly low: number; readonly high: number };
  readonly b: { readonly passed: number; readonly low: number; readonly high: number };
  /** Tasks A passed and B missed, and the other way round. */
  readonly onlyA: number;
  readonly onlyB: number;
  readonly p: number;
  readonly byVerdict: ReadonlyMap<
    string,
    { readonly n: number; readonly a: number; readonly b: number }
  >;
  readonly costA: number | null;
  readonly costB: number | null;
  readonly unpaired: readonly string[];
  /**
   * Tasks both sides missed on the same field. Two models that fail the same
   * way are more often reading the same unclear sentence than sharing a
   * weakness, so each is a wording check before it counts as difficulty.
   */
  readonly sharedMisses: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

export function compare(
  a: ReturnType<typeof scoreSide>,
  b: ReturnType<typeof scoreSide>,
): Comparison {
  const ids = [...a.byTask.keys()].filter((id) => b.byTask.has(id)).sort();
  const unpaired = [
    ...new Set([...a.byTask.keys(), ...b.byTask.keys(), ...a.unscored, ...b.unscored]),
  ]
    .filter((id) => !ids.includes(id))
    .sort();
  let passA = 0;
  let passB = 0;
  let onlyA = 0;
  let onlyB = 0;
  let costA: number | null = 0;
  let costB: number | null = 0;
  const byVerdict = new Map<string, { n: number; a: number; b: number }>();
  const sharedMisses: { id: string; fields: string[] }[] = [];
  for (const id of ids) {
    const x = a.byTask.get(id) as Scored;
    const y = b.byTask.get(id) as Scored;
    if (x.pass) passA++;
    if (y.pass) passB++;
    if (x.pass && !y.pass) onlyA++;
    if (!x.pass && y.pass) onlyB++;
    const both = x.missed.filter((f) => y.missed.includes(f));
    if (both.length) sharedMisses.push({ id, fields: both });
    costA = costA === null || x.cost === null ? null : costA + x.cost;
    costB = costB === null || y.cost === null ? null : costB + y.cost;
    const v = byVerdict.get(x.verdict) ?? { n: 0, a: 0, b: 0 };
    v.n++;
    if (x.pass) v.a++;
    if (y.pass) v.b++;
    byVerdict.set(x.verdict, v);
  }
  const n = ids.length;
  return {
    tasks: n,
    a: { passed: passA, ...wilson(passA, n) },
    b: { passed: passB, ...wilson(passB, n) },
    onlyA,
    onlyB,
    p: mcnemarExact(onlyA, onlyB),
    byVerdict,
    costA: costA === null || n === 0 ? null : costA / n,
    costB: costB === null || n === 0 ? null : costB / n,
    unpaired,
    sharedMisses,
  };
}

export const readRun = (paths: readonly string[]): EpisodeLine[] =>
  paths.flatMap((p) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as EpisodeLine),
  );
