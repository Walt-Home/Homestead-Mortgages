/**
 * Claude served by Vertex AI, as the client the Claude policy takes.
 *
 * Anthropic's Vertex SDK speaks the same Messages API at Google's endpoint,
 * billed to our project and authorized by a Google access token, so the
 * Claude policy's loop is unchanged: only the client differs.
 *
 * The token comes from the gcloud CLI, the same as the DeepSeek policy's. The
 * SDK's `accessToken` option is stored and never read (0.20.2): every request
 * asks the SDK's auth client for headers, and the default one reads the
 * machine's application-default credentials, which on Joe's Mac are stale
 * and fail with `invalid_rapt`. So the SDK gets an auth client of ours that
 * answers with the gcloud token, asked afresh on every request. A 401 gets a
 * forced fresh token and one more try; nothing else does.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { DEFAULT_VERTEX_PROJECT, gcloudAccessToken, type AccessToken } from "./vertex.js";

type Messages = Pick<Anthropic, "messages">;
type VertexOptions = NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>;

export interface VertexClaudeOptions {
  readonly project?: string;
  readonly region?: string;
  readonly accessToken?: AccessToken;
  /** The client to wrap; a test stands one in. */
  readonly client?: Messages;
  /** The network, for a test that runs the real SDK without one. */
  readonly fetch?: typeof globalThis.fetch;
}

export function vertexClaudeClient(opts: VertexClaudeOptions = {}): Messages {
  const project = opts.project ?? DEFAULT_VERTEX_PROJECT;
  const token = opts.accessToken ?? gcloudAccessToken();
  // The two things the SDK reads from an auth client, and nothing more.
  const authClient = {
    projectId: project,
    getRequestHeaders: async () => new Headers({ Authorization: `Bearer ${await token()}` }),
  } as unknown as VertexOptions["authClient"];
  const client =
    opts.client ??
    (new AnthropicVertex({
      region: opts.region ?? "global",
      projectId: project,
      authClient,
      // Bill and meter our project, whatever gcloud's default project is.
      defaultHeaders: { "x-goog-user-project": project },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }) as unknown as Messages);
  const create = async (...args: Parameters<Anthropic["messages"]["create"]>) => {
    try {
      return await client.messages.create(...args);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      await token(true);
      return await client.messages.create(...args);
    }
  };
  return { messages: { create } } as unknown as Messages;
}
