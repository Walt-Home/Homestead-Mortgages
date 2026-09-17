/**
 * The page a co-borrower's invitation link opens.
 *
 * Signed out, it shows what the email already said — who is applying, where,
 * and that the reader was named — and offers the same Google sign-in as
 * everything else; the URL survives signing in, so the same page then takes
 * the invitation. Signed in, it takes it at once and sends the person to
 * their own screen 2, which is the first thing the application needs from
 * them and the first thing that is theirs to state.
 *
 * A link that is not good any more says so and nothing else. Which way it
 * stopped being good — expired, taken, revoked, never real — is a fact about
 * somebody's application, and this page is the one screen a stranger can
 * reach with nothing but a string.
 */

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { Lockup } from "../components/Wordmark.js";
import { Footer } from "../components/Footer.js";
import { GoogleSignIn } from "../components/GoogleSignIn.js";
import { CLAIM_COPY } from "../lib/outcomes.js";

interface ClaimPreview {
  coBorrowerFirstName: string;
  applicantFirstName: string;
  propertyCity: string | null;
  expiresAt: string;
}

export function ClaimPage() {
  // The token rides in the fragment, which a browser never sends to any
  // server: it reaches neither our logs nor the platform's.
  const token = window.location.hash.replace(/^#/, "") || undefined;
  const { status, config } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);

  const preview = useQuery({
    queryKey: ["claim", token],
    queryFn: () => api.post<ClaimPreview>("/auth/claims/preview", { token }),
    enabled: Boolean(token),
    retry: false,
  });

  // Taking it is a press, not a page load: whoever is signed in on this
  // browser is not necessarily the person the link was sent to, and a merge
  // is not undone. Once: a failed attempt stays failed rather than retrying
  // on every render.
  const attempted = useRef(false);
  async function takeIt() {
    if (!token || attempted.current) return;
    attempted.current = true;
    setTaking(true);
    try {
      const claimed = await api.post<{ loanFileId: string; borrowerId: string }>(
        "/auth/claims/accept",
        { token },
      );
      navigate(`/f/${claimed.loanFileId}/identity`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : CLAIM_COPY.couldNotTake);
      setTaking(false);
    }
  }

  const dead = preview.isError || (preview.isSuccess && !preview.data);

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-1 flex-col justify-center px-6">
        <Lockup className="text-accent" />
        {dead ? (
          <>
            <h1 className="mt-6 font-display text-3xl text-ink">{CLAIM_COPY.deadTitle}</h1>
            <p className="mt-3 text-base text-ink-soft">{CLAIM_COPY.deadBody}</p>
          </>
        ) : preview.data ? (
          <>
            <h1 className="mt-6 font-display text-3xl text-ink">
              {CLAIM_COPY.title(preview.data.coBorrowerFirstName)}
            </h1>
            <p className="mt-3 text-base text-ink-soft">
              {CLAIM_COPY.body(preview.data.applicantFirstName, preview.data.propertyCity)}
            </p>
            <p className="mt-2 text-sm text-ink-muted">{CLAIM_COPY.yours}</p>
            {status === "signed-in" ? (
              <div className="mt-8">
                {error && <p className="mb-3 text-sm text-danger">{error}</p>}
                <button
                  className="super-btn super-btn-primary"
                  onClick={() => void takeIt()}
                  disabled={taking || attempted.current}
                >
                  {taking ? CLAIM_COPY.taking : CLAIM_COPY.thisIsMe}
                </button>
              </div>
            ) : (
              <div className="mt-8">
                <p className="mb-3 text-sm text-ink-muted">
                  {config?.allowedDomain
                    ? `Sign in with your ${config.allowedDomain} account to continue.`
                    : CLAIM_COPY.signIn}
                </p>
                <GoogleSignIn />
              </div>
            )}
          </>
        ) : (
          <p className="mt-6 text-base text-ink-soft">{CLAIM_COPY.looking}</p>
        )}
      </div>
      <Footer />
    </div>
  );
}
