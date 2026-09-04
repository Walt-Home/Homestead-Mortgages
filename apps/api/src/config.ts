import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "../../../.env") });
dotenv.config();

/**
 * Express `trust proxy`, as a hop count.
 *
 * Behind Cloud Run plus a load balancer the real client IP sits N hops deep in
 * X-Forwarded-For. `true` would let a client spoof the header and forge the IP
 * we record on every consent — and a consent record whose IP can be chosen by
 * the signer is not evidence of anything.
 */
function parseTrustProxy(v: string | undefined): number | boolean {
  if (!v || v.trim() === "") return false;
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : false;
}

export const config = {
  port: parseInt(process.env.PORT ?? "8080", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /**
   * The state gallery at /states — every state and its copy, side by side.
   *
   * Off unless asked for. It is a design surface rather than a feature, it
   * shows states most of which have no column behind them yet, and it should
   * not be something a borrower stumbles into from a stray link. Sign-in is
   * still required on top of this; the flag is what lets us turn it off
   * without a deploy of the client.
   */
  stateGalleryEnabled: process.env.STATE_GALLERY === "true",
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? "",
  /**
   * Which connector adapters to use. Only "fixture" is implemented; the value
   * is read rather than assumed so that wiring a real vendor is a config
   * change with a visible default, not a code path somebody discovers later.
   */
  connectorMode: (process.env.CONNECTOR_MODE ?? "fixture") as "fixture" | "sandbox" | "production",
  /**
   * Which adapter serves each connector. Anything unset stays on the fixture,
   * so a new vendor is one variable rather than a global switch.
   */
  providers: {
    propertyData: process.env.PROPERTY_DATA_PROVIDER ?? "fixture",
    identity: process.env.IDENTITY_PROVIDER ?? "fixture",
    bank: process.env.BANK_PROVIDER ?? "fixture",
  },

  /**
   * Google Places, for address autocomplete. Restrict the key to the Places
   * API and to this service's origins — an unrestricted Maps key found in a
   * bundle is somebody else's bill.
   */
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,

  /**
   * Stripe. The SANDBOX key is preferred deliberately and the live key is only
   * reached by setting STRIPE_ALLOW_LIVE_IDENTITY=true.
   *
   * Live identity verification collects a real government ID and a real face
   * scan from every person who walks the flow. Face geometry is biometric data
   * with statutory duties attached under BIPA and its equivalents, and this
   * deployment has no retention policy. Test mode proves the entire
   * integration against Stripe's sample documents and collects nothing real.
   */
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY_SANDBOX ?? process.env.STRIPE_SECRET_KEY,
    publishableKey:
      process.env.STRIPE_PUBLISHABLE_KEY_SANDBOX ?? process.env.STRIPE_PUBLISHABLE_KEY,
    allowLiveIdentity: process.env.STRIPE_ALLOW_LIVE_IDENTITY === "true",
  },

  /**
   * Plaid, for the twelve-month CRA report behind screen 3.
   *
   * CRA products are enabled per account and are not on by default — a client
   * id that works for Assets will fail at /link/token/create with the CRA
   * products named. Sandbox needs no approval; production does.
   */
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    environment: (process.env.PLAID_ENV ?? "sandbox") as "sandbox" | "production",
    /**
     * "cra" is the target; "assets" is the stand-in while CRA access is being
     * granted. Assets returns real transactions from a real bank login and is
     * NOT a consumer report, so it sets `vendorAuthorizedForDu: false` and
     * CRD-017 stays unsatisfied. That is deliberate: the flow becomes walkable
     * without the decision quietly resting on the wrong evidence.
     */
    product: (process.env.PLAID_PRODUCT ?? "cra") as "cra" | "assets",
    /**
     * Where an OAuth bank returns the borrower. **Unset by default, and that
     * is deliberate.**
     *
     * Plaid rejects `/link/token/create` outright — INVALID_FIELD — when the
     * redirect URI is not registered under Developers > API > Allowed
     * Redirect URIs. Not just for OAuth banks: for every link token. So
     * defaulting this to a plausible-looking URL takes the whole screen down
     * until somebody happens to add it in the dashboard, which is a
     * configuration step this repo cannot perform or verify.
     *
     * Unset, Link works for every non-OAuth institution and OAuth ones are
     * simply unavailable. Set it once `${PUBLIC_ORIGIN}/plaid/return` is
     * registered, and they light up.
     */
    redirectUri: process.env.PLAID_REDIRECT_URI,
  },

  /**
   * Encrypts vendor bearer credentials at rest — base64 of 32 random bytes.
   * There is no default: see `services/vendor-tokens.ts` for why a missing
   * key is a boot failure rather than a fallback.
   */
  vendorTokenKey: process.env.VENDOR_TOKEN_KEY,

  /**
   * Where hosted vendors send the borrower back — Stripe Identity, and Plaid's
   * report webhook.
   *
   * `||` and not `??`: an empty string is not nullish, and a deploy that sets
   * this from an unresolved shell variable would otherwise produce return URLs
   * beginning "/f/..." with no origin at all. Falling back to the local
   * default is wrong in production, but it is visibly wrong.
   */
  publicOrigin: process.env.PUBLIC_ORIGIN || "http://localhost:5173",

  /** Fixture persona for local development. */
  fixturePersona: process.env.FIXTURE_PERSONA ?? "clean_w2",

  /**
   * The product a new file is quoted against.
   *
   * Drew's sheet has no product or rate selection screen — the borrower never
   * picks a loan. But six requirements need a note rate to compute anything:
   * UW-004 (DTI, via PITIA), UW-007/8/9 (the APR-based compliance tests),
   * UW-010 (pricing) and APP-019 (net tangible benefit). Without one, screen 8
   * can compute LTV and nothing else, which is not a decision.
   *
   * So the system quotes a product rather than asking for one. This is a
   * placeholder rate, not a lock and not a quote: a real build reads it from a
   * rate sheet keyed on product, FICO, LTV and lock period. It is an env var so
   * the number is visible and adjustable rather than buried in a constructor.
   */
  /**
   * Google OAuth client id. Public by design — it is embedded in every page
   * that offers Google sign-in — so it is a plain env var, not a secret.
   * Required in production; `assertAuthConfigured` refuses to boot without it.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID,

  /**
   * Optional domain restriction on sign-in. **Unset means anyone with a Google
   * account may sign in**, which is the current intent — the prototype is
   * being tested by people outside the company.
   *
   * This defaults to open rather than closed, which is the opposite of what a
   * gate should normally do. It is defensible only because it is not the
   * control: the OAuth consent screen decides who Google will mint a token
   * for, and this is a narrowing on top of that. Set it the moment the
   * audience narrows again.
   */
  allowedDomain: process.env.ALLOWED_DOMAIN || undefined,

  /**
   * Signs the session cookie. A weak or shared value would let anyone who
   * knows it mint a session for any user, so production must supply a real
   * one — the development fallback is deliberately obvious as a fallback.
   */
  sessionSecret:
    process.env.SESSION_SECRET ??
    (process.env.NODE_ENV === "production" ? "" : "development-only-session-secret"),

  defaultProduct: {
    code: process.env.DEFAULT_PRODUCT_CODE ?? "CONF-30-FIXED",
    termMonths: parseInt(process.env.DEFAULT_TERM_MONTHS ?? "360", 10),
    noteRate: Number(process.env.DEFAULT_NOTE_RATE ?? "6.25"),
  },
} as const;
