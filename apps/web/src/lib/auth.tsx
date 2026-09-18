/**
 * Who is signed in, and how they get that way.
 *
 * The server is the authority: this asks `/api/auth/me` on load and trusts the
 * answer. Nothing about the session is stored client-side — the cookie is
 * httpOnly, so this code cannot read it and does not try.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, SECOND_FACTOR_REQUIRED, SESSION_EXPIRED } from "./api.js";
import type { ConnectorModes } from "./disclosures.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  /** Set when this session is a sample borrower. Null for a real person. */
  persona: { key: string; name: string | null } | null;
}

/**
 * Where the second step of sign-in stands, as the server reports it.
 *
 * "satisfied" is the gate open — a code was accepted in this session, or the
 * session is a sample borrower's or the local developer's, which have no
 * phone to enroll. The other two are the screens that finish a sign-in:
 * "enroll" when the person has no authenticator yet, "verify" when they do.
 */
export type SecondFactorStanding = "satisfied" | "enroll" | "verify";

/** What every sign-in route and `/me` answer with. */
interface SessionResponse {
  user: AuthUser;
  secondFactor: SecondFactorStanding;
}

/**
 * What a sample borrower is told when the server refuses a write.
 *
 * The demo-file refusal already has copy on each screen that carries it, and
 * this is the session-level twin: it can arrive from any route, including ones
 * with no file behind them, so the sentence says "account" rather than "file".
 */
export const PERSONA_READ_ONLY = "This is a sample account, so it is read-only.";

interface AuthConfig {
  googleClientId: string | null;
  allowedDomain: string | null;
  developerSignInAvailable: boolean;
  /**
   * Which adapter is behind each connector on this deployment.
   *
   * It replaced `identityRequiresRedirect`, a boolean that answered two
   * questions with one bit: whether screen 2's button leaves the site, and
   * whether the check it starts is a test-mode one. `lib/disclosures.ts` is
   * where these values become words.
   */
  connectorModes?: ConnectorModes;
  /** Whether /states is served at all. A design surface, off by default. */
  stateGalleryEnabled?: boolean;
  /** Whether the sign-in page offers the sample borrowers. Staging only. */
  demoPersonasEnabled?: boolean;
}

/**
 * Whether this session may open the state gallery at /states.
 *
 * The flag on its own was not a gate. STATE_GALLERY is set on the deployed
 * service, so the whole of the protection was sign-in — and sign-in is open to
 * any Google account. What the gallery renders is 34 worked examples with
 * invented figures, which to somebody who has a file of their own reads as
 * figures about it.
 *
 * So it takes both flags and the session. DEMO_PERSONAS is the flag this repo
 * already uses to mean "not the real product": it mounts a session minter that
 * needs no Google credential and must never be set on a production deploy, so
 * where it is off the gallery is off with it. On the deployment where it IS on,
 * the sample borrowers are what the sign-in page hands to anyone who asks, and
 * a session holding one is the borrower-shaped session there — so it is
 * refused, the same way every write from it is.
 *
 * Refusal is the route not existing. The catch-all answers /states exactly as
 * it answers a typo, which is what the flag being off has always looked like.
 */
export function stateGalleryVisible(
  config: Pick<AuthConfig, "stateGalleryEnabled" | "demoPersonasEnabled"> | null,
  user: Pick<AuthUser, "persona"> | null,
): boolean {
  if (!config?.stateGalleryEnabled || !config.demoPersonasEnabled) return false;
  return user !== null && user.persona === null;
}

/**
 * Whether the vendor demo page is reachable: the same "not the real product"
 * test the gallery uses, without the persona refusal. The demo reads public
 * county data about an address a person types and touches no file, so a
 * session holding a sample borrower can use it — the lookup is on a GET for
 * exactly that reason — and there is nothing on the page a tester could read
 * as a fact about their sample borrower.
 */
export function vendorDemoVisible(
  config: Pick<AuthConfig, "demoPersonasEnabled"> | null,
  user: Pick<AuthUser, "persona"> | null,
): boolean {
  return Boolean(config?.demoPersonasEnabled) && user !== null;
}

interface AuthState {
  status: "loading" | "signed-in" | "signed-out";
  user: AuthUser | null;
  /**
   * Null until the server has said. While it is "enroll" or "verify" the app
   * renders that step in place of everything else, the way it renders the
   * sign-in page in place of everything while signed out.
   */
  secondFactor: SecondFactorStanding | null;
  /** The step is done: a code was accepted. Called by the screen that sent it. */
  completeSecondFactor: () => void;
  config: AuthConfig | null;
  signInWithGoogle: (credential: string) => Promise<void>;
  signInAsDeveloper: () => Promise<void>;
  signInAsPersona: (key: string) => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [secondFactor, setSecondFactor] = useState<SecondFactorStanding | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await api.get<AuthConfig>("/auth/config").catch(() => null);
      if (!cancelled) setConfig(cfg);
      try {
        const me = await api.get<SessionResponse>("/auth/me");
        if (!cancelled) {
          setUser(me.user);
          setSecondFactor(me.secondFactor);
          setStatus("signed-in");
        }
      } catch {
        // A 401 here is the normal state for a visitor, not an error worth
        // showing. Anything else is also not actionable by them.
        if (!cancelled) setStatus("signed-out");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A session can end while somebody is halfway through the flow. Without
  // this the app kept rendering screens whose every request failed.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setSecondFactor(null);
      setStatus("signed-out");
      setError("Your session ended. Sign in again to pick up where you left off.");
    };
    window.addEventListener(SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired);
  }, []);

  // The server can also say the second step is still to do — a session that
  // was identified in another tab, say, and never finished. The screen for
  // it replaces whatever was being asked for, and the URL survives.
  useEffect(() => {
    const onRequired = (event: Event) => {
      const standing = (event as CustomEvent<{ standing: SecondFactorStanding }>).detail?.standing;
      if (standing === "enroll" || standing === "verify") setSecondFactor(standing);
    };
    window.addEventListener(SECOND_FACTOR_REQUIRED, onRequired);
    return () => window.removeEventListener(SECOND_FACTOR_REQUIRED, onRequired);
  }, []);

  const finish = useCallback((next: SessionResponse) => {
    setUser(next.user);
    setSecondFactor(next.secondFactor);
    setStatus("signed-in");
    setError(null);
  }, []);

  const completeSecondFactor = useCallback(() => setSecondFactor("satisfied"), []);

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      try {
        const r = await api.post<SessionResponse>("/auth/google", { credential });
        finish(r);
      } catch (err) {
        setError(
          err instanceof ApiError && err.code === "DOMAIN_NOT_ALLOWED"
            ? err.message
            : "That sign-in didn't work. Try again?",
        );
      }
    },
    [finish],
  );

  const signInAsDeveloper = useCallback(async () => {
    const r = await api.post<SessionResponse>("/auth/developer", {});
    finish(r);
  }, [finish]);

  /**
   * Sign in as one of the seeded sample borrowers.
   *
   * The same three lines as the developer shortcut, because it is the same
   * kind of thing: a real session for a real row, minted without a Google
   * credential. The URL is left alone, so a link straight to a persona's file
   * lands on it rather than on the file list.
   */
  const signInAsPersona = useCallback(
    async (key: string) => {
      try {
        const r = await api.post<SessionResponse>(`/auth/personas/${key}`, {});
        finish(r);
      } catch (err) {
        setError(
          err instanceof ApiError && err.code === "PERSONAS_NOT_SEEDED"
            ? "The sample borrowers are not on this deployment yet."
            : "That sign-in didn't work. Try again?",
        );
      }
    },
    [finish],
  );

  const signOut = useCallback(async () => {
    await api.post("/auth/signout", {});
    setUser(null);
    setSecondFactor(null);
    setStatus("signed-out");
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        secondFactor,
        completeSecondFactor,
        config,
        signInWithGoogle,
        signInAsDeveloper,
        signInAsPersona,
        signOut,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
