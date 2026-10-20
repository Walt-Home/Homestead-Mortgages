/**
 * Claude through Vertex: the real SDK against a stand-in network, so the
 * URL, the token and the billing header are what Google expects; and the
 * token rule — a 401 earns one fresh token, nothing else does.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicPolicy } from "../anthropic.js";
import { vertexClaudeClient } from "../anthropic-vertex.js";

const MESSAGE = {
  id: "msg",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ready" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
};
const params = {
  model: "claude-opus-5-5",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("Claude through Vertex", () => {
  it("sends the real SDK's request to our project's global endpoint, with our token and billing header", async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(MESSAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = vertexClaudeClient({ accessToken: async () => "tok", fetch });
    const reply = await client.messages.create(params);

    expect(reply.content[0]).toMatchObject({ text: "ready" });
    const [req] = seen;
    expect(req?.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/homestead-mortgages/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict",
    );
    expect(req?.headers.get("authorization")).toBe("Bearer tok");
    expect(req?.headers.get("x-goog-user-project")).toBe("homestead-mortgages");
    expect(req?.body).toMatchObject({ anthropic_version: expect.any(String), max_tokens: 16 });
    expect(req?.body).not.toHaveProperty("model");
  });

  it("takes a 401 as an expired token: one fresh token, and a second 401 is a real error", async () => {
    const forced: boolean[] = [];
    const accessToken = async (force = false) => {
      forced.push(force);
      return force ? "fresh" : "stale";
    };
    const fake = (seq: number[]) => {
      let calls = 0;
      const client = {
        messages: {
          create: async () => {
            calls++;
            const status = seq.shift();
            if (status === 200) return MESSAGE;
            throw Object.assign(new Error(`status ${status}`), { status });
          },
        },
      } as unknown as Pick<Anthropic, "messages">;
      return { client, calls: () => calls };
    };

    const ok = fake([401, 200]);
    expect(
      await vertexClaudeClient({ accessToken, client: ok.client }).messages.create(params),
    ).toMatchObject({
      content: [{ text: "ready" }],
    });
    expect(ok.calls()).toBe(2);
    expect(forced).toEqual([true]);

    const twice = fake([401, 401]);
    await expect(
      vertexClaudeClient({ accessToken, client: twice.client }).messages.create(params),
    ).rejects.toMatchObject({
      status: 401,
    });
    const other = fake([429]);
    await expect(
      vertexClaudeClient({ accessToken, client: other.client }).messages.create(params),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(other.calls()).toBe(1);
  });

  it("asks for the token on every request, so an hour-old one is never sent", async () => {
    let n = 0;
    const fetch = (async () =>
      new Response(JSON.stringify(MESSAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const client = vertexClaudeClient({ accessToken: async () => `tok-${++n}`, fetch });
    await client.messages.create(params);
    await client.messages.create(params);
    expect(n).toBe(2);
  });

  it("names where the model is served in the record", () => {
    const p = new AnthropicPolicy({
      client: vertexClaudeClient({ accessToken: async () => "t" }),
      provider: "anthropic-vertex",
    });
    expect(p.id).toBe("anthropic-vertex:claude-opus-5-5:high");
    expect(new AnthropicPolicy({ client: {} as Pick<Anthropic, "messages"> }).id).toBe(
      "anthropic:claude-opus-5-5:high",
    );
  });
});
