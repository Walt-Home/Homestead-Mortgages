/**
 * A Claude model as a policy, over the Messages API.
 *
 * A manual loop rather than the SDK's tool runner, because the environment
 * owns the loop: it runs the tools, counts the budget and ends the episode.
 * The history is append-only — every response's whole content goes back as
 * the assistant turn, every tool result for a turn goes back in one user
 * message — which is what the API's thinking and caching both assume.
 *
 * No refusal fallback: a fallback would answer with a different model and
 * the score would be credited to the one that refused. A refusal is an
 * outcome of the episode, recorded as such and scored as a miss.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  EpisodeStart,
  Observation,
  Policy,
  PolicySession,
  PolicyTurn,
  TurnStop,
} from "./episode.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicPolicyOptions {
  /** Anything with the SDK's `messages.create`, so a test can stand one in. */
  readonly client?: Pick<Anthropic, "messages">;
  readonly model?: string;
  readonly effort?: Effort;
  readonly maxTokens?: number;
}

const stopOf = (reason: Anthropic.Message["stop_reason"]): TurnStop =>
  reason === "tool_use"
    ? "tool_calls"
    : reason === "refusal"
      ? "refusal"
      : reason === "max_tokens"
        ? "max_tokens"
        : "end";

export class AnthropicPolicy implements Policy {
  readonly id: string;
  private readonly client: Pick<Anthropic, "messages">;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;

  constructor(opts: AnthropicPolicyOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? 16000;
    this.id = `anthropic:${this.model}:${this.effort}`;
  }

  start(episode: EpisodeStart): PolicySession {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: episode.user }];
    // The rulebook and the tools are the same for every task: the stable
    // prefix, cached; the task is the only thing that differs.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: episode.system, cache_control: { type: "ephemeral" } },
    ];
    const tools = episode.tools.map((t): Anthropic.Tool => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));
    return {
      act: async (observations: readonly Observation[]): Promise<PolicyTurn> => {
        if (observations.length > 0) {
          messages.push({
            role: "user",
            content: observations.map((o): Anthropic.ToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: o.call_id,
              content: o.content,
              ...(o.is_error ? { is_error: true } : {}),
            })),
          });
        }
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system,
          tools,
          messages,
          output_config: { effort: this.effort },
        });
        messages.push({ role: "assistant", content: response.content });
        return {
          calls: response.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, input: b.input })),
          text: response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
          stop: stopOf(response.stop_reason),
          usage: {
            input_tokens: response.usage.input_tokens,
            cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
            output_tokens: response.usage.output_tokens,
          },
        };
      },
    };
  }
}
