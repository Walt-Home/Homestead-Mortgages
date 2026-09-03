/**
 * The logo, in one place: the mark, the wordmark, and the lockup of both.
 *
 * The three are separate exports because they are three different things in
 * docs/brand.md and get used separately — the mark alone in a favicon or a
 * tight nav, the lockup everywhere else. `PRODUCT_NAME` is exported for the
 * places that need the name in a sentence rather than in a lockup.
 *
 * None of them sets a color. All three paint with `currentColor`, so the
 * caller decides with a text utility and the same component covers white on
 * black, red on black, black on white and red on white. See /brand.
 */

import { useId } from "react";

export const PRODUCT_NAME = "Supermortgage";

/**
 * The house, on its 12 × 12 grid, drawn in `currentColor`.
 *
 * The lit doorway is punched out with a mask rather than painted black. That
 * matters: a black rectangle is invisible on black and a black smear on white,
 * so the mark could only ever sit on one background. As a hole it takes
 * whatever is behind it, which is what makes the light variants possible.
 *
 * Inlined rather than loaded from packages/brand/assets/mark.svg because an
 * <img> can do neither `currentColor` nor the cut-out.
 */
export function Mark({ size = 26, className }: { size?: number; className?: string }) {
  // Unique per instance: /brand renders this a dozen times on one page, and
  // duplicate mask ids would have every copy reference the first one.
  const maskId = `mark-doorway-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ display: "block", flex: "none" }}
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="12">
        <rect width="12" height="12" fill="#fff" />
        <rect x="5" y="8" width="2" height="3" fill="#000" />
      </mask>
      <g mask={`url(#${maskId})`} fill="currentColor">
        <rect x="5" y="1" width="2" height="1" />
        <rect x="4" y="2" width="4" height="1" />
        <rect x="3" y="3" width="6" height="1" />
        <rect x="2" y="4" width="8" height="1" />
        <rect x="1" y="5" width="10" height="1" />
        <rect x="2" y="6" width="8" height="5" />
      </g>
    </svg>
  );
}

/**
 * SUPERMORTGAGE, set in type.
 *
 * SUPER light and MORTGAGE heavy — the weight change is the whole idea, that
 * the ordinary half is the bold one. This is a stand-in for the real artwork,
 * which is still a white PNG that cannot take a color; replacing it is a
 * change to this component alone.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`uppercase tracking-label ${className ?? ""}`}>
      <span className="font-normal">Super</span>
      <span className="font-bold">mortgage</span>
    </span>
  );
}

/** Mark plus wordmark, at the nav's proportions. */
export function Lockup({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <Mark size={size} />
      <Wordmark className="text-base" />
    </span>
  );
}
