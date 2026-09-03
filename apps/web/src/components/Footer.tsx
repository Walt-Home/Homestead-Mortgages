/**
 * The site footer.
 *
 * Every page gets it, signed in or not, so it is the one place guaranteed to
 * carry the legal links — which is what a footer is actually for.
 *
 * The link list is data, and an entry with no `to` is a SLOT rather than a
 * dead link. Terms and contact have no destination yet; they render as inert
 * text instead of a link that bounces the reader to the sign-in page or the
 * file list, which is what the router's catch-all would do with a /terms it
 * has never heard of. Giving one a `to` is the whole of what it takes to turn
 * it on.
 *
 * NOT here, deliberately: the "not a loan offer, no credit is checked"
 * disclaimer. `PrototypeBanner` already says it at the top of every page, in
 * a color people read, and saying it twice makes both quieter.
 */

import { Link } from "react-router-dom";
import { Lockup, PRODUCT_NAME } from "./Wordmark.js";

interface FooterLink {
  readonly label: string;
  /** Absent means the destination does not exist yet. */
  readonly to?: string;
}

const LINKS: readonly FooterLink[] = [
  { label: "Brand", to: "/brand" },
  { label: "Privacy", to: "/privacy" },
  { label: "Terms" },
  { label: "Contact" },
];

export function Footer() {
  // Read at render rather than baked in, so the notice cannot go stale in a
  // build that sits on a server across new year.
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-rule-soft">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-8 sm:px-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <Link to="/" aria-label={`${PRODUCT_NAME} home`} className="self-start">
            <Lockup size={22} className="text-accent" />
          </Link>

          <nav aria-label="Footer">
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {LINKS.map((link) => (
                <li key={link.label}>
                  {link.to ? (
                    <Link to={link.to} className="super-link-quiet text-sm">
                      {link.label}
                    </Link>
                  ) : (
                    /*
                     * Inert on purpose. Marked aria-disabled rather than
                     * hidden: the slot is part of the design and a screen
                     * reader should hear that it exists and is not ready,
                     * not silently get a shorter list than everyone else.
                     */
                    <span
                      aria-disabled="true"
                      title="Not written yet"
                      className="text-sm text-ink-faint"
                    >
                      {link.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className="text-sm text-ink-faint">
          © {year} {PRODUCT_NAME}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
