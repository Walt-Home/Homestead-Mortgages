/**
 * The average prime offer rate, and the week it was published for.
 *
 * Three of the regulatory tests on screen 8 — General QM, HPML and HOEPA —
 * compare this loan's APR against the rate a borrower with the best terms was
 * getting at the moment this loan's rate was set. The FFIEC publishes that
 * figure weekly, one column per term, and Regulation Z's comparison is against
 * the week the rate was set rather than against the latest week available. So
 * a number alone is not an APOR: an APOR is a number, a term, and a week.
 *
 * That is why this is a dated series with a lookup and not a constant.
 * `GUIDELINES` holds thresholds that change every January and says so; an APOR
 * changes every Monday, which is a different failure. A threshold that is a
 * year stale is wrong by the size of one annual adjustment. An APOR that is six
 * months stale is wrong by however far the market moved, in whichever
 * direction, and it is wrong silently — the HPML test still returns a boolean,
 * the HOEPA test still says "not high-cost", and nothing anywhere reads as
 * missing.
 *
 * **So a week this table does not hold is a blocked derivation, never the
 * nearest week it does hold.** `lookupApor` refuses a rate set more than six
 * days after the last week in the series, which is the only mechanism that
 * makes staleness visible: the table stops answering rather than answering
 * approximately, the compliance tests block, and the decision is `referred`
 * instead of confidently wrong. It also means this file WILL stop answering,
 * on the Monday after the last row below, and that is the alarm working.
 *
 * **Where the rows come from.** The CFPB publishes the survey it computes the
 * APOR from, and its methodology; `apor-survey.ts` does that computation, and
 * reproduces the CFPB's own published table to the two decimals they print.
 * `APOR_TABLE` below is computed from the survey vendored in `@hm/shared` and
 * exists for tests and for the fixture adapter. A deployment does not read it:
 * the API reads `apor_weeks`, which `scripts/fetch-apor.ts` fills from the live
 * survey, and a deployment with nothing fetched blocks rather than falling back
 * to a checked-in file that was current the day somebody last ran
 * `apor:vendor`. Every derivation that consumes a rate records `apor_source`,
 * so a stored decision says which publication answered it.
 *
 * **The date the rate was set is a calendar date, in a named zone.** The lookup
 * took the UTC calendar date off the stored instant, which is a different day
 * for eight hours out of every twenty-four: a quote at 21:00 Sunday in New York
 * is `T01:00Z` on Monday, and UTC moved it into the following week — first a
 * blocked test, then, once Monday's row landed, a comparison against the wrong
 * week, recorded on an append-only decision that names the week it used. The
 * zone is `RATE_SET_TIME_ZONE` in `@hm/shared`, the fixture rate sheet stamps
 * its days in the same one, and every derivation records both.
 */

import { calendarDateIn } from "@hm/shared";

/** One week of the series: the FFIEC's week begins on a Monday. */
export interface AporWeek {
  /** The Monday the week begins, as an ISO date. */
  readonly weekOf: string;
  /** One rate per entry of `termYears`, in the same order, in percent. */
  readonly fixed: readonly number[];
  /**
   * Where THIS week's figures came from, when it differs from the table's
   * source. A fetched series is a rolling window, so a week can stay in force
   * from a publication a newer one no longer carries.
   */
  readonly source?: string;
}

export interface AporTable {
  /** Where the rows came from, recorded onto every derivation that reads one. */
  readonly source: string;
  /**
   * The fixed-rate terms this table carries a column for, in years.
   *
   * The FFIEC's own table is wider than this. A term with no column here is a
   * blocked lookup rather than the nearest column, for the reason a missing
   * week is: a 20-year loan compared against the 30-year average is a spread
   * nobody published.
   */
  readonly termYears: readonly number[];
  readonly weeks: readonly AporWeek[];
}

/** What a lookup answers: a rate and its provenance, or why there is none. */
export type AporLookup =
  | {
      readonly found: true;
      readonly rate: number;
      readonly weekOf: string;
      /** The rate-set calendar date the week was matched on, in RATE_SET_TIME_ZONE. */
      readonly setOn: string;
      readonly termYears: number;
      readonly source: string;
    }
  | { readonly found: false; readonly reason: string };

const MS_PER_DAY = 86_400_000;
/** Beyond this the rate was set in a week the series does not reach. */
const WEEK_SPAN_DAYS = 6;
/** A rate outside this band is a transcription error rather than a market. */
const PLAUSIBLE_RATE = { min: 0.01, max: 25 };

/**
 * Validate a table on the way in, so a bad edit fails at import.
 *
 * Contiguity is the load-bearing check. The lookup takes the latest week on or
 * before the date the rate was set, so a series with a hole in it answers the
 * week BEFORE the hole for every rate set inside it — which is the stale answer
 * this file exists to refuse, arriving through a gap rather than through the
 * end of the series. A hole cannot be detected at lookup time, because from
 * there a missing week and a week that was never published look the same.
 */
export function loadAporTable(table: AporTable): AporTable {
  if (table.termYears.length === 0) {
    throw new Error("An APOR table with no term columns cannot answer anything.");
  }
  for (const term of table.termYears) {
    if (!Number.isInteger(term) || term <= 0) {
      throw new Error(`A term of ${term} years is not a term. Refusing to load the APOR table.`);
    }
  }
  if (table.weeks.length === 0) {
    throw new Error("An APOR table with no weeks cannot answer anything.");
  }

  let previous: number | null = null;
  for (const week of table.weeks) {
    const at = Date.parse(`${week.weekOf}T00:00:00.000Z`);
    if (!Number.isFinite(at)) {
      throw new Error(`"${week.weekOf}" is not a date. Refusing to load the APOR table.`);
    }
    if (new Date(at).getUTCDay() !== 1) {
      throw new Error(
        `The FFIEC's week begins on a Monday and ${week.weekOf} is not one. ` +
          "Refusing to load the APOR table.",
      );
    }
    if (previous !== null && at - previous !== 7 * MS_PER_DAY) {
      throw new Error(
        `The APOR series jumps from ${new Date(previous).toISOString().slice(0, 10)} to ` +
          `${week.weekOf}. A series with a hole in it answers the week before the hole.`,
      );
    }
    if (week.fixed.length !== table.termYears.length) {
      throw new Error(
        `The week of ${week.weekOf} carries ${week.fixed.length} rates against ` +
          `${table.termYears.length} term columns.`,
      );
    }
    for (const rate of week.fixed) {
      if (!Number.isFinite(rate) || rate < PLAUSIBLE_RATE.min || rate > PLAUSIBLE_RATE.max) {
        throw new Error(
          `An average prime offer rate of ${rate} in the week of ${week.weekOf} is not a rate.`,
        );
      }
    }
    previous = at;
  }
  return table;
}

/**
 * The rate for the week `rateSetOn` falls in, or why there is none.
 *
 * Only fixed-rate terms are answerable: the columns below are fixed-rate
 * columns, and an adjustable-rate loan is compared against a different series
 * keyed on its initial fixed period. Answering one from the other would be the
 * same invention as answering a 20-year term off the 30-year column.
 */
export function lookupApor(
  table: AporTable,
  rateSetOn: Date,
  termMonths: number,
  amortization: string,
): AporLookup {
  if (amortization !== "Fixed") {
    return {
      found: false,
      reason: `an average prime offer rate for a ${amortization} product (this table holds fixed-rate columns only)`,
    };
  }
  if (!Number.isFinite(rateSetOn.getTime())) {
    return { found: false, reason: "the date this loan's rate was set" };
  }
  // The calendar date FIRST, and every comparison below on that date's midnight
  // — the week match and the staleness check alike. Comparing the raw instant
  // against a Monday midnight in UTC while reporting a date read in another
  // zone is two answers to one question, and the reason string would name a day
  // the match did not use.
  const setOn = calendarDateIn(rateSetOn);
  const at = Date.parse(`${setOn}T00:00:00.000Z`);
  if (termMonths % 12 !== 0) {
    return {
      found: false,
      reason: `an average prime offer rate for a ${termMonths}-month term (this table is keyed by whole years)`,
    };
  }
  const termYears = termMonths / 12;
  const column = table.termYears.indexOf(termYears);
  if (column === -1) {
    return {
      found: false,
      reason: `an average prime offer rate for a ${termYears}-year term (this table holds ${table.termYears.join(", ")})`,
    };
  }

  let match: AporWeek | null = null;
  for (const week of table.weeks) {
    if (Date.parse(`${week.weekOf}T00:00:00.000Z`) <= at) match = week;
    else break;
  }
  const first = table.weeks[0]!;
  const last = table.weeks[table.weeks.length - 1]!;
  if (match === null) {
    return {
      found: false,
      reason: `an average prime offer rate for the week of ${setOn} (the FFIEC table starts the week of ${first.weekOf})`,
    };
  }
  const ageDays = Math.floor((at - Date.parse(`${match.weekOf}T00:00:00.000Z`)) / MS_PER_DAY);
  if (ageDays > WEEK_SPAN_DAYS) {
    return {
      found: false,
      reason: `an average prime offer rate for the week of ${setOn} (the FFIEC table ends the week of ${last.weekOf})`,
    };
  }
  return {
    found: true,
    rate: match.fixed[column]!,
    weekOf: match.weekOf,
    setOn,
    termYears,
    source: match.source ?? table.source,
  };
}
