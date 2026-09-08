/**
 * Borrowing, and the receipt.
 *
 * The pin is the mechanism of the whole design, and the receipt is the
 * highest-stakes clock in the product. Every assertion here needs Postgres:
 * the guards are triggers, the receipt is a trigger, and the one thing that
 * matters most — that the sixth piece landing IS the application — cannot be
 * shown by anything that mocks the database.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { addBusinessDays, TRID_PARTY_PREDICATES } from "@hm/shared";
import { pinFact, proposeScenario, releasePin, sixPieces } from "../services/evidence.js";

const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const uniq = () => `${Date.now().toString(36)}-${(n += 1)}`;

async function party() {
  return prisma.party.create({ data: { kind: "PERSON" }, select: { id: true } });
}
async function borrowerPrincipal(partyId: string) {
  return prisma.principal.create({
    data: { kind: "BORROWER", subject: `b-${uniq()}`, partyId },
    select: { id: true },
  });
}
async function application(partyId: string) {
  const app = await prisma.application.create({ data: {}, select: { id: true } });
  await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId, role: "PRIMARY_BORROWER" },
  });
  return app;
}
async function grant(partyId: string, over: Record<string, unknown> = {}) {
  return prisma.authorization.create({
    data: {
      partyId,
      purpose: "FCRA_WRITTEN_INSTRUCTION",
      dataCategories: ["CREDIT_REPORT"],
      grantedAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + 120 * DAY),
      ...over,
    },
    select: { id: true },
  });
}
async function fact(partyId: string, principalId: string, predicate: string, value: unknown = "x") {
  return prisma.fact.create({
    data: {
      subjectType: "PARTY",
      subjectId: partyId,
      partyId,
      predicate,
      value: value as never,
      sourceKind: "SELF_ATTESTED",
      confidence: "ATTESTED",
      assertedByPrincipalId: principalId,
      observedAt: new Date("2026-06-01T00:00:00Z"),
    },
    select: { id: true },
  });
}

/** A party with the three person-side pieces asserted, and a live grant. */
async function personWithSixPieces() {
  const p = await party();
  const who = await borrowerPrincipal(p.id);
  const g = await grant(p.id);
  const facts = Object.fromEntries(
    await Promise.all(
      TRID_PARTY_PREDICATES.map(async (pred) => [pred, await fact(p.id, who.id, pred)] as const),
    ),
  );
  return { p, who, g, facts };
}

const fullTerms = {
  objective: "PURCHASE" as const,
  occupancy: "PRIMARY_RESIDENCE" as const,
  loanAmountCents: 41_600_000n,
  termMonths: 360,
  propertyAddress: "42 Oak Street, Demo City CA 94000",
  valueEstimateCents: 52_000_000n,
};

describe("what a pin may borrow", () => {
  it("borrows a fact under a live authorization from the same party", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    const pin = await pinFact({
      applicationId: app.id,
      factId: facts.legal_name!.id,
      authorizationId: g.id,
    });
    expect(pin.predicate).toBe("legal_name");
  });

  it("refuses a fact whose party is not on the application", async () => {
    const { facts, g } = await personWithSixPieces();
    const stranger = await party();
    const app = await application(stranger.id);
    await expect(
      pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id }),
    ).rejects.toThrow(/not on application/);
  });

  it("refuses an authorization granted by a different party", async () => {
    // The same defect as the old guard, one layer down: A's grant must not
    // let A's file borrow a fact about B.
    const a = await personWithSixPieces();
    const b = await personWithSixPieces();
    const app = await application(a.p.id);
    await prisma.applicationParty.create({
      data: { applicationId: app.id, partyId: b.p.id, role: "CO_BORROWER" },
    });
    await expect(
      pinFact({ applicationId: app.id, factId: b.facts.legal_name!.id, authorizationId: a.g.id }),
    ).rejects.toThrow(/different party/);
  });

  it("refuses a revoked authorization — retained is not borrowable", async () => {
    const { p, who, facts, g } = await personWithSixPieces();
    await prisma.authorization.update({
      where: { id: g.id },
      data: { revokedAt: new Date(), revokedByPrincipalId: who.id, revocationReason: "withdrew" },
    });
    const app = await application(p.id);
    await expect(
      pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id }),
    ).rejects.toThrow(/revoked/);
  });

  it("refuses an expired authorization", async () => {
    const p = await party();
    const who = await borrowerPrincipal(p.id);
    const stale = await grant(p.id, {
      grantedAt: new Date(Date.now() - 200 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    const f = await fact(p.id, who.id, "legal_name");
    const app = await application(p.id);
    await expect(
      pinFact({ applicationId: app.id, factId: f.id, authorizationId: stale.id }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses a retracted fact", async () => {
    const { p, facts, g } = await personWithSixPieces();
    await prisma.fact.update({
      where: { id: facts.legal_name!.id },
      data: { retractedAt: new Date(), retractionReason: "never said it" },
    });
    const app = await application(p.id);
    await expect(
      pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id }),
    ).rejects.toThrow(/retracted/);
  });

  it("refuses an expired fact", async () => {
    const p = await party();
    const who = await borrowerPrincipal(p.id);
    const g = await grant(p.id);
    const app = await application(p.id);
    const stale = await prisma.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: p.id,
        partyId: p.id,
        predicate: "monthly_income",
        value: 8500,
        sourceKind: "SELF_ATTESTED",
        confidence: "ATTESTED",
        assertedByPrincipalId: who.id,
        observedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date(Date.now() - DAY),
      },
      select: { id: true },
    });
    await expect(
      pinFact({ applicationId: app.id, factId: stale.id, authorizationId: g.id }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses a superseded fact — pin the successor", async () => {
    const { p, who, facts, g } = await personWithSixPieces();
    const newer = await fact(p.id, who.id, "monthly_income", 9000);
    await prisma.fact.update({
      where: { id: facts.monthly_income!.id },
      data: { supersededById: newer.id },
    });
    const app = await application(p.id);
    await expect(
      pinFact({ applicationId: app.id, factId: facts.monthly_income!.id, authorizationId: g.id }),
    ).rejects.toThrow(/superseded/);
  });

  it("refuses a fact with nothing in it", async () => {
    // The receipt counts predicates. A monthly_income of JSON null would have
    // counted toward the six.
    const p = await party();
    const who = await borrowerPrincipal(p.id);
    const g = await grant(p.id);
    const app = await application(p.id);
    const empty = await fact(p.id, who.id, "monthly_income", null);
    const blank = await fact(p.id, who.id, "legal_name", "   ");
    await expect(
      pinFact({ applicationId: app.id, factId: empty.id, authorizationId: g.id }),
    ).rejects.toThrow(/no value/);
    await expect(
      pinFact({ applicationId: app.id, factId: blank.id, authorizationId: g.id }),
    ).rejects.toThrow(/no value/);
  });

  it("refuses a grant that does not cover a credit request", async () => {
    // An account-review grant is what monthly monitoring runs under, and its
    // own enum comment says it is not what an origination authorization covers.
    const { p, facts } = await personWithSixPieces();
    const review = await grant(p.id, { purpose: "FCRA_ACCOUNT_REVIEW" });
    const app = await application(p.id);
    await expect(
      pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: review.id }),
    ).rejects.toThrow(/does not cover a credit request/);
  });

  it("copies the predicate from the fact rather than trusting the caller", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    // Straight to Prisma with a lie in the predicate. The trigger overwrites it.
    const row = await prisma.applicationEvidenceLink.create({
      data: {
        applicationId: app.id,
        factId: facts.ssn_token!.id,
        authorizationId: g.id,
        predicate: "legal_name",
        asOf: new Date("1999-01-01T00:00:00Z"),
      },
      select: { predicate: true, asOf: true },
    });
    expect(row.predicate).toBe("ssn_token");
    expect(row.asOf.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("is released, never edited or re-released", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    const pin = await pinFact({
      applicationId: app.id,
      factId: facts.legal_name!.id,
      authorizationId: g.id,
    });
    // A release fifty-six years before the borrow is impossible history.
    await expect(
      prisma.applicationEvidenceLink.update({
        where: { id: pin.id },
        data: { releasedAt: new Date(0) },
      }),
    ).rejects.toThrow();
    await releasePin(pin.id);
    await expect(releasePin(pin.id)).rejects.toThrow(/already released/);
    await expect(
      prisma.applicationEvidenceLink.update({
        where: { id: pin.id },
        data: { factId: facts.ssn_token!.id },
      }),
    ).rejects.toThrow(/never edited/);
  });

  it("holds one live pin per fact, and allows a re-pin after release", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    const first = await pinFact({
      applicationId: app.id,
      factId: facts.legal_name!.id,
      authorizationId: g.id,
    });
    await expect(
      pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await releasePin(first.id);
    const again = await pinFact({
      applicationId: app.id,
      factId: facts.legal_name!.id,
      authorizationId: g.id,
    });
    expect(again.id).not.toBe(first.id);
  });
});

describe("scenarios", () => {
  it("keeps exactly one active, and retires the old one in the same transaction", async () => {
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    const v1 = await proposeScenario(app.id, fullTerms);
    const v2 = await proposeScenario(app.id, {
      ...fullTerms,
      loanAmountCents: 41_200_000n,
      origin: "COUNTEROFFER",
    });
    expect([v1.seq, v2.seq]).toEqual([1, 2]);
    const rows = await prisma.loanScenario.findMany({
      where: { applicationId: app.id },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => [r.seq, r.isActive, r.supersededBySeq])).toEqual([
      [1, false, 2],
      [2, true, null],
    ]);
  });

  it("is immutable — a change of terms is a new scenario", async () => {
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    const v1 = await proposeScenario(app.id, fullTerms);
    await expect(
      prisma.loanScenario.update({ where: { id: v1.id }, data: { loanAmountCents: 1n } }),
    ).rejects.toThrow(/immutable/);
  });

  it("only retires, and only forward", async () => {
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    await expect(
      prisma.loanScenario.create({ data: { applicationId: app.id, seq: 0, ...fullTerms } }),
    ).rejects.toThrow();
    await expect(
      prisma.loanScenario.create({
        data: { applicationId: app.id, seq: 1, isActive: true, supersededBySeq: 5, ...fullTerms },
      }),
    ).rejects.toThrow();
    const v1 = await proposeScenario(app.id, fullTerms);
    await proposeScenario(app.id, fullTerms);
    await expect(
      prisma.loanScenario.update({ where: { id: v1.id }, data: { supersededBySeq: null } }),
    ).rejects.toThrow();
    await expect(
      prisma.loanScenario.update({ where: { id: v1.id }, data: { id: randomUUID() } }),
    ).rejects.toThrow(/immutable/);
  });

  it("reports a concurrent proposal as a scenario conflict, not a pin collision", async () => {
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    const results = await Promise.allSettled([
      proposeScenario(app.id, fullTerms),
      proposeScenario(app.id, { ...fullTerms, loanAmountCents: 40_000_000n }),
    ]);
    // Both may win if the pool serialized them; if one lost, it lost for the
    // right reason.
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ statusCode: 409, code: "SCENARIO_CONFLICT" });
    }
    const active = await prisma.loanScenario.findMany({
      where: { applicationId: app.id, isActive: true },
    });
    expect(active).toHaveLength(1);
  });

  it("proposed inside a caller's transaction, it goes when the transaction goes", async () => {
    // Screen 1 will create the file, the application and its first scenario
    // in one transaction. A proposal that opened its own would survive the
    // caller's rollback as a scenario on an application that does not exist.
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    await expect(
      prisma.$transaction(async (tx) => {
        const v1 = await proposeScenario(app.id, fullTerms, tx);
        expect(v1.seq).toBe(1);
        throw new Error("simulated failure after the proposal");
      }),
    ).rejects.toThrow(/simulated/);
    expect(await prisma.loanScenario.count({ where: { applicationId: app.id } })).toBe(0);
    // And the next proposal starts the sequence, rather than continuing one
    // that was never committed.
    const v1 = await proposeScenario(app.id, fullTerms);
    expect(v1.seq).toBe(1);
  });

  it("cannot reactivate a superseded scenario", async () => {
    const { p } = await personWithSixPieces();
    const app = await application(p.id);
    const v1 = await proposeScenario(app.id, fullTerms);
    await proposeScenario(app.id, fullTerms);
    await expect(
      prisma.loanScenario.update({ where: { id: v1.id }, data: { isActive: true } }),
    ).rejects.toThrow(/cannot be reactivated/);
  });
});

describe("THE RECEIPT", () => {
  it("becomes an application the moment the sixth piece lands, with a ledger row", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);

    // Five pieces: still a draft.
    await pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id });
    await pinFact({ applicationId: app.id, factId: facts.ssn_token!.id, authorizationId: g.id });
    const before = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(before.status).toBe("DRAFT");

    // The sixth.
    await pinFact({
      applicationId: app.id,
      factId: facts.monthly_income!.id,
      authorizationId: g.id,
    });

    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.status).toBe("INTAKE_RECEIVED");
    expect(after.statusSeq).toBe(1);
    // The receipt is the one write to applications that bypasses Prisma, so it
    // has to move updated_at itself or a poller diffing on it never sees the
    // most consequential state change in the product.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(after.statusEnteredAt.getTime());

    const ledger = await prisma.applicationTransition.findMany({
      where: { applicationId: app.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      seq: 1,
      fromState: "DRAFT",
      toState: "INTAKE_RECEIVED",
      event: "intake_completed",
      reasonCode: "six_pieces_received",
    });
    const actor = await prisma.principal.findUnique({ where: { id: ledger[0]!.actorPrincipalId } });
    expect(actor).toMatchObject({ kind: "SERVICE", subject: "trid_receipt" });
  });

  it("fires just as well when the scenario is the sixth piece", async () => {
    // Relationship-first raises the accidental-receipt risk: a returning
    // member already has name, SSN and income on file. Here they are pinned
    // first, and the scenario completes the six.
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    expect((await prisma.application.findUnique({ where: { id: app.id } }))?.status).toBe("DRAFT");
    await proposeScenario(app.id, fullTerms);
    expect((await prisma.application.findUnique({ where: { id: app.id } }))?.status).toBe(
      "INTAKE_RECEIVED",
    );
  });

  it("does not count a scenario missing a request-side piece", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, { ...fullTerms, valueEstimateCents: null });
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    expect((await prisma.application.findUnique({ where: { id: app.id } }))?.status).toBe("DRAFT");
    expect(await sixPieces(app.id)).toMatchObject({ valueEstimateCents: false, legal_name: true });
  });

  it("opens the Loan Estimate clock TOLLED, with the reason", async () => {
    // There is no delivery channel. A clock that cannot be satisfied must not
    // be allowed to breach on schedule and write a permanent record of it.
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    const clock = await prisma.regulatoryClock.findFirst({ where: { applicationId: app.id } });
    expect(clock).toMatchObject({
      kind: "TRID_LE_DELIVERY",
      tollingReason: "no_delivery_channel_configured",
      satisfiedAt: null,
      breachedAt: null,
    });
    expect(clock?.tolledFrom).not.toBeNull();
    // due_at is three business days out, and agrees with the TS helper.
    expect(clock?.dueAt.getTime()).toBe(addBusinessDays(clock!.startedAt, 3).getTime());
  });

  it("receives an application whose draft and sixth piece land in one transaction", async () => {
    // The returning-member case: name, SSN and income already on file, and one
    // transaction completes the six. The draft takes the column DEFAULT — this
    // transaction's now() — which is exactly the stamp the receipt must move
    // strictly past. The first version rolled the whole intake back here.
    const { p, facts, g } = await personWithSixPieces();
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO "applications" ("id", "updated_at") VALUES (${id}::uuid, now())`;
      await tx.applicationParty.create({
        data: { applicationId: id, partyId: p.id, role: "PRIMARY_BORROWER" },
      });
      await tx.loanScenario.create({ data: { applicationId: id, seq: 1, ...fullTerms } });
      for (const pred of TRID_PARTY_PREDICATES) {
        await tx.applicationEvidenceLink.create({
          data: {
            applicationId: id,
            factId: facts[pred]!.id,
            authorizationId: g.id,
            predicate: pred,
            asOf: new Date(0),
          },
        });
      }
    });
    const app = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(app.status).toBe("INTAKE_RECEIVED");
    expect(app.statusSeq).toBe(1);
    expect(app.statusEnteredAt.getTime()).toBeGreaterThan(app.createdAt.getTime());
    expect(app.updatedAt.getTime()).toBeGreaterThanOrEqual(app.statusEnteredAt.getTime());
    const ledger = await prisma.applicationTransition.findFirstOrThrow({
      where: { applicationId: id },
    });
    expect(ledger.occurredAt.getTime()).toBeGreaterThanOrEqual(app.createdAt.getTime());
  });

  it("receives one created through Prisma in the same transaction, in order", async () => {
    // Through the client the stamp is a few milliseconds AFTER the
    // transaction's now(), so without the correction the receipt was recorded
    // before the draft it moved.
    const { p, facts, g } = await personWithSixPieces();
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.application.create({ data: { id } });
      await tx.applicationParty.create({
        data: { applicationId: id, partyId: p.id, role: "PRIMARY_BORROWER" },
      });
      await tx.loanScenario.create({ data: { applicationId: id, seq: 1, ...fullTerms } });
      for (const pred of TRID_PARTY_PREDICATES) {
        await tx.applicationEvidenceLink.create({
          data: {
            applicationId: id,
            factId: facts[pred]!.id,
            authorizationId: g.id,
            predicate: pred,
            asOf: new Date(0),
          },
        });
      }
    });
    const app = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(app.status).toBe("INTAKE_RECEIVED");
    expect(app.statusEnteredAt.getTime()).toBeGreaterThan(app.createdAt.getTime());
  });

  it("does not count a blank property address as an address", async () => {
    // An HTML form posts '' for an unfilled field. Under 1026.2(a)(3)(ii) a
    // request with no property address is not an application, and a receipt
    // is never un-stamped.
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    await proposeScenario(app.id, { ...fullTerms, propertyAddress: "   " });
    expect((await prisma.application.findUnique({ where: { id: app.id } }))?.status).toBe("DRAFT");
    expect(await prisma.regulatoryClock.count({ where: { applicationId: app.id } })).toBe(0);
    expect(await sixPieces(app.id)).toMatchObject({ propertyAddress: false });
    // And the database refuses the blank outright.
    await expect(
      prisma.loanScenario.create({
        data: { applicationId: app.id, seq: 9, ...fullTerms, propertyAddress: "" },
      }),
    ).rejects.toThrow();
  });

  it("refuses to run under REPEATABLE READ, where a concurrent pin is invisible", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await expect(
      prisma.$transaction(
        (tx) =>
          tx.applicationEvidenceLink.create({
            data: {
              applicationId: app.id,
              factId: facts.legal_name!.id,
              authorizationId: g.id,
              predicate: "legal_name",
              asOf: new Date(0),
            },
          }),
        { isolationLevel: "RepeatableRead" },
      ),
    ).rejects.toThrow(/REPEATABLE READ/);
    // SERIALIZABLE is safe: a loser is aborted with 40001 rather than a
    // receipt being silently missed.
    await prisma.$transaction(
      (tx) =>
        tx.applicationEvidenceLink.create({
          data: {
            applicationId: app.id,
            factId: facts.legal_name!.id,
            authorizationId: g.id,
            predicate: "legal_name",
            asOf: new Date(0),
          },
        }),
      { isolationLevel: "Serializable" },
    );
  });

  it("stamps once and never again", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    // A later scenario, and a released-and-repinned fact, change nothing.
    await proposeScenario(app.id, { ...fullTerms, loanAmountCents: 40_000_000n });
    const app2 = await prisma.application.findUnique({ where: { id: app.id } });
    expect(app2?.status).toBe("INTAKE_RECEIVED");
    expect(app2?.statusSeq).toBe(1);
    expect(await prisma.regulatoryClock.count({ where: { applicationId: app.id } })).toBe(1);
  });

  it("still stamps when its actor already exists under a different id", async () => {
    // The receipt guarantees its own actor with an idempotent insert keyed on
    // (kind, subject). If the row is already there under another id, that
    // insert is a no-op — and the ledger row must name the id that is actually
    // present, not the one the migration would have chosen.
    const existing = await prisma.principal.create({
      data: { kind: "SERVICE", subject: "trid_receipt" },
      select: { id: true },
    });
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    const ledger = await prisma.applicationTransition.findFirst({
      where: { applicationId: app.id },
    });
    expect(ledger?.actorPrincipalId).toBe(existing.id);
  });

  it("holds one Loan Estimate clock per application at the storage layer", async () => {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    await expect(
      prisma.regulatoryClock.create({
        data: {
          applicationId: app.id,
          kind: "TRID_LE_DELIVERY",
          statuteCitation: "x",
          startedAt: new Date(),
          dueAt: new Date(Date.now() + DAY),
        },
      }),
    ).rejects.toThrow();
  });
});

describe("deleting a party takes its pins with it", () => {
  it("cascades, so account deletion stays total even once a fact is pinned", async () => {
    // A pin is a record about a person's data. The first version of this
    // slice gave its foreign keys RESTRICT, which would have made the first
    // pinned fact the thing that quietly broke "we remove your data for good".
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await pinFact({ applicationId: app.id, factId: facts.legal_name!.id, authorizationId: g.id });

    await prisma.party.delete({ where: { id: p.id } });
    expect(await prisma.fact.count({ where: { partyId: p.id } })).toBe(0);
    expect(await prisma.applicationEvidenceLink.count({ where: { applicationId: app.id } })).toBe(
      0,
    );
    // The application itself is not the person's data and survives; it simply
    // no longer borrows anything.
    expect(await prisma.application.findUnique({ where: { id: app.id } })).not.toBeNull();
  });
});

describe("a clock is set once", () => {
  async function receivedClock() {
    const { p, facts, g } = await personWithSixPieces();
    const app = await application(p.id);
    await proposeScenario(app.id, fullTerms);
    for (const f of Object.values(facts)) {
      await pinFact({ applicationId: app.id, factId: f.id, authorizationId: g.id });
    }
    return prisma.regulatoryClock.findFirstOrThrow({ where: { applicationId: app.id } });
  }

  it("never tidies a breach away", async () => {
    const clock = await receivedClock();
    await prisma.regulatoryClock.update({
      where: { id: clock.id },
      data: { breachedAt: new Date() },
    });
    await expect(
      prisma.regulatoryClock.update({ where: { id: clock.id }, data: { breachedAt: null } }),
    ).rejects.toThrow(/never tidied away/);
  });

  it("does not let the deadline or the origin move", async () => {
    const clock = await receivedClock();
    await expect(
      prisma.regulatoryClock.update({
        where: { id: clock.id },
        data: { dueAt: new Date(clock.dueAt.getTime() + 30 * DAY) },
      }),
    ).rejects.toThrow(/set once/);
    await expect(
      prisma.regulatoryClock.update({ where: { id: clock.id }, data: { startedAt: new Date(0) } }),
    ).rejects.toThrow(/set once/);
  });

  it("ends one way, after it started", async () => {
    const clock = await receivedClock();
    await expect(
      prisma.regulatoryClock.update({
        where: { id: clock.id },
        data: { satisfiedAt: new Date(), breachedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.regulatoryClock.update({ where: { id: clock.id }, data: { breachedAt: new Date(0) } }),
    ).rejects.toThrow();
  });

  it("ends a toll by recording when, never by clearing why", async () => {
    const clock = await receivedClock();
    await expect(
      prisma.regulatoryClock.update({ where: { id: clock.id }, data: { tollingReason: "" } }),
    ).rejects.toThrow();
    await expect(
      prisma.regulatoryClock.update({
        where: { id: clock.id },
        data: { tolledFrom: null, tollingReason: null },
      }),
    ).rejects.toThrow();
    await prisma.regulatoryClock.update({
      where: { id: clock.id },
      data: { tolledUntil: new Date() },
    });
    await expect(
      prisma.regulatoryClock.update({
        where: { id: clock.id },
        data: { tolledUntil: new Date(Date.now() + DAY) },
      }),
    ).rejects.toThrow(/already ended/);
  });
});

describe("the vocabularies agree", () => {
  it("the trigger counts exactly the predicates @hm/shared names", async () => {
    // The receipt trigger has the three party-side predicates as a literal
    // list. If the constant in @hm/shared drifts from it, a pinned fact under
    // a renamed predicate silently stops counting toward the six.
    const src = await prisma.$queryRaw<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc WHERE proname = 'trid_receipt_if_complete'
    `;
    for (const pred of TRID_PARTY_PREDICATES) {
      expect(src[0]?.src, pred).toContain(`'${pred}'`);
    }
  });

  it("business days agree between SQL and TypeScript, end of the third day in the creditor's zone", async () => {
    // Friday 11 Sep 2026; nothing federal in the week that follows.
    const friday = new Date("2026-09-11T15:00:00Z");
    const rows = await prisma.$queryRaw<
      { due: Date }[]
    >`SELECT add_business_days(${friday}::timestamptz, 3) AS due`;
    expect(rows[0]!.due.getTime()).toBe(addBusinessDays(friday, 3).getTime());
    // Fri → Mon, Tue, Wed 16 Sep, and the deadline is the END of Wednesday, Eastern (UTC-4).
    expect(rows[0]!.due.toISOString()).toBe("2026-09-17T03:59:59.999Z");
  });

  it("judges the weekday in the creditor's zone, not in UTC", async () => {
    // Friday 18:00 Pacific is already Saturday in UTC. Counting from Saturday
    // would give Tuesday; the creditor's Friday gives Wednesday.
    const fridayEveningPacific = new Date("2026-09-12T01:00:00Z");
    const rows = await prisma.$queryRaw<
      { due: Date }[]
    >`SELECT add_business_days(${fridayEveningPacific}::timestamptz, 3) AS due`;
    expect(rows[0]!.due.getTime()).toBe(addBusinessDays(fridayEveningPacific, 3).getTime());
    expect(rows[0]!.due.toISOString()).toBe("2026-09-17T03:59:59.999Z");
  });

  it.fails("skips federal holidays — the calendar slice flips this", async () => {
    // Wednesday before Thanksgiving 2026. Thu 26 Nov is a federal holiday, so
    // three business days is Fri, Mon, Tue 1 Dec. Weekends-only says Mon 30 Nov.
    // Failing on purpose: clocks open tolled until this passes.
    const wed = new Date("2026-11-25T15:00:00Z");
    const rows = await prisma.$queryRaw<
      { due: Date }[]
    >`SELECT add_business_days(${wed}::timestamptz, 3) AS due`;
    expect(rows[0]!.due.toISOString()).toBe("2026-12-02T04:59:59.999Z");
  });
});
