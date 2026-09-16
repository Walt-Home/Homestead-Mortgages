/**
 * Asking for Desktop Underwriter, and what happens when the deployment cannot
 * deliver it.
 *
 * This is the one connector where falling back to the fixture would be
 * invisible AND catastrophic. The fixture answers `Approve/Eligible` in
 * milliseconds and transmits nothing at all — so a deployment that asked for
 * Fannie Mae and quietly got the fixture looks exactly like a product that
 * submits, right up to the point somebody relies on a recommendation nobody
 * made. Every missing value is therefore a boot failure that names the
 * variable.
 *
 * The configuration is read at module load, so each case re-imports the graph
 * with a different environment rather than mutating a frozen object. The Prisma
 * client is a `globalThis` singleton in non-production, so the re-import does
 * not open a second pool.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_INSTITUTION } from "@hm/du";

const COMPLETE = {
  DU_PROVIDER: "fannie",
  DU_ENDPOINT: "https://du.example.invalid/casefiles",
  DU_SELLER_SERVICER_NUMBER: "GRNDR1",
  DU_CREDENTIAL_SCHEME: "bearer",
  DU_CREDENTIAL: "a-test-token",
};

async function withEnv(env: Record<string, string>) {
  vi.resetModules();
  // Every DU variable is cleared first, so a case that omits one is testing the
  // absence rather than inheriting a developer's .env.
  for (const name of Object.keys(COMPLETE)) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return await import("../services/connectors.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("DU_PROVIDER left alone", () => {
  it("serves the fixture, which answers and sends nothing", async () => {
    const { connectors, providerModes, providerMix } = await withEnv({});
    expect(connectors().du.capabilities.provider).toBe("fixture-du");
    expect(providerModes().du).toBe("fixture");
    expect(providerMix().du).toBe("fixture-du");
  });
});

describe("DU_PROVIDER=fannie", () => {
  it("refuses to boot naming every variable that is missing", async () => {
    const { connectors } = await withEnv({ DU_PROVIDER: "fannie" });
    expect(() => connectors()).toThrow(
      /DU_ENDPOINT, DU_SELLER_SERVICER_NUMBER, DU_CREDENTIAL_SCHEME, DU_CREDENTIAL/,
    );
  });

  it("names the one that is missing when the rest are set", async () => {
    const { connectors } = await withEnv({ ...COMPLETE, DU_CREDENTIAL: "" });
    expect(() => connectors()).toThrow(/DU_PROVIDER=fannie but DU_CREDENTIAL is not set/);
  });

  it("builds the real adapter and reports it as the test environment", async () => {
    const { connectors, providerModes, providerMix } = await withEnv(COMPLETE);
    expect(connectors().du.capabilities.provider).toBe("desktop-underwriter (test)");
    // What /api/health prints, and what the deploy workflow greps for.
    expect(providerMix().du).toBe("desktop-underwriter (test)");
    expect(providerModes().du).toBe("sandbox");
  });

  it("still claims to satisfy no requirement", async () => {
    // UW-001 and UW-002 stay unclaimed until an exchange against Fannie Mae's
    // own test environment has actually completed. A `satisfies` list here
    // would make the requirement rail report a submission path nobody has run.
    const { connectors } = await withEnv(COMPLETE);
    expect(connectors().du.capabilities.satisfies).toEqual([]);
  });

  it("refuses an endpoint that is not https", async () => {
    const { connectors } = await withEnv({ ...COMPLETE, DU_ENDPOINT: "http://du.example.invalid" });
    expect(() => connectors()).toThrow(/not https/);
  });

  it("refuses production unless somebody said production", async () => {
    const { connectors } = await withEnv({ ...COMPLETE, DU_ENV: "production" });
    expect(() => connectors()).toThrow(/DU_ALLOW_PRODUCTION/);

    const allowed = await withEnv({
      ...COMPLETE,
      DU_ENV: "production",
      DU_ALLOW_PRODUCTION: "true",
    });
    expect(allowed.connectors().du.capabilities.provider).toBe("desktop-underwriter (PRODUCTION)");
    expect(allowed.providerModes().du).toBe("production");
  });

  it("refuses a credential scheme this system does not implement", async () => {
    const { connectors } = await withEnv({ ...COMPLETE, DU_CREDENTIAL_SCHEME: "mutual_tls" });
    expect(() => connectors()).toThrow(/not one this system implements/);
  });

  it("refuses a basic or header credential with nothing to split", async () => {
    const basic = await withEnv({ ...COMPLETE, DU_CREDENTIAL_SCHEME: "basic" });
    expect(() => basic.connectors()).toThrow(/username:password/);
    const header = await withEnv({ ...COMPLETE, DU_CREDENTIAL_SCHEME: "header" });
    expect(() => header.connectors()).toThrow(/Header-Name:value/);
  });
});

describe("the seller/servicer number is held once", () => {
  /**
   * The gap this closes. The adapter submits under a number and the document
   * STATES one, and the adapter is forbidden from reading the document to
   * compare them — so two configuration fields could have disagreed
   * indefinitely without anything here noticing.
   */
  it("gives the document the same field the adapter authenticates beside", async () => {
    const { duInstitutionFromConfig } = await withEnv(COMPLETE);
    expect(duInstitutionFromConfig().submittingPartyIdentifier).toBe("GRNDR1");
  });

  it("is the placeholder when nobody has configured one", async () => {
    const { duInstitutionFromConfig } = await withEnv({});
    expect(duInstitutionFromConfig().submittingPartyIdentifier).toBe(
      PLACEHOLDER_INSTITUTION.submittingPartyIdentifier,
    );
  });

  it("leaves the lender loan number a placeholder either way", async () => {
    // A separate gap with a separate owner: nothing mints a lender loan number
    // and no column holds one. Configuring the seller/servicer number does not
    // quietly half-solve it.
    const { duInstitutionFromConfig } = await withEnv(COMPLETE);
    expect(duInstitutionFromConfig().lenderLoanIdentifier).toBe(
      PLACEHOLDER_INSTITUTION.lenderLoanIdentifier,
    );
  });

  it("cannot be built as an adapter while the document would carry a placeholder", async () => {
    // There is no arrangement of variables where a real adapter exists and the
    // casefile it would send states PLCHLD: the number is required for the
    // adapter to be built at all.
    const { connectors, duInstitutionFromConfig } = await withEnv({
      ...COMPLETE,
      DU_SELLER_SERVICER_NUMBER: "",
    });
    expect(() => connectors()).toThrow(/DU_SELLER_SERVICER_NUMBER/);
    expect(duInstitutionFromConfig().submittingPartyIdentifier).toBe(
      PLACEHOLDER_INSTITUTION.submittingPartyIdentifier,
    );
  });
});
