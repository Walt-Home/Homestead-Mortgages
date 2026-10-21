/**
 * Run a suite and record every episode.
 *
 *   npm run env:refi -w @hm/environments -- --policy reference
 *   npm run env:refi -w @hm/environments -- --policy anthropic --model claude-opus-5-5 --effort high --n 20
 *   npm run env:refi -w @hm/environments -- --policy vertex --split train --n 5
 *   npm run env:refi -w @hm/environments -- --policy anthropic-vertex --split train --n 5
 *   npm run env:refi -w @hm/environments -- --env refi-tape --policy reference
 *   npm run env:refi -w @hm/environments -- --env refi-policy --policy reference
 *   npm run env:refi -w @hm/environments -- --env refi-hard --policy reference
 *   npm run env:refi -w @hm/environments -- --env refi-hard-policy --policy reference
 *   npm run env:refi -w @hm/environments -- --env escrow-analysis --policy reference
 *   npm run env:refi -w @hm/environments -- --env regz-price-tests --policy reference
 *   npm run env:refi -w @hm/environments -- --env escrow-policy --policy reference
 *   npm run env:refi -w @hm/environments -- --env regz-policy --policy reference
 *   npm run env:refi -w @hm/environments -- --env escrow-history --policy reference
 *   npm run env:refi -w @hm/environments -- --env regz-apr --policy reference
 *   npm run env:refi -w @hm/environments -- --env flexmod-terms --policy reference
 *   npm run env:refi -w @hm/environments -- --env payments-posting --policy reference
 *   npm run env:refi -w @hm/environments -- --env arm-adjustment --policy reference
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
import type { Environment } from "./episode.js";
import {
  HELDOUT_SUITE,
  REFI_FINGERPRINT,
  ReferencePolicy,
  expectedReview,
  generateSuite,
  generateTask,
  refiReview,
  specTasks,
  type RefiAnswer,
  type Split,
} from "./refi/index.js";
import {
  TAPE_FINGERPRINT,
  TAPE_HELDOUT_SUITE,
  TapeReferencePolicy,
  expectedTapeAnswer,
  generateTapeSuite,
  generateTapeTask,
  refiTape,
  tapeSpecTasks,
  type RefiTapeTask,
} from "./refi-tape/index.js";
import { POLICY_FINGERPRINT, refiPolicy } from "./refi-policy/index.js";
import {
  HARD_FINGERPRINT,
  HARD_HELDOUT_SUITE,
  HARD_POLICY_FINGERPRINT,
  generateHardSuite,
  generateHardTask,
  refiHard,
  refiHardPolicy,
} from "./refi-hard/index.js";
import {
  ESCROW_FINGERPRINT,
  ESCROW_HELDOUT_SUITE,
  EscrowReferencePolicy,
  escrowAnalysis,
  escrowSpecTasks,
  expectedEscrow,
  generateEscrowSuite,
  generateEscrowTask,
  type EscrowAnswer,
  type EscrowTask,
} from "./escrow/index.js";
import {
  REGZ_FINGERPRINT,
  REGZ_HELDOUT_SUITE,
  RegzReferencePolicy,
  expectedRegz,
  generateRegzSuite,
  generateRegzTask,
  regzPriceTests,
  type RegzAnswer,
  type RegzTask,
} from "./regz/index.js";
import { ESCROW_POLICY_FINGERPRINT, escrowPolicy } from "./escrow/policy-env.js";
import { REGZ_POLICY_FINGERPRINT, regzPolicy } from "./regz/policy-env.js";
import {
  HISTORY_FINGERPRINT,
  HISTORY_HELDOUT_SUITE,
  HistoryReferencePolicy,
  escrowHistory,
  expectedHistory,
  generateHistorySuite,
  generateHistoryTask,
  type EscrowHistoryTask,
} from "./escrow-history/index.js";
import {
  REGZ_APR_FINGERPRINT,
  REGZ_APR_HELDOUT_SUITE,
  RegzAprReferencePolicy,
  generateRegzAprSuite,
  generateRegzAprTask,
  regzApr,
} from "./regz-apr/index.js";
import {
  FLEX_FINGERPRINT,
  FLEX_HELDOUT_SUITE,
  FlexReferencePolicy,
  expectedFlex,
  flexSpecTasks,
  flexmodTerms,
  generateFlexSuite,
  generateFlexTask,
  type FlexAnswer,
  type FlexTask,
} from "./flexmod/index.js";
import {
  PAYMENTS_FINGERPRINT,
  PAYMENTS_HELDOUT_SUITE,
  PaymentsReferencePolicy,
  expectedPayments,
  generatePaymentsSuite,
  generatePaymentsTask,
  paymentsPosting,
  paymentsSpecTasks,
  type PaymentsAnswer,
  type PaymentsTask,
} from "./payments/index.js";
import {
  ARM_FINGERPRINT,
  ARM_HELDOUT_SUITE,
  ArmReferencePolicy,
  armAdjustment,
  armSpecTasks,
  expectedArm,
  generateArmSuite,
  generateArmTask,
  type ArmAnswer,
  type ArmTask,
} from "./arm/index.js";

interface TaskCoordinates {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
}

/** What the runner needs of an environment: its tasks, its reference, and what a task should conclude. */
interface Bench<T extends TaskCoordinates, A = RefiAnswer> {
  readonly env: Environment<T, A>;
  readonly fingerprint:
    | typeof REFI_FINGERPRINT
    | typeof TAPE_FINGERPRINT
    | typeof POLICY_FINGERPRINT
    | typeof HARD_FINGERPRINT
    | typeof HARD_POLICY_FINGERPRINT
    | typeof ESCROW_FINGERPRINT
    | typeof REGZ_FINGERPRINT
    | typeof ESCROW_POLICY_FINGERPRINT
    | typeof REGZ_POLICY_FINGERPRINT
    | typeof HISTORY_FINGERPRINT
    | typeof REGZ_APR_FINGERPRINT
    | typeof FLEX_FINGERPRINT
    | typeof PAYMENTS_FINGERPRINT
    | typeof ARM_FINGERPRINT;
  readonly heldout: { readonly seed: number; readonly n: number };
  readonly suite: (split: Exclude<Split, "spec">, seed: number, n: number) => T[];
  readonly one: (split: Exclude<Split, "spec">, seed: number, index: number) => T;
  readonly spec: () => T[];
  readonly verdictOf: (task: T) => string;
  readonly reference: () => Policy;
}

const BENCHES = {
  "refi-review": {
    env: refiReview,
    fingerprint: REFI_FINGERPRINT,
    heldout: HELDOUT_SUITE,
    suite: generateSuite,
    one: generateTask,
    spec: specTasks,
    verdictOf: (t) => expectedReview(t).verdict,
    reference: () => new ReferencePolicy(),
  } satisfies Bench<ReturnType<typeof generateTask>>,
  "refi-tape": {
    env: refiTape,
    fingerprint: TAPE_FINGERPRINT,
    heldout: TAPE_HELDOUT_SUITE,
    suite: generateTapeSuite,
    one: generateTapeTask,
    spec: tapeSpecTasks,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  } satisfies Bench<ReturnType<typeof generateTapeTask>>,
  // refi-tape's tasks and reference, with the review stated as a policy.
  "refi-policy": {
    env: refiPolicy,
    fingerprint: POLICY_FINGERPRINT,
    heldout: TAPE_HELDOUT_SUITE,
    suite: generateTapeSuite,
    one: generateTapeTask,
    spec: tapeSpecTasks,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  } satisfies Bench<ReturnType<typeof generateTapeTask>>,
  // refi-tape's rules over tasks placed on their edges, and refi-policy's wording over the same.
  "refi-hard": {
    env: refiHard,
    fingerprint: HARD_FINGERPRINT,
    heldout: HARD_HELDOUT_SUITE,
    suite: generateHardSuite,
    one: generateHardTask,
    spec: tapeSpecTasks,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  } satisfies Bench<RefiTapeTask>,
  "refi-hard-policy": {
    env: refiHardPolicy,
    fingerprint: HARD_POLICY_FINGERPRINT,
    heldout: HARD_HELDOUT_SUITE,
    suite: generateHardSuite,
    one: generateHardTask,
    spec: tapeSpecTasks,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  } satisfies Bench<RefiTapeTask>,
  // The servicing app's annual escrow analysis, graded by its own engine.
  "escrow-analysis": {
    env: escrowAnalysis,
    fingerprint: ESCROW_FINGERPRINT,
    heldout: ESCROW_HELDOUT_SUITE,
    suite: generateEscrowSuite,
    one: generateEscrowTask,
    spec: escrowSpecTasks,
    verdictOf: (t) => expectedEscrow(t).decision,
    reference: () => new EscrowReferencePolicy(),
  } satisfies Bench<EscrowTask, EscrowAnswer>,
  // Regulation Z's price tests as the shadow AUS runs them, graded by it.
  "regz-price-tests": {
    env: regzPriceTests,
    fingerprint: REGZ_FINGERPRINT,
    heldout: REGZ_HELDOUT_SUITE,
    suite: generateRegzSuite,
    one: generateRegzTask,
    spec: () => [],
    verdictOf: (t) => {
      const a = expectedRegz(t);
      return `qm ${a.qm_status ?? "undecided"}`;
    },
    reference: () => new RegzReferencePolicy(),
  } satisfies Bench<RegzTask, RegzAnswer>,
  // The same two tasks, tools and graders, with the rules stated as policies.
  "escrow-policy": {
    env: escrowPolicy,
    fingerprint: ESCROW_POLICY_FINGERPRINT,
    heldout: ESCROW_HELDOUT_SUITE,
    suite: generateEscrowSuite,
    one: generateEscrowTask,
    spec: escrowSpecTasks,
    verdictOf: (t) => expectedEscrow(t).decision,
    reference: () => new EscrowReferencePolicy(),
  } satisfies Bench<EscrowTask, EscrowAnswer>,
  "regz-policy": {
    env: regzPolicy,
    fingerprint: REGZ_POLICY_FINGERPRINT,
    heldout: REGZ_HELDOUT_SUITE,
    suite: generateRegzSuite,
    one: generateRegzTask,
    spec: () => [],
    verdictOf: (t) => `qm ${expectedRegz(t).qm_status ?? "undecided"}`,
    reference: () => new RegzReferencePolicy(),
  } satisfies Bench<RegzTask, RegzAnswer>,
  // escrow-analysis from the account's ledger: last year and the balance read off it.
  "escrow-history": {
    env: escrowHistory,
    fingerprint: HISTORY_FINGERPRINT,
    heldout: HISTORY_HELDOUT_SUITE,
    suite: generateHistorySuite,
    one: generateHistoryTask,
    spec: () => [],
    verdictOf: (t) => expectedHistory(t).decision,
    reference: () => new HistoryReferencePolicy(),
  } satisfies Bench<EscrowHistoryTask, EscrowAnswer>,
  // regz-price-tests with the Appendix J solve taken out of the tools.
  "regz-apr": {
    env: regzApr,
    fingerprint: REGZ_APR_FINGERPRINT,
    heldout: REGZ_APR_HELDOUT_SUITE,
    suite: generateRegzAprSuite,
    one: generateRegzAprTask,
    spec: () => [],
    verdictOf: (t) => `qm ${expectedRegz(t).qm_status ?? "undecided"}`,
    reference: () => new RegzAprReferencePolicy(),
  } satisfies Bench<RegzTask, RegzAnswer>,
  // Fannie Mae's Flex Modification waterfall, graded by the servicing app's own engine.
  "flexmod-terms": {
    env: flexmodTerms,
    fingerprint: FLEX_FINGERPRINT,
    heldout: FLEX_HELDOUT_SUITE,
    suite: generateFlexSuite,
    one: generateFlexTask,
    spec: flexSpecTasks,
    verdictOf: (t) => expectedFlex(t).denial_reason ?? "offer",
    reference: () => new FlexReferencePolicy(),
  } satisfies Bench<FlexTask, FlexAnswer>,
  // A month of receipts and late-charge runs, graded by the servicing app's own cashiering.
  "payments-posting": {
    env: paymentsPosting,
    fingerprint: PAYMENTS_FINGERPRINT,
    heldout: PAYMENTS_HELDOUT_SUITE,
    suite: generatePaymentsSuite,
    one: generatePaymentsTask,
    spec: paymentsSpecTasks,
    verdictOf: (t) => {
      const a = expectedPayments(t);
      return a.receipts[0]?.outcome ?? a.late_charge_runs[0]?.outcome ?? "nothing";
    },
    reference: () => new PaymentsReferencePolicy(),
  } satisfies Bench<PaymentsTask, PaymentsAnswer>,
  // An ARM's rate and payment change and its Reg Z notice, graded by the servicing app's own two engines.
  "arm-adjustment": {
    env: armAdjustment,
    fingerprint: ARM_FINGERPRINT,
    heldout: ARM_HELDOUT_SUITE,
    suite: generateArmSuite,
    one: generateArmTask,
    spec: armSpecTasks,
    verdictOf: (t) => expectedArm(t).notice_template ?? "no notice",
    reference: () => new ArmReferencePolicy(),
  } satisfies Bench<ArmTask, ArmAnswer>,
};

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "refi-review" },
    policy: { type: "string", default: "reference" },
    split: { type: "string", default: "heldout" },
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

function suite<T extends TaskCoordinates, A>(bench: Bench<T, A>): T[] {
  const split = values.split;
  if (split === "spec") return bench.spec();
  if (split !== "train" && split !== "heldout")
    throw new Error(`--split must be train, heldout or spec`);
  const seed = Number(values.seed ?? (split === "heldout" ? bench.heldout.seed : 1));
  if (values.index !== undefined) return [bench.one(split, seed, Number(values.index))];
  const n = Number(values.n ?? (split === "heldout" ? bench.heldout.n : 50));
  return bench.suite(split, seed, n);
}

function policyOf(reference: () => Policy): Policy {
  if (values.policy === "reference") return reference();
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

async function run<T extends TaskCoordinates, A>(bench: Bench<T, A>): Promise<void> {
  const env = bench.env;
  const tasks = suite(bench);
  const policy = policyOf(bench.reference);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const out = values.out ?? `runs/${env.name}/${runId}.jsonl`;
  const recorder = new RunRecorder(out);
  const concurrency = Math.max(1, Number(values.concurrency));
  console.log(
    `${policy.id}: ${tasks.length} episodes of ${env.name} ${env.version}, ${values.split}, recorded to ${out}`,
  );

  const results: { task: T; pass: boolean; score: number; outcome: string }[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      const task = tasks[i] as T;
      const rendered = env.render(task);
      const result = await runEpisode(env, task, policy, DEFAULT_LIMITS);
      recorder.append({
        record_version: RECORD_VERSION,
        run_id: runId,
        ...bench.fingerprint,
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
    const v = bench.verdictOf(r.task);
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

async function main(): Promise<void> {
  if (values.env === "refi-review") return run(BENCHES["refi-review"]);
  if (values.env === "refi-tape") return run(BENCHES["refi-tape"]);
  if (values.env === "refi-policy") return run(BENCHES["refi-policy"]);
  if (values.env === "refi-hard") return run(BENCHES["refi-hard"]);
  if (values.env === "refi-hard-policy") return run(BENCHES["refi-hard-policy"]);
  if (values.env === "escrow-analysis") return run(BENCHES["escrow-analysis"]);
  if (values.env === "regz-price-tests") return run(BENCHES["regz-price-tests"]);
  if (values.env === "escrow-policy") return run(BENCHES["escrow-policy"]);
  if (values.env === "regz-policy") return run(BENCHES["regz-policy"]);
  if (values.env === "escrow-history") return run(BENCHES["escrow-history"]);
  if (values.env === "regz-apr") return run(BENCHES["regz-apr"]);
  if (values.env === "flexmod-terms") return run(BENCHES["flexmod-terms"]);
  if (values.env === "payments-posting") return run(BENCHES["payments-posting"]);
  if (values.env === "arm-adjustment") return run(BENCHES["arm-adjustment"]);
  throw new Error(`--env must be one of ${Object.keys(BENCHES).join(", ")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
