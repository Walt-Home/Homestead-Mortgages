/**
 * Who is signed in, and how they get that way.
 *
 * The server is the authority: this asks `/api/auth/me` on load and trusts the
 * answer. Nothing about the session is stored client-side — the cookie is
 * httpOnly, so this code cannot read it and does not try.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, SESSION_EXPIRED } from "./api.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  /** Set when this session is a sample borrower. Null for a real person. */
  persona: { key: string; name: string | null } | null;
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
  /** Whether the ID check navigates away to a vendor. */
  identityRequiresRedirect?: boolean;
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

interface AuthState {
  status: "loading" | "signed-in" | "signed-out";
  user: AuthUser | null;
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
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await api.get<AuthConfig>("/auth/config").catch(() => null);
      if (!cancelled) setConfig(cfg);
      try {
        const me = await api.get<{ user: AuthUser }>("/auth/me");
        if (!cancelled) {
          setUser(me.user);
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
      setStatus("signed-out");
      setError("Your session ended. Sign in again to pick up where you left off.");
    };
    window.addEventListener(SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired);
  }, []);

  const finish = useCallback((next: AuthUser) => {
    setUser(next);
    setStatus("signed-in");
    setError(null);
  }, []);

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      try {
        const r = await api.post<{ user: AuthUser }>("/auth/google", { credential });
        finish(r.user);
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
    const r = await api.post<{ user: AuthUser }>("/auth/developer", {});
    finish(r.user);
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
        const r = await api.post<{ user: AuthUser }>(`/auth/personas/${key}`, {});
        finish(r.user);
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
    setStatus("signed-out");
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
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
