/**
 * Who is signed in, which roles they hold, and which one they are acting as.
 *
 * The server is the authority: `/me` on load, and again after anything that
 * changes a session. The acting role is the one choice the client owns —
 * his API runs every read under the least role that opens it unless told
 * otherwise — and it is remembered per person in this browser.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setActingRole, SIGNED_OUT } from "./api.js";

export const STAFF_ROLES = ["ops_analyst", "officer", "compliance", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_WORDS: Record<string, string> = {
  ops_analyst: "Ops analyst",
  officer: "Officer",
  compliance: "Compliance",
  admin: "Admin",
  ciso: "CISO",
  counsel: "Counsel",
  auditor: "Auditor",
  examiner: "Examiner",
  attorney: "Attorney",
  signing_officer: "Signing officer",
  fnma_portal_operator: "FNMA portal operator",
  human_agent: "Human agent",
  lossmit_reviewer: "Loss-mit reviewer",
  fraud_officer: "Fraud officer",
};
export const roleWord = (r: string): string => ROLE_WORDS[r] ?? r.replace(/_/g, " ");

export interface Me {
  staff_user_id: string;
  legal_name: string | null;
  roles: string[];
  role: string;
  acted_as?: string;
  readOnly?: boolean;
  session: {
    session_id: string;
    factors: string[];
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  } | null;
}

type Status = "loading" | "signed-out" | "signed-in";

interface Auth {
  status: Status;
  me: Me | null;
  /** The role requests are sent under. */
  role: string | null;
  setRole: (role: string) => void;
  /** Why the last session ended, for the sign-in page's one line. */
  endedBecause: "expired" | "signed-out" | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  holds: (...roles: readonly string[]) => boolean;
}

const AuthContext = createContext<Auth | null>(null);

const roleKey = (id: string) => `console.role.${id}`;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [role, setRoleState] = useState<string | null>(null);
  const [endedBecause, setEnded] = useState<Auth["endedBecause"]>(null);
  const queries = useQueryClient();

  const adopt = useCallback((who: Me | null) => {
    setMe(who);
    if (!who) {
      setRoleState(null);
      setActingRole(null);
      setStatus("signed-out");
      return;
    }
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(roleKey(who.staff_user_id));
    } catch {
      remembered = null;
    }
    const chosen = remembered && who.roles.includes(remembered) ? remembered : who.role;
    setRoleState(chosen);
    setActingRole(chosen);
    setStatus("signed-in");
    setEnded(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      adopt(await api<Me>("/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === "SESSION_EXPIRED") setEnded("expired");
        adopt(null);
      } else if (err instanceof ApiError && err.status === 403) {
        adopt(null);
      } else {
        // The server is unreachable; say so rather than show a sign-in that
        // cannot work. The sign-in page reads `status` and shows the line.
        adopt(null);
      }
    }
  }, [adopt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onSignedOut = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      setEnded(code === "SESSION_EXPIRED" ? "expired" : "signed-out");
      adopt(null);
      queries.clear();
    };
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, [adopt, queries]);

  const setRole = useCallback(
    (next: string) => {
      setRoleState(next);
      setActingRole(next);
      if (me) {
        try {
          localStorage.setItem(roleKey(me.staff_user_id), next);
        } catch {
          // A browser without storage still works; it just forgets.
        }
      }
      void queries.invalidateQueries();
    },
    [me, queries],
  );

  const signOut = useCallback(async () => {
    try {
      await api("/auth/signout", { body: {} });
    } finally {
      setEnded("signed-out");
      adopt(null);
      queries.clear();
    }
  }, [adopt, queries]);

  const value = useMemo<Auth>(
    () => ({
      status,
      me,
      role,
      setRole,
      endedBecause,
      refresh,
      signOut,
      holds: (...roles) => !!me && roles.some((r) => me.roles.includes(r)),
    }),
    [status, me, role, setRole, endedBecause, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
