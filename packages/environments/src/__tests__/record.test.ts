/**
 * The record only grows: a second run appends after the first and leaves
 * every line it wrote as it was.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { RECORD_VERSION, RunRecorder, sha256 } from "../record.js";
import { REFI_FINGERPRINT, ReferencePolicy, refiReview, specTasks } from "../refi/index.js";

describe("the run record", () => {
  it("appends, never rewrites, and carries what a score rests on", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "env-record-")), "runs.jsonl");
    writeFileSync(path, '{"earlier":true}\n');
    const recorder = new RunRecorder(path);
    for (const task of specTasks().slice(0, 2)) {
      const rendered = refiReview.render(task);
      recorder.append({
        record_version: RECORD_VERSION,
        run_id: "test",
        ...REFI_FINGERPRINT,
        task: {
          id: task.id,
          split: task.split,
          suite_seed: task.suite_seed,
          index: task.index,
          sha256: sha256(rendered),
          rendered,
        },
        policy: { id: "reference" },
        result: await runEpisode(refiReview, task, new ReferencePolicy()),
      });
    }
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines[0]).toBe('{"earlier":true}');
    expect(lines).toHaveLength(3);
    const rec = JSON.parse(lines[1] as string);
    expect(rec).toMatchObject({
      environment: { name: "refi-review", version: refiReview.version },
      grader: { rule_set_version: expect.any(String), port_version: expect.any(String) },
      policy: { id: "reference" },
      result: { outcome: "submitted", grade: { pass: true } },
    });
    expect(rec.environment.rulebook_sha256).toBe(sha256(refiReview.system));
  });
});
