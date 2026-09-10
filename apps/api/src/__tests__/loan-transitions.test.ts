/**
 * What the database refuses to let a loan's state change be.
 *
 * The machine's own properties are tested without Postgres in
 * packages/shared/src/__tests__/loan-machine.test.ts. These are the ones that
 * only exist because the guarantees live in the database: that the column
 * cannot move without the ledger, that an ending is final, that a loan is born
 * in one of exactly two states, and that its ledger never names a principal
 * that dies with a person.
 *
 * The first test here is the agreement that file could not make. The eleven
 * names in `LOAN_STATES` and the eleven labels in the Postgres enum have to be
 * the same set, and the type does not exist until the migration that creates
 * `loans` — so the comparison lands here, in the shape `transition.test.ts`
 * already uses for applications.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { LOAN_STATES, type LoanEvent } from "@hm/shared";
import { moveLoan, moveLoanIfLegal, toDbLoanState } from "../services/loan-transition.js";
import { createImportedLoan } from "../services/loans.js";
import { TransitionConflict } from "../services/aggregate-transition.js";
import { servicePrincipal } from "../services/party.js";
import { createParty, importedLoan } from "./support/factories.js";

let n = 0;
const uniq = () => `${Date.now().toString(36)}-${(n += 1)}`;

/** The service every loan move in this file runs under. Never a borrower's. */
async function actor() {
  return servicePrincipal(prisma, "claim_flow");
}

/** A mortgage a feed sent us, with one person on it. */
async function loan() {
  const party = await createParty({ sourceFirstSeen: "grander_import" });
  return importedLoan([{ partyId: party.id }]);
}

/** Walk a loan to a state through legal moves, so tests start where they mean to. */
async function drive(id: string, actorPrincipalId: string, events: LoanEvent[]) {
  for (const event of events) await moveLoan({ id, event, actorPrincipalId });
}

async function ledgerOf(loanId: string) {
  return prisma.loanTransition.findMany({ where: { loanId }, orderBy: { seq: "asc" } });
}

/** A raw status change that satisfies every trigger but the one under test. */
function forceStatus(loanId: string, to: string) {
  return prisma.$executeRawUnsafe(
    `UPDATE loans SET status = '${to}', status_seq = status_seq + 1,
     status_entered_at = status_entered_at + interval '1 second' WHERE id = $1::uuid`,
    loanId,
  );
}

describe("the vocabularies agree", () => {
  it("stores exactly the states the machine knows, in both directions", async () => {
    // A state added to one and not the other is a mortgage that can enter a
    // state nothing knows how to render, or a name the machine offers and the
    // column refuses.
    const rows = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'LoanState'
    `;
    const inDb = rows.map((r) => r.label.toLowerCase()).sort();
    expect(inDb).toEqual([...LOAN_STATES].sort());
    expect(rows.map((r) => r.label).sort()).toEqual(LOAN_STATES.map(toDbLoanState).sort());
  });
});

describe("a loan is born, not placed", () => {
  it("refuses an INSERT at any state but the two beginnings", async () => {
    // The guard a bulk importer most wants to skip: an extract that says a
    // mortgage is active would otherwise create one that never boarded, with
    // no move on the ledger to say who decided it was.
    const party = await createParty();
    await expect(
      prisma.loan.create({
        data: {
          status: "ACTIVE",
          source: "PARTNER_IMPORT",
          rateType: "FIXED",
          noteRateBps: 625,
          termMonths: 360,
          originalPrincipalCents: 41_600_000n,
          parties: { create: [{ partyId: party.id, role: "PRIMARY_BORROWER" }] },
        },
      }),
    ).rejects.toThrow(/not at ACTIVE/);
  });

  it("makes both beginnings, and nothing else", async () => {
    const made = await loan();
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.status).toBe("IMPORTED_UNCLAIMED");
    expect(row.statusSeq).toBe(0);
    // Seq 0 with no ledger row is what a birth is, and the deferred check
    // permits it exactly as it does for a draft application.
    expect(await ledgerOf(made.id)).toHaveLength(0);
  });

  it("refuses to make a mortgage with nobody on it", async () => {
    // The constructors write the row and its parties in one act, and this is
    // the half of that sentence a caller could otherwise walk past. It matters
    // beyond tidiness: users_delete_takes_loans sweeps away a loan the
    // deletion left with no parties, on the argument that such a row is not a
    // record about anybody — which is true of a write that stopped halfway and
    // false of a shape the product hands out on request.
    await expect(
      createImportedLoan(prisma, {
        terms: {
          rateType: "FIXED",
          noteRateBps: 625,
          termMonths: 360,
          originalPrincipalCents: 41_600_000n,
        },
        property: {},
        axes: {},
        parties: [],
        servicerId: null,
      }),
    ).rejects.toThrow(/created with the people on it/);
    expect(await prisma.loan.count({ where: { parties: { none: {} } } })).toBe(0);
  });
});

describe("a move is recorded or it does not happen", () => {
  it("writes a ledger row with the column", async () => {
    const who = await actor();
    const made = await loan();
    const moved = await moveLoan({
      id: made.id,
      event: "borrower_claimed",
      actorPrincipalId: who,
      reasonCode: "claim_confirmed",
    });

    expect(moved).toMatchObject({ from: "imported_unclaimed", to: "monitoring_only", seq: 1 });
    const rows = await ledgerOf(made.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      fromState: "IMPORTED_UNCLAIMED",
      toState: "MONITORING_ONLY",
      event: "borrower_claimed",
      reasonCode: "claim_confirmed",
    });
  });

  it("REFUSES a bare status update", async () => {
    // The call that typechecks, lints clean, passes every mocked test, and
    // makes a stranger's mortgage ours with no record of who did it or why.
    const made = await loan();
    await expect(
      prisma.loan.update({ where: { id: made.id }, data: { status: "MONITORING_ONLY" } }),
    ).rejects.toThrow(/without advancing status_seq/);
  });

  it("refuses a status change with a sequence but no explanation", async () => {
    // Advancing the sequence by hand gets past the first trigger. The deferred
    // constraint catches it at COMMIT, because that is the only moment "did
    // this transaction also record why" can be answered.
    const made = await loan();
    await expect(
      prisma.loan.update({
        where: { id: made.id },
        data: { status: "MONITORING_ONLY", statusSeq: 1, statusEnteredAt: new Date() },
      }),
    ).rejects.toThrow(/no matching transition row/);
    const still = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(still.status).toBe("IMPORTED_UNCLAIMED");
  });

  it("refuses a sequence bump that changes nothing", async () => {
    const made = await loan();
    await expect(
      prisma.loan.update({ where: { id: made.id }, data: { statusSeq: 1 } }),
    ).rejects.toThrow(/without changing status/);
  });

  it("keeps the ledger append-only", async () => {
    const who = await actor();
    const made = await loan();
    await moveLoan({ id: made.id, event: "borrower_claimed", actorPrincipalId: who });
    const row = await prisma.loanTransition.findFirstOrThrow({ where: { loanId: made.id } });
    await expect(
      prisma.loanTransition.update({ where: { id: row.id }, data: { event: "payoff_posted" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("passes the deferred check on two moves in one transaction", async () => {
    // A servicing extract can imply two moves at once — a transfer announced
    // and settled between batches. The deferred constraint matches each status
    // against its own ledger row, not only the last one.
    const who = await actor();
    const made = await loan();
    await prisma.$transaction(async (tx) => {
      await moveLoan({ id: made.id, event: "borrower_claimed", actorPrincipalId: who }, tx);
      await moveLoan({ id: made.id, event: "transfer_announced", actorPrincipalId: who }, tx);
    });
    const rows = await ledgerOf(made.id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.map((r) => r.toState)).toEqual(["MONITORING_ONLY", "IN_SERVICING_TRANSFER"]);
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.status).toBe("IN_SERVICING_TRANSFER");
    expect(row.statusSeq).toBe(2);
  });
});

describe("an ending is an ending", () => {
  /** How a loan reaches each of the five, through legal moves only. */
  const ENDINGS: Record<string, LoanEvent[]> = {
    PAID_OFF: ["payoff_posted"],
    CHARGED_OFF: ["charge_off_posted"],
    MATURED: ["term_completed"],
    TRANSFERRED_OUT: ["borrower_claimed", "transfer_announced", "transfer_completed_outbound"],
    REFINANCED_INTERNALLY: ["borrower_claimed", "refinanced_by_us"],
  };

  for (const [ending, events] of Object.entries(ENDINGS)) {
    it(`refuses to reopen ${ending.toLowerCase()}`, async () => {
      const who = await actor();
      const made = await loan();
      if (ending === "REFINANCED_INTERNALLY") {
        // refinanced_internally without the loan that did it is an
        // unfalsifiable claim, so the successor is named before the move.
        const successor = await loan();
        await prisma.loan.update({
          where: { id: made.id },
          data: { refinancedByLoanId: successor.id },
        });
      }
      await drive(made.id, who, events);
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: made.id } })).status).toBe(ending);

      // Raw SQL, because the machine refuses this before the database sees it.
      // Belt and braces: the two enforce it for different callers.
      await expect(forceStatus(made.id, "ACTIVE")).rejects.toThrow(/cannot be reopened/);
    });
  }

  it("refuses refinanced_internally with no successor named", async () => {
    // A rule about the MOVE, and a trigger rather than a CHECK for exactly one
    // reason: `refinanced_by_loan_id` is ON DELETE SET NULL, a referential
    // action is an UPDATE, and a CHECK on the row would refuse that UPDATE from
    // inside somebody else's DELETE. Here is the half that has to keep working
    // anyway — claiming the state without naming the loan that caused it is
    // refused at the moment it is claimed.
    const who = await actor();
    const made = await loan();
    await drive(made.id, who, ["borrower_claimed"]);

    await expect(
      moveLoan({ id: made.id, event: "refinanced_by_us", actorPrincipalId: who }),
    ).rejects.toThrow(/without naming the loan that did it/);

    const still = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(still.status).toBe("MONITORING_ONLY");
    expect(await ledgerOf(made.id)).toHaveLength(1);
  });

  it("lets the successor be erased and leaves the predecessor saying so", async () => {
    // The other half, and the one the CHECK made impossible. Erasing the
    // successor nulls the predecessor's pointer through the foreign key — an
    // UPDATE nobody asked for, on a row that is terminal and therefore cannot
    // be moved out of the way first. A rule on the row aborts that DELETE
    // permanently; a rule on the move lets it through and leaves a predecessor
    // whose successor is gone saying so with a NULL.
    const who = await actor();
    const made = await loan();
    const successor = await loan();
    await prisma.loan.update({
      where: { id: made.id },
      data: { refinancedByLoanId: successor.id },
    });
    await drive(made.id, who, ["borrower_claimed", "refinanced_by_us"]);

    await prisma.loan.delete({ where: { id: successor.id } });

    const still = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(still.status).toBe("REFINANCED_INTERNALLY");
    expect(still.refinancedByLoanId).toBeNull();
  });
});

describe("a loan's ledger never names a principal that dies with a person", () => {
  it("refuses a borrower's own principal, and takes a service's", async () => {
    // Loans outlive their parties by design. With actor_principal_id on
    // RESTRICT and SET NULL impossible, a BORROWER actor on a surviving loan
    // is an account that cannot be deleted at all — on precisely the case the
    // two-party mortgage advertises as working.
    const party = await createParty();
    const theirs = await prisma.principal.create({
      data: { kind: "BORROWER", subject: `b-${uniq()}`, partyId: party.id },
      select: { id: true },
    });
    const made = await importedLoan([{ partyId: party.id }]);

    await expect(
      moveLoan({ id: made.id, event: "borrower_claimed", actorPrincipalId: theirs.id }),
    ).rejects.toThrow(/dies with them/);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: made.id } })).status).toBe(
      "IMPORTED_UNCLAIMED",
    );

    const who = await actor();
    await moveLoan({ id: made.id, event: "borrower_claimed", actorPrincipalId: who });
    const rows = await ledgerOf(made.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorPrincipalId).toBe(who);
  });
});

describe("two writers racing", () => {
  it("gives the loser a conflict, not a silent overwrite", async () => {
    // Both read imported_unclaimed. One of them is about to be wrong, and it
    // must find out rather than overwrite the other's move.
    const who = await actor();
    const made = await loan();

    const results = await Promise.allSettled([
      moveLoan({
        id: made.id,
        event: "borrower_claimed",
        actorPrincipalId: who,
        expectedFrom: "imported_unclaimed",
      }),
      moveLoan({
        id: made.id,
        event: "payoff_posted",
        actorPrincipalId: who,
        expectedFrom: "imported_unclaimed",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r) => r.status === "rejected");
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionConflict);

    // Exactly one move, exactly one ledger row, and they agree.
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    const rows = await ledgerOf(made.id);
    expect(row.statusSeq).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toState).toBe(row.status);
  });

  it("reads a landing state with no such edge as a skip, not a conflict", async () => {
    // A servicing extract re-sends a record whose move has already been made
    // somewhere else. Answering that with a 409 would refuse an event whose
    // whole effect had just happened.
    const who = await actor();
    const made = await loan();
    await moveLoan({ id: made.id, event: "payoff_posted", actorPrincipalId: who });

    const advance = await moveLoanIfLegal({
      id: made.id,
      event: "borrower_claimed",
      actorPrincipalId: who,
    });
    expect(advance).toEqual({ skipped: "no_edge", from: "paid_off" });
    expect(await ledgerOf(made.id)).toHaveLength(1);
  });

  it("keeps status_entered_at strictly increasing at TIMESTAMP(3)", async () => {
    // Two moves in one request land on the same millisecond often enough to
    // matter, and a status change whose stamp did not move is refused by the
    // database. The floor is what keeps the two from disagreeing.
    const who = await actor();
    const made = await loan();
    const when = new Date();
    await moveLoan({
      id: made.id,
      event: "borrower_claimed",
      actorPrincipalId: who,
      occurredAt: when,
    });
    await moveLoan({
      id: made.id,
      event: "transfer_announced",
      actorPrincipalId: who,
      occurredAt: when,
    });

    const rows = await ledgerOf(made.id);
    expect(rows[1]!.occurredAt.getTime()).toBeGreaterThan(rows[0]!.occurredAt.getTime());
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.statusEnteredAt.getTime()).toBe(rows[1]!.occurredAt.getTime());
  });

  it("answers a loan that is not there with 404", async () => {
    const who = await actor();
    await expect(
      moveLoan({ id: randomUUID(), event: "borrower_claimed", actorPrincipalId: who }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });
});
