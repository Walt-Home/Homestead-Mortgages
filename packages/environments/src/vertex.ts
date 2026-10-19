/**
 * An open model Vertex serves as a managed API, as a policy.
 *
 * Vertex's managed open models answer an OpenAI-style Chat Completions
 * endpoint on our own project, billed to it, authorized by a Google access
 * token — no vendor account and no key. The loop is the same as the Claude
 * policy's: append-only history, every tool result for a turn sent back
 * before the next request, no fallback to another model.
 *
 * Two things differ for DeepSeek, both from Google's own docs. Its function
 * calling is worse with a system prompt, so the rulebook opens the first user
 * message instead. Thinking is off unless asked for, through
 * `chat_template_kwargs`, and arrives as `reasoning_content`, which goes back
 * with the assistant turn it came with.
 *
 * Every request streams. The endpoint is slow (2 to 70 seconds a turn in
 * the first smoke run) and a turn that thinks long can pass five minutes,
 * which is where Node's fetch gives up waiting for response headers
 * (UND_ERR_HEADERS_TIMEOUT): four of the first five episodes died there.
 * Streamed, the headers come at once and the tokens keep the line alive. A
 * request that still drops is retried whole, which is safe because nothing
 * is appended to the history until a turn has arrived complete.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  EpisodeStart,
  Observation,
  Policy,
  PolicySession,
  PolicyTurn,
  ToolCall,
  TurnStop,
} from "./episode.js";

export const DEFAULT_VERTEX_MODEL = "deepseek-ai/deepseek-v4.1-flash-maas";
export const DEFAULT_VERTEX_PROJECT = "homestead-mortgages";

/** The wire shapes this policy sends and reads. Vertex's, in the OpenAI format; there is no SDK for it here. */
interface WireToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}
type WireMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly WireToolCall[];
      readonly reasoning_content?: string;
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };
interface WireResponse {
  readonly choices?: readonly {
    readonly finish_reason: string | null;
    readonly message: {
      readonly content: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly WireToolCall[] | null;
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
  };
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponse>;

/** A dropped or stalled connection, worth one more try; anything else is not. */
const NETWORK_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);
const causeCode = (e: unknown): string | undefined =>
  (e as { cause?: { code?: string } } | null)?.cause?.code;

async function* lines(res: FetchResponse): AsyncGenerator<string> {
  if (!res.body) {
    yield* (await res.text()).split("\n");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      yield buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

interface Chunk {
  readonly error?: unknown;
  readonly usage?: WireResponse["usage"];
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string | null;
        readonly function?: { readonly name?: string | null; readonly arguments?: string | null };
      }[];
    };
  }[];
}

/** A streamed completion put back together as the one response it stands for. */
async function assemble(res: FetchResponse): Promise<WireResponse> {
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: WireResponse["usage"];
  const calls: { id: string; name: string; arguments: string }[] = [];
  for await (const raw of lines(res)) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data) as Chunk;
    if (chunk.error)
      throw new Error(`Vertex streamed an error: ${JSON.stringify(chunk.error).slice(0, 500)}`);
    if (chunk.usage?.prompt_tokens !== undefined) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      content += d.content ?? "";
      reasoning += d.reasoning_content ?? "";
      for (const tc of d.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: `call_${tc.index}`, name: "", arguments: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        slot.arguments += tc.function?.arguments ?? "";
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return {
    choices: [
      {
        finish_reason: finish,
        message: {
          content,
          reasoning_content: reasoning || null,
          tool_calls: calls.filter(Boolean).map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        },
      },
    ],
    usage,
  };
}

/**
 * A Google access token from the gcloud CLI, reused for two minutes.
 *
 * Short on purpose. gcloud hands back the token it already holds until that
 * token expires, so a fresh-looking answer can have minutes to live: a
 * 45-minute reuse cost the first gate run five episodes, all failing with
 * 401 at the hour. `force` drops the reuse, for the one retry a 401 earns.
 */
export function gcloudAccessToken(): AccessToken {
  let token: { value: string; at: number } | null = null;
  return async (force = false) => {
    if (!force && token && Date.now() - token.at < 2 * 60_000) return token.value;
    const { stdout } = await promisify(execFile)("gcloud", ["auth", "print-access-token"]);
    token = { value: stdout.trim(), at: Date.now() };
    return token.value;
  };
}

/** A bearer token; `force` asks for one that is not the last one handed out. */
export type AccessToken = (force?: boolean) => Promise<string>;

const stopOf = (reason: string | null): TurnStop =>
  reason === "tool_calls"
    ? "tool_calls"
    : reason === "length"
      ? "max_tokens"
      : reason === "content_filter"
        ? "refusal"
        : "end";

const argumentsOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Handed to the environment as it came: a call whose input is not an
    // object is answered with an error, which is what the model should see.
    return raw;
  }
};

export interface VertexPolicyOptions {
  readonly model?: string;
  readonly project?: string;
  readonly thinking?: boolean;
  readonly maxTokens?: number;
  readonly accessToken?: AccessToken;
  readonly fetch?: Fetch;
  /** Waits between retries of a 429, a 5xx or a dropped connection; a test sets these to zero. */
  readonly retryDelaysMs?: readonly number[];
}

export class VertexOpenModelPolicy implements Policy {
  readonly id: string;
  private readonly url: string;
  private readonly opts: Required<Omit<VertexPolicyOptions, "accessToken" | "fetch">> & {
    readonly accessToken: AccessToken;
    readonly fetch: Fetch;
  };

  constructor(opts: VertexPolicyOptions = {}) {
    this.opts = {
      model: opts.model ?? DEFAULT_VERTEX_MODEL,
      project: opts.project ?? DEFAULT_VERTEX_PROJECT,
      thinking: opts.thinking ?? true,
      maxTokens: opts.maxTokens ?? 16000,
      accessToken: opts.accessToken ?? gcloudAccessToken(),
      fetch: opts.fetch ?? (globalThis.fetch as unknown as Fetch),
      retryDelaysMs: opts.retryDelaysMs ?? [2_000, 8_000, 30_000],
    };
    this.id = `vertex:${this.opts.model}:${this.opts.thinking ? "thinking" : "no-thinking"}`;
    this.url = `https://aiplatform.googleapis.com/v1/projects/${this.opts.project}/locations/global/endpoints/openapi/chat/completions`;
  }

  private async post(body: unknown): Promise<WireResponse> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.opts.retryDelaysMs[attempt];
      const asked = Date.now();
      try {
        const res = await this.opts.fetch(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.opts.accessToken(refreshed)}`,
            "x-goog-user-project": this.opts.project,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        });
        if (res.ok) return await assemble(res);
        const text = await res.text();
        // An expired token is not a failed request: one fresh token, at once.
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          attempt -= 1;
          continue;
        }
        if (!(res.status === 429 || res.status >= 500) || wait === undefined) {
          throw new Error(`Vertex answered ${res.status}: ${text.slice(0, 500)}`);
        }
      } catch (e) {
        const code = causeCode(e);
        if (!code || !NETWORK_CODES.has(code)) throw e;
        if (wait === undefined) {
          // fetch says only "fetch failed"; the cause is the useful part.
          throw new Error(
            `Vertex request failed after ${Math.round((Date.now() - asked) / 1000)} s, ${attempt + 1} tries: ${code}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  start(episode: EpisodeStart): PolicySession {
    const messages: WireMessage[] = [
      { role: "user", content: `${episode.system}\n\n---\n\n${episode.user}` },
    ];
    const tools = episode.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    return {
      act: async (observations: readonly Observation[]): Promise<PolicyTurn> => {
        for (const o of observations) {
          messages.push({ role: "tool", tool_call_id: o.call_id, content: o.content });
        }
        const response = await this.post({
          model: this.opts.model,
          messages,
          tools,
          tool_choice: "auto",
          max_tokens: this.opts.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.opts.thinking ? { chat_template_kwargs: { thinking: true } } : {}),
        });
        const choice = response.choices?.[0];
        if (!choice) throw new Error("Vertex answered with no choice");
        const m = choice.message;
        const wireCalls = m.tool_calls ?? [];
        messages.push({
          role: "assistant",
          content: m.content ?? "",
          ...(wireCalls.length ? { tool_calls: wireCalls } : {}),
          ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
        });
        const calls: ToolCall[] = wireCalls.map((c) => ({
          id: c.id,
          name: c.function.name,
          input: argumentsOf(c.function.arguments),
        }));
        const prompt = response.usage?.prompt_tokens ?? 0;
        const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        return {
          calls,
          text: m.content ?? "",
          // A turn that carries tool calls is a tool turn, whatever finish_reason says.
          stop: calls.length ? "tool_calls" : stopOf(choice.finish_reason),
          usage: {
            input_tokens: prompt - cached,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: 0,
            output_tokens: response.usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  }
}
