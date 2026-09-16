/**
 * From the CFPB's survey to an average prime offer rate, by their method.
 *
 * The APOR is not a rate anybody quotes. It is an APR the CFPB computes every
 * week from a survey of what prime borrowers were offered — a contract rate and
 * points for each of eight products — using Appendix J to Regulation Z with the
 * assumptions its methodology page lists: a fully amortizing loan, monthly
 * compounding, equal payments to the fraction of a cent, thirty-day months, and
 * no odd-days interest. The survey rows are published as a CSV; the resulting
 * APRs are what the FFIEC's rate-spread calculator compares against, and what
 * §1026.35 (HPML), §1026.32 (HOEPA) and §1026.43(e) (General QM) are decided on.
 *
 * (Until April 2023 the survey was Freddie Mac's PMMS. It is ICE Mortgage
 * Technology's now. Neither Freddie nor Fannie publishes an APOR: the survey is
 * an input, and the APOR is what the CFPB makes of it.)
 *
 * This file does the same arithmetic on the same inputs, with the same solver
 * the engine uses for a borrower's own APR. That is checked rather than hoped:
 * a test computes the week of 2026-01-05 from the vendored survey and expects
 * the four fixed-rate figures the CFPB actually published for that week —
 * 6.19, 5.87, 5.61 and 5.74 — to the two decimals they publish. Two sets were
 * published for that week and the CFPB corrected the first; this reproduces
 * the corrected one.
 *
 * What it refuses, loudly:
 *   - a column it does not recognize, or one it needs missing (the CFPB may
 *     reshape the file, and a shifted column is a wrong APOR that looks right);
 *   - a survey date that is not a Thursday, or a series with a week missing;
 *   - a rate or a point figure outside any plausible band.
 *
 * And what it deliberately does not do: the ARM columns. Their APOR is a
 * composite-rate calculation with a two-point annual cap and a fully-indexed
 * rate, and V1 quotes no adjustable product. The columns are checked for
 * presence and otherwise left alone.
 */

import { FFIEC_SURVEY } from "@hm/shared";
import { solveAnnualPercentageRate } from "./apr.js";
import { loadAporTable, type AporTable, type AporWeek } from "./apor.js";
import { round } from "./derive.js";

/** The fixed-rate terms the survey carries, in years. Column order is theirs. */
export const SURVEY_FIXED_TERMS = [30, 20, 15, 10] as const;
export type SurveyFixedTerm = (typeof SURVEY_FIXED_TERMS)[number];

export interface SurveyFixedProduct {
  /** The average contract rate offered, in percent. */
  readonly rate: number;
  /** Average points and fees, as a percent of the initial loan balance. */
  readonly points: number;
}

export interface SurveyRow {
  /** The Thursday the survey is dated, as an ISO date. */
  readonly surveyDate: string;
  readonly fixed: Readonly<Record<SurveyFixedTerm, SurveyFixedProduct>>;
}

/*
 * Columns are found by NAME and the ones this reads are required. A column it
 * does not read is ignored, whatever it is called. An earlier draft refused any
 * header it had not enumerated, on the theory that a reshaped file is a
 * misread rate; but a lookup by name cannot misread a column because another
 * was added beside it, and a RENAMED required column fails the required check
 * below. Enumerating bought nothing but an outage the day the CFPB adds a
 * 40-year column.
 */

const rateColumn = (term: SurveyFixedTerm) => `${term}-Year Fixed Rates`;
const pointsColumn = (term: SurveyFixedTerm) => `${term}-Year Fixed Points & Fees`;

/** A contract rate outside this is a transcription error, not a market. */
const PLAUSIBLE_RATE = { min: 0.01, max: 25 };
/** Points are a percent of the balance; ten would be a different product. */
const PLAUSIBLE_POINTS = { min: 0, max: 10 };

const MS_PER_DAY = 86_400_000;
const THURSDAY = 4;

function parseDate(text: string, where: string): number {
  const at = Date.parse(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(at)) {
    throw new Error(`${where}: "${text}" is not an ISO date. Refusing to read the survey.`);
  }
  return at;
}

function parseNumber(text: string, band: { min: number; max: number }, where: string): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < band.min || value > band.max) {
    throw new Error(
      `${where}: "${text}" is outside ${band.min}–${band.max}. Refusing to read the survey.`,
    );
  }
  return value;
}

/**
 * Parse the CFPB's `SurveyTable.csv`, exactly as served.
 *
 * The file has no quoted fields and no embedded commas — a split is a parse —
 * and a leading byte-order mark or CRLF line endings are tolerated because both
 * have been seen on files from that site.
 */
export function parseSurveyCsv(csv: string): SurveyRow[] {
  const lines = csv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    throw new Error("The survey has a header and no rows. Refusing to read it.");
  }
  const header = lines[0]!.split(",").map((h) => h.trim());
  const index = new Map(header.map((name, i) => [name, i] as const));
  const columnIndex = (name: string): number => {
    const i = index.get(name);
    if (i === undefined) {
      throw new Error(`The survey has no "${name}" column. Refusing to read it.`);
    }
    return i;
  };
  const dateAt = columnIndex("Date");
  const columns = SURVEY_FIXED_TERMS.map((term) => ({
    term,
    rate: columnIndex(rateColumn(term)),
    points: columnIndex(pointsColumn(term)),
  }));

  const rows: SurveyRow[] = [];
  let previous: number | null = null;
  for (const [n, line] of lines.slice(1).entries()) {
    const cells = line.split(",");
    const where = `survey row ${n + 1}`;
    if (cells.length !== header.length) {
      throw new Error(
        `${where}: ${cells.length} cells against ${header.length} columns. Refusing to read the survey.`,
      );
    }
    const surveyDate = cells[dateAt]!.trim();
    const at = parseDate(surveyDate, where);
    if (new Date(at).getUTCDay() !== THURSDAY) {
      throw new Error(
        `${where}: the survey is dated ${surveyDate}, which is not a Thursday. ` +
          "The CFPB's methodology dates every survey on a Thursday; refusing to read it.",
      );
    }
    if (previous !== null && at - previous !== 7 * MS_PER_DAY) {
      throw new Error(
        `${where}: the survey jumps from ${new Date(previous).toISOString().slice(0, 10)} to ` +
          `${surveyDate}. A series with a week missing answers the week before it.`,
      );
    }
    const fixed = {} as Record<SurveyFixedTerm, SurveyFixedProduct>;
    for (const { term, rate, points } of columns) {
      fixed[term] = {
        rate: parseNumber(cells[rate]!, PLAUSIBLE_RATE, `${where}, ${rateColumn(term)}`),
        points: parseNumber(cells[points]!, PLAUSIBLE_POINTS, `${where}, ${pointsColumn(term)}`),
      };
    }
    rows.push({ surveyDate, fixed });
    previous = at;
  }
  return rows;
}

/**
 * The Monday a survey's rates take effect as APORs.
 *
 * Methodology: survey data are available on Thursday, the APORs are posted the
 * following day, and "those average prime offer rates are effective beginning
 * the following Monday and until the next posting takes effect."
 */
export function effectiveMonday(surveyDate: string): string {
  const at = parseDate(surveyDate, "effectiveMonday");
  return new Date(at + 4 * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * One product's APOR: Appendix J on the survey's rate and points.
 *
 * Points are a percent of the initial balance and are paid at closing, so they
 * are a prepaid finance charge and come out of the amount financed. The loan
 * amount is arbitrary — the APR is a ratio and does not move with it — and the
 * result is rounded to the two decimals the CFPB publishes.
 */
export function aporFor(product: SurveyFixedProduct, termYears: number): number {
  const loanAmount = 100_000;
  // Unrounded, then rounded ONCE to the two places the CFPB publishes. Through
  // the three-place figure a decision uses, nine of 208 vendored figures came
  // out a basis point high against the CFPB's table.
  const solved = solveAnnualPercentageRate({
    loanAmount,
    noteRate: product.rate,
    termMonths: termYears * 12,
    amortization: "Fixed",
    prepaidFinanceCharges: (loanAmount * product.points) / 100,
    mortgageInsuranceApplies: false,
  });
  if (!solved.computed) {
    throw new Error(
      `The ${termYears}-year survey product (${product.rate}% and ${product.points} points) ` +
        `has no annual percentage rate: the solver needed ${solved.reason}.`,
    );
  }
  return round(solved.apr, 2);
}

/**
 * The fixed-rate APOR table a survey implies, one week per row, validated on the
 * way out by the same loader every other table goes through.
 */
export function aporTableFromSurvey(rows: readonly SurveyRow[], source: string): AporTable {
  const weeks: AporWeek[] = rows.map((row) => ({
    weekOf: effectiveMonday(row.surveyDate),
    fixed: SURVEY_FIXED_TERMS.map((term) => aporFor(row.fixed[term], term)),
  }));
  return loadAporTable({ source, termYears: [...SURVEY_FIXED_TERMS], weeks });
}

/**
 * The table the vendored survey COMPUTES to — the cross-check, not the table.
 *
 * `APOR_TABLE` in `apor-yield.ts` is the published one, and is what the tests
 * and the fixture adapter use. This is what Appendix J makes of the survey,
 * kept so the cross-check can be exercised without a fetch.
 */
export const APOR_TABLE_FROM_SURVEY: AporTable = aporTableFromSurvey(
  parseSurveyCsv(FFIEC_SURVEY.csv),
  `fixture:ffiec-survey:${FFIEC_SURVEY.lastModified}`,
);
