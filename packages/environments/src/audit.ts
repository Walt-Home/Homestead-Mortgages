/**
 * The audit that directs a hand read of a run.
 *
 * For each episode it says what the record already proves and where a reader
 * should look: every figure the answer submitted that no tool ever returned
 * (arithmetic done in the model's head), a pass that skipped a tool a full
 * review needs, the tool calls that came back as errors, the slowest turn,
 * the fields missed. Phase 1's gate was read this way: every pass audited,
 * the flagged ones and a sample read line by line.
 *
 * A held-out transcript is not for reading. The held-out suite is what every
 * reported score is measured on, and a person who has read its transcripts
 * tunes toward them without meaning to, so the audit lists a held-out
 * episode's outcome and missed fields and refuses to print its turns.
 */

import type { EpisodeResult, Observation } from "./episode.js";
import { costOf } from "./compare.js";

/** What a full review cannot do without, once a loan is past its exclusions and has a quote. */
const NEEDED_WITH_QUOTE = ["level_payment", "present_value", "balance_after"] as const;

export interface AuditRecord {
  readonly task: {
    readonly id: string;
    readonly split: string;
    readonly index: number;
    readonly rendered: string;
  };
  readonly policy: { readonly id: string };
  /** A refi answer carries its figures in `offer`; another environment's answer is its figures. */
  readonly result: EpisodeResult<Readonly<Record<string, unknown>> | null>;
}

export interface AuditRow {
  readonly id: string;
  readonly split: string;
  readonly index: number;
  readonly verdict: string;
  readonly pass: boolean;
  readonly outcome: string;
  readonly turns: number;
  readonly calls: number;
  readonly cost: number | null;
  readonly slowestTurnS: number;
  /** Figures the answer submitted that no tool returned: done in the model's head. */
  readonly mental: readonly string[];
  /** For a pass on a quoted, non-excluded loan: the tools a full review needs that it never called. */
  readonly passWithout: readonly string[];
  readonly toolErrors: number;
  readonly missed: readonly string[];
  readonly error: string | null;
}

const valuesOf = (o: Observation): string[] => {
  if (o.is_error) return [];
  try {
    return Object.values(JSON.parse(o.content) as Record<string, unknown>).map(String);
  } catch {
    return [];
  }
};

export function auditEpisode(r: AuditRecord): AuditRow {
  const res = r.result;
  const turns = res.transcript.flatMap((e) => (e.kind === "turn" ? [e] : []));
  const observations = res.transcript.flatMap((e) =>
    e.kind === "observations" ? e.observations : [],
  );
  const returned = new Set(observations.flatMap(valuesOf));
  const verdict =
    res.grade.fields.find((f) => f.field === "verdict" || f.field === "decision")?.expected ?? "?";
  const answer = res.answer ?? null;
  const figures =
    answer && "offer" in answer
      ? ((answer["offer"] ?? null) as Readonly<Record<string, unknown>> | null)
      : answer;
  const mental = figures
    ? Object.entries(figures)
        .filter(([k, v]) => k.endsWith("_cents") && v !== null && !returned.has(String(v)))
        .map(([k]) => k)
        .sort()
    : [];
  const called = new Set(turns.flatMap((t) => t.calls.map((c) => c.name)));
  const quoted = /"quote": \{/.test(r.task.rendered);
  const passWithout =
    res.grade.pass && quoted && verdict !== "excluded"
      ? NEEDED_WITH_QUOTE.filter((t) => !called.has(t))
      : [];
  return {
    id: r.task.id,
    split: r.task.split,
    index: r.task.index,
    verdict,
    pass: res.grade.pass,
    outcome: res.outcome,
    turns: res.turns,
    calls: res.tool_calls,
    cost: costOf(r.policy.id, res.usage),
    slowestTurnS: Math.round(Math.max(0, ...turns.map((t) => t.ms ?? 0)) / 1000),
    mental,
    passWithout: [...passWithout],
    toolErrors: observations.filter((o) => o.is_error).length,
    missed: res.grade.fields.filter((f) => !f.ok).map((f) => f.field),
    error: res.error,
  };
}

export interface AuditSummary {
  readonly episodes: number;
  readonly passed: number;
  readonly cost: number | null;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly byVerdict: Readonly<Record<string, { readonly n: number; readonly passed: number }>>;
  readonly flagged: {
    readonly mental: number;
    readonly passWithout: number;
    readonly toolErrors: number;
  };
  /** Each missed field, and how many episodes missed it. */
  readonly missedFields: Readonly<Record<string, number>>;
}

export function summarize(rows: readonly AuditRow[]): AuditSummary {
  const count = <K extends string>(keys: readonly K[]) =>
    keys.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
  const byVerdict: Record<string, { n: number; passed: number }> = {};
  for (const r of rows) {
    const v = (byVerdict[r.verdict] ??= { n: 0, passed: 0 });
    v.n++;
    if (r.pass) v.passed++;
  }
  const costs = rows.map((r) => r.cost);
  return {
    episodes: rows.length,
    passed: rows.filter((r) => r.pass).length,
    cost: costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0),
    outcomes: count(rows.map((r) => r.outcome)),
    byVerdict,
    flagged: {
      mental: rows.filter((r) => r.mental.length).length,
      passWithout: rows.filter((r) => r.passWithout.length).length,
      toolErrors: rows.filter((r) => r.toolErrors).length,
    },
    missedFields: count(rows.flatMap((r) => r.missed)),
  };
}

/** The turns of one episode, as a reader reads them; refused for the held-out suite. */
export function transcriptOf(r: AuditRecord): string {
  if (r.task.split === "heldout") {
    throw new Error(
      `${r.task.id} is a held-out task: its transcript is not for reading (see docs/environments.md).`,
    );
  }
  const out: string[] = [];
  for (const e of r.result.transcript) {
    if (e.kind === "turn") {
      out.push(`turn ${e.turn} (${Math.round((e.ms ?? 0) / 1000)} s): ${e.text.slice(0, 300)}`);
      for (const c of e.calls) out.push(`    ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
    } else {
      for (const o of e.observations)
        out.push(`      -> ${o.content.slice(0, 120)}${o.is_error ? " (error)" : ""}`);
    }
  }
  out.push(`answer: ${JSON.stringify(r.result.answer).slice(0, 800)}`);
  return out.join("\n");
}
