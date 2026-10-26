/**
 * The security headers, in one place.
 *
 * This lived in two: `index.ts` mounted it and `headers.test.ts` re-declared
 * it, so the test asserted against its own copy and would have gone on passing
 * while the real server served something else. Both now import this.
 *
 * Every entry below is here because omitting it breaks something silently.
 * That is the theme: none of these failures produce an error anyone sees.
 */

import { createHash } from "node:crypto";
import helmet from "helmet";
import type { HelmetOptions } from "helmet";

type Directives = ReturnType<typeof helmet.contentSecurityPolicy.getDefaultDirectives>;

/** Plaid Link's script and the iframe it renders into both come from here. */
const PLAID_CDN = "https://cdn.plaid.com";

export function securityHeaders(plaidEnvironment: "sandbox" | "production"): HelmetOptions {
  return {
    // helmet's default is `same-origin`, which severs `window.opener` for the
    // popup Google Identity Services opens. The popup loads, tries to post the
    // credential back, cannot, and sits there blank forever with no error in
    // either window — indistinguishable from an unregistered OAuth origin, and
    // it cost a round of chasing the wrong thing. It matters twice now: OAuth
    // banks in Plaid Link hand their result back the same way.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: { directives: contentSecurityDirectives(plaidEnvironment) },
  };
}

/** The Content-Security-Policy every response carries, unless a path below says otherwise. */
export function contentSecurityDirectives(plaidEnvironment: "sandbox" | "production"): Directives {
  // Link's own XHRs go to the environment-matched API host. Allowing both
  // would let a production page talk to sandbox, which is not a directive's
  // job to prevent but is free to avoid.
  const plaidApi = `https://${plaidEnvironment}.plaid.com`;
  return {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    // Whole origin rather than the /gsi/ path prefix: GIS moves between
    // several paths on accounts.google.com and a path-scoped source is a
    // subtle breakage waiting for the next SDK change.
    "script-src": ["'self'", "https://accounts.google.com/gsi/client", PLAID_CDN],
    "connect-src": ["'self'", "https://accounts.google.com", plaidApi],
    // Without cdn.plaid.com here the script loads, `Plaid.create` returns,
    // `open()` runs, and the iframe never boots — no error, no callback,
    // and a close button inside the frame that did not load. The widget
    // has a watchdog for it; this is what stops it happening.
    "frame-src": ["'self'", "https://accounts.google.com", PLAID_CDN],
    // Google serves the avatar from the ID token here. Plaid needs
    // nothing: it inlines institution logos as data URIs, which the
    // default already covers.
    "img-src": ["'self'", "data:", "https://lh3.googleusercontent.com"],
  };
}

/**
 * The `'sha256-…'` source of each inline `<script>` in a document, as a
 * browser hashes it: the element's text exactly, after the parser's one
 * normalization of the input, CRLF and CR to LF. A script with a `src` is
 * not inline and is not hashed.
 */
export function inlineScriptHashes(html: string): string[] {
  const text = html.replace(/\r\n?/g, "\n");
  const hashes: string[] = [];
  for (const m of text.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? "")) continue;
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(m[2] ?? "", "utf8")
        .digest("base64")}'`,
    );
  }
  return hashes;
}

/**
 * The Supermortgage Gym's page, at `/console/hm/gym/` on the servicing host
 * (`routes/console-gym.ts`), and only there: the policy above with
 * `script-src` replaced by `'self'` and the hash of each of the page's own
 * inline scripts. It is one document with one inline script, and that
 * script is the page, so without its hash the page is its markup and
 * nothing else. Nothing else is relaxed: the page's one inline `<style>` is
 * already admitted by the default `style-src`, and it loads nothing from
 * another origin, so the Google and Plaid script sources the borrower app
 * needs are dropped here rather than carried.
 */
export function gymContentSecurityDirectives(
  plaidEnvironment: "sandbox" | "production",
  html: string,
): Directives {
  return {
    ...contentSecurityDirectives(plaidEnvironment),
    "script-src": ["'self'", ...inlineScriptHashes(html)],
  };
}
