/**
 * The frame: navigation on the left, the page on the right.
 *
 * Three breakpoints, one nav model. Under `md` (768px) the nav is a sheet
 * behind a menu button in a slim top bar; from `md` it is a 60px rail of
 * icons; from `lg` (1024px) the rail widens to 248px with labels, section
 * headings and counts. The account and the acting role live at the bottom
 * of the nav in every form.
 */

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { Icon, type IconName } from "./Icon.js";
import { Count, IconButton, Select } from "./ui.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { KIND_WORDS, QUEUE_KINDS, useHome, type QueueKind } from "../lib/home.js";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: readonly string[];
  count?: number | null;
  countTone?: "neutral" | "danger" | "warn";
  end?: boolean;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const OPS = ["ops_analyst", "officer", "compliance"] as const;
const STAFF = ["ops_analyst", "officer", "compliance", "admin"] as const;

const KIND_ICON: Record<QueueKind, IconName> = {
  escalation: "alert",
  portal_task: "inbox",
  held_notice: "pause",
  dead_letter: "mail-off",
  breached_timer: "clock",
};

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-baseline gap-1.5", className)}>
      <span className="text-base font-semibold tracking-tight text-fg">Supermortgage</span>
      <span className="text-sm text-fg-3">Ops</span>
    </span>
  );
}

function useNav(): NavGroup[] {
  const { holds } = useAuth();
  const home = useHome();
  const byKind = home.data?.my_queue?.by_kind;
  const clocks = home.data?.clocks?.counts;
  const kindCount = (k: QueueKind) =>
    k === "breached_timer" ? (clocks?.breached ?? byKind?.[k] ?? null) : (byKind?.[k] ?? null);
  const groups: NavGroup[] = [
    {
      label: "Work",
      items: [
        {
          to: "/",
          label: "Queue",
          icon: "home",
          end: true,
          count: home.data?.my_queue?.count ?? null,
        },
        ...QUEUE_KINDS.map<NavItem>((k) => ({
          to: `/work/${k}`,
          label: KIND_WORDS[k],
          icon: KIND_ICON[k],
          roles: OPS,
          count: kindCount(k),
          countTone: k === "breached_timer" || k === "escalation" ? "danger" : "neutral",
        })),
        { to: "/work-items", label: "Work items", icon: "sliders", roles: STAFF },
      ],
    },
    {
      label: "Records",
      items: [
        { to: "/loans", label: "Loans", icon: "home", roles: OPS },
        { to: "/people", label: "People", icon: "users", roles: OPS },
        { to: "/partner-book", label: "Partner book", icon: "book", roles: OPS },
      ],
    },
    {
      label: "Oversight",
      items: [
        { to: "/oversight/compliance", label: "Compliance", icon: "shield", roles: OPS },
        { to: "/oversight/controls", label: "Controls", icon: "sliders", roles: STAFF },
        { to: "/oversight/ai", label: "AI", icon: "sparkles", roles: OPS },
      ],
    },
    {
      label: "Staff",
      items: [
        { to: "/staff", label: "Staff & roles", icon: "badge", roles: ["admin"] },
        {
          to: "/staff/access-review",
          label: "Access review",
          icon: "key",
          roles: ["compliance", "admin"],
        },
      ],
    },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || holds(...i.roles)) }))
    .filter((g) => g.items.length > 0);
}

function NavList({ groups, labels }: { groups: NavGroup[]; labels: boolean }) {
  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Sections">
      {groups.map((g) => (
        <div key={g.label} className="mb-2">
          {labels ? (
            <div className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">
              {g.label}
            </div>
          ) : (
            <div className="mx-2 my-2 border-t border-line first:hidden" />
          )}
          <ul className="space-y-0.5">
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end={i.end}
                  title={labels ? undefined : i.label}
                  className={({ isActive }) =>
                    clsx(
                      "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-base transition-colors",
                      labels ? "" : "justify-center px-0",
                      isActive
                        ? "bg-surface-3 font-medium text-fg"
                        : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                    )
                  }
                >
                  <Icon name={i.icon} size={18} className="shrink-0" />
                  {labels ? (
                    <>
                      <span className="truncate">{i.label}</span>
                      <Count
                        n={i.count ?? undefined}
                        tone={i.count && i.countTone === "danger" ? "danger" : "neutral"}
                      />
                    </>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Account({ compact }: { compact?: boolean }) {
  const { me, role, setRole, signOut } = useAuth();
  if (!me) return null;
  const initials = (me.legal_name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  if (compact) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-line p-2">
        <div
          title={`${me.legal_name ?? "Staff"} · acting as ${roleWord(role ?? me.role)}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-xs font-semibold text-surface"
        >
          {initials}
        </div>
        <IconButton label="Sign out" icon="log-out" onClick={() => void signOut()} />
      </div>
    );
  }
  return (
    <div className="border-t border-line p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fg text-xs font-semibold text-surface">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-fg">{me.legal_name ?? "Staff"}</div>
          <div className="truncate text-xs text-fg-3">{me.roles.map(roleWord).join(" · ")}</div>
        </div>
        <IconButton
          label="Sign out"
          icon="log-out"
          onClick={() => void signOut()}
          className="-mr-1"
        />
      </div>
      {me.roles.length > 1 ? (
        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-fg-3">Acting as</span>
          <Select
            value={role ?? me.role}
            onChange={(e) => setRole(e.target.value)}
            className="h-9 text-sm"
          >
            {me.roles.map((r) => (
              <option key={r} value={r}>
                {roleWord(r)}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const groups = useNav();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-screen bg-canvas md:flex">
      {/* Desktop rail / sidebar */}
      <aside className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface md:flex md:w-[60px] lg:w-[248px]">
        <div className="flex h-14 items-center px-3 lg:px-4">
          <span className="hidden lg:inline">
            <Wordmark />
          </span>
          <span className="mx-auto inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-fg lg:hidden">
            S
          </span>
        </div>
        <div className="hidden min-h-0 flex-1 flex-col lg:flex">
          <NavList groups={groups} labels />
          <Account />
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
          <NavList groups={groups} labels={false} />
          <Account compact />
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-2 backdrop-blur md:hidden">
        <IconButton label="Menu" icon="menu" onClick={() => setOpen(true)} />
        <Wordmark />
      </header>

      {/* Phone nav sheet */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-fg/30"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] flex-col bg-surface shadow-menu">
            <div className="flex h-14 items-center justify-between px-4">
              <Wordmark />
              <IconButton label="Close" icon="x" onClick={() => setOpen(false)} />
            </div>
            <NavList groups={groups} labels />
            <Account />
          </div>
        </div>
      ) : null}

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
