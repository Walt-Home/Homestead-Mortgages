/**
 * A statement's loans as a CSV: one row per loan billed, a TOTAL row last,
 * and the rows adding up to the statement's own figures, column by column —
 * for a month computed live, for the same month once closed, and for a
 * month closed before the cycle was itemized, whose loans carry no rows.
 *
 * The book is the sample one, as of 1 August and billed from 15 August, as
 * in `console-billing.test.ts`; the gate is the same stub.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, Prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { CYCLE_CODES, type StatementWire } from "@hm/billing";
import { plainDate } from "@hm/kernel/calendar";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleBillingRouter } from "../routes/console-billing.js";
import { closeBillingMonth, statementFor } from "../services/billing.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";

const ADMIN_COOKIE = "sm_staff=admin";

let upstream: Server;
let app: Server;
let port: number;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const cookie = String(req.headers.cookie ?? "");
    if (req.url !== "/ops/api/me" || !cookie.includes(ADMIN_COOKIE)) {
      res.statusCode = req.url === "/ops/api/me" ? 401 : 404;
      res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
      return;
    }
    res.end(
      JSON.stringify({
        staff_user_id: "staff-admin",
        legal_name: "The Admin",
        roles: ["ops_analyst", "officer", "compliance", "admin"],
        role: "ops_analyst",
        source: "session",
      }),
    );
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

const utf8 = (s: string) => new TextEncoder().encode(s);

async function loadedBook() {
  const servicer = await prisma.servicer.create({
    data: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name, integrationDepth: "API" },
    select: { id: true, slug: true },
  });
  const book = sampleBook(() => ({ as_of_date: "2026-08-01" }));
  const imported = await importPartnerBook({
    servicerId: servicer.id,
    principalId: await partnerPrincipal(prisma, servicer.slug),
    profile: "m3-v1",
    billedFrom: "2026-08-15",
    tape: { filename: "northlight.xlsx", bytes: book.tape },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  if (imported.status !== "loaded") throw new Error(imported.status);
  return servicer;
}

async function csv(month: string, cookie: string | null = ADMIN_COOKIE) {
  const r = await fetch(
    `http://127.0.0.1:${port}/console/hm/billing/servicers/${NORTHLIGHT.slug}/statements/${month}/loans.csv`,
    { headers: cookie ? { cookie } : {} },
  );
  return {
    status: r.status,
    type: r.headers.get("content-type"),
    disposition: r.headers.get("content-disposition"),
    text: await r.text(),
  };
}

/** The CSV as records by header; none of its cells is quoted here. */
function parse(text: string): Record<string, string>[] {
  const [header, ...rows] = text
    .trimEnd()
    .split("\r\n")
    .map((l) => l.split(","));
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""])));
}

const cents = (dollars: string) => BigInt(dollars.replace(".", ""));
const sum = (
  rows: Record<string, string>[],
  col: string,
  of: (v: string) => bigint = (v) => BigInt(v),
) => rows.reduce((n, r) => n + of(r[col]!), 0n);

/** Every column of the loan rows adds up to the TOTAL row, and the TOTAL row is the statement. */
function expectAddsUp(text: string, s: StatementWire) {
  const records = parse(text);
  const total = records.at(-1)!;
  const loans = records.slice(0, -1);
  expect(total.loan_number).toBe("TOTAL");
  expect(loans).toHaveLength(s.loans.length);
  for (const line of s.lines) {
    expect(sum(loans, `tokens_${line.code}`).toString()).toBe(line.tokens);
    expect(total[`tokens_${line.code}`]).toBe(line.tokens);
  }
  expect(sum(loans, "total_tokens").toString()).toBe(s.tokens);
  expect(total.total_tokens).toBe(s.tokens);
  expect(sum(loans, "charge_dollars", cents).toString()).toBe(s.cents);
  expect(cents(total.charge_dollars!).toString()).toBe(s.cents);
  expect(sum(loans, "balance_dollars", cents).toString()).toBe(s.balanceCents);
  expect(cents(total.balance_dollars!).toString()).toBe(s.balanceCents);
  expect(sum(loans, "days_billed").toString()).toBe(String(s.loanDays));
  expect(total.days_billed).toBe(String(s.loanDays));
  return { loans, total };
}

describe("a statement's loans, as a CSV", () => {
  it("lists every loan a month billed, with a TOTAL row equal to the statement", async () => {
    await loadedBook();
    const live = await csv("2026-08");
    expect(live.status).toBe(200);
    expect(live.type).toBe("text/csv; charset=utf-8");
    expect(live.disposition).toBe(`attachment; filename="${NORTHLIGHT.slug}-2026-08-loans.csv"`);
    const header = live.text.split("\r\n")[0]!.split(",");
    expect(header).toEqual([
      "loan_number",
      "watched_from",
      "ended_on",
      "days_billed",
      "days_in_month",
      "balance_as_of",
      "balance_status",
      "balance_dollars",
      ...CYCLE_CODES.map((c) => `tokens_${c}`),
      "tokens_A.offer_touch",
      "total_tokens",
      "charge_dollars",
    ]);
    const open = await statementFor({ slug: NORTHLIGHT.slug, month: plainDate("2026-08-01") });
    expect(open.standing).toBe("open");
    const { loans } = expectAddsUp(live.text, open.statement);
    expect(loans[0]).toMatchObject({
      loan_number: "NL-100001",
      watched_from: "2026-08-15",
      ended_on: "",
      days_billed: "17",
      days_in_month: "31",
      balance_as_of: "2026-08-01",
      balance_status: "current",
    });

    // Closed, it is read from the row the close wrote, and reads the same.
    await closeBillingMonth({ month: plainDate("2026-08-01"), closedBy: "job" });
    const closed = await csv("2026-08");
    expect(closed.text).toBe(live.text);

    // Admin only, like the rest of billing.
    expect((await csv("2026-08", null)).status).toBe(401);
  });

  it("carries a month closed before the cycle was itemized on its one balance line", async () => {
    const servicer = await loadedBook();
    const s = (await statementFor({ slug: NORTHLIGHT.slug, month: plainDate("2026-08-01") }))
      .statement;
    // August as sheet 1.0 would have closed it: one balance line, and no rows on a loan.
    const touch = s.lines.at(-1)!;
    const older = {
      ...s,
      sheet: { version: "1.0", date: "2026-09-28" },
      month: "2026-07",
      lines: [
        {
          ...s.lines[0]!,
          code: "A.self_improving_mortgage",
          tokens: (BigInt(s.tokens) - BigInt(touch.tokens)).toString(),
        },
        touch,
      ],
      loans: s.loans.map(({ rows: _rows, ...rest }) => rest),
    };
    await prisma.billingStatement.create({
      data: {
        servicerId: servicer.id,
        month: new Date("2026-07-01T00:00:00.000Z"),
        sheetVersion: "1.0",
        loansBilled: s.loansBilled,
        loanMonths: new Prisma.Decimal(s.loanMonths),
        balanceCents: BigInt(s.balanceCents),
        tokens: BigInt(s.tokens),
        cents: BigInt(s.cents),
        statement: older as unknown as Prisma.InputJsonValue,
        closedBy: "job",
      },
    });
    const r = await csv("2026-07");
    expect(r.status).toBe(200);
    expect(r.text.split("\r\n")[0]).toContain(
      "tokens_A.self_improving_mortgage,tokens_A.offer_touch",
    );
    const { loans } = expectAddsUp(r.text, older as unknown as StatementWire);
    expect(loans[0]!["tokens_A.self_improving_mortgage"]).toBe(s.loans[0]!.tokens);
  });
});
