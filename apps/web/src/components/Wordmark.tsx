/**
 * The logo, in one place: the wordmark, and the lockup that is now only it.
 *
 * The house is gone (Joe, 8 October 2026: "we're moving away from that"),
 * and with it the street under the landing page. What is left is what
 * supermortgage.com carries today: SUPERMORTGAGE in a geometric sans, SUPER
 * heavy and MORTGAGE light — read off the live artwork, which is the reverse
 * of the first prototype's weights — and nothing beside it. `Lockup` stays
 * exported because a dozen screens call it; it renders the wordmark.
 *
 * Nothing here sets a color. The wordmark paints with `currentColor`, so the
 * caller decides with a text utility and the same component covers ink on
 * paper, red on paper, and white on a photograph. See /brand.
 *
 * `PRODUCT_NAME` is for the places that need the name in a sentence rather
 * than in a lockup.
 */

export const PRODUCT_NAME = "Supermortgage";

/**
 * SUPERMORTGAGE, set in type.
 *
 * SUPER heavy and MORTGAGE light, as the artwork at supermortgage.com has it.
 * This is a typographic stand-in for that artwork, which is still a PNG and
 * cannot take a color; replacing it is a change to this component alone.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`uppercase tracking-label ${className ?? ""}`}>
      <span className="font-bold">Super</span>
      <span className="font-normal">mortgage</span>
    </span>
  );
}

/** The logo at the nav's proportions: the wordmark, and nothing beside it. */
export function Lockup({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>
      <Wordmark className="text-base" />
    </span>
  );
}
