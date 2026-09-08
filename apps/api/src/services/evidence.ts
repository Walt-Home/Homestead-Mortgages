/**
 * Borrowing facts into an application, and proposing terms.
 *
 * An application holds no borrower columns. It BORROWS facts from a party by
 * pinning them, and the pin records which authorization it borrowed under.
 * That is the legal act — TRID's six pieces must be received in connection
 * with a request for credit, not merely held on file — and the database stamps
 * the receipt the moment the sixth lands. Nothing here calls `transition()`
 * for that; the trigger does, with a ledger row, and this module cannot forget.
 *
 * The guards are in Postgres and this file does not repeat them. What it does
 * is load the fact so the caller cannot mislabel the pin, and turn the
 * database's refusals into the errors the routes already know how to render.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import { TRID_PARTY_PREDICATES, TRID_SCENARIO_FIELDS } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";

export interface PinInput {
  readonly applicationId: string;
  readonly factId: string;
  readonly authorizationId: string;
}

/**
 * Pin a fact to an application under an authorization.
 *
 * The trigger refuses a fact whose party is not on the application, an
 * authorization from a different party, and one that is revoked or expired —
 * each with its own message, surfaced here as a 403 carrying that message.
 */
export async function pinFact(input: PinInput): Promise<{ id: string; predicate: string }> {
  const fact = await prisma.fact.findUnique({
    where: { id: input.factId },
    select: { predicate: true, observedAt: true },
  });
  if (!fact) throw new AppError(404, "Fact not found", "NOT_FOUND");

  try {
    return await prisma.applicationEvidenceLink.create({
      data: {
        applicationId: input.applicationId,
        factId: input.factId,
        authorizationId: input.authorizationId,
        // The trigger overwrites both from the fact. Passed here so the row is
        // complete before the trigger runs, and so a reader of this code sees
        // what a pin carries.
        predicate: fact.predicate,
        asOf: fact.observedAt,
      },
      select: { id: true, predicate: true },
    });
  } catch (err) {
    throw asRefusal(err, "pin");
  }
}

/** Stop relying on a pinned fact. Never deletes the pin. */
export async function releasePin(pinId: string): Promise<void> {
  try {
    await prisma.applicationEvidenceLink.update({
      where: { id: pinId },
      data: { releasedAt: new Date() },
    });
  } catch (err) {
    throw asRefusal(err, "pin");
  }
}

export interface ScenarioTerms {
  readonly objective:
    "PURCHASE" | "RATE_TERM_REFINANCE" | "CASH_OUT_REFINANCE" | "HELOC_DRAW" | "CLOSED_END_SECOND";
  readonly occupancy: "PRIMARY_RESIDENCE" | "SECOND_HOME" | "INVESTMENT";
  readonly lienPosition?: "FIRST" | "SECOND" | "SUBORDINATE_HELOC";
  readonly loanAmountCents: bigint;
  readonly downPaymentCents?: bigint;
  readonly termMonths: number;
  readonly noteRateBps?: number | null;
  readonly propertyAddress?: string | null;
  readonly valueEstimateCents?: bigint | null;
  readonly origin?: "BORROWER" | "COUNTEROFFER" | "REPRICING" | "STAFF" | "AI_SUGGESTED";
}

/**
 * Propose terms. Always a NEW scenario at the next sequence; the current active
 * one is retired in the same transaction, so there is never a moment with two
 * live or none.
 */
export async function proposeScenario(
  applicationId: string,
  terms: ScenarioTerms,
): Promise<{ id: string; seq: number }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.loanScenario.findFirst({
        where: { applicationId, isActive: true },
        select: { id: true, seq: true },
      });
      const seq = (current?.seq ?? 0) + 1;

      if (current) {
        await tx.loanScenario.update({
          where: { id: current.id },
          data: { isActive: false, supersededBySeq: seq },
        });
      }

      return tx.loanScenario.create({
        data: {
          applicationId,
          seq,
          objective: terms.objective,
          occupancy: terms.occupancy,
          lienPosition: terms.lienPosition ?? "FIRST",
          loanAmountCents: terms.loanAmountCents,
          downPaymentCents: terms.downPaymentCents ?? 0n,
          termMonths: terms.termMonths,
          noteRateBps: terms.noteRateBps ?? null,
          propertyAddress: terms.propertyAddress?.trim() || null,
          valueEstimateCents: terms.valueEstimateCents ?? null,
          origin: terms.origin ?? "BORROWER",
        },
        select: { id: true, seq: true },
      });
    });
  } catch (err) {
    throw asRefusal(err, "scenario");
  }
}

/** Which of TRID's six pieces an application holds. For a screen, not a guard. */
export async function sixPieces(applicationId: string): Promise<Record<string, boolean>> {
  const [pins, scenario] = await Promise.all([
    prisma.applicationEvidenceLink.findMany({
      where: { applicationId, releasedAt: null },
      select: { predicate: true },
    }),
    prisma.loanScenario.findFirst({
      where: { applicationId, isActive: true },
      select: { propertyAddress: true, valueEstimateCents: true, loanAmountCents: true },
    }),
  ]);
  const have = new Set(pins.map((p) => p.predicate));
  const out: Record<string, boolean> = {};
  // '' is not an address, and a screen must not agree with a false receipt.
  const present = (v: unknown) => v != null && !(typeof v === "string" && v.trim() === "");
  for (const p of TRID_PARTY_PREDICATES) out[p] = have.has(p);
  for (const f of TRID_SCENARIO_FIELDS) out[f] = present(scenario?.[f]);
  return out;
}

/** A Postgres refusal from a trigger or a constraint, as the error it means. */
function asRefusal(err: unknown, what: "pin" | "scenario"): unknown {
  const e = err as Prisma.PrismaClientKnownRequestError & {
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
  };
  // A unique violation ALSO carries an originalMessage, so it has to be
  // recognized first — otherwise a collision surfaces as a 403 refusal rather
  // than the 409 it is. Which collision depends on what was being written: two
  // proposals racing lose on (application_id, seq), and telling that caller
  // "already pinned" is the wrong explanation for a call that pinned nothing.
  if (e?.code === "P2002") {
    return what === "pin"
      ? new AppError(409, "That fact is already pinned to this application.", "ALREADY_PINNED")
      : new AppError(
          409,
          "Terms were proposed on this application at the same time. Reload and propose again.",
          "SCENARIO_CONFLICT",
        );
  }
  const msg = e?.meta?.driverAdapterError?.cause?.originalMessage;
  if (msg) return new AppError(403, msg, "EVIDENCE_REFUSED");
  return err;
}
