/**
 * Every episode is a line, appended, never rewritten.
 *
 * A run's record is the evidence a score rests on: which task (by split,
 * seed and index, so it can be regenerated), which version of the rules
 * and of the grader, which policy, the whole transcript, the answer and
 * every graded field. The file is only ever opened to append, so a record
 * written cannot be edited by a later run, and a score can always be
 * traced back to the turns that earned it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { EpisodeResult, Usage } from "./episode.js";

export const RECORD_VERSION = 1;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface EpisodeRecord<A> {
  readonly record_version: number;
  readonly run_id: string;
  readonly environment: {
    readonly name: string;
    readonly version: string;
    readonly rulebook_sha256: string;
    readonly tools_sha256: string;
  };
  readonly grader: Readonly<Record<string, string>>;
  readonly task: {
    readonly id: string;
    readonly split: string;
    readonly suite_seed: number;
    readonly index: number;
    readonly sha256: string;
    readonly rendered: string;
  };
  readonly policy: { readonly id: string };
  readonly result: EpisodeResult<A>;
}

/** JSON with bigints as strings: a record must never fail to serialize. */
export const toJsonLine = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

export class RunRecorder {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append<A>(record: EpisodeRecord<A>): void {
    appendFileSync(this.path, `${toJsonLine(record)}\n`, { flag: "a" });
  }
}

/**
 * An episode whose turn never ran: it called no tool and spent not one token,
 * yet ended in an outcome other than an error. A model that read its task
 * spent tokens reading it, so this is a turn the transport lost (a stream
 * the endpoint cut, read as a model that stopped without an answer, before
 * the Vertex policy checked that a turn arrived whole) and not the model's
 * miss: it is not scored, and `--resume` runs it again.
 */
export function neverRan(result: {
  readonly outcome: string;
  readonly tool_calls?: number;
  readonly usage?: Partial<Usage>;
}): boolean {
  const u = result.usage ?? {};
  return (
    result.outcome !== "error" &&
    result.tool_calls === 0 &&
    (u.input_tokens ?? 0) === 0 &&
    (u.cache_read_input_tokens ?? 0) === 0 &&
    (u.cache_creation_input_tokens ?? 0) === 0 &&
    (u.output_tokens ?? 0) === 0
  );
}

/**
 * What a run file already holds for `--resume`: the tasks with an episode
 * that ran on this version, which it leaves out, and the tasks it runs again
 * because their only episodes ended in a transport error or never ran. It
 * reads a line's coordinates, outcome and counts, never its transcript.
 */
export function recordedTasks(
  text: string,
  version: string,
): { readonly ran: ReadonlySet<string>; readonly again: ReadonlySet<string> } {
  const ran = new Set<string>();
  const tried = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: {
      environment?: { version?: string };
      task: { id: string };
      result: { outcome: string; tool_calls?: number; usage?: Partial<Usage> };
    };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue; // a run still being written ends mid-line
    }
    if (r.environment?.version !== version) continue;
    tried.add(r.task.id);
    if (r.result.outcome !== "error" && !neverRan(r.result)) ran.add(r.task.id);
  }
  return { ran, again: new Set([...tried].filter((id) => !ran.has(id))) };
}
