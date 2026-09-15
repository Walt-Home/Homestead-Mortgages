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
 * The front door used to repeat the privacy link in its own closing
 * paragraph. It does not any more — this is the one place it lives.
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

        {/*
          `/` is public now, and the hero on it advertises a mortgage that
          refinances itself to anyone on the internet. That is an advertising
          claim about a mortgage, so the page cannot be silent about what it is
          not. The hero's "lowest rates guaranteed" is gone — nothing here can
          guarantee a rate, and `RATE_COMMITMENT` keeps it gone — but this
          paragraph is not what it was there for and does not leave with it.

          This is the protective minimum, not a compliance sign-off: a real
          consumer mortgage footer also needs the lending entity's legal name,
          an NMLS ID and the Equal Housing Opportunity mark, and none of those
          can be invented here. See docs/brand.md, "The guarantee".
        */}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-faint">
            Not a commitment to lend. Rates and terms shown are illustrative, subject to
            underwriting and credit approval, and are not an offer of credit.
          </p>
          <p className="text-sm text-ink-faint">
            © {year} {PRODUCT_NAME}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
