/**
 * `/` for somebody who is not signed in.
 *
 * The marketing page, publicly reachable, with sign-in as the action — which
 * is what supermortgage.com's front page is. Before this, a stranger opening
 * the site got a bare sign-in form and never saw the product at all.
 *
 * Deep links are NOT routed here. Somebody who opens /f/:id/bank while signed
 * out still gets SignInPage, rendered in place so the URL survives and they
 * land on the file they asked for rather than on a pitch.
 */

import { GoogleSignIn } from "../components/GoogleSignIn.js";
import { HomeHero } from "../components/HomeHero.js";
import { StreetScene } from "../components/StreetScene.js";
import { useAuth } from "../lib/auth.js";

export function LandingPage() {
  const { config } = useAuth();

  return (
    <>
      <HomeHero>
        <GoogleSignIn variant="hero" />
        <p className="text-sm text-ink-muted">
          {config?.allowedDomain
            ? `Sign in with your ${config.allowedDomain} account to start.`
            : "Sign in to start. It takes about five minutes."}
        </p>
      </HomeHero>
      <StreetScene />
    </>
  );
}
