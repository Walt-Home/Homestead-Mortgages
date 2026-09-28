/**
 * The portal's frame: the servicer's name where the ops console has its
 * wordmark, two links, and who is signed in. One bar, no rail: a servicer's
 * team has two things to look at.
 */

import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { Button } from "../components/ui.js";
import { usePortalAuth } from "./auth.js";

export function PortalWordmark({ servicer }: { servicer?: string | null }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-base font-semibold tracking-tight text-fg">Supermortgage</span>
      {servicer ? <span className="text-sm text-fg-3">for {servicer}</span> : null}
    </span>
  );
}

const link = ({ isActive }: { isActive: boolean }) =>
  clsx(
    "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
    isActive ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
  );

export function PortalShell({ children }: { children: ReactNode }) {
  const { me, signOut } = usePortalAuth();
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line-2 bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <PortalWordmark servicer={me?.servicer.displayName} />
          <nav className="flex items-center gap-1" aria-label="Portal">
            <NavLink to="/" end className={link}>
              Book
            </NavLink>
            <NavLink to="/team" className={link}>
              Team
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-fg-2">
            <span className="hidden sm:inline">{me?.user.name ?? me?.user.email}</span>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
