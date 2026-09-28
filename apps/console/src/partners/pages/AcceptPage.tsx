/**
 * Taking an invitation, at `/console/accept#<token>`: the link is the first
 * factor, the password chosen here the second, and the person is signed in
 * on the spot. The token rides in the URL's fragment, which a browser never
 * sends to a server, so the page reads it off `location.hash` and posts it
 * in a body.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, Notice } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { Icon } from "../../components/Icon.js";
import { fmtDate } from "../../lib/format.js";
import { portal, PortalError } from "../api.js";
import { usePortalAuth } from "../auth.js";
import { PortalWordmark } from "../Shell.js";

interface Preview {
  servicerName: string;
  email: string;
  name: string | null;
  expiresAt: string;
}

export function AcceptPage() {
  const { refresh } = usePortalAuth();
  const navigate = useNavigate();
  const token = window.location.hash.replace(/^#/, "");
  const [preview, setPreview] = useState<Preview | null | "dead">(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) {
      setPreview("dead");
      return;
    }
    portal<Preview>("/auth/invitation", { body: { token } })
      .then(setPreview)
      .catch(() => setPreview("dead"));
  }, [token]);

  useEffect(() => {
    if (preview && preview !== "dead") first.current?.focus();
  }, [preview]);

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("The two passwords differ.");
    setBusy(true);
    setError(null);
    try {
      await portal("/auth/accept", { body: { token, password } });
      await refresh();
      navigate("/portal", { replace: true });
    } catch (err) {
      const code = err instanceof PortalError ? err.code : null;
      setError(
        code === "PASSWORD_WEAK"
          ? "Use at least twelve characters."
          : code === "NOT_FOUND"
            ? "That link is not good any more. Ask Supermortgage for a new invitation."
            : err instanceof Error
              ? err.message
              : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (preview === null) return <Loading what="Reading your invitation" />;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-5 py-12">
        <PortalWordmark />
        {preview === "dead" ? (
          <>
            <h1 className="mt-8 text-2xl font-semibold tracking-tight text-fg">
              That link is not good any more
            </h1>
            <p className="mt-1.5 text-base text-fg-2">
              It was taken already, it expired, or a newer one was sent. Ask Supermortgage for a
              fresh invitation, or sign in if you already have a password.
            </p>
            <div className="mt-6">
              <Button variant="primary" onClick={() => navigate("/", { replace: true })}>
                Sign in
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-8 text-2xl font-semibold tracking-tight text-fg">
              Set your password
            </h1>
            <p className="mt-1.5 text-base text-fg-2">
              {preview.name ? `${preview.name}, you` : "You"} were invited to see{" "}
              <span className="font-medium text-fg">{preview.servicerName}</span>&rsquo;s book on
              Supermortgage as <span className="font-medium text-fg">{preview.email}</span>. This
              link is good until {fmtDate(preview.expiresAt)}.
            </p>
            <div className="mt-6 rounded-xl border border-line-2 bg-surface p-5 shadow-card sm:p-6">
              <form onSubmit={accept} className="space-y-4">
                <Field
                  label="Password"
                  htmlFor="password"
                  hint="Twelve characters or more. A phrase works well."
                >
                  <Input
                    ref={first}
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Password, again" htmlFor="again">
                  <Input
                    id="again"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    value={again}
                    onChange={(e) => setAgain(e.target.value)}
                    required
                  />
                </Field>
                <Button type="submit" variant="primary" className="w-full" loading={busy}>
                  Set password and sign in
                </Button>
                {error ? (
                  <p className="flex items-start gap-2 text-sm text-danger" role="alert">
                    <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </p>
                ) : null}
              </form>
            </div>
            <Notice tone="neutral" className="mt-6">
              From then on, signing in is a code to this address and your password.
            </Notice>
          </>
        )}
      </div>
    </div>
  );
}
