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

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  const { token } = useParams<{ token: string }>();
  const { status, config } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);

  const preview = useQuery({
    queryKey: ["claim", token],
    queryFn: () => api.get<ClaimPreview>(`/auth/claims/${token}`),
    enabled: Boolean(token),
    retry: false,
  });

  // Signed in with a good link: take it, once, and go.
  useEffect(() => {
    if (status !== "signed-in" || !token || !preview.data || taking) return;
    setTaking(true);
    void api
      .post<{ loanFileId: string; borrowerId: string }>(`/auth/claims/${token}/accept`, {})
      .then((claimed) => navigate(`/f/${claimed.loanFileId}/identity`, { replace: true }))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : CLAIM_COPY.couldNotTake);
        setTaking(false);
      });
  }, [status, token, preview.data, taking, navigate]);

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
              <p className="mt-8 text-base text-ink-soft">{error ?? CLAIM_COPY.taking}</p>
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
