/**
 * The date a rate was set is a CALENDAR DATE, and a calendar needs a zone.
 *
 * Three of the price tests compare this loan's APR against the average prime
 * offer rate "as of the date the interest rate is set" (§1026.35(a)(1)), and
 * the FFIEC/CFPB table is published per Monday-to-Sunday week. A date, not an
 * instant — and the rule names no time zone, because a rate is set in an office
 * and an office is somewhere.
 *
 * Everything here used to take the UTC calendar date off the stored instant,
 * which is the same thing only for the sixteen hours a day the two calendars
 * agree. A quote at 21:00 on Sunday the 14th in New York is stored as
 * `2026-06-15T01:00:00.000Z`, and UTC reads that as Monday the 15th: the
 * comparison week moves forward by one, onto a week the CFPB has not published
 * yet. That is first a blocked test and then — once Monday's row lands — a
 * comparison against the WRONG week, written onto an append-only decision that
 * names the week it used. One week's move in the APOR only decides HPML, QM and
 * HOEPA at the line, but at the line is exactly where these tests live.
 *
 * So the zone is named once, here, and recorded on every derivation that reads
 * it. `America/New_York` is this lender's business day; a pricing vendor
 * stamping `effectiveAt` in its own zone, or a lock desk somewhere else, is a
 * different answer and would be a different constant. It is a policy choice and
 * it is written down as one.
 *
 * This lives in `@hm/shared` rather than in `@hm/underwriting` because the rate
 * sheet fixture in `@hm/connectors` manufactures the very instants the lookup
 * then reads, and `@hm/connectors` depends on `@hm/shared` alone. The sheet's
 * day and the lookup's day have to be the same day.
 *
 * ⚠ These functions need a full-ICU Node. The default builds ship it; a
 * `small-icu` container would format every zone as UTC and give back exactly
 * the bug described above, silently. `assertRateSetTimeZoneAvailable` is the
 * check, and a test pins the Sunday-evening case.
 */

/** The zone the rate-set calendar date is read in. Recorded on the derivation. */
export const RATE_SET_TIME_ZONE = "America/New_York";

const MS_PER_DAY = 86_400_000;

/**
 * The zone's offset from UTC at this instant, in milliseconds.
 *
 * Formatted wall-clock parts read back as if they were UTC, minus the instant.
 * `longOffset` would be shorter but returns "GMT" with no sign for UTC itself
 * and a half-hour zone prints "GMT+5:30", so parsing it is more special cases
 * than this subtraction is.
 */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  // Formatted parts carry no milliseconds, so compare against a whole second.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The calendar date at `instant` in `zone`, as an ISO `YYYY-MM-DD`.
 *
 * `en-CA` formats as ISO, which is the whole reason for the locale.
 */
export function calendarDateIn(instant: Date, zone: string = RATE_SET_TIME_ZONE): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("An invalid Date has no calendar date in any zone.");
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** The year of the calendar date at `instant` in `zone`. */
export function calendarYearIn(instant: Date, zone: string = RATE_SET_TIME_ZONE): number {
  return Number(calendarDateIn(instant, zone).slice(0, 4));
}

/** The day after an ISO date, as an ISO date. */
export function nextCalendarDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(at)) throw new RangeError(`"${day}" is not a calendar date.`);
  return new Date(at + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The instant local midnight begins `day` in `zone`.
 *
 * Two passes: the offset that applies near the naive instant gives a candidate,
 * and the offset that applies AT the candidate is the one that actually governs
 * it. One correction is enough for every zone with a whole- or half-hour offset
 * and a shift of at most an hour, and neither of this zone's two transitions
 * happens at local midnight — they are at 02:00 local.
 */
export function startOfDayIn(day: string, zone: string = RATE_SET_TIME_ZONE): Date {
  const naive = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(naive)) throw new RangeError(`"${day}" is not a calendar date.`);
  const first = naive - zoneOffsetMs(new Date(naive), zone);
  return new Date(naive - zoneOffsetMs(new Date(first), zone));
}

/**
 * The last millisecond of `day` in `zone`.
 *
 * ⚠ A local day is 23 or 25 hours twice a year. This is the end of the day
 * rather than the start plus twenty-four hours for exactly that reason: a rate
 * sheet published on the second Sunday in March expires at local midnight, and
 * that is 23 hours after it took effect.
 */
export function endOfDayIn(day: string, zone: string = RATE_SET_TIME_ZONE): Date {
  return new Date(startOfDayIn(nextCalendarDay(day), zone).getTime() - 1);
}

/**
 * Throw unless this Node can actually resolve the zone.
 *
 * A `small-icu` build resolves every IANA zone to UTC without complaining, so
 * the failure is a wrong calendar date rather than an error. Called at API
 * startup so a container like that stops on boot rather than quietly measuring
 * every Sunday-evening quote against next week.
 */
export function assertRateSetTimeZoneAvailable(zone: string = RATE_SET_TIME_ZONE): void {
  const resolved = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone;
  if (resolved !== zone) {
    throw new Error(
      `This Node cannot resolve ${zone} (it resolved to ${resolved}), so every rate-set ` +
        "date would be read in UTC. Build with full ICU.",
    );
  }
  // A zone that resolves by name but does not shift is the same failure wearing
  // the right label: 2026-06-15T01:00Z is 2026-06-14 in New York and 06-15 in UTC.
  if (calendarDateIn(new Date("2026-06-15T01:00:00.000Z"), zone) === "2026-06-15") {
    throw new Error(
      `This Node resolves ${zone} but does not offset it, so every rate-set date would ` +
        "be read in UTC. Build with full ICU.",
    );
  }
}
