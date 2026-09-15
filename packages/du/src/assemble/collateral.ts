/**
 * The subject property, and the address every other address in the document is
 * shaped like.
 *
 * The REO twin's address lives here rather than in `assets.ts` for one reason:
 * an owned property that IS the subject stores no address of its own and is
 * rendered from this one, so the two renderings come from one function and
 * cannot drift into disagreement by accident. They can still disagree on
 * purpose — `DI-C04` emits "1234 Main St" under `OWNED_PROPERTY` against "1234
 * Main" under `COLLATERALS`, which is a borrower's REO record and a county's
 * subject record being two different strings about one house — and the whole
 * point of `du_owned_properties`' address columns is to hold that. Filling one
 * of the four fills all four, by
 * `du_owned_properties_subject_override_is_whole`.
 *
 * The two destinations carry different maximum lengths — `String 35` at 3a.2.1
 * under `OWNED_PROPERTY`, `String 50` at 4a.3.1 under `COLLATERALS` — which is
 * why nothing here compares the two renderings: a legal 41-character street
 * line makes them unequal by construction.
 */

import type { Occupancy, Prisma } from "@hm/db";
import { compact, container, leaf, type DuNode } from "../document.js";
import { renderAmount } from "../values.js";
import type { LoadedApplication } from "./load.js";

/** The five lines an address is, in whatever container holds it. */
export interface AddressFields {
  readonly addressLineText: string | null;
  readonly addressUnit?: string | null;
  readonly cityName: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly countryCode?: string | null;
}

/**
 * An `ADDRESS`, or nothing when no line of it is known.
 *
 * `CountryCode` is optional and present on three of `DI-C02`'s REO addresses
 * and on none of its subject property, which is the corpus saying the element
 * is per-address rather than per-document.
 */
export function addressNode(fields: AddressFields): DuNode | null {
  return container("ADDRESS", [
    leaf("AddressLineText", fields.addressLineText),
    leaf("AddressUnitIdentifier", fields.addressUnit ?? null),
    leaf("CityName", fields.cityName),
    leaf("CountryCode", fields.countryCode ?? null),
    leaf("PostalCode", fields.postalCode),
    leaf("StateCode", fields.stateCode),
  ]);
}

/**
 * How the subject property is to be used, from the scenario rather than from
 * `loan_files.occupancy`.
 *
 * The scenario's column is the typed one; the file's is free text that predates
 * it. Exhaustive, and it throws on a value the enum grows rather than emitting
 * a word MISMO does not have.
 */
const PROPERTY_USAGE: Readonly<Record<Occupancy, string>> = {
  PRIMARY_RESIDENCE: "PrimaryResidence",
  SECOND_HOME: "SecondHome",
  INVESTMENT: "Investment",
};

export function propertyUsageType(occupancy: Occupancy): string {
  const usage = PROPERTY_USAGE[occupancy];
  if (!usage) throw new Error(`No PropertyUsageType for occupancy ${occupancy}.`);
  return usage;
}

/**
 * A `Decimal(14,2)` column as cents, without going through a double.
 *
 * `toFixed(2)` is exact for a column that holds two decimal places, and
 * removing the point is the whole conversion. `Number(value) * 100` is the
 * version that turns 420,000.00 into 41,999,999.99 cents once in a while.
 */
export function centsFromDecimal(value: Prisma.Decimal | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(value.toFixed(2).replace(".", ""));
}

/** The subject property's address, which the REO twin borrows when it stores none. */
export function subjectAddressFields(application: LoadedApplication): AddressFields {
  const file = application.loanFile;
  return {
    addressLineText: file.propertyLine1,
    addressUnit: file.propertyLine2,
    cityName: file.propertyCity,
    stateCode: file.propertyState,
    postalCode: file.propertyPostalCode,
  };
}

export function buildCollaterals(application: LoadedApplication): DuNode | null {
  const scenario = application.scenarios[0];
  const estimatedValue =
    scenario?.valueEstimateCents ?? centsFromDecimal(application.loanFile.valueOrPrice);

  const subject = container("SUBJECT_PROPERTY", [
    addressNode(subjectAddressFields(application)),
    container(
      "PROPERTY_DETAIL",
      compact([
        estimatedValue === null || estimatedValue === undefined
          ? null
          : leaf("PropertyEstimatedValueAmount", renderAmount(estimatedValue)),
        scenario ? leaf("PropertyUsageType", propertyUsageType(scenario.occupancy)) : null,
      ]),
    ),
  ]);

  return container("COLLATERALS", [container("COLLATERAL", [subject])]);
}
