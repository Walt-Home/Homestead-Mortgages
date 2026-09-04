/**
 * What the database refuses to let a state change be.
 *
 * The machine's own properties are tested without Postgres in
 * packages/shared/src/__tests__/application-machine.test.ts. These are the ones
 * that only exist because the guarantees live in the database: that the column
 * cannot move without the ledger, that an ending is final, and that two writers
 * racing produce a conflict rather than a lost decision.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { APPLICATION_STATES, IllegalTransition } from "@hm/shared";
import { transition, TransitionConflict } from "../services/transition.js";

let n = 0;
async function principal() {
  return prisma.principal.create({
    data: { kind: "STAFF", subject: `ops-${(n += 1)}` },
    select: { id: true },
  });
}

async function application() {
  return prisma.application.create({ data: {}, select: { id: true, status: true } });
}

/** Walk a file to a state through legal moves, so tests start where they mean to. */
async function drive(
  id: string,
  actor: string,
  events: Parameters<typeof transition>[0]["event"][],
) {
  for (const event of events) {
    await transition({ applicationId: id, event, actorPrincipalId: actor });
  }
}

describe("the vocabularies agree", () => {
  it("stores exactly the states the machine knows", async () => {
    // A state added to one and not the other is a file that can enter a state
    // nothing knows how to render.
    const rows = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ApplicationState'
    `;
    const inDb = rows.map((r) => r.label.toLowerCase()).sort();
    expect(inDb).toEqual([...APPLICATION_STATES].sort());
  });
});

describe("a move is recorded or it does not happen", () => {
  it("writes a ledger row with the column", async () => {
    const who = await principal();
    const app = await application();
    const moved = await transition({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
      reasonCode: "six_pieces_pinned",
    });

    expect(moved).toMatchObject({ from: "draft", to: "intake_received", seq: 1 });
    const rows = await prisma.applicationTransition.findMany({ where: { applicationId: app.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      fromState: "DRAFT",
      toState: "INTAKE_RECEIVED",
      event: "intake_completed",
      reasonCode: "six_pieces_pinned",
    });
  });

  it("REFUSES a bare status update", async () => {
    // The call that typechecks, lints clean, passes every mocked test, and
    // moves a file to approved with no record of who did it or why.
    const app = await application();
    await expect(
      prisma.application.update({ where: { id: app.id }, data: { status: "APPROVED" } }),
    ).rejects.toThrow(/without advancing status_seq/);
  });

  it("refuses a status change with a sequence but no explanation", async () => {
    // Advancing the sequence by hand gets past the first trigger. The deferred
    // constraint catches it at COMMIT, because that is the only moment "did
    // this transaction also record why" can be answered.
    const app = await application();
    await expect(
      prisma.application.update({
        where: { id: app.id },
        data: { status: "APPROVED", statusSeq: 1, statusEnteredAt: new Date() },
      }),
    ).rejects.toThrow(/no matching transition row/);
  });

  it("refuses a sequence bump that changes nothing", async () => {
    const app = await application();
    await expect(
      prisma.application.update({ where: { id: app.id }, data: { statusSeq: 1 } }),
    ).rejects.toThrow(/without changing status/);
  });

  it("keeps the ledger append-only", async () => {
    const who = await principal();
    const app = await application();
    await transition({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
    });
    const row = await prisma.applicationTransition.findFirst({ where: { applicationId: app.id } });
    await expect(
      prisma.applicationTransition.update({
        where: { id: row!.id },
        data: { event: "decided_approved" },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe("illegal moves cost nothing", () => {
  it("throws rather than returning the current state", async () => {
    const who = await principal();
    const app = await application();
    await expect(
      transition({ applicationId: app.id, event: "disbursed", actorPrincipalId: who.id }),
    ).rejects.toThrow(IllegalTransition);
  });

  it("leaves no trace of a refused move", async () => {
    // advanceStage's failure mode was silent success. This one has to be
    // silent NON-success: nothing written, nothing to roll back.
    const who = await principal();
    const app = await application();
    await expect(
      transition({ applicationId: app.id, event: "disbursed", actorPrincipalId: who.id }),
    ).rejects.toThrow();
    const after = await prisma.application.findUnique({ where: { id: app.id } });
    expect(after?.status).toBe("DRAFT");
    expect(after?.statusSeq).toBe(0);
    expect(await prisma.applicationTransition.count({ where: { applicationId: app.id } })).toBe(0);
  });
});

describe("an ending is final", () => {
  it("cannot be left through the machine", async () => {
    const who = await principal();
    const app = await application();
    await drive(app.id, who.id, ["borrower_withdrew"]);
    await expect(
      transition({ applicationId: app.id, event: "intake_completed", actorPrincipalId: who.id }),
    ).rejects.toThrow(IllegalTransition);
  });

  it("cannot be left through raw SQL either", async () => {
    // Belt and braces: the machine refuses the move, and the database refuses
    // it again for a caller that never went through the machine.
    const who = await principal();
    const app = await application();
    await drive(app.id, who.id, ["borrower_withdrew"]);
    await expect(
      prisma.$executeRaw`UPDATE applications SET status = 'IN_PROCESSING', status_seq = status_seq + 1, status_entered_at = now() WHERE id = ${app.id}::uuid`,
    ).rejects.toThrow(/cannot be reopened/);
  });
});

describe("two writers racing", () => {
  it("gives the loser a conflict, not a silent overwrite", async () => {
    // Both read draft. Both decide. One of them is about to be wrong, and it
    // must find out rather than overwrite a decision somebody else recorded.
    const who = await principal();
    const app = await application();

    const results = await Promise.allSettled([
      transition({
        applicationId: app.id,
        event: "intake_completed",
        actorPrincipalId: who.id,
        expectedFrom: "draft",
      }),
      transition({
        applicationId: app.id,
        event: "borrower_withdrew",
        actorPrincipalId: who.id,
        expectedFrom: "draft",
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // Exactly one move, exactly one ledger row, and they agree.
    const app2 = await prisma.application.findUnique({ where: { id: app.id } });
    const rows = await prisma.applicationTransition.findMany({ where: { applicationId: app.id } });
    expect(app2?.statusSeq).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toState).toBe(app2?.status);
  });

  it("tells the loser what the file actually is", async () => {
    const who = await principal();
    const app = await application();
    await transition({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
    });

    try {
      await transition({
        applicationId: app.id,
        event: "borrower_withdrew",
        actorPrincipalId: who.id,
        expectedFrom: "draft",
      });
      throw new Error("should have conflicted");
    } catch (err) {
      const e = err as TransitionConflict;
      expect(e).toBeInstanceOf(TransitionConflict);
      expect(e.actualState).toBe("intake_received");
      expect(e.statusCode).toBe(409);
    }
  });
});

describe("the ledger reconstructs the file", () => {
  it("answers what state it was in, in order, with who and why", async () => {
    const who = await principal();
    const app = await application();
    await drive(app.id, who.id, [
      "intake_completed",
      "work_began",
      "borrower_owes",
      "borrower_satisfied",
      "underwriting_began",
      "decided_decline",
      "adverse_action_delivered",
    ]);

    const rows = await prisma.applicationTransition.findMany({
      where: { applicationId: app.id },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.toState)).toEqual([
      "INTAKE_RECEIVED",
      "IN_PROCESSING",
      "AWAITING_BORROWER",
      "IN_PROCESSING",
      "IN_UNDERWRITING",
      "ADVERSE_ACTION_PENDING",
      "DENIED",
    ]);
    // Gapless from 1, so a missing row is visible rather than inferred.
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.every((r) => r.actorPrincipalId === who.id)).toBe(true);
    // Every row carries both times, so a backdated correction is expressible.
    expect(rows.every((r) => r.occurredAt && r.recordedAt)).toBe(true);
  });
});
