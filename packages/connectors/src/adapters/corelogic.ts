/**
 * The county record and the valuation, from CoreLogic's Property API (v2, at
 * Cotality, which is what CoreLogic is called now).
 *
 * The second real adapter behind `PropertyDataConnector`, and the one that
 * makes screen 1's property card a fact rather than a fixture. It implements
 * three of the four methods — autocomplete, the assessor record and the AVM —
 * and delegates the fourth. The Property API carries no flood determination:
 * that is a separate CoreLogic product, and on a federally related mortgage
 * it has to be a certified determination rather than a map read, so
 * `determineFlood` goes to whatever adapter is passed as `fallback` and the
 * capabilities object says exactly which parts are real.
 *
 * Address-keyed and unguarded, like the fixture it replaces: screen 1 runs
 * before anybody has authorized anything, and nothing here is about a person.
 *
 * ── How the API is shaped, and how this adapter uses it ────────────────────
 *
 *   1. **One bearer token for everything.** `POST /oauth/token` with the
 *      client key and secret as HTTP Basic and `grant_type=client_credentials`
 *      answers `{ access_token, expires_in }`; every data call carries it as
 *      a bearer. The token is cached until a minute before it expires, and a
 *      401 from a data call refreshes it once and retries — the guide says a
 *      client may do either, and doing both means a token revoked early does
 *      not take the screen down.
 *   2. **An address becomes a CLIP.** `GET /v2/properties/search` with the
 *      street, city, state and ZIP and `bestMatch=true` answers at most one
 *      property, whose `clip` is the key to everything else. Nothing found is
 *      `AddressNotFoundError`, which the route already turns into the manual
 *      path. The CLIP is memoized per address, because the route asks for the
 *      record, the valuation and the flood zone in parallel and three searches
 *      for one address would be three billable requests for one answer.
 *   3. **The record is one call.** `GET /v2/properties/{clip}/property-detail`
 *      bundles the buildings, the ownership, the site (land use, legal
 *      description, lot), the latest tax assessment and the last market sale.
 *      `GET .../home-owners-association` is a second call for whether an
 *      association exists; it carries no dues, so `monthlyAssociationDues`
 *      stays unset and the screen keeps asking.
 *   4. **The valuation is one call.** `GET .../avm/thv/thvOriginations/summary`
 *      — the originations model, because that is what this is — answers the
 *      estimate, the range, a confidence score and a forecast standard
 *      deviation.
 *
 * ── What is mapped by rule, and what is refused ────────────────────────────
 *
 * The property type and whether the dwelling is attached come off CoreLogic's
 * land-use description by keyword, and a description this file cannot place
 * is refused as `PropertyNotDescribableError` — a subclass of
 * `AddressNotFoundError`, so the borrower gets the manual path rather than a
 * property card carrying a guessed `Detached` on a federal submission. The
 * refusal names the land-use code and nothing about the borrower.
 *
 * Two fields the county does not know. `priorOwnershipInLastThreeYears` is a
 * fact about the borrower, not the parcel, and the fixture's answer was the
 * persona's; a real record answers null, and screen 2 stops deriving the
 * first-time-homebuyer answer from it. And a numeric the county did not
 * report — a bedroom count, a lot size — is zero here rather than invented,
 * and the card leaves a zero out.
 *
 * The trial account is limited to 100 property requests and 25 AVM requests
 * a day. A property lookup is three requests and a valuation is one, on top
 * of the shared search.
 */

import type {
  Address,
  AddressSuggestion,
  AvmEstimate,
  FloodDetermination,
  PropertyRecord,
  PropertyType,
} from "@hm/shared";
import {
  AddressNotFoundError,
  type ConnectorResult,
  type PropertyDataConnector,
} from "../ports/index.js";

export type CoreLogicAvmModel =
  "thvConsumers" | "thvOriginations" | "thvMarketing" | "thvRiskManagement";

export interface CoreLogicOptions {
  /** The client key and secret from the developer portal's API Keys page. */
  readonly clientKey: string;
  readonly clientSecret: string;
  /**
   * Where the API lives. The v2 specification names `api1.cotality.com`; the
   * older guide names `api-prod.corelogic.com`. The token endpoint hangs off
   * the same host.
   */
  readonly baseUrl?: string;
  /** Serves what this API does not carry: the flood determination. */
  readonly fallback: PropertyDataConnector;
  /** Overridable so tests do not reach the network. */
  readonly fetchImpl?: typeof fetch;
  /** Overridable so tests can move the clock past a token's expiry. */
  readonly now?: () => Date;
  readonly avmModel?: CoreLogicAvmModel;
}

export const CORELOGIC_DEFAULT_BASE_URL = "https://api1.cotality.com";

/** A property the API answered for, whose land use this adapter cannot place. */
export class PropertyNotDescribableError extends AddressNotFoundError {
  constructor(
    address: string,
    readonly landUseCode: string | null,
    readonly landUseDescription: string | null,
  ) {
    super(address);
    this.name = "PropertyNotDescribableError";
    this.message =
      `The county record for ${address} describes a land use this system does not map ` +
      `(${landUseCode ?? "no code"}: ${landUseDescription ?? "no description"}), so the ` +
      "property is entered by hand rather than described from a guess.";
  }
}

/** The API answered something other than 200 and 404. */
export class CoreLogicError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CoreLogicError";
  }
}

/* ── The shapes read off the wire. Only the fields this adapter reads. ───── */

interface SearchResponse {
  items?: {
    clip?: string;
    propertyAddress?: { county?: string };
    propertyAPN?: {
      apnParcelNumberFormatted?: string;
      apnParcelNumberUnformatted?: string;
    };
    addressMatchInformation?: { propertyMatchScore?: number };
  }[];
}

interface Building {
  constructionDetails?: { yearBuilt?: number | null; effectiveYearBuilt?: number | null };
  interiorArea?: { universalBuildingAreaSquareFeet?: number | null };
}

interface PropertyDetailResponse {
  buildings?: {
    data?: {
      allBuildingsSummary?: {
        unitsCount?: number | null;
        bedroomsCount?: number | null;
        bathroomsCount?: number | null;
        livingAreaSquareFeet?: number | null;
        totalAreaSquareFeet?: number | null;
      };
      Buildings?: Building[];
    };
  };
  ownership?: {
    data?: { currentOwners?: { ownerNames?: { fullName?: string | null }[] } };
  };
  siteLocation?: {
    data?: {
      locationLegal?: { description?: string | null };
      landUseAndZoningCodes?: {
        propertyTypeCode?: string | null;
        propertyTypeCodeDescription?: string | null;
        landUseCode?: string | null;
        landUseCodeDescription?: string | null;
        countyLandUseDescription?: string | null;
        isManufacturedHome?: string | null;
      };
      lot?: { areaSquareFeet?: number | null; areaAcres?: number | null };
    };
  };
  taxAssessment?: {
    items?: {
      taxAmount?: { totalTaxAmount?: number | null; netTaxAmount?: number | null };
      assessedValue?: { calculatedTotalValue?: number | null; taxableValue?: number | null };
    }[];
  };
  lastMarketSale?: {
    items?: {
      transactionDetails?: { saleDateDerived?: string | null; saleAmount?: number | null };
      propertyDetails?: { actualYearBuilt?: number | null };
    }[];
  };
}

interface HoaResponse {
  items?: { homeOwnersAssociation?: unknown[] }[];
}

interface AvmSummaryResponse {
  summary?: {
    estimatedValue?: number | null;
    lowValue?: number | null;
    highValue?: number | null;
    processedDate?: string | null;
    forecastStandardDeviation?: number | null;
    confidenceScore?: number | null;
  };
}

interface TypeaheadResponse {
  results?: {
    clip?: string;
    address?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    zip?: string;
  }[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: string | number;
}

/* ── Mapping rules ──────────────────────────────────────────────────────── */

/**
 * CoreLogic's land use, as this product's property type and attachment.
 *
 * By keyword over the descriptions rather than by the numeric code, because
 * the codes are a county-by-county conversion and the descriptions are what
 * the specification defines them by. The land-use description is the finer
 * of the two and is read first; the property-type code groups classes — its
 * code 10 reads "Single Family Residence / Townhouse" — so it is read only
 * when the land use says nothing, and a grouped text that fits two classes is
 * ambiguous rather than the first one that matched. Anything that does not
 * match is refused upstream, not defaulted here.
 */
export function classifyLandUse(site: {
  readonly propertyTypeCodeDescription?: string | null;
  readonly landUseCodeDescription?: string | null;
  readonly countyLandUseDescription?: string | null;
  readonly isManufacturedHome?: string | null;
}): { propertyType: PropertyType; attachment: PropertyRecord["attachment"] } | null {
  const upper = (...parts: (string | null | undefined)[]): string =>
    parts
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" | ")
      .toUpperCase();
  if (site.isManufacturedHome === "Y") {
    return { propertyType: "manufactured", attachment: "detached" };
  }
  return (
    classifyText(upper(site.landUseCodeDescription, site.countyLandUseDescription)) ??
    classifyText(upper(site.propertyTypeCodeDescription))
  );
}

type Placed = { propertyType: PropertyType; attachment: PropertyRecord["attachment"] };

function classifyText(text: string): Placed | null {
  if (text === "") return null;
  const matches: Placed[] = [];
  if (/MOBILE|MANUFACTURED/.test(text)) {
    matches.push({ propertyType: "manufactured", attachment: "detached" });
  }
  if (/CO-?OP(ERATIVE)?\b/.test(text))
    matches.push({ propertyType: "co_op", attachment: "attached" });
  if (/CONDO/.test(text)) matches.push({ propertyType: "condo", attachment: "attached" });
  if (/TOWN ?(HOUSE|HOME)|ROW ?HOUSE|ZERO LOT/.test(text)) {
    matches.push({ propertyType: "townhouse", attachment: "attached" });
  }
  if (/DUPLEX|TRIPLEX|QUADR?U?PLEX|FOUR ?PLEX|2-4 UNIT|TWO TO FOUR|MULTI-?FAMILY/.test(text)) {
    matches.push({ propertyType: "two_to_four_unit", attachment: "detached" });
  }
  if (/SINGLE FAMILY|\bSFR\b|\bPUD\b|PLANNED UNIT|RESIDENTIAL/.test(text)) {
    matches.push({
      propertyType: "single_family",
      attachment:
        /ATTACHED|COMMON WALL/.test(text) && !/DETACHED/.test(text) ? "attached" : "detached",
    });
  }
  // A description that groups classes — "SINGLE FAMILY RESIDENCE / TOWNHOUSE"
  // — and fits more than one of them is ambiguous, whichever it fits.
  // Otherwise "RESIDENTIAL" rides along with every finer class: drop it when
  // a finer one matched, and call two finer classes in one description
  // ambiguous.
  if (/\/| OR |,/.test(text) && matches.length > 1) return null;
  const finer = matches.filter((m) => m.propertyType !== "single_family");
  if (finer.length === 1) return finer[0]!;
  if (finer.length > 1) return null;
  return matches[0] ?? null;
}

/** A number the county reported, or zero where it reported nothing. */
const reported = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** The first of several places a figure can be reported, or zero. */
const firstReported = (...values: (number | null | undefined)[]): number =>
  reported(values.find((v) => typeof v === "number" && Number.isFinite(v) && v > 0));

/** An ISO calendar day from whatever date spelling the API used, or null. */
function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * The AVM's confidence on this product's 0–100 scale. The summary carries a
 * `confidenceScore`; where it is absent the forecast standard deviation is
 * the same fact the other way round (a 10% FSD is a 90% confidence).
 */
export function avmConfidence(summary: {
  readonly confidenceScore?: number | null;
  readonly forecastStandardDeviation?: number | null;
}): number {
  const score = summary.confidenceScore;
  if (typeof score === "number" && Number.isFinite(score)) {
    return Math.round(score <= 1 ? score * 100 : score);
  }
  const fsd = summary.forecastStandardDeviation;
  if (typeof fsd === "number" && Number.isFinite(fsd)) {
    return Math.max(0, Math.min(100, Math.round((1 - (fsd <= 1 ? fsd : fsd / 100)) * 100)));
  }
  return 0;
}

function oneLine(address: Address): string {
  const street = address.line2 ? `${address.line1}, ${address.line2}` : address.line1;
  return `${street}, ${address.city}, ${address.state} ${address.postalCode}`;
}

/* ── The adapter ────────────────────────────────────────────────────────── */

export function coreLogicConnector(options: CoreLogicOptions): PropertyDataConnector {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = (options.baseUrl ?? CORELOGIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model: CoreLogicAvmModel = options.avmModel ?? "thvOriginations";
  const { fallback } = options;

  let token: { value: string; expiresAt: number } | null = null;

  async function freshToken(): Promise<string> {
    const basic = Buffer.from(`${options.clientKey}:${options.clientSecret}`, "utf8").toString(
      "base64",
    );
    const res = await doFetch(`${base}/oauth/token?grant_type=client_credentials`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-length": "0" },
    });
    if (!res.ok) {
      throw new CoreLogicError(
        `CoreLogic refused the client credentials (${res.status}). The key and secret are ` +
          "read from CORELOGIC_CLIENT_KEY and CORELOGIC_CLIENT_SECRET; neither is repeated here.",
        res.status,
      );
    }
    const body = (await res.json()) as TokenResponse;
    if (!body.access_token) {
      throw new CoreLogicError("CoreLogic answered the token request without a token.", 200);
    }
    const seconds = Number(body.expires_in ?? 0);
    token = {
      value: body.access_token,
      // A minute early, so a token used at the edge of its life is not one
      // the next call finds expired.
      expiresAt: now().getTime() + Math.max(0, seconds - 60) * 1000,
    };
    return token.value;
  }

  async function bearer(): Promise<string> {
    if (token && token.expiresAt > now().getTime()) return token.value;
    return freshToken();
  }

  /**
   * A data call, with the one retry the guide allows for: a 401 means the
   * token died early, so it is replaced once and the call made again. Answers
   * null on 404 so a caller can say what "nothing" means for its endpoint.
   */
  async function get<T>(path: string, retried = false): Promise<T | null> {
    const res = await doFetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${await bearer()}`, accept: "application/json" },
    });
    if (res.status === 401 && !retried) {
      token = null;
      return get<T>(path, true);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new CoreLogicError(
        `CoreLogic answered ${res.status} at ${path.split("?")[0]}. The body is not repeated ` +
          "here: a property record names its owner.",
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  // The CLIP for an address, looked up once however many of the three
  // methods ask. Bounded so a long-running process does not keep every
  // address it ever saw.
  const clips = new Map<string, Promise<Found>>();
  interface Found {
    readonly clip: string;
    readonly county: string;
    readonly apn: string;
  }
  function found(address: Address): Promise<Found> {
    const key = oneLine(address).toUpperCase();
    const cached = clips.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<Found> => {
      const params = new URLSearchParams({
        streetAddress: address.line2 ? `${address.line1} ${address.line2}` : address.line1,
        city: address.city,
        state: address.state,
        zipCode: address.postalCode.slice(0, 5),
        bestMatch: "true",
      });
      const res = await get<SearchResponse>(`/v2/properties/search?${params.toString()}`);
      const item = res?.items?.[0];
      if (!item?.clip) throw new AddressNotFoundError(oneLine(address));
      return {
        clip: item.clip,
        county: item.propertyAddress?.county ?? "",
        apn:
          item.propertyAPN?.apnParcelNumberFormatted ??
          item.propertyAPN?.apnParcelNumberUnformatted ??
          "",
      };
    })();
    // A failed search is not kept: the next attempt asks again.
    pending.catch(() => clips.delete(key));
    if (clips.size >= 200) clips.delete(clips.keys().next().value!);
    clips.set(key, pending);
    return pending;
  }

  return {
    capabilities: {
      provider: "corelogic",
      mode: "production",
      // APP-004 is the address matched to a public record, which is exactly
      // what the search and the record do. The flood determination is the
      // fallback's to claim.
      satisfies: ["APP-004"],
    },

    async suggestAddresses(query: string): Promise<readonly AddressSuggestion[]> {
      const q = query.trim();
      if (q.length < 3) return [];
      let res: TypeaheadResponse | null;
      try {
        res = await get<TypeaheadResponse>(
          `/v2/properties/typeahead?${new URLSearchParams({ input: q }).toString()}`,
        );
      } catch {
        // A dead autocomplete must not block the form; screen 1 keeps a
        // manual path for exactly this.
        return [];
      }
      return (res?.results ?? [])
        .filter((r) => r.clip && r.addressLine1 && r.city && r.state && r.zip)
        .slice(0, 5)
        .map((r) => ({
          id: r.clip!,
          label: r.address ?? `${r.addressLine1}, ${r.city}, ${r.state} ${r.zip}`,
          address: {
            line1: r.addressLine1!,
            city: r.city!,
            state: r.state!,
            postalCode: r.zip!.slice(0, 5),
          },
        }));
    },

    async lookupRecord(address: Address): Promise<ConnectorResult<PropertyRecord>> {
      const { clip, county, apn } = await found(address);
      const [detail, hoa] = await Promise.all([
        get<PropertyDetailResponse>(`/v2/properties/${encodeURIComponent(clip)}/property-detail`),
        get<HoaResponse>(`/v2/properties/${encodeURIComponent(clip)}/home-owners-association`),
      ]);
      if (!detail) throw new AddressNotFoundError(oneLine(address));

      const site = detail.siteLocation?.data;
      const landUse = site?.landUseAndZoningCodes ?? {};
      const kind = classifyLandUse(landUse);
      if (!kind) {
        throw new PropertyNotDescribableError(
          oneLine(address),
          landUse.landUseCode ?? null,
          landUse.landUseCodeDescription ?? landUse.propertyTypeCodeDescription ?? null,
        );
      }

      const summary = detail.buildings?.data?.allBuildingsSummary ?? {};
      const building = detail.buildings?.data?.Buildings?.[0];
      const tax = detail.taxAssessment?.items?.[0];
      const sale = detail.lastMarketSale?.items?.[0];
      const owners = (detail.ownership?.data?.currentOwners?.ownerNames ?? [])
        .map((o) => o.fullName?.trim())
        .filter((name): name is string => Boolean(name));
      const soldOn = isoDay(sale?.transactionDetails?.saleDateDerived);
      const salePrice = sale?.transactionDetails?.saleAmount;

      const units = kind.propertyType === "two_to_four_unit" ? reported(summary.unitsCount) : 1;

      const record: PropertyRecord = {
        apn,
        county,
        legalDescription: site?.locationLegal?.description ?? "",
        propertyType: kind.propertyType,
        units: units >= 1 ? units : 1,
        attachment: kind.attachment,
        yearBuilt: firstReported(
          building?.constructionDetails?.yearBuilt,
          building?.constructionDetails?.effectiveYearBuilt,
          sale?.propertyDetails?.actualYearBuilt,
        ),
        squareFeet: firstReported(
          summary.livingAreaSquareFeet,
          building?.interiorArea?.universalBuildingAreaSquareFeet,
          summary.totalAreaSquareFeet,
        ),
        bedrooms: reported(summary.bedroomsCount),
        bathrooms: reported(summary.bathroomsCount),
        lotSizeSqFt: firstReported(
          site?.lot?.areaSquareFeet,
          site?.lot?.areaAcres ? Math.round(site.lot.areaAcres * 43_560) : null,
        ),
        assessedValue: firstReported(
          tax?.assessedValue?.calculatedTotalValue,
          tax?.assessedValue?.taxableValue,
        ),
        annualPropertyTax: firstReported(
          tax?.taxAmount?.totalTaxAmount,
          tax?.taxAmount?.netTaxAmount,
        ),
        // The HOA product says whether an association is on record and
        // nothing about what it charges; a 404 is no record at all.
        hoaExists: (hoa?.items?.[0]?.homeOwnersAssociation?.length ?? 0) > 0,
        ownerOfRecord: owners.join(" & "),
        ...(soldOn && typeof salePrice === "number" && salePrice > 0
          ? { lastSale: { soldOn, price: salePrice } }
          : {}),
        // A fact about the borrower, which a parcel record cannot carry.
        priorOwnershipInLastThreeYears: null,
      };
      return {
        data: record,
        provider: "corelogic",
        retrievedAt: now().toISOString(),
        externalId: `clip-${clip}`,
      };
    },

    async estimateValue(address: Address): Promise<ConnectorResult<AvmEstimate>> {
      const { clip } = await found(address);
      const res = await get<AvmSummaryResponse>(
        `/v2/properties/${encodeURIComponent(clip)}/avm/thv/${model}/summary`,
      );
      const summary = res?.summary;
      if (!summary || typeof summary.estimatedValue !== "number") {
        throw new AddressNotFoundError(oneLine(address));
      }
      const value = summary.estimatedValue;
      return {
        data: {
          value,
          low: reported(summary.lowValue) || value,
          high: reported(summary.highValue) || value,
          confidence: avmConfidence(summary),
          asOf: isoDay(summary.processedDate) ?? now().toISOString().slice(0, 10),
        },
        provider: `corelogic-${model}`,
        retrievedAt: now().toISOString(),
        externalId: `avm-${clip}-${model}`,
      };
    },

    determineFlood: (address: Address): Promise<ConnectorResult<FloodDetermination>> =>
      fallback.determineFlood(address),
  };
}
