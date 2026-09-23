/**
 * The tape desk: a book previewed before it is written, loaded under the
 * servicer's own principal, and the people on it invited to claim.
 *
 * The servicing app's console API is a stub that answers `/ops/api/me` for
 * one cookie, because the desk's gate is that answer and nothing else. The
 * tape is the sample book, so every count here is one the reader's own
 * tests already hold; what is held here is what the desk says about it
 * against what the database holds, and what each act writes.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { FixtureMailConnector } from "@hm/connectors";
import { NORTHLIGHT, sampleBook, toCsv } from "@hm/partner-book";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleTapeRouter } from "../routes/console-tape.js";
import { connectors } from "../services/connectors.js";
import { acceptLoanClaim, mintLoanClaim } from "../services/loan-claims.js";
import { partnerPrincipal } from "../services/party.js";
import { createUser } from "./support/factories.js";

const STAFF_COOKIE = "sm_staff=desk";
const COMPLIANCE_COOKIE = "sm_staff=reader";

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
    if (cookie.includes(STAFF_COOKIE)) {
      res.end(
        JSON.stringify({
          staff_user_id: "staff-1",
          legal_name: "Desk Person",
          roles: ["ops_analyst", "admin"],
          role: req.headers["x-staff-role"] ?? "ops_analyst",
          source: "session",
        }),
      );
    } else if (cookie.includes(COMPLIANCE_COOKIE)) {
      res.end(
        JSON.stringify({
          staff_user_id: "staff-2",
          legal_name: "Reader",
          roles: ["compliance"],
          role: "compliance",
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
    "/console/hm/tape",
    consoleTapeRouter({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }),
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
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  cookie: string | null = STAFF_COOKIE,
): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${port}/console/hm/tape${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-staff-role": "ops_analyst",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const gz = (bytes: Uint8Array) => ({ base64: b64(gzipSync(bytes)), encoding: "gzip" as const });
const utf8 = (s: string) => new TextEncoder().encode(s);
const SERVICER = { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name };

function tapeBody(
  book = sampleBook(),
  opts: { supplement?: boolean; asOf?: string } = {},
): Record<string, unknown> {
  return {
    servicer: SERVICER,
    profile: "m3-v1",
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    tape: { filename: "northlight.xlsx", base64: b64(book.tape) },
    ...(opts.supplement === false
      ? {}
      : { supplement: { filename: "supplement.csv", base64: b64(utf8(book.supplement)) } }),
  };
}

const outbox = () => (connectors().mail as FixtureMailConnector).outbox;

describe("the desk's gate", () => {
  it("is the servicing app's session, and a reading role does not load", async () => {
    expect((await call("GET", "/servicers", undefined, null)).status).toBe(401);
    expect((await call("GET", "/servicers", undefined, "sm_staff=nobody")).status).toBe(401);
    const reader = await call<{ error: { code: string } }>(
      "GET",
      "/servicers",
      undefined,
      COMPLIANCE_COOKIE,
    );
    expect(reader.status).toBe(403);
    expect(reader.body.error.code).toBe("ROLE_REQUIRED");
    expect((await call("GET", "/servicers")).status).toBe(200);
  });
});

describe("previewing a tape", () => {
  it("reads the book, writes nothing, and says what loading it would do", async () => {
    const before = await prisma.loan.count();
    const r = await call<Record<string, never>>("POST", "/preview", tapeBody());
    expect(r.status).toBe(200);
    const p = r.body as unknown as {
      profile: string;
      headers: { matched: boolean; required: number; missing: string[] };
      rejected: boolean;
      alreadyLoaded: null;
      rowsTotal: number;
      counts: { created: number; updated: number; unchanged: number };
      claimed: number;
      supplement: { rows: number; matched: number; withEmail: number };
      servicer: { exists: boolean; slug: string };
      rows: {
        number: string;
        borrower: string | null;
        change: string;
        email: string | null;
        claimed: boolean;
      }[];
    };
    expect(p.profile).toBe("m3-v1");
    expect(p.headers).toEqual({ matched: true, required: 15, missing: [] });
    expect(p.rejected).toBe(false);
    expect(p.alreadyLoaded).toBeNull();
    expect(p.servicer).toMatchObject({ exists: false, slug: NORTHLIGHT.slug });
    expect(p.rowsTotal).toBe(12);
    expect(p.counts).toEqual({ created: 12, updated: 0, unchanged: 0 });
    expect(p.claimed).toBe(0);
    // Loan 12 has no supplement row; the rest carry an address the desk can mail.
    expect(p.supplement.rows).toBe(11);
    expect(p.supplement.withEmail).toBe(11);
    const one = p.rows.find((x) => x.number === "NL-100001")!;
    expect(one.borrower).toBeTruthy();
    expect(one.email).toMatch(/@/);
    expect(p.rows.find((x) => x.number === "NL-100012")!.email).toBeNull();
    // Nothing was written.
    expect(await prisma.loan.count()).toBe(before);
    expect(await prisma.servicer.count({ where: { slug: NORTHLIGHT.slug } })).toBe(0);
  });

  it("refuses a tape missing a required header, by name, before reading a row", async () => {
    const book = sampleBook();
    const header = book.tapeRows[0]!;
    const drop = header.indexOf("Next Due Date");
    expect(drop).toBeGreaterThan(-1);
    const rows = book.tapeRows.map((r) => r.filter((_, i) => i !== drop));
    const r = await call<{
      rejected: boolean;
      headers: { missing: string[] };
      rowsReadable: number;
    }>("POST", "/preview", {
      servicer: SERVICER,
      profile: "m3-v1",
      tape: { filename: "short.csv", base64: b64(utf8(toCsv(rows))) },
    });
    expect(r.status).toBe(200);
    expect(r.body.rejected).toBe(true);
    expect(r.body.headers.missing).toContain("Next Due Date");
    expect(r.body.rowsReadable).toBe(0);
  });
});

describe("loading a tape", () => {
  it("makes the servicer on first sight, loads once, and the preview then reads what is held", async () => {
    const first = await call<{
      servicer: { created: boolean; slug: string };
      result: { status: string; counts?: { loans_created: number } };
      loadedBy: string;
    }>("POST", "/imports", tapeBody());
    expect(first.status).toBe(201);
    expect(first.body.servicer).toMatchObject({ created: true, slug: NORTHLIGHT.slug });
    expect(first.body.result.status).toBe("loaded");
    expect(first.body.result.counts?.loans_created).toBe(12);
    expect(first.body.loadedBy).toBe("staff-1");
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
    expect(servicer.integrationDepth).toBe("API");
    expect(await prisma.loan.count({ where: { servicerId: servicer.id } })).toBe(12);

    // The same two files load once.
    const again = await call<{ result: { status: string } }>("POST", "/imports", tapeBody());
    expect(again.status).toBe(200);
    expect(again.body.result.status).toBe("already_loaded");

    // The preview now sees the book as held: every row unchanged, and the tape already loaded.
    const p = await call<{
      counts: { created: number; updated: number; unchanged: number };
      alreadyLoaded: { importId: string } | null;
      servicer: { exists: boolean };
    }>("POST", "/preview", tapeBody());
    expect(p.body.counts).toEqual({ created: 0, updated: 0, unchanged: 12 });
    expect(p.body.alreadyLoaded).not.toBeNull();
    expect(p.body.servicer.exists).toBe(true);

    // A later tape with one balance moved previews as one change, and a
    // cell the profile cannot read is an exception on a row that still
    // loads, not a refusal.
    const later = sampleBook((l) => ({
      as_of_date: "2026-10-01",
      ...(l.n === 1 ? { upb_cents: 440000 } : {}),
      ...(l.n === 2 ? { fico_current_date: "not a date" } : {}),
    }));
    const q = await call<{
      asOf: string;
      counts: { updated: number };
      rows: { number: string; change: string }[];
      rowsReadable: number;
      rowsRefused: number;
      exceptionsTotal: number;
      exceptionSummary: { code: string; column: string | null; rows: number }[];
    }>("POST", "/preview", {
      servicer: SERVICER,
      profile: "m3-v1",
      tape: { filename: "october.csv", base64: b64(utf8(toCsv(later.tapeRows))) },
    });
    expect(q.body.rows.find((r) => r.number === "NL-100001")?.change).toBe("updated");
    // The same tape gzipped on the way up reads the same.
    const packed = await call<{ rowsReadable: number; asOf: string }>("POST", "/preview", {
      servicer: SERVICER,
      profile: "m3-v1",
      tape: { filename: "october.csv", ...gz(utf8(toCsv(later.tapeRows))) },
    });
    expect(packed.status).toBe(200);
    expect(packed.body.rowsReadable).toBe(12);
    expect(packed.body.asOf).toBe("2026-10-01");
    // The as-of is the tape's own, not the day the desk read it.
    expect(q.body.asOf).toBe("2026-10-01");
    expect(q.body.rowsReadable).toBe(12);
    expect(q.body.rowsRefused).toBe(0);
    expect(q.body.exceptionsTotal).toBe(1);
    expect(q.body.exceptionSummary).toEqual([
      { code: "unreadable_cell", column: "Current Fico Date", rows: 1 },
    ]);

    // The history lists it.
    const h = await call<{ imports: { rowsLoaded: number }[] }>(
      "GET",
      `/imports?servicer=${NORTHLIGHT.slug}`,
    );
    expect(h.body.imports).toHaveLength(1);
    expect(h.body.imports[0]?.rowsLoaded).toBe(12);
    const s = await call<{ servicers: { slug: string; book: { imports: number } }[] }>(
      "GET",
      "/servicers",
    );
    expect(s.body.servicers.find((x) => x.slug === NORTHLIGHT.slug)?.book.imports).toBe(1);
  });
});

describe("inviting the people on a tape to claim", () => {
  it("mints one claim per loan, mails the ones with an address, and answers for every loan", async () => {
    await call("POST", "/imports", tapeBody());
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
    // One loan claimed already, through the same door a partner's link opens.
    const minted = await mintLoanClaim({
      servicerId: servicer.id,
      servicerLoanNumber: "NL-100003",
      principalId: await partnerPrincipal(prisma, NORTHLIGHT.slug),
    });
    await acceptLoanClaim(minted.token, (await createUser()).id);

    const before = outbox().length;
    const r = await call<{
      outcomes: {
        number: string;
        status: string;
        to?: string;
        link?: string;
        reason?: string;
        expiresAt?: string;
      }[];
    }>("POST", "/claims", {
      servicerSlug: NORTHLIGHT.slug,
      invitations: [
        { number: "NL-100001", email: "one@example.test" },
        { number: "NL-100012", email: null },
        { number: "NL-100003", email: "three@example.test" },
        { number: "NL-999999", email: "nobody@example.test" },
      ],
    });
    expect(r.status).toBe(201);
    const by = new Map(r.body.outcomes.map((o) => [o.number, o]));
    expect(by.get("NL-100001")).toMatchObject({ status: "sent", to: "one@example.test" });
    expect(by.get("NL-100012")).toMatchObject({ status: "no_address" });
    expect(by.get("NL-100012")?.link).toContain("/claim#");
    expect(by.get("NL-100003")?.status).toBe("not_claimable");
    expect(by.get("NL-999999")?.status).toBe("not_claimable");

    // The mail carried the link, and the claim row says where it went.
    expect(outbox().length).toBe(before + 1);
    const mail = outbox().at(-1)!;
    expect(mail.to).toBe("one@example.test");
    expect(mail.text).toContain("/claim#");
    expect(mail.text).toContain(NORTHLIGHT.legal_name);
    const loan = await prisma.loan.findFirstOrThrow({
      where: { servicerId: servicer.id, servicerLoanNumber: "NL-100001" },
    });
    const claim = await prisma.loanClaim.findFirstOrThrow({
      where: { loanId: loan.id, revokedAt: null },
    });
    expect(claim.deliveredTo).toBe("one@example.test");
    expect(claim.deliveredAt).not.toBeNull();
    expect(claim.delivery).toMatchObject({ status: "sent" });
    // The link in the mail is the one the row hashes, and it opens the claim door.
    const token = /\/claim#([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const taken = await acceptLoanClaim(token, (await createUser()).id);
    expect(taken.loanId).toBe(loan.id);
  });
});
