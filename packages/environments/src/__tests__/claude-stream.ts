/**
 * The Messages API's stream, written by hand for the Claude policy's tests:
 * a message as the server-sent events the API streams it as, and a fetch
 * that answers with them. The tests run the real SDK clients over it, so
 * what they check is what the SDK makes of a stream, not what a stand-in
 * hands back.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** One server-sent event, as JSON on the wire; the SDK reads its `type`. */
export type StreamEvent = { readonly type: string } & Record<string, unknown>;

/** A reply as a test writes it: the content and the stop, the rest filled in. */
export type Reply = Pick<Anthropic.Message, "content" | "stop_reason"> & Partial<Anthropic.Message>;

export const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 0,
};

export const messageOf = (reply: Reply, model: string): Anthropic.Message =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model,
    stop_sequence: null,
    usage: USAGE,
    ...reply,
  }) as Anthropic.Message;

/** A block as it opens, before its first delta. */
const opened = (block: Anthropic.ContentBlock): Record<string, unknown> => {
  switch (block.type) {
    case "text":
      return { type: "text", text: "", citations: null };
    case "tool_use":
      return { ...block, input: {} };
    case "thinking":
      return { type: "thinking", thinking: "", signature: "" };
    default:
      throw new Error(`no stream written for a ${block.type} block`);
  }
};

/** A block's deltas. A tool call's input comes in two pieces, as the API splits it. */
const deltas = (block: Anthropic.ContentBlock): Record<string, unknown>[] => {
  switch (block.type) {
    case "text":
      return [{ type: "text_delta", text: block.text }];
    case "tool_use": {
      const json = JSON.stringify(block.input);
      const half = Math.floor(json.length / 2);
      return [
        { type: "input_json_delta", partial_json: json.slice(0, half) },
        { type: "input_json_delta", partial_json: json.slice(half) },
      ];
    }
    case "thinking":
      return [
        { type: "thinking_delta", thinking: block.thinking },
        { type: "signature_delta", signature: block.signature },
      ];
    default:
      throw new Error(`no stream written for a ${block.type} block`);
  }
};

/** A message as the events it streams as, in order, ending with its `message_stop`. */
export function eventsOf(message: Anthropic.Message): StreamEvent[] {
  const { usage } = message;
  const events: StreamEvent[] = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
  ];
  message.content.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: opened(block) });
    for (const delta of deltas(block)) events.push({ type: "content_block_delta", index, delta });
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage,
    },
    { type: "message_stop" },
  );
  return events;
}

/** Events as the body of a `text/event-stream` response. */
export const sse = (events: readonly StreamEvent[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

export const streamResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

export interface SentRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/**
 * A network that answers each request with the next response the script
 * makes from it, and keeps every request it was sent.
 */
export function scriptedFetch(next: (body: Record<string, unknown>) => Response) {
  const sent: SentRequest[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(url), headers: new Headers(init?.headers), body });
    return next(body);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
