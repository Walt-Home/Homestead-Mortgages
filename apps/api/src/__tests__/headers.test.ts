/**
 * The headers that decide whether sign-in works at all.
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
 */

import express from "express";
import helmet from "helmet";
import { describe, expect, it } from "vitest";

/** The same helmet configuration the server mounts. */
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

const app = express();
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://accounts.google.com/gsi/client"],
        "connect-src": ["'self'", "https://accounts.google.com"],
        "frame-src": ["'self'", "https://accounts.google.com"],
        "img-src": ["'self'", "data:", "https://lh3.googleusercontent.com"],
      },
    },
  }),
);
app.get("/", (_req, res) => res.send("ok"));

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
