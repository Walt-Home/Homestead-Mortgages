/**
 * A servicer's book from the desk: its loans read from our database, its
 * tapes added up, a tape taken back, and a tape that would make loans the
 * book already holds under another spelling refused before it writes.
 *
 * The servicing app's console API is a stub that answers `/ops/api/me` for
 * one cookie, as in `console-tape.test.ts`. The tapes are the sample book
 * with its numbers made digits, the shape a real servicer's are: tape A is
 * September; tape B is A again with every number written with two leading
 * zeros, as a re-export may write it, loaded by somebody who said it was
 * meant; tape C is eleven new loans for October with two rows refused; tape
 * D carries three of A's loans again for October.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { plainDate } from "@hm/kernel/calendar";
import { NORTHLIGHT, sampleBook, toCsv, type SampleLoan } from "@hm/partner-book";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleTapeRouter } from "../routes/console-tape.js";
import { partnerRouter } from "../routes/partner.js";
import { closeBillingMonth } from "../services/billing.js";
import { lockBook } from "../services/book-lock.js";
import { acceptLoanClaim, mintLoanClaim } from "../services/loan-claims.js";
import { renumberBook } from "../services/loan-numbers.js";
import { importPartnerBook } from "../services/partner-book.js";
import { issuePartnerCredential } from "../services/partner-credentials.js";
import { partnerPrincipal } from "../services/party.js";
import { createUser } from "./support/factories.js";

const STAFF_COOKIE = "sm_staff=desk";

let upstream: Server;
let app: Server;
let port: number;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const cookie = String(req.headers.cookie ?? "");
    if (req.url !== "/ops/api/me" || !cookie.includes(STAFF_COOKIE)) {
      res.statusCode = req.url === "/ops/api/me" ? 401 : 404;
      res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
      return;
    }
    res.end(
      JSON.stringify({
        staff_user_id: "staff-1",
        legal_name: "Desk Person",
        roles: ["ops_analyst", "admin"],
        role: "ops_analyst",
        source: "session",
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const server = express();
  server.use(
    "/console/hm/tape",
    consoleTapeRouter({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }),
  );
  server.use("/api/partner", partnerRouter);
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
): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${port}/console/hm/tape${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: STAFF_COOKIE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const SERVICER = { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name };

/** Loan n's number as the servicer writes it: ten digits. */
const number = (n: number, offset = 0) => String(1002027990 + n + offset);

type Override = (l: SampleLoan) => Partial<Record<string, string | number | null>>;
const csvOf = (override: Override) => toCsv(sampleBook(override).tapeRows);

const tape = (
  filename: string,
  override: Override,
  extra: { billingMonth?: string; allowNearDuplicates?: boolean } = {},
) => ({
  servicer: SERVICER,
  profile: "m3-v1",
  tape: { filename, base64: b64(csvOf(override)) },
  ...extra,
});

const TAPE_A = tape("september.csv", (l) => ({ servicer_loan_number: number(l.n) }), {
  billingMonth: "2026-09",
});
const TAPE_B = tape("september-again.csv", (l) => ({ servicer_loan_number: `00${number(l.n)}` }), {
  billingMonth: "2026-09",
  allowNearDuplicates: true,
});
const TAPE_C = tape(
  "october.csv",
  (l) => ({
    as_of_date: "2026-10-31",
    servicer_loan_number: l.n === 11 ? null : number(l.n, 100),
    // No term the reader can take: the cell is blank and so are the dates it
    // would otherwise count the payments between.
    ...(l.n === 12
      ? { original_term_months: null, first_payment_date: null, maturity_date: null }
      : {}),
  }),
  { billingMonth: "2026-10" },
);
/**
 * Loans 1–3 of tape A again, as of October. Loan 4's number is in
 * scientific notation, which a CSV may have rounded and the reader refuses;
 * the rest of the rows carry no number and are refused too.
 */
const TAPE_D = tape(
  "october-a.csv",
  (l) => ({
    as_of_date: "2026-10-31",
    servicer_loan_number: l.n <= 3 ? number(l.n) : l.n === 4 ? "1.002027994E9" : null,
  }),
  { billingMonth: "2026-10" },
);

interface Tape {
  id: string;
  filename: string | null;
  asOf: string;
  billedFrom: string | null;
  rowsTotal: number;
  rowsLoaded: number;
  rowsRefused: number;
  loansCreated: number;
  loansUpdated: number;
  loansStillOnBook: number;
  balanceCents: string;
  refused: { row: number; number: string | null; code: string; column: string | null }[];
  duplicates: number;
  duplicatesOf: { tapeId: string; loans: number }[];
  removable: { ok: boolean; reasons: string[] };
  removes: { loans: number; observations: number; reviews: number };
}
interface Tapes {
  servicer: { slug: string; displayName: string };
  loansOnBook: number;
  tapes: Tape[];
  removals: {
    id: string;
    tapeId: string;
    filename: string | null;
    asOf: string;
    loansRemoved: number;
    observationsRemoved: number;
    balanceCents: string;
    reason: string;
    removedBy: string | null;
    removedByName: string | null;
    removedAt: string;
  }[];
  outstanding: {
    row: number;
    number: string | null;
    code: string;
    column: string | null;
    tapeId: string;
    tapeAsOf: string;
    tapeFilename: string | null;
  }[];
  check: { created: number; removed: number; loansOnBook: number; adds: boolean };
}

async function load(body: Record<string, unknown>): Promise<string> {
  const r = await call<{ result: { status: string; importId: string } }>("POST", "/imports", body);
  expect(r.status).toBe(201);
  return r.body.result.importId;
}

/** The four tapes, loaded in order. */
async function book() {
  const a = await load(TAPE_A);
  const b = await load(TAPE_B);
  const c = await load(TAPE_C);
  const d = await load(TAPE_D);
  const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
  return { a, b, c, d, servicerId: servicer.id };
}

const tapes = async () => (await call<Tapes>("GET", `/servicers/${NORTHLIGHT.slug}/tapes`)).body;
const remove = (tapeId: string, body: Record<string, unknown>, slug: string = NORTHLIGHT.slug) =>
  call<{
    removal?: Tapes["removals"][number];
    loansOnBook?: number;
    error?: { code: string; message: string; reasons?: string[]; loansToRemove?: number };
  }>("POST", `/servicers/${slug}/tapes/${tapeId}/remove`, body);

/** A review the morning job could have written, resting on one observation. */
async function reviewOn(loanId: string, observationId: string, asOf: string) {
  return prisma.loanReview.create({
    data: {
      loanId,
      observationId,
      asOf: new Date(`${asOf}T00:00:00.000Z`),
      verdict: "WATCHING",
      reasons: [],
      facts: {},
      ruleSetVersion: "test",
      explanation: "test",
    },
  });
}

describe("the book's loans, from our database", () => {
  it("lists a servicer's loans a page at a time, opens one, and a stranger's loan is a 404", async () => {
    await load(TAPE_A);
    const page = await call<{ total: number; rows: { id: string; number: string }[] }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/loans?limit=5&offset=0`,
    );
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(12);
    expect(page.body.rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5].map((n) => number(n)));
    const found = await call<{ total: number }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/loans?q=${number(7)}`,
    );
    expect(found.body.total).toBe(1);

    const one = await call<{ loan: { id: string; number: string; tapes: unknown[] } }>(
      "GET",
      `/servicers/${NORTHLIGHT.slug}/loans/${page.body.rows[0]!.id}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.loan.number).toBe(number(1));
    expect(one.body.loan.tapes).toHaveLength(1);

    // Another servicer's loan, a loan that is nobody's and a servicer that is nobody answer alike.
    await call("POST", "/servicers", { slug: "elsewhere", displayName: "Elsewhere" });
    const theirs = await call("GET", `/servicers/elsewhere/loans/${page.body.rows[0]!.id}`);
    expect(theirs.status).toBe(404);
    expect((await call("GET", `/servicers/${NORTHLIGHT.slug}/loans/not-an-id`)).status).toBe(404);
    expect((await call("GET", "/servicers/nobody/loans")).status).toBe(404);
  });
});

describe("the book's tapes, added up", () => {
  it("says what each tape made and refused, names the loans made twice, and adds up to the book", async () => {
    const { a, b, c, d } = await book();
    const r = await tapes();
    expect(r.servicer).toEqual({ slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name });
    expect(r.loansOnBook).toBe(34);
    expect(r.tapes.map((t) => t.id)).toEqual([a, b, c, d]);
    const [ta, tb, tc, td] = r.tapes as [Tape, Tape, Tape, Tape];

    expect(ta).toMatchObject({
      filename: "september.csv",
      asOf: "2026-09-01",
      billedFrom: "2026-09-01",
      rowsTotal: 12,
      rowsLoaded: 12,
      rowsRefused: 0,
      loansCreated: 12,
      loansStillOnBook: 12,
      refused: [],
      duplicates: 0,
      duplicatesOf: [],
      removable: { ok: true, reasons: [] },
      // Three of its loans are on tape D too, and stay.
      removes: { loans: 9, observations: 12, reviews: 0 },
    });
    const balanceOfA = await prisma.servicingObservation.aggregate({
      where: { importId: a },
      _sum: { principalBalanceCents: true },
    });
    expect(ta.balanceCents).toBe(balanceOfA._sum.principalBalanceCents!.toString());

    // The re-export: every loan it made, the first tape had made first.
    expect(tb).toMatchObject({
      filename: "september-again.csv",
      loansCreated: 12,
      duplicates: 12,
      duplicatesOf: [{ tapeId: a, loans: 12 }],
      removable: { ok: true, reasons: [] },
      removes: { loans: 12, observations: 12, reviews: 0 },
    });
    expect(tb.balanceCents).toBe(ta.balanceCents);

    expect(tc).toMatchObject({
      billedFrom: "2026-10-01",
      rowsTotal: 12,
      rowsLoaded: 10,
      rowsRefused: 2,
      loansCreated: 10,
      duplicates: 0,
    });
    expect(tc.refused).toEqual([
      { row: 11, number: null, code: "no_loan_number", column: null },
      { row: 12, number: number(12, 100), code: "no_term", column: "Term" },
    ]);

    // A tape that made nothing has no day of its own, and deletes no loan.
    expect(td).toMatchObject({
      loansCreated: 0,
      loansUpdated: 3,
      loansStillOnBook: 0,
      billedFrom: null,
      rowsRefused: 9,
      removes: { loans: 0, observations: 3, reviews: 0 },
    });
    expect(td.refused).toHaveLength(9);
    expect(td.refused[0]).toEqual({
      row: 4,
      number: "1.002027994E9",
      code: "loan_number_scientific",
      column: "Servicer Loan Number",
    });
    expect(td.refused.slice(1).every((x) => x.code === "no_loan_number")).toBe(true);
    expect(r.removals).toEqual([]);
    expect(r.check).toEqual({ created: 34, removed: 0, loansOnBook: 34, adds: true });
  });

  it("is a 404 for a servicer nobody holds", async () => {
    expect((await call("GET", "/servicers/nobody/tapes")).status).toBe(404);
  });
});

describe("taking a tape back", () => {
  it("removes the loans only it made, their observations, reviews and people, and keeps the record", async () => {
    const { a, b, servicerId } = await book();
    const loansOfB = await prisma.servicingObservation.findMany({
      where: { importId: b },
      select: { id: true, loanId: true },
    });
    const partiesOfB = await prisma.loanParty.findMany({
      where: { loanId: { in: loansOfB.map((o) => o.loanId) } },
      select: { partyId: true },
    });
    expect(partiesOfB).toHaveLength(12);
    expect(
      await prisma.fact.count({ where: { partyId: { in: partiesOfB.map((p) => p.partyId) } } }),
    ).toBeGreaterThan(0);
    await reviewOn(loansOfB[0]!.loanId, loansOfB[0]!.id, "2026-10-26");
    const loansBefore = await prisma.loan.count({ where: { servicerId } });
    const factsBefore = await prisma.fact.count();
    const before = (await tapes()).tapes.find((t) => t.id === b)!;
    expect(before.removes).toEqual({ loans: 12, observations: 12, reviews: 1 });

    // The count typed is the count it deletes, or nothing moves.
    const wrong = await remove(b, { confirmLoans: 11, reason: "Re-export of September" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.code).toBe("CONFIRM_MISMATCH");
    expect(wrong.body.error?.loansToRemove).toBe(12);
    expect(await prisma.loan.count({ where: { servicerId } })).toBe(loansBefore);
    // And a reason is said.
    expect((await remove(b, { confirmLoans: 12, reason: "  " })).status).toBe(400);

    const done = await remove(b, { confirmLoans: 12, reason: "  Re-export of September  " });
    expect(done.status).toBe(200);
    expect(done.body.loansOnBook).toBe(22);
    expect(done.body.removal).toMatchObject({
      tapeId: b,
      filename: "september-again.csv",
      asOf: "2026-09-01",
      loansRemoved: 12,
      observationsRemoved: 12,
      balanceCents: before.balanceCents,
      reason: "Re-export of September",
      removedBy: "staff-1",
      removedByName: "Desk Person",
    });

    // Its loans, their observations, the review and the people they were made with are gone.
    expect(await prisma.loan.count({ where: { id: { in: loansOfB.map((o) => o.loanId) } } })).toBe(
      0,
    );
    expect(await prisma.servicingObservation.count({ where: { importId: b } })).toBe(0);
    expect(await prisma.loanReview.count()).toBe(0);
    expect(
      await prisma.party.count({ where: { id: { in: partiesOfB.map((p) => p.partyId) } } }),
    ).toBe(0);
    expect(
      await prisma.fact.count({ where: { partyId: { in: partiesOfB.map((p) => p.partyId) } } }),
    ).toBe(0);
    expect(await prisma.fact.count()).toBeLessThan(factsBefore);
    expect(await prisma.partnerBookImport.count({ where: { id: b } })).toBe(0);
    // The first tape's loans are as they were.
    expect(await prisma.servicingObservation.count({ where: { importId: a } })).toBe(12);
    expect(await prisma.loan.count({ where: { servicerId, servicerLoanNumber: number(1) } })).toBe(
      1,
    );

    const row = await prisma.partnerBookRemoval.findUniqueOrThrow({ where: { importId: b } });
    expect(row).toMatchObject({
      loansCreated: 12,
      loansRemoved: 12,
      observationsRemoved: 12,
      reviewsRemoved: 1,
      partiesRemoved: 12,
      removedBy: "staff-1",
    });
    // A record: nothing rewrites it and nothing takes it away.
    await expect(
      prisma.partnerBookRemoval.update({ where: { id: row.id }, data: { reason: "x" } }),
    ).rejects.toThrow(/record/);
    await expect(prisma.partnerBookRemoval.delete({ where: { id: row.id } })).rejects.toThrow(
      /record/,
    );

    const after = await tapes();
    expect(after.tapes.map((t) => t.id)).not.toContain(b);
    expect(after.tapes.find((t) => t.id === a)?.duplicates).toBe(0);
    expect(after.removals).toHaveLength(1);
    expect(after.removals[0]).toMatchObject({ tapeId: b, loansRemoved: 12, removedBy: "staff-1" });
    expect(after.check).toEqual({ created: 34, removed: 12, loansOnBook: 22, adds: true });

    // Once: the tape is gone.
    expect((await remove(b, { confirmLoans: 12, reason: "again" })).status).toBe(404);
  });

  it("keeps a loan another tape also carries, and takes only this tape's word on it", async () => {
    const { a, d, servicerId } = await book();
    const loan1 = await prisma.loan.findFirstOrThrow({
      where: { servicerId, servicerLoanNumber: number(1) },
      select: { id: true, observations: { select: { id: true, importId: true } } },
    });
    const onA = loan1.observations.find((o) => o.importId === a)!;
    const onD = loan1.observations.find((o) => o.importId === d)!;
    await reviewOn(loan1.id, onA.id, "2026-10-01");
    const kept = await reviewOn(loan1.id, onD.id, "2026-10-26");

    const done = await remove(a, { confirmLoans: 9, reason: "Wrong month" });
    expect(done.status).toBe(200);
    expect(done.body.removal).toMatchObject({ loansRemoved: 9, observationsRemoved: 12 });
    expect(done.body.loansOnBook).toBe(25);
    // Loans 1–3 stay with tape D's observation alone; the review on A's is gone, the one on D's kept.
    for (const n of [1, 2, 3]) {
      const left = await prisma.loan.findFirstOrThrow({
        where: { servicerId, servicerLoanNumber: number(n) },
        select: { observations: { select: { importId: true } } },
      });
      expect(left.observations).toEqual([{ importId: d }]);
    }
    expect(await prisma.loanReview.findMany({ select: { id: true } })).toEqual([{ id: kept.id }]);
    expect(await prisma.loan.count({ where: { servicerId, servicerLoanNumber: number(4) } })).toBe(
      0,
    );

    const after = await tapes();
    // A's twelve made, nine taken back: the three left are on the book under D.
    expect(after.check).toEqual({ created: 34, removed: 9, loansOnBook: 25, adds: true });
  });

  it("is refused for a loan somebody has claimed, naming why, and nothing moves", async () => {
    const { b, servicerId } = await book();
    const minted = await mintLoanClaim({
      servicerId,
      servicerLoanNumber: `00${number(5)}`,
      principalId: await partnerPrincipal(prisma, NORTHLIGHT.slug),
    });
    await acceptLoanClaim(minted.token, (await createUser()).id);
    const t = (await tapes()).tapes.find((x) => x.id === b)!;
    expect(t.removable.ok).toBe(false);
    expect(t.removable.reasons).toEqual([
      "1 of the loans it would remove has been claimed, or moved by something other than a tape.",
      "1 of the loans it would remove has a claim link minted.",
    ]);
    const refused = await remove(b, { confirmLoans: 12, reason: "Re-export" });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("TAPE_NOT_REMOVABLE");
    expect(refused.body.error?.reasons).toEqual(t.removable.reasons);
    expect(refused.body.error?.message).toBe(t.removable.reasons.join(" "));
    expect(await prisma.servicingObservation.count({ where: { importId: b } })).toBe(12);
    expect(await prisma.partnerBookRemoval.count()).toBe(0);
  });

  it("takes back a tape that ended loans only it made, and their ledger goes with them", async () => {
    const id = await load(
      tape("ended.csv", (l) => ({
        servicer_loan_number: number(l.n, 500),
        ...(l.n <= 2 ? { servicing_status: "Paid in Full" } : {}),
      })),
    );
    const paid = await prisma.loan.findMany({
      where: { status: "PAID_OFF" },
      select: { id: true },
    });
    expect(paid).toHaveLength(2);
    const t = (await tapes()).tapes.find((x) => x.id === id)!;
    expect(t.removable).toEqual({ ok: true, reasons: [] });
    expect(t.removes.loans).toBe(12);
    const done = await remove(id, { confirmLoans: 12, reason: "Another servicer's file" });
    expect(done.status).toBe(200);
    expect(done.body.removal?.loansRemoved).toBe(12);
    const gone = paid.map((p) => p.id);
    expect(await prisma.loan.count({ where: { id: { in: gone } } })).toBe(0);
    expect(await prisma.loanTransition.count({ where: { loanId: { in: gone } } })).toBe(0);
  });

  it("is refused when it ended a loan another tape carries, until another tape says so too", async () => {
    await load(TAPE_A);
    const endsLoanOne = (filename: string, asOf: string) =>
      tape(filename, (l) => ({
        as_of_date: asOf,
        servicer_loan_number: number(l.n),
        ...(l.n === 1 ? { servicing_status: "Paid in Full" } : {}),
      }));
    const november = await load(endsLoanOne("november.csv", "2026-11-30"));
    const one = await prisma.loan.findFirstOrThrow({
      where: { servicerLoanNumber: number(1) },
      select: { id: true, status: true },
    });
    expect(one.status).toBe("PAID_OFF");
    const ended =
      "1 loan another tape also carries was ended on this tape's word alone, and an ended loan cannot be reopened.";
    const before = (await tapes()).tapes.find((x) => x.id === november)!;
    expect(before.removable).toEqual({ ok: false, reasons: [ended] });
    expect(before.removes.loans).toBe(0);
    const refused = await remove(november, { confirmLoans: 0, reason: "The wrong month" });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.reasons).toEqual([ended]);
    expect(await prisma.servicingObservation.count({ where: { importId: november } })).toBe(12);

    // December says loan 1 is paid off too: it stays ended on that tape's
    // word, and November can go.
    await load(endsLoanOne("december.csv", "2026-12-31"));
    const after = (await tapes()).tapes.find((x) => x.id === november)!;
    expect(after.removable).toEqual({ ok: true, reasons: [] });
    expect((await remove(november, { confirmLoans: 0, reason: "The wrong month" })).status).toBe(
      200,
    );
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: one.id } })).status).toBe(
      "PAID_OFF",
    );
  });

  it("is refused for a loan with an offer on it", async () => {
    const { b } = await book();
    const obs = await prisma.servicingObservation.findFirstOrThrow({
      where: { importId: b },
      select: { id: true, loanId: true },
    });
    const review = await prisma.loanReview.create({
      data: {
        loanId: obs.loanId,
        observationId: obs.id,
        asOf: new Date("2026-10-26T00:00:00.000Z"),
        verdict: "CANDIDATE",
        reasons: [],
        facts: {},
        offer: {},
        ruleSetVersion: "test",
        explanation: "test",
      },
    });
    await prisma.refiOffer.create({
      data: {
        loanId: obs.loanId,
        reviewId: review.id,
        detectedOn: new Date("2026-10-26T00:00:00.000Z"),
        disclosure: {},
        candidateRatePct: "6.250",
      },
    });
    const refused = await remove(b, { confirmLoans: 12, reason: "Re-export" });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.reasons).toEqual([
      "1 of the loans it would remove has a refinance offer.",
    ]);
  });

  it("is refused for loans a closed month billed, naming the month", async () => {
    const { b } = await book();
    await closeBillingMonth({ month: plainDate("2026-09-01"), closedBy: "job" });
    const t = (await tapes()).tapes.find((x) => x.id === b)!;
    expect(t.removable).toEqual({
      ok: false,
      reasons: ["September 2026 is closed with 12 of these loans."],
    });
    const refused = await remove(b, { confirmLoans: 12, reason: "Re-export" });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe("September 2026 is closed with 12 of these loans.");
  });

  it("is a 404 under another servicer's name, or for a tape nobody loaded", async () => {
    const { b } = await book();
    await call("POST", "/servicers", { slug: "elsewhere", displayName: "Elsewhere" });
    expect((await remove(b, { confirmLoans: 12, reason: "x" }, "elsewhere")).status).toBe(404);
    expect((await remove(b, { confirmLoans: 12, reason: "x" }, "nobody")).status).toBe(404);
    expect(
      (await remove("8a6f3c1e-1111-4222-8333-944455556666", { confirmLoans: 0, reason: "x" }))
        .status,
    ).toBe(404);
    expect((await remove("not-an-id", { confirmLoans: 0, reason: "x" })).status).toBe(404);
    expect(await prisma.servicingObservation.count({ where: { importId: b } })).toBe(12);
  });
});

describe("one writer to a book at a time", () => {
  it("a removal waits for a load under way, and decides on the book the load leaves", async () => {
    const { a, b, servicerId } = await book();
    const seen = await prisma.servicingObservation.findFirstOrThrow({
      where: { importId: b },
      orderBy: { id: "asc" },
      select: {
        loanId: true,
        asOf: true,
        status: true,
        principalBalanceCents: true,
        totalPrincipalBalanceCents: true,
        recordHash: true,
      },
    });
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    // What a load does: holds the book, and observes one of tape B's loans
    // under another tape, not yet committed.
    const writer = prisma.$transaction(
      async (tx) => {
        await lockBook(tx, servicerId);
        await tx.servicingObservation.create({ data: { ...seen, importId: a, facts: {} } });
        holding();
        await released;
      },
      { timeout: 30_000 },
    );
    await held;
    // Twelve was right before the load; the removal must not decide until it commits.
    const removal = remove(b, { confirmLoans: 12, reason: "Re-export of September" });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await writer;
    const r = await removal;
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("CONFIRM_MISMATCH");
    expect(r.body.error?.loansToRemove).toBe(11);
    expect(
      await prisma.servicingObservation.count({ where: { importId: a, loanId: seen.loanId } }),
    ).toBe(1);
    expect(await prisma.loan.count({ where: { id: seen.loanId } })).toBe(1);
  });
});

describe("a tape that would make a loan twice", () => {
  it("is named by the preview and refused at the load, unless the person loading says it is meant", async () => {
    await load(TAPE_A);
    const again = { ...TAPE_B, allowNearDuplicates: undefined };
    const p = await call<{
      counts: { created: number };
      nearDuplicates: { count: number; rows: { row: number; number: string; onBook: string }[] };
    }>("POST", "/preview", again);
    expect(p.status).toBe(200);
    expect(p.body.counts.created).toBe(12);
    expect(p.body.nearDuplicates.count).toBe(12);
    expect(p.body.nearDuplicates.rows[0]).toEqual({
      row: 1,
      number: `00${number(1)}`,
      onBook: number(1),
    });

    const refused = await call<{
      error: { code: string; message: string; nearDuplicates: { count: number } };
    }>("POST", "/imports", again);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("TAPE_NEAR_DUPLICATES");
    expect(refused.body.error.nearDuplicates.count).toBe(12);
    expect(await prisma.loan.count()).toBe(12);
    expect(await prisma.partnerBookImport.count()).toBe(1);

    // The streamed load says the same as its last line.
    const streamed = await fetch(`http://127.0.0.1:${port}/console/hm/tape/imports/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: STAFF_COOKIE },
      body: JSON.stringify(again),
    });
    const last = JSON.parse((await streamed.text()).trim().split("\n").at(-1)!) as {
      kind: string;
      status: number;
      code: string;
    };
    expect(last).toMatchObject({ kind: "error", status: 409, code: "TAPE_NEAR_DUPLICATES" });

    // Said to be meant, it loads.
    expect((await call("POST", "/imports", TAPE_B)).status).toBe(201);
    expect(await prisma.loan.count()).toBe(24);
    // The same tape a second time is the same tape, and the files' own check answers first.
    const twice = await call<{ result: { status: string } }>("POST", "/imports", again);
    expect(twice.status).toBe(200);
    expect(twice.body.result.status).toBe("already_loaded");
  });

  it("names a loan the book holds in scientific notation, and refuses it at the partner's door too", async () => {
    await load(TAPE_A);
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
    // The book as a tape read before the reader spelled numbers plainly left it.
    await prisma.loan.updateMany({
      where: { servicerId: servicer.id, servicerLoanNumber: number(1) },
      data: { servicerLoanNumber: "1.002027991E9" },
    });
    const october = tape("october.csv", (l) => ({
      as_of_date: "2026-10-31",
      servicer_loan_number: number(l.n),
    }));
    const p = await call<{
      counts: { created: number; updated: number };
      nearDuplicates: { count: number; rows: unknown[] };
    }>("POST", "/preview", october);
    expect(p.body.counts).toMatchObject({ created: 1, updated: 11 });
    expect(p.body.nearDuplicates).toEqual({
      count: 1,
      rows: [{ row: 1, number: number(1), onBook: "1.002027991E9" }],
    });

    const { key } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "t" });
    const door = (body: Record<string, unknown>) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/partner/book/imports",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            agent: false,
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (text += c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as never }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    const files = { profile: "m3-v1", tape: october.tape };
    const refused = await door(files);
    expect(refused.status).toBe(409);
    expect((refused.body.error as { code: string }).code).toBe("TAPE_NEAR_DUPLICATES");
    expect(await prisma.partnerBookImport.count()).toBe(1);
    const meant = await door({ ...files, allowNearDuplicates: true });
    expect(meant.status).toBe(201);
    // Both doors write the names the files came under.
    expect(
      (await prisma.partnerBookImport.findMany({ select: { tapeFilename: true } }))
        .map((i) => i.tapeFilename)
        .sort(),
    ).toEqual(["october.csv", "september.csv"]);
  });

  it("refuses the same way at the service, which both doors call", async () => {
    await load(TAPE_A);
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
    await expect(
      importPartnerBook({
        servicerId: servicer.id,
        principalId: await partnerPrincipal(prisma, NORTHLIGHT.slug),
        profile: "m3-v1",
        tape: {
          filename: "again.csv",
          bytes: new TextEncoder().encode(
            csvOf((l) => ({
              servicer_loan_number: `${number(l.n).slice(0, 4)}-${number(l.n).slice(4)}`,
            })),
          ),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "TAPE_NEAR_DUPLICATES" });
  });
});

describe("renumbering a book stored in scientific notation", () => {
  it("says what would change, then rewrites only what lands on no other loan", async () => {
    await load(TAPE_A);
    await load(tape("october.csv", (l) => ({ servicer_loan_number: number(l.n, 1000) })));
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: NORTHLIGHT.slug } });
    const sci = (digits: string) => `${digits[0]}.${digits.slice(1)}E9`;
    // The second tape's loans as a writer that stores numbers as doubles left them:
    // three of them in the digits of tape A's first three loans, the rest in their own.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      await prisma.loan.updateMany({
        where: { servicerId: servicer.id, servicerLoanNumber: number(n, 1000) },
        data: { servicerLoanNumber: sci(n <= 3 ? number(n) : number(n, 1000)) },
      });
    }
    // One of tape A's written with leading zeros: different, and not notation.
    await prisma.loan.updateMany({
      where: { servicerId: servicer.id, servicerLoanNumber: number(10) },
      data: { servicerLoanNumber: `00${number(10)}` },
    });
    const observations = await prisma.servicingObservation.count();

    const dry = await renumberBook({ slug: NORTHLIGHT.slug, apply: false });
    expect(dry).toMatchObject({
      loansOnBook: 24,
      spelledDifferently: 13,
      applied: false,
      renumbered: 0,
    });
    expect(dry.renumberable.map((p) => p.plain).sort()).toEqual(
      [4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => number(n, 1000)).sort(),
    );
    expect(
      dry.collisions.map((p) => [p.number, p.plain, p.collidesWith.map((o) => o.number)]),
    ).toEqual([1, 2, 3].map((n) => [sci(number(n)), number(n), [number(n)]]));
    expect(dry.keptAsWritten.map((k) => k.number)).toEqual([`00${number(10)}`]);
    expect(await prisma.loan.count({ where: { servicerLoanNumber: { contains: "E9" } } })).toBe(12);

    const applied = await renumberBook({ slug: NORTHLIGHT.slug, apply: true });
    expect(applied.renumbered).toBe(9);
    expect(
      (
        await prisma.loan.findMany({
          where: { servicerLoanNumber: { contains: "E9" } },
          select: { servicerLoanNumber: true },
          orderBy: { servicerLoanNumber: "asc" },
        })
      ).map((l) => l.servicerLoanNumber),
    ).toEqual([1, 2, 3].map((n) => sci(number(n))));
    expect(await prisma.loan.count({ where: { servicerLoanNumber: number(4, 1000) } })).toBe(1);
    expect(await prisma.servicingObservation.count()).toBe(observations);
    // Run again, it finds only what it would not touch.
    const again = await renumberBook({ slug: NORTHLIGHT.slug, apply: true });
    expect(again.renumberable).toHaveLength(0);
    expect(again.collisions).toHaveLength(3);
    expect(again.renumbered).toBe(0);
  });

  it('leaves a whole number stored with ".0" until told the book came from workbooks', async () => {
    // Seven digits, as a Java writer stores them in a workbook and the
    // reader kept them before; a CSV saying ".0" is read the same way today.
    const seven = (n: number) => String(1234560 + n);
    await load(tape("september.csv", (l) => ({ servicer_loan_number: `${seven(l.n)}.0` })));
    const workbook = {
      servicer: SERVICER,
      profile: "m3-v1",
      tape: {
        filename: "october.xlsx",
        base64: Buffer.from(
          sampleBook((l) => ({ servicer_loan_number: Number(seven(l.n)) })).tape,
        ).toString("base64"),
      },
    };
    const preview = () =>
      call<{ counts: { created: number }; nearDuplicates: { count: number } }>(
        "POST",
        "/preview",
        workbook,
      );
    // The workbook reads the digits, which the book holds only with the ".0".
    expect((await preview()).body.nearDuplicates.count).toBe(12);

    const untold = await renumberBook({ slug: NORTHLIGHT.slug, apply: true });
    expect(untold.renumbered).toBe(0);
    expect(untold.renumberable).toEqual([]);
    expect(untold.keptAsWritten).toEqual([]);
    expect(untold.pointZeroKept.map((p) => [p.number, p.plain])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [`${seven(n)}.0`, seven(n)]),
    );

    const told = await renumberBook({ slug: NORTHLIGHT.slug, apply: true, pointZero: true });
    expect(told.renumbered).toBe(12);
    expect(told.pointZeroKept).toEqual([]);
    expect(await prisma.loan.count({ where: { servicerLoanNumber: seven(1) } })).toBe(1);
    // The next workbook finds every loan as it is written, and makes none twice.
    const next = await preview();
    expect(next.body.nearDuplicates.count).toBe(0);
    expect(next.body.counts.created).toBe(0);
  });
});

describe("the loans the book is missing", () => {
  it("names every refused row no tape has since carried, and lets one go when a tape does", async () => {
    const { c, d } = await book();
    const r = await tapes();

    // Tape C refused two rows — row 11 carries no number, row 12 no term —
    // and tape D refused nine. None of those loans is on the book, so every
    // one of them is still outstanding.
    expect(r.outstanding).toHaveLength(11);
    expect(r.outstanding.filter((o) => o.tapeId === c)).toHaveLength(2);
    expect(r.outstanding.filter((o) => o.tapeId === d)).toHaveLength(9);

    // The newest tape's gaps read first, and each row says which tape it
    // came from and why it was refused, which is what chasing one needs.
    expect(r.outstanding[0]!.tapeAsOf).toBe("2026-10-31");
    expect(r.outstanding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: number(12, 100),
          code: "no_term",
          column: "Term",
          tapeId: c,
          tapeFilename: "october.csv",
        }),
      ]),
    );

    // The loan refused for a blank term, delivered again with the term filled
    // in. It joins the book and stops being outstanding; the refusal stays on
    // tape C, because that is what tape C did.
    await load(
      tape(
        "october-fixed.csv",
        // Every row numbered, so this delivery refuses nothing of its own:
        // loan 12 under the number tape C could not load, the rest fresh.
        (l) => ({
          as_of_date: "2026-10-31",
          servicer_loan_number: l.n === 12 ? number(12, 100) : number(l.n, 500),
        }),
        { billingMonth: "2026-10" },
      ),
    );
    const after = await tapes();
    expect(after.outstanding.some((o) => o.number === number(12, 100))).toBe(false);
    expect(after.outstanding).toHaveLength(10);
    // Tape C still reports what it refused: history does not change.
    const tc = after.tapes.find((t) => t.id === c)!;
    expect(tc.rowsRefused).toBe(2);
    expect(tc.refused.map((x) => x.code)).toContain("no_term");
  });

  it("is empty for a book every tape loaded whole", async () => {
    await load(TAPE_A);
    const r = await tapes();
    expect(r.tapes).toHaveLength(1);
    expect(r.outstanding).toEqual([]);
  });
});
