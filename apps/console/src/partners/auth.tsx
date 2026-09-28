/**
 * Who is signed in at the portal. The server is the authority: `/me` on
 * load and again after anything that changes the session.
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
import { portal, PortalError, PORTAL_SIGNED_OUT, type PortalMe } from "./api.js";

type Status = "loading" | "signed-out" | "signed-in";

interface PortalAuth {
  status: Status;
  me: PortalMe | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<PortalAuth | null>(null);

export function PortalAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<PortalMe | null>(null);
  const queries = useQueryClient();

  const adopt = useCallback((who: PortalMe | null) => {
    setMe(who);
    setStatus(who ? "signed-in" : "signed-out");
  }, []);

  const refresh = useCallback(async () => {
    try {
      adopt(await portal<PortalMe>("/me"));
    } catch (err) {
      // 401 is "not signed in"; anything else is the server unreachable, and
      // a sign-in page is still the honest thing to show.
      void (err instanceof PortalError);
      adopt(null);
    }
  }, [adopt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onSignedOut = () => {
      adopt(null);
      queries.clear();
    };
    window.addEventListener(PORTAL_SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(PORTAL_SIGNED_OUT, onSignedOut);
  }, [adopt, queries]);

  const signOut = useCallback(async () => {
    try {
      await portal("/auth/session", { method: "DELETE" });
    } finally {
      adopt(null);
      queries.clear();
    }
  }, [adopt, queries]);

  const value = useMemo<PortalAuth>(
    () => ({ status, me, refresh, signOut }),
    [status, me, refresh, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortalAuth(): PortalAuth {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePortalAuth outside PortalAuthProvider");
  return ctx;
}
