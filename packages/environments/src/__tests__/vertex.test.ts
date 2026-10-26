/**
 * The Vertex open-model policy against a stand-in endpoint: what it sends,
 * and what it does with what comes back. No network, no token, no spend.
 */

import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { SUBMIT_TOOL, refiReview, specTasks } from "../refi/index.js";
import { VertexOpenModelPolicy } from "../vertex.js";

const [workedExample] = specTasks();
if (!workedExample) throw new Error("no spec tasks");

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> & { messages: Record<string, unknown>[] };
}

type Reply =
  | { readonly status: number; readonly body: unknown }
  | { readonly stream: readonly unknown[] }
  | { readonly raw: string }
  | { readonly pieces: readonly string[] }
  | { readonly drop: string };

/**
 * An endpoint that answers from a script and keeps every request: an HTTP
 * error, a stream of chunks as Vertex sends them, a 200 whose body is given
 * byte for byte (whole, or read off the wire in pieces), or a dropped
 * connection.
 */
function fakeVertex(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Sent["body"] });
    const r = replies.shift();
    if (!r) throw new Error("the script ran out");
    if ("drop" in r)
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: r.drop } });
    if ("status" in r)
      return { ok: false, status: r.status, text: async () => JSON.stringify(r.body) };
    if ("raw" in r) return { ok: true, status: 200, text: async () => r.raw };
    if ("pieces" in r) {
      const bytes = r.pieces.map((p) => new TextEncoder().encode(p));
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          const next = bytes.shift();
          if (next) c.enqueue(next);
          else c.close();
        },
      });
      return { ok: true, status: 200, body, text: async () => r.pieces.join("") };
    }
    const sse = [...r.stream.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(
      "",
    );
    return { ok: true, status: 200, text: async () => sse };
  };
  return { fetch, sent };
}

const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 50,
  prompt_tokens_details: { cached_tokens: 800 },
};

/** One turn as Vertex streams it: the deltas, then the finish, then the usage. */
const reply = (
  m: { content?: string; reasoning_content?: string; calls?: [string, string, unknown][] },
  finish_reason = "tool_calls",
): Reply => ({
  stream: [
    { choices: [{ delta: { role: "assistant", content: "", reasoning_content: null } }] },
    ...(m.reasoning_content
      ? [{ choices: [{ delta: { reasoning_content: m.reasoning_content } }] }]
      : []),
    ...(m.content ? [{ choices: [{ delta: { content: m.content } }] }] : []),
    ...(m.calls ?? []).flatMap(([id, name, args], index) => {
      const text = typeof args === "string" ? args : JSON.stringify(args);
      const half = Math.floor(text.length / 2);
      // The id and name come first, the arguments after, in pieces.
      return [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: null, function: { name: null, arguments: text.slice(0, half) } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: null, function: { name: null, arguments: text.slice(half) } },
                ],
              },
            },
          ],
        },
      ];
    }),
    { choices: [{ delta: {}, finish_reason }] },
    { choices: [], usage: USAGE },
  ],
});

/** Chunks as server-sent events, each a `data:` line. */
const sse = (chunks: readonly unknown[]): string =>
  chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");

/** A whole turn's body, byte for byte, ending in [DONE]. */
const whole = (r: Reply): string => {
  if (!("stream" in r)) throw new Error("not a stream");
  return sse([...r.stream, "[DONE]"]);
};

/**
 * What the endpoint sent on 26 October, on all 15 call-qa first turns probed
 * one to eight at a time and on 40 of 48 at once: an HTTP 200 that ends
 * mid-turn, as a clean end of the body. No error, no finish_reason, no
 * usage, no [DONE]; the streams in flight together cut on the same second.
 */
const cut = (m: { reasoning_content?: string; partialCall?: [string, string, string] } = {}) =>
  sse([
    { choices: [{ delta: { role: "assistant", content: "", reasoning_content: null } }] },
    { choices: [{ delta: { reasoning_content: m.reasoning_content ?? "Let me work through" } }] },
    ...(m.partialCall
      ? [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: m.partialCall[0],
                      type: "function",
                      function: { name: m.partialCall[1], arguments: m.partialCall[2] },
                    },
                  ],
                },
              },
            ],
            // Vertex can put a usage object with no counts on any chunk.
            usage: { extra_properties: { google: { traffic_type: "ON_DEMAND" } } },
          },
        ]
      : []),
  ]);

/** The notice the endpoint wrote into a stream on 26 October, before the whole turn it then sent. */
const NOTICE =
  "inference error: ServiceUnavailable - failed to find endpoint candidates for serving the request";

const SUBMIT_WATCHING = reply({
  calls: [
    ["s1", SUBMIT_TOOL, { verdict: "watching", reasons: [], offer: null, watch_rate_pct: null }],
  ],
});

const policy = (fetch: ReturnType<typeof fakeVertex>["fetch"], thinking = true) =>
  new VertexOpenModelPolicy({
    fetch,
    thinking,
    accessToken: async () => "tok",
    retryDelaysMs: [0, 0],
  });

describe("the Vertex open-model policy", () => {
  it("puts the rulebook in the first user message, sends tools in the function format, and batches results", async () => {
    const { fetch, sent } = fakeVertex([
      reply({
        reasoning_content: "First the per diem.",
        calls: [
          ["c1", "per_diem", { balance_cents: "55310641", annual_rate_pct: "7.000" }],
          ["c2", "date_add", { date: "2026-10-01", days: 36 }],
        ],
      }),
      reply({
        calls: [
          [
            "c3",
            SUBMIT_TOOL,
            { verdict: "watching", reasons: [], offer: null, watch_rate_pct: null },
          ],
        ],
      }),
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));

    expect(r.outcome).toBe("submitted");
    const [first, second] = sent as [Sent, Sent];
    expect(first.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/homestead-mortgages/locations/global/endpoints/openapi/chat/completions",
    );
    expect(first.headers).toMatchObject({
      Authorization: "Bearer tok",
      "x-goog-user-project": "homestead-mortgages",
    });
    expect(first.body).toMatchObject({
      model: "deepseek-ai/deepseek-v4.1-flash-maas",
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { thinking: true },
    });
    expect(first.body.messages.map((m) => m["role"])).toEqual(["user"]);
    expect(String(first.body.messages[0]?.["content"]).startsWith(refiReview.system)).toBe(true);
    expect(
      (first.body["tools"] as { function: { name: string } }[]).map((t) => t.function.name),
    ).toEqual(refiReview.tools.map((t) => t.name));
    // The assistant turn goes back whole, reasoning and calls; then one tool message per call.
    expect(second.body.messages.map((m) => m["role"])).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    // The arguments arrived in pieces and go back whole.
    expect(second.body.messages[1]).toMatchObject({
      reasoning_content: "First the per diem.",
      tool_calls: [
        {
          id: "c1",
          function: {
            name: "per_diem",
            arguments: '{"balance_cents":"55310641","annual_rate_pct":"7.000"}',
          },
        },
        { id: "c2", function: { name: "date_add" } },
      ],
    });
    expect(second.body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"per_diem_cents":"10608"}',
    });
    expect(r.usage).toEqual({
      input_tokens: 400,
      cache_read_input_tokens: 1600,
      cache_creation_input_tokens: 0,
      output_tokens: 100,
    });
  });

  it("names a budget other than the default in its id, and sends it", async () => {
    expect(policy(fakeVertex([]).fetch).id).toBe(
      "vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking",
    );
    const { fetch, sent } = fakeVertex([reply({ content: "done" }, "stop")]);
    const wide = new VertexOpenModelPolicy({
      fetch,
      maxTokens: 32000,
      accessToken: async () => "tok",
      retryDelaysMs: [0, 0],
    });
    expect(wide.id).toBe("vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking:max-tokens-32000");
    await runEpisode(refiReview, workedExample, wide);
    expect(sent[0]?.body).toMatchObject({ max_tokens: 32000 });
  });

  it("leaves thinking off when asked, and answers malformed arguments with an error", async () => {
    const { fetch, sent } = fakeVertex([
      reply({ calls: [["c1", "per_diem", "{not json"]] }),
      reply({ content: "done" }, "stop"),
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch, false));
    expect(sent[0]?.body).not.toHaveProperty("chat_template_kwargs");
    expect(r.transcript.find((e) => e.kind === "observations")).toMatchObject({
      observations: [{ call_id: "c1", is_error: true }],
    });
    expect(r.outcome).toBe("no_submission");
    // Vertex refuses a request whose history carries arguments that are not
    // a JSON object, so the malformed call goes back wrapped, as written.
    const back = (
      sent[1]?.body.messages[1] as { tool_calls: { function: { arguments: string } }[] }
    ).tool_calls[0]?.function.arguments;
    expect(JSON.parse(back ?? "")).toEqual({ unparsed_arguments: "{not json" });
  });

  it("retries a 429, gives up on a 400, and reads a content filter as a refusal", async () => {
    const retried = fakeVertex([
      { status: 429, body: { error: "slow down" } },
      reply({ content: "" }, "content_filter"),
    ]);
    expect((await runEpisode(refiReview, workedExample, policy(retried.fetch))).outcome).toBe(
      "refusal",
    );
    expect(retried.sent).toHaveLength(2);
    const refused = fakeVertex([{ status: 400, body: { error: "bad request" } }]);
    const r = await runEpisode(refiReview, workedExample, policy(refused.fetch));
    expect(r.outcome).toBe("error");
    expect(r.error).toMatch(/400/);
  });

  it("retries a dropped connection whole, and says why when it gives up", async () => {
    const recovered = fakeVertex([
      { drop: "UND_ERR_HEADERS_TIMEOUT" },
      reply({
        calls: [
          [
            "c1",
            SUBMIT_TOOL,
            { verdict: "watching", reasons: [], offer: null, watch_rate_pct: null },
          ],
        ],
      }),
    ]);
    expect((await runEpisode(refiReview, workedExample, policy(recovered.fetch))).outcome).toBe(
      "submitted",
    );
    expect(recovered.sent).toHaveLength(2);
    const lost = fakeVertex([
      { drop: "ECONNRESET" },
      { drop: "ECONNRESET" },
      { drop: "ECONNRESET" },
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(lost.fetch));
    expect(r.outcome).toBe("error");
    expect(r.error).toMatch(/3 tries: ECONNRESET/);
  });

  it("takes a 401 as an expired token: one fresh token, at once, then a real error", async () => {
    const forced: boolean[] = [];
    const accessToken = async (force = false) => {
      forced.push(force);
      return force ? "fresh" : "stale";
    };
    const expired = fakeVertex([
      { status: 401, body: { error: "UNAUTHENTICATED" } },
      reply({
        calls: [
          [
            "c1",
            SUBMIT_TOOL,
            { verdict: "watching", reasons: [], offer: null, watch_rate_pct: null },
          ],
        ],
      }),
    ]);
    const ok = await runEpisode(
      refiReview,
      workedExample,
      new VertexOpenModelPolicy({ fetch: expired.fetch, accessToken, retryDelaysMs: [0, 0] }),
    );
    expect(ok.outcome).toBe("submitted");
    expect(forced).toEqual([false, true]);
    expect(expired.sent.map((x) => x.headers["Authorization"])).toEqual([
      "Bearer stale",
      "Bearer fresh",
    ]);

    const refused = fakeVertex([
      { status: 401, body: { error: "UNAUTHENTICATED" } },
      { status: 401, body: { error: "UNAUTHENTICATED" } },
    ]);
    const r = await runEpisode(
      refiReview,
      workedExample,
      new VertexOpenModelPolicy({ fetch: refused.fetch, accessToken, retryDelaysMs: [0, 0] }),
    );
    expect(r.outcome).toBe("error");
    expect(r.error).toMatch(/401/);
    expect(refused.sent).toHaveLength(2);
  });

  it("retries a stream cut mid-turn, which once read as a model that stopped with no answer", async () => {
    const { fetch, sent } = fakeVertex([{ raw: cut() }, { raw: cut() }, SUBMIT_WATCHING]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));
    expect(r.outcome).toBe("submitted");
    expect(r.turns).toBe(1);
    expect(sent).toHaveLength(3);
    // Nothing of a cut turn reaches the history: each try sends what the first did.
    expect(sent[2]?.body.messages).toEqual(sent[0]?.body.messages);
  });

  it("reads a cut off the wire as a cut, a line split across reads or not", async () => {
    const body = cut({ reasoning_content: "Call: LN-d3ec1259" });
    const at = body.indexOf("Call:");
    const { fetch, sent } = fakeVertex([
      // The body ends at a chunk's end, as it did, and mid-line, as it could.
      { pieces: [body.slice(0, at), body.slice(at)] },
      { pieces: [body.slice(0, at + 3)] },
      { pieces: whole(SUBMIT_WATCHING).match(/[^]{1,7}/g) ?? [] },
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));
    expect(r.outcome).toBe("submitted");
    expect(sent).toHaveLength(3);
  });

  it("never runs a tool call a cut stream carried, its arguments cut with it", async () => {
    const { fetch, sent } = fakeVertex([
      { raw: cut({ partialCall: ["c1", "per_diem", '{"balance_cents": "553'] }) },
      SUBMIT_WATCHING,
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));
    expect(r.outcome).toBe("submitted");
    expect(r.tool_calls).toBe(1);
    expect(r.transcript.filter((e) => e.kind === "observations")).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("takes a notice before the turn as a notice, and the whole turn after it as the turn", async () => {
    const { fetch, sent } = fakeVertex([{ raw: sse([NOTICE]) + whole(SUBMIT_WATCHING) }]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));
    expect(r.outcome).toBe("submitted");
    expect(sent).toHaveLength(1);
    expect(r.usage.output_tokens).toBe(50);
  });

  it("retries a line that is not JSON once the turn has begun, a body that is not a stream, and an empty body", async () => {
    const midTurn = sse([
      { choices: [{ delta: { reasoning_content: "First the per diem." } }] },
      "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    const { fetch, sent } = fakeVertex([
      { raw: midTurn },
      { raw: "upstream connect error or disconnect/reset before headers. reset reason: overflow" },
      { raw: "" },
      { raw: whole(SUBMIT_WATCHING) },
    ]);
    const r = await runEpisode(
      refiReview,
      workedExample,
      new VertexOpenModelPolicy({
        fetch,
        accessToken: async () => "tok",
        retryDelaysMs: [0, 0, 0],
      }),
    );
    expect(r.outcome).toBe("submitted");
    expect(sent).toHaveLength(4);
  });

  it("retries an error the stream carries, where it once ended the episode", async () => {
    const { fetch, sent } = fakeVertex([
      { stream: [{ error: { code: 503, message: "The model is overloaded." } }] },
      SUBMIT_WATCHING,
    ]);
    expect((await runEpisode(refiReview, workedExample, policy(fetch))).outcome).toBe("submitted");
    expect(sent).toHaveLength(2);
  });

  it("retries a turn with nothing in it, and one cut after its finish, but takes a finish and [DONE] with no usage", async () => {
    const nothing = sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    const cutAfterFinish = sse([
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const noUsage = sse([
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const { fetch, sent } = fakeVertex([
      { raw: nothing },
      { raw: cutAfterFinish },
      { raw: noUsage },
    ]);
    const r = await runEpisode(
      refiReview,
      workedExample,
      new VertexOpenModelPolicy({
        fetch,
        accessToken: async () => "tok",
        retryDelaysMs: [0, 0, 0],
      }),
    );
    expect(sent).toHaveLength(3);
    expect(r.outcome).toBe("no_submission");
    expect(r.transcript[0]).toMatchObject({ kind: "turn", text: "done", stop: "end" });
  });

  it("ends the episode as an error that says why when no whole turn comes, which --resume runs again", async () => {
    const { fetch, sent } = fakeVertex([
      { raw: cut() },
      { raw: sse([NOTICE]) },
      { raw: sse([NOTICE]) + cut() },
    ]);
    const r = await runEpisode(refiReview, workedExample, policy(fetch));
    expect(sent).toHaveLength(3);
    expect(r.outcome).toBe("error");
    expect(r.turns).toBe(0);
    expect(r.error).toMatch(/^Vertex sent no whole turn in 3 tries, the last after \d+ s: /);
    expect(r.error).toContain(
      "the stream ended with no finish_reason (2 chunks, 19 characters of reasoning, 0 of content, 0 tool calls) after",
    );
    expect(r.error).toContain(NOTICE);
  });

  it("keeps a model's own stop as the model's: reasoning or content and no tool call", async () => {
    const thought = fakeVertex([reply({ reasoning_content: "Nothing to call." }, "stop")]);
    const r = await runEpisode(refiReview, workedExample, policy(thought.fetch));
    expect(r.outcome).toBe("no_submission");
    expect(thought.sent).toHaveLength(1);
    expect(r.usage.output_tokens).toBe(50);
  });
});
