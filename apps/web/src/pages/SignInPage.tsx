/**
 * Sign-in, for somebody who asked for a page they need an account to see.
 *
 * NOT the front door — `/` is public and shows the marketing page with sign-in
 * on it. This is what the catch-all renders for a deep link like
 * /f/:id/bank, and it renders IN PLACE rather than redirecting, so the URL
 * survives and signing in lands them on the file they actually wanted.
 *
 * The Google control itself lives in components/GoogleSignIn.tsx, shared with
 * the landing page.
 */

import { useAuth } from "../lib/auth.js";
import { Lockup } from "../components/Wordmark.js";
import { Footer } from "../components/Footer.js";
import { GoogleSignIn } from "../components/GoogleSignIn.js";

export function SignInPage() {
  const { config } = useAuth();

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-1 flex-col justify-center px-6">
        <Lockup className="text-accent" />
        <h1 className="mt-6 font-display text-3xl text-ink">Sign in to continue</h1>
        <p className="mt-3 text-base text-ink-soft">
          {config?.allowedDomain
            ? `Use your ${config.allowedDomain} account.`
            : "Any Google account works."}
        </p>

        <div className="mt-8">
          <GoogleSignIn />
        </div>
      </div>
      <Footer />
    </div>
  );
}
