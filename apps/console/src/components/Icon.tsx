/**
 * The console's icons: 20px, 1.75 stroke, drawn in `currentColor`. One file
 * so the set stays consistent and a screen cannot reach for a stray glyph.
 */

import type { SVGProps } from "react";

export type IconName =
  | "inbox"
  | "alert"
  | "clock"
  | "pause"
  | "mail-off"
  | "home"
  | "users"
  | "book"
  | "shield"
  | "sliders"
  | "sparkles"
  | "badge"
  | "key"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "search"
  | "menu"
  | "x"
  | "check"
  | "external"
  | "arrow-left"
  | "log-out"
  | "loader"
  | "info"
  | "eye"
  | "filter"
  | "plus";

const PATHS: Record<IconName, string> = {
  inbox:
    "M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5",
  alert:
    "M12 9v4m0 4h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  pause: "M9 5v14M15 5v14",
  "mail-off": "M4 6h16v12H4zM4 7l8 6 4-3M3 3l18 18",
  home: "M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10",
  users:
    "M16 19v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M13 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM21 19v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  book: "M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM9 12l2 2 4-4",
  sliders: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M6 10v4M16 16v4",
  sparkles: "M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2",
  badge: "M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM8.5 14.5 7 21l5-2 5 2-1.5-6.5",
  key: "M15 3a6 6 0 0 0-5.7 8L3 17.3V21h3.7l1.3-1.3v-2h2v-2h2l1.7-1.7A6 6 0 1 0 15 3ZM16 8h.01",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-right": "m9 6 6 6-6 6",
  "chevron-left": "m15 6-6 6 6 6",
  search: "M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  menu: "M4 7h16M4 12h16M4 17h16",
  x: "M6 6l12 12M18 6 6 18",
  check: "m5 12 4 4L19 6",
  external: "M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6",
  "arrow-left": "M19 12H5M11 18l-6-6 6-6",
  "log-out": "M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 16l4-4-4-4M19 12H9",
  loader:
    "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2",
  info: "M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  filter: "M4 5h16l-6 7v5l-4 2v-7z",
  plus: "M12 5v14M5 12h14",
};

export function Icon({
  name,
  size = 20,
  className,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flex: "none" }}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
