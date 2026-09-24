/**
 * A book is a tape, read once.
 *
 * The sample partner's twelve loans through the import service against the
 * real Postgres: what the first tape creates, what a second reading of the
 * same files does (nothing), what a later tape changes, and what a tape
 * that says a loan ended does to its state. Then the same through the
 * partner's own door, with a key.
 */

import express from "express";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import {
  M3_V1,
  NORTHLIGHT,
  NORTHLIGHT_AS_OF,
  sampleBook,
  toCsv,
  type SampleBook,
} from "@hm/partner-book";
import { errorHandler } from "../middleware/error-handler.js";
import { partnerRouter } from "../routes/partner.js";
import { issuePartnerCredential } from "../services/partner-credentials.js";
import { importPartnerBook, rateToBps } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
let seq = 0;

async function northlight() {
  const slug = `northlight-${Date.now().toString(36)}-${(seq += 1)}`;
  const servicer = await prisma.servicer.create({
    data: { slug, displayName: NORTHLIGHT.legal_name },
    select: { id: true, slug: true },
  });
  const principalId = await partnerPrincipal(prisma, slug);
  return { servicer, principalId };
}

function files(book: SampleBook, opts: { csv?: boolean; supplement?: boolean } = {}) {
  return {
    tape: opts.csv
      ? { filename: "northlight.csv", bytes: utf8(book.tapeCsv) }
      : { filename: "northlight.xlsx", bytes: book.tape },
    supplement:
      opts.supplement === false
        ? null
        : { filename: "supplement.csv", bytes: utf8(book.supplement) },
  };
}

async function load(
  who: { servicer: { id: string }; principalId: string },
  book = sampleBook(),
  opts: { csv?: boolean; supplement?: boolean; asOf?: string } = {},
) {
  return importPartnerBook({
    servicerId: who.servicer.id,
    principalId: who.principalId,
    profile: "m3-v1",
    asOf: opts.asOf ?? null,
    ...files(book, opts),
  });
}

describe("the first tape", () => {
  it("makes twelve unclaimed loans on provisional parties, each with the partner's facts", async () => {
    const who = await northlight();
    const r = await load(who);
    expect(r.status).toBe("loaded");
    if (r.status !== "loaded") return;
    expect(r.counts).toEqual({
      rows_total: 12,
      rows_loaded: 12,
      rows_rejected: 0,
      loans_created: 12,
      loans_updated: 0,
      loans_unchanged: 0,
      parties_created: 12,
    });
    expect(r.report.as_of).toBe(NORTHLIGHT_AS_OF);
    expect(r.report.not_on_tape).toEqual([]);

    const loans = await prisma.loan.findMany({
      where: { servicerId: who.servicer.id },
      include: {
        parties: { include: { party: { include: { facts: true } } } },
        observations: true,
      },
      orderBy: { servicerLoanNumber: "asc" },
    });
    expect(loans).toHaveLength(12);
    for (const loan of loans) {
      expect(loan.status).toBe("IMPORTED_UNCLAIMED");
      expect(loan.source).toBe("PARTNER_IMPORT");
      expect(loan.servicerLoanNumber).toMatch(/^NL-1000\d\d$/);
      // Watched from birth: the book is what starts the review, and the
      // claim is the door the person opens to see it.
      expect(loan.monitoringEnabled).toBe(true);
      expect(loan.nextReviewDueAt).not.toBeNull();
      expect(loan.originatingApplicationId).toBeNull();
      expect(loan.parties).toHaveLength(1);
      const party = loan.parties[0]!.party;
      expect(party.claimStatus).toBe("PROVISIONAL");
      expect(party.sourceFirstSeen).toBe(`partner_import:${who.servicer.slug}`);
      const byPredicate = Object.fromEntries(party.facts.map((f) => [f.predicate, f]));
      expect(byPredicate["legal_name"]?.sourceKind).toBe("PARTNER_SHARED");
      expect(byPredicate["legal_name"]?.confidence).toBe("UNVERIFIED");
      expect(byPredicate["legal_name"]?.assertedByPrincipalId).toBe(who.principalId);
      expect(byPredicate["email"]).toBeUndefined();
      expect(byPredicate["phone"]).toBeUndefined();
      expect(loan.observations).toHaveLength(1);
    }

    const one = loans.find((l) => l.servicerLoanNumber === "NL-100001")!;
    expect(one.noteRateBps).toBe(725);
    expect(one.originalPrincipalCents).toBe(45_000_000n);
    expect(one.objective).toBe("PURCHASE");
    expect(one.program).toBe("CONVENTIONAL");
    expect(one.lienPosition).toBe("FIRST");
    expect(one.occupancy).toBe("PRIMARY_RESIDENCE");
    expect(one.propertyCity).toBe("Phoenix");
    const facts = one.parties[0]!.party.facts;
    expect(facts.find((f) => f.predicate === "legal_name")?.value).toEqual({
      first: "Maria",
      last: "Garcia",
    });
    expect(facts.find((f) => f.predicate === "date_of_birth")?.value).toBe("1984-03-14");
    expect(one.observations[0]).toMatchObject({
      status: "CURRENT",
      principalBalanceCents: 44_136_613n,
      scheduledPaymentCents: 368_229n,
      delinquencyDays: 0,
    });
    expect(one.observations[0]!.currentRatePct?.toString()).toBe("7.25");
    expect(one.observations[0]!.asOf.toISOString()).toBe("2026-09-01T00:00:00.000Z");

    const twelve = loans.find((l) => l.servicerLoanNumber === "NL-100012")!;
    expect(twelve.parties[0]!.party.facts.map((f) => f.predicate)).toEqual(["legal_name"]);

    const eight = loans.find((l) => l.servicerLoanNumber === "NL-100008")!;
    expect(eight.observations[0]).toMatchObject({ status: "DELINQUENT", delinquencyDays: 30 });
    expect(eight.status).toBe("IMPORTED_UNCLAIMED");
  });

  it("keeps the rate the servicer stated where the loan's column cannot", () => {
    expect(rateToBps("7.250")).toBe(725);
    expect(rateToBps("6.375")).toBe(638);
  });

  it("writes an import row that names no person's contact", async () => {
    const who = await northlight();
    const r = await load(who);
    if (r.status !== "loaded") throw new Error(r.status);
    const row = await prisma.partnerBookImport.findUniqueOrThrow({ where: { id: r.importId } });
    expect(row.principalId).toBe(who.principalId);
    expect(row.supplementSha256).not.toBe("");
    const text = JSON.stringify(row.report);
    expect(text).not.toMatch(/@example\.com|555-01|5550/);
    expect(row.report).toMatchObject({
      supplement: { rows: 11, ignored_columns: ["borrower_email", "borrower_phone"] },
      gaps: { dob: 1, mailing_address: 12, coborrower: 12 },
    });
  });

  it("reads the same book from CSV", async () => {
    const who = await northlight();
    const r = await load(who, sampleBook(), { csv: true });
    expect(r.status).toBe("loaded");
    expect(await prisma.loan.count({ where: { servicerId: who.servicer.id } })).toBe(12);
  });
});

describe("reading again", () => {
  it("lands the same two files once", async () => {
    const who = await northlight();
    const first = await load(who);
    const again = await load(who);
    expect(again).toEqual({
      status: "already_loaded",
      importId: (first as { importId: string }).importId,
    });
    expect(await prisma.partnerBookImport.count()).toBe(1);
    expect(await prisma.servicingObservation.count()).toBe(12);
    expect(await prisma.party.count()).toBe(12);
  });

  it("appends an observation per loan from a later tape, moves what ended, and reports what is missing", async () => {
    const who = await northlight();
    await load(who);

    // A month later: loan 2 paid off, loan 1's balance moved, loan 12 not on the tape.
    const later = sampleBook((l) => ({
      as_of_date: "2026-10-01",
      ...(l.n === 2 ? { servicing_status: "Paid Off", upb_cents: 0 } : {}),
      ...(l.n === 1 ? { upb_cents: 440000 } : {}),
    }));
    const rows = later.tapeRows.filter((_, i) => i !== 12);
    const r = await importPartnerBook({
      servicerId: who.servicer.id,
      principalId: who.principalId,
      profile: "m3-v1",
      tape: { filename: "october.csv", bytes: utf8(toCsv(rows)) },
      supplement: null,
    });
    expect(r.status).toBe("loaded");
    if (r.status !== "loaded") return;
    expect(r.report.as_of).toBe("2026-10-01");
    expect(r.counts).toMatchObject({
      rows_loaded: 11,
      loans_created: 0,
      loans_updated: 11,
      loans_unchanged: 0,
      parties_created: 0,
    });
    expect(r.report.not_on_tape.map((n) => n.servicer_loan_number)).toEqual(["NL-100012"]);
    expect(r.report.not_on_tape[0]!.last_as_of).toBe("2026-09-01");

    const two = await prisma.loan.findUniqueOrThrow({
      where: {
        servicerId_servicerLoanNumber: {
          servicerId: who.servicer.id,
          servicerLoanNumber: "NL-100002",
        },
      },
      include: { transitions: true, observations: { orderBy: { asOf: "asc" } } },
    });
    expect(two.status).toBe("PAID_OFF");
    expect(two.transitions).toHaveLength(1);
    expect(two.transitions[0]).toMatchObject({
      fromState: "IMPORTED_UNCLAIMED",
      toState: "PAID_OFF",
      event: "payoff_posted",
      reasonCode: "servicer_reported",
      actorPrincipalId: who.principalId,
    });
    expect(two.observations.map((o) => o.status)).toEqual(["CURRENT", "PAID_OFF"]);
    expect(r.report.loans.find((l) => l.servicer_loan_number === "NL-100002")).toMatchObject({
      change: "updated",
      state: "PAID_OFF",
      moved: "payoff_posted",
    });

    // Every loan on the tape got an observation; the same as-of twice does not.
    expect(await prisma.servicingObservation.count()).toBe(23);
    expect(await prisma.party.count()).toBe(12);
    // A name spelled the same way is not a new fact.
    expect(await prisma.fact.count({ where: { predicate: "legal_name" } })).toBe(12);
  });

  it("does not move an unclaimed loan a tape calls transferred, and says so", async () => {
    const who = await northlight();
    await load(who);
    const later = sampleBook((l) => ({
      as_of_date: "2026-10-01",
      ...(l.n === 3 ? { servicing_status: "Service Released" } : {}),
    }));
    const r = await load(who, later);
    if (r.status !== "loaded") throw new Error(r.status);
    const three = r.report.loans.find((l) => l.servicer_loan_number === "NL-100003")!;
    expect(three).toMatchObject({
      state: "IMPORTED_UNCLAIMED",
      moved: "transfer_reported:no_edge",
    });
    const obs = await prisma.servicingObservation.findFirst({
      where: { loan: { servicerLoanNumber: "NL-100003" }, status: "TRANSFERRED" },
    });
    expect(obs).not.toBeNull();
  });

  it("writes nothing for a tape missing a required header", async () => {
    const who = await northlight();
    const rows = sampleBook().tapeRows.map((r) =>
      r.filter((_, i) => M3_V1.columns[i]!.key !== "original_term_months"),
    );
    const r = await importPartnerBook({
      servicerId: who.servicer.id,
      principalId: who.principalId,
      profile: "m3-v1",
      tape: { filename: "bad.csv", bytes: utf8(toCsv(rows)) },
    });
    expect(r).toEqual({ status: "rejected", missing_headers: ["Term"] });
    expect(await prisma.partnerBookImport.count()).toBe(0);
    expect(await prisma.loan.count()).toBe(0);
  });
});

describe("the database", () => {
  it("never overwrites an observation or an import", async () => {
    const who = await northlight();
    const r = await load(who);
    if (r.status !== "loaded") throw new Error(r.status);
    await expect(
      prisma.$executeRaw`UPDATE servicing_observations SET principal_balance_cents = 1 WHERE import_id = ${r.importId}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`UPDATE partner_book_imports SET rows_loaded = 0 WHERE id = ${r.importId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it("keeps one loan per servicer number", async () => {
    const who = await northlight();
    await load(who);
    const one = await prisma.loan.findFirstOrThrow({ where: { servicerLoanNumber: "NL-100001" } });
    await expect(
      prisma.loan.create({
        data: {
          status: "IMPORTED_UNCLAIMED",
          source: "PARTNER_IMPORT",
          servicerId: who.servicer.id,
          servicerLoanNumber: "NL-100001",
          rateType: one.rateType,
          noteRateBps: one.noteRateBps,
          termMonths: one.termMonths,
          originalPrincipalCents: one.originalPrincipalCents,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("the partner's door", () => {
  interface Reply<T = Record<string, unknown>> {
    status: number;
    body: T;
  }

  async function serve() {
    const app = express();
    app.use("/api/partner", partnerRouter);
    app.use(errorHandler);
    const server: Server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    function call<T = Record<string, unknown>>(
      method: "GET" | "POST",
      path: string,
      key: string,
      body?: unknown,
    ): Promise<Reply<T>> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            agent: false,
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: (text ? JSON.parse(text) : {}) as T });
              } catch (err) {
                reject(err);
              }
            });
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  it("takes a tape with a key, lists it, shows it, and hides it from another partner", async () => {
    const who = await northlight();
    const { key } = await issuePartnerCredential(prisma, {
      servicerId: who.servicer.id,
      label: "t",
    });
    const other = await northlight();
    const { key: otherKey } = await issuePartnerCredential(prisma, {
      servicerId: other.servicer.id,
      label: "o",
    });
    const book = sampleBook();
    const s = await serve();
    try {
      const posted = await s.call<{
        status: string;
        importId: string;
        counts: { loans_created: number };
      }>("POST", "/api/partner/book/imports", key, {
        profile: "m3-v1",
        tape: { filename: "northlight.xlsx", base64: b64(book.tape) },
        supplement: { filename: "supplement.csv", base64: b64(utf8(book.supplement)) },
      });
      expect(posted.status).toBe(201);
      expect(posted.body.status).toBe("loaded");
      expect(posted.body.counts.loans_created).toBe(12);

      const again = await s.call<{ status: string }>("POST", "/api/partner/book/imports", key, {
        profile: "m3-v1",
        tape: { filename: "northlight.xlsx", base64: b64(book.tape) },
        supplement: { filename: "supplement.csv", base64: b64(utf8(book.supplement)) },
      });
      expect(again.status).toBe(200);
      expect(again.body.status).toBe("already_loaded");

      const list = await s.call<{ imports: { id: string }[] }>(
        "GET",
        "/api/partner/book/imports",
        key,
      );
      expect(list.status).toBe(200);
      expect(list.body.imports.map((i) => i.id)).toEqual([posted.body.importId]);

      const one = await s.call<{ report: { loans: unknown[] } }>(
        "GET",
        `/api/partner/book/imports/${posted.body.importId}`,
        key,
      );
      expect(one.status).toBe(200);
      expect(one.body.report.loans).toHaveLength(12);

      const stranger = await s.call(
        "GET",
        `/api/partner/book/imports/${posted.body.importId}`,
        otherKey,
      );
      expect(stranger.status).toBe(404);

      const status = await s.call<{ imports: number; lastAsOf: string; loans: { total: number } }>(
        "GET",
        "/api/partner/book/status",
        key,
      );
      expect(status.body).toMatchObject({
        imports: 1,
        lastAsOf: NORTHLIGHT_AS_OF,
        loans: { total: 12 },
      });
      expect(
        (await s.call<{ loans: { total: number } }>("GET", "/api/partner/book/status", otherKey))
          .body.loans.total,
      ).toBe(0);
    } finally {
      await s.close();
    }
  });

  it("answers a tape it cannot read with what is missing, and an unknown profile with a 400", async () => {
    const who = await northlight();
    const { key } = await issuePartnerCredential(prisma, {
      servicerId: who.servicer.id,
      label: "t",
    });
    const rows = sampleBook().tapeRows.map((r) =>
      r.filter((_, i) => M3_V1.columns[i]!.key !== "original_term_months"),
    );
    const s = await serve();
    try {
      const rejected = await s.call<{ status: string; missing_headers: string[] }>(
        "POST",
        "/api/partner/book/imports",
        key,
        { profile: "m3-v1", tape: { filename: "bad.csv", base64: b64(utf8(toCsv(rows))) } },
      );
      expect(rejected.status).toBe(422);
      expect(rejected.body).toEqual({ status: "rejected", missing_headers: ["Term"] });

      const unknown = await s.call<{ error: { code: string } }>(
        "POST",
        "/api/partner/book/imports",
        key,
        {
          profile: "m4-v9",
          tape: { filename: "t.csv", base64: b64(utf8("a,b\r\n1,2\r\n")) },
        },
      );
      expect(unknown.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});

describe("a real book's size", () => {
  /** The sample's twelve loans, each cloned `times` over under numbers of its own. */
  function bigTape(times: number, override?: Parameters<typeof sampleBook>[0]): Uint8Array {
    const book = sampleBook(override);
    const [header, ...rows] = book.tapeRows;
    const numberAt = M3_V1.columns.findIndex((c) => c.key === "servicer_loan_number");
    const cloned = rows.flatMap((row) =>
      Array.from({ length: times }, (_, k) => {
        const copy = [...row];
        copy[numberAt] = `${String(row[numberAt])}-${k}`;
        return copy;
      }),
    );
    return utf8(toCsv([header!, ...cloned]));
  }

  it("loads twelve hundred loans as sets, and repeats none of their facts on the next tape", async () => {
    const who = await northlight();
    const tape = { filename: "big.csv", bytes: bigTape(100) };
    const first = await importPartnerBook({
      servicerId: who.servicer.id,
      principalId: who.principalId,
      profile: "m3-v1",
      tape,
      supplement: null,
    });
    expect(first.status).toBe("loaded");
    if (first.status !== "loaded") return;
    expect(first.counts).toEqual({
      rows_total: 1200,
      rows_loaded: 1200,
      rows_rejected: 0,
      loans_created: 1200,
      loans_updated: 0,
      loans_unchanged: 0,
      parties_created: 1200,
    });
    const where = { loan: { servicerId: who.servicer.id } };
    expect(await prisma.loanParty.count({ where })).toBe(1200);
    expect(await prisma.servicingObservation.count({ where })).toBe(1200);
    // One name per person, no supplement so no date of birth.
    const facts = () =>
      prisma.fact.count({
        where: { sourceKind: "PARTNER_SHARED", assertedByPrincipalId: who.principalId },
      });
    expect(await facts()).toBe(1200);

    // The same book a month later: every loan known, every name the same,
    // so twelve hundred observations and not one fact more.
    const again = await importPartnerBook({
      servicerId: who.servicer.id,
      principalId: who.principalId,
      profile: "m3-v1",
      tape: {
        filename: "big-october.csv",
        bytes: bigTape(100, () => ({ as_of_date: "2026-10-01" })),
      },
      supplement: null,
    });
    expect(again.status).toBe("loaded");
    if (again.status !== "loaded") return;
    expect(again.counts.loans_created).toBe(0);
    expect(again.counts.loans_updated + again.counts.loans_unchanged).toBe(1200);
    expect(again.counts.parties_created).toBe(0);
    expect(await prisma.servicingObservation.count({ where })).toBe(2400);
    expect(await facts()).toBe(1200);
  });

  it("loads a row whose cell it cannot read, as an exception and not a rejection", async () => {
    const who = await northlight();
    const book = sampleBook((l) => (l.n === 2 ? { fico_current_date: "not a date" } : {}));
    const r = await load(who, book, { csv: true });
    expect(r.status).toBe("loaded");
    if (r.status !== "loaded") return;
    expect(r.counts.rows_loaded).toBe(12);
    expect(r.counts.rows_rejected).toBe(0);
    expect(r.report.exceptions).toEqual([
      expect.objectContaining({
        code: "unreadable_cell",
        column: "Current Fico Date",
        servicer_loan_number: "NL-100002",
      }),
    ]);
  });
});
