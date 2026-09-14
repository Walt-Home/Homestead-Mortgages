/**
 * What is true of THIS deployment, in the borrower's words.
 *
 * A catalog, like `outcomes.ts` and `home-copy.ts`, and it exists for the same
 * reason they do: the sentences below were inline in four screens and a
 * signing panel, where `borrower-copy.test.ts` could see them but had no rule
 * that applied, and five of them said something the code does not do.
 *
 * What makes this file different from the other two is that most of its
 * strings cannot be settled once. "A soft pull. This does not affect your
 * score." is not wrong copy — it is correct copy on a deployment with a credit
 * reseller behind `POST /files/:id/credit`, and a fabrication on one answering
 * out of `fixtures/personas`. Deleting it would be wrong the day the adapter
 * lands. So every such sentence is a function of `capabilities.mode`, which
 * `/auth/config` serves as `connectorModes` out of the same `providerModes()`
 * that `/api/health` reports.
 *
 * Two claims here are NOT mode-derived, and each says why where it sits: what
 * happens to the Social Security number, and what happens to a property
 * correction. Neither turns on a vendor.
 *
 * The two labels on the bank screen's figures are mode-derived and still do
 * not live here. They are a function of the deployment AND of the file — which
 * retrieval wrote the rows the engine summed, and what that report said it
 * established — so they sit in `figures.ts` beside the formatter for the
 * numbers they name, and take a `ConnectorMode` from here. The first draft of
 * this header argued they were a function of the figure ALONE, which is how
 * the word `verified` came to sit over a number nothing had retrieved.
 */

/** The three values `ConnectorCapabilities.mode` can take. */
export type ConnectorMode = "fixture" | "sandbox" | "production";

/** The nine ports in `ConnectorRegistry`, as the server names them. */
export type ConnectorName =
  | "identity"
  | "credit"
  | "bank"
  | "payroll"
  | "irs"
  | "esign"
  | "propertyData"
  | "screening"
  | "liens";

export type ConnectorModes = Partial<Record<ConnectorName, ConnectorMode>>;

/**
 * Which adapter is behind one connector, for a screen that has to say.
 *
 * Absent means fixture, and that direction is deliberate. `/auth/config` is
 * fetched on load and a screen renders before it lands, so the default is the
 * answer a screen gives for the short moment it does not know — and the safe
 * thing not to know is whether a vendor did something. Guessing "production"
 * would put "we pulled your credit" on screen for one render and then take it
 * back.
 */
export function modeOf(
  modes: ConnectorModes | null | undefined,
  name: ConnectorName,
): ConnectorMode {
  return modes?.[name] ?? "fixture";
}

/**
 * The Social Security number, said once for the two screens that say it.
 *
 * Screen 2 used to answer "It is the only way to pull your credit. We keep the
 * last four digits; the rest goes straight to the credit bureaus and is never
 * stored here." while `/privacy` said, correctly, that the number never
 * reaches the server at all: `IdentityPage` derives a `vault:<last4>:<uuid>`
 * handle in the browser and posts that and the last four digits. Two surfaces
 * on one deployment told a borrower opposite things about the most sensitive
 * field in the product.
 *
 * Not a function of any mode. Nothing on the wire carries the number, so no
 * adapter can change what is true of it — a credit reseller landing tomorrow
 * would need a route that does not exist before this sentence moved.
 */
export const SSN_COPY = {
  lead: "Your Social Security number never leaves your browser.",
  body: "The form asks for it because the real product would, but only the last four digits are ever sent to us. The rest is discarded the moment you move to the next screen.",
} as const;

/** The two halves together, for a screen with one line to give them. */
export const ssnDisclosure = () => `${SSN_COPY.lead} ${SSN_COPY.body}`;

/**
 * What the credit step may say about itself.
 *
 * Every string here asserts a bureau interaction in the vendor case, and the
 * fixture case has to replace it rather than go quiet: the animation runs
 * either way, and three labeled steps ticking past with nothing under them
 * reads as work being done.
 */
export function creditCheckCopy(mode: ConnectorMode) {
  if (mode === "fixture") {
    return {
      step: "Building your sample credit report",
      note: "No bureau is asked for anything. This deployment answers with a made-up report, and your real credit is left alone.",
      pill: "Sample credit",
      pillNote: "Made up for this prototype, not read from a bureau.",
      authorization:
        "No credit check runs on this deployment: it answers with a made-up report rather than asking a bureau for one.",
    } as const;
  }
  if (mode === "sandbox") {
    return {
      step: "Running a test-mode credit check",
      note: "The reseller's test mode. It answers with invented tradelines and reaches no bureau, so your score is untouched.",
      pill: "Test-mode credit",
      pillNote: "A test-mode answer, not your file at a bureau.",
      authorization:
        "The credit check runs against the reseller's test mode on this deployment, so it reaches no bureau and cannot affect your score.",
    } as const;
  }
  return {
    step: "Checking your credit",
    note: "A soft pull. This does not affect your score.",
    pill: "Credit checked",
    pillNote: "Soft pull, so your score is untouched.",
    authorization: "The credit check is a soft pull and does not affect your score.",
  } as const;
}

/** The same step, said by the screen a borrower lands on after the ID vendor. */
export const creditNextStep = (mode: ConnectorMode) =>
  `${creditCheckCopy(mode).step}, then on to the next step.`;

/**
 * What is open in the other window.
 *
 * The asymmetry this ends: screen 2 disclosed that Stripe was in test mode and
 * screen 4 disclosed nothing, while the window it opened was `sandbox.plaid.com`
 * serving invented institutions. A tester puts their own bank credentials into
 * it, is rejected, and has nothing on screen to explain why.
 *
 * The fixture wording is written down even though the fixture never reaches
 * this phase — `requiresClientHandoff` is false, so the screen goes idle →
 * opening → done. A branch that cannot render today is one route change away
 * from rendering tomorrow, and the wording it would use should not be decided
 * then.
 */
export function bankHandoffCopy(mode: ConnectorMode): string {
  if (mode === "fixture") {
    return "No bank is opened here. This deployment reads a made-up report rather than anything of yours.";
  }
  if (mode === "sandbox") {
    return "Plaid's sandbox is open in a secure window. The institutions it lists are simulated, so use Plaid's test credentials rather than your own bank's.";
  }
  return "Your bank is open in a secure window. Sign in there and we'll take it from here.";
}

/**
 * Who says the rent was paid on time.
 *
 * The bank screen tells a borrower their rent history counts in their favor,
 * and on a fixture deployment the months it counts were invented by
 * `fixtures/personas` — the same asymmetry the assets label had. This is the
 * subject of that sentence rather than the whole of it, because the number
 * sits in the middle of it and the half that follows ("that counts in your
 * favor") is true of whatever report produced it.
 */
export function rentHistorySource(mode: ConnectorMode): string {
  if (mode === "fixture") return "The sample report shows";
  if (mode === "sandbox") return "The sandbox report shows";
  return "We found";
}

/**
 * The ID check: what the control is called, and what it is worth warning about.
 *
 * `caveat` is the fix for the defect one step along from the five. It used to
 * be gated on `identityRequiresRedirect`, which is true whenever identity is
 * not a fixture — so a live Stripe key would have left a banner reading "this
 * check runs in Stripe's test mode" over a check that was verifying a real
 * document. Test mode is the sandbox, not the vendor, and the two are separate
 * values here.
 *
 * `button` names the vendor in both non-fixture cases on purpose. It is the
 * one claim in this file that is worth making louder rather than softer: a
 * control reading "Scan your ID and take a selfie" that lands somebody on a
 * Stripe domain asking for a government ID looks precisely like the thing
 * people are told to be suspicious of.
 */
export function identityCheckCopy(mode: ConnectorMode) {
  if (mode === "fixture") {
    return {
      caveat: null,
      button: "Scan your ID and take a selfie",
      vendorNote: "",
      prompt: "Scan your ID to continue.",
    } as const;
  }
  return {
    caveat:
      mode === "sandbox"
        ? "This check runs in Stripe's test mode, so it cannot verify a real document. Please use Stripe's test credentials rather than your own ID."
        : null,
    button: "Verify your ID with Stripe",
    vendorNote: " Stripe handles it and brings you straight back — we never see your document.",
    prompt: "Verify your ID to continue.",
  } as const;
}

/**
 * What happens to a property correction, which is: it is written down.
 *
 * "someone will check it against the county record" named a person who does
 * not exist. The route writes a `FileEvent` and there is no queue, no assignee
 * and no review surface anywhere in this repository. That corrections are
 * recorded rather than applied is a deliberate stub and says so in CLAUDE.md;
 * inventing a reviewer on top of it is not.
 *
 * Both halves are here because only one of them was fixed the first time. The
 * confirmation stopped naming a reviewer while the prompt thirteen lines above
 * it — the sentence a borrower reads BEFORE deciding to correct anything —
 * still opened with "We will check it", about the same absent person. A pair
 * of sentences that have to agree is a pair that belongs in one place.
 *
 * Not mode-derived. No connector setting puts a person on the other end.
 */
export const PROPERTY_CORRECTION_PROMPT =
  "Tell us what is off. It goes down against this file as you wrote it — nothing here has to be settled before you carry on.";

export const PROPERTY_CORRECTION_RECORDED =
  "Thanks — your correction is written down against this file. It does not change the county record the numbers above come from, and it will not hold anything up, so carry on.";
