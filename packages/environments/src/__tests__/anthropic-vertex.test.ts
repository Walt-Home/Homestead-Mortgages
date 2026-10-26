/**
 * Claude through Vertex: the real SDK against a stand-in network, so the
 * URL, the token and the billing header are what Google expects and the
 * turn streams; and the token rule — a 401 earns one fresh token, nothing
 * else does.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicPolicy, type ClaudeClient } from "../anthropic.js";
import { vertexClaudeClient } from "../anthropic-vertex.js";
import { eventsOf, scriptedFetch, sse, streamResponse } from "./claude-stream.js";

const MESSAGE = {
  id: "msg",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ready", citations: null }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
} as unknown as Anthropic.Message;
const params = {
  model: "claude-opus-5-5",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
};
const streamed = () => streamResponse(sse(eventsOf(MESSAGE)));

describe("Claude through Vertex", () => {
  it("streams the real SDK's request from our project's global endpoint, with our token and billing header", async () => {
    const { fetch, sent } = scriptedFetch(streamed);
    const client = vertexClaudeClient({ accessToken: async () => "tok", fetch });
    const reply = await client.messages.stream(params).finalMessage();

    expect(reply.content[0]).toMatchObject({ text: "ready" });
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req?.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/homestead-mortgages/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict",
    );
    expect(req?.headers.get("authorization")).toBe("Bearer tok");
    expect(req?.headers.get("x-goog-user-project")).toBe("homestead-mortgages");
    expect(req?.body).toMatchObject({
      anthropic_version: expect.any(String),
      max_tokens: 16,
      stream: true,
    });
    expect(req?.body).not.toHaveProperty("model");
  });

  it("takes a 401 as an expired token: one fresh token, and a second 401 is a real error", async () => {
    const forced: boolean[] = [];
    const accessToken = async (force = false) => {
      forced.push(force);
      return force ? "fresh" : "stale";
    };

    // Through the real SDK: the 401 comes before any of the stream, and the
    // second try opens the whole stream again with the fresh token, which
    // is then the one handed out, as gcloudAccessToken's is.
    let held = "stale";
    let answered = 0;
    const real = scriptedFetch(() =>
      answered++ === 0
        ? new Response(JSON.stringify({ type: "error", error: { type: "authentication_error" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        : streamed(),
    );
    const reply = await vertexClaudeClient({
      accessToken: async (force = false) => (force ? (held = "fresh") : held),
      fetch: real.fetch,
    })
      .messages.stream(params)
      .finalMessage();
    expect(reply).toMatchObject({ content: [{ text: "ready" }] });
    expect(real.sent.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer stale",
      "Bearer fresh",
    ]);

    const fake = (seq: number[]) => {
      let calls = 0;
      const client: ClaudeClient = {
        messages: {
          stream: () => ({
            finalMessage: async () => {
              calls++;
              const status = seq.shift();
              if (status === 200) return MESSAGE;
              throw Object.assign(new Error(`status ${status}`), { status });
            },
          }),
        },
      };
      return { client, calls: () => calls };
    };

    const ok = fake([401, 200]);
    expect(
      await vertexClaudeClient({ accessToken, client: ok.client })
        .messages.stream(params)
        .finalMessage(),
    ).toMatchObject({
      content: [{ text: "ready" }],
    });
    expect(ok.calls()).toBe(2);
    expect(forced).toEqual([true]);

    const twice = fake([401, 401]);
    await expect(
      vertexClaudeClient({ accessToken, client: twice.client })
        .messages.stream(params)
        .finalMessage(),
    ).rejects.toMatchObject({
      status: 401,
    });
    const other = fake([429]);
    await expect(
      vertexClaudeClient({ accessToken, client: other.client })
        .messages.stream(params)
        .finalMessage(),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(other.calls()).toBe(1);
  });

  it("asks for the token on every request, so an hour-old one is never sent", async () => {
    let n = 0;
    const { fetch } = scriptedFetch(streamed);
    const client = vertexClaudeClient({ accessToken: async () => `tok-${++n}`, fetch });
    await client.messages.stream(params).finalMessage();
    await client.messages.stream(params).finalMessage();
    expect(n).toBe(2);
  });

  it("names where the model is served in the record", () => {
    const p = new AnthropicPolicy({
      client: vertexClaudeClient({ accessToken: async () => "t" }),
      provider: "anthropic-vertex",
    });
    expect(p.id).toBe("anthropic-vertex:claude-opus-5-5:high");
    expect(new AnthropicPolicy({ client: {} as ClaudeClient }).id).toBe(
      "anthropic:claude-opus-5-5:high",
    );
  });
});
