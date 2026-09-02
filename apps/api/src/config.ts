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
