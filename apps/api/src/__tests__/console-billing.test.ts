/**
 * Billing's door: admin only, the sample book metered off the price sheet
 * from the day it was loaded, a month closed once and never rewritten.
 *
 * The servicing app's console API is a stub that answers `/ops/api/me` for
 * two cookies — an admin and an analyst — because the gate is that answer
 * and nothing else. The tape is the sample book with its as-of moved to 1
 * August and the loans' load day moved to 15 August, so a whole month can
 * be closed and its figures held to the meter's own arithmetic.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { tokensForBalance, type StatementWire } from "@hm/billing";
import { daysInMonth, parts, plainDate } from "@hm/kernel/calendar";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleBillingRouter } from "../routes/console-billing.js";
import { closeBillingMonth, statementFor } from "../services/billing.js";
import { todayEt } from "../services/loan-review.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";

const ADMIN_COOKIE = "sm_staff=admin";
const ANALYST_COOKIE = "sm_staff=analyst";

let upstream: Server;
let app: Server;
let port: number;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/ops/api/me") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const cookie = String(req.headers.cookie ?? "");
    if (cookie.includes(ADMIN_COOKIE)) {
      res.end(
        JSON.stringify({
          staff_user_id: "staff-admin",
          legal_name: "The Admin",
          roles: ["ops_analyst", "officer", "compliance", "admin"],
          role: "ops_analyst",
          source: "session",
        }),
      );
    } else if (cookie.includes(ANALYST_COOKIE)) {
      res.end(
        JSON.stringify({
          staff_user_id: "staff-analyst",
          legal_name: "An Analyst",
          roles: ["ops_analyst"],
          role: "ops_analyst",
          source: "session",
        }),
      );
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const server = express();
  server.use(
    "/console/hm/billing",
    consoleBillingRouter({
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
  );
  server.use(errorHandler);
  app = server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", r));
  port = (app.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function call<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  cookie: string | null = ADMIN_COOKIE,
): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${port}/console/hm/billing${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const TAPE_AS_OF = "2026-08-01";
const LOADED_ON = new Date("2026-08-15T16:00:00.000Z");

/** The sample book, as of 1 August, loaded on 15 August. */
async function loadedBook() {
  const servicer = await prisma.servicer.create({
    data: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name, integrationDepth: "API" },
    select: { id: true, slug: true },
  });
  const principalId = await partnerPrincipal(prisma, servicer.slug);
  const book = sampleBook(() => ({ as_of_date: TAPE_AS_OF }));
  const imported = await importPartnerBook({
    servicerId: servicer.id,
    principalId,
    profile: "m3-v1",
    tape: { filename: "northlight.xlsx", bytes: book.tape },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  if (imported.status !== "loaded") throw new Error(imported.status);
  await prisma.loan.updateMany({
    where: { servicerId: servicer.id },
    data: { createdAt: LOADED_ON },
  });
  return { servicer, book };
}

/** What the meter says the book consumed, for `days` of a month of `inMonth` days. */
function expectedTokens(
  book: ReturnType<typeof sampleBook>,
  days: number,
  inMonth: number,
): bigint {
  return book.loans.reduce((n, l) => n + tokensForBalance(l.upb_cents, 1750, days, inMonth), 0n);
}

describe("billing's gate", () => {
  it("is the servicing app's session, and only an admin opens it", async () => {
    expect((await call("GET", "/servicers", undefined, null)).status).toBe(401);
    expect((await call("GET", "/servicers", undefined, "sm_staff=nobody")).status).toBe(401);
    const analyst = await call<{ error: { code: string; message: string } }>(
      "GET",
      "/servicers",
      undefined,
      ANALYST_COOKIE,
    );
    expect(analyst.status).toBe(403);
    expect(analyst.body.error.code).toBe("ROLE_REQUIRED");
    expect(analyst.body.error.message).toBe("Billing needs one of admin.");
    expect((await call("GET", "/servicers")).status).toBe(200);
  });
});

describe("the month running", () => {
  it("lists every servicer with this month through today, off the price sheet", async () => {
    const { book } = await loadedBook();
    const today = todayEt();
    const { y, m, d } = parts(today);
    const r = await call<{
      sheet: { version: string; date: string };
      today: string;
      servicers: {
        slug: string;
        loansOnBook: number;
        since: string;
        annualTokenPool: string | null;
        running: {
          month: string;
          through: string;
          loansBilled: number;
          tokens: string;
          cents: string;
          balanceCents: string;
        };
        lastClosed: null;
        yearToDate: { year: number; tokens: string };
      }[];
    }>("GET", "/servicers");
    expect(r.status).toBe(200);
    expect(r.body.sheet).toEqual({ version: "1.0", date: "2026-09-28" });
    expect(r.body.today).toBe(today);
    expect(r.body.servicers).toHaveLength(1);
    const s = r.body.servicers[0]!;
    expect(s.slug).toBe(NORTHLIGHT.slug);
    expect(s.loansOnBook).toBe(12);
    expect(s.since).toBe("2026-08-15");
    expect(s.annualTokenPool).toBeNull();
    expect(s.running.month).toBe(`${y}-${String(m).padStart(2, "0")}`);
    expect(s.running.through).toBe(today);
    expect(s.running.loansBilled).toBe(12);
    expect(s.running.balanceCents).toBe("447158188");
    // Every loan watched from 15 August: the whole month so far, pro rata by day.
    expect(s.running.tokens).toBe(expectedTokens(book, d, daysInMonth(y, m)).toString());
    expect(s.running.cents).toBe(s.running.tokens);
    expect(s.lastClosed).toBeNull();
    expect(s.yearToDate).toEqual({ year: y, tokens: "0", cents: "0" });
  });

  it("answers a servicer's page: this month running, no statements yet", async () => {
    await loadedBook();
    const r = await call<{
      servicer: { slug: string; since: string };
      current: { standing: string; closed: null; statement: StatementWire };
      statements: unknown[];
    }>("GET", `/servicers/${NORTHLIGHT.slug}`);
    expect(r.status).toBe(200);
    expect(r.body.servicer.since).toBe("2026-08-15");
    expect(r.body.current.standing).toBe("running");
    expect(r.body.current.closed).toBeNull();
    expect(r.body.current.statement.lines.map((l) => l.code)).toEqual([
      "A.self_improving_mortgage",
      "A.offer_touch",
    ]);
    expect(r.body.current.statement.lines[1]!.quantity).toEqual({ kind: "events", count: 0 });
    expect(r.body.statements).toEqual([]);
    expect((await call("GET", "/servicers/nobody")).status).toBe(404);
  });

  it("refuses a month that has not started, and a month spelled wrong", async () => {
    await loadedBook();
    const { y } = parts(todayEt());
    const ahead = await call<{ error: { code: string } }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/statements/${y + 1}-01`,
    );
    expect(ahead.status).toBe(400);
    expect(ahead.body.error.code).toBe("MONTH_AHEAD");
    const wrong = await call<{ error: { code: string } }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/statements/2026-13`,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("BAD_MONTH");
  });
});

describe("a month that has ended", () => {
  it("is computed live from the load day through the month's end until it is closed", async () => {
    const { book } = await loadedBook();
    const r = await call<{ standing: string; closed: null; statement: StatementWire }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/statements/2026-08`,
    );
    expect(r.status).toBe(200);
    expect(r.body.standing).toBe("open");
    const s = r.body.statement;
    expect(s.month).toBe("2026-08");
    expect(s.through).toBe("2026-08-31");
    expect(s.loansOnBook).toBe(12);
    expect(s.loansBilled).toBe(12);
    // 15 August through the 31st: seventeen days of thirty-one, every loan.
    expect(s.loanDays).toBe(17 * 12);
    expect(s.loanMonths).toBe("6.58");
    expect(s.tokens).toBe(expectedTokens(book, 17, 31).toString());
    expect(s.loans.every((c) => c.days === 17 && c.watchedFrom === "2026-08-15")).toBe(true);
    expect(s.loans.every((c) => c.basis?.asOf === TAPE_AS_OF)).toBe(true);
    // The month before the load: on the book, nothing consumed.
    const before = await call<{ statement: StatementWire }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/statements/2026-07`,
    );
    expect(before.body.statement.loansOnBook).toBe(12);
    expect(before.body.statement.loansBilled).toBe(0);
    expect(before.body.statement.tokens).toBe("0");
  });

  it("closes once, under the staff id that asked, and the row is answered verbatim from then on", async () => {
    const { book, servicer } = await loadedBook();
    const closed = await call<{
      month: string;
      closed: { slug: string; tokens: string; cents: string }[];
      alreadyClosed: string[];
    }>("POST", "/close", { month: "2026-08" });
    expect(closed.status).toBe(201);
    expect(closed.body.month).toBe("2026-08");
    expect(closed.body.closed).toEqual([
      {
        slug: NORTHLIGHT.slug,
        tokens: expectedTokens(book, 17, 31).toString(),
        cents: expectedTokens(book, 17, 31).toString(),
      },
    ]);
    expect(closed.body.alreadyClosed).toEqual([]);

    const row = await prisma.billingStatement.findUniqueOrThrow({
      where: {
        servicerId_month: { servicerId: servicer.id, month: new Date("2026-08-01T00:00:00.000Z") },
      },
    });
    expect(row.closedBy).toBe("staff-admin");
    expect(row.sheetVersion).toBe("1.0");
    expect(row.loansBilled).toBe(12);
    expect(row.loanMonths.toFixed(2)).toBe("6.58");
    expect(row.tokens).toBe(expectedTokens(book, 17, 31));

    // A second close writes nothing and says so.
    const again = await call<{ closed: unknown[]; alreadyClosed: string[] }>("POST", "/close", {
      month: "2026-08",
    });
    expect(again.status).toBe(201);
    expect(again.body.closed).toEqual([]);
    expect(again.body.alreadyClosed).toEqual([NORTHLIGHT.slug]);
    expect(await prisma.billingStatement.count()).toBe(1);

    // From now on the month is the row, whatever a later tape says.
    const read = await call<{
      standing: string;
      closed: { closedBy: string };
      statement: StatementWire;
    }>("GET", `/servicers/${NORTHLIGHT.slug}/statements/2026-08`);
    expect(read.body.standing).toBe("closed");
    expect(read.body.closed.closedBy).toBe("staff-admin");
    expect(read.body.statement.tokens).toBe(expectedTokens(book, 17, 31).toString());

    const page = await call<{
      statements: { month: string; tokens: string; closedBy: string }[];
    }>("GET", `/servicers/${NORTHLIGHT.slug}`);
    expect(page.body.statements).toHaveLength(1);
    expect(page.body.statements[0]).toMatchObject({ month: "2026-08", closedBy: "staff-admin" });

    const list = await call<{
      servicers: { lastClosed: { month: string }; yearToDate: { tokens: string } }[];
    }>("GET", "/servicers");
    expect(list.body.servicers[0]!.lastClosed.month).toBe("2026-08");
    expect(list.body.servicers[0]!.yearToDate.tokens).toBe(expectedTokens(book, 17, 31).toString());
  });

  it("refuses to close a month still running, and the job closes the month before by default", async () => {
    await loadedBook();
    const { y, m } = parts(todayEt());
    const running = await call<{ error: { code: string } }>("POST", "/close", {
      month: `${y}-${String(m).padStart(2, "0")}`,
    });
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe("MONTH_OPEN");
    // The job on the first: the month that has just ended.
    const report = await closeBillingMonth({
      closedBy: "job",
      now: new Date("2026-10-01T12:00:00Z"),
    });
    expect(report.month).toBe("2026-09");
    expect(report.closed.map((c) => c.slug)).toEqual([NORTHLIGHT.slug]);
    // Named, September on the 30th is still running.
    await expect(
      closeBillingMonth({
        month: plainDate("2026-09-01"),
        closedBy: "job",
        now: new Date("2026-09-30T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "MONTH_OPEN" });
  });

  it("never rewrites a closed statement", async () => {
    const { servicer } = await loadedBook();
    await closeBillingMonth({ month: plainDate("2026-08-01"), closedBy: "job" });
    const row = await prisma.billingStatement.findFirstOrThrow({
      where: { servicerId: servicer.id },
    });
    await expect(
      prisma.billingStatement.update({ where: { id: row.id }, data: { tokens: 0n } }),
    ).rejects.toThrow(/may not be updated/);
    // And a month is only ever its first day.
    await expect(
      prisma.billingStatement.create({
        data: {
          servicerId: servicer.id,
          month: new Date("2026-07-15T00:00:00.000Z"),
          sheetVersion: "1.0",
          loansBilled: 0,
          loanMonths: "0.00",
          balanceCents: 0n,
          tokens: 0n,
          cents: 0n,
          statement: {},
          closedBy: "test",
        },
      }),
    ).rejects.toThrow(/billing_statements_month_is_first_day/);
  });
});

describe("the annual token pool", () => {
  it("is recorded when set, shown on the servicer, and cleared with null", async () => {
    await loadedBook();
    const set = await call<{ servicer: { annualTokenPool: string } }>(
      "PUT",
      `/servicers/${NORTHLIGHT.slug}/pool`,
      { annualTokenPool: "2500000" },
    );
    expect(set.status).toBe(200);
    expect(set.body.servicer.annualTokenPool).toBe("2500000");
    const answer = await statementFor({ slug: NORTHLIGHT.slug, month: plainDate("2026-08-01") });
    expect(answer.servicer.annualTokenPool).toBe("2500000");
    const cleared = await call<{ servicer: { annualTokenPool: null } }>(
      "PUT",
      `/servicers/${NORTHLIGHT.slug}/pool`,
      { annualTokenPool: null },
    );
    expect(cleared.body.servicer.annualTokenPool).toBeNull();
    expect(
      (await call("PUT", `/servicers/${NORTHLIGHT.slug}/pool`, { annualTokenPool: "-1" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", `/servicers/${NORTHLIGHT.slug}/pool`, { annualTokenPool: "1.5" })).status,
    ).toBe(400);
  });
});
