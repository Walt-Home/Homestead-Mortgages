/**
 * Which run records are ready to archive.
 *
 * The archive bucket keeps every object for a year and lets none be replaced
 * (infra/evals.tf), so a record uploaded while its run is still appending to
 * it would be frozen half-written. A file is ready once nothing has written
 * to it for a quiet period; one still growing waits for the next archive.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const QUIET_MS = 15 * 60_000;

export interface RunFile {
  readonly path: string;
  /** The path under the runs directory, which is also its name in the bucket. */
  readonly key: string;
  readonly modifiedMs: number;
}

export function runFiles(root: string): RunFile[] {
  const out: RunFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) {
        out.push({ path: p, key: relative(root, p), modifiedMs: statSync(p).mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function readyToArchive(
  files: readonly RunFile[],
  nowMs: number,
  quietMs = QUIET_MS,
): { readonly ready: RunFile[]; readonly stillWriting: RunFile[] } {
  return {
    ready: files.filter((f) => nowMs - f.modifiedMs >= quietMs),
    stillWriting: files.filter((f) => nowMs - f.modifiedMs < quietMs),
  };
}
