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
import type { EpisodeResult } from "./episode.js";

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
