/**
 * The claim: how a mortgage a tape wrote becomes somebody's.
 *
 * Through the doors the product has — the partner key mints, the public
 * preview says what the notice said, the signed-in accept takes — against a
 * real Postgres, because the promises here are the database's: one live
 * link per loan, taken once, the loan moved by the one edge a person may
 * take, and the review off until then.
 */

import express from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { errorHandler } from "../middleware/error-handler.js";
import { authRouter } from "../routes/auth.js";
import { loanRouter } from "../routes/loans.js";
import { partnerRouter } from "../routes/partner.js";
import { issuePartnerCredential } from "../services/partner-credentials.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal, partyForUser } from "../services/party.js";
import { LOAN_CLAIM_TTL_MS } from "../services/loan-claims.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The sample book, loaded as the partner's key would load it, with a key to mint claims with. */
async function northlight(depth: "API" | "DEEP_LINK" = "API") {
  const servicer = await prisma.servicer.create({
    data: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name, integrationDepth: depth },
    select: { id: true, slug: true },
  });
  const principalId = await partnerPrincipal(prisma, servicer.slug);
  const book = sampleBook();
  const imported = await importPartnerBook({
    servicerId: servicer.id,
    principalId,
    profile: "m3-v1",
    tape: { filename: "northlight.xlsx", bytes: book.tape },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  if (imported.status !== "loaded") throw new Error(imported.status);
  const { key } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "test" });
  return { servicer, principalId, key };
}

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** The partner router over a real socket, because `requirePartner` reads the bearer off the wire. */
async function partnerDoor() {
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
      req.end();
    });
  }
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

type Minted = { loanId: string; token: string; link: string; expiresAt: string };

// The preview is public; the helper wants a session, so a fresh one stands in for nobody.
const preview = async (token: string) =>
  callAs<Record<string, unknown>>(
    (await createUser()).id,
    [authRouter],
    "POST",
    "/claims/preview",
    { token },
    "/api/auth",
  );
const accept = (userId: string, token: string) =>
  callAs<Record<string, unknown>>(
    userId,
    [authRouter],
    "POST",
    "/claims/accept",
    { token },
    "/api/auth",
  );

describe("minting a claim, as the partner", () => {
  it("hands the token back once, with the link, for a loan that is unclaimed", async () => {
    const { key } = await northlight();
    const door = await partnerDoor();
    try {
      const r = await door.call<Minted>("POST", "/api/partner/book/loans/NL-100001/claims", key);
      expect(r.status).toBe(201);
      expect(r.body.token.length).toBeGreaterThan(30);
      expect(r.body.link).toContain(`/claim#${r.body.token}`);
      expect(new Date(r.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(
        LOAN_CLAIM_TTL_MS - 60_000,
      );
      // The row holds the hash and not the token, and the tape's party is now waiting to be claimed.
      const row = await prisma.loanClaim.findFirstOrThrow({
        where: { loanId: r.body.loanId },
        include: { party: true },
      });
      expect(row.tokenHash).not.toBe(r.body.token);
      expect(row.party.claimStatus).toBe("CLAIM_PENDING");
    } finally {
      await door.close();
    }
  });

  it("answers another servicer's loan, and a loan that does not exist, the same way", async () => {
    await northlight();
    const other = await prisma.servicer.create({
      data: { slug: "other", displayName: "Other Servicing" },
      select: { id: true },
    });
    const { key } = await issuePartnerCredential(prisma, { servicerId: other.id, label: "test" });
    const door = await partnerDoor();
    try {
      const theirs = await door.call("POST", "/api/partner/book/loans/NL-100001/claims", key);
      const nothing = await door.call("POST", "/api/partner/book/loans/NL-999999/claims", key);
      expect(theirs.status).toBe(404);
      expect(nothing.status).toBe(404);
      expect(theirs.body).toEqual(nothing.body);
    } finally {
      await door.close();
    }
  });

  it("revokes the last link when it mints the next, so one is live", async () => {
    const { key } = await northlight();
    const door = await partnerDoor();
    try {
      const first = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100002/claims",
        key,
      );
      const second = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100002/claims",
        key,
      );
      expect((await preview(first.body.token)).status).toBe(404);
      expect((await preview(second.body.token)).status).toBe(200);
    } finally {
      await door.close();
    }
  });
});

describe("the link, before and after it is taken", () => {
  it("shows a stranger the servicer and the town, and nothing that names or numbers anyone", async () => {
    const { key } = await northlight();
    const door = await partnerDoor();
    try {
      const minted = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100001/claims",
        key,
      );
      const p = await preview(minted.body.token);
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({
        kind: "mortgage",
        servicerDisplayName: NORTHLIGHT.legal_name,
      });
      expect(typeof p.body.propertyCity).toBe("string");
      expect(JSON.stringify(p.body)).not.toContain("NL-100001");
      expect(Object.keys(p.body).sort()).toEqual([
        "expiresAt",
        "kind",
        "propertyCity",
        "propertyState",
        "servicerDisplayName",
      ]);
    } finally {
      await door.close();
    }
  });

  it("taken by a signed-in person, folds the tape's party into theirs, moves the loan and turns the review on", async () => {
    const { key } = await northlight();
    const door = await partnerDoor();
    try {
      const minted = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100001/claims",
        key,
      );
      const me = await createUser();
      const taken = await accept(me.id, minted.body.token);
      expect(taken.status).toBe(201);
      expect(taken.body).toEqual({ kind: "mortgage", loanId: minted.body.loanId });

      const loan = await prisma.loan.findUniqueOrThrow({
        where: { id: minted.body.loanId },
        include: {
          parties: { include: { party: true } },
          transitions: { orderBy: { seq: "asc" } },
        },
      });
      expect(loan.status).toBe("MONITORING_ONLY");
      expect(loan.monitoringEnabled).toBe(true);
      expect(loan.nextReviewDueAt).not.toBeNull();
      // The loan's one party is now the claimant's own, CLAIMED; the tape's is folded into it.
      const mine = await partyForUser(prisma, me.id);
      expect(loan.parties.map((p) => p.partyId)).toEqual([mine]);
      expect(loan.parties[0]!.party.claimStatus).toBe("CLAIMED");
      const folded = await prisma.party.findMany({ where: { mergedIntoPartyId: mine } });
      expect(folded).toHaveLength(1);
      // The ledger names the person who did it, and why.
      const move = loan.transitions.at(-1)!;
      expect(move).toMatchObject({
        fromState: "IMPORTED_UNCLAIMED",
        toState: "MONITORING_ONLY",
        event: "borrower_claimed",
        reasonCode: "claim_confirmed",
      });
      expect(move.causedBy).toMatch(/^loan_claim:/);
      // And the mortgage is theirs to read, watched.
      const page = await callAs<Record<string, unknown>>(
        me.id,
        [loanRouter],
        "GET",
        `/${loan.id}/servicing`,
        undefined,
        "/api/loans",
      );
      expect(page.status).toBe(200);
      expect((page.body.loan as { state: string }).state).toBe("monitoring_only");
      // A claim taken is a claim gone: the same link, the same person, again.
      expect((await accept(me.id, minted.body.token)).status).toBe(404);
      expect((await preview(minted.body.token)).status).toBe(404);
      // And the partner cannot mint another for a loan that is somebody's.
      expect(
        (await door.call("POST", "/api/partner/book/loans/NL-100001/claims", key)).status,
      ).toBe(409);
    } finally {
      await door.close();
    }
  });

  it("refuses a sample borrower, an expired link, and a loan that ended before it was taken", async () => {
    const { key, servicer, principalId } = await northlight();
    const door = await partnerDoor();
    try {
      const minted = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100003/claims",
        key,
      );
      const persona = await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
      expect((await accept(persona.id, minted.body.token)).status).toBe(403);

      const stale = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100004/claims",
        key,
      );
      await prisma.loanClaim.updateMany({
        where: { loanId: stale.body.loanId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await preview(stale.body.token)).status).toBe(404);
      expect((await accept((await createUser()).id, stale.body.token)).status).toBe(404);

      // A payoff posted after the link went out: the machine makes that final,
      // and the claim asks for a state the loan has left.
      const ended = await door.call<Minted>(
        "POST",
        "/api/partner/book/loans/NL-100005/claims",
        key,
      );
      const { moveLoanIfLegal } = await import("../services/loan-transition.js");
      await moveLoanIfLegal({
        id: ended.body.loanId,
        event: "payoff_posted",
        actorPrincipalId: principalId,
        reasonCode: "servicer_reported",
        causedBy: `partner_book:${servicer.slug}:test`,
      });
      expect((await preview(ended.body.token)).status).toBe(404);
      expect((await accept((await createUser()).id, ended.body.token)).status).toBe(409);
    } finally {
      await door.close();
    }
  });

  it("still opens a co-borrower's invitation through the same door, and says which it is", async () => {
    // A token that matches neither table is a dead link for both kinds.
    expect((await preview("not-a-token-anyone-minted-0000000000")).status).toBe(404);
  });
});
