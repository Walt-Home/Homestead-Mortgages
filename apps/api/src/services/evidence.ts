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
 *
 * Every writer takes a client last. Inside a route's transaction the pin and
 * the receipt it fires commit with the row that caused them; a pin refused by
 * the database rolls that whole save back, which is what a refused invariant
 * should do.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import { TERMINAL, TRID_PARTY_PREDICATES, TRID_SCENARIO_FIELDS } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { ownsTransaction, type Db } from "./db.js";
import { liveFact, liveGrant } from "./party.js";
import { toDomainState } from "./transition.js";

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
export async function pinFact(
  input: PinInput,
  db: Db = prisma,
): Promise<{ id: string; predicate: string }> {
  const fact = await db.fact.findUnique({
    where: { id: input.factId },
    select: { predicate: true, observedAt: true },
  });
  if (!fact) throw new AppError(404, "Fact not found", "NOT_FOUND");

  try {
    return await db.applicationEvidenceLink.create({
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
export async function releasePin(pinId: string, db: Db = prisma): Promise<void> {
  try {
    await db.applicationEvidenceLink.update({
      where: { id: pinId },
      data: { releasedAt: new Date() },
    });
  } catch (err) {
    throw asRefusal(err, "pin");
  }
}

/** What a reconciliation did. `grantId` null means there was nothing to pin under. */
export interface PinReconciliation {
  /** The live FCRA grant everything was pinned under, or null when there is none. */
  readonly grantId: string | null;
  /** Predicates newly pinned by this call. */
  readonly pinned: string[];
  /** Pin ids released as stale by this call. */
  readonly released: string[];
}

/**
 * Bring an application's borrowed party facts up to date. A reconciler, never
 * a blind pin.
 *
 * Screen 2 is saved more than once, a name is corrected, an income is fixed,
 * and a signature is renewed after 120 days. Each of those leaves the pins
 * pointing at something that is no longer true: `assertFacts` supersedes the
 * old fact but the pin still names it, and the mirror trigger retires a lapsed
 * grant but the pin still borrows under it. Pinning again without looking
 * would either collide on the live-pin index or add a second pin for the same
 * predicate. So every save asks the same question per predicate — is there a
 * live pin, on the live fact, under a live grant? — and only writes when the
 * answer is no.
 *
 * What licenses the borrowing is the party's live grant, looked up BY PURPOSE
 * and never as "any live grant". Persistent monitoring mirrors to an
 * account-review grant, which covers no credit request and which the pin guard
 * refuses outright — so asking for any grant would turn an opt-in to
 * monitoring into the authorization an application was borrowed under, and the
 * refusal would reach the borrower as a 403 on an ordinary save.
 *
 * Nothing to borrow under is not an error: it is the ordinary state of a first
 * save on any file, where screen 2 writes the facts and the consent that
 * follows it is what pins them.
 *
 * An application that has ENDED is left exactly as it is. Its evidence is the
 * record of what it was decided on, and re-pointing a withdrawn or denied
 * file's pins would quietly rewrite the basis of somebody's ending. The check
 * lives HERE rather than in the callers because screen 2, the consent and the
 * e-sign completion all pin directly: asking each of them to remember would
 * mean the invariant held on the paths somebody thought of and nowhere else,
 * and saving screen 2 at a withdrawn file's URL really did move its pins.
 *
 * The inserts fire the receipt trigger inside the caller's transaction, so the
 * third piece of a still-draft application stamps it and opens the Loan
 * Estimate clock with the save that completed it. After that the receipt
 * returns at `status <> DRAFT` and a re-pin is evidence upkeep with no state
 * effect, which is why this can run on every save.
 */
export async function pinTridPieces(
  db: Db,
  args: { applicationId: string; partyId: string },
): Promise<PinReconciliation> {
  const { applicationId, partyId } = args;
  const application = await db.application.findUnique({
    where: { id: applicationId },
    select: { status: true },
  });
  if (!application || TERMINAL.includes(toDomainState(application.status)))
    return { grantId: null, pinned: [], released: [] };

  const grant = await liveGrant(db, partyId, "FCRA_WRITTEN_INSTRUCTION");
  if (!grant) return { grantId: null, pinned: [], released: [] };

  const now = new Date();
  const pinned: string[] = [];
  const released: string[] = [];

  for (const predicate of TRID_PARTY_PREDICATES) {
    const fact = await liveFact(db, partyId, predicate);
    // Nothing asserted for this piece. A revisit that did not restate an
    // income must not release the pin the first save made: absent is absent,
    // and the earlier evidence stands.
    if (!fact) continue;

    const live = await db.applicationEvidenceLink.findMany({
      where: { applicationId, predicate, releasedAt: null, fact: { partyId } },
      select: {
        id: true,
        factId: true,
        authorization: { select: { revokedAt: true, expiresAt: true } },
      },
    });
    // A pin is current when it names the fact that stands now, under an
    // authorization that still stands.
    const isCurrent = (pin: (typeof live)[number]) =>
      pin.factId === fact.id &&
      pin.authorization.revokedAt === null &&
      pin.authorization.expiresAt > now;

    // The sweep runs before the decision to skip, never after it. Deciding
    // first left the OTHER live pins on this predicate standing whenever one
    // of them was current — the live-pin index is keyed on
    // (application_id, fact_id), so pins naming different facts do not collide
    // and nothing else was ever going to come back for them. It perpetuated
    // itself, too: the next save took the same short circuit. The receipt
    // counts live pins, so a stale one is a piece the application says it
    // holds and has nothing behind.
    for (const stale of live) {
      if (isCurrent(stale)) continue;
      await releasePin(stale.id, db);
      released.push(stale.id);
    }
    if (live.some(isCurrent)) continue;

    await pinFact({ applicationId, factId: fact.id, authorizationId: grant.id }, db);
    pinned.push(predicate);
  }

  return { grantId: grant.id, pinned, released };
}

/**
 * Reconcile every application this person's evidence is borrowed into.
 *
 * One person, two files. Screen 1 of the second states an income and
 * supersedes the fact the first one's application borrowed — and until this
 * existed, nothing ever looked at an application other than the one the
 * request happened to be about, so the first file kept a live pin on a fact
 * the borrower had replaced, forever. A pin is what an application relies on
 * NOW, and the receipt counts live pins without asking whether the fact behind
 * one still stands: the SQL and `sixPieces` would both have gone on reporting
 * a piece held on evidence that had been taken back.
 *
 * Nothing is lost by re-pointing a pin. The superseded fact is still there
 * with its supersession chain, the released pin is still there with its
 * `released_at`, and the ledger says when intake happened.
 *
 * An application that has ended is left alone, which this does not have to
 * arrange: `pinTridPieces` refuses one whoever asks.
 */
export async function reconcilePartyEvidence(db: Db, partyId: string): Promise<void> {
  const on = await db.applicationParty.findMany({
    where: { partyId, role: "PRIMARY_BORROWER" },
    select: { applicationId: true },
  });
  for (const membership of on) {
    await pinTridPieces(db, { applicationId: membership.applicationId, partyId });
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
  db: Db = prisma,
): Promise<{ id: string; seq: number }> {
  const propose = async (tx: Db) => {
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
  };

  try {
    return ownsTransaction(db) ? await prisma.$transaction(propose) : await propose(db);
  } catch (err) {
    throw asRefusal(err, "scenario");
  }
}

/** Which of TRID's six pieces an application holds. For a screen, not a guard. */
export async function sixPieces(
  applicationId: string,
  db: Db = prisma,
): Promise<Record<string, boolean>> {
  const [pins, scenario] = await Promise.all([
    db.applicationEvidenceLink.findMany({
      where: {
        applicationId,
        releasedAt: null,
        fact: { party: { applications: { some: { applicationId, role: "PRIMARY_BORROWER" } } } },
      },
      select: { predicate: true, fact: { select: { partyId: true } } },
    }),
    db.loanScenario.findFirst({
      where: { applicationId, isActive: true },
      select: { propertyAddress: true, valueEstimateCents: true, loanAmountCents: true },
    }),
  ]);
  // One set of predicates per person, and the fullest set is the answer. The
  // party-side pieces are counted per person because TRID's pieces are about
  // the consumer who is applying: a co-borrower's SSN beside the primary's
  // name and income is nobody's three, and the receipt trigger counts it the
  // same way. Counting across the application instead let this say the six
  // were held while the database still said draft.
  const byParty = new Map<string, Set<string>>();
  for (const pin of pins) {
    if (pin.fact.partyId == null) continue;
    const held = byParty.get(pin.fact.partyId) ?? new Set<string>();
    held.add(pin.predicate);
    byParty.set(pin.fact.partyId, held);
  }
  const pieces = (held: Set<string>) => TRID_PARTY_PREDICATES.filter((p) => held.has(p)).length;
  let have = new Set<string>();
  for (const held of byParty.values()) if (pieces(held) > pieces(have)) have = held;

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
