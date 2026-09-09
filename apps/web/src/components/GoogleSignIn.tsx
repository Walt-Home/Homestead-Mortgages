/**
 * The Google sign-in control, wherever sign-in is offered.
 *
 * The button is rendered by Google itself — a hand-rolled one would be against
 * their branding terms and would not get One Tap.
 *
 * KNOWN TRADE, and it changed when `/` became public. The script is still
 * loaded lazily rather than from index.html, but this component now mounts on
 * the public landing page, so every anonymous visitor DOES reach
 * accounts.google.com whether or not they ever sign in. index.html's claim
 * about no third-party request before sign-in is now true only of fonts.
 * Deferring the script until somebody presses something would restore it, at
 * the cost of a click on the one action the page exists for.
 *
 * Extracted from SignInPage when `/` became public, because the landing page
 * offers sign-in too and two copies of this would be two places for the GSI
 * lifecycle to drift.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth.js";
import { PersonaPicker } from "./PersonaPicker.js";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: {
            client_id: string;
            callback: (r: { credential: string }) => void;
            auto_select?: boolean;
            error_callback?: (e: { type?: string; message?: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("gsi failed")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("gsi failed"));
    document.head.appendChild(script);
  });
}

export function GoogleSignIn({
  /**
   * `page` is the sign-in screen a person was sent to, and shows the origin
   * hint unconditionally — see the note below. `hero` is the public landing
   * page, where that hint is developer noise in front of a stranger, so it
   * appears only once something has actually gone wrong.
   */
  variant = "page",
}: {
  variant?: "page" | "hero";
}) {
  const { config, signInWithGoogle, signInAsDeveloper, error } = useAuth();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [scriptFailed, setScriptFailed] = useState(false);

  useEffect(() => {
    const clientId = config?.googleClientId;
    if (!clientId || !buttonRef.current) return;
    let cancelled = false;

    loadGsi()
      .then(() => {
        if (cancelled || !buttonRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => void signInWithGoogle(r.credential),
          // Google's popup fails silently on an unregistered origin — you get
          // a blank accounts.google.com frame and no callback ever fires,
          // which is indistinguishable from a hung network. Naming the origin
          // turns twenty minutes of guessing into one line to copy.
          error_callback: (e) =>
            setGoogleError(
              `Google refused the sign-in (${e.type ?? "unknown"}). The usual cause is that ` +
                `${window.location.origin} is not an authorised JavaScript origin on the OAuth client.`,
            ),
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
        });
      })
      .catch(() => setScriptFailed(true));

    return () => {
      cancelled = true;
    };
  }, [config?.googleClientId, signInWithGoogle]);

  /*
   * Only the two failures that are ACTUALLY about the OAuth origin.
   *
   * `error` from useAuth is an ordinary rejected sign-in — a wrong domain, a
   * declined account — and including it here put "this page must be an
   * authorised JavaScript origin" in front of a stranger on the public page
   * every time somebody mistyped their way out of a login.
   */
  const originProblem = Boolean(scriptFailed || googleError);
  const align = variant === "hero" ? "items-center text-center" : "items-start";

  return (
    <div className={`flex flex-col ${align}`}>
      <div ref={buttonRef} />

      {/*
        Config never arrived. Every branch below is keyed on `config`, so
        without this the public landing page renders a hero with no action
        under it and no hint that anything is wrong.
      */}
      {!config && (
        <p className="max-w-measure-prose text-sm text-ink-muted">
          Sign-in is not available right now. Please try again in a moment.
        </p>
      )}

      {config && !config.googleClientId && (
        <div className="mt-2">
          {config.developerSignInAvailable ? (
            <>
              <button
                className="super-btn super-btn-outline"
                onClick={() => void signInAsDeveloper()}
              >
                Continue as local developer
              </button>
              <p className="mt-3 max-w-measure-prose text-xs text-ink-faint">
                No Google client is configured, so this is running the local development shortcut.
                It is unavailable in production.
              </p>
            </>
          ) : (
            <p className="text-sm text-danger">Sign-in is not configured on this deployment.</p>
          )}
        </div>
      )}

      {scriptFailed && (
        <p className="mt-5 max-w-measure-prose text-sm text-danger">
          Google&rsquo;s sign-in script didn&rsquo;t load. An ad blocker or a blocked third-party
          script will do this.
        </p>
      )}
      {googleError && <p className="mt-5 max-w-measure-prose text-sm text-danger">{googleError}</p>}
      {error && <p className="mt-5 max-w-measure-prose text-sm text-danger">{error}</p>}

      {/*
        The sample borrowers, where a deployment has them. Here rather than in
        either page, because both sign-in surfaces render this component and a
        picker in one of them would be a picker a deep link never reaches.
      */}
      {config?.demoPersonasEnabled && <PersonaPicker />}

      {/*
        The popup can also die without firing error_callback at all — an
        unregistered origin is the common case. On the sign-in screen the
        origin is shown unconditionally, so the answer is on screen before
        anyone goes looking for it. On the public landing page that sentence
        is addressed to nobody who is standing there, so it waits until
        something is actually broken.
      */}
      {(variant === "page" || originProblem) && (
        <p className="mt-10 max-w-measure-prose text-xs text-ink-faint">
          Trouble signing in? This page is served from{" "}
          <code className="text-ink-muted">{window.location.origin}</code>, which must be an
          authorised JavaScript origin on the OAuth client.
        </p>
      )}
    </div>
  );
}
