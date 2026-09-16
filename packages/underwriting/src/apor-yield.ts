/**
 * The CFPB's published average prime offer rate table, and the check that the
 * survey agrees with it.
 *
 * `https://files.ffiec.cfpb.gov/apor/YieldTableFixed.txt` is the table the
 * CFPB's own rate-spread calculator reads: pipe-delimited, one row per Monday
 * since 2017, a column for every term from one to fifty years, updated in the
 * same second as the survey every Thursday. **It is the figure in force**, and
 * it is the source of truth here.
 *
 * It is the source of truth rather than a computation from the survey because
 * the CFPB deviates from its own method by announcement, and a computation
 * cannot know when. Two such weeks sit inside one vendored year:
 *
 *   - **2025-12-29.** Christmas fell on the survey Thursday. Per the method's
 *     footnote 2 the CFPB republished the prior week's figures — and the
 *     survey file nevertheless carries a 2025-12-25 row, which computes to
 *     numbers the CFPB never put in force, seven basis points off on the
 *     30-year.
 *   - **2026-01-05.** Two sets were published and the calculator took the
 *     HIGHER figure per term, so three of the four modeled terms carry the
 *     first set and one carries the revision. No survey row computes to that.
 *
 * A decision on a rate set in either week, measured against the survey's
 * arithmetic, would have been measured against a fabricated APOR. So the
 * survey is demoted to a **cross-check**: `crossCheck` computes every week
 * from the survey by Appendix J and reports where the published figure
 * differs. On every week the CFPB did not announce a deviation the two agree
 * to the cent — a test proves it across the vendored year — and the weeks
 * where they do not are exactly the announced ones. A divergence is never a
 * refusal (the published figure is in force whatever the arithmetic says); it
 * is reported, stored beside the row, and printed by the fetch, so that a
 * deviation is an event somebody sees rather than a number nobody questions.
 */

import { FFIEC_YIELD_TABLE_FIXED } from "@hm/shared";
import { loadAporTable, type AporTable, type AporWeek } from "./apor.js";
import { aporFor, SURVEY_FIXED_TERMS, type SurveyRow } from "./apor-survey.js";

const MS_PER_DAY = 86_400_000;
const MONDAY = 1;
/** A published rate outside this is a transcription error, not a market. */
const PLAUSIBLE_RATE = { min: 0.01, max: 25 };
const TERMS = 50;

export interface YieldRow {
  /** The Monday the row's rates take effect, as an ISO date. */
  readonly weekOf: string;
  /** Index `t` is the rate for a term of `t` years; index 0 is unused. */
  readonly byTerm: readonly number[];
}

function mmddyyyy(text: string, where: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m)
    throw new Error(`${where}: "${text}" is not a MM/DD/YYYY date. Refusing to read the table.`);
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const at = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== iso) {
    throw new Error(`${where}: "${text}" is not a date. Refusing to read the table.`);
  }
  return iso;
}

/**
 * Parse `YieldTableFixed.txt` exactly as served.
 *
 * The header is checked in full — this file's shape is the CFPB's promise to
 * its own calculator, and a table whose columns moved is a table read under
 * the wrong term — and every row must be a Monday, seven days after the last,
 * with fifty rates in a plausible band.
 */
export function parseYieldTable(text: string): YieldRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new Error("The table has a header and no rows. Refusing to read it.");
  const expectedHeader = [
    "Term of Loan in Years",
    ...Array.from({ length: TERMS }, (_, i) => String(i + 1)),
  ];
  const header = lines[0]!.split("|").map((h) => h.trim());
  if (header.length !== expectedHeader.length || header.some((h, i) => h !== expectedHeader[i])) {
    throw new Error(
      `The table's header is not "Term of Loan in Years|1|…|${TERMS}" (got ${JSON.stringify(lines[0]!.slice(0, 60))}). ` +
        "The CFPB may have reshaped the file; read it before trusting any figure in it.",
    );
  }
  const rows: YieldRow[] = [];
  let previous: number | null = null;
  for (const [n, line] of lines.slice(1).entries()) {
    const where = `table row ${n + 1}`;
    const cells = line.split("|");
    if (cells.length !== header.length) {
      throw new Error(
        `${where}: ${cells.length} cells against ${header.length} columns. Refusing to read the table.`,
      );
    }
    const weekOf = mmddyyyy(cells[0]!, where);
    const at = Date.parse(`${weekOf}T00:00:00.000Z`);
    if (new Date(at).getUTCDay() !== MONDAY) {
      throw new Error(
        `${where}: ${weekOf} is not a Monday. The FFIEC's week begins on one; refusing to read the table.`,
      );
    }
    if (previous !== null && at - previous !== 7 * MS_PER_DAY) {
      throw new Error(
        `${where}: the table jumps from ${new Date(previous).toISOString().slice(0, 10)} to ${weekOf}. ` +
          "A series with a hole in it answers the week before the hole.",
      );
    }
    const byTerm: number[] = [Number.NaN];
    for (let term = 1; term <= TERMS; term += 1) {
      const raw = cells[term]!.trim();
      const rate = Number(raw);
      if (
        raw === "" ||
        !Number.isFinite(rate) ||
        rate < PLAUSIBLE_RATE.min ||
        rate > PLAUSIBLE_RATE.max
      ) {
        throw new Error(
          `${where}, ${term}-year: "${raw}" is not a rate. Refusing to read the table.`,
        );
      }
      byTerm.push(rate);
    }
    rows.push({ weekOf, byTerm });
    previous = at;
  }
  return rows;
}

/** The published table, on the terms this engine models, through the loader. */
export function aporTableFromYieldRows(rows: readonly YieldRow[], source: string): AporTable {
  const weeks: AporWeek[] = rows.map((row) => ({
    weekOf: row.weekOf,
    fixed: SURVEY_FIXED_TERMS.map((term) => row.byTerm[term]!),
  }));
  return loadAporTable({ source, termYears: [...SURVEY_FIXED_TERMS], weeks });
}

/** One (week, term) where the survey's arithmetic and the published table differ. */
export interface AporDivergence {
  readonly weekOf: string;
  readonly surveyDate: string;
  readonly termYears: number;
  readonly published: number;
  readonly computed: number;
  /** published − computed, in basis points. */
  readonly deltaBps: number;
}

/** What the survey says about each published week, where it says anything. */
export interface SurveyEcho {
  readonly weekOf: string;
  readonly surveyDate: string;
  readonly byTerm: Readonly<Record<number, { rate: number; points: number; computed: number }>>;
}

/**
 * Compute every week the survey reaches and compare it with what was published.
 *
 * A week the survey does not cover is not a divergence; a week it covers whose
 * figures differ is. The return carries both the echoes (to store beside the
 * published rows) and the divergences (to report).
 */
export function crossCheck(
  published: readonly YieldRow[],
  survey: readonly SurveyRow[],
): { echoes: SurveyEcho[]; divergences: AporDivergence[] } {
  const bySurveyWeek = new Map(
    survey.map((row) => [effectiveMondayOf(row.surveyDate), row] as const),
  );
  const echoes: SurveyEcho[] = [];
  const divergences: AporDivergence[] = [];
  for (const row of published) {
    const s = bySurveyWeek.get(row.weekOf);
    if (!s) continue;
    const byTerm: Record<number, { rate: number; points: number; computed: number }> = {};
    for (const term of SURVEY_FIXED_TERMS) {
      const computed = aporFor(s.fixed[term], term);
      byTerm[term] = { rate: s.fixed[term].rate, points: s.fixed[term].points, computed };
      const publishedRate = row.byTerm[term]!;
      if (computed !== publishedRate) {
        divergences.push({
          weekOf: row.weekOf,
          surveyDate: s.surveyDate,
          termYears: term,
          published: publishedRate,
          computed,
          deltaBps: Math.round((publishedRate - computed) * 100),
        });
      }
    }
    echoes.push({ weekOf: row.weekOf, surveyDate: s.surveyDate, byTerm });
  }
  return { echoes, divergences };
}

function effectiveMondayOf(surveyDate: string): string {
  return new Date(Date.parse(`${surveyDate}T00:00:00.000Z`) + 4 * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * The table the tests and the fixture adapter use: the vendored PUBLISHED
 * table. Its last week is the vendored file's last Monday, and it goes stale
 * in exactly the way `apor.ts` describes — by refusing. Nothing a borrower
 * reaches reads this constant: the API takes its table from the database, and
 * `npm run apor:vendor` is how this one is brought forward.
 */
export const APOR_TABLE: AporTable = aporTableFromYieldRows(
  parseYieldTable(FFIEC_YIELD_TABLE_FIXED.body),
  `fixture:ffiec-yield-table-fixed:${FFIEC_YIELD_TABLE_FIXED.lastModified}`,
);
