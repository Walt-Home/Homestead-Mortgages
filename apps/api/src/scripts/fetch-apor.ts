/**
 * Fetch the CFPB's published average prime offer rate table, cross-check it
 * against the survey it was computed from, and append this week's rates.
 *
 *   node apps/api/dist/scripts/fetch-apor.js            # ingest into DATABASE_URL
 *   npm run apor:fetch                                   # the same, from source
 *   npm run apor:vendor                                  # refresh data/ and re-embed
 *
 * Which adapter fetches is `APOR_PROVIDER`: "ffiec" reads the live files at
 * files.ffiec.cfpb.gov, anything else serves the vendored copies. A scheduled
 * job and the deploy workflow run this with "ffiec"; a developer database is
 * filled from the vendored copies with no network at all.
 *
 * Three things are printed and two are exited on:
 *   - what was added or revised, and every week where Appendix J on the survey
 *     disagrees with the published figure (a DIVERGENCE — reported, never a
 *     failure: the published figure is in force);
 *   - whether the series now covers the current week (exit 1 if not: every
 *     decision computed this week would block UW-008 and end `referred`);
 *   - whether the CFPB's own calculator agrees with the latest week stored,
 *     on the two terms V1 quotes (exit 1 if it ANSWERS and disagrees; an
 *     outage is printed and is not a failure).
 *
 * `--vendor` goes to the CFPB regardless of the provider, writes both documents
 * and their headers into `data/`, and touches no database. It is how the
 * checked-in copies are brought forward: one command, never an edit to a row.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffiecAporSeriesConnector, type AporSurveyFetch } from "@hm/connectors";
import { prisma } from "@hm/db";
import {
  aporStatus,
  ingestApor,
  latestFetch,
  type FetchKind,
  type IngestReport,
} from "../services/apor.js";
import { connectors } from "../services/connectors.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const V1_TERMS = [30, 15] as const;

async function failAfterFlush(): Promise<never> {
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(1);
}

async function vendor(): Promise<void> {
  const live = ffiecAporSeriesConnector();
  const write = async (base: string, fetched: AporSurveyFetch) => {
    if (fetched.status !== "fetched")
      throw new Error("An unconditional fetch cannot be unchanged.");
    const { document } = fetched;
    writeFileSync(resolve(ROOT, `data/${base}`), document.csv);
    writeFileSync(
      resolve(ROOT, `data/${base.replace(/\.[a-z]+$/, "")}.meta.json`),
      `${JSON.stringify(
        {
          url: document.url,
          retrievedAt: document.retrievedAt,
          lastModified: document.lastModified,
          etag: document.etag,
          note:
            "Written by `npm run apor:vendor`, never by hand. The file beside it is the CFPB's " +
            "document exactly as served; `scripts/build-apor.mjs` embeds it into " +
            "packages/shared/src/generated/ffiec-survey.ts.",
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `vendored ${document.url} (${document.csv.length} bytes, last-modified ${document.lastModified})`,
    );
  };
  await write("ffiec-yield-table-fixed.txt", await live.fetchTable());
  await write("ffiec-survey-table.csv", await live.fetchSurvey());
}

function describe(report: IngestReport): string[] {
  if (report.status === "unchanged") return [`apor unchanged (${report.reason})`];
  if (report.status === "refused") return [`apor REFUSED: ${report.reason}`];
  const lines = [
    `apor ingested fetch ${report.fetchId} (${report.rowCount} published weeks, sha256 ${report.sha256.slice(0, 12)}…)`,
  ];
  for (const week of report.weeks) {
    if (week.added) lines.push(`apor week ${week.weekOf} added`);
    for (const r of week.revised)
      lines.push(`apor week ${week.weekOf} REVISED ${r.term}-year ${r.was} -> ${r.now}`);
  }
  for (const d of report.divergences) {
    lines.push(
      `apor week ${d.weekOf} DIVERGES ${d.termYears}-year: published ${d.published}, Appendix J on the ` +
        `${d.surveyDate} survey gives ${d.computed} (${d.deltaBps > 0 ? "+" : ""}${d.deltaBps} bps). ` +
        "The published figure is in force; the CFPB deviated from its method for this week by announcement.",
    );
  }
  if (report.unchecked > 0)
    lines.push(
      `apor ${report.unchecked} published week(s) predate the survey and carry no cross-check`,
    );
  return lines;
}

async function conditional(kind: FetchKind) {
  const prior = await latestFetch(kind);
  return {
    ...(prior?.etag ? { ifNoneMatch: prior.etag } : {}),
    ...(prior?.lastModified ? { ifModifiedSince: prior.lastModified.toUTCString() } : {}),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--vendor")) {
    await vendor();
    return;
  }
  const port = connectors().aporSeries;

  // The published table is required. The survey is the cross-check: if the
  // server does not serve it today the table still goes in, uncross-checked,
  // and the log says so.
  const table = await port.fetchTable(await conditional("yield_table_fixed"));
  let survey: AporSurveyFetch | null = null;
  try {
    const conditionalSurvey = await conditional("survey");
    survey = await port.fetchSurvey(conditionalSurvey);
    if (survey.status === "unchanged" && table.status === "fetched") {
      // A new table with an unchanged survey is a table that revised without
      // a new survey behind it. Re-fetch unconditionally so the cross-check
      // has the survey to compare against.
      survey = await port.fetchSurvey();
    }
  } catch (err) {
    console.log(
      `apor survey unavailable, ingesting without the cross-check: ${err instanceof Error ? err.message : err}`,
    );
  }

  const report = await ingestApor(table, survey, port.capabilities.provider);
  for (const line of describe(report)) console.log(line);
  if (report.status === "refused") {
    await prisma.$disconnect();
    await failAfterFlush();
  }

  const status = await aporStatus();
  console.log(
    `apor series ends the week of ${status.latestWeekOf ?? "(nothing fetched)"}; ` +
      `covers this week: ${status.coversThisWeek}${status.error ? `; ERROR ${status.error}` : ""}`,
  );

  // The CFPB's own calculator, against what was just stored, on the terms V1
  // quotes. Two CFPB sources disagreeing is not something to log and move on
  // from.
  let contradicted = false;
  if (status.latestWeekOf) {
    const { aporTableFromDatabase } = await import("../services/apor.js");
    const held = await aporTableFromDatabase();
    for (const term of V1_TERMS) {
      const answer = await port.rateSpreadCheck({ weekOf: status.latestWeekOf, termYears: term });
      const stored = held?.weeks[held.weeks.length - 1]!.fixed[held.termYears.indexOf(term)];
      if (answer.status === "unavailable") {
        console.log(`apor calculator check ${term}-year: unavailable (${answer.reason})`);
      } else if (stored !== undefined && Math.abs(answer.apor - stored) >= 0.005) {
        console.log(
          `apor calculator check ${term}-year: CONTRADICTION — calculator ${answer.apor}, stored ${stored}`,
        );
        contradicted = true;
      } else {
        console.log(`apor calculator check ${term}-year: agrees (${answer.apor})`);
      }
    }
  }

  await prisma.$disconnect();
  if (!status.coversThisWeek || status.error) {
    console.error(
      "The average prime offer rate series does not cover the current week. Every decision " +
        "computed this week blocks UW-008 and ends referred until it does. If the CFPB has " +
        "published and this still fails, the file has changed shape; read the error above.",
    );
    await failAfterFlush();
  }
  if (contradicted) {
    console.error(
      "The CFPB's calculator disagrees with the table this ingested. A person has to look.",
    );
    await failAfterFlush();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    await failAfterFlush();
  });
}
