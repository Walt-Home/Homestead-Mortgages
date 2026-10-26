/**
 * The Claude policy against a stand-in client: what it sends, and what it
 * does with what comes back. No network, no key, no spend.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicPolicy } from "../anthropic.js";
import { runEpisode } from "../episode.js";
import { SUBMIT_TOOL, refiReview, specTasks } from "../refi/index.js";

const [workedExample] = specTasks();
if (!workedExample) throw new Error("no spec tasks");

type Params = Anthropic.MessageCreateParamsNonStreaming;

/** A client that answers from a script and keeps every request it was sent. */
function fakeClient(replies: Partial<Anthropic.Message>[]) {
  const sent: Params[] = [];
  const client = {
    messages: {
      create: async (params: Params) => {
        sent.push(structuredClone(params));
        const reply = replies.shift();
        if (!reply) throw new Error("the script ran out");
        return {
          id: "msg",
          type: "message",
          role: "assistant",
          model: params.model,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
          },
          ...reply,
        };
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, sent };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});

describe("the Claude policy", () => {
  it("sends the rulebook as a cached system prompt, appends every turn whole, and batches tool results", async () => {
    const { client, sent } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Two figures first.", citations: null },
          toolUse("t1", "per_diem", { balance_cents: "55310641", annual_rate_pct: "7.000" }),
          toolUse("t2", "date_add", { date: "2026-10-01", days: 36 }),
        ] as Anthropic.ContentBlock[],
      },
      {
        stop_reason: "tool_use",
        content: [
          toolUse("t3", SUBMIT_TOOL, {
            verdict: "watching",
            reasons: [],
            offer: null,
            watch_rate_pct: null,
          }),
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const r = await runEpisode(
      refiReview,
      workedExample,
      new AnthropicPolicy({ client, model: "claude-opus-5-5", effort: "high" }),
    );

    expect(r.outcome).toBe("submitted");
    expect(sent).toHaveLength(2);
    const [first, second] = sent as [Params, Params];
    expect(first.system).toEqual([
      { type: "text", text: refiReview.system, cache_control: { type: "ephemeral" } },
    ]);
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.tool_choice).toBeUndefined();
    expect(first.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual(
      refiReview.tools.map((t) => t.name),
    );
    // The second request is the first's history plus the assistant turn as sent, then ONE user message of results.
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text" }, { id: "t1" }, { id: "t2" }],
    });
    expect(second.messages[2]).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: '{"per_diem_cents":"10608"}' },
        { type: "tool_result", tool_use_id: "t2", content: '{"date":"2026-11-06"}' },
      ],
    });
    expect(r.usage).toEqual({
      input_tokens: 20,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
    });
  });

  it("records a refusal as the outcome, with no fallback to another model", async () => {
    const { client, sent } = fakeClient([{ stop_reason: "refusal", content: [] }]);
    const r = await runEpisode(refiReview, workedExample, new AnthropicPolicy({ client }));
    expect(r).toMatchObject({ outcome: "refusal", grade: { pass: false } });
    expect(sent[0]).not.toHaveProperty("fallbacks");
  });

  it("names a budget other than the default in its id, as the Vertex policy does, and sends it", async () => {
    const { client: idle } = fakeClient([]);
    expect(new AnthropicPolicy({ client: idle }).id).toBe("anthropic:claude-opus-5-5:high");
    expect(new AnthropicPolicy({ client: idle, maxTokens: 16000 }).id).toBe(
      "anthropic:claude-opus-5-5:high",
    );
    expect(
      new AnthropicPolicy({ client: idle, provider: "anthropic-vertex", effort: "max" }).id,
    ).toBe("anthropic-vertex:claude-opus-5-5:max");
    expect(
      new AnthropicPolicy({ client: idle, provider: "anthropic-vertex", maxTokens: 32000 }).id,
    ).toBe("anthropic-vertex:claude-opus-5-5:high:max-tokens-32000");

    const { client, sent } = fakeClient([{ stop_reason: "end_turn", content: [] }]);
    const wide = new AnthropicPolicy({ client, maxTokens: 32000 });
    expect(wide.id).toBe("anthropic:claude-opus-5-5:high:max-tokens-32000");
    await runEpisode(refiReview, workedExample, wide);
    expect(sent[0]).toMatchObject({ max_tokens: 32000 });
    const { client: narrow, sent: sentNarrow } = fakeClient([
      { stop_reason: "end_turn", content: [] },
    ]);
    await runEpisode(refiReview, workedExample, new AnthropicPolicy({ client: narrow }));
    expect(sentNarrow[0]).toMatchObject({ max_tokens: 16000 });
  });
});
