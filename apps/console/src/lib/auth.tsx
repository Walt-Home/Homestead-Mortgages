/**
 * Who is signed in.
 *
 * The server is the authority: `/me` on load, and again after anything that
 * changes a session. The console has one role — admin, full access — and
 * the four roles the servicing app spells (`STAFF_ROLES`) are what an admin
 * holds underneath: an invitation grants all four, no acting role rides a
 * call, the servicing app runs each read as the least of them that opens
 * it, and an act it refuses is sent again as the role it names (`act.ts`).
 * `holds` and `role` remain for the few calls that name a role themselves.
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
import { api, ApiError, SIGNED_OUT } from "./api.js";

/** The servicing app's four staff roles: how an admin's access is spelled to it. */
export const STAFF_ROLES = ["ops_analyst", "officer", "compliance", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** What an invitation grants: all four, because the console has one role. */
export const ADMIN_GRANT: readonly string[] = STAFF_ROLES;

/** Holds every role there is — an admin, in the console's one word. */
export const isAdmin = (roles: readonly string[]): boolean =>
  STAFF_ROLES.every((r) => roles.includes(r));

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

/** "Admin" for the full grant; otherwise what is held, for an account invited before there was one role. */
export function rolesWord(roles: readonly string[]): string {
  if (isAdmin(roles)) return "Admin";
  return roles.map(roleWord).join(" · ") || "No role";
}

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
  /** The session's default role, as the server reports it; nothing is sent under it. */
  role: string | null;
  /** Why the last session ended, for the sign-in page's one line. */
  endedBecause: "expired" | "signed-out" | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * End this session and leave the rest of the page alone: what the app
   * asks for when it finds a staff session beside a servicer member's.
   * No reason is recorded and no query is dropped — the portal is already
   * drawing, and its reads are not this session's to clear.
   */
  stepAside: () => Promise<void>;
  holds: (...roles: readonly string[]) => boolean;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [endedBecause, setEnded] = useState<Auth["endedBecause"]>(null);
  const queries = useQueryClient();

  const adopt = useCallback((who: Me | null) => {
    setMe(who);
    if (!who) {
      setStatus("signed-out");
      return;
    }
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

  const signOut = useCallback(async () => {
    try {
      await api("/auth/signout", { body: {} });
    } finally {
      setEnded("signed-out");
      adopt(null);
      queries.clear();
    }
  }, [adopt, queries]);

  const stepAside = useCallback(async () => {
    try {
      await api("/auth/signout", { body: {} });
    } finally {
      adopt(null);
    }
  }, [adopt]);

  const value = useMemo<Auth>(
    () => ({
      status,
      me,
      role: me?.role ?? null,
      endedBecause,
      refresh,
      signOut,
      stepAside,
      holds: (...roles) => !!me && roles.some((r) => me.roles.includes(r)),
    }),
    [status, me, endedBecause, refresh, signOut, stepAside],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
