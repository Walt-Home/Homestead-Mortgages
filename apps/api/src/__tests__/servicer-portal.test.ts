/**
 * The partner portal's door, end to end against Postgres: ops invites a
 * servicer's person, the link sets a password and signs them in, a later
 * sign-in is a code and the password, and what they see is their book and
 * nobody else's — the loans, each loan's page, what the book is billed —
 * and a team they can grow and prune.
 *
 * And the two sessions never cross: a borrower's session opens nothing of
 * the portal, a member's opens nothing of the borrower app. `index.ts`
 * mounts the portal above `requireAuth`; this file arranges the same and
 * probes both sides.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { FixtureMailConnector } from "@hm/connectors";
import { NORTHLIGHT, sampleAsOfFor, sampleBook } from "@hm/partner-book";
import { errorHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { servicerPortalRouter } from "../routes/servicer-portal.js";
import { closeBillingMonth } from "../services/billing.js";
import { connectors } from "../services/connectors.js";
import {
  inviteServicerTeam,
  PASSWORD_ATTEMPTS,
  verifyPassword,
  hashPassword,
} from "../services/servicer-team.js";
import { loadTape, reviewBook } from "../services/tape-desk.js";
import { dayEt } from "../services/refi-offers.js";
import { createUser } from "./support/factories.js";

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The same session shape `index.ts` mounts, on an in-memory store: the
  // real one keeps its table outside the migrations, and this suite's
  // drift test reads the test database as the migrations left it.
  app.use(
    session({
      secret: "test",
      resave: false,
      saveUninitialized: false,
      cookie: { sameSite: "lax" },
    }),
  );
  // A borrower session, for the crossing tests: what /api/auth would mint.
  app.post("/test/borrower-session", (req, res) => {
    req.session.userId = String(req.body.userId);
    req.session.secondFactor = "exempt";
    res.status(201).end();
  });
  app.use("/api/servicer", servicerPortalRouter);
  app.use("/api", requireAuth);
  app.get("/api/probe", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  server = createServer(app).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** One browser: a cookie jar and calls that carry it. */
function agent() {
  let cookie = "";
  return async <T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as T };
  };
}

const outbox = () => (connectors().mail as FixtureMailConnector).outbox;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const utf8 = (s: string) => new TextEncoder().encode(s);
const PASSWORD = "correct horse battery staple 22";

async function loadNorthlight() {
  // Reviewed as of today, so as of this month; pinned to September the
  // book reads as a day past due from the second of October.
  const book = sampleBook(() => ({}), { asOf: sampleAsOfFor(dayEt(new Date())) });
  const loaded = await loadTape({
    servicer: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name },
    profile: "m3-v1",
    asOf: null,
    tape: {
      filename: "northlight.xlsx",
      bytes: new Uint8Array(Buffer.from(b64(book.tape), "base64")),
    },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  expect(loaded.result.status).toBe("loaded");
}

/** Invite one address and read the token out of the mail, as the person would. */
async function invite(email: string, slug: string = NORTHLIGHT.slug) {
  const before = outbox().length;
  const [outcome] = await inviteServicerTeam({
    servicerSlug: slug,
    invitations: [{ email, name: "Ada" }],
    invitedBy: "staff-1",
  });
  expect(outcome!.status).toBe("sent");
  expect(outbox().length).toBe(before + 1);
  const mail = outbox().at(-1)!;
  expect(mail.to).toBe(email);
  const link = mail.text.match(/https?:\/\/\S+/)![0];
  expect(link).toContain("/accept#");
  return link.split("#")[1]!;
}

async function member(email = "ada@northlight.example") {
  await loadNorthlight();
  const token = await invite(email);
  const call = agent();
  const accepted = await call("POST", "/api/servicer/auth/accept", { token, password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { call, token, email };
}

beforeEach(() => {
  outbox().length = 0;
});

describe("the invitation", () => {
  it("is a link that sets the password and signs the person in, once", async () => {
    await loadNorthlight();
    const token = await invite("ada@northlight.example");
    const call = agent();

    const preview = await call("POST", "/api/servicer/auth/invitation", { token });
    expect(preview.status).toBe(200);
    expect(preview.body.servicerName).toBe(NORTHLIGHT.legal_name);
    expect(preview.body.email).toBe("ada@northlight.example");

    const weak = await call("POST", "/api/servicer/auth/accept", { token, password: "short" });
    expect(weak.status).toBe(422);
    expect((weak.body.error as { code: string }).code).toBe("PASSWORD_WEAK");

    const accepted = await call("POST", "/api/servicer/auth/accept", { token, password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect((accepted.body.servicer as { slug: string }).slug).toBe(NORTHLIGHT.slug);

    const me = await call("GET", "/api/servicer/me");
    expect(me.status).toBe(200);
    expect((me.body.user as { email: string }).email).toBe("ada@northlight.example");

    // The token is spent; the same link is dead for the next holder.
    const again = await agent()("POST", "/api/servicer/auth/accept", { token, password: PASSWORD });
    expect(again.status).toBe(404);
    expect((await agent()("POST", "/api/servicer/auth/invitation", { token })).status).toBe(404);

    const row = await prisma.servicerUser.findUniqueOrThrow({
      where: { email: "ada@northlight.example" },
    });
    expect(row.inviteTokenHash).toBeNull();
    expect(row.acceptedAt).not.toBeNull();
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, row.passwordHash!)).toBe(true);
    expect(await verifyPassword("something else", row.passwordHash!)).toBe(false);
  });

  it("re-sent, kills the earlier link; taken, it is left alone", async () => {
    await loadNorthlight();
    const first = await invite("ada@northlight.example");
    const second = await invite("ada@northlight.example");
    expect((await agent()("POST", "/api/servicer/auth/invitation", { token: first })).status).toBe(
      404,
    );
    expect((await agent()("POST", "/api/servicer/auth/invitation", { token: second })).status).toBe(
      200,
    );
    await agent()("POST", "/api/servicer/auth/accept", { token: second, password: PASSWORD });
    const [outcome] = await inviteServicerTeam({
      servicerSlug: NORTHLIGHT.slug,
      invitations: [{ email: "ADA@northlight.example " }],
      invitedBy: "staff-1",
    });
    expect(outcome!.status).toBe("already_member");
  });

  it("answers one outcome per address, and an address belongs to one team", async () => {
    await loadNorthlight();
    await prisma.servicer.create({ data: { slug: "other", displayName: "Other Servicing" } });
    await invite("ada@northlight.example");
    const outcomes = await inviteServicerTeam({
      servicerSlug: "other",
      invitations: [
        { email: "ada@northlight.example" },
        { email: "not an address" },
        { email: "bob@other.example" },
        { email: "bob@other.example" },
      ],
      invitedBy: "staff-1",
    });
    expect(outcomes.map((o) => o.status)).toEqual([
      "on_another_team",
      "invalid",
      "sent",
      "invalid",
    ]);
  });
});

describe("signing in", () => {
  it("is a code to the address and then the password, and the session opens the book", async () => {
    const { email } = await member();
    const call = agent();

    const asked = await call("POST", "/api/servicer/auth/code", { email: email.toUpperCase() });
    expect(asked.status).toBe(200);
    // The test mailer is a stand-in, so the code is echoed and also mailed.
    const code = asked.body.fake_code as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(outbox().at(-1)!.text).toContain(code);

    // Nothing is open on the code alone.
    expect((await call("GET", "/api/servicer/me")).status).toBe(401);
    const verified = await call("POST", "/api/servicer/auth/verify", { email, code });
    expect(verified.status).toBe(200);
    expect((await call("GET", "/api/servicer/me")).status).toBe(401);

    const wrong = await call("POST", "/api/servicer/auth/signin", { password: "not it at all" });
    expect(wrong.status).toBe(401);
    expect((wrong.body.error as { code: string }).code).toBe("PASSWORD_WRONG");

    const ok = await call("POST", "/api/servicer/auth/signin", { password: PASSWORD });
    expect(ok.status).toBe(201);
    const me = await call("GET", "/api/servicer/me");
    expect(me.status).toBe(200);

    const book = await call("GET", "/api/servicer/book");
    expect(book.status).toBe(200);
    expect((book.body.book as { loans: { total: number } }).loans.total).toBe(12);
    const loans = await call<{
      total: number;
      rows: { number: string; borrower: string | null }[];
    }>("GET", "/api/servicer/book/loans?q=NL-1000");
    expect(loans.body.total).toBe(12);
    expect(loans.body.rows[0]!.number).toBe("NL-100001");
    expect(loans.body.rows[0]!.borrower).toBeTruthy();
    const team = await call<{ team: { email: string; standing: string }[] }>(
      "GET",
      "/api/servicer/team",
    );
    expect(team.body.team).toEqual([expect.objectContaining({ email, standing: "active" })]);

    expect((await call("DELETE", "/api/servicer/auth/session")).status).toBe(204);
    expect((await call("GET", "/api/servicer/me")).status).toBe(401);
  });

  it("answers a stranger's address like a member's, and a wrong or spent code alike", async () => {
    const { email } = await member();
    const stranger = await agent()("POST", "/api/servicer/auth/code", {
      email: "nobody@example.com",
    });
    expect(stranger.status).toBe(200);
    expect(stranger.body.fake_code).toBeUndefined();
    const call = agent();
    const asked = await call("POST", "/api/servicer/auth/code", { email });
    const code = asked.body.fake_code as string;
    const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const wrong = await call("POST", "/api/servicer/auth/verify", { email, code: wrongCode });
    expect(wrong.status).toBe(401);
    expect((wrong.body.error as { code: string }).code).toBe("OTP_INVALID");
    expect((await call("POST", "/api/servicer/auth/verify", { email, code })).status).toBe(200);
    // Spent.
    const spent = await agent()("POST", "/api/servicer/auth/verify", { email, code });
    expect(spent.status).toBe(401);
    expect((spent.body.error as { code: string }).code).toBe("OTP_INVALID");
  });

  it("locks the account after five wrong passwords and says until when", async () => {
    const { email } = await member();
    const call = agent();
    const code = (await call("POST", "/api/servicer/auth/code", { email })).body
      .fake_code as string;
    await call("POST", "/api/servicer/auth/verify", { email, code });
    let last: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < PASSWORD_ATTEMPTS; i++) {
      last = await call("POST", "/api/servicer/auth/signin", { password: `wrong ${i}` });
    }
    expect(last!.status).toBe(401);
    expect((last!.body.error as { locked_until?: string }).locked_until).toMatch(/^\d{4}-/);
    const locked = await call("POST", "/api/servicer/auth/signin", { password: PASSWORD });
    expect(locked.status).toBe(423);
    expect((locked.body.error as { code: string }).code).toBe("ACCOUNT_LOCKED");
  });
});

describe("the two sessions never cross", () => {
  it("a borrower's session opens nothing of the portal", async () => {
    const user = await createUser();
    const call = agent();
    await call("POST", "/test/borrower-session", { userId: user.id });
    expect((await call("GET", "/api/probe")).status).toBe(200);
    expect((await call("GET", "/api/servicer/me")).status).toBe(401);
    expect((await call("GET", "/api/servicer/book")).status).toBe(401);
  });

  it("a member's session opens nothing of the borrower app", async () => {
    const { call } = await member();
    expect((await call("GET", "/api/servicer/me")).status).toBe(200);
    const probe = await call("GET", "/api/probe");
    expect(probe.status).toBe(401);
  });

  it("a member sees their servicer's book and no other", async () => {
    const { call } = await member();
    await prisma.servicer.create({ data: { slug: "other", displayName: "Other Servicing" } });
    const token = await invite("bob@other.example", "other");
    const bob = agent();
    expect(
      (await bob("POST", "/api/servicer/auth/accept", { token, password: PASSWORD })).status,
    ).toBe(201);
    const theirs = await bob<{ total: number }>("GET", "/api/servicer/book/loans");
    expect(theirs.body.total).toBe(0);
    const ours = await call<{ total: number }>("GET", "/api/servicer/book/loans");
    expect(ours.body.total).toBe(12);
  });
});

describe("a member's team", () => {
  it("is theirs to grow: an invitation from a member lands on their own servicer, signed as theirs", async () => {
    const { call } = await member();
    const before = outbox().length;
    const r = await call<{ outcomes: { email: string; status: string }[] }>(
      "POST",
      "/api/servicer/team",
      { invitations: [{ email: "colleague@northlight.example", name: "Col" }] },
    );
    expect(r.status).toBe(201);
    expect(r.body.outcomes[0]!.status).toBe("sent");
    expect(outbox().length).toBe(before + 1);
    expect(outbox().at(-1)!.text).toContain("/console/accept#");
    const row = await prisma.servicerUser.findUniqueOrThrow({
      where: { email: "colleague@northlight.example" },
      include: { servicer: { select: { slug: true } } },
    });
    expect(row.servicer.slug).toBe(NORTHLIGHT.slug);
    expect(row.invitedBy).toMatch(/^member:/);
    const team = await call<{ team: { email: string; standing: string }[] }>(
      "GET",
      "/api/servicer/team",
    );
    expect(team.body.team.map((m) => m.standing).sort()).toEqual(["active", "invited"]);
    // Nobody signed out can.
    const stranger = await agent()("POST", "/api/servicer/team", {
      invitations: [{ email: "x@y.example" }],
    });
    expect(stranger.status).toBe(401);
  });

  it("says which door an address belongs at without looking anything up", async () => {
    const r = await agent()<{ internalDomains: string[] }>("GET", "/api/servicer/auth/door");
    expect(r.status).toBe(200);
    expect(r.body.internalDomains).toContain("supermortgage.com");
  });
});

/** A second servicer with one member, signed in: the stranger every "theirs and no other" test needs. */
async function strangerAt(slug = "other") {
  await prisma.servicer.create({ data: { slug, displayName: "Other Servicing" } });
  const token = await invite(`bob@${slug}.example`, slug);
  const bob = agent();
  expect(
    (await bob("POST", "/api/servicer/auth/accept", { token, password: PASSWORD })).status,
  ).toBe(201);
  return bob;
}

interface LoanPage {
  loan: {
    id: string;
    number: string;
    borrower: string | null;
    state: string;
    watchedSince: string;
    address: { line1: string | null; city: string | null; state: string | null };
    terms: { noteRatePct: string; termMonths: number; originalPrincipalCents: string };
    tapes: { asOf: string; status: string; principalBalanceCents: string }[];
    reviews: {
      asOf: string;
      verdict: string;
      reasons: string[];
      candidateRatePct: string | null;
    }[];
    offers: { status: string; deliveredAt: string | null; newRatePct: string }[];
    claim: { deliveredTo: string | null } | null;
  };
}

describe("a loan's page", () => {
  it("carries the tape, the reviews and the offer for a loan on their book", async () => {
    const { call } = await member();
    await reviewBook({ servicerSlug: NORTHLIGHT.slug });
    const list = await call<{ rows: { id: string; number: string }[] }>(
      "GET",
      "/api/servicer/book/loans",
    );
    const row = list.body.rows.find((r) => r.number === "NL-100001")!;
    const page = await call<LoanPage>("GET", `/api/servicer/book/loans/${row.id}`);
    expect(page.status).toBe(200);
    const { loan } = page.body;
    expect(loan.number).toBe("NL-100001");
    expect(loan.borrower).toBeTruthy();
    expect(loan.state).toBe("imported_unclaimed");
    expect(loan.watchedSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(loan.address.line1).toBeTruthy();
    expect(loan.terms.noteRatePct).toBe("7.250");
    expect(loan.tapes).toHaveLength(1);
    expect(loan.tapes[0]!.status).toBe("current");
    expect(Number(loan.tapes[0]!.principalBalanceCents)).toBeGreaterThan(0);
    // The fixture sheet quotes 6.25 %: loan 1 at 7.25 % is a candidate, its
    // reasons in words, its offer made and waiting for the claim.
    expect(loan.reviews).toHaveLength(1);
    expect(loan.reviews[0]!.verdict).toBe("candidate");
    expect(loan.reviews[0]!.reasons.length).toBeGreaterThan(0);
    expect(loan.reviews[0]!.reasons.every((r) => !r.includes("_"))).toBe(true);
    expect(loan.offers).toHaveLength(1);
    expect(loan.offers[0]!.status).toBe("offered");
    expect(loan.offers[0]!.deliveredAt).toBeNull();
    expect(loan.offers[0]!.newRatePct).toBe(loan.reviews[0]!.candidateRatePct);
    expect(loan.claim).toBeNull();
  });

  it("is a 404 for another servicer's loan, exactly as for a loan that does not exist", async () => {
    const { call } = await member();
    const list = await call<{ rows: { id: string }[] }>("GET", "/api/servicer/book/loans");
    const theirs = list.body.rows[0]!.id;
    const bob = await strangerAt();
    const stranger = await bob<{ error: { code: string } }>(
      "GET",
      `/api/servicer/book/loans/${theirs}`,
    );
    const missing = await bob<{ error: { code: string } }>(
      "GET",
      `/api/servicer/book/loans/${randomUUID()}`,
    );
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
    expect((await call("GET", "/api/servicer/book/loans/not-an-id")).status).toBe(404);
    expect((await agent()("GET", `/api/servicer/book/loans/${theirs}`)).status).toBe(401);
  });
});

interface BillingPage {
  servicer: { displayName: string; since: string | null };
  current: {
    standing: string;
    closedAt: string | null;
    statement: { month: string; loansOnBook: number; loans: unknown[] };
  };
  invoices: { month: string; tokens: string; cents: string; closedAt: string }[];
}

describe("what the book is billed", () => {
  it("is this month running and every closed month, theirs alone, without who closed it", async () => {
    const { call } = await member();
    const bob = await strangerAt();
    const closed = await closeBillingMonth({ closedBy: "staff-who-closed-it" });

    const mine = await call<BillingPage>("GET", "/api/servicer/billing");
    expect(mine.status).toBe(200);
    expect(mine.body.servicer.displayName).toBe(NORTHLIGHT.legal_name);
    expect(mine.body.current.standing).toBe("running");
    expect(mine.body.current.closedAt).toBeNull();
    expect(mine.body.current.statement.loansOnBook).toBe(12);
    expect(mine.body.invoices.map((i) => i.month)).toEqual([closed.month]);
    expect(JSON.stringify(mine.body)).not.toContain("staff-who-closed-it");
    expect(JSON.stringify(mine.body)).not.toContain("closedBy");

    const invoice = await call<BillingPage["current"]>(
      "GET",
      `/api/servicer/billing/statements/${closed.month}`,
    );
    expect(invoice.status).toBe(200);
    expect(invoice.body.standing).toBe("closed");
    expect(invoice.body.closedAt).toMatch(/^\d{4}-/);
    expect(invoice.body.statement.month).toBe(closed.month);
    expect(JSON.stringify(invoice.body)).not.toContain("staff-who-closed-it");

    // The other servicer's member reads the other servicer's, which has no book.
    const theirs = await bob<BillingPage>("GET", "/api/servicer/billing");
    expect(theirs.body.servicer.displayName).toBe("Other Servicing");
    expect(theirs.body.current.statement.loansOnBook).toBe(0);
    expect(theirs.body.current.statement.loans).toEqual([]);

    expect((await call("GET", "/api/servicer/billing/statements/last-month")).status).toBe(400);
    expect((await agent()("GET", "/api/servicer/billing")).status).toBe(401);
  });
});

describe("removing a member", () => {
  /** Ada, signed in, and a colleague she invited who took the link. */
  async function pair() {
    const ada = await member();
    await ada.call("POST", "/api/servicer/team", {
      invitations: [{ email: "col@northlight.example", name: "Col" }],
    });
    const token = outbox()
      .at(-1)!
      .text.match(/https?:\/\/\S+/)![0]
      .split("#")[1]!;
    const col = agent();
    expect(
      (await col("POST", "/api/servicer/auth/accept", { token, password: PASSWORD })).status,
    ).toBe(201);
    const team = await ada.call<{ team: { id: string; email: string }[] }>(
      "GET",
      "/api/servicer/team",
    );
    const id = (email: string) => team.body.team.find((m) => m.email === email)!.id;
    return { ada: ada.call, col, adaId: id(ada.email), colId: id("col@northlight.example") };
  }

  it("ends their session at once, takes them off the list, and records who did it", async () => {
    const { ada, col, adaId, colId } = await pair();
    expect((await col("GET", "/api/servicer/book")).status).toBe(200);

    expect((await ada("DELETE", `/api/servicer/team/${colId}`)).status).toBe(204);

    expect((await col("GET", "/api/servicer/book")).status).toBe(401);
    expect((await col("GET", "/api/servicer/me")).status).toBe(401);
    const team = await ada<{ team: { email: string }[] }>("GET", "/api/servicer/team");
    expect(team.body.team.map((m) => m.email)).toEqual(["ada@northlight.example"]);
    const row = await prisma.servicerUser.findUniqueOrThrow({ where: { id: colId } });
    expect(row.disabledAt).not.toBeNull();
    expect(row.disabledBy).toBe(`member:${adaId}`);
    // No code for somebody removed, and the door answers as it does a stranger.
    const asked = await agent()("POST", "/api/servicer/auth/code", {
      email: "col@northlight.example",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.fake_code).toBeUndefined();
    // Gone is gone: a second removal finds nobody.
    expect((await ada("DELETE", `/api/servicer/team/${colId}`)).status).toBe(404);
  });

  it("kills an invitation that was not yet taken, and a fresh one is the way back", async () => {
    const { call } = await member();
    await call("POST", "/api/servicer/team", {
      invitations: [{ email: "late@northlight.example" }],
    });
    const token = outbox()
      .at(-1)!
      .text.match(/https?:\/\/\S+/)![0]
      .split("#")[1]!;
    const row = await prisma.servicerUser.findUniqueOrThrow({
      where: { email: "late@northlight.example" },
    });
    expect((await call("DELETE", `/api/servicer/team/${row.id}`)).status).toBe(204);
    expect((await agent()("POST", "/api/servicer/auth/invitation", { token })).status).toBe(404);
    expect(
      (await agent()("POST", "/api/servicer/auth/accept", { token, password: PASSWORD })).status,
    ).toBe(404);

    const again = await call<{ outcomes: { status: string }[] }>("POST", "/api/servicer/team", {
      invitations: [{ email: "late@northlight.example" }],
    });
    expect(again.body.outcomes[0]!.status).toBe("sent");
    const back = await prisma.servicerUser.findUniqueOrThrow({ where: { id: row.id } });
    expect(back.disabledAt).toBeNull();
    expect(back.disabledBy).toBeNull();
  });

  it("is never of oneself, so a team cannot remove its way down to nobody", async () => {
    const { ada, adaId } = await pair();
    const self = await ada<{ error: { code: string } }>("DELETE", `/api/servicer/team/${adaId}`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("CANNOT_REMOVE_SELF");
    expect((await ada("GET", "/api/servicer/me")).status).toBe(200);
  });

  it("reaches nobody on another servicer's team, and says only that nobody is there", async () => {
    const { ada, colId } = await pair();
    const bob = await strangerAt();
    const crossed = await bob("DELETE", `/api/servicer/team/${colId}`);
    expect(crossed.status).toBe(404);
    expect(crossed.body).toEqual((await bob("DELETE", `/api/servicer/team/${randomUUID()}`)).body);
    expect((await bob("DELETE", "/api/servicer/team/not-an-id")).status).toBe(404);
    const row = await prisma.servicerUser.findUniqueOrThrow({ where: { id: colId } });
    expect(row.disabledAt).toBeNull();
    expect((await agent()("DELETE", `/api/servicer/team/${colId}`)).status).toBe(401);
    expect((await ada("GET", "/api/servicer/team")).status).toBe(200);
  });
});

describe("passwords", () => {
  it("are scrypt with a salt, never the text", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, "not a hash")).toBe(false);
  });
});
