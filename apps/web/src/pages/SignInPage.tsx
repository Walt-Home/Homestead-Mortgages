import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth.js";
import { PrototypeBanner } from "../components/PrototypeBanner.js";

/**
 * Sign-in.
 *
 * Google Identity Services is loaded lazily rather than from a script tag in
 * index.html, so a person who never reaches this page never talks to Google.
 * The button is rendered by Google itself — a hand-rolled one would be against
 * their branding terms and would not get One Tap.
 */

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

export function SignInPage() {
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

  return (
    <>
      <PrototypeBanner />
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
        <span className="font-brand text-[15px] font-bold tracking-tight text-gold">
          Homestead Mortgages
        </span>
        <h1 className="mt-6 font-brand text-[28px] font-semibold leading-tight text-ink-editorial">
          Sign in to continue
        </h1>
        <p className="mt-3 font-prose text-[16px] leading-relaxed text-ink-prose">
          {config?.allowedDomain
            ? `Use your ${config.allowedDomain} account.`
            : "Any Google account works."}
        </p>

        <div className="mt-8" ref={buttonRef} />

        {config && !config.googleClientId && (
          <div className="mt-2">
            {config.developerSignInAvailable ? (
              <>
                <button className="btn-secondary" onClick={() => void signInAsDeveloper()}>
                  Continue as local developer
                </button>
                <p className="mt-3 text-[12px] leading-relaxed text-subtle">
                  No Google client is configured, so this is running the local development shortcut.
                  It is unavailable in production.
                </p>
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-error">
                Sign-in is not configured on this deployment.
              </p>
            )}
          </div>
        )}

        {scriptFailed && (
          <p className="mt-5 text-[13px] leading-relaxed text-error">
            Google&rsquo;s sign-in script didn&rsquo;t load. An ad blocker or a blocked third-party
            script will do this.
          </p>
        )}

        {googleError && (
          <p className="mt-5 text-[13px] leading-relaxed text-error">{googleError}</p>
        )}

        {error && <p className="mt-5 text-[13px] text-error">{error}</p>}

        {/* The popup can also die without firing error_callback at all — an
            unregistered origin is the common case. Showing the origin
            unconditionally means the answer is on screen before anyone has to
            go looking for it. */}
        <p className="mt-10 text-[11px] leading-relaxed text-subtle">
          Trouble signing in? This page is served from{" "}
          <code className="text-meta">{window.location.origin}</code>, which must be an authorised
          JavaScript origin on the OAuth client.
        </p>
      </div>
    </>
  );
}
