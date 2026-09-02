/**
 * The headers that decide whether sign-in and the bank widget work at all.
 *
 * Both of these are helmet defaults that break Google Identity Services
 * silently, and one of them cost a debugging round: with
 * `Cross-Origin-Opener-Policy: same-origin`, the popup GIS opens cannot post
 * the credential back to us, so it renders blank forever with no error in
 * either window — indistinguishable from an unregistered OAuth origin.
 *
 * Pinned here because the failure is invisible in every other test: the API
 * works perfectly, the button renders, and only a real browser doing a real
 * popup exposes it.
 *
 * This file used to re-declare the helmet config rather than import it, so it
 * asserted against its own copy and would have kept passing while the server
 * served something else entirely. It now imports the same function index.ts
 * mounts.
 */

import express from "express";
import helmet from "helmet";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../security-policy.js";

/** The same helmet configuration the server mounts — imported, not copied. */
function headersFor(app: express.Express): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        resolve(Object.fromEntries([...res.headers.entries()]));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function appFor(environment: "sandbox" | "production") {
  const app = express();
  app.use(helmet(securityHeaders(environment)));
  app.get("/", (_req, res) => res.send("ok"));
  return app;
}

const app = appFor("sandbox");

describe("headers that Google sign-in depends on", () => {
  it("lets a popup keep its opener, or the credential can never come back", async () => {
    const headers = await headersFor(app);
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    // The helmet default. If this ever reappears, sign-in hangs on a blank modal.
    expect(headers["cross-origin-opener-policy"]).not.toBe("same-origin");
  });

  it("allows the GIS script, frames and calls", async () => {
    const csp = (await headersFor(app))["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).toContain("frame-src 'self' https://accounts.google.com");
    expect(csp).toContain("connect-src 'self' https://accounts.google.com");
  });

  it("still allows the avatar Google returns in the token", async () => {
    const csp = (await headersFor(app))["content-security-policy"] ?? "";
    expect(csp).toContain("https://lh3.googleusercontent.com");
  });
});

describe("headers that Plaid Link depends on", () => {
  /**
   * Every one of these fails silently too. Without the CDN in script-src the
   * widget never loads; without it in frame-src the script loads, create()
   * returns, open() runs, and the iframe stays blank with its close button
   * inside the document that did not boot.
   */
  it("allows the Link script and the frame it renders into", async () => {
    const csp = (await headersFor(app))["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.plaid\.com/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/cdn\.plaid\.com/);
  });

  it("allows Link to reach the API host for the configured environment", async () => {
    const csp = (await headersFor(appFor("sandbox")))["content-security-policy"] ?? "";
    expect(csp).toMatch(/connect-src[^;]*https:\/\/sandbox\.plaid\.com/);
  });

  it("does not open production hosts on a sandbox deployment", async () => {
    const csp = (await headersFor(appFor("sandbox")))["content-security-policy"] ?? "";
    expect(csp).not.toContain("https://production.plaid.com");
    const prod = (await headersFor(appFor("production")))["content-security-policy"] ?? "";
    expect(prod).toContain("https://production.plaid.com");
    expect(prod).not.toContain("https://sandbox.plaid.com");
  });

  it("keeps the sign-in sources while adding the bank ones", async () => {
    // The regression this file exists for: adding a directive by overwriting
    // rather than extending is how sign-in silently broke once already.
    const csp = (await headersFor(app))["content-security-policy"] ?? "";
    expect(csp).toContain("https://accounts.google.com/gsi/client");
    expect(csp).toContain("https://accounts.google.com");
  });
});
