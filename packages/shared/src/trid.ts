/**
 * The six pieces.
 *
 * TRID (12 CFR 1026.2(a)(3)) says an application exists the moment a creditor
 * has received six things: the consumer's name, income, social security
 * number, the property address, an estimate of its value, and the loan amount
 * sought. Receiving the sixth starts a three-business-day Loan Estimate clock,
 * and missing it is the sheet's most severe category.
 *
 * Three of the six are facts about a PERSON and are pinned from the
 * relationship layer. Three are about the REQUEST and live on the active loan
 * scenario until a Property object exists. The database trigger that stamps
 * the receipt reads both, and this file is the one place the vocabulary is
 * written down — the trigger's predicate list is asserted against it by a test.
 */

/** The party-side pieces, as fact predicates. */
export const TRID_PARTY_PREDICATES = ["legal_name", "ssn_token", "monthly_income"] as const;

export type TridPartyPredicate = (typeof TRID_PARTY_PREDICATES)[number];

/** The request-side pieces, as scenario fields. */
export const TRID_SCENARIO_FIELDS = [
  "propertyAddress",
  "valueEstimateCents",
  "loanAmountCents",
] as const;

export type TridScenarioField = (typeof TRID_SCENARIO_FIELDS)[number];

/**
 * The reason the receipt writes on its ledger row.
 *
 * The SQL function stamps this literal; a test reads `pg_proc` and asserts the
 * spelling. Exported so nothing else ever writes a second spelling for the
 * same event.
 */
export const RECEIPT_REASON_CODE = "six_pieces_received" as const;

/**
 * The zone whose calendar counts business days.
 *
 * A configuration in a later slice; one value for now, and the SQL function
 * `add_business_days` carries the same default.
 */
export const CREDITOR_TIME_ZONE = "America/New_York";

const DAY_MS = 86_400_000;

/** The wall-clock date parts of `at` in `timeZone`. */
function wallDate(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month") - 1, d: get("day") };
}

/** The instant of local midnight at the start of (y, m, d) in `timeZone`. */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): number {
  // Guess UTC midnight, then correct by the zone's offset at that instant.
  // Two passes settle a guess that lands across a DST boundary.
  let t = Date.UTC(y, m, d);
  for (let i = 0; i < 2; i += 1) {
    const w = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(t));
    const get = (k: string) => Number(w.find((p) => p.type === k)?.value);
    const wallAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    const offset = wallAsUtc - t;
    t = Date.UTC(y, m, d) - offset;
  }
  return t;
}

/**
 * The end of the Nth business day after `from`, weekends only, in the
 * creditor's zone.
 *
 * "Not later than the third business day" (1026.19(e)(1)(iii)) is a DAY, so
 * the deadline is the instant before the next local midnight — not the
 * receipt's time of day three days on. Reg Z's business day is one the
 * creditor is open, which excludes federal holidays; that needs a calendar
 * table this slice does not add, so in a holiday week this is one day
 * optimistic. Clocks open tolled until then, and a failing test says so.
 *
 * The Postgres function `add_business_days` must agree with this exactly, and
 * a test holds them together.
 */
export function addBusinessDays(from: Date, days: number, timeZone = CREDITOR_TIME_ZONE): Date {
  const { y, m, d } = wallDate(from, timeZone);
  let cursor = Date.UTC(y, m, d);
  let left = days;
  while (left > 0) {
    cursor += DAY_MS;
    const dow = new Date(cursor).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  const end = new Date(cursor);
  return new Date(
    zonedMidnight(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1, timeZone) - 1,
  );
}
