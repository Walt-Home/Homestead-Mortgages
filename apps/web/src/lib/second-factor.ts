/**
 * The words for the second step of sign-in, and the two rules the screen
 * needs. A catalog like `outcomes.ts`: copy and nothing else, so the copy
 * rules can hold it — `second-factor.test.ts` runs them over every string.
 */

import { ApiError } from "./api.js";

export const SECOND_FACTOR_COPY = {
  enroll: {
    title: "Add a second step to your sign-in",
    body: "Scan this with an authenticator app, then enter the six-digit code it shows. From now on, signing in takes your Google account and that code.",
    cannotScan: "Can’t scan it? Enter this key by hand instead:",
    codeLabel: "Six-digit code",
    submit: "Turn it on",
    working: "Checking…",
  },
  replace: {
    title: "Set up a new authenticator",
    body: "Scan this with the authenticator app on your new phone, then enter the code it shows. The old one stops working, and so do your old recovery codes.",
  },
  recovery: {
    title: "Keep these somewhere safe",
    body: "If you ever lose your phone, any one of these codes signs you in instead. Each works once, and this is the only time they are shown.",
    confirm: "I’ve saved them",
  },
  verify: {
    title: "Enter your code",
    body: "Open your authenticator app and enter the six-digit code it shows for Supermortgage.",
    codeLabel: "Six-digit code",
    recoveryBody: "Enter one of the recovery codes you saved when you set this up. It works once.",
    recoveryLabel: "Recovery code",
    useRecovery: "Lost your phone? Use a recovery code",
    useApp: "Use your authenticator app instead",
    submit: "Continue",
    working: "Checking…",
  },
  privacy: {
    title: "Your sign-in",
    body: "Signing in takes your Google account and a code from an authenticator app.",
    codesLeft: (n: number) =>
      n === 1 ? "You have one recovery code left." : `You have ${n} recovery codes left.`,
    replace: "Set up a new authenticator",
  },
  errors: {
    wrongCode: "That code didn’t match. Codes change every 30 seconds, so try the one showing now.",
    wrongRecovery: "That recovery code didn’t work. Each one works once, so try another.",
    couldNotStart: "We couldn’t start setting this up. Try again?",
    generic: "That didn’t work. Try again?",
  },
  signOut: "Sign out",
} as const;

export type CodeKind = "app" | "recovery";

/**
 * Six digits is the app; anything else is a recovery code. Spaces and dashes
 * are how people type both, so they do not decide it.
 */
export function codeKind(input: string): CodeKind {
  return /^\d{6}$/.test(input.replace(/[\s-]/g, "")) ? "app" : "recovery";
}

/** The key in groups of four, which is how the apps print it and how a person reads it back. */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * What a refused code is called. The lock carries its own sentence from the
 * server, with the minutes in it; a plain mismatch gets the sentence for the
 * kind of code that was typed; anything else says what the server said.
 */
export function errorFor(err: unknown, kind: CodeKind): string {
  if (err instanceof ApiError) {
    if (err.code === "SECOND_FACTOR_LOCKED") return err.message;
    if (err.code === "WRONG_CODE") {
      return kind === "app"
        ? SECOND_FACTOR_COPY.errors.wrongCode
        : SECOND_FACTOR_COPY.errors.wrongRecovery;
    }
    return err.message;
  }
  return SECOND_FACTOR_COPY.errors.generic;
}
