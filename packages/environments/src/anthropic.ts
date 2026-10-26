/**
 * A Claude model as a policy, over the Messages API.
 *
 * A manual loop rather than the SDK's tool runner, because the environment
 * owns the loop: it runs the tools, counts the budget and ends the episode.
 * The history is append-only — every response's whole content goes back as
 * the assistant turn, every tool result for a turn goes back in one user
 * message — which is what the API's thinking and caching both assume.
 *
 * Every turn streams, read whole through the SDK's `finalMessage()`. The SDK
 * refuses to send a request it is not streaming when its `max_tokens` could
 * take longer than ten minutes to write (above about 21,333 tokens), so at
 * the 32,000-token budget boarding-triage, tape-intake and contact-audit
 * declare, every unstreamed episode ended in an error without a request
 * leaving the machine. Streamed, the response's headers come at once, so a
 * long turn is not left to Node fetch's wait for them either, which is why
 * the open-model policy (`src/vertex.ts`) streams too.
 *
 * A turn is the stream's final message, and a stream that ends before its
 * `message_stop` has none: `finalMessage()` rejects, and the episode ends
 * `error`, a transport error that `--resume` runs again, never a turn the
 * model ended. Nothing is appended to the history until a turn has arrived
 * whole.
 *
 * No refusal fallback: a fallback would answer with a different model and
 * the score would be credited to the one that refused. A refusal is an
 * outcome of the episode, recorded as such and scored as a miss.
 */

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_OUTPUT_BUDGET } from "./episode.js";
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

/**
 * What the policy asks of a client: the SDK's `messages.stream`, read whole.
 * Anthropic's client and its Vertex client both have it as they stand; the
 * Vertex wrapper (`vertexClaudeClient`) and a test stand one in.
 */
export interface ClaudeClient {
  readonly messages: {
    stream(params: Anthropic.MessageStreamParams): {
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export interface AnthropicPolicyOptions {
  readonly client?: ClaudeClient;
  readonly model?: string;
  readonly effort?: Effort;
  /** Output tokens per turn, thinking included; `DEFAULT_OUTPUT_BUDGET` unless asked. */
  readonly maxTokens?: number;
  /** Where the model is served, for the record's policy id: `anthropic` (the API) or `anthropic-vertex`. */
  readonly provider?: string;
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
  private readonly client: ClaudeClient;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;

  constructor(opts: AnthropicPolicyOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? DEFAULT_OUTPUT_BUDGET;
    // A budget other than the default is in the id, as the Vertex policy's
    // is, so a run record says which budget its episodes had; pricing reads
    // the id by its prefix.
    this.id = `${opts.provider ?? "anthropic"}:${this.model}:${this.effort}${
      this.maxTokens === DEFAULT_OUTPUT_BUDGET ? "" : `:max-tokens-${this.maxTokens}`
    }`;
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
        const response = await this.client.messages
          .stream({
            model: this.model,
            max_tokens: this.maxTokens,
            // The conversation grows by one turn at a time, so the history
            // up to the newest block is cached too, not only the rulebook.
            cache_control: { type: "ephemeral" },
            system,
            tools,
            messages,
            output_config: { effort: this.effort },
          })
          .finalMessage();
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
