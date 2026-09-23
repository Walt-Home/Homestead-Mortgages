/**
 * The screen while the console finds out who you are.
 *
 * `/me` goes through the front door, our API and the servicing app, and
 * both services sleep when nobody is using them, so the first answer of the
 * morning can take the better part of a minute. A blank canvas for that
 * long reads as broken. This says what is happening, and after a while,
 * why — and never asks the person to do anything, because nothing they can
 * do would help.
 */

import { useEffect, useState } from "react";
import { loadingLine } from "../lib/loading.js";
import { Wordmark } from "./Shell.js";

/** Seconds since the screen appeared, ticking once a second. */
function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return seconds;
}

export function Loading({ what = "Signing you in" }: { what?: string }) {
  const seconds = useElapsedSeconds();
  const line = loadingLine(seconds);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-4 text-center"
    >
      <Wordmark />
      <span
        aria-hidden="true"
        className="h-7 w-7 animate-spin rounded-full border-2 border-line-2 border-t-accent"
      />
      <div>
        <div className="text-sm font-medium text-fg">{what}…</div>
        <p className="mt-1 min-h-10 max-w-xs text-sm text-fg-2">{line}</p>
      </div>
    </div>
  );
}
