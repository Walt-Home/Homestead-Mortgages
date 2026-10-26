/**
 * The Claude policy over the real SDK and a stand-in network: what it sends,
 * and what it does with the stream that comes back. No key, no spend.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicPolicy, type ClaudeClient } from "../anthropic.js";
import { vertexClaudeClient } from "../anthropic-vertex.js";
import { runEpisode } from "../episode.js";
import { SUBMIT_TOOL, refiReview, specTasks } from "../refi/index.js";
import {
  eventsOf,
  messageOf,
  scriptedFetch,
  sse,
  streamResponse,
  type Reply,
  type StreamEvent,
} from "./claude-stream.js";

const [workedExample] = specTasks();
if (!workedExample) throw new Error("no spec tasks");

type Params = Anthropic.MessageCreateParamsStreaming;

/** Not a key: every request goes to the stand-in network. */
const NOT_A_KEY = "not-a-key";

/**
 * The SDK's own client over a network that streams each reply of a script
 * in turn, keeping every request it was sent.
 */
function fakeClient(replies: Reply[]) {
  const sent: Params[] = [];
  const { fetch } = scriptedFetch((body) => {
    sent.push(body as unknown as Params);
    const reply = replies.shift();
    if (!reply) throw new Error("the script ran out");
    return streamResponse(sse(eventsOf(messageOf(reply, String(body["model"])))));
  });
  const client = new Anthropic({ apiKey: NOT_A_KEY, fetch, maxRetries: 0 });
  return { client, sent };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});

const SUBMIT: Reply = {
  stop_reason: "tool_use",
  content: [
    toolUse("t3", SUBMIT_TOOL, {
      verdict: "watching",
      reasons: [],
      offer: null,
      watch_rate_pct: null,
    }),
  ] as Anthropic.ContentBlock[],
};

describe("the Claude policy", () => {
  it("sends the rulebook as a cached system prompt, appends every turn whole, and batches tool results", async () => {
    const { client, sent } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "text", text: "Two figures first.", citations: null },
          toolUse("t1", "per_diem", { balance_cents: "55310641", annual_rate_pct: "7.000" }),
          toolUse("t2", "date_add", { date: "2026-10-01", days: 36 }),
        ] as Anthropic.ContentBlock[],
      },
      SUBMIT,
    ]);
    const r = await runEpisode(
      refiReview,
      workedExample,
      new AnthropicPolicy({ client, model: "claude-opus-5-5", effort: "high" }),
    );

    expect(r.outcome).toBe("submitted");
    expect(sent).toHaveLength(2);
    const [first, second] = sent as [Params, Params];
    expect(first.stream).toBe(true);
    expect(first.system).toEqual([
      { type: "text", text: refiReview.system, cache_control: { type: "ephemeral" } },
    ]);
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.tool_choice).toBeUndefined();
    expect(first.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual(
      refiReview.tools.map((t) => t.name),
    );
    // The second request is the first's history plus the assistant turn as
    // it streamed, its thinking signature and both calls' inputs put back
    // together, then ONE user message of results.
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "Two figures first.", citations: null },
        toolUse("t1", "per_diem", { balance_cents: "55310641", annual_rate_pct: "7.000" }),
        toolUse("t2", "date_add", { date: "2026-10-01", days: 36 }),
      ],
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

  it("records a turn that spent its budget as max_tokens, and one that ended as no submission", async () => {
    const { client } = fakeClient([
      { stop_reason: "max_tokens", content: [{ type: "text", text: "Wor", citations: null }] },
    ]);
    const spent = await runEpisode(refiReview, workedExample, new AnthropicPolicy({ client }));
    expect(spent).toMatchObject({ outcome: "max_tokens", turns: 1, error: null });

    const { client: ended } = fakeClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done.", citations: null }] },
    ]);
    const quiet = await runEpisode(
      refiReview,
      workedExample,
      new AnthropicPolicy({ client: ended }),
    );
    expect(quiet).toMatchObject({ outcome: "no_submission", turns: 1, error: null });
    expect(quiet.transcript[0]).toMatchObject({ kind: "turn", text: "Done.", stop: "end" });
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

/**
 * Both clients the CLI builds, the SDK's own classes over a stand-in
 * network: `anthropic` (the SDK's client) and `anthropic-vertex` (its Vertex
 * client, through our wrapper).
 */
const CLIENTS: readonly {
  readonly provider: string;
  readonly over: (fetch: typeof globalThis.fetch) => ClaudeClient;
}[] = [
  {
    provider: "anthropic",
    over: (fetch) => new Anthropic({ apiKey: NOT_A_KEY, fetch, maxRetries: 0 }),
  },
  {
    provider: "anthropic-vertex",
    over: (fetch) => vertexClaudeClient({ accessToken: async () => "tok", fetch }),
  },
];

describe("every Claude turn streams", () => {
  it("is why a 32,000-token turn is sent at all: unstreamed, the SDK refuses it before any request", async () => {
    const { fetch, sent } = scriptedFetch(() => {
      throw new Error("no request should be sent");
    });
    const client = new Anthropic({ apiKey: NOT_A_KEY, fetch, maxRetries: 0 });
    const unstreamed = async () =>
      client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 32000,
        messages: [{ role: "user", content: "hi" }],
      });
    await expect(unstreamed()).rejects.toThrow(/Streaming is required/);
    expect(sent).toHaveLength(0);
  });

  it.each(CLIENTS)(
    "sends a 32,000-token turn through $provider as one streamed request, with no error",
    async ({ provider, over }) => {
      const { fetch, sent } = scriptedFetch((body) =>
        streamResponse(
          sse(eventsOf(messageOf(SUBMIT, String(body["model"] ?? "claude-opus-5-5")))),
        ),
      );
      const policy = new AnthropicPolicy({ client: over(fetch), provider, maxTokens: 32000 });
      expect(policy.id).toBe(`${provider}:claude-opus-5-5:high:max-tokens-32000`);
      const r = await runEpisode(refiReview, workedExample, policy);

      expect(r).toMatchObject({ outcome: "submitted", error: null, turns: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toMatchObject({ max_tokens: 32000, stream: true });
      expect(r.usage).toEqual({
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
      });
    },
  );

  it.each(CLIENTS)(
    "takes a stream through $provider that ends before its message_stop as a transport error, not the model's miss",
    async ({ provider, over }) => {
      const whole = eventsOf(messageOf(SUBMIT, "claude-opus-5-5"));
      const at = (type: string) => whole.findIndex((e) => e.type === type);
      // Cut where a dropped connection can cut: before anything, after the
      // message opens, inside the tool call's input, after the stop reason.
      const cuts: readonly (readonly StreamEvent[])[] = [
        [],
        whole.slice(0, 1),
        whole.slice(0, at("content_block_delta") + 1),
        whole.slice(0, at("message_stop")),
      ];
      for (const events of cuts) {
        const { fetch, sent } = scriptedFetch(() => streamResponse(sse(events)));
        const r = await runEpisode(
          refiReview,
          workedExample,
          new AnthropicPolicy({ client: over(fetch), provider, maxTokens: 32000 }),
        );
        expect(sent).toHaveLength(1);
        // An error, which --resume runs again and compare does not score; not
        // a turn with no tool call, which would read as a model that stopped.
        expect(r).toMatchObject({ outcome: "error", turns: 0, tool_calls: 0, answer: null });
        expect(r.error).toMatch(/ended without/);
        expect(r.transcript).toEqual([]);
      }
    },
  );
});
