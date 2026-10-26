/**
 * The record only grows: a second run appends after the first and leaves
 * every line it wrote as it was.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { NO_USAGE } from "../episode.js";
import { RECORD_VERSION, RunRecorder, neverRan, recordedTasks, sha256 } from "../record.js";
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

  it("tells a turn that never ran from the model's own miss, by counts alone", () => {
    const spent = { ...NO_USAGE, input_tokens: 5160, output_tokens: 1844 };
    // What a cut first turn was recorded as: one turn, no tool call, not one token.
    expect(neverRan({ outcome: "no_submission", tool_calls: 0, usage: NO_USAGE })).toBe(true);
    expect(neverRan({ outcome: "refusal", tool_calls: 0, usage: NO_USAGE })).toBe(true);
    // A model that read its task and stopped spent tokens doing it.
    expect(neverRan({ outcome: "no_submission", tool_calls: 0, usage: spent })).toBe(false);
    expect(
      neverRan({
        outcome: "no_submission",
        tool_calls: 0,
        usage: { ...NO_USAGE, cache_read_input_tokens: 3840 },
      }),
    ).toBe(false);
    expect(neverRan({ outcome: "no_submission", tool_calls: 5, usage: NO_USAGE })).toBe(false);
    // An error is already run again, as an error.
    expect(neverRan({ outcome: "error", tool_calls: 0, usage: NO_USAGE })).toBe(false);
  });

  it("leaves out for --resume the tasks that ran, and runs again what errored or never ran", () => {
    const spent = { ...NO_USAGE, input_tokens: 5160, output_tokens: 1844 };
    const line = (
      id: string,
      outcome: string,
      tool_calls: number,
      usage: typeof NO_USAGE,
      version = "1.0.0",
    ) =>
      JSON.stringify({
        environment: { name: "call-qa", version },
        task: { id },
        result: { outcome, tool_calls, usage, transcript: [], answer: null },
      });
    const text = [
      line("t-submitted", "submitted", 6, spent),
      line("t-missed", "no_submission", 4, spent),
      line("t-stopped", "no_submission", 0, spent),
      line("t-never-ran", "no_submission", 0, NO_USAGE),
      line("t-errored", "error", 0, NO_USAGE),
      // Run again later and recorded: the newer line ran, so the task is done.
      line("t-rerun", "no_submission", 0, NO_USAGE),
      line("t-rerun", "submitted", 3, spent),
      line("t-old-version", "submitted", 3, spent, "0.9.0"),
      '{"environment":{"version":"1.0.0"},"task":{"id":"t-cut-mid-li', // a run still being written
    ].join("\n");
    const { ran, again } = recordedTasks(text, "1.0.0");
    expect([...ran].sort()).toEqual(["t-missed", "t-rerun", "t-stopped", "t-submitted"]);
    expect([...again].sort()).toEqual(["t-errored", "t-never-ran"]);
  });

  it("says which policy ids a run file was run as, at this version, so a resume can refuse another", () => {
    const line = (policy: string, version = "1.1.0") =>
      JSON.stringify({
        environment: { name: "boarding-triage", version },
        policy: { id: policy },
        task: { id: `t-${policy.length}-${version}` },
        result: {
          outcome: "submitted",
          tool_calls: 3,
          usage: NO_USAGE,
          transcript: [],
          answer: null,
        },
      });
    const sixteen = "vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking";
    const wide = `${sixteen}:max-tokens-32000`;
    expect([...recordedTasks(line(sixteen), "1.1.0").policies]).toEqual([sixteen]);
    expect(
      [
        ...recordedTasks(
          [line(sixteen), line(wide), line("reference", "1.0.0")].join("\n"),
          "1.1.0",
        ).policies,
      ].sort(),
    ).toEqual([sixteen, wide]);
    expect(recordedTasks("", "1.1.0").policies.size).toBe(0);
  });
});
