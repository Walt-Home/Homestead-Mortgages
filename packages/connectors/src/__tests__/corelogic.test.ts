/**
 * The CoreLogic adapter, tested without touching the network.
 *
 * What matters more than the happy path: the token is fetched once and
 * replaced on a 401; an address the API cannot place is the manual path, not
 * a thrown 500; a land use this file cannot map is refused rather than
 * defaulted to `Detached` on a federal submission; the three methods share
 * one search; and the flood determination is somebody else's.
 *
 * The payloads below are shaped exactly as the v2 specification declares
 * them, read off the developer portal's Swagger on 2026-09-17.
 */
import { describe, expect, it, vi } from "vitest";
import {
  avmConfidence,
  classifyLandUse,
  coreLogicConnector,
  CoreLogicError,
  PropertyNotDescribableError,
} from "../adapters/corelogic.js";
import {
  AddressNotFoundError,
  FloodNotDeterminedError,
  ValuationUnavailableError,
  fixturePropertyDataConnector,
} from "../index.js";

const fallback = fixturePropertyDataConnector({ latencyMs: 0 });

const OAK = { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78704" };

const SEARCH = {
  metadata: { totalRecords: 1 },
  items: [
    {
      clip: "1234567890",
      propertyAddress: {
        streetAddress: "1247 OAK ST",
        city: "AUSTIN",
        state: "TX",
        zipCode: "78704",
        county: "TRAVIS",
      },
      propertyAPN: {
        apnParcelNumberFormatted: "01-1423-0209",
        apnParcelNumberUnformatted: "0114230209",
      },
      addressMatchInformation: { propertyMatchScore: 10, resultCode: "ADDR:MATCH" },
    },
  ],
};

const DETAIL = {
  buildings: {
    data: {
      allBuildingsSummary: {
        buildingsCount: 1,
        unitsCount: 1,
        bedroomsCount: 3,
        bathroomsCount: 2,
        livingAreaSquareFeet: 1840,
        totalAreaSquareFeet: 2100,
      },
      Buildings: [{ constructionDetails: { yearBuilt: 1962, effectiveYearBuilt: 1990 } }],
    },
  },
  ownership: {
    data: {
      currentOwners: {
        ownerNames: [{ fullName: "WHITFIELD DANA M" }, { fullName: "WHITFIELD ELI" }],
      },
    },
  },
  siteLocation: {
    data: {
      locationLegal: { description: "LOT 14 BLK C TRAVIS HEIGHTS ANNEX" },
      landUseAndZoningCodes: {
        propertyTypeCode: "10",
        propertyTypeCodeDescription: "SINGLE FAMILY RESIDENCE / TOWNHOUSE",
        landUseCode: "163",
        landUseCodeDescription: "SINGLE FAMILY RESIDENTIAL",
        isManufacturedHome: null,
      },
      lot: { areaSquareFeet: 7405, areaAcres: 0.17 },
    },
  },
  taxAssessment: {
    items: [
      {
        taxAmount: { billedYear: 2025, totalTaxAmount: 8216.4, netTaxAmount: 8100 },
        assessedValue: {
          taxAssessedYear: 2025,
          calculatedTotalValue: 389000,
          taxableValue: 350000,
        },
      },
    ],
  },
  lastMarketSale: {
    items: [
      {
        transactionDetails: { saleDateDerived: "2017-06-15", saleAmount: 268000 },
        propertyDetails: { actualYearBuilt: 1962 },
      },
    ],
  },
};

const AVM = {
  summary: {
    estimatedValue: 412000,
    lowValue: 394000,
    highValue: 430000,
    processedDate: "2026-09-10",
    forecastStandardDeviation: 0.12,
    confidenceScore: 88,
  },
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers by path, and remembers every call it saw. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.pathname.startsWith(k));
    if (!key) return new Response("no route", { status: 500 });
    return routes[key]!(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const token =
  (value = "tok-1", expiresIn: string | number = 3599) =>
  () =>
    json({ access_token: value, expires_in: expiresIn, token_type: "Bearer" });

function connector(
  routes: Record<string, Handler>,
  extra: Partial<Parameters<typeof coreLogicConnector>[0]> = {},
) {
  const fetchImpl = stubFetch({ "/oauth/token": token(), ...routes });
  const c = coreLogicConnector({
    clientKey: "key",
    clientSecret: "secret",
    fallback,
    fetchImpl: fetchImpl.impl,
    ...extra,
  });
  return { c, calls: fetchImpl.calls };
}

const HAPPY: Record<string, Handler> = {
  "/v2/properties/search": () => json(SEARCH),
  "/v2/properties/1234567890/property-detail": () => json(DETAIL),
  "/v2/properties/1234567890/home-owners-association": () => json({ items: [] }, 404),
  "/v2/properties/1234567890/avm/thv/thvOriginations/summary": () => json(AVM),
};

describe("the token", () => {
  it("is fetched once with the key and secret as Basic, and sent as a bearer", async () => {
    const { c, calls } = connector(HAPPY);
    await c.lookupRecord(OAK);
    await c.estimateValue(OAK);
    const tokenCalls = calls.filter((x) => x.url.pathname === "/oauth/token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url.searchParams.get("grant_type")).toBe("client_credentials");
    expect(tokenCalls[0]!.init?.method).toBe("POST");
    const headers = tokenCalls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
    const data = calls.filter((x) => x.url.pathname !== "/oauth/token");
    expect(data.length).toBeGreaterThan(0);
    for (const call of data) {
      expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    }
  });

  it("is replaced once on a 401 and the call is made again", async () => {
    let issued = 0;
    let searches = 0;
    const { c, calls } = connector({
      "/oauth/token": () => json({ access_token: `tok-${++issued}`, expires_in: 3599 }),
      ...HAPPY,
      "/v2/properties/search": () => (++searches === 1 ? json({}, 401) : json(SEARCH)),
    });
    const record = await c.lookupRecord(OAK);
    expect(record.data.apn).toBe("01-1423-0209");
    expect(issued).toBe(2);
    const bearers = calls
      .filter((x) => x.url.pathname === "/v2/properties/search")
      .map((x) => (x.init?.headers as Record<string, string>).authorization);
    expect(bearers).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("expires a minute early, by the clock it is given", async () => {
    let issued = 0;
    let at = new Date("2026-09-17T12:00:00Z");
    const { c } = connector(
      {
        "/oauth/token": () => json({ access_token: `tok-${++issued}`, expires_in: 120 }),
        ...HAPPY,
      },
      { now: () => at },
    );
    await c.estimateValue(OAK);
    at = new Date("2026-09-17T12:00:59Z");
    await c.estimateValue({ ...OAK, line1: "1249 Oak Street" });
    expect(issued).toBe(1);
    at = new Date("2026-09-17T12:01:01Z");
    await c.estimateValue({ ...OAK, line1: "1251 Oak Street" });
    expect(issued).toBe(2);
  });

  it("names the variables and never the values when the credentials are refused", async () => {
    const { c } = connector({ "/oauth/token": () => json({ error: "invalid_client" }, 401) });
    await expect(c.lookupRecord(OAK)).rejects.toMatchObject({
      name: "CoreLogicError",
      status: 401,
    });
    await expect(c.lookupRecord(OAK)).rejects.toThrow(/CORELOGIC_CLIENT_KEY/);
    await expect(c.lookupRecord(OAK)).rejects.not.toThrow(/secret\b.*:/);
  });
});

describe("the county record", () => {
  it("is read off one search and one detail call, with the HOA beside it", async () => {
    const { c, calls } = connector(HAPPY);
    const result = await c.lookupRecord(OAK);
    expect(result.provider).toBe("corelogic");
    expect(result.externalId).toBe("clip-1234567890");
    expect(result.data).toEqual({
      apn: "01-1423-0209",
      county: "TRAVIS",
      legalDescription: "LOT 14 BLK C TRAVIS HEIGHTS ANNEX",
      propertyType: "single_family",
      units: 1,
      attachment: "detached",
      yearBuilt: 1962,
      squareFeet: 1840,
      bedrooms: 3,
      bathrooms: 2,
      lotSizeSqFt: 7405,
      assessedValue: 389000,
      annualPropertyTax: 8216.4,
      hoaExists: false,
      ownerOfRecord: "WHITFIELD DANA M & WHITFIELD ELI",
      lastSale: { soldOn: "2017-06-15", price: 268000 },
      priorOwnershipInLastThreeYears: null,
    });
    const search = calls.find((x) => x.url.pathname === "/v2/properties/search")!;
    expect(Object.fromEntries(search.url.searchParams)).toEqual({
      streetAddress: "1247 Oak Street",
      city: "Austin",
      state: "TX",
      zipCode: "78704",
      bestMatch: "true",
    });
  });

  it("says an association exists when the HOA product has one on record, and knows no dues", async () => {
    const { c } = connector({
      ...HAPPY,
      "/v2/properties/1234567890/home-owners-association": () =>
        json({
          items: [
            {
              clip: "1234567890",
              homeOwnersAssociation: [{ identifier: 1, name: "TRAVIS HEIGHTS HOA" }],
            },
          ],
        }),
    });
    const { data } = await c.lookupRecord(OAK);
    expect(data.hoaExists).toBe(true);
    expect(data.monthlyAssociationDues).toBeUndefined();
  });

  it("is the manual path when the address matches nothing", async () => {
    const { c } = connector({ ...HAPPY, "/v2/properties/search": () => json({ items: [] }) });
    await expect(c.lookupRecord(OAK)).rejects.toBeInstanceOf(AddressNotFoundError);
  });

  it("refuses a land use it cannot place, naming the code and nobody", async () => {
    const { c } = connector({
      ...HAPPY,
      "/v2/properties/1234567890/property-detail": () =>
        json({
          ...DETAIL,
          siteLocation: {
            data: {
              ...DETAIL.siteLocation.data,
              landUseAndZoningCodes: {
                landUseCode: "200",
                landUseCodeDescription: "COMMERCIAL (GENERAL)",
                propertyTypeCodeDescription: "COMMERCIAL",
              },
            },
          },
        }),
    });
    const attempt = c.lookupRecord(OAK);
    await expect(attempt).rejects.toBeInstanceOf(PropertyNotDescribableError);
    await expect(attempt).rejects.toBeInstanceOf(AddressNotFoundError);
    await expect(attempt).rejects.toThrow(/200: COMMERCIAL \(GENERAL\)/);
    await expect(attempt).rejects.not.toThrow(/WHITFIELD/);
  });

  it("leaves a figure the county did not report at zero rather than inventing one", async () => {
    const { c } = connector({
      ...HAPPY,
      "/v2/properties/1234567890/property-detail": () =>
        json({
          ...DETAIL,
          buildings: {
            data: { allBuildingsSummary: { unitsCount: null, bedroomsCount: null }, Buildings: [] },
          },
        }),
    });
    const { data } = await c.lookupRecord(OAK);
    expect(data.bedrooms).toBe(0);
    expect(data.squareFeet).toBe(0);
    expect(data.yearBuilt).toBe(1962); // off the last sale, the third place it is reported
    expect(data.units).toBe(1); // a single-family house is one unit whatever the count says
  });

  it("takes the unit count off the buildings for a two-to-four", async () => {
    const { c } = connector({
      ...HAPPY,
      "/v2/properties/1234567890/property-detail": () =>
        json({
          ...DETAIL,
          buildings: {
            data: {
              ...DETAIL.buildings.data,
              allBuildingsSummary: { ...DETAIL.buildings.data.allBuildingsSummary, unitsCount: 3 },
            },
          },
          siteLocation: {
            data: {
              ...DETAIL.siteLocation.data,
              landUseAndZoningCodes: { landUseCode: "165", landUseCodeDescription: null },
            },
          },
        }),
    });
    const { data } = await c.lookupRecord(OAK);
    expect(data).toMatchObject({
      propertyType: "two_to_four_unit",
      units: 3,
      attachment: "detached",
    });
  });
});

describe("the valuation", () => {
  it("is the originations model's summary", async () => {
    const { c, calls } = connector(HAPPY);
    const result = await c.estimateValue(OAK);
    expect(result.provider).toBe("corelogic-thvOriginations");
    expect(result.data).toEqual({
      value: 412000,
      low: 394000,
      high: 430000,
      confidence: 88,
      asOf: "2026-09-10",
    });
    expect(calls.some((x) => x.url.pathname.endsWith("/avm/thv/thvOriginations/summary"))).toBe(
      true,
    );
  });

  it("is no valuation, not no record, when the model has no estimate or answers zeros", async () => {
    const missing = connector({
      ...HAPPY,
      "/v2/properties/1234567890/avm/thv/thvOriginations/summary": () => json({}, 404),
    });
    await expect(missing.c.estimateValue(OAK)).rejects.toBeInstanceOf(ValuationUnavailableError);
    await expect(missing.c.estimateValue(OAK)).rejects.not.toBeInstanceOf(AddressNotFoundError);
    // A building the model will not price answers 200 with every figure at zero.
    const zeros = connector({
      ...HAPPY,
      "/v2/properties/1234567890/avm/thv/thvOriginations/summary": () =>
        json({ summary: { estimatedValue: 0, lowValue: 0, highValue: 0, confidenceScore: 0 } }),
    });
    await expect(zeros.c.estimateValue(OAK)).rejects.toBeInstanceOf(ValuationUnavailableError);
  });
});

describe("the three methods together", () => {
  it("search once for an address, however many of them ask", async () => {
    const { c, calls } = connector(HAPPY);
    await Promise.all([c.lookupRecord(OAK), c.estimateValue(OAK), c.determineFlood(OAK)]);
    expect(calls.filter((x) => x.url.pathname === "/v2/properties/search")).toHaveLength(1);
  });

  it("hand the flood determination to the fallback, and say so", async () => {
    const { c, calls } = connector(HAPPY);
    const flood = await c.determineFlood(OAK);
    expect(flood.provider).toBe("fixture-flood");
    expect(calls).toHaveLength(0);
    expect(c.capabilities).toEqual({
      provider: "corelogic",
      mode: "production",
      satisfies: ["APP-004"],
    });
  });

  it("say a parcel the fallback does not know is undetermined, not unknown", async () => {
    // The fixture knows three addresses. Every other parcel has a record and
    // no flood determination, which is a different fact from no record.
    const { c } = connector(HAPPY);
    const elsewhere = { line1: "1 W 72nd St", city: "New York", state: "NY", postalCode: "10023" };
    await expect(c.determineFlood(elsewhere)).rejects.toBeInstanceOf(FloodNotDeterminedError);
    await expect(c.determineFlood(elsewhere)).rejects.not.toBeInstanceOf(AddressNotFoundError);
  });

  it("answer autocomplete from typeahead, and nothing when it is down", async () => {
    const { c } = connector({
      "/v2/properties/typeahead": () =>
        json({
          results: [
            {
              clip: "1",
              address: "1247 OAK ST AUSTIN TX 78704",
              addressLine1: "1247 OAK ST",
              city: "AUSTIN",
              state: "TX",
              zip: "78704",
            },
            { clip: "2", address: "no street", city: "AUSTIN", state: "TX", zip: "78704" },
          ],
        }),
    });
    const suggestions = await c.suggestAddresses("1247 Oak");
    expect(suggestions).toEqual([
      {
        id: "1",
        label: "1247 OAK ST AUSTIN TX 78704",
        address: { line1: "1247 OAK ST", city: "AUSTIN", state: "TX", postalCode: "78704" },
      },
    ]);
    const down = connector({ "/v2/properties/typeahead": () => json({}, 500) });
    expect(await down.c.suggestAddresses("1247 Oak")).toEqual([]);
    expect(await down.c.suggestAddresses("12")).toEqual([]);
  });

  it("surface any other failure with the status and never the body", async () => {
    const { c } = connector({
      ...HAPPY,
      "/v2/properties/1234567890/property-detail": () => json({ owner: "WHITFIELD" }, 503),
    });
    await expect(c.lookupRecord(OAK)).rejects.toBeInstanceOf(CoreLogicError);
    await expect(c.lookupRecord(OAK)).rejects.not.toThrow(/WHITFIELD/);
  });
});

describe("the mapping rules", () => {
  it("read the Universal Land Use code first, as the wire sends it: codes and no descriptions", () => {
    const code = (landUseCode: string, propertyTypeCode = "10") =>
      classifyLandUse({ landUseCode, propertyTypeCode, landUseCodeDescription: null });
    expect(code("163")).toEqual({ propertyType: "single_family", attachment: "detached" });
    expect(code("148")).toEqual({ propertyType: "single_family", attachment: "detached" });
    expect(code("102")).toEqual({ propertyType: "townhouse", attachment: "attached" });
    expect(code("112", "11")).toEqual({ propertyType: "condo", attachment: "attached" });
    expect(code("117", "11")).toEqual({ propertyType: "condo", attachment: "attached" });
    expect(code("111", "11")).toEqual({ propertyType: "co_op", attachment: "attached" });
    expect(code("115", "21")).toEqual({
      propertyType: "two_to_four_unit",
      attachment: "detached",
      units: 2,
    });
    expect(code("151", "21")).toEqual({
      propertyType: "two_to_four_unit",
      attachment: "detached",
      units: 4,
    });
    expect(code("138")).toEqual({ propertyType: "manufactured", attachment: "detached" });
    // A condominium PROJECT is the parcel the units sit on; a mobile home
    // park is land; tax-exempt and art are not dwellings.
    expect(code("113", "11")).toBeNull();
    expect(code("136")).toBeNull();
    expect(code("601", "90")).toBeNull();
    expect(code("620", "90")).toBeNull();
  });

  it("let the property indicator settle a residential land use that names no kind", () => {
    expect(classifyLandUse({ landUseCode: "100", propertyTypeCode: "10" })).toEqual({
      propertyType: "single_family",
      attachment: "detached",
    });
    expect(classifyLandUse({ landUseCode: "133", propertyTypeCode: "11" })).toEqual({
      propertyType: "condo",
      attachment: "attached",
    });
    expect(classifyLandUse({ landUseCode: "133", propertyTypeCode: "21" }, 3)).toEqual({
      propertyType: "two_to_four_unit",
      attachment: "detached",
      units: 3,
    });
    // Two to four units with no count is not a kind this product can state.
    expect(classifyLandUse({ landUseCode: "133", propertyTypeCode: "21" }, null)).toBeNull();
    expect(classifyLandUse({ landUseCode: "133", propertyTypeCode: "21" }, 6)).toBeNull();
    expect(classifyLandUse({ landUseCode: "", propertyTypeCode: "11" })).toEqual({
      propertyType: "condo",
      attachment: "attached",
    });
  });

  it("place the land uses this product underwrites", () => {
    expect(classifyLandUse({ landUseCodeDescription: "CONDOMINIUM (RESIDENTIAL)" })).toEqual({
      propertyType: "condo",
      attachment: "attached",
    });
    expect(classifyLandUse({ landUseCodeDescription: "TOWNHOUSE (RESIDENTIAL)" })).toEqual({
      propertyType: "townhouse",
      attachment: "attached",
    });
    expect(classifyLandUse({ landUseCodeDescription: "ROW HOUSE" })).toEqual({
      propertyType: "townhouse",
      attachment: "attached",
    });
    expect(classifyLandUse({ landUseCodeDescription: "COOPERATIVE" })).toEqual({
      propertyType: "co_op",
      attachment: "attached",
    });
    expect(
      classifyLandUse({ landUseCodeDescription: "DUPLEX (2 UNITS, ANY COMBINATION)" }),
    ).toEqual({ propertyType: "two_to_four_unit", attachment: "detached" });
    expect(
      classifyLandUse({
        landUseCodeDescription: "SINGLE FAMILY RESIDENTIAL",
        isManufacturedHome: "Y",
      }),
    ).toEqual({ propertyType: "manufactured", attachment: "detached" });
    expect(classifyLandUse({ landUseCodeDescription: "PUD (PLANNED UNIT DEVELOPMENT)" })).toEqual({
      propertyType: "single_family",
      attachment: "detached",
    });
    expect(
      classifyLandUse({ landUseCodeDescription: "SINGLE FAMILY RESIDENTIAL - ATTACHED" }),
    ).toEqual({ propertyType: "single_family", attachment: "attached" });
    expect(classifyLandUse({ landUseCodeDescription: "COMMERCIAL (GENERAL)" })).toBeNull();
    expect(classifyLandUse({})).toBeNull();
    // The property-type code groups classes; on its own it is ambiguous, and
    // beneath a land use it is not consulted.
    expect(
      classifyLandUse({ propertyTypeCodeDescription: "SINGLE FAMILY RESIDENCE / TOWNHOUSE" }),
    ).toBeNull();
    expect(
      classifyLandUse({
        propertyTypeCodeDescription: "SINGLE FAMILY RESIDENCE / TOWNHOUSE",
        landUseCodeDescription: "TOWNHOUSE (RESIDENTIAL)",
      }),
    ).toEqual({ propertyType: "townhouse", attachment: "attached" });
    expect(classifyLandUse({ propertyTypeCodeDescription: "CONDOMINIUM" })).toEqual({
      propertyType: "condo",
      attachment: "attached",
    });
  });

  it("read the confidence on the 0–100 scale from either figure", () => {
    expect(avmConfidence({ confidenceScore: 88 })).toBe(88);
    expect(avmConfidence({ confidenceScore: 0.88 })).toBe(88);
    expect(avmConfidence({ forecastStandardDeviation: 0.12 })).toBe(88);
    expect(avmConfidence({ forecastStandardDeviation: 12 })).toBe(88);
    expect(avmConfidence({})).toBe(0);
  });
});
