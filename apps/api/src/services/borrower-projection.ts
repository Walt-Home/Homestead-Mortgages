/**
 * A borrower, read from the person rather than from the row.
 *
 * The strangler's second move. Screen 2 has been writing every identity field
 * both ways — a column on `borrowers` and a fact on the party — since the
 * bridge landed. This is where a screen starts READING the fact. It happens in
 * the projection, because `loadLoanFile` is the one place the domain LoanFile
 * is assembled, so every screen gets the fact-backed value and no component
 * changes.
 *
 * Only the fields that are about the PERSON flip. A legal name, a date of
 * birth, a citizenship are the same on every application somebody makes. What
 * they pay in rent, whether they are a first-time buyer on THIS purchase, and
 * the HMDA demographics — which the law collects per application — stay on
 * the row, because they can legitimately differ from one file to the next.
 *
 * Every read falls back to the column when the fact is absent or malformed.
 * A projection must never fail because a fact has an unexpected shape; it
 * shows what the row says, which is what it showed yesterday.
 */

import type { Borrower } from "@hm/shared";

/** The live value of each predicate on one party. */
export type FactMap = ReadonlyMap<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The identity fields of a borrower, as the party asserts them. */
export interface IdentityFromFacts {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly dateOfBirth?: string;
  readonly ssnVaultHandle?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly currentAddress?: Borrower["currentAddress"];
  readonly maritalStatus?: Borrower["maritalStatus"];
  readonly citizenship?: Borrower["citizenship"];
  readonly preferredLanguage?: string;
  readonly isMilitary?: boolean;
  readonly firstTimeHomebuyer?: boolean;
}

const MARITAL = new Set<string>(["married", "unmarried", "separated"]);
const CITIZENSHIP = new Set<string>(["us_citizen", "permanent_resident", "non_permanent_resident"]);

/**
 * What the party says about themselves. Every field is optional: absent means
 * "no live fact", and the caller keeps the column.
 */
export function identityFromFacts(facts: FactMap): IdentityFromFacts {
  const name = obj(facts.get("legal_name"));
  const address = obj(facts.get("current_address"));
  const marital = str(facts.get("marital_status"));
  const citizenship = str(facts.get("citizenship"));

  const addr: Borrower["currentAddress"] | undefined =
    address &&
    str(address.line1) &&
    str(address.city) &&
    str(address.state) &&
    str(address.postalCode)
      ? {
          line1: str(address.line1)!,
          line2: str(address.line2),
          city: str(address.city)!,
          state: str(address.state)!,
          postalCode: str(address.postalCode)!,
        }
      : undefined;

  return {
    firstName: name ? str(name.first) : undefined,
    lastName: name ? str(name.last) : undefined,
    dateOfBirth: str(facts.get("date_of_birth")),
    ssnVaultHandle: str(facts.get("ssn_token")),
    email: str(facts.get("email")),
    phone: str(facts.get("phone")),
    currentAddress: addr,
    maritalStatus:
      marital && MARITAL.has(marital) ? (marital as Borrower["maritalStatus"]) : undefined,
    citizenship:
      citizenship && CITIZENSHIP.has(citizenship)
        ? (citizenship as Borrower["citizenship"])
        : undefined,
    preferredLanguage: str(facts.get("preferred_language")),
    isMilitary: bool(facts.get("is_military")),
    firstTimeHomebuyer: bool(facts.get("first_time_homebuyer")),
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
