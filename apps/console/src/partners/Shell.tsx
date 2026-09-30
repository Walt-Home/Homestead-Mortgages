/**
 * The portal's frame, inside the console's bundle at `/console/portal`: the
 * servicer's name where the ops console has its wordmark, three links, and
 * who is signed in. One bar, no rail: a servicer's team has three things to
 * look at — their loans, what the book is billed, and their team — and
 * nothing of the ops console is among them.
 */

import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
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
  const { pathname } = useLocation();
  // The list and each loan's page are one place in the bar.
  const onLoans = pathname === "/portal" || pathname.startsWith("/portal/loans");
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line-2 bg-surface">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 md:px-8">
          <PortalWordmark servicer={me?.servicer.displayName} />
          <nav className="flex items-center gap-1" aria-label="Portal">
            <NavLink to="/portal" end className={() => link({ isActive: onLoans })}>
              Loans
            </NavLink>
            <NavLink to="/portal/billing" className={link}>
              Billing
            </NavLink>
            <NavLink to="/portal/team" className={link}>
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
      {/* Each page brings its own measure and gutters (`Page`); the bar above matches them. */}
      <main>{children}</main>
    </div>
  );
}
