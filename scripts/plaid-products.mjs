#!/usr/bin/env node
/**
 * Which Plaid products the account is enabled for, asked of Plaid itself.
 *
 * Plaid has no endpoint that lists an account's entitlements. What it has is
 * `/link/token/create`, which refuses with INVALID_PRODUCT and the product's
 * name when the account is not enabled for it — so this asks for a link
 * token per product and reads the answer. A link token nobody opens costs
 * nothing and touches no borrower.
 *
 * Reads PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV (sandbox or production)
 * from the environment, the same names the API reads, so `.env` serves for
 * the sandbox and the production secret can be handed in for one run:
 *
 *   PLAID_ENV=production PLAID_SECRET="$(gcloud secrets versions access latest \
 *     --secret=HOMESTEAD_MORTGAGES_PLAID_SECRET_PROD --project=homestead-mortgages)" \
 *     npm run plaid:products
 *
 * The consumer-report products (`cra_base_report`, `cra_income_insights`)
 * are the ones CRD-017 turns on and the ones the sandbox refuses too until
 * Plaid enables them; `assets` is the stand-in the bank screen runs on
 * meanwhile. Probed 7 October 2026: this account is enabled for none of
 * them in either environment.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dotenv = resolve(here, "../.env");
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env.PLAID_SECRET;
const env = process.env.PLAID_ENV ?? "sandbox";
if (!clientId || !secret) {
  console.error("PLAID_CLIENT_ID and PLAID_SECRET are required.");
  process.exit(2);
}
if (env !== "sandbox" && env !== "production") {
  console.error(`PLAID_ENV is '${env}'; it is sandbox or production.`);
  process.exit(2);
}
const host = env === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";

async function call(path, body) {
  const res = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });
  return res.json();
}

/**
 * The consumer-report products and bank income need a user, and the link
 * token has to name the SAME person Plaid made the user for — the handle
 * at `/user/create` and `user.client_user_id` at the link token are one
 * string, exactly as the adapter sends them.
 */
const handle = `plaid-products-${Date.now()}`;
const user = await call("/user/create", { client_user_id: handle });
const userId = typeof user.user_id === "string" ? user.user_id : null;

const PRODUCTS = [
  { products: ["cra_base_report", "cra_income_insights"], cra: true },
  { products: ["assets"] },
  { products: ["transactions"] },
  { products: ["auth"] },
  { products: ["identity"] },
  { products: ["income_verification"], user: true },
];

console.log(`Plaid ${env}, client ${clientId.slice(0, 8)}…`);
let enabledAny = false;
for (const p of PRODUCTS) {
  const r = await call("/link/token/create", {
    user: { client_user_id: handle },
    client_name: "Supermortgage",
    language: "en",
    country_codes: ["US"],
    products: p.products,
    ...((p.cra || p.user) && userId ? { user_id: userId } : {}),
    ...(p.cra
      ? {
          consumer_report_permissible_purpose: "WRITTEN_INSTRUCTION_PREQUALIFICATION",
          cra_options: { days_requested: 365 },
        }
      : {}),
  });
  const label = p.products.join(" + ");
  if (typeof r.link_token === "string") {
    enabledAny = true;
    console.log(`  enabled   ${label}`);
  } else if (r.error_code === "INVALID_PRODUCT") {
    console.log(`  NOT enabled ${label}`);
  } else if (p.cra && /identity/i.test(String(r.error_message))) {
    // Past the product check: Plaid wants a person's identity before it
    // makes a consumer-report user, and this probe deliberately gives none.
    // The adapter does. So this is "enabled", said with the reason.
    enabledAny = true;
    console.log(
      `  enabled   ${label} (Plaid asked for the person's identity, which the adapter sends)`,
    );
  } else {
    console.log(`  ?         ${label}: ${r.error_code ?? "no answer"} ${r.error_message ?? ""}`);
  }
}
if (!enabledAny) {
  console.log(
    "Nothing is enabled. Ask Plaid to enable the products on this client id, in this environment:",
  );
  console.log("  https://dashboard.plaid.com/overview/request-products");
}
