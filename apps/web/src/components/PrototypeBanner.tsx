/**
 * The banner that says what this is.
 *
 * On every screen, permanently, and not dismissible.
 *
 * It used to say "don't enter real personal information", which was the safe
 * thing to write and the wrong thing to ask: a mortgage flow tested entirely
 * with invented numbers teaches you nothing about how it feels to hand over
 * your own. Now that people outside the company are testing it, the banner
 * tells the truth instead — what is fake, what is stored, and that it can be
 * taken back. `/privacy` is one screen away from every page it appears on.
 */
import { Link } from "react-router-dom";

export function PrototypeBanner() {
  return (
    <div className="border-b border-notice-border bg-notice-bg">
      <p className="mx-auto max-w-5xl px-6 py-2 text-[12px] leading-relaxed text-ink-soft">
        <span className="font-medium">Prototype.</span> Nothing here is a loan
        offer, no credit is checked, and every connection returns invented data.
        Anything you type is stored so the flow works —{" "}
        <Link to="/privacy" className="text-gold underline underline-offset-2">
          what we keep, and how to delete it
        </Link>
        .
      </p>
    </div>
  );
}
