/**
 * The identity token our calls to his door carry: minted from the metadata
 * server for his URL, cached until it is about to expire, and absent — not
 * an error — where there is no metadata server.
 */

import { describe, expect, it } from "vitest";
import { identityTokenFor } from "../services/google-identity.js";

function jwt(exp: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ aud: "x", exp })}.sig`;
}

describe("identityTokenFor", () => {
  it("mints for the audience and caches until a minute before expiry", async () => {
    let clock = 1_000_000_000_000;
    const calls: string[] = [];
    const token = jwt(clock / 1000 + 600);
    const provider = identityTokenFor("https://his.run.app", {
      now: () => clock,
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(token, { status: 200 });
      }) as typeof fetch,
    });
    expect(await provider()).toBe(token);
    expect(await provider()).toBe(token);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("audience=https%3A%2F%2Fhis.run.app");
    clock += 9 * 60_000 + 1;
    expect(await provider()).toBe(token);
    expect(calls).toHaveLength(2);
  });

  it("answers null off Google Cloud and stays quiet for a minute", async () => {
    let clock = 0;
    let asked = 0;
    const provider = identityTokenFor("https://his.run.app", {
      now: () => clock,
      fetchImpl: (async () => {
        asked += 1;
        throw new Error("getaddrinfo ENOTFOUND metadata.google.internal");
      }) as typeof fetch,
    });
    expect(await provider()).toBeNull();
    expect(await provider()).toBeNull();
    expect(asked).toBe(1);
    clock = 61_000;
    expect(await provider()).toBeNull();
    expect(asked).toBe(2);
  });

  it("treats a refusal from the metadata server as no token", async () => {
    const provider = identityTokenFor("https://his.run.app", {
      fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch,
    });
    expect(await provider()).toBeNull();
  });
});
