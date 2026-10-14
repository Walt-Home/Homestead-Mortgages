/**
 * Does the restricted key read the date of birth? One command to find out.
 *
 *   npm run identity:dob -- vs_1UOKmIKI8FIkvVrtg9Jx26MX
 *
 * Reads the named VerificationSession the way screen 2 does, through the
 * adapter, and says what came back: the status, whether a name, an address
 * and a date of birth were returned, and when the date did not come back,
 * Stripe's own reason from a direct read with the restricted key. It prints
 * no value from the ID, only whether each one is there.
 *
 * The session has to have been verified in the last 48 hours: that is the
 * window a restricted key without an IP restriction is given, and the reason
 * Stripe most often gives for refusing an older one. Verify a fresh session
 * in test mode (screen 2, "Scan your ID", then "Complete with test data") and
 * name it here.
 *
 * The key is `STRIPE_IDENTITY_RESULTS_KEY_SANDBOX`, a restricted key made in
 * the Stripe dashboard with Identity Verification Results and Recent Detailed
 * Verification Results set to Read and nothing else.
 */

import { stripeIdentityConnector } from "@hm/connectors";
import { config } from "../config.js";

async function main(): Promise<void> {
  const verificationId = process.argv[2];
  if (!verificationId?.startsWith("vs_")) {
    console.error("Name a verification session: npm run identity:dob -- vs_...");
    process.exitCode = 1;
    return;
  }
  const { secretKey, identityResultsKey, allowLiveIdentity } = config.stripe;
  if (!secretKey) {
    console.error("No Stripe secret key is set (STRIPE_SECRET_KEY_SANDBOX).");
    process.exitCode = 1;
    return;
  }
  if (!identityResultsKey) {
    console.log(
      "No restricted key is set, so the date of birth is not read and screen 2 asks for it.\n" +
        "Create one in the Stripe dashboard (Identity Verification Results and Recent Detailed\n" +
        "Verification Results set to Read) and set STRIPE_IDENTITY_RESULTS_KEY_SANDBOX.",
    );
    return;
  }

  const identity = stripeIdentityConnector({
    secretKey,
    origin: config.publicOrigin,
    allowLiveMode: allowLiveIdentity,
    resultsKey: identityResultsKey,
  });
  console.log(`adapter: ${identity.capabilities.provider}`);

  const read = await identity.getVerification(verificationId);
  if (!read) {
    console.log("Stripe did not return that session to the secret key.");
    process.exitCode = 1;
    return;
  }
  const has = (v: unknown) => (v ? "returned" : "not returned");
  console.log(`status: ${read.status}`);
  console.log(`name: ${has(read.documentName)}`);
  console.log(`address: ${has(read.documentAddress)}`);
  console.log(`date of birth: ${has(read.documentDateOfBirth)}`);
  if (read.documentDateOfBirth || read.status !== "verified") return;

  // Why not, in Stripe's words. Its error messages carry no personal data.
  const res = await fetch(
    `https://api.stripe.com/v1/identity/verification_sessions/${encodeURIComponent(verificationId)}` +
      "?expand[]=verified_outputs&expand[]=verified_outputs.dob",
    { headers: { Authorization: `Bearer ${identityResultsKey}` } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    console.log(
      `Stripe refused the restricted key's read (${res.status}): ${body?.error?.message}`,
    );
  } else {
    console.log(
      "The restricted key's read succeeded and carried no usable date: the document had none, " +
        "or the session is past the 48-hour window.",
    );
  }
  process.exitCode = 1;
}

void main();
