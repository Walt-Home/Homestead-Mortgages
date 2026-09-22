/**
 * Sign in: e-mail, the code that was sent to it, the password. One card, one
 * step at a time, the step you are on named at the top.
 *
 * His rules, kept honest here: the code is the possession factor and opens
 * exactly one sign-in within ten minutes; a first sign-in sets the password
 * instead of asking for it; five wrong answers in an hour lock the account
 * for fifteen minutes. On a deployment whose mail vendor is a fake the
 * server echoes the code, and the page says so in as many words rather than
 * pretending a mail was sent.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { Button, Field, Input, Notice } from "../components/ui.js";
import { Icon } from "../components/Icon.js";
import { Wordmark } from "../components/Shell.js";
import { fmtTime } from "../lib/format.js";

type Step = "email" | "code" | "password" | "set-password";

interface CodeAnswer {
  challenge_id: string;
  delivery: string;
  expires_at: string;
  fake_code?: string;
}
interface VerifyAnswer {
  token: string;
  status: "invited" | "active";
  has_password: boolean;
  roles: string[];
}

export function SignInPage() {
  const { refresh, endedBecause } = useAuth();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [current, setCurrent] = useState("");
  const [changing, setChanging] = useState(false);
  const [fakeCode, setFakeCode] = useState<string | null>(null);
  const [stepToken, setStepToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, [step]);

  const fail = (err: unknown) => {
    const e = err instanceof ApiError ? err : null;
    setLockedUntil(
      typeof e?.extra.locked_until === "string" ? (e.extra.locked_until as string) : null,
    );
    switch (e?.code) {
      case "EMAIL_INVALID":
        return setError("That doesn't look like an e-mail address.");
      case "OTP_INVALID":
        return setError("That code didn't match. Check it and try again, or send a new one.");
      case "OTP_TOO_MANY_ATTEMPTS":
        return setError("Too many tries against that code. Send a new one.");
      case "PASSWORD_WRONG":
        return setError(
          typeof e.extra.locked_until === "string"
            ? "Wrong password, and the account is now locked for fifteen minutes."
            : "Wrong password. Five wrong answers in an hour lock the account.",
        );
      case "ACCOUNT_LOCKED":
        return setError("This account is locked after too many wrong answers.");
      case "FACTOR_REQUIRED":
        setStep("code");
        setCode("");
        return setError("The code has expired. Send a new one and enter the password again.");
      case "PASSWORD_WEAK":
        return setError(
          e.extra.reason === "breached"
            ? "That password appears in a list of breached passwords. Choose another."
            : "Use at least twelve characters.",
        );
      case "PROOF_REQUIRED":
        setChanging(true);
        return setError("Changing a password needs the current one.");
      case "TOKEN_INVALID":
        setStep("code");
        return setError("That step timed out. Send a new code.");
      case "ACCOUNT_DISABLED":
        return setError("This account has been disabled.");
      default:
        return setError(e?.message ?? "Something went wrong. Try again.");
    }
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await api<CodeAnswer>("/auth/code", { body: { email: email.trim() } });
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
      const a = await api<VerifyAnswer>("/auth/verify", {
        body: { email: email.trim(), code: withCode.trim() },
      });
      setStepToken(a.token);
      setPassword("");
      setAgain("");
      setStep(a.has_password ? "password" : "set-password");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (pw: string) => {
    await api("/auth/signin", { body: { email: email.trim(), password: pw } });
    await refresh();
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (changing) {
        if (password !== again) return setError("The two passwords differ.");
        await api("/auth/password", {
          body: { token: stepToken, password, current_password: current },
        });
        await signIn(password);
      } else {
        await signIn(password);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const setNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("The two passwords differ.");
    setBusy(true);
    setError(null);
    try {
      await api("/auth/password", { body: { token: stepToken, password } });
      await signIn(password);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const heading =
    step === "email"
      ? "Sign in"
      : step === "code"
        ? "Check your e-mail"
        : step === "set-password"
          ? "Set your password"
          : changing
            ? "Change your password"
            : "Your password";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-5 py-12">
        <Wordmark className="mb-8" />
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{heading}</h1>
        <p className="mt-1.5 text-base text-fg-2">
          {step === "email" && "The operator console for Supermortgage servicing."}
          {step === "code" && (
            <>
              A six-digit code was sent to <span className="font-medium text-fg">{email}</span>. It
              is good for ten minutes.
            </>
          )}
          {step === "set-password" &&
            "First time here. Choose a password of twelve characters or more."}
          {step === "password" && !changing && "Then you're in."}
          {step === "password" && changing && "Your current password proves it's you."}
        </p>

        {endedBecause === "expired" && step === "email" ? (
          <Notice tone="neutral" className="mt-5">
            Your session ended after thirty minutes idle. Sign in again to pick up where you were.
          </Notice>
        ) : null}

        <div className="mt-6 rounded-xl border border-line-2 bg-surface p-5 shadow-card sm:p-6">
          {step === "email" ? (
            <form onSubmit={sendCode} className="space-y-4">
              <Field label="Work e-mail" htmlFor="email">
                <Input
                  ref={first}
                  id="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  placeholder="you@trywalt.ai"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                Continue
              </Button>
            </form>
          ) : null}

          {step === "code" ? (
            <form onSubmit={verify} className="space-y-4">
              {fakeCode ? (
                <Notice tone="warn" title="No mail leaves this environment">
                  Every vendor here is a stand-in, so the code is shown instead:{" "}
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
                <button
                  type="button"
                  className="text-fg-2 hover:text-fg"
                  onClick={() => setStep("email")}
                >
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
            </form>
          ) : null}

          {step === "password" ? (
            <form onSubmit={submitPassword} className="space-y-4">
              {changing ? (
                <>
                  <Field label="Current password" htmlFor="current">
                    <Input
                      ref={first}
                      id="current"
                      type="password"
                      autoComplete="current-password"
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="New password" htmlFor="password" hint="Twelve characters or more.">
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="New password, again" htmlFor="again">
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
                </>
              ) : (
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
              )}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                {changing ? "Change password and sign in" : "Sign in"}
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  className="text-fg-2 hover:text-fg"
                  onClick={() => setStep("email")}
                >
                  Start over
                </button>
                <button
                  type="button"
                  className="text-fg-2 hover:text-fg"
                  onClick={() => {
                    setChanging((c) => !c);
                    setError(null);
                  }}
                >
                  {changing ? "Keep my password" : "Change password"}
                </button>
              </div>
            </form>
          ) : null}

          {step === "set-password" ? (
            <form onSubmit={setNewPassword} className="space-y-4">
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
          Two factors, always: a code to your e-mail and your password. Every action is recorded
          with your name and role. Forgotten your password? An admin can re-invite you.
        </p>
      </div>
    </div>
  );
}
