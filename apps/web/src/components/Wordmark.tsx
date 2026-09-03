/**
 * The logo, in one place.
 *
 * Both the product name and the mark are here so that renaming, or swapping
 * the drawn mark for the real wordmark artwork, is a single edit rather than a
 * hunt through every header. `PRODUCT_NAME` is exported for the few places
 * that need the name in a sentence rather than in a lockup.
 *
 * The mark is the prototype's twelve-pixel house, inlined rather than loaded
 * from packages/brand/assets/mark.svg: it has to take its colour from
 * `currentColor` and its doorway from the surface behind it, and an <img>
 * cannot do either. See docs/brand.md for the drawing rules — crisp edges,
 * whole multiples, never below 22px, never any colour but the accent.
 */

export const PRODUCT_NAME = "Supermortgage";

/** The house, on its 12 × 12 grid. Takes its colour from the text around it. */
export function Mark({ size = 26, className }: { size?: number; className?: string }) {
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
      <rect x="5" y="1" width="2" height="1" fill="currentColor" />
      <rect x="4" y="2" width="4" height="1" fill="currentColor" />
      <rect x="3" y="3" width="6" height="1" fill="currentColor" />
      <rect x="2" y="4" width="8" height="1" fill="currentColor" />
      <rect x="1" y="5" width="10" height="1" fill="currentColor" />
      <rect x="2" y="6" width="8" height="5" fill="currentColor" />
      {/* The lit doorway is a hole cut to the surface behind, not black paint. */}
      <rect x="5" y="8" width="2" height="3" fill="var(--sm-color-ground)" />
    </svg>
  );
}

/**
 * Mark plus name. `SUPER` light, `MORTGAGE` heavy — the weight change is the
 * point, and it is why this is set rather than shipped as the prototype's PNG:
 * the PNG is white-only and cannot take the accent colour. Replacing this with
 * the real vector wordmark when it exists is a change to this component alone.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  const [light, heavy] = ["Super", "mortgage"];
  return (
    <span className="inline-flex items-center gap-2.5 text-accent">
      <Mark size={size} />
      <span className="text-base uppercase tracking-label">
        <span className="font-normal">{light}</span>
        <span className="font-bold">{heavy}</span>
      </span>
    </span>
  );
}
