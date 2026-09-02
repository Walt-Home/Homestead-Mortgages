/**
 * The widget, mounted.
 *
 * Everything awkward about Plaid Link on the web is concentrated here so the
 * screen above can stay a plain state machine.
 *
 * Three hazards this exists to handle:
 *
 * **Stale callbacks.** The handler is created once per token and lives across
 * renders, so a callback captured at creation would read the state that was
 * current then. Every callback goes through a ref written on every render.
 *
 * **onExit after onSuccess.** Teardown calls `exit({ force: true })`, and
 * Plaid fires `onExit` in response — after the success we are already acting
 * on. Unguarded, that knocks the screen from "assembling" back to "connect
 * your bank" at the exact moment the report starts building. The `done` ref
 * makes a post-success exit a no-op, and the parent's handler uses the
 * updater form as a second line of defence.
 *
 * **Silence.** If CSP `frame-src` blocks cdn.plaid.com, or an ad blocker
 * null-routes it, the script loads, `create()` returns and `open()` runs — and
 * then nothing. No error, no exit, no event, and an overlay whose close button
 * lives inside the frame that never booted. A watchdog is the only way to
 * detect it, and destroying the handler is what gives the borrower the page
 * back.
 */

import { useEffect, useRef } from "react";
import { loadPlaid, type PlaidExitMetadata, type PlaidLinkError } from "../lib/plaid.js";

/** Long enough for a slow connection, short enough not to strand anyone. */
const OPEN_WATCHDOG_MS = 20_000;

export function PlaidLink({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
  onUnavailable,
}: {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string | null) => void;
  onExit: (error: PlaidLinkError | null, metadata: PlaidExitMetadata) => void;
  onUnavailable: () => void;
}) {
  const cb = useRef({ onSuccess, onExit, onUnavailable });
  cb.current = { onSuccess, onExit, onUnavailable };

  useEffect(() => {
    let cancelled = false;
    let handler: import("../lib/plaid.js").PlaidHandler | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    // Set the moment Link hands us a token. Everything after is teardown.
    let done = false;

    const disarm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = undefined;
    };

    void loadPlaid()
      .then(() => {
        if (cancelled || !window.Plaid) return;
        handler = window.Plaid.create({
          token,
          ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
          onSuccess: (publicToken) => {
            done = true;
            disarm();
            cb.current.onSuccess(publicToken);
          },
          onExit: (error, metadata) => {
            disarm();
            // The teardown exit, arriving after we already succeeded.
            if (done) return;
            cb.current.onExit(error, metadata);
          },
          onEvent: (eventName) => {
            // Link is really on screen; the silent-failure clock can stop.
            if (eventName === "OPEN") disarm();
          },
        });
        handler.open();
        watchdog = setTimeout(() => {
          if (cancelled || done) return;
          handler?.destroy();
          handler = undefined;
          cb.current.onUnavailable();
        }, OPEN_WATCHDOG_MS);
      })
      .catch(() => {
        if (!cancelled) cb.current.onUnavailable();
      });

    return () => {
      cancelled = true;
      disarm();
      handler?.exit({ force: true }, () => handler?.destroy());
    };
    // Exactly these two. Adding the callbacks would tear down and recreate the
    // widget on every parent render, closing it under the borrower.
  }, [token, receivedRedirectUri]);

  return null;
}
