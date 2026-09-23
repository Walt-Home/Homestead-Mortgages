/**
 * A Google identity token for calling another Cloud Run service.
 *
 * Doug's runtime no longer admits the world: Cloud Run's own IAM gate is
 * on it, and only this service's identity (`hm-run@`) holds the invoker
 * role. So every call our API makes to his door carries an OIDC token for
 * his URL as audience, minted by the metadata server from the identity the
 * container runs as, and sent on `X-Serverless-Authorization` — the header
 * Cloud Run reserves for exactly the case where `Authorization` already
 * belongs to the application, which here is his bearer. Cloud Run checks
 * the token and strips the header before his server sees the request.
 *
 * Off Google Cloud there is no metadata server; the provider answers null
 * and the callers send nothing extra, which is what a local runtime wants.
 * A token is cached until a minute before it expires; a failed mint is
 * remembered for a minute so a local run does not ask the void on every
 * call.
 */

const METADATA =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export const IDENTITY_HEADER = "x-serverless-authorization";

export type IdentityTokenProvider = () => Promise<string | null>;

/** The `exp` claim of a JWT, in ms, or null when it cannot be read. */
function expiryOf(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function identityTokenFor(
  audience: string,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): IdentityTokenProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let token: string | null = null;
  let goodUntil = 0;
  let quietUntil = 0;

  return async () => {
    const t = now();
    if (token && t < goodUntil) return token;
    if (t < quietUntil) return null;
    try {
      const res = await doFetch(`${METADATA}?audience=${encodeURIComponent(audience)}`, {
        headers: { "metadata-flavor": "Google" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`metadata server answered ${res.status}`);
      const minted = (await res.text()).trim();
      if (!minted) throw new Error("metadata server answered nothing");
      token = minted;
      goodUntil = (expiryOf(minted) ?? t + 30 * 60_000) - 60_000;
      return token;
    } catch {
      token = null;
      quietUntil = t + 60_000;
      return null;
    }
  };
}
