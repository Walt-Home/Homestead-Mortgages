/**
 * The average prime offer rate series: fetched into the database, read out of it.
 *
 * Three legal tests are decided against this series, for the week a loan's rate
 * was set, and the series is a weekly publication. So it lives in two
 * append-only tables rather than in a source file: `apor_fetches`, one row per
 * document the CFPB served, and `apor_weeks`, the published rates on the terms
 * this engine models. The engine is handed the table this module builds and
 * nothing else — a deployment that has fetched nothing hands it null, and
 * UW-008 blocks with words that say what to run.
 *
 * Two documents, two roles. The PUBLISHED table (`YieldTableFixed.txt`) is the
 * figure in force and the only thing `apor_weeks.rate` is ever taken from. The
 * survey is the cross-check: what Appendix J makes of it is stored beside each
 * published rate, with the difference in basis points, so that a week where
 * the CFPB deviated from its own method — a holiday carry-forward, a per-term
 * revision — is a number on the row and a line in the fetch log rather than a
 * silent disagreement nobody measured. A divergence never blocks: the
 * published figure is in force whatever the arithmetic says.
 *
 * The CFPB updates the published file in place, so the latest publication is
 * the latest fetch — and the ingest refuses a document older than the newest
 * one held, so a stale copy served after a newer one cannot walk the table
 * backwards. Old rows stay because decisions cite them.
 */

import { createHash } from "node:crypto";
import type { AporSurveyFetch } from "@hm/connectors";
import { prisma } from "@hm/db";
import { calendarDateIn } from "@hm/shared";
import {
  aporTableFromYieldRows,
  crossCheck,
  loadAporTable,
  parseSurveyCsv,
  parseYieldTable,
  SURVEY_FIXED_TERMS,
  type AporDivergence,
  type AporTable,
  type AporWeek,
  type SurveyRow,
} from "@hm/underwriting";
import { config } from "../config.js";
import type { Db } from "./db.js";

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const atMidnightUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export type FetchKind = "yield_table_fixed" | "survey";

export interface IngestedWeek {
  readonly weekOf: string;
  readonly added: boolean;
  /** Terms whose in-force rate changed against what was held, with both figures. */
  readonly revised: readonly { term: number; was: number; now: number }[];
}

export type IngestReport =
  | {
      readonly status: "ingested";
      readonly fetchId: string;
      readonly sha256: string;
      readonly rowCount: number;
      readonly weeks: readonly IngestedWeek[];
      /** Where the survey's arithmetic disagrees with the published figure. */
      readonly divergences: readonly AporDivergence[];
      /** Weeks the survey did not reach, and so carry no cross-check. */
      readonly unchecked: number;
    }
  | {
      readonly status: "unchanged";
      readonly reason: "not_modified" | "already_held";
    }
  | {
      readonly status: "refused";
      readonly reason: string;
    };

/** The most recent fetch of a kind, for the conditional request the next one makes. */
export async function latestFetch(
  kind: FetchKind,
  db: Db = prisma,
): Promise<{
  id: string;
  provider: string;
  etag: string | null;
  lastModified: Date | null;
  sha256: string;
  retrievedAt: Date;
} | null> {
  return db.aporFetch.findFirst({
    where: { kind },
    orderBy: { writeSeq: "desc" },
    select: {
      id: true,
      provider: true,
      etag: true,
      lastModified: true,
      sha256: true,
      retrievedAt: true,
    },
  });
}

function parsedLastModified(header: string | null): Date | null {
  if (header === null) return null;
  const d = new Date(header);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Ingest the published table, with the survey beside it as the cross-check.
 *
 * `survey` may be null: a survey the server did not serve leaves the published
 * rows uncross-checked, which is reported, and is not a reason to withhold the
 * figure in force. Idempotent by the published document's hash. The parse and
 * the cross-check run before the transaction opens, so a document the parser
 * refuses leaves nothing behind.
 */
export async function ingestApor(
  table: AporSurveyFetch,
  survey: AporSurveyFetch | null,
  provider: string,
  db: Db = prisma,
): Promise<IngestReport> {
  if (table.status === "unchanged") return { status: "unchanged", reason: "not_modified" };
  const document = table.document;
  const sha256 = sha(document.csv);
  // "Already held" is the same bytes as the NEWEST fetch, not as any fetch:
  // the CFPB can restore an earlier file, and when it does, that file is the
  // publication in force again and must be ingested again.
  const newest = await latestFetch("yield_table_fixed", db);
  if (newest?.sha256 === sha256) return { status: "unchanged", reason: "already_held" };

  // A fixture-provider document is for tests and developers. In production it
  // is a checked-in file standing in for a publication, and beside a live
  // fetch it would become the rate in force with a provenance string that
  // says otherwise. Refused in both cases, the way a placeholder institution
  // is refused.
  if (provider.startsWith("fixture")) {
    if (config.nodeEnv === "production") {
      return { status: "refused", reason: "a fixture document cannot be ingested in production" };
    }
    if (newest && !newest.provider.startsWith("fixture")) {
      return {
        status: "refused",
        reason: `this database holds a live fetch (${newest.provider}); a fixture document would displace it`,
      };
    }
  }

  const rows = parseYieldTable(document.csv);
  const published = aporTableFromYieldRows(rows, `${provider}:${document.lastModified ?? sha256}`);
  const lastModified = parsedLastModified(document.lastModified);

  // Monotonic: the CFPB updates the file in place and it holds the figure in
  // force, so a document that ends earlier than what is held, or was modified
  // earlier, is an older publication — a stale mirror, a cache, a developer's
  // vendored copy — and ingesting it would walk the table backwards.
  const held = await aporTableFromDatabase(db).catch(() => null);
  if (held) {
    const heldLast = held.weeks[held.weeks.length - 1]!.weekOf;
    const incomingLast = published.weeks[published.weeks.length - 1]!.weekOf;
    if (incomingLast < heldLast) {
      return {
        status: "refused",
        reason: `the document ends the week of ${incomingLast}, before the week of ${heldLast} already held`,
      };
    }
    if (
      newest?.lastModified &&
      lastModified &&
      lastModified.getTime() < newest.lastModified.getTime()
    ) {
      return {
        status: "refused",
        reason: `the document was modified ${lastModified.toISOString()}, before the ${newest.lastModified.toISOString()} already held`,
      };
    }
  }

  let surveyRows: SurveyRow[] = [];
  if (survey && survey.status === "fetched") surveyRows = parseSurveyCsv(survey.document.csv);
  const { echoes, divergences } = crossCheck(rows, surveyRows);
  const echoByWeek = new Map(echoes.map((e) => [e.weekOf, e] as const));

  const current = new Map<string, number>();
  if (held) {
    for (const week of held.weeks) {
      held.termYears.forEach((term, i) => current.set(`${week.weekOf}/${term}`, week.fixed[i]!));
    }
  }

  // Two ingests of the same document at once — the scheduled job and a
  // deploy — both pass the newest-bytes check and both insert. Harmless: the
  // rows are identical and the later write_seq wins with the same figures.
  const fetchId = await db.$transaction(async (tx) => {
    if (survey && survey.status === "fetched") {
      const surveySha = sha(survey.document.csv);
      // Recorded for the audit trail; the weeks reference the table's fetch.
      const newestSurvey = await latestFetch("survey", tx);
      if (newestSurvey?.sha256 !== surveySha) {
        await tx.aporFetch.create({
          data: {
            kind: "survey",
            retrievedAt: new Date(survey.document.retrievedAt),
            provider,
            sourceUrl: survey.document.url,
            lastModified: parsedLastModified(survey.document.lastModified),
            etag: survey.document.etag,
            sha256: surveySha,
            rowCount: surveyRows.length,
            body: survey.document.csv,
          },
          select: { id: true },
        });
      }
    }
    const fetch = await tx.aporFetch.create({
      data: {
        kind: "yield_table_fixed",
        retrievedAt: new Date(document.retrievedAt),
        provider,
        sourceUrl: document.url,
        lastModified,
        etag: document.etag,
        sha256,
        rowCount: rows.length,
        body: document.csv,
      },
      select: { id: true },
    });
    await tx.aporWeek.createMany({
      data: published.weeks.flatMap((week) =>
        SURVEY_FIXED_TERMS.map((term, t) => {
          const echo = echoByWeek.get(week.weekOf)?.byTerm[term];
          const rate = week.fixed[t]!;
          return {
            fetchId: fetch.id,
            weekOf: atMidnightUtc(week.weekOf),
            termYears: term,
            rate,
            ...(echo
              ? {
                  surveyDate: atMidnightUtc(echoByWeek.get(week.weekOf)!.surveyDate),
                  surveyRate: echo.rate,
                  surveyPoints: echo.points,
                  computedRate: echo.computed,
                  divergenceBps: Math.round((rate - echo.computed) * 100),
                }
              : {}),
          };
        }),
      ),
    });
    return fetch.id;
  });

  const weeks: IngestedWeek[] = published.weeks.map((week) => {
    const revised: { term: number; was: number; now: number }[] = [];
    let seen = false;
    published.termYears.forEach((term, i) => {
      const was = current.get(`${week.weekOf}/${term}`);
      if (was === undefined) return;
      seen = true;
      if (was !== week.fixed[i]) revised.push({ term, was, now: week.fixed[i]! });
    });
    return { weekOf: week.weekOf, revised, added: !seen };
  });
  return {
    status: "ingested",
    fetchId,
    sha256,
    rowCount: rows.length,
    weeks,
    divergences,
    unchecked: published.weeks.length - echoes.length,
  };
}

/**
 * The series in force, as the engine's `AporTable`, or null when nothing has
 * been fetched.
 *
 * Latest `write_seq` per (week, term) wins. The result goes through
 * `loadAporTable`, so a hole in the stored series — which no single fetch can
 * produce, because the published file is contiguous, but a partial restore
 * could — throws rather than answering the week before the hole.
 */
export async function aporTableFromDatabase(db: Db = prisma): Promise<AporTable | null> {
  const rows = await db.aporWeek.findMany({
    orderBy: [{ weekOf: "asc" }, { termYears: "asc" }, { writeSeq: "asc" }],
    select: {
      weekOf: true,
      termYears: true,
      rate: true,
      fetch: { select: { id: true, provider: true } },
    },
  });
  if (rows.length === 0) return null;

  const latest = new Map<string, { rate: number; source: string }>();
  for (const row of rows) {
    latest.set(`${isoDate(row.weekOf)}/${row.termYears}`, {
      rate: Number(row.rate),
      source: `${row.fetch.provider}:yield-table-fixed:fetch:${row.fetch.id}`,
    });
  }
  const weekOfs = [...new Set(rows.map((r) => isoDate(r.weekOf)))].sort();
  // Provenance travels per week. The published file is a rolling window, so
  // a week can stay in force from a fetch the newest file no longer carries;
  // a decision on it has to cite the fetch that actually answered.
  const weeks: AporWeek[] = weekOfs.map((weekOf) => {
    const hits = SURVEY_FIXED_TERMS.map((term) => {
      const hit = latest.get(`${weekOf}/${term}`);
      if (!hit) {
        throw new Error(
          `apor_weeks holds the week of ${weekOf} without a ${term}-year rate. ` +
            "A partial series is not a series; re-run apor:fetch.",
        );
      }
      return hit;
    });
    return { weekOf, fixed: hits.map((h) => h.rate), source: hits[0]!.source };
  });
  const newest = await latestFetch("yield_table_fixed", db);
  return loadAporTable({
    source: `${newest?.provider ?? "unknown"}:yield-table-fixed:fetch:${newest?.id ?? "unknown"}`,
    termYears: [...SURVEY_FIXED_TERMS],
    weeks,
  });
}

/** What /health reports, and what the fetch script exits on. */
export interface AporStatus {
  readonly latestWeekOf: string | null;
  readonly coversThisWeek: boolean;
  readonly lastRetrievedAt: string | null;
  readonly provider: string | null;
  readonly fetchCount: number;
  /** Set when the stored series cannot be read as a table at all. */
  readonly error?: string;
}

/**
 * The Monday of the FFIEC week containing `now`, as an ISO date.
 *
 * On the lender's calendar, not UTC's — this is what `/health` reports
 * `coversThisWeek` against, and reading it in UTC flipped the answer at 20:00
 * on Sunday in New York (19:00 in winter). For four hours every Sunday evening
 * a fully current series read as one week behind, which is an alarm that cries
 * on a schedule.
 */
export function mondayOf(now: Date): string {
  const d = new Date(`${calendarDateIn(now)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return isoDate(d);
}

export async function aporStatus(db: Db = prisma, now: Date = new Date()): Promise<AporStatus> {
  const [newest, fetchCount] = await Promise.all([
    latestFetch("yield_table_fixed", db),
    db.aporFetch.count({ where: { kind: "yield_table_fixed" } }),
  ]);
  let table: AporTable | null = null;
  let error: string | undefined;
  try {
    table = await aporTableFromDatabase(db);
  } catch (err) {
    error = err instanceof Error ? err.message.split("\n")[0] : "unknown";
  }
  const latestWeekOf = table ? table.weeks[table.weeks.length - 1]!.weekOf : null;
  return {
    latestWeekOf,
    coversThisWeek: latestWeekOf !== null && latestWeekOf >= mondayOf(now),
    lastRetrievedAt: newest?.retrievedAt.toISOString() ?? null,
    provider: newest?.provider ?? null,
    fetchCount,
    ...(error ? { error } : {}),
  };
}
