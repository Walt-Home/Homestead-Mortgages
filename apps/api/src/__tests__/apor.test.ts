/**
 * The average prime offer rate series in the database: what a fetch appends,
 * what a re-fetch does not, what a revision does, what is refused, and what
 * nothing can undo.
 */

import { describe, expect, it } from "vitest";
import { fixtureAporSeriesConnector, type AporSurveyFetch } from "@hm/connectors";
import { prisma } from "@hm/db";
import { FFIEC_SURVEY, FFIEC_YIELD_TABLE_FIXED } from "@hm/shared";
import { APOR_TABLE, lookupApor, parseYieldTable } from "@hm/underwriting";
import {
  aporStatus,
  aporTableFromDatabase,
  ingestApor,
  latestFetch,
  mondayOf,
} from "../services/apor.js";
import { ingestFixtureApor } from "./support/apor.js";

const fixture = fixtureAporSeriesConnector({ latencyMs: 0 });
const PROVIDER = fixture.capabilities.provider;
const rows = parseYieldTable(FFIEC_YIELD_TABLE_FIXED.body);

const document = (
  body: string,
  extra: Partial<{ lastModified: string | null; etag: string | null; url: string }> = {},
): AporSurveyFetch => ({
  status: "fetched",
  document: {
    csv: body,
    url: extra.url ?? FFIEC_YIELD_TABLE_FIXED.url,
    retrievedAt: new Date().toISOString(),
    lastModified:
      extra.lastModified === undefined ? FFIEC_YIELD_TABLE_FIXED.lastModified : extra.lastModified,
    etag: extra.etag === undefined ? FFIEC_YIELD_TABLE_FIXED.etag : extra.etag,
  },
});

/** The vendored published table with one cell changed: a revision, as the CFPB issues them. */
function revisedTable(weekOf: string, term: number, rate: string): string {
  const [y, m, d] = weekOf.split("-");
  return FFIEC_YIELD_TABLE_FIXED.body
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith(`${m}/${d}/${y}|`)) return line;
      const cells = line.split("|");
      cells[term] = rate;
      return cells.join("|");
    })
    .join("\r\n");
}

const ingestFixture = () => ingestFixtureApor();
/** The weeks without their per-week provenance, which the fixture table does not carry. */
const bare = (weeks: readonly { weekOf: string; fixed: readonly number[] }[]) =>
  weeks.map(({ weekOf, fixed }) => ({ weekOf, fixed }));
const survey = () => fixture.fetchSurvey();
const table = () => fixture.fetchTable();

describe("ingesting the published table", () => {
  it("starts empty, and says so as null rather than as an empty table", async () => {
    expect(await aporTableFromDatabase()).toBeNull();
    expect(await aporStatus()).toMatchObject({
      latestWeekOf: null,
      coversThisWeek: false,
      fetchCount: 0,
    });
  });

  it("appends one fetch per document and one row per (week, term), matching the fixture table exactly", async () => {
    const report = await ingestApor(await table(), await survey(), PROVIDER);
    expect(report.status).toBe("ingested");
    if (report.status !== "ingested") return;
    expect(report.rowCount).toBe(rows.length);
    expect(report.weeks.every((w) => w.added && w.revised.length === 0)).toBe(true);
    expect(await prisma.aporFetch.count()).toBe(2);
    expect(await prisma.aporWeek.count()).toBe(rows.length * 4);

    const held = (await aporTableFromDatabase())!;
    expect(held.termYears).toEqual(APOR_TABLE.termYears);
    expect(bare(held.weeks)).toEqual(bare(APOR_TABLE.weeks));
    // And every week names the fetch that answered it — this one, today.
    expect(new Set(held.weeks.map((w) => w.source))).toEqual(new Set([held.source]));
    expect(held.source).toContain(report.fetchId);
    expect(held.source).toContain(PROVIDER);
  });

  it("stores each document verbatim with the server's headers, so a fetch is a snapshot", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const published = await prisma.aporFetch.findFirstOrThrow({
      where: { kind: "yield_table_fixed" },
    });
    expect(published.body).toBe(FFIEC_YIELD_TABLE_FIXED.body);
    expect(published.etag).toBe(FFIEC_YIELD_TABLE_FIXED.etag);
    expect(published.sha256).toBe(FFIEC_YIELD_TABLE_FIXED.sha256);
    const s = await prisma.aporFetch.findFirstOrThrow({ where: { kind: "survey" } });
    expect(s.body).toBe(FFIEC_SURVEY.csv);
  });

  it("stores the cross-check beside every published rate the survey reaches, and the divergences the CFPB announced", async () => {
    const report = await ingestApor(await table(), await survey(), PROVIDER);
    if (report.status !== "ingested") throw new Error(report.status);
    expect(report.divergences.map((d) => `${d.weekOf}/${d.termYears}`).sort()).toEqual(
      [
        "2025-12-29/30",
        "2025-12-29/20",
        "2025-12-29/15",
        "2025-12-29/10",
        "2026-01-05/20",
        "2026-01-05/15",
        "2026-01-05/10",
      ].sort(),
    );
    const checked = await prisma.aporWeek.count({ where: { surveyDate: { not: null } } });
    expect(checked).toBe(52 * 4);
    const holiday = await prisma.aporWeek.findFirstOrThrow({
      where: { weekOf: new Date("2025-12-29T00:00:00Z"), termYears: 30 },
    });
    expect(Number(holiday.rate)).toBe(6.25);
    expect(Number(holiday.computedRate)).toBe(6.18);
    expect(holiday.divergenceBps).toBe(7);
    const agreed = await prisma.aporWeek.findFirstOrThrow({
      where: { weekOf: new Date("2026-09-14T00:00:00Z"), termYears: 30 },
    });
    expect(agreed.divergenceBps).toBe(0);
    expect(report.unchecked).toBe(rows.length - 52);
  });

  it("ingests the table without the survey when the survey was not served, and says so", async () => {
    const report = await ingestApor(await table(), null, PROVIDER);
    if (report.status !== "ingested") throw new Error(report.status);
    expect(report.unchecked).toBe(rows.length);
    expect(await prisma.aporWeek.count({ where: { surveyDate: null } })).toBe(rows.length * 4);
    expect(bare((await aporTableFromDatabase())!.weeks)).toEqual(bare(APOR_TABLE.weeks));
  });

  it("does nothing the second time: the same bytes are the same publication", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    expect(await ingestApor(await table(), await survey(), PROVIDER)).toEqual({
      status: "unchanged",
      reason: "already_held",
    });
    expect(await prisma.aporFetch.count()).toBe(2);
  });

  it("does nothing on a 304 either, and the next conditional request carries what the server sent", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const prior = (await latestFetch("yield_table_fixed"))!;
    const conditional = await fixture.fetchTable({
      ifNoneMatch: prior.etag!,
      ifModifiedSince: prior.lastModified!.toUTCString(),
    });
    expect(conditional.status).toBe("unchanged");
    expect(await ingestApor(conditional, await survey(), PROVIDER)).toEqual({
      status: "unchanged",
      reason: "not_modified",
    });
  });
});

describe("a revision", () => {
  const WEEK = "2026-09-07";

  it("is a new fetch beside the old one, and the newer published figure is the one in force", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const before = lookupApor(
      (await aporTableFromDatabase())!,
      new Date(`${WEEK}T12:00:00Z`),
      360,
      "Fixed",
    );
    if (!before.found) throw new Error("expected a rate");

    const report = await ingestApor(
      document(revisedTable(WEEK, 30, "7.25"), {
        lastModified: "Fri, 11 Sep 2026 12:00:00 GMT",
        etag: '"revised"',
      }),
      await survey(),
      PROVIDER,
    );
    if (report.status !== "ingested") throw new Error(report.status);
    const week = report.weeks.find((w) => w.weekOf === WEEK)!;
    expect(week.added).toBe(false);
    expect(week.revised).toEqual([{ term: 30, was: before.rate, now: 7.25 }]);
    // The survey's arithmetic now disagrees with the published figure for that
    // week, and the row says by how much.
    expect(report.divergences.find((d) => d.weekOf === WEEK && d.termYears === 30)).toMatchObject({
      published: 7.25,
      computed: before.rate,
    });

    expect(await prisma.aporFetch.count({ where: { kind: "yield_table_fixed" } })).toBe(2);
    const stored = await prisma.aporWeek.findMany({
      where: { weekOf: new Date(`${WEEK}T00:00:00Z`), termYears: 30 },
      orderBy: { writeSeq: "asc" },
    });
    expect(stored.map((r) => Number(r.rate))).toEqual([before.rate, 7.25]);
    expect(
      lookupApor((await aporTableFromDatabase())!, new Date(`${WEEK}T12:00:00Z`), 360, "Fixed"),
    ).toMatchObject({
      found: true,
      rate: 7.25,
    });
  });

  it("leaves every other week's figure exactly as it was, now cited to the newer publication", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const before = (await aporTableFromDatabase())!;
    await ingestApor(
      document(revisedTable(WEEK, 30, "7.25"), {
        lastModified: "Fri, 11 Sep 2026 12:00:00 GMT",
        etag: '"r"',
      }),
      await survey(),
      PROVIDER,
    );
    const after = (await aporTableFromDatabase())!;
    expect(bare(after.weeks.filter((w) => w.weekOf !== WEEK))).toEqual(
      bare(before.weeks.filter((w) => w.weekOf !== WEEK)),
    );
    // The newer publication carries every week, so every week now cites it —
    // the same figures, from the document in force.
    expect(new Set(after.weeks.map((w) => w.source))).toEqual(new Set([after.source]));
    expect(after.source).not.toBe(before.source);
  });

  it("keeps citing the older fetch for a week the newer publication no longer carries", async () => {
    // The CFPB's file is a window. When a week rolls off its front, the rate
    // in force for that week is still the one we hold, and a decision on it
    // has to cite the fetch that actually carried it.
    await ingestApor(await table(), await survey(), PROVIDER);
    const before = (await aporTableFromDatabase())!;
    const lines = FFIEC_YIELD_TABLE_FIXED.body.split(/\r?\n/).filter(Boolean);
    const lastCells = lines[lines.length - 1]!.split("|");
    const nextWeek = ["09/21/2026", ...lastCells.slice(1)].join("|");
    const rolled = [lines[0]!, ...lines.slice(2), nextWeek].join("\r\n");
    const report = await ingestApor(
      document(rolled, { lastModified: "Thu, 17 Sep 2026 18:41:14 GMT", etag: '"next"' }),
      await survey(),
      PROVIDER,
    );
    expect(report.status).toBe("ingested");
    const after = (await aporTableFromDatabase())!;
    expect(after.weeks.length).toBe(before.weeks.length + 1);
    const first = after.weeks[0]!;
    const newest = after.weeks[after.weeks.length - 1]!;
    expect(first.weekOf).toBe("2017-01-02");
    expect(newest.weekOf).toBe("2026-09-21");
    expect(first.source).toBe(before.source);
    expect(newest.source).toBe(after.source);
    expect(first.source).not.toBe(newest.source);
    // And the lookup hands the week's own provenance to the derivation.
    expect(lookupApor(after, new Date("2017-01-03T12:00:00Z"), 360, "Fixed")).toMatchObject({
      source: before.source,
    });
  });
});

describe("what the ingest refuses", () => {
  it("a document that ends before the newest week already held, so the table cannot walk backwards", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const shorter = FFIEC_YIELD_TABLE_FIXED.body
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, -1)
      .join("\r\n");
    const report = await ingestApor(
      document(shorter, { etag: '"older"' }),
      await survey(),
      PROVIDER,
    );
    expect(report).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("before the week of 2026-09-14"),
    });
    expect(await prisma.aporFetch.count({ where: { kind: "yield_table_fixed" } })).toBe(1);
  });

  it("a document modified before the newest one held, however it was served", async () => {
    await ingestApor(await table(), await survey(), PROVIDER);
    const report = await ingestApor(
      document(revisedTable("2026-09-07", 30, "7.25"), {
        lastModified: "Thu, 03 Sep 2026 18:41:14 GMT",
        etag: '"stale"',
      }),
      await survey(),
      PROVIDER,
    );
    expect(report).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("modified"),
    });
  });

  it("a fixture document beside a live fetch, so a developer's copy cannot displace the CFPB's", async () => {
    await ingestApor(await table(), await survey(), "ffiec-survey");
    const report = await ingestApor(
      document(revisedTable("2026-09-07", 30, "7.25"), {
        lastModified: "Fri, 11 Sep 2026 12:00:00 GMT",
        etag: '"dev"',
      }),
      await survey(),
      PROVIDER,
    );
    expect(report).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("live fetch"),
    });
    expect((await aporTableFromDatabase())!.source).toContain("ffiec-survey");
  });
});

describe("what the database refuses", () => {
  it("an UPDATE or a DELETE on either table, because a published rate is a record", async () => {
    await ingestFixture();
    const week = await prisma.aporWeek.findFirstOrThrow();
    await expect(
      prisma.aporWeek.update({ where: { id: week.id }, data: { rate: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.aporWeek.delete({ where: { id: week.id } })).rejects.toThrow(/append-only/);
    const fetch = await prisma.aporFetch.findFirstOrThrow();
    await expect(
      prisma.aporFetch.update({ where: { id: fetch.id }, data: { etag: "x" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.aporFetch.delete({ where: { id: fetch.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("a week that is not a Monday, a survey that is not a Thursday, or one not four days after the other", async () => {
    await ingestFixture();
    const fetch = await prisma.aporFetch.findFirstOrThrow({ where: { kind: "yield_table_fixed" } });
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const base = {
      fetchId: fetch.id,
      termYears: 40,
      rate: 6.5,
      surveyRate: 6.4,
      surveyPoints: 0.9,
      computedRate: 6.5,
      divergenceBps: 0,
    };
    await expect(
      prisma.aporWeek.create({
        data: { ...base, weekOf: day("2026-09-15"), surveyDate: day("2026-09-11") },
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      prisma.aporWeek.create({
        data: { ...base, weekOf: day("2026-09-14"), surveyDate: day("2026-09-09") },
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      prisma.aporWeek.create({
        data: { ...base, weekOf: day("2026-09-21"), surveyDate: day("2026-09-10") },
      }),
    ).rejects.toThrow(/check constraint/);
    // And a divergence that is not the difference it claims to be.
    await expect(
      prisma.aporWeek.create({
        data: {
          ...base,
          weekOf: day("2026-09-21"),
          surveyDate: day("2026-09-17"),
          divergenceBps: 3,
        },
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it("a series with a term missing from a week, when read back — and health says so", async () => {
    await ingestFixture();
    const fetch = await prisma.aporFetch.findFirstOrThrow({ where: { kind: "yield_table_fixed" } });
    await prisma.aporWeek.create({
      data: {
        fetchId: fetch.id,
        weekOf: new Date("2026-09-21T00:00:00Z"),
        termYears: 30,
        rate: 6.8,
      },
    });
    await expect(aporTableFromDatabase()).rejects.toThrow(/without a 20-year rate/);
    expect(await aporStatus()).toMatchObject({
      coversThisWeek: false,
      error: expect.stringContaining("20-year"),
    });
  });
});

describe("what the fetch script exits on", () => {
  it("names the Monday of the FFIEC week a date falls in, on the lender's calendar", () => {
    // Midnight UTC on a Monday is still Sunday evening in New York, so it
    // belongs to the week before; the week turns at 04:00Z (EDT) — which is
    // exactly the four hours every Sunday evening that a UTC read spent
    // calling a current series one week behind.
    expect(mondayOf(new Date("2026-09-16T15:00:00Z"))).toBe("2026-09-14");
    expect(mondayOf(new Date("2026-09-14T00:00:00Z"))).toBe("2026-09-07");
    expect(mondayOf(new Date("2026-09-14T04:00:00Z"))).toBe("2026-09-14");
    expect(mondayOf(new Date("2026-09-21T03:59:59Z"))).toBe("2026-09-14");
    expect(mondayOf(new Date("2026-09-21T04:00:00Z"))).toBe("2026-09-21");
  });

  it("covers this week exactly when the latest week is this week's Monday or later", async () => {
    const held = await ingestFixture();
    const last = held.weeks[held.weeks.length - 1]!.weekOf;
    // Noon UTC, so both instants fall on the calendar day they name in New
    // York as well as in Greenwich.
    const inside = new Date(`${last}T12:00:00Z`);
    const after = new Date(inside.getTime() + 7 * 86_400_000);
    expect((await aporStatus(prisma, inside)).coversThisWeek).toBe(true);
    expect((await aporStatus(prisma, after)).coversThisWeek).toBe(false);
    expect(await aporStatus(prisma, inside)).toMatchObject({
      latestWeekOf: last,
      provider: PROVIDER,
    });
  });
});
