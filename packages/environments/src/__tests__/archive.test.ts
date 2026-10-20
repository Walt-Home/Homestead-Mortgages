/**
 * Only a finished run is archived: the bucket keeps every object for a year
 * and replaces none, so a file still being written must wait.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QUIET_MS, readyToArchive, runFiles } from "../archive.js";

describe("the archive", () => {
  it("finds every run record under the runs directory, keyed by its path there", () => {
    const root = mkdtempSync(join(tmpdir(), "env-archive-"));
    mkdirSync(join(root, "refi-review"));
    writeFileSync(join(root, "refi-review", "a.jsonl"), "{}\n");
    writeFileSync(join(root, "refi-review", "notes.txt"), "not a record");
    writeFileSync(join(root, "b.jsonl"), "{}\n");
    expect(runFiles(root).map((f) => f.key)).toEqual(["b.jsonl", "refi-review/a.jsonl"]);
  });

  it("leaves a file written to in the quiet period for the next archive", () => {
    const root = mkdtempSync(join(tmpdir(), "env-archive-"));
    const old = join(root, "finished.jsonl");
    const fresh = join(root, "running.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    const now = Date.now();
    const longAgo = (now - QUIET_MS - 60_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    const { ready, stillWriting } = readyToArchive(runFiles(root), now);
    expect(ready.map((f) => f.key)).toEqual(["finished.jsonl"]);
    expect(stillWriting.map((f) => f.key)).toEqual(["running.jsonl"]);
  });
});
