/**
 * The ops console's sections, as the rail lists them. Kept apart from the
 * rail that draws them (`components/Shell.tsx`) so what a staff session is
 * offered can be read, and tested, without a browser.
 *
 * The partner portal has a bar of its own (`partners/Shell.tsx`) and none of
 * this: a servicer's team never sees the ops console.
 */

import type { IconName } from "../components/Icon.js";
import { KIND_WORDS, QUEUE_KINDS, type QueueKind } from "./home.js";

/**
 * The Supermortgage Gym, served by our API on this host beside the console
 * (`apps/api/src/routes/console-gym.ts`) and outside its router: a page of
 * its own, loaded whole, with its own script and none of the console's.
 */
export const GYM_HREF = "/console/hm/gym/";

interface NavItemBase {
  label: string;
  icon: IconName;
  count?: number | null;
  countTone?: "neutral" | "danger" | "warn";
}
/** A section of the console: a route inside its router. */
export interface NavRoute extends NavItemBase {
  to: string;
  end?: boolean;
}
/** A page beside the console, outside its router: a plain link, loaded as a full page. */
export interface NavPage extends NavItemBase {
  href: string;
}
export type NavItem = NavRoute | NavPage;
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const isPage = (i: NavItem): i is NavPage => "href" in i;

export interface NavCounts {
  /** Everything in the signed-in person's queue. */
  queue: number | null;
  /** The queue by kind. */
  kind: (k: QueueKind) => number | null;
}

const KIND_ICON: Record<QueueKind, IconName> = {
  escalation: "alert",
  portal_task: "inbox",
  held_notice: "pause",
  dead_letter: "mail-off",
  breached_timer: "clock",
};

/** The console has one role, so every section is every admin's; the sections are the nav. */
export function navGroups(counts: NavCounts): NavGroup[] {
  return [
    {
      label: "Work",
      items: [
        { to: "/", label: "Queue", icon: "home", end: true, count: counts.queue },
        ...QUEUE_KINDS.map<NavItem>((k) => ({
          to: `/work/${k}`,
          label: KIND_WORDS[k],
          icon: KIND_ICON[k],
          count: counts.kind(k),
          countTone: k === "breached_timer" || k === "escalation" ? "danger" : "neutral",
        })),
        { to: "/work-items", label: "Work items", icon: "sliders" },
      ],
    },
    {
      label: "Records",
      items: [
        { to: "/loans", label: "Loans", icon: "home" },
        { to: "/people", label: "People", icon: "users" },
        { to: "/partner-book", label: "Partner book", icon: "book" },
        { to: "/servicers", label: "Servicers", icon: "badge" },
      ],
    },
    {
      label: "Oversight",
      items: [
        { to: "/oversight/compliance", label: "Compliance", icon: "shield" },
        { to: "/oversight/controls", label: "Controls", icon: "sliders" },
        { to: "/oversight/ai", label: "AI", icon: "sparkles" },
      ],
    },
    {
      label: "Billing",
      items: [{ to: "/billing", label: "Billing", icon: "receipt" }],
    },
    {
      label: "Gym",
      items: [{ href: GYM_HREF, label: "Gym", icon: "dumbbell" }],
    },
    {
      label: "Staff",
      items: [
        { to: "/staff", label: "Staff", icon: "badge" },
        { to: "/staff/access-review", label: "Access review", icon: "key" },
      ],
    },
  ];
}
