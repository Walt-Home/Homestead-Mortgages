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

import helmet from "helmet";
import type { HelmetOptions } from "helmet";

/** Plaid Link's script and the iframe it renders into both come from here. */
const PLAID_CDN = "https://cdn.plaid.com";

export function securityHeaders(plaidEnvironment: "sandbox" | "production"): HelmetOptions {
  // Link's own XHRs go to the environment-matched API host. Allowing both
  // would let a production page talk to sandbox, which is not a directive's
  // job to prevent but is free to avoid.
  const plaidApi = `https://${plaidEnvironment}.plaid.com`;

  return {
    // helmet's default is `same-origin`, which severs `window.opener` for the
    // popup Google Identity Services opens. The popup loads, tries to post the
    // credential back, cannot, and sits there blank forever with no error in
    // either window — indistinguishable from an unregistered OAuth origin, and
    // it cost a round of chasing the wrong thing. It matters twice now: OAuth
    // banks in Plaid Link hand their result back the same way.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: {
      directives: {
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
      },
    },
  };
}
