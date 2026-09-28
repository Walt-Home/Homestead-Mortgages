/**
 * The servicer door of the console's one sign-in: the entry page took the
 * e-mail; this is the code sent to it, then the password. One card, one
 * step at a time — the staff door's shape, against our own API.
 *
 * The code is the possession factor and opens exactly one sign-in within
 * ten minutes; five wrong passwords in an hour lock the account for
 * fifteen minutes. On a deployment whose mailer is a stand-in the server
 * echoes the code, and the page says so rather than pretend a mail went.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Input, Notice } from "../../components/ui.js";
import { Icon } from "../../components/Icon.js";
import { fmtTime } from "../../lib/format.js";
import { portal, PortalError } from "../api.js";
import { usePortalAuth } from "../auth.js";
import { PortalWordmark } from "../Shell.js";

type Step = "code" | "password";

interface CodeAnswer {
  delivery: string;
  expires_in: number;
  fake_code?: string;
}

export function ServicerSignInPage({
  initialEmail,
  onBack,
  onStaff,
}: {
  /** The address the entry page took; the code goes out as the page opens. */
  initialEmail: string;
  /** Back to the one field. */
  onBack: () => void;
  /** The same address, at the staff door instead. */
  onStaff: () => void;
}) {
  const { refresh } = usePortalAuth();
  const [step, setStep] = useState<Step>("code");
  const [email] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [fakeCode, setFakeCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, [step]);

  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void sendCode();
  }, []);

  const fail = (err: unknown) => {
    const e = err instanceof PortalError ? err : null;
    const until = typeof e?.extra.locked_until === "string" ? e.extra.locked_until : null;
    setLockedUntil(until);
    switch (e?.code) {
      case "EMAIL_INVALID":
      case "VALIDATION_ERROR":
        return setError("That doesn't look like an e-mail address.");
      case "OTP_INVALID":
        return setError(
          "That code didn't match. If this address isn't on a servicer's team yet, no code will: Supermortgage invites your team. Otherwise check it and try again, or send a new one.",
        );
      case "OTP_TOO_MANY_ATTEMPTS":
        return setError("Too many tries against that code. Send a new one.");
      case "PASSWORD_WRONG":
        return setError(
          until
            ? "Wrong password, and the account is now locked for fifteen minutes."
            : "Wrong password. Five wrong answers in an hour lock the account.",
        );
      case "ACCOUNT_LOCKED":
        return setError("This account is locked after too many wrong answers.");
      case "FACTOR_REQUIRED":
        setStep("code");
        setCode("");
        return setError("The code has expired. Send a new one and enter the password again.");
      default:
        return setError(e?.message ?? "Something went wrong. Try again.");
    }
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await portal<CodeAnswer>("/auth/code", { body: { email: email.trim() } });
      setFakeCode(a.fake_code ?? null);
      setCode("");
      setStep("code");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e?: FormEvent, withCode = code) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await portal("/auth/verify", { body: { email: email.trim(), code: withCode.trim() } });
      setPassword("");
      setStep("password");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await portal("/auth/signin", { body: { password } });
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const heading = step === "code" ? "Check your e-mail" : "Your password";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-5 py-12">
        <PortalWordmark />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-fg">{heading}</h1>
        <p className="mt-1.5 text-base text-fg-2">
          {step === "code" && (
            <>
              A six-digit code was sent to <span className="font-medium text-fg">{email}</span>. It
              is good for ten minutes.
            </>
          )}
          {step === "password" && "Then you're in."}
        </p>

        <div className="mt-6 rounded-xl border border-line-2 bg-surface p-5 shadow-card sm:p-6">
          {step === "code" ? (
            <form onSubmit={verify} className="space-y-4">
              {fakeCode ? (
                <Notice tone="warn" title="No mail leaves this environment">
                  The mailer here is a stand-in, so the code is shown instead:{" "}
                  <span className="font-mono text-md font-semibold tracking-[0.2em] text-fg">
                    {fakeCode}
                  </span>
                  <div className="mt-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setCode(fakeCode);
                        void verify(undefined, fakeCode);
                      }}
                    >
                      Use this code
                    </Button>
                  </div>
                </Notice>
              ) : null}
              <Field label="Code" htmlFor="code">
                <Input
                  ref={first}
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="123456"
                  className="font-mono text-[20px] tracking-[0.3em] sm:text-xl"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                loading={busy}
                disabled={code.length < 6}
              >
                Continue
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" className="text-fg-2 hover:text-fg" onClick={onBack}>
                  Different e-mail
                </button>
                <button
                  type="button"
                  className="text-fg-2 hover:text-fg"
                  onClick={() => void sendCode()}
                >
                  Send a new code
                </button>
              </div>
              <p className="text-sm text-fg-3">
                Supermortgage staff?{" "}
                <button
                  type="button"
                  className="text-fg-2 underline hover:text-fg"
                  onClick={onStaff}
                >
                  Sign in at the staff door
                </button>
                .
              </p>
            </form>
          ) : null}

          {step === "password" ? (
            <form onSubmit={signIn} className="space-y-4">
              <Field label="Password" htmlFor="password">
                <Input
                  ref={first}
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                Sign in
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" className="text-fg-2 hover:text-fg" onClick={onBack}>
                  Start over
                </button>
              </div>
            </form>
          ) : null}

          {error ? (
            <p className="mt-4 flex items-start gap-2 text-sm text-danger" role="alert">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
              <span>
                {error}
                {lockedUntil ? ` Try again after ${fmtTime(lockedUntil)}.` : ""}
              </span>
            </p>
          ) : null}
        </div>

        <p className="mt-6 text-sm text-fg-3">
          Two factors, always: a code to your e-mail and your password. Forgotten your password?
          Supermortgage can send you a new invitation.
        </p>
      </div>
    </div>
  );
}
