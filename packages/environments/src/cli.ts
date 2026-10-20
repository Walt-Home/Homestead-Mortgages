/**
 * Run a suite and record every episode.
 *
 *   npm run env:refi -w @hm/environments -- --policy reference
 *   npm run env:refi -w @hm/environments -- --policy anthropic --model claude-opus-5-5 --effort high --n 20
 *   npm run env:refi -w @hm/environments -- --policy vertex --split train --n 5
 *   npm run env:refi -w @hm/environments -- --policy anthropic-vertex --split train --n 5
 *
 * The default is the held-out suite, the one every reported score is
 * measured on. A model run spends real money: it is never the default, and
 * it says how many episodes it is about to run before it runs them.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicPolicy, DEFAULT_MODEL, type Effort } from "./anthropic.js";
import { DEFAULT_VERTEX_MODEL, DEFAULT_VERTEX_PROJECT, VertexOpenModelPolicy } from "./vertex.js";
import { vertexClaudeClient } from "./anthropic-vertex.js";
import { DEFAULT_LIMITS, runEpisode, type Policy } from "./episode.js";
import { RECORD_VERSION, RunRecorder, sha256 } from "./record.js";
import {
  HELDOUT_SUITE,
  REFI_FINGERPRINT,
  ReferencePolicy,
  expectedReview,
  generateSuite,
  generateTask,
  refiReview,
  specTasks,
  type RefiTask,
} from "./refi/index.js";

const { values } = parseArgs({
  options: {
    policy: { type: "string", default: "reference" },
    split: { type: "string", default: HELDOUT_SUITE.split },
    seed: { type: "string" },
    n: { type: "string" },
    index: { type: "string" },
    model: { type: "string" },
    effort: { type: "string", default: "high" },
    project: { type: "string", default: DEFAULT_VERTEX_PROJECT },
    thinking: { type: "string", default: "on" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string" },
  },
});

function suite(): RefiTask[] {
  const split = values.split;
  if (split === "spec") return specTasks();
  if (split !== "train" && split !== "heldout")
    throw new Error(`--split must be train, heldout or spec`);
  const seed = Number(values.seed ?? (split === "heldout" ? HELDOUT_SUITE.seed : 1));
  if (values.index !== undefined) return [generateTask(split, seed, Number(values.index))];
  const n = Number(values.n ?? (split === "heldout" ? HELDOUT_SUITE.n : 50));
  return generateSuite(split, seed, n);
}

function policyOf(): Policy {
  if (values.policy === "reference") return new ReferencePolicy();
  if (values.policy === "anthropic") {
    // An eval key of its own name, so it never turns on the API's refi
    // analyst, which starts calling Claude whenever ANTHROPIC_API_KEY is set
    // (and the API's tests load the root .env).
    const evalKey = process.env["ANTHROPIC_EVAL_API_KEY"]?.trim();
    return new AnthropicPolicy({
      ...(evalKey ? { client: new Anthropic({ apiKey: evalKey }) } : {}),
      model: values.model ?? DEFAULT_MODEL,
      effort: values.effort as Effort,
    });
  }
  if (values.policy === "anthropic-vertex") {
    return new AnthropicPolicy({
      client: vertexClaudeClient({ project: values.project }),
      model: values.model ?? DEFAULT_MODEL,
      effort: values.effort as Effort,
      provider: "anthropic-vertex",
    });
  }
  if (values.policy === "vertex") {
    return new VertexOpenModelPolicy({
      model: values.model ?? DEFAULT_VERTEX_MODEL,
      project: values.project,
      thinking: values.thinking !== "off",
    });
  }
  throw new Error(`--policy must be reference, anthropic, anthropic-vertex or vertex`);
}

async function main(): Promise<void> {
  const tasks = suite();
  const policy = policyOf();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const out = values.out ?? `runs/${refiReview.name}/${runId}.jsonl`;
  const recorder = new RunRecorder(out);
  const concurrency = Math.max(1, Number(values.concurrency));
  console.log(
    `${policy.id}: ${tasks.length} episodes of ${refiReview.name} ${refiReview.version}, ${values.split}, recorded to ${out}`,
  );

  const results: { task: RefiTask; pass: boolean; score: number; outcome: string }[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      const task = tasks[i] as RefiTask;
      const rendered = refiReview.render(task);
      const result = await runEpisode(refiReview, task, policy, DEFAULT_LIMITS);
      recorder.append({
        record_version: RECORD_VERSION,
        run_id: runId,
        ...REFI_FINGERPRINT,
        task: {
          id: task.id,
          split: task.split,
          suite_seed: task.suite_seed,
          index: task.index,
          sha256: sha256(rendered),
          rendered,
        },
        policy: { id: policy.id },
        result,
      });
      results.push({
        task,
        pass: result.grade.pass,
        score: result.grade.score,
        outcome: result.outcome,
      });
      if (!result.grade.pass) {
        const missed = result.grade.fields.filter((f) => !f.ok).map((f) => f.field);
        console.log(`  miss ${task.id} (${result.outcome}): ${missed.join(", ")}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const passed = results.filter((r) => r.pass).length;
  const mean = results.reduce((s, r) => s + r.score, 0) / Math.max(1, results.length);
  console.log(
    `passed ${passed}/${results.length} (${((100 * passed) / Math.max(1, results.length)).toFixed(1)} %), mean field score ${mean.toFixed(3)}`,
  );
  const byVerdict = new Map<string, { n: number; passed: number }>();
  for (const r of results) {
    const v = expectedReview(r.task).verdict;
    const b = byVerdict.get(v) ?? { n: 0, passed: 0 };
    b.n += 1;
    if (r.pass) b.passed += 1;
    byVerdict.set(v, b);
  }
  for (const [v, b] of [...byVerdict].sort()) console.log(`  ${v}: ${b.passed}/${b.n}`);
  const outcomes = new Map<string, number>();
  for (const r of results) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
  console.log(`  outcomes: ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
