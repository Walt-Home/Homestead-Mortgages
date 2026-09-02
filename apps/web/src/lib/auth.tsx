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
}

interface AuthConfig {
  googleClientId: string | null;
  allowedDomain: string | null;
  developerSignInAvailable: boolean;
  /** Whether the ID check navigates away to a vendor. */
  identityRequiresRedirect?: boolean;
}

interface AuthState {
  status: "loading" | "signed-in" | "signed-out";
  user: AuthUser | null;
  config: AuthConfig | null;
  signInWithGoogle: (credential: string) => Promise<void>;
  signInAsDeveloper: () => Promise<void>;
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

  const signOut = useCallback(async () => {
    await api.post("/auth/signout", {});
    setUser(null);
    setStatus("signed-out");
  }, []);

  return (
    <AuthContext.Provider
      value={{ status, user, config, signInWithGoogle, signInAsDeveloper, signOut, error }}
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
