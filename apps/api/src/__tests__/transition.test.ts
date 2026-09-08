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
import {
  APPLICATION_STATES,
  IllegalTransition,
  RECEIPT_REASON_CODE,
  TRID_PARTY_PREDICATES,
} from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { pinFact, proposeScenario } from "../services/evidence.js";
import { advanceIfLegal, transition, TransitionConflict } from "../services/transition.js";

const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const uniq = () => `${Date.now().toString(36)}-${(n += 1)}`;

/** A member of staff: may move a file, may not withdraw one. */
async function principal() {
  return prisma.principal.create({
    data: { kind: "STAFF", subject: `ops-${uniq()}` },
    select: { id: true },
  });
}

/** A person, and the principal they act as. */
async function borrower() {
  const party = await prisma.party.create({ data: { kind: "PERSON" }, select: { id: true } });
  const who = await prisma.principal.create({
    data: { kind: "BORROWER", subject: `b-${uniq()}`, partyId: party.id },
    select: { id: true },
  });
  return { partyId: party.id, principalId: who.id };
}

/**
 * An application with a primary borrower on it — the given party's, or a
 * fresh one. An application with nobody on it is not a shape the product
 * makes.
 */
async function application(partyId?: string) {
  const app = await prisma.application.create({ data: {}, select: { id: true, status: true } });
  await prisma.applicationParty.create({
    data: {
      applicationId: app.id,
      partyId: partyId ?? (await borrower()).partyId,
      role: "PRIMARY_BORROWER",
    },
  });
  return app;
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

async function ledgerOf(applicationId: string) {
  return prisma.applicationTransition.findMany({
    where: { applicationId },
    orderBy: { seq: "asc" },
  });
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
      reasonCode: RECEIPT_REASON_CODE,
    });

    expect(moved).toMatchObject({ from: "draft", to: "intake_received", seq: 1 });
    const rows = await ledgerOf(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      fromState: "DRAFT",
      toState: "INTAKE_RECEIVED",
      event: "intake_completed",
      reasonCode: RECEIPT_REASON_CODE,
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

describe("a move rides the caller's transaction", () => {
  it("goes when the transaction goes", async () => {
    // A route writes its row and moves the file in one act. If the row fails
    // after the move, the move must not survive it: a ledger that says the
    // bank was connected next to a file with no bank snapshot is worse than
    // no ledger.
    const who = await principal();
    const app = await application();
    await expect(
      prisma.$transaction(async (tx) => {
        const moved = await transition(
          { applicationId: app.id, event: "intake_completed", actorPrincipalId: who.id },
          tx,
        );
        expect(moved.to).toBe("intake_received");
        throw new Error("simulated failure after the move");
      }),
    ).rejects.toThrow(/simulated/);

    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.statusSeq).toBe(0);
    expect(await ledgerOf(app.id)).toHaveLength(0);
  });

  it("makes two moves in one transaction, and the check at COMMIT is satisfied", async () => {
    // Intake and the first obligation land in the same request. The deferred
    // constraint matches each status against its own ledger row, not only
    // the last one.
    const who = await principal();
    const app = await application();
    await prisma.$transaction(async (tx) => {
      await transition(
        { applicationId: app.id, event: "intake_completed", actorPrincipalId: who.id },
        tx,
      );
      await transition(
        { applicationId: app.id, event: "work_began", actorPrincipalId: who.id },
        tx,
      );
    });
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.status).toBe("IN_PROCESSING");
    expect(after.statusSeq).toBe(2);
    expect((await ledgerOf(app.id)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("stamps strictly later than the receipt it follows, whatever the clock says", async () => {
    // The receipt fires on the sixth piece and stamps the file. A move in the
    // same transaction may be asked to record the same instant — the request
    // has one clock — and a status change whose stamp did not move is refused
    // by the database. The service does what the receipt does: one
    // millisecond past the current stamp, at the least.
    const staff = await principal();
    const { partyId, principalId } = await borrower();
    const grant = await prisma.authorization.create({
      data: {
        partyId,
        purpose: "FCRA_WRITTEN_INSTRUCTION",
        dataCategories: ["CREDIT_REPORT"],
        grantedAt: new Date(Date.now() - DAY),
        expiresAt: new Date(Date.now() + 120 * DAY),
      },
      select: { id: true },
    });
    const facts = await Promise.all(
      TRID_PARTY_PREDICATES.map((predicate) =>
        prisma.fact.create({
          data: {
            subjectType: "PARTY",
            subjectId: partyId,
            partyId,
            predicate,
            value: "x",
            sourceKind: "SELF_ATTESTED",
            confidence: "ATTESTED",
            assertedByPrincipalId: principalId,
            observedAt: new Date("2026-06-01T00:00:00Z"),
          },
          select: { id: true },
        }),
      ),
    );
    const app = await application(partyId);
    await proposeScenario(app.id, {
      objective: "PURCHASE",
      occupancy: "PRIMARY_RESIDENCE",
      loanAmountCents: 41_600_000n,
      termMonths: 360,
      propertyAddress: "42 Oak Street, Demo City CA 94000",
      valueEstimateCents: 52_000_000n,
    });

    const { received, moved } = await prisma.$transaction(async (tx) => {
      for (const fact of facts) {
        await pinFact({ applicationId: app.id, factId: fact.id, authorizationId: grant.id }, tx);
      }
      const received = await tx.application.findUniqueOrThrow({
        where: { id: app.id },
        select: { status: true, statusEnteredAt: true },
      });
      expect(received.status).toBe("INTAKE_RECEIVED");
      const moved = await transition(
        {
          applicationId: app.id,
          event: "work_began",
          actorPrincipalId: staff.id,
          // The same instant the receipt recorded.
          occurredAt: received.statusEnteredAt,
        },
        tx,
      );
      return { received, moved };
    });

    expect(moved).toMatchObject({ from: "intake_received", to: "in_processing", seq: 2 });
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.statusEnteredAt.getTime()).toBe(received.statusEnteredAt.getTime() + 1);
    const rows = await ledgerOf(app.id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]!.occurredAt.getTime()).toBe(after.statusEnteredAt.getTime());
    expect(rows[1]!.occurredAt.getTime()).toBeGreaterThan(rows[0]!.occurredAt.getTime());
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
    expect(await ledgerOf(app.id)).toHaveLength(0);
  });
});

describe("a repeat is a skip, not an error", () => {
  it("says there is no edge, and writes nothing", async () => {
    const who = await principal();
    const app = await application();
    const result = await advanceIfLegal({
      applicationId: app.id,
      event: "disbursed",
      actorPrincipalId: who.id,
    });
    expect(result).toEqual({ skipped: "no_edge", from: "draft" });
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.statusSeq).toBe(0);
    expect(await ledgerOf(app.id)).toHaveLength(0);
  });

  it("moves once, and the second arrival of the same event is a skip", async () => {
    // A screen revisited sends its event again. The machine has no
    // self-edges, so the second arrival has nowhere to go; that is where the
    // file is, not something that went wrong.
    const who = await principal();
    const app = await application();
    const first = await advanceIfLegal({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
    });
    expect(first).toMatchObject({ from: "draft", to: "intake_received", seq: 1 });

    const again = await advanceIfLegal({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
    });
    expect(again).toEqual({ skipped: "no_edge", from: "intake_received" });
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.statusSeq).toBe(1);
    expect(await ledgerOf(app.id)).toHaveLength(1);
  });

  it("still hears a conflict", async () => {
    // A skip is for a repeat. Somebody else moving the file between the read
    // and the write is not a repeat, and the caller must find out.
    const who = await principal();
    const app = await application();
    const results = await Promise.allSettled([
      advanceIfLegal({
        applicationId: app.id,
        event: "intake_completed",
        actorPrincipalId: who.id,
      }),
      advanceIfLegal({ applicationId: app.id, event: "ops_canceled", actorPrincipalId: who.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost && lost.reason).toBeInstanceOf(TransitionConflict);
    expect(await ledgerOf(app.id)).toHaveLength(1);
  });
});

describe("withdrawing is the borrower's act", () => {
  it("refuses a member of staff before anything is written", async () => {
    const who = await principal();
    const app = await application();
    await expect(
      transition({ applicationId: app.id, event: "borrower_withdrew", actorPrincipalId: who.id }),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACTOR_NOT_PERMITTED" });
    await expect(
      transition({ applicationId: app.id, event: "borrower_withdrew", actorPrincipalId: who.id }),
    ).rejects.toBeInstanceOf(AppError);

    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.statusSeq).toBe(0);
    expect(await ledgerOf(app.id)).toHaveLength(0);
  });

  it("refuses the same member of staff through advanceIfLegal — a refusal is not a repeat", async () => {
    const who = await principal();
    const app = await application();
    await expect(
      advanceIfLegal({
        applicationId: app.id,
        event: "borrower_withdrew",
        actorPrincipalId: who.id,
      }),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_PERMITTED" });
    expect(await ledgerOf(app.id)).toHaveLength(0);
  });

  it("lets the borrower withdraw", async () => {
    const { partyId, principalId } = await borrower();
    const app = await application(partyId);
    const moved = await transition({
      applicationId: app.id,
      event: "borrower_withdrew",
      actorPrincipalId: principalId,
      reasonCode: "borrower_requested",
    });
    expect(moved).toMatchObject({ from: "draft", to: "withdrawn", seq: 1 });
    const rows = await ledgerOf(app.id);
    expect(rows[0]).toMatchObject({
      actorPrincipalId: principalId,
      reasonCode: "borrower_requested",
    });
  });
});

describe("an ending is final", () => {
  it("cannot be left through the machine", async () => {
    const who = await principal();
    const { partyId, principalId } = await borrower();
    const app = await application(partyId);
    await drive(app.id, principalId, ["borrower_withdrew"]);
    await expect(
      transition({ applicationId: app.id, event: "intake_completed", actorPrincipalId: who.id }),
    ).rejects.toThrow(IllegalTransition);
  });

  it("cannot be left through raw SQL either", async () => {
    // Belt and braces: the machine refuses the move, and the database refuses
    // it again for a caller that never went through the machine.
    const { partyId, principalId } = await borrower();
    const app = await application(partyId);
    await drive(app.id, principalId, ["borrower_withdrew"]);
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
    const { partyId, principalId } = await borrower();
    const app = await application(partyId);

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
        actorPrincipalId: principalId,
        expectedFrom: "draft",
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionConflict);

    // Exactly one move, exactly one ledger row, and they agree.
    const app2 = await prisma.application.findUnique({ where: { id: app.id } });
    const rows = await ledgerOf(app.id);
    expect(app2?.statusSeq).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toState).toBe(app2?.status);
  });

  it("tells the loser what the file actually is", async () => {
    const who = await principal();
    const { partyId, principalId } = await borrower();
    const app = await application(partyId);
    await transition({
      applicationId: app.id,
      event: "intake_completed",
      actorPrincipalId: who.id,
    });

    try {
      await transition({
        applicationId: app.id,
        event: "borrower_withdrew",
        actorPrincipalId: principalId,
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

    const rows = await ledgerOf(app.id);
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
