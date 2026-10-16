/**
 * One episode: a policy, a task, the tools, and a grade at the end.
 *
 * The loop is the environment's, not the model's: it owns the tool budget,
 * runs every tool itself, takes the answer only through the submit tool,
 * and grades with a function the policy never sees. A policy is anything
 * that turns observations into tool calls — a model behind an API, or the
 * scripted reference that proves a task can be solved with the tools alone —
 * so the same loop scores both, and nothing about a provider leaks in here.
 */

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface Observation {
  readonly call_id: string;
  readonly content: string;
  readonly is_error: boolean;
}

export type TurnStop = "tool_calls" | "end" | "refusal" | "max_tokens";

export interface Usage {
  readonly input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly output_tokens: number;
}
export const NO_USAGE: Usage = {
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
};

export interface PolicyTurn {
  readonly calls: readonly ToolCall[];
  readonly text: string;
  readonly stop: TurnStop;
  readonly usage?: Usage;
}

export interface EpisodeStart {
  readonly system: string;
  readonly user: string;
  readonly tools: readonly ToolSpec[];
}

export interface PolicySession {
  /** The next turn, given the observations from the last one (none on the first). */
  act(observations: readonly Observation[]): Promise<PolicyTurn>;
}

export interface Policy {
  /** What the record calls it: `reference`, or `anthropic:<model>:<effort>`. */
  readonly id: string;
  start(episode: EpisodeStart): PolicySession;
}

export interface FieldGrade {
  readonly field: string;
  readonly expected: string;
  readonly got: string | null;
  readonly ok: boolean;
}

export interface Grade {
  readonly pass: boolean;
  readonly score: number;
  readonly fields: readonly FieldGrade[];
}

export type Parsed<A> =
  { readonly ok: true; readonly answer: A } | { readonly ok: false; readonly error: string };

/** What an environment hands the loop. `T` is a task, `A` an answer. */
export interface Environment<T, A> {
  readonly name: string;
  readonly version: string;
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly submitTool: string;
  render(task: T): string;
  /** Runs a non-submit tool. Throwing is an error observation, never a crash. */
  execute(name: string, input: unknown): string;
  parseAnswer(input: unknown): Parsed<A>;
  grade(task: T, answer: A | null): Grade;
}

export type Outcome =
  | "submitted"
  | "no_submission"
  | "max_turns"
  | "max_tool_calls"
  | "refusal"
  | "max_tokens"
  | "error";

export type TranscriptEntry =
  | {
      readonly kind: "turn";
      readonly turn: number;
      readonly text: string;
      readonly calls: readonly ToolCall[];
      readonly stop: TurnStop;
    }
  | {
      readonly kind: "observations";
      readonly turn: number;
      readonly observations: readonly Observation[];
    };

export interface EpisodeResult<A> {
  readonly outcome: Outcome;
  readonly answer: A | null;
  readonly grade: Grade;
  readonly turns: number;
  readonly tool_calls: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly usage: Usage;
  readonly error: string | null;
  readonly started_at: string;
  readonly finished_at: string;
}

export interface EpisodeLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}
/** A full review is about forty tool calls; a model that makes one per turn needs room for all of them. */
export const DEFAULT_LIMITS: EpisodeLimits = { maxTurns: 80, maxToolCalls: 160 };

export async function runEpisode<T, A>(
  env: Environment<T, A>,
  task: T,
  policy: Policy,
  limits: EpisodeLimits = DEFAULT_LIMITS,
): Promise<EpisodeResult<A>> {
  const started_at = new Date().toISOString();
  const transcript: TranscriptEntry[] = [];
  const usage = { ...NO_USAGE };
  let answer: A | null = null;
  let outcome: Outcome = "max_turns";
  let toolCalls = 0;
  let turns = 0;
  let error: string | null = null;
  let observations: Observation[] = [];

  try {
    const session = policy.start({ system: env.system, user: env.render(task), tools: env.tools });
    for (; turns < limits.maxTurns;) {
      const turn = await session.act(observations);
      turns += 1;
      const u = turn.usage ?? NO_USAGE;
      usage.input_tokens += u.input_tokens;
      usage.cache_read_input_tokens += u.cache_read_input_tokens;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
      usage.output_tokens += u.output_tokens;
      transcript.push({
        kind: "turn",
        turn: turns,
        text: turn.text,
        calls: turn.calls,
        stop: turn.stop,
      });
      if (turn.stop === "refusal" || turn.stop === "max_tokens") {
        outcome = turn.stop;
        break;
      }
      if (turn.calls.length === 0) {
        outcome = "no_submission";
        break;
      }
      observations = [];
      for (const call of turn.calls) {
        if (answer !== null) break;
        toolCalls += 1;
        if (toolCalls > limits.maxToolCalls) {
          outcome = "max_tool_calls";
          break;
        }
        if (call.name === env.submitTool) {
          const parsed = env.parseAnswer(call.input);
          if (parsed.ok) answer = parsed.answer;
          else observations.push({ call_id: call.id, content: parsed.error, is_error: true });
          continue;
        }
        try {
          observations.push({
            call_id: call.id,
            content: env.execute(call.name, call.input),
            is_error: false,
          });
        } catch (e) {
          observations.push({
            call_id: call.id,
            content: e instanceof Error ? e.message : String(e),
            is_error: true,
          });
        }
      }
      if (answer !== null) {
        outcome = "submitted";
        break;
      }
      if (outcome === "max_tool_calls") break;
      transcript.push({ kind: "observations", turn: turns, observations });
    }
  } catch (e) {
    outcome = "error";
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    outcome,
    answer,
    grade: env.grade(task, answer),
    turns,
    tool_calls: toolCalls,
    transcript,
    usage,
    error,
    started_at,
    finished_at: new Date().toISOString(),
  };
}
