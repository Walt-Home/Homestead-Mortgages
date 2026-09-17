/**
 * Which adapter answers for the county record, read off the registry at boot.
 *
 * Two variables, two layers. `PROPERTY_RECORDS_PROVIDER` says who answers
 * beneath autocomplete for the record and the valuation; `PROPERTY_DATA_PROVIDER`
 * says who answers autocomplete on top. A deployment naming CoreLogic without
 * its credentials refuses to boot rather than serving a fixture's tax bill
 * behind a real vendor's name, and /health prints which mix it ended up with.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const VARIABLES = [
  "PROPERTY_DATA_PROVIDER",
  "PROPERTY_RECORDS_PROVIDER",
  "GOOGLE_PLACES_API_KEY",
  "CORELOGIC_CLIENT_KEY",
  "CORELOGIC_CLIENT_SECRET",
  "CORELOGIC_BASE_URL",
];

async function withEnv(env: Record<string, string>) {
  vi.resetModules();
  for (const name of VARIABLES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return await import("../services/connectors.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("PROPERTY_RECORDS_PROVIDER left alone", () => {
  it("serves the fixture for everything", async () => {
    const { connectors, providerMix } = await withEnv({});
    expect(connectors().propertyData.capabilities.provider).toBe("fixture-property");
    expect(providerMix().propertyData).toBe("fixture-property");
  });
});

describe("PROPERTY_RECORDS_PROVIDER=corelogic", () => {
  it("refuses to boot without the client key and secret", async () => {
    const { connectors } = await withEnv({ PROPERTY_RECORDS_PROVIDER: "corelogic" });
    expect(() => connectors()).toThrow(/CORELOGIC_CLIENT_KEY or CORELOGIC_CLIENT_SECRET/);
  });

  it("builds CoreLogic for the record and the AVM, with the fixture behind it for flood", async () => {
    const { connectors, providerMix, providerModes } = await withEnv({
      PROPERTY_RECORDS_PROVIDER: "corelogic",
      CORELOGIC_CLIENT_KEY: "k",
      CORELOGIC_CLIENT_SECRET: "s",
    });
    const propertyData = connectors().propertyData;
    expect(propertyData.capabilities.provider).toBe("corelogic");
    expect(providerModes().propertyData).toBe("production");
    expect(providerMix().propertyData).toBe("corelogic (+ fixture for flood)");
    // The flood determination is the fixture's, and reached without a token.
    const flood = await propertyData.determineFlood({
      line1: "1247 Oak Street",
      city: "Austin",
      state: "TX",
      postalCode: "78704",
    });
    expect(flood.provider).toBe("fixture-flood");
  });

  it("sits beneath Places when both are named", async () => {
    const { connectors, providerMix } = await withEnv({
      PROPERTY_DATA_PROVIDER: "google_places",
      GOOGLE_PLACES_API_KEY: "g",
      PROPERTY_RECORDS_PROVIDER: "corelogic",
      CORELOGIC_CLIENT_KEY: "k",
      CORELOGIC_CLIENT_SECRET: "s",
    });
    expect(connectors().propertyData.capabilities.provider).toBe("google-places");
    expect(providerMix().propertyData).toBe(
      "google-places (+ corelogic for records and AVM, fixture for flood)",
    );
  });

  it("is what Places sits over by default when only Places is named", async () => {
    const { providerMix } = await withEnv({
      PROPERTY_DATA_PROVIDER: "google_places",
      GOOGLE_PLACES_API_KEY: "g",
    });
    expect(providerMix().propertyData).toBe("google-places (+ fixture for records)");
  });
});
