/**
 * Which adapter serves each connector.
 *
 * This used to be one `CONNECTOR_MODE` switch: everything fixture, or
 * everything real. That was fine while everything was a fixture and becomes
 * wrong the moment the first vendor lands, because they land one at a time and
 * over months — address autocomplete needs an API key and an afternoon,
 * a credit reseller needs a licence and a site inspection. An all-or-nothing
 * switch would force the whole registry to wait for the slowest member.
 *
 * So each connector reads its own variable and falls back to the fixture. The
 * boot log prints the resulting mix, because "which of these is real right
 * now?" is a question somebody will ask at the worst possible moment.
 */

import {
  duConnector,
  fixtureRegistry,
  googlePlacesConnector,
  mismoAusResponseReader,
  plaidConnector,
  stripeIdentityConnector,
  type ConnectorRegistry,
  type DuCredential,
  type PersonaId,
} from "@hm/connectors";
import { prisma } from "@hm/db";
import { PLACEHOLDER_INSTITUTION, placeholdersIn, type DuInstitution } from "@hm/du";
import { ffiecAporSeriesConnector } from "@hm/connectors";
import { config } from "../config.js";
import { vendorTokenStore } from "./vendor-tokens.js";

let registry: ConnectorRegistry | undefined;

/** What each connector ended up using. Logged at boot and served by /health. */
export interface ProviderMix {
  readonly [connector: string]: string;
}

/**
 * The same answer with the decoration taken off: what each connector IS.
 *
 * `ProviderMix` is for a human reading a boot log — "google-places (+ fixture
 * for records)" is the useful thing to print and the useless thing to branch
 * on. A screen that has to decide whether it may say "we pulled your credit"
 * needs the three-valued fact underneath, and it has to be the fact from the
 * registry that actually answered the request rather than a second copy of the
 * configuration read somewhere else.
 */
export type ConnectorMode = "fixture" | "sandbox" | "production";
export interface ProviderModes {
  readonly [connector: string]: ConnectorMode;
}

let mix: ProviderMix = {};
let modes: ProviderModes = {};

export function providerMix(): ProviderMix {
  connectors();
  return mix;
}

/**
 * What /health reports and what /auth/config hands the client. One function,
 * so the disclosure a borrower reads and the answer an operator checks cannot
 * be two different readings of the same deployment.
 */
export function providerModes(): ProviderModes {
  connectors();
  return modes;
}

/**
 * `DU_CREDENTIAL_SCHEME` and `DU_CREDENTIAL` as the credential the adapter
 * takes.
 *
 * One secret rather than four variables, so there is one thing in Secret
 * Manager and one thing to rotate. The scheme decides how it is read: a bearer
 * token is the whole string, and the other two split at the FIRST colon —
 * a password or a header value may carry colons of its own and the left half
 * may not.
 *
 * The scheme is not guessed. Which one Desktop Underwriter wants is in the
 * integration guide, and an adapter that tried all three would send the
 * credential to whichever endpoint answered first.
 */
function duCredential(scheme: string, secret: string): DuCredential {
  switch (scheme) {
    case "bearer":
      return { scheme: "bearer", token: secret };
    case "basic": {
      const colon = secret.indexOf(":");
      if (colon === -1) {
        throw new Error(
          "DU_CREDENTIAL_SCHEME=basic expects DU_CREDENTIAL to be username:password.",
        );
      }
      return {
        scheme: "basic",
        username: secret.slice(0, colon),
        password: secret.slice(colon + 1),
      };
    }
    case "header": {
      const colon = secret.indexOf(":");
      if (colon === -1) {
        throw new Error(
          "DU_CREDENTIAL_SCHEME=header expects DU_CREDENTIAL to be Header-Name:value.",
        );
      }
      return { scheme: "header", name: secret.slice(0, colon), value: secret.slice(colon + 1) };
    }
    default:
      throw new Error(
        `DU_CREDENTIAL_SCHEME=${JSON.stringify(scheme)} is not one this system implements. ` +
          "It is bearer, basic or header; mutual TLS is a client certificate rather than a " +
          "header and has no seam here.",
      );
  }
}

/**
 * The institution a casefile is assembled under, from the SAME field the
 * adapter authenticates beside.
 *
 * This is the whole of how the seller/servicer number stops being held in two
 * places that can disagree. `duConnector` takes `sellerServicerNumber` and the
 * emitted document carries `PartyRoleIdentifier`, and the adapter is forbidden
 * from reading the document to compare them — an adapter that parsed the
 * casefile would have taken on a second copy of the serializer's assumptions.
 * One `config.du.sellerServicerNumber` feeds both, so there is nothing to
 * disagree.
 *
 * Unset, it is the placeholder, which `assertInstitutionEmittable` refuses when
 * `NODE_ENV=production`. The lender loan number is still the placeholder in
 * every case: nothing mints one and no column holds one, which is its own row
 * in `docs/du-readiness.md`.
 */
export function duInstitutionFromConfig(): DuInstitution {
  return {
    lenderLoanIdentifier: PLACEHOLDER_INSTITUTION.lenderLoanIdentifier,
    submittingPartyIdentifier:
      config.du.sellerServicerNumber?.trim() || PLACEHOLDER_INSTITUTION.submittingPartyIdentifier,
  };
}

export function connectors(): ConnectorRegistry {
  if (registry) return registry;

  const fixtures = fixtureRegistry({ persona: config.fixturePersona as PersonaId });
  const chosen: Record<string, string> = Object.fromEntries(
    Object.entries(fixtures).map(([k, v]) => [
      k,
      (v as { capabilities: { provider: string } }).capabilities.provider,
    ]),
  );

  let propertyData = fixtures.propertyData;
  if (config.providers.propertyData === "google_places") {
    if (!config.googlePlacesApiKey) {
      // Failing at boot rather than at the first keystroke: an autocomplete
      // that silently returns nothing looks like a product with no addresses
      // in it.
      throw new Error("PROPERTY_DATA_PROVIDER=google_places but GOOGLE_PLACES_API_KEY is not set.");
    }
    propertyData = googlePlacesConnector({
      apiKey: config.googlePlacesApiKey,
      // Places knows which addresses exist and nothing else. The assessor
      // record, the valuation and the flood zone stay with the fixture until a
      // property-data vendor is wired.
      fallback: fixtures.propertyData,
    });
    chosen.propertyData = "google-places (+ fixture for records)";
  }

  let identity = fixtures.identity;
  if (config.providers.identity === "stripe") {
    if (!config.stripe.secretKey) {
      throw new Error(
        "IDENTITY_PROVIDER=stripe but no Stripe secret key is set. " +
          "Set STRIPE_SECRET_KEY_SANDBOX.",
      );
    }
    identity = stripeIdentityConnector({
      secretKey: config.stripe.secretKey,
      // Stripe sends the borrower back to {origin}/f/{fileId}/identity/return
      // after the hosted flow; screen 2 reads the result when they land.
      origin: config.publicOrigin,
      allowLiveMode: config.stripe.allowLiveIdentity,
    });
    chosen.identity = identity.capabilities.provider;
  }

  let bank = fixtures.bank;
  if (config.providers.bank === "plaid") {
    if (!config.plaid.clientId || !config.plaid.secret) {
      throw new Error("BANK_PROVIDER=plaid but PLAID_CLIENT_ID or PLAID_SECRET is not set.");
    }
    bank = plaidConnector({
      clientId: config.plaid.clientId,
      secret: config.plaid.secret,
      environment: config.plaid.environment,
      product: config.plaid.product,
      // Throws if VENDOR_TOKEN_KEY is missing or the wrong length. Better here
      // than at the first borrower's bank login.
      tokens: vendorTokenStore(prisma, config.vendorTokenKey),
      // Only when it is registered. Plaid refuses every link token — not just
      // the OAuth ones — if this is sent and not on the dashboard allowlist.
      ...(config.plaid.redirectUri ? { redirectUri: config.plaid.redirectUri } : {}),
      // /cra/check_report/create refuses to run without somewhere to announce
      // completion. The client still polls; this satisfies the endpoint.
      publicOrigin: config.publicOrigin,
    });
    chosen.bank = config.plaid.redirectUri
      ? bank.capabilities.provider
      : `${bank.capabilities.provider}, no OAuth banks`;
  }

  // The CFPB's survey. No credential and no fallback question: the live file
  // is public, and a deployment that cannot reach it has nothing to fall back
  // to that would be true — the vendored copy is the week somebody last ran
  // `apor:vendor`. The fetch script fails loudly instead.
  let aporSeries = fixtures.aporSeries;
  if (config.providers.aporSeries === "ffiec") {
    aporSeries = ffiecAporSeriesConnector();
    chosen.aporSeries = "ffiec-survey (files.ffiec.cfpb.gov)";
  }

  // Desktop Underwriter. The one branch where "fell back to the fixture"
  // would be indistinguishable from working: the fixture answers
  // Approve/Eligible in milliseconds and transmits nothing at all, so a
  // deployment that asked for Fannie and got the fixture would look like a
  // product that submits. Every missing value is therefore a boot failure
  // naming the variable.
  let du = fixtures.du;
  if (config.providers.du === "fannie") {
    const missing = (
      [
        ["DU_ENDPOINT", config.du.endpoint],
        ["DU_SELLER_SERVICER_NUMBER", config.du.sellerServicerNumber],
        ["DU_CREDENTIAL_SCHEME", config.du.credentialScheme],
        ["DU_CREDENTIAL", config.du.credential],
      ] as const
    )
      .filter(([, value]) => !value || value.trim() === "")
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`DU_PROVIDER=fannie but ${missing.join(", ")} is not set.`);
    }
    // The same refusal `assertInstitutionEmittable` makes about the document,
    // made about the adapter, and for the same reason: a plausible-looking
    // number is a submission Fannie Mae accepts against somebody else's
    // institution. The document check would already stop a production
    // assembly, but this is the one that can send, so it refuses too rather
    // than relying on a check one package over.
    if (
      config.nodeEnv === "production" &&
      placeholdersIn(duInstitutionFromConfig()).includes("submittingPartyIdentifier")
    ) {
      throw new Error(
        "DU_PROVIDER=fannie with the placeholder seller/servicer number, in production. " +
          "Nobody holds the number this casefile would be sent under, and a number that looks " +
          "real is worse than none.",
      );
    }
    du = duConnector({
      endpoint: config.du.endpoint!,
      sellerServicerNumber: config.du.sellerServicerNumber!,
      credential: duCredential(config.du.credentialScheme!, config.du.credential!),
      environment: config.du.environment,
      allowProduction: config.du.allowProduction,
      // Required, with no default, on the adapter's own argument: a deployment
      // whose response format is not the one this reader guesses at must be
      // handed a different function rather than half-reading this one.
      readResponse: mismoAusResponseReader,
    });
    chosen.du = du.capabilities.provider;
  }

  registry = { ...fixtures, propertyData, identity, bank, aporSeries, du };
  mix = chosen;
  // Read off the registry that was just assembled, not off `config`. The
  // configuration is the intent and the registry is the outcome, and every
  // branch above can decide not to honor the intent — a missing key throws,
  // but a fallback need not. What a screen discloses has to follow the object
  // that will answer the request.
  //
  // It is only as honest as the adapter it asks. `googlePlacesConnector`
  // reports "production" while the assessor, valuation and flood lookups
  // behind it are still the fixture's, so a disclosure keyed on propertyData
  // would overclaim. Nothing keys on it today; whoever first does has to split
  // that adapter's capabilities before believing this.
  modes = Object.fromEntries(
    Object.entries(registry).map(([name, connector]) => [
      name,
      (connector as { capabilities: { mode: ConnectorMode } }).capabilities.mode,
    ]),
  );
  return registry;
}
