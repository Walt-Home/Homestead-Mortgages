/**
 * Address autocomplete, from Google Places.
 *
 * The first adapter in this repo that talks to a real vendor, and it is
 * deliberately the smallest one: autocomplete has no consent to gate, no
 * personal data going out beyond what the borrower is typing into a public
 * search box, and a failure degrades to typing the address by hand.
 *
 * It implements ONE method of `PropertyDataConnector`. Places knows what
 * addresses exist; it does not know the assessor record, the AVM or the flood
 * zone, and pretending otherwise would put invented tax figures behind a real
 * vendor's name. The other three methods delegate to whatever adapter is passed
 * as `fallback` — the fixture today, ATTOM or CoreLogic later — and the
 * capabilities object says exactly which half is real.
 */

import type { Address, AddressSuggestion } from "@hm/shared";
import type { PropertyDataConnector } from "../ports/index.js";

export interface GooglePlacesOptions {
  readonly apiKey: string;
  /** Serves everything Places cannot: assessor record, valuation, flood. */
  readonly fallback: PropertyDataConnector;
  /** Overridable so tests do not reach the network. */
  readonly fetchImpl?: typeof fetch;
}

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
    };
  }[];
}

interface PlaceDetails {
  addressComponents?: {
    longText?: string;
    shortText?: string;
    types?: string[];
  }[];
  formattedAddress?: string;
}

function component(details: PlaceDetails, type: string, short = false): string {
  const c = details.addressComponents?.find((x) => x.types?.includes(type));
  return (short ? c?.shortText : c?.longText) ?? "";
}

/**
 * Google returns components, not a mailing address. A US street address is
 * street_number + route, and either can be absent — a rural route has no
 * number, and a query that resolved to a locality has no route at all.
 */
function toAddress(details: PlaceDetails): Address | null {
  const number = component(details, "street_number");
  const route = component(details, "route");
  const city =
    component(details, "locality") ||
    component(details, "sublocality") ||
    component(details, "postal_town");
  const state = component(details, "administrative_area_level_1", true);
  const postalCode = component(details, "postal_code");

  // Without a street line, a city or a ZIP there is nothing a lender can
  // originate against, and a half-filled form is worse than no suggestion.
  if (!route || !city || !state || !postalCode) return null;

  return {
    line1: number ? `${number} ${route}` : route,
    city,
    state,
    postalCode,
  };
}

export function googlePlacesConnector(options: GooglePlacesOptions): PropertyDataConnector {
  const doFetch = options.fetchImpl ?? fetch;
  const { fallback } = options;

  async function details(placeId: string): Promise<PlaceDetails | null> {
    const res = await doFetch(`${DETAILS_URL}/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": options.apiKey,
        // Places charges by the field, so ask for the two we use and no more.
        "X-Goog-FieldMask": "addressComponents,formattedAddress",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as PlaceDetails;
  }

  return {
    capabilities: {
      provider: "google-places",
      mode: "production",
      // Autocomplete alone satisfies nothing in the sheet — APP-004 wants the
      // address matched to a public record, which is the assessor lookup, not
      // this. Claiming APP-004 here would be the adapter taking credit for the
      // fallback's work.
      satisfies: [],
    },

    async suggestAddresses(query: string): Promise<readonly AddressSuggestion[]> {
      const q = query.trim();
      if (q.length < 3) return [];

      let payload: AutocompleteResponse;
      try {
        const res = await doFetch(AUTOCOMPLETE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": options.apiKey },
          body: JSON.stringify({
            input: q,
            includedPrimaryTypes: ["street_address", "premise", "subpremise"],
            includedRegionCodes: ["us"],
          }),
        });
        if (!res.ok) return [];
        payload = (await res.json()) as AutocompleteResponse;
      } catch {
        // A dead autocomplete must not block the form. The borrower can still
        // type the address, and screen 1 keeps a manual path for exactly this.
        return [];
      }

      const predictions = (payload.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is { placeId?: string; text?: { text?: string } } => Boolean(p?.placeId))
        .slice(0, 5);

      const resolved = await Promise.all(
        predictions.map(async (p) => {
          const d = await details(p.placeId!).catch(() => null);
          if (!d) return null;
          const address = toAddress(d);
          if (!address) return null;
          return {
            id: p.placeId!,
            label: d.formattedAddress ?? p.text?.text ?? "",
            address,
          } satisfies AddressSuggestion;
        }),
      );

      return resolved.filter((x): x is AddressSuggestion => x !== null);
    },

    lookupRecord: (address: Address) => fallback.lookupRecord(address),
    estimateValue: (address: Address) => fallback.estimateValue(address),
    determineFlood: (address: Address) => fallback.determineFlood(address),
  };
}
