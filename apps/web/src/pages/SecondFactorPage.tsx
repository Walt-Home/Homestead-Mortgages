/**
 * The second step of sign-in: set up an authenticator app, or enter the code
 * from one.
 *
 * Rendered IN PLACE for every path while the session is identified and not
 * yet authenticated, the way SignInPage is for a signed-out deep link — so the
 * URL survives, and finishing lands the person on the file they asked for.
 *
 * The same screen serves a new phone, at /second-factor from the privacy page:
 * the same enrollment, against a session that has already presented a code.
 * The server refuses it from one that has not, so a stolen Google password is
 * not enough to swap the phone.
 *
 * The QR code is drawn here, in the browser, from the URI the server hands
 * over. Nothing about it goes back over the wire, and the key is printed
 * beside it for a person who cannot point a camera at their own screen.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toDataURL } from "qrcode";
import { api, ApiError } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { Lockup } from "../components/Wordmark.js";
import { Footer } from "../components/Footer.js";
import {
  SECOND_FACTOR_COPY as COPY,
  codeKind,
  errorFor,
  formatSecret,
} from "../lib/second-factor.js";

interface Enrollment {
  secret: string;
  otpauthUri: string;
}

export type SecondFactorMode = "enroll" | "verify" | "replace";

export function SecondFactorPage({ mode }: { mode: SecondFactorMode }) {
  const body = mode === "verify" ? <Verify /> : <Enroll replacing={mode === "replace"} />;

  // Replacing an authenticator happens inside the signed-in app, under its
  // own header and footer. The two sign-in steps stand alone, like SignInPage.
  if (mode === "replace") return <div className="mx-auto max-w-md px-6 py-12">{body}</div>;

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-1 flex-col justify-center px-6">
        <Lockup className="text-accent" />
        {body}
        <SignOutLine />
      </div>
      <Footer />
    </div>
  );
}

/**
 * Somebody without their phone has to be able to leave: a screen they cannot
 * pass and cannot back out of is a locked room.
 */
function SignOutLine() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <p className="mt-10 text-xs text-ink-faint">
      {user?.email && <span className="text-ink-muted">{user.email} · </span>}
      <button className="super-link-quiet" onClick={() => void signOut().then(() => navigate("/"))}>
        {COPY.signOut}
      </button>
    </p>
  );
}

function Enroll({ replacing }: { replacing: boolean }) {
  const { completeSecondFactor } = useAuth();
  const navigate = useNavigate();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const started = await api.post<Enrollment>("/auth/second-factor/enroll", {});
        if (cancelled) return;
        setEnrollment(started);
        const image = await toDataURL(started.otpauthUri, { margin: 2, width: 208 });
        if (!cancelled) setQr(image);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : COPY.errors.couldNotStart);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await api.post<{ recoveryCodes: string[] }>(
        "/auth/second-factor/enroll/confirm",
        { code },
      );
      setRecoveryCodes(done.recoveryCodes);
    } catch (err) {
      setError(errorFor(err, "app"));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function saved() {
    if (replacing) navigate("/privacy");
    else completeSecondFactor();
  }

  if (recoveryCodes) {
    return (
      <>
        <h1 className="mt-6 font-display text-3xl text-ink">{COPY.recovery.title}</h1>
        <p className="mt-3 text-base text-ink-soft">{COPY.recovery.body}</p>
        <ul className="super-card mt-6 grid grid-cols-2 gap-x-6 gap-y-2">
          {recoveryCodes.map((c) => (
            <li key={c}>
              <code className="text-base text-ink">{c}</code>
            </li>
          ))}
        </ul>
        <button className="super-btn super-btn-primary mt-8" onClick={saved}>
          {COPY.recovery.confirm}
        </button>
      </>
    );
  }

  const copy = replacing ? COPY.replace : COPY.enroll;
  return (
    <>
      <h1 className="mt-6 font-display text-3xl text-ink">{copy.title}</h1>
      <p className="mt-3 text-base text-ink-soft">{copy.body}</p>

      {enrollment && (
        <div className="mt-6">
          {/*
            The image carries its own light ground: a QR code is dark modules
            on light, and a phone camera reads nothing off the black page.
          */}
          {qr && <img src={qr} alt="" width={208} height={208} />}
          <p className="mt-4 text-sm text-ink-muted">{COPY.enroll.cannotScan}</p>
          <code className="mt-1 block text-sm text-ink">{formatSecret(enrollment.secret)}</code>
        </div>
      )}

      <form onSubmit={(e) => void confirm(e)} className="mt-6">
        <label className="super-label" htmlFor="second-factor-code">
          {COPY.enroll.codeLabel}
        </label>
        <input
          id="second-factor-code"
          className="super-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={!enrollment || busy}
        />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <button
          type="submit"
          className="super-btn super-btn-primary mt-5"
          disabled={!enrollment || busy || code.length < 6}
        >
          {busy ? COPY.enroll.working : COPY.enroll.submit}
        </button>
      </form>
      {replacing && (
        <p className="mt-6 text-sm">
          <Link to="/privacy" className="super-link-quiet">
            Never mind
          </Link>
        </p>
      )}
    </>
  );
}

function Verify() {
  const { completeSecondFactor } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/second-factor/verify", { code });
      completeSecondFactor();
    } catch (err) {
      setError(errorFor(err, codeKind(code)));
      setCode("");
      setBusy(false);
    }
  }

  function swap() {
    setUseRecovery((v) => !v);
    setCode("");
    setError(null);
  }

  return (
    <>
      <h1 className="mt-6 font-display text-3xl text-ink">{COPY.verify.title}</h1>
      <p className="mt-3 text-base text-ink-soft">
        {useRecovery ? COPY.verify.recoveryBody : COPY.verify.body}
      </p>

      <form onSubmit={(e) => void submit(e)} className="mt-8">
        <label className="super-label" htmlFor="second-factor-code">
          {useRecovery ? COPY.verify.recoveryLabel : COPY.verify.codeLabel}
        </label>
        <input
          id="second-factor-code"
          className="super-input"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          maxLength={useRecovery ? 12 : 6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          autoFocus
        />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <button
          type="submit"
          className="super-btn super-btn-primary mt-5"
          disabled={busy || code.replace(/[\s-]/g, "").length < 6}
        >
          {busy ? COPY.verify.working : COPY.verify.submit}
        </button>
      </form>

      <p className="mt-6 text-sm">
        <button className="super-link-quiet" onClick={swap}>
          {useRecovery ? COPY.verify.useApp : COPY.verify.useRecovery}
        </button>
      </p>
    </>
  );
}
