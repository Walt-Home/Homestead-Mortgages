/**
 * The environments, for a browser: every one the CLI runs, with its own
 * generator, rulebook, tools, parser, grader and reference, behind one plain
 * JSON interface on `globalThis.HMEnvironments`.
 *
 * Nothing here reimplements an environment. Each entry below names the
 * modules `src/cli.ts` registers for it, and every function hands its work to
 * them: `draw` is the environment's own generator, `grade` its own grader,
 * `solve` its reference policy run through `runEpisode`, the loop every
 * model is scored in. `scripts/build-playground.mjs` bundles this file, with
 * `node:crypto`, `node:fs` and `node:path` replaced by `shims/`.
 *
 * Only the train split and the spec's own cases are reachable. The held-out
 * suite is what every reported score is measured on, so `draw` refuses any
 * split but "train", and a task handed back with any other split is refused
 * before anything is generated. A train id is not enough either: 32-bit
 * stream seeds collide, so train coordinates whose stream a held-out task
 * draws from are refused too, by `src/heldout-guard.ts`, before generating.
 *
 * A task crosses to the page as its coordinates (a `TaskRef`), never as the
 * engine's object, because the engine's objects carry bigints; every value
 * that crosses is plain JSON.
 */

import {
  DEFAULT_LIMITS,
  runEpisode,
  type Environment,
  type Grade,
  type Parsed,
  type Policy,
  type ToolSpec,
} from "../src/episode.js";
import { drawsHeldoutStream } from "../src/heldout-guard.js";
import { toJsonLine } from "../src/record.js";
import {
  ReferencePolicy,
  SPEC_CASES,
  expectedAnswer,
  expectedReview,
  generateTask,
  refiReview,
  specTasks,
  taskId,
  taskPayload,
} from "../src/refi/index.js";
import {
  TapeReferencePolicy,
  expectedTapeAnswer,
  generateTapeTask,
  refiTape,
  tapePayload,
  tapeSpecTasks,
  tapeTaskId,
} from "../src/refi-tape/index.js";
import { refiPolicy } from "../src/refi-policy/index.js";
import { generateHardTask, hardTaskId, refiHard, refiHardPolicy } from "../src/refi-hard/index.js";
import {
  ESCROW_SPEC_CASES,
  EscrowReferencePolicy,
  escrowAnalysis,
  escrowPayload,
  escrowSpecTasks,
  escrowTaskId,
  expectedEscrow,
  generateEscrowTask,
} from "../src/escrow/index.js";
import { escrowPolicy } from "../src/escrow/policy-env.js";
import {
  HistoryReferencePolicy,
  escrowHistory,
  expectedHistory,
  generateHistoryTask,
  historyPayload,
  historyTaskId,
} from "../src/escrow-history/index.js";
import {
  RegzReferencePolicy,
  expectedRegz,
  generateRegzTask,
  regzPayload,
  regzPriceTests,
  regzTaskId,
} from "../src/regz/index.js";
import { regzPolicy } from "../src/regz/policy-env.js";
import {
  RegzAprReferencePolicy,
  generateRegzAprTask,
  regzApr,
  regzAprTaskId,
} from "../src/regz-apr/index.js";
import {
  FlexReferencePolicy,
  expectedFlex,
  flexPayload,
  flexSpecTasks,
  flexTaskId,
  flexmodTerms,
  generateFlexTask,
} from "../src/flexmod/index.js";
import {
  PaymentsReferencePolicy,
  expectedPayments,
  generatePaymentsTask,
  paymentsPayload,
  paymentsPosting,
  paymentsSpecTasks,
  paymentsTaskId,
} from "../src/payments/index.js";
import {
  ArmReferencePolicy,
  armAdjustment,
  armPayload,
  armSpecTasks,
  armTaskId,
  expectedArm,
  generateArmTask,
} from "../src/arm/index.js";
import {
  PayoffReferencePolicy,
  expectedPayoff,
  generatePayoffTask,
  payoffPayload,
  payoffSpecTasks,
  payoffStatement,
  payoffTaskId,
} from "../src/payoff/index.js";
import {
  AUS_SPEC_CASES,
  AusReferencePolicy,
  ausDecision,
  ausPayload,
  ausSpecTasks,
  ausTaskId,
  expectedAus,
  generateAusTask,
} from "../src/aus/index.js";

/* ── what crosses to the page ───────────────────────────────────────────── */

export type Side = "refinance" | "servicing" | "origination";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A task as the page holds it: its coordinates, from which it is rebuilt. */
export interface TaskRef {
  readonly env: string;
  readonly id: string;
  readonly split: "train" | "spec";
  readonly suite_seed: number;
  readonly index: number;
  /** A spec case's name, as the spec gives it; a training task has none. */
  readonly name?: string;
}

export interface SolvedCall {
  readonly name: string;
  readonly input: Json;
  /** The tool's answer; null for the submission that ended the episode, which has none. */
  readonly output: string | null;
  readonly is_error: boolean;
}

export interface Solution {
  readonly answer: Json;
  readonly outcome: string;
  readonly grade: Grade;
  readonly steps: readonly { readonly turn: number; readonly calls: readonly SolvedCall[] }[];
}

export type ParseResult =
  { readonly ok: true; readonly answer: Json } | { readonly ok: false; readonly error: string };

export interface PlaygroundEnvironment {
  readonly key: string;
  readonly title: string;
  readonly side: Side;
  readonly summary: string;
  readonly version: string;
  /** The system prompt: the rulebook, or the policy. */
  readonly rulebook: string;
  /** Every tool the model is given, the submit tool among them. */
  readonly tools: readonly ToolSpec[];
  readonly submitTool: string;
  /** A training task; refused for any other split, and for coordinates that draw a held-out task's stream. */
  draw(split: "train", seed: number, index: number): TaskRef;
  spec(): TaskRef[];
  /** The user prompt the model sees. */
  render(task: TaskRef): string;
  /** The task's data, exactly as the rendered prompt carries it. */
  payload(task: TaskRef): Record<string, Json>;
  /** Runs a tool other than the submit tool; throws on bad input, as the episode loop's tools do. */
  execute(name: string, input: unknown): string;
  /** Reads a submission strictly, as the episode loop does. */
  parse(raw: unknown): ParseResult;
  /** An answer (parse's, or null for none) held to the engine's, field by field. */
  grade(task: TaskRef, answer: unknown): Grade;
  /** The engine's answer. */
  expected(task: TaskRef): Json;
  /** The reference policy through the episode loop, read back from its transcript. */
  solve(task: TaskRef): Promise<Solution>;
  verdictOf(task: TaskRef): string;
}

/** JSON with bigints as strings, the run records' own serializer. */
const plain = <T = Json>(value: unknown): T =>
  (value === undefined ? null : JSON.parse(toJsonLine(value))) as T;

const REFUSED =
  "the playground offers the train split and the spec's own tasks only: the held-out suite is what every reported score is measured on";

const COLLIDES = (seed: number, index: number): string =>
  `Seed ${seed}, index ${index} draws from the same seeded stream as a held-out task. The held-out suite is what every reported score is measured on, so these coordinates are not offered. Try another index.`;

const wholeNumber = (n: unknown, what: string): number => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${what} must be a whole number, 0 or more`);
  return n;
};

/* ── each environment, from its own modules ─────────────────────────────── */

interface Coordinates {
  readonly id: string;
  readonly split: "train" | "heldout" | "spec";
  readonly suite_seed: number;
  readonly index: number;
}

interface Definition<T extends Coordinates, A> {
  readonly env: Environment<T, A>;
  readonly title: string;
  readonly side: Side;
  readonly summary: string;
  /** The generator's own task id, so coordinates are checked before anything is drawn. */
  readonly id: (split: "train", seed: number, index: number) => string;
  readonly one: (split: "train", seed: number, index: number) => T;
  readonly spec: () => T[];
  /** Each spec case's name, in the order `spec` returns them. */
  readonly specNames: readonly string[];
  readonly payload: (task: T) => Record<string, unknown>;
  readonly expected: (task: T) => unknown;
  readonly verdictOf: (task: T) => string;
  readonly reference: () => Policy;
}

/** Tasks rebuilt recently, so a page that grades what it just drew does not draw it twice. */
const CACHE_SIZE = 256;

function playground<T extends Coordinates, A>(d: Definition<T, A>): PlaygroundEnvironment {
  const { env } = d;
  const cache = new Map<string, T>();
  const remember = (task: T): T => {
    cache.delete(task.id);
    cache.set(task.id, task);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return task;
  };
  const refOf = (task: T): TaskRef => {
    if (task.split !== "train" && task.split !== "spec") throw new Error(REFUSED);
    const name = task.split === "spec" ? d.specNames[task.index] : undefined;
    return {
      env: env.name,
      id: task.id,
      split: task.split,
      suite_seed: task.suite_seed,
      index: task.index,
      ...(name ? { name } : {}),
    };
  };
  /** A training task, refused before it is drawn when its stream is a held-out task's. */
  const train = (seed: number, index: number): T => {
    const id = d.id("train", seed, index);
    if (drawsHeldoutStream(id)) throw new Error(COLLIDES(seed, index));
    const task = d.one("train", seed, index);
    if (task.id !== id) throw new Error(`${env.name} drew ${task.id} at the coordinates of ${id}`);
    return task;
  };
  const specAt = (index: number): T => {
    const task = d.spec()[index];
    if (!task) throw new RangeError(`${env.name} has no spec task ${index}`);
    return task;
  };
  const resolve = (ref: TaskRef): T => {
    if (!ref || typeof ref !== "object")
      throw new TypeError("a task is what draw() or spec() returned");
    if (ref.env !== env.name)
      throw new Error(`that task is ${String(ref.env)}'s, not ${env.name}'s`);
    if (ref.split !== "train" && ref.split !== "spec") throw new Error(REFUSED);
    const seed = wholeNumber(ref.suite_seed, "suite_seed");
    const index = wholeNumber(ref.index, "index");
    if (ref.split === "train" && ref.id !== d.id("train", seed, index))
      throw new Error(`no task ${String(ref.id)} at those coordinates`);
    const hit = cache.get(ref.id);
    if (hit && hit.split === ref.split && hit.suite_seed === seed && hit.index === index)
      return remember(hit);
    const task = ref.split === "train" ? train(seed, index) : specAt(index);
    if (task.id !== ref.id || task.split !== ref.split)
      throw new Error(`no task ${String(ref.id)} at those coordinates`);
    return remember(task);
  };
  const parse = (raw: unknown): ParseResult => {
    const parsed: Parsed<A> = env.parseAnswer(raw);
    return parsed.ok ? { ok: true, answer: plain(parsed.answer) } : parsed;
  };

  return Object.freeze({
    key: env.name,
    title: d.title,
    side: d.side,
    summary: d.summary,
    version: env.version,
    rulebook: env.system,
    tools: plain<ToolSpec[]>(env.tools),
    submitTool: env.submitTool,
    draw(split: "train", seed: number, index: number): TaskRef {
      if (split !== "train") throw new Error(REFUSED);
      return refOf(remember(train(wholeNumber(seed, "seed"), wholeNumber(index, "index"))));
    },
    spec: (): TaskRef[] => d.spec().map((t) => refOf(remember(t))),
    render: (task: TaskRef): string => env.render(resolve(task)),
    payload: (task: TaskRef) => plain<Record<string, Json>>(d.payload(resolve(task))),
    execute: (name: string, input: unknown): string => env.execute(name, input),
    parse,
    grade(task: TaskRef, answer: unknown): Grade {
      const t = resolve(task);
      if (answer === null || answer === undefined) return plain(env.grade(t, null));
      // Read again, so an answer the page built or edited is held to the same parser a model's is.
      const parsed = env.parseAnswer(answer);
      if (!parsed.ok) throw new TypeError(parsed.error);
      return plain(env.grade(t, parsed.answer));
    },
    expected: (task: TaskRef): Json => plain(d.expected(resolve(task))),
    async solve(task: TaskRef): Promise<Solution> {
      const result = await runEpisode(env, resolve(task), d.reference(), DEFAULT_LIMITS);
      if (result.error) throw new Error(result.error);
      // Each turn's calls, then the observations the loop answered them with, matched by call id.
      const byId = new Map<string, { -readonly [K in keyof SolvedCall]: SolvedCall[K] }>();
      const steps: { turn: number; calls: SolvedCall[] }[] = [];
      for (const entry of result.transcript) {
        if (entry.kind === "turn") {
          steps.push({
            turn: entry.turn,
            calls: entry.calls.map((c) => {
              const call = { name: c.name, input: plain(c.input), output: null, is_error: false };
              byId.set(c.id, call);
              return call;
            }),
          });
        } else {
          for (const o of entry.observations) {
            const call = byId.get(o.call_id);
            if (!call) continue;
            call.output = o.content;
            call.is_error = o.is_error;
          }
        }
      }
      return {
        answer: plain(result.answer),
        outcome: result.outcome,
        grade: plain(result.grade),
        steps,
      };
    },
    verdictOf: (task: TaskRef): string => d.verdictOf(resolve(task)),
  });
}

/* ── the registry: cli.ts's BENCHES, in its order ───────────────────────── */

const regzVerdict = (t: Parameters<typeof expectedRegz>[0]) =>
  `qm ${expectedRegz(t).qm_status ?? "undecided"}`;

/** refi-tape's one spec case, which the policy and edge environments draw as theirs. */
const TAPE_SPEC = ["worked example 1, as our loan record and a clean tape"];
const TAPE_SPEC_ELSEWHERE = ["refi-tape's worked example 1"];
const TAPE_SPEC_ON_THE_EDGES = ["refi-tape's worked example 1, not on an edge"];

/** §7.2's Plan 4927 loan and its test cases, in the order `armSpecTasks` builds them. */
const ARM_SPEC = [
  "7.2 worked example: 3.64883 + 2.750 rounds to 6.375%, sent in its window (with 7.3's initial notice)",
  "T1: no print on the index date",
  "T3: the cap variant, 7.85 rounds to 7.875 and is capped at 7.750",
  "T2: an index on an eighth's midpoint, rounded half down",
  "T2: the same midpoint, rounded half up",
  "T5: sent a day late",
  "T5: proposed before the window opens",
  "The second change, on 2027-05-01",
  "T6: a monthly legacy loan's 25-day deadline",
  "T11: an FDCPA cease on file",
];

/** The spec's payoff examples, in the order `payoffSpecTasks` builds them. */
const PAYOFF_SPEC = [
  "16.1 example A: Ohio, the funds a week early",
  "16.1 example A: the statement's amount, late (16.1-T2)",
  "16.1 example B: deferred principal, paid on the good-through",
  "16.2 worked example: A/A",
  "16.2: the same loan, S/A",
  "16.2: the same loan, S/S in an MBS pool",
  "16.2: an S/S MBS payoff processed on the first business day",
  "7.6: the Texas statement",
  "7.6: the same statement in Florida",
  "16.1-T7: Massachusetts",
  "16.1-T11: Connecticut, five business days",
  "16.2-T4: $30.00 short",
  "16.2-T5: Florida, short within the good-through",
  "16.1-T3: a Sunday due date and Monday's funds",
  "16.1-T4: example A on daily simple interest",
];

/** The spec's §2 examples, in the order `paymentsSpecTasks` builds them. */
const PAYMENTS_SPEC = [
  "Example A: a full payment",
  "Examples K and M: paid after the grace end, then October on time",
  "Example D: the $50 rule",
  "Example F: a curtailment with the payment, then October's smaller interest",
  'Example G: "principal only" on a delinquent loan',
  "Example L: the transfer shield, credited on receipt",
  "Example N: a forbearance defaulted in November",
];

export const ENVIRONMENTS: readonly PlaygroundEnvironment[] = Object.freeze([
  playground({
    env: refiReview,
    title: "Refinance review",
    side: "refinance",
    summary:
      "One loan as the daily refinance review sees it, with the day's quoted 30-year rate, if there is one, and the loan's offer history. The model gives the verdict and its reasons, every disclosure figure to the cent for a candidate, and the watch rate for a watched loan.",
    id: taskId,
    one: generateTask,
    spec: specTasks,
    specNames: SPEC_CASES.map((c) => c.name),
    payload: taskPayload,
    expected: (t) => expectedAnswer(expectedReview(t)),
    verdictOf: (t) => expectedReview(t).verdict,
    reference: () => new ReferencePolicy(),
  }),
  playground({
    env: refiTape,
    title: "Refinance review from the tape",
    side: "refinance",
    summary:
      "The same review, starting from our loan record and the servicer's newest tape instead of the cleaned row. The model reads the loan off the tape first, and a loan the tape cannot describe (no first payment date, balance or value) takes the verdict not_reviewable.",
    id: tapeTaskId,
    one: generateTapeTask,
    spec: tapeSpecTasks,
    specNames: TAPE_SPEC,
    payload: tapePayload,
    expected: expectedTapeAnswer,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  }),
  playground({
    env: refiPolicy,
    title: "Refinance review, as a policy",
    side: "refinance",
    summary:
      "The tape review's tasks, tools and grader, with the rules written as a policy: by topic, in defined terms, with no order of work given.",
    id: tapeTaskId,
    one: generateTapeTask,
    spec: tapeSpecTasks,
    specNames: TAPE_SPEC_ELSEWHERE,
    payload: tapePayload,
    expected: expectedTapeAnswer,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  }),
  playground({
    env: refiHard,
    title: "Refinance review on the edges",
    side: "refinance",
    summary:
      "The tape review over loans placed on one of ten rule edges, such as the rate floor, the cash-back cap, an LTV limit, the age of a value or the Massachusetts window, each on one side of it, so one slip changes the answer.",
    id: hardTaskId,
    one: generateHardTask,
    spec: tapeSpecTasks,
    specNames: TAPE_SPEC_ON_THE_EDGES,
    payload: tapePayload,
    expected: expectedTapeAnswer,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  }),
  playground({
    env: refiHardPolicy,
    title: "Refinance edges, as a policy",
    side: "refinance",
    summary:
      "The edge tasks with the review stated as a policy, so what the edges cost and what the wording costs can be told apart.",
    id: hardTaskId,
    one: generateHardTask,
    spec: tapeSpecTasks,
    specNames: TAPE_SPEC_ON_THE_EDGES,
    payload: tapePayload,
    expected: expectedTapeAnswer,
    verdictOf: (t) => expectedTapeAnswer(t).verdict,
    reference: () => new TapeReferencePolicy(),
  }),
  playground({
    env: escrowAnalysis,
    title: "Escrow analysis",
    side: "servicing",
    summary:
      "One escrowed loan's annual escrow analysis under RESPA: project the year, find the low point, set the cushion, decide balanced, refund, credit, retain or shortage, and set the new payment. 24 fields, graded by the servicing app's own engine.",
    id: escrowTaskId,
    one: generateEscrowTask,
    spec: escrowSpecTasks,
    specNames: ESCROW_SPEC_CASES.map((c) => c.name),
    payload: escrowPayload,
    expected: expectedEscrow,
    verdictOf: (t) => expectedEscrow(t).decision,
    reference: () => new EscrowReferencePolicy(),
  }),
  playground({
    env: regzPriceTests,
    title: "Reg Z price tests",
    side: "origination",
    summary:
      "One quoted loan through Regulation Z's price tests as the shadow AUS runs them: the General QM price and points-and-fees tests, the higher-priced mortgage test, the HOEPA triggers and a refinance's net tangible benefit. 16 fields: the eight figures the tests stand on, and each test's answer, which can be that it cannot be decided.",
    id: regzTaskId,
    one: generateRegzTask,
    spec: () => [],
    specNames: [],
    payload: regzPayload,
    expected: expectedRegz,
    verdictOf: regzVerdict,
    reference: () => new RegzReferencePolicy(),
  }),
  playground({
    env: escrowPolicy,
    title: "Escrow analysis, as a policy",
    side: "servicing",
    summary:
      "The escrow analysis's tasks, tools and grader, with the rules written as a policy by topic, with no order of work given.",
    id: escrowTaskId,
    one: generateEscrowTask,
    spec: escrowSpecTasks,
    specNames: ESCROW_SPEC_CASES.map((c) => c.name),
    payload: escrowPayload,
    expected: expectedEscrow,
    verdictOf: (t) => expectedEscrow(t).decision,
    reference: () => new EscrowReferencePolicy(),
  }),
  playground({
    env: regzPolicy,
    title: "Reg Z price tests, as a policy",
    side: "origination",
    summary:
      "The price tests' quotes, tools and grader, with the tests written as a policy by topic, with no order of work given.",
    id: regzTaskId,
    one: generateRegzTask,
    spec: () => [],
    specNames: [],
    payload: regzPayload,
    expected: expectedRegz,
    verdictOf: regzVerdict,
    reference: () => new RegzReferencePolicy(),
  }),
  playground({
    env: escrowHistory,
    title: "Escrow analysis from the ledger",
    side: "servicing",
    summary:
      "The escrow analysis started from the account's ledger: the model reads last year's figures and the run-date balance off the postings since the account's opening balance, thirteen months before the new year, then runs the analysis.",
    id: historyTaskId,
    one: generateHistoryTask,
    spec: () => [],
    specNames: [],
    payload: historyPayload,
    expected: expectedHistory,
    verdictOf: (t) => expectedHistory(t).decision,
    reference: () => new HistoryReferencePolicy(),
  }),
  playground({
    env: regzApr,
    title: "Reg Z with the APR searched",
    side: "origination",
    summary:
      "The price tests with the APR solve taken out of the tools: the model finds the APR itself, searching with the present-value tool, and every price test stands on what it finds.",
    id: regzAprTaskId,
    one: generateRegzAprTask,
    spec: () => [],
    specNames: [],
    payload: regzPayload,
    expected: expectedRegz,
    verdictOf: regzVerdict,
    reference: () => new RegzAprReferencePolicy(),
  }),
  playground({
    env: flexmodTerms,
    title: "Flex Modification",
    side: "servicing",
    summary:
      "One delinquent Fannie Mae loan evaluated for a Flex Modification: the prechecks, the five-step waterfall and eligibility, and for an offer the trial plan and the modification's dates. 22 fields, graded by the servicing app's own waterfall.",
    id: flexTaskId,
    one: generateFlexTask,
    spec: flexSpecTasks,
    specNames: ["12.8 worked example: $250,000 at 6.500%, 51 payments made, 8 behind"],
    payload: flexPayload,
    expected: expectedFlex,
    verdictOf: (t) => expectedFlex(t).denial_reason ?? "offer",
    reference: () => new FlexReferencePolicy(),
  }),
  playground({
    env: paymentsPosting,
    title: "Payment posting",
    side: "servicing",
    summary:
      "One loan's receipts over a window of four weeks to about two months, posted the way the servicing app's cashiering posts them: each day's late-charge run, then that day's receipts through the waterfall, and where the loan stands at the end.",
    id: paymentsTaskId,
    one: generatePaymentsTask,
    spec: paymentsSpecTasks,
    specNames: PAYMENTS_SPEC,
    payload: paymentsPayload,
    expected: expectedPayments,
    verdictOf: (t) => {
      const a = expectedPayments(t);
      return a.receipts[0]?.outcome ?? a.late_charge_runs[0]?.outcome ?? "nothing";
    },
    reference: () => new PaymentsReferencePolicy(),
  }),
  playground({
    env: armAdjustment,
    title: "ARM rate change",
    side: "servicing",
    summary:
      "One adjustable-rate loan on one change date: find the index print, round and cap the new rate, amortize the scheduled balance, set the new payment, and decide which Reg Z notice goes, when its window opens and whether the proposed send is on time. Graded by the servicing app's two ARM engines, which must agree.",
    id: armTaskId,
    one: generateArmTask,
    spec: armSpecTasks,
    specNames: ARM_SPEC,
    payload: armPayload,
    expected: expectedArm,
    verdictOf: (t) => expectedArm(t).notice_template ?? "no notice",
    reference: () => new ArmReferencePolicy(),
  }),
  playground({
    env: payoffStatement,
    title: "Payoff statement",
    side: "servicing",
    summary:
      "One loan's written payoff request: the statement's deadline and how long it is good, the payoff interest, per diem and total, the figure if the next installment posts, what happens to funds that arrive early or late, and the share owed to Fannie Mae by remittance type. Graded by the servicing app's own payoff engine.",
    id: payoffTaskId,
    one: generatePayoffTask,
    spec: payoffSpecTasks,
    specNames: PAYOFF_SPEC,
    payload: payoffPayload,
    expected: expectedPayoff,
    verdictOf: (t) => expectedPayoff(t).disposition,
    reference: () => new PayoffReferencePolicy(),
  }),
  playground({
    env: ausDecision,
    title: "Underwriting decision",
    side: "origination",
    summary:
      "One loan file decided the way the shadow AUS decides it: the scores and seasoning, income and debt-to-income, loan-to-value, funds to close and reserves, contributions, the Regulation Z price tests and a refinance's net tangible benefit, then the findings, what could not be computed, the recommendation and the outcome. Graded by the engine itself.",
    id: ausTaskId,
    one: generateAusTask,
    spec: ausSpecTasks,
    specNames: AUS_SPEC_CASES.map((c) => c.name),
    payload: ausPayload,
    expected: expectedAus,
    verdictOf: (t) => expectedAus(t).outcome,
    reference: () => new AusReferencePolicy(),
  }),
]);

export interface Playground {
  /** The splits a page may draw from. */
  readonly splits: readonly ("train" | "spec")[];
  /** The episode loop's budget, the one every run is held to. */
  readonly limits: { readonly maxTurns: number; readonly maxToolCalls: number };
  readonly environments: readonly PlaygroundEnvironment[];
  get(key: string): PlaygroundEnvironment;
  /** Whether a task id, of any version, draws from a stream a held-out task draws from; the build reads it. */
  drawsHeldoutStream(id: string): boolean;
}

export const HMEnvironments: Playground = Object.freeze({
  splits: Object.freeze(["train", "spec"] as const),
  limits: Object.freeze({ ...DEFAULT_LIMITS }),
  environments: ENVIRONMENTS,
  drawsHeldoutStream,
  get(key: string): PlaygroundEnvironment {
    const env = ENVIRONMENTS.find((e) => e.key === key);
    if (!env) throw new Error(`no environment ${JSON.stringify(key)}`);
    return env;
  },
});

(globalThis as { HMEnvironments?: Playground }).HMEnvironments = HMEnvironments;
