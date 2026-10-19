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
  | { readonly drop: string };

/**
 * An endpoint that answers from a script and keeps every request: an HTTP
 * error, a stream of chunks as Vertex sends them, or a dropped connection.
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
});
