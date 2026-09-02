/**
 * Public-record fixtures — what the county, FEMA, the watchlists and the
 * recorder's office say about each persona.
 *
 * Kept beside `personas.ts` rather than inside it. The three persona literals
 * describe a *borrower's financial life*; this file describes facts held about
 * a property and a name by third parties who were never asked. They are
 * retrieved by different adapters, on different screens, under different
 * authorization rules — the property lookups run unguarded on screen 1, the
 * screening and lien search run guarded on screen 2 — and a reader tracing
 * "why does screen 1 know the year built" should land in one file, not in the
 * middle of a credit report.
 *
 * Keyed by `PersonaId`, so `Record` makes an omission a compile error the same
 * way the persona registry does.
 *
 * Each persona is built to exercise a different branch of the new flow:
 *   clean_w2         — everything clean, nothing to ask on screen 4
 *   thin_file_renter — a condo, so HOA dues exist and PITIA has an A
 *   variable_income  — a flood zone, a junior lien, and a delinquent federal
 *                      debt, which is the one case where screen 4 has to turn
 *                      a derived declaration back into a question
 */

import type {
  Address,
  AvmEstimate,
  FloodDetermination,
  IdentityVerification,
  LienSearch,
  PropertyRecord,
  SanctionsScreening,
} from "@hm/shared";
import type { PersonaId } from "./personas.js";

export interface PublicRecordFixture {
  readonly address: Address;
  readonly record: PropertyRecord;
  readonly avm: (ref: Date) => AvmEstimate;
  readonly flood: (ref: Date) => FloodDetermination;
  readonly sanctions: (ref: Date) => SanctionsScreening;
  readonly liens: (ref: Date) => LienSearch;
  readonly identity: (ref: Date) => IdentityVerification;
}

/** ISO date `years` before the reference date. */
function yearsBefore(ref: Date, years: number): string {
  const d = new Date(ref);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const OFAC_LISTS = ["OFAC SDN", "OFAC Consolidated", "FinCEN 314(a)"] as const;

/* ── clean_w2 · Dana Whitfield, Austin TX ───────────────────────────────── */
// Nothing to surface. Screen 4 shows five green lines and asks no questions,
// which is the case the whole redesign is built around.

const cleanW2: PublicRecordFixture = {
  address: {
    line1: "1247 Oak Street",
    city: "Austin",
    state: "TX",
    postalCode: "78704",
  },
  record: {
    apn: "0114230209",
    county: "Travis",
    legalDescription: "LOT 14 BLK C TRAVIS HEIGHTS ANNEX",
    propertyType: "single_family",
    units: 1,
    yearBuilt: 1962,
    squareFeet: 1_840,
    bedrooms: 3,
    bathrooms: 2,
    lotSizeSqFt: 7_405,
    assessedValue: 389_000,
    // Travis County's real effective rate is roughly double the 1.1% national
    // average `calculations.ts` assumes. The number arriving here is the whole
    // point of the lookup.
    annualPropertyTax: 8_216,
    hoaExists: false,
    ownerOfRecord: "WHITFIELD, DANA M",
    lastSale: { soldOn: yearsBefore(new Date(), 9), price: 268_000 },
    priorOwnershipInLastThreeYears: false,
  },
  avm: (ref) => ({
    value: 412_000,
    low: 394_000,
    high: 430_000,
    confidence: 88,
    asOf: ref.toISOString().slice(0, 10),
  }),
  flood: (ref) => ({
    zone: "X",
    communityId: "480624",
    inSpecialFloodHazardArea: false,
    nfipParticipating: true,
    insuranceRequired: false,
    determinedOn: ref.toISOString().slice(0, 10),
  }),
  sanctions: (ref) => ({
    clear: true,
    matches: [],
    listsChecked: [...OFAC_LISTS],
    screenedAt: ref.toISOString(),
  }),
  liens: (ref) => ({
    apn: "0114230209",
    liens: [],
    delinquentFederalDebt: false,
    foreclosureOrShortSaleInHistory: false,
    searchedAt: ref.toISOString(),
  }),
  identity: (ref) => ({
    documentType: "drivers_license",
    documentExpiresOn: yearsBefore(ref, -4),
    firstName: "Dana",
    lastName: "Whitfield",
    dateOfBirth: yearsBefore(ref, 37),
    address: { line1: "88 Foster Lane", city: "Austin", state: "TX", postalCode: "78745" },
    selfieLiveness: 96,
    documentAuthentic: true,
    verifiedAt: ref.toISOString(),
  }),
};

/* ── thin_file_renter · Marcus Adeyemi, Atlanta GA ──────────────────────── */
// A condo, so association dues exist. Omitting them understates PITIA for
// exactly the borrower whose DTI is tightest — the error `docs/decisions.md`
// records as already having been made once.

const thinFileRenter: PublicRecordFixture = {
  address: {
    line1: "540 Ponce De Leon Ave NE",
    line2: "Unit 312",
    city: "Atlanta",
    state: "GA",
    postalCode: "30308",
  },
  record: {
    apn: "14-0049-0006-072-1",
    county: "Fulton",
    legalDescription: "UNIT 312 PONCE MIDTOWN CONDOMINIUM",
    propertyType: "condo",
    units: 1,
    yearBuilt: 2006,
    squareFeet: 1_120,
    bedrooms: 2,
    bathrooms: 2,
    lotSizeSqFt: 0,
    assessedValue: 291_500,
    annualPropertyTax: 3_402,
    hoaExists: true,
    monthlyAssociationDues: 385,
    ownerOfRecord: "PONCE MIDTOWN HOLDINGS LLC",
    lastSale: { soldOn: yearsBefore(new Date(), 4), price: 262_000 },
    priorOwnershipInLastThreeYears: false,
  },
  avm: (ref) => ({
    value: 297_500,
    low: 279_000,
    high: 316_000,
    confidence: 74,
    asOf: ref.toISOString().slice(0, 10),
  }),
  flood: (ref) => ({
    zone: "X",
    communityId: "130059",
    inSpecialFloodHazardArea: false,
    nfipParticipating: true,
    insuranceRequired: false,
    determinedOn: ref.toISOString().slice(0, 10),
  }),
  sanctions: (ref) => ({
    clear: true,
    matches: [],
    listsChecked: [...OFAC_LISTS],
    screenedAt: ref.toISOString(),
  }),
  liens: (ref) => ({
    apn: "14-0049-0006-072-1",
    liens: [],
    delinquentFederalDebt: false,
    foreclosureOrShortSaleInHistory: false,
    searchedAt: ref.toISOString(),
  }),
  identity: (ref) => ({
    documentType: "drivers_license",
    documentExpiresOn: yearsBefore(ref, -2),
    firstName: "Marcus",
    lastName: "Adeyemi",
    dateOfBirth: yearsBefore(ref, 29),
    address: { line1: "1904 Briarcliff Rd NE", city: "Atlanta", state: "GA", postalCode: "30329" },
    selfieLiveness: 93,
    documentAuthentic: true,
    verifiedAt: ref.toISOString(),
  }),
};

/* ── variable_income · Priya Raman, San Jose CA ─────────────────────────── */
// The interesting one. A Special Flood Hazard Area, a HELOC behind the
// subject, and a delinquent federal debt — which is the single case where a
// derived declaration comes back positive and screen 4 must ask about that
// one item and stay silent about the other four.

const variableIncome: PublicRecordFixture = {
  address: {
    line1: "1247 Oak Street",
    city: "San Jose",
    state: "CA",
    postalCode: "95125",
  },
  record: {
    apn: "439-28-014",
    county: "Santa Clara",
    legalDescription: "LOT 27 TRACT 1184 WILLOW GLEN MANOR",
    propertyType: "single_family",
    units: 1,
    yearBuilt: 1962,
    squareFeet: 1_840,
    bedrooms: 3,
    bathrooms: 2,
    lotSizeSqFt: 6_098,
    assessedValue: 398_400,
    // Proposition 13 keeps the assessed value far below market, which is why
    // a tax figure derived from the AVM would be badly wrong here and the
    // assessor's own number is the one worth having.
    annualPropertyTax: 5_182,
    hoaExists: false,
    ownerOfRecord: "RAMAN, PRIYA",
    lastSale: { soldOn: yearsBefore(new Date(), 6), price: 352_000 },
    priorOwnershipInLastThreeYears: false,
  },
  avm: (ref) => ({
    value: 418_500,
    low: 388_000,
    high: 449_000,
    confidence: 71,
    asOf: ref.toISOString().slice(0, 10),
  }),
  flood: (ref) => ({
    zone: "AE",
    communityId: "060349",
    inSpecialFloodHazardArea: true,
    nfipParticipating: true,
    // Mandatory on a federally related mortgage in an SFHA. Recorded rather
    // than inferred at render time, so the reason survives into the file.
    insuranceRequired: true,
    determinedOn: ref.toISOString().slice(0, 10),
  }),
  sanctions: (ref) => ({
    // Clear, but not silently. A weak name similarity is worth recording and
    // not worth stopping a file over — collapsing "screened, scored 41" into
    // "screened, nothing found" throws away the only evidence that the screen
    // ran against this particular name.
    clear: true,
    matches: [{ listName: "OFAC Consolidated", matchedName: "P. RAMANN", score: 41 }],
    listsChecked: [...OFAC_LISTS],
    screenedAt: ref.toISOString(),
  }),
  liens: (ref) => ({
    apn: "439-28-014",
    liens: [
      {
        kind: "heloc",
        holder: "Bay Federal Credit Union",
        recordedOn: yearsBefore(ref, 3),
        amount: 42_000,
        position: 2,
        released: false,
      },
      {
        kind: "federal_debt",
        holder: "U.S. Department of Education",
        recordedOn: yearsBefore(ref, 1),
        amount: 3_180,
        released: false,
      },
    ],
    delinquentFederalDebt: true,
    foreclosureOrShortSaleInHistory: false,
    searchedAt: ref.toISOString(),
  }),
  identity: (ref) => ({
    documentType: "drivers_license",
    documentExpiresOn: yearsBefore(ref, -3),
    firstName: "Priya",
    lastName: "Raman",
    dateOfBirth: yearsBefore(ref, 34),
    address: { line1: "2201 The Alameda", city: "San Jose", state: "CA", postalCode: "95126" },
    selfieLiveness: 91,
    documentAuthentic: true,
    verifiedAt: ref.toISOString(),
  }),
};

export const PUBLIC_RECORDS: Record<PersonaId, PublicRecordFixture> = {
  clean_w2: cleanW2,
  thin_file_renter: thinFileRenter,
  variable_income: variableIncome,
};

/**
 * Autocomplete candidates.
 *
 * Exactly the three addresses we hold records for, and no decoys.
 *
 * An earlier version padded this list so the dropdown would not be a list of
 * three. That was a mistake: a suggestion the borrower can select and we
 * cannot then describe is worse than a short list, because the failure lands
 * *after* they have committed to an address rather than while they are still
 * typing. Every entry here resolves to a full record, an AVM and a flood
 * determination.
 */
export const ADDRESS_BOOK: readonly Address[] = [
  cleanW2.address,
  thinFileRenter.address,
  variableIncome.address,
];
