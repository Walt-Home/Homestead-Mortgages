/**
 * The guarantees the fact ledger keeps in Postgres.
 *
 * Every assertion here fails against application code alone. They are the
 * reason CI runs a real database: a mock would happily let an AI principal
 * certify an income, and nothing would say so until an auditor asked.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";

async function party(kind: "PERSON" | "ENTITY" = "PERSON") {
  return prisma.party.create({ data: { kind }, select: { id: true } });
}

let n = 0;
async function principal(kind: "BORROWER" | "STAFF" | "SERVICE" | "AI_AGENT", partyId?: string) {
  return prisma.principal.create({
    data: { kind, subject: `${kind.toLowerCase()}-${(n += 1)}`, partyId: partyId ?? null },
    select: { id: true },
  });
}

async function assertFact(
  partyId: string,
  principalId: string,
  over: Record<string, unknown> = {},
) {
  return prisma.fact.create({
    data: {
      subjectType: "PARTY",
      subjectId: partyId,
      partyId,
      predicate: "annual_income",
      value: 120000,
      sourceKind: "SELF_ATTESTED",
      confidence: "ATTESTED",
      assertedByPrincipalId: principalId,
      observedAt: new Date("2026-01-01T00:00:00Z"),
      ...over,
    },
    select: { id: true, confidence: true },
  });
}

describe("facts are append-only", () => {
  it("refuses to change a recorded value", async () => {
    const p = await party();
    const who = await principal("BORROWER", p.id);
    const f = await assertFact(p.id, who.id);

    // The correction for a wrong value is a NEW row. Rewriting this one does
    // not correct history, it destroys it.
    await expect(
      prisma.fact.update({ where: { id: f.id }, data: { value: 999999 } }),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses to change who asserted it, or when", async () => {
    const p = await party();
    const who = await principal("BORROWER", p.id);
    const other = await principal("STAFF");
    const f = await assertFact(p.id, who.id);

    await expect(
      prisma.fact.update({ where: { id: f.id }, data: { assertedByPrincipalId: other.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.fact.update({ where: { id: f.id }, data: { confidence: "VERIFIED" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("allows the three ways a row is retired", async () => {
    const p = await party();
    const who = await principal("BORROWER", p.id);
    const first = await assertFact(p.id, who.id);
    const second = await assertFact(p.id, who.id, { value: 130000 });

    await prisma.fact.update({
      where: { id: first.id },
      data: { supersededById: second.id },
    });
    await prisma.fact.update({
      where: { id: second.id },
      data: { retractedAt: new Date(), retractionReason: "borrower says they never said it" },
    });

    const rows = await prisma.fact.findMany({ where: { partyId: p.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.id)?.supersededById).toBe(second.id);
    expect(rows.find((r) => r.id === second.id)?.retractedAt).not.toBeNull();
  });

  it("still refuses a value change made in the same update as a retraction", async () => {
    // The exemption is three named columns, not "any update that also touches
    // one of them".
    const p = await party();
    const who = await principal("BORROWER", p.id);
    const f = await assertFact(p.id, who.id);
    await expect(
      prisma.fact.update({
        where: { id: f.id },
        data: { retractedAt: new Date(), value: 1 },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe("an AI principal may not certify", () => {
  it("refuses verified", async () => {
    const p = await party();
    const ai = await principal("AI_AGENT");
    // An agent that fills a gap with a plausible value turns "we do not know"
    // into "we checked and you passed". This is the one rule the whole model
    // is built around.
    await expect(
      assertFact(p.id, ai.id, { confidence: "VERIFIED", sourceKind: "AI_INFERRED" }),
    ).rejects.toThrow(/may not assert confidence/);
  });

  it("refuses validated_d1c", async () => {
    const p = await party();
    const ai = await principal("AI_AGENT");
    await expect(
      assertFact(p.id, ai.id, { confidence: "VALIDATED_D1C", sourceKind: "AI_INFERRED" }),
    ).rejects.toThrow(/may not assert confidence/);
  });

  it("lets it infer and estimate", async () => {
    const p = await party();
    const ai = await principal("AI_AGENT");
    const inferred = await assertFact(p.id, ai.id, {
      confidence: "INFERRED",
      sourceKind: "AI_INFERRED",
    });
    expect(inferred.confidence).toBe("INFERRED");
  });

  it("does not stop a vendor pull from being verified", async () => {
    const p = await party();
    const service = await principal("SERVICE");
    const v = await assertFact(p.id, service.id, {
      confidence: "VERIFIED",
      sourceKind: "VENDOR_RETRIEVED",
    });
    expect(v.confidence).toBe("VERIFIED");
  });
});

describe("subject and party stay consistent", () => {
  it("refuses a party fact with no party id", async () => {
    const p = await party();
    const who = await principal("BORROWER", p.id);
    await expect(
      prisma.fact.create({
        data: {
          subjectType: "PARTY",
          subjectId: p.id,
          partyId: null,
          predicate: "legal_name",
          value: "x",
          sourceKind: "SELF_ATTESTED",
          confidence: "ATTESTED",
          assertedByPrincipalId: who.id,
          observedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a property fact that carries a party id", async () => {
    const p = await party();
    const who = await principal("STAFF");
    await expect(
      prisma.fact.create({
        data: {
          subjectType: "PROPERTY",
          subjectId: p.id,
          partyId: p.id,
          predicate: "annual_tax",
          value: 4200,
          sourceKind: "PUBLIC_RECORD",
          confidence: "CORROBORATED",
          assertedByPrincipalId: who.id,
          observedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a non-borrower principal that names a party", async () => {
    const p = await party();
    await expect(
      prisma.principal.create({
        data: { kind: "STAFF", subject: "staff-with-a-party", partyId: p.id },
      }),
    ).rejects.toThrow();
  });
});

describe("deleting a party takes its facts with it", () => {
  it("cascades, so account deletion stays total", async () => {
    const p = await party();
    const who = await principal("BORROWER", p.id);
    await assertFact(p.id, who.id);

    // Append-only is a rule about rewriting, not about erasure. The privacy
    // page promises removal "for good — there is no archive and no undo", and
    // that promise runs through this cascade. An earlier version of the
    // migration blocked row deletion outright and broke it; this test is why
    // that trigger is gone.
    await prisma.party.delete({ where: { id: p.id } });
    expect(await prisma.fact.count({ where: { partyId: p.id } })).toBe(0);
  });
});
