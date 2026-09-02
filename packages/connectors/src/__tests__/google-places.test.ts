/**
 * The Places adapter, tested without touching the network.
 *
 * Two properties matter more than the happy path. A dead autocomplete must
 * degrade to "no suggestions" rather than throwing, because screen 1 keeps a
 * manual path and a thrown error would take the whole form down. And a place
 * that resolves to something short of a mailing address must be dropped, not
 * half-mapped — a suggestion that fills the city and leaves the street blank is
 * worse than no suggestion, because the borrower will not notice.
 */

import { describe, expect, it, vi } from "vitest";
import { googlePlacesConnector } from "../adapters/google-places.js";
import { fixturePropertyDataConnector } from "../index.js";

const fallback = fixturePropertyDataConnector({ latencyMs: 0 });

function stubFetch(handlers: { autocomplete?: unknown; details?: unknown; fail?: boolean }) {
  return vi.fn(async (url: string | URL | Request) => {
    if (handlers.fail) throw new Error("network down");
    const href = String(url);
    const body = href.includes(":autocomplete") ? handlers.autocomplete : handlers.details;
    if (body === undefined) return new Response("", { status: 500 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const COMPLETE = {
  formattedAddress: "1247 Oak Street, Austin, TX 78704, USA",
  addressComponents: [
    { longText: "1247", types: ["street_number"] },
    { longText: "Oak Street", types: ["route"] },
    { longText: "Austin", types: ["locality"] },
    { longText: "Texas", shortText: "TX", types: ["administrative_area_level_1"] },
    { longText: "78704", types: ["postal_code"] },
  ],
};

describe("google places autocomplete", () => {
  it("maps a complete place to a mailing address", async () => {
    const c = googlePlacesConnector({
      apiKey: "k",
      fallback,
      fetchImpl: stubFetch({
        autocomplete: { suggestions: [{ placePrediction: { placeId: "p1", text: { text: "1247 Oak" } } }] },
        details: COMPLETE,
      }),
    });
    const [s] = await c.suggestAddresses("1247 Oak");
    expect(s?.address).toEqual({
      line1: "1247 Oak Street",
      city: "Austin",
      state: "TX",
      postalCode: "78704",
    });
    expect(s?.id).toBe("p1");
  });

  it("drops a place that is not a full mailing address", async () => {
    // A locality-level result has no route. Half-mapping it would fill the
    // city and silently leave the street empty.
    const c = googlePlacesConnector({
      apiKey: "k",
      fallback,
      fetchImpl: stubFetch({
        autocomplete: { suggestions: [{ placePrediction: { placeId: "p1" } }] },
        details: {
          formattedAddress: "Austin, TX, USA",
          addressComponents: [
            { longText: "Austin", types: ["locality"] },
            { longText: "Texas", shortText: "TX", types: ["administrative_area_level_1"] },
          ],
        },
      }),
    });
    expect(await c.suggestAddresses("Austin")).toEqual([]);
  });

  it("handles a street with no number rather than dropping it", async () => {
    const c = googlePlacesConnector({
      apiKey: "k",
      fallback,
      fetchImpl: stubFetch({
        autocomplete: { suggestions: [{ placePrediction: { placeId: "p1" } }] },
        details: {
          formattedAddress: "Rural Route 3, Bandera, TX 78003, USA",
          addressComponents: [
            { longText: "Rural Route 3", types: ["route"] },
            { longText: "Bandera", types: ["locality"] },
            { longText: "Texas", shortText: "TX", types: ["administrative_area_level_1"] },
            { longText: "78003", types: ["postal_code"] },
          ],
        },
      }),
    });
    const [s] = await c.suggestAddresses("Rural Route 3");
    expect(s?.address.line1).toBe("Rural Route 3");
  });

  it("returns nothing rather than throwing when Places is unreachable", async () => {
    const c = googlePlacesConnector({ apiKey: "k", fallback, fetchImpl: stubFetch({ fail: true }) });
    await expect(c.suggestAddresses("anything")).resolves.toEqual([]);
  });

  it("does not call Places for a query too short to mean anything", async () => {
    const fetchImpl = stubFetch({ autocomplete: { suggestions: [] } });
    const c = googlePlacesConnector({ apiKey: "k", fallback, fetchImpl });
    await c.suggestAddresses("12");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("claims no requirements — the assessor lookup satisfies APP-004, not this", async () => {
    const c = googlePlacesConnector({ apiKey: "k", fallback, fetchImpl: stubFetch({}) });
    expect(c.capabilities.satisfies).toEqual([]);
    expect(c.capabilities.provider).toBe("google-places");
  });

  it("delegates everything Places does not know to the fallback", async () => {
    const c = googlePlacesConnector({ apiKey: "k", fallback, fetchImpl: stubFetch({}) });
    const address = { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78704" };
    const record = await c.lookupRecord(address);
    expect(record.provider).toBe(fallback.capabilities.provider);
  });
});
