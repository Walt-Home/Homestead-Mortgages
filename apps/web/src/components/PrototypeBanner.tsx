/**
 * The banner that says what this is.
 *
 * It is on every screen, permanently, and it is not dismissible. The flow asks
 * for a Social Security number and a signed authorization to pull credit —
 * a person who lands on it without context has every reason to believe it is
 * real. Someone reviewing it for feedback needs to know the numbers came from
 * fixtures before they judge whether the numbers are right.
 *
 * Delete this when the connectors are real. Not before.
 */
export function PrototypeBanner() {
  return (
    <div className="border-b border-notice-border bg-notice-bg">
      <p className="mx-auto max-w-5xl px-6 py-2 text-[12px] leading-relaxed text-ink-soft">
        <span className="font-medium">Prototype.</span> Connections return sample data, and the
        decision comes from our own engine rather than an agency underwriting system — it is not a
        loan commitment. Please don&rsquo;t enter real personal information.
      </p>
    </div>
  );
}
