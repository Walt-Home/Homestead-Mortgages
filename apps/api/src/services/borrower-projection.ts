/**
 * A borrower's identity, read from the person.
 *
 * The `borrowers` row holds nothing that identifies anyone. Name, date of
 * birth, the SSN vault handle, contact details, address, marital status,
 * citizenship, language, military service and first-time-buyer status are
 * facts on the party, written by screen 2 and read here. There is no column
 * to fall back to — those came out once every row had been backfilled.
 *
 * So a missing or malformed REQUIRED fact is an invariant violation and is
 * loud: the projection throws, naming the borrower and the predicate, rather
 * than rendering a blank name and letting a screen carry on. Three fields
 * have defaults the old columns had — language "en", not military, first-time
 * buyer unknown — and take them when the fact is absent.
 *
 * What is NOT here, on purpose: rent, current housing and the HMDA
 * demographics. Rent is what they pay on THIS file, and the demographics are
 * collected per application by law. Those stay on the row.
 */

import type { Borrower } from "@hm/shared";

/** The live value of each predicate on one party. */
export type FactMap = ReadonlyMap<string, unknown>;

export class ProjectionError extends Error {
  constructor(
    readonly borrowerId: string,
    readonly predicate: string,
    detail: string,
  ) {
    super(`Borrower ${borrowerId} has no usable ${predicate} fact: ${detail}`);
    this.name = "ProjectionError";
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const MARITAL = new Set<string>(["married", "unmarried", "separated"]);
const CITIZENSHIP = new Set<string>(["us_citizen", "permanent_resident", "non_permanent_resident"]);

export interface Identity {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly ssnVaultHandle: string;
  readonly email: string;
  readonly phone: string;
  readonly currentAddress: Borrower["currentAddress"];
  readonly maritalStatus: Borrower["maritalStatus"];
  readonly citizenship: Borrower["citizenship"];
  readonly preferredLanguage: string;
  readonly isMilitary: boolean;
  readonly firstTimeHomebuyer: boolean | null;
}

/** The predicates a complete identity needs, in the order the screen asks them. */
const REQUIRED_PREDICATES = [
  "legal_name",
  "date_of_birth",
  "ssn_token",
  "email",
  "phone",
  "current_address",
  "marital_status",
  "citizenship",
] as const;

/**
 * Which required predicates a party has not stated yet.
 *
 * Empty for a person who has completed their profile. A co-borrower the
 * applicant has named holds a name and an email and nothing else, and the
 * projection lists them as invited rather than reading them through
 * `requireIdentity` — which is the right reader for an arrived person and the
 * wrong one for somebody who has not answered.
 */
export function identityMissing(facts: FactMap): string[] {
  return REQUIRED_PREDICATES.filter((predicate) => facts.get(predicate) == null);
}

/** The identity the party asserts, or a loud failure naming what is missing. */
export function requireIdentity(borrowerId: string, facts: FactMap): Identity {
  const need = (predicate: string, detail: string): never => {
    throw new ProjectionError(borrowerId, predicate, detail);
  };

  const name = obj(facts.get("legal_name")) ?? need("legal_name", "absent or not an object");
  const firstName = str(name.first) ?? need("legal_name", "no first name");
  const lastName = str(name.last) ?? need("legal_name", "no last name");

  const address =
    obj(facts.get("current_address")) ?? need("current_address", "absent or not an object");
  const currentAddress: Borrower["currentAddress"] = {
    line1: str(address.line1) ?? need("current_address", "no line1"),
    line2: str(address.line2),
    city: str(address.city) ?? need("current_address", "no city"),
    state: str(address.state) ?? need("current_address", "no state"),
    postalCode: str(address.postalCode) ?? need("current_address", "no postal code"),
  };

  const marital = str(facts.get("marital_status")) ?? need("marital_status", "absent");
  if (!MARITAL.has(marital)) need("marital_status", `unknown value ${JSON.stringify(marital)}`);
  const citizenship = str(facts.get("citizenship")) ?? need("citizenship", "absent");
  if (!CITIZENSHIP.has(citizenship))
    need("citizenship", `unknown value ${JSON.stringify(citizenship)}`);

  return {
    firstName,
    lastName,
    dateOfBirth: str(facts.get("date_of_birth")) ?? need("date_of_birth", "absent"),
    ssnVaultHandle: str(facts.get("ssn_token")) ?? need("ssn_token", "absent"),
    email: str(facts.get("email")) ?? need("email", "absent"),
    phone: str(facts.get("phone")) ?? need("phone", "absent"),
    currentAddress,
    maritalStatus: marital as Borrower["maritalStatus"],
    citizenship: citizenship as Borrower["citizenship"],
    preferredLanguage: str(facts.get("preferred_language")) ?? "en",
    isMilitary: bool(facts.get("is_military")) ?? false,
    firstTimeHomebuyer: bool(facts.get("first_time_homebuyer")) ?? null,
  };
}

/** Group live facts by party: partyId -> (predicate -> value). Latest observed wins. */
export function factMapsByParty(
  rows: readonly { partyId: string | null; predicate: string; value: unknown; observedAt: Date }[],
): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  const seenAt = new Map<string, Date>();
  for (const r of rows) {
    if (!r.partyId) continue;
    const key = `${r.partyId}:${r.predicate}`;
    const prev = seenAt.get(key);
    if (prev && prev.getTime() >= r.observedAt.getTime()) continue;
    seenAt.set(key, r.observedAt);
    let m = out.get(r.partyId);
    if (!m) {
      m = new Map();
      out.set(r.partyId, m);
    }
    m.set(r.predicate, r.value);
  }
  return out;
}

/** A display name from a party's live facts, for a list. Null when unknown. */
export function displayNameFrom(value: unknown): { firstName: string; lastName: string } | null {
  const name = obj(value);
  const firstName = name ? str(name.first) : undefined;
  const lastName = name ? str(name.last) : undefined;
  return firstName && lastName ? { firstName, lastName } : null;
}
