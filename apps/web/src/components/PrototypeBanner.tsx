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
 *
 * It also used to say "every connection returns invented data", which stopped
 * being true the moment real vendors were switched on. Two of them matter:
 *
 * Address search is now live Google Places, returning real properties. And
 * the ID check is a real Stripe flow in test mode — test mode does not verify
 * anything, but it still receives whatever image is put in front of it. A
 * banner promising invented data is an invitation to scan a real driver's
 * licence into an integration with no retention policy, which is the exact
 * outcome the old wording was written to prevent.
 *
 * Deliberately static rather than driven by the provider mix. Locally, where
 * everything is a fixture, it is merely conservative; the cost of being
 * over-careful on a developer machine is nothing, and the cost of the banner
 * lagging a config change by one deploy is somebody's ID.
 */
import { Link } from "react-router-dom";

export function PrototypeBanner() {
  return (
    <div className="border-b border-rule bg-raised">
      <p className="mx-auto max-w-5xl px-6 py-2 text-xs text-ink-soft">
        <span className="font-medium">Prototype.</span> Not a loan offer, and no credit is checked.
        Bank and ID checks run in the vendors&rsquo; test modes, so please use their test
        credentials rather than a real ID. Address search is live. Anything you type is stored so
        the flow works —{" "}
        <Link to="/privacy" className="super-link">
          what we keep, and how to delete it
        </Link>
        .
      </p>
    </div>
  );
}
