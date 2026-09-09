/**
 * Who a person is, across files.
 *
 * The four screens still write a `borrowers` row per file. That row is a
 * snapshot; the party is the person. This module finds-or-creates the party
 * behind a sign-in, gives it a principal to assert things as, and writes what
 * screen 2 collects as FACTS on the party — in the same transaction as the
 * legacy row, so a request either records the person both ways or not at all.
 *
 * Nothing in the four screens reads any of this yet. That is the strangler's
 * first move: dual-write, prove the new rows agree with the old, then read from
 * the new, then stop writing the old. Each is its own change.
 */

import type { AuthorizationPurpose, Prisma } from "@hm/db";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import type { Db } from "./db.js";

type Tx = Db;

/** The party behind a signed-in user, created on first use. */
export async function partyForUser(
  tx: Tx,
  userId: string,
  opts?: { sourceFirstSeen?: "self_signup" | "persona_seed" },
): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { partyId: true },
  });
  if (user.partyId) return user.partyId;

  // Nobody yet, so claim the row before reading it again. Two first saves from
  // one person — a double-submitted screen 1 — both read null here, and
  // without the lock both would mint a party and one would lose the write:
  // a second party for a person the model says has exactly one. The loser
  // waits here and finds the winner's party instead.
  const [locked] = await tx.$queryRaw<{ party_id: string | null }[]>`
    SELECT party_id FROM users WHERE id = ${userId}::uuid FOR UPDATE
  `;
  if (locked?.party_id) return locked.party_id;

  // A person who signed in is not provisional: they came to us. A sample
  // borrower did not, and says so, so a report can tell the two apart.
  const party = await tx.party.create({
    data: {
      kind: "PERSON",
      claimStatus: "CLAIMED",
      sourceFirstSeen: opts?.sourceFirstSeen ?? "self_signup",
    },
    select: { id: true },
  });
  await tx.user.update({ where: { id: userId }, data: { partyId: party.id } });
  return party.id;
}

/** A party for a borrower row that has no user — a demo file. */
export async function partyForDemoBorrower(tx: Tx): Promise<string> {
  const party = await tx.party.create({
    data: { kind: "PERSON", claimStatus: "CLAIMED", sourceFirstSeen: "demo_seed" },
    select: { id: true },
  });
  return party.id;
}

/** The principal a party asserts facts as. One per party. */
export async function principalForParty(tx: Tx, partyId: string): Promise<string> {
  const found = await tx.principal.findFirst({
    where: { kind: "BORROWER", partyId },
    select: { id: true },
  });
  if (found) return found.id;
  const made = await tx.principal.create({
    data: { kind: "BORROWER", subject: `party:${partyId}`, partyId },
    select: { id: true },
  });
  return made.id;
}

/**
 * The principal a piece of the product acts as, looked up by name.
 *
 * `application_flow` writes the orchestration edges — what the borrower owes,
 * that underwriting began. `shadow_aus` writes the decided edges, so the
 * ledger names which engine decided, and it carries the engine's version.
 * Found or created on the `(kind, subject)` unique, never assumed by id: the
 * test harness truncates principals, and the migration's fixed ids are a
 * convenience for a fresh database, not a promise.
 *
 * Insert-then-read, not `upsert`. Prisma's upsert on a compound unique is a
 * SELECT followed by an INSERT, so two first callers race and the loser gets a
 * uniqueness error — inside the transaction a route hands us, that error
 * aborts the whole transaction and the borrower's save goes with it.
 * `createMany` with `skipDuplicates` is the ON CONFLICT DO NOTHING the
 * receipt's own function uses, and it raises nothing.
 */
export async function servicePrincipal(
  db: Db,
  subject: "application_flow" | "shadow_aus",
): Promise<string> {
  const model =
    subject === "shadow_aus" ? { modelId: "shadow", modelVersion: SHADOW_ENGINE_VERSION } : {};
  await db.principal.createMany({
    data: [{ kind: "SERVICE", subject, ...model }],
    skipDuplicates: true,
  });
  // A version already stamped is never overwritten: the ledger's promise is
  // that a transition names the engine that decided it, and a build bump that
  // rewrote this row would quietly restate every older decision as the new
  // one's. Only a row that has no version yet gets one.
  if (subject === "shadow_aus") {
    await db.principal.updateMany({
      where: { kind: "SERVICE", subject, modelVersion: null },
      data: model,
    });
  }
  // Looked up, not assumed: if the row was already there the insert was a
  // no-op, and the ledger must name the id that actually exists.
  const row = await db.principal.findUniqueOrThrow({
    where: { kind_subject: { kind: "SERVICE", subject } },
    select: { id: true },
  });
  return row.id;
}

/** A staff principal by name, found or created. No party: the CHECK says so. */
export async function staffPrincipal(db: Db, subject: string): Promise<string> {
  await db.principal.createMany({
    data: [{ kind: "STAFF", subject }],
    skipDuplicates: true,
  });
  const row = await db.principal.findUniqueOrThrow({
    where: { kind_subject: { kind: "STAFF", subject } },
    select: { id: true },
  });
  return row.id;
}

/**
 * The party's current assertion of `predicate`, or null.
 *
 * "Live" is one definition: not superseded, not retracted, the default
 * subject key, newest observation first. Every reader that wants the current
 * value goes through here so two of them cannot drift apart.
 */
export async function liveFact(
  db: Db,
  partyId: string,
  predicate: string,
): Promise<LiveFact | null> {
  return db.fact.findFirst({
    where: { partyId, predicate, ...LIVE },
    orderBy: { observedAt: "desc" },
    select: { id: true, value: true, observedAt: true },
  });
}

export interface LiveFact {
  readonly id: string;
  readonly value: Prisma.JsonValue;
  readonly observedAt: Date;
}

/** What "live" means, in one place, so the two readers below cannot drift. */
const LIVE = { subjectKey: "", supersededById: null, retractedAt: null } as const;

/**
 * The same answer for many parties at once, keyed by party.
 *
 * The file list asks every row for its borrower's name, which was one query
 * per file. Same definition of live, same ordering; the newest observation per
 * party wins because the rows arrive newest-first and the first write into the
 * map is kept.
 */
export async function liveFactsByParty(
  db: Db,
  partyIds: readonly string[],
  predicate: string,
): Promise<Map<string, LiveFact>> {
  const found = new Map<string, LiveFact>();
  if (partyIds.length === 0) return found;
  const rows = await db.fact.findMany({
    where: { partyId: { in: [...new Set(partyIds)] }, predicate, ...LIVE },
    orderBy: { observedAt: "desc" },
    select: { id: true, value: true, observedAt: true, partyId: true },
  });
  for (const { partyId, ...fact } of rows) {
    if (partyId && !found.has(partyId)) found.set(partyId, fact);
  }
  return found;
}

/**
 * The party's live grant for exactly `purpose`, or null.
 *
 * By purpose, never "any live grant": persistent monitoring mirrors to an
 * account-review grant, which covers no credit request and which the pin
 * guard refuses. Live is unrevoked and unexpired, the same test the minter
 * applies, so a pin and a pull agree about which grant stands.
 */
export async function liveGrant(
  db: Db,
  partyId: string,
  purpose: AuthorizationPurpose,
): Promise<{ id: string; grantedAt: Date; expiresAt: Date } | null> {
  return db.authorization.findFirst({
    where: { partyId, purpose, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { grantedAt: "desc" },
    select: { id: true, grantedAt: true, expiresAt: true },
  });
}

export interface AssertedFact {
  readonly predicate: string;
  readonly value: Prisma.InputJsonValue;
  /** When it was true. Defaults to now — screen 2 is the borrower speaking now. */
  readonly observedAt?: Date;
}

/**
 * Write facts the borrower just stated, superseding any live prior assertion
 * of the same predicate.
 *
 * Going back to screen 2 and saving again must not leave two live legal_name
 * facts. The old one is superseded — pointed at its replacement, never edited
 * — so the history of what they said, and when, is intact.
 */
export async function assertFacts(
  tx: Tx,
  partyId: string,
  principalId: string,
  facts: readonly AssertedFact[],
): Promise<void> {
  const now = new Date();
  for (const f of facts) {
    const created = await tx.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: partyId,
        partyId,
        predicate: f.predicate,
        value: f.value,
        sourceKind: "SELF_ATTESTED",
        confidence: "ATTESTED",
        assertedByPrincipalId: principalId,
        observedAt: f.observedAt ?? now,
      },
      select: { id: true },
    });
    // Retire the earlier live assertion of this predicate. The ledger's
    // append-only trigger permits exactly this column, and `supersededById` is
    // unique — a fact has one successor — so this is a chain, and there is at
    // most one live prior to point at the new row. Found, then updated, rather
    // than an updateMany that would trip the uniqueness if history ever held
    // two live rows.
    const prior = await tx.fact.findFirst({
      where: {
        partyId,
        predicate: f.predicate,
        subjectKey: "",
        supersededById: null,
        retractedAt: null,
        id: { not: created.id },
      },
      orderBy: { observedAt: "desc" },
      select: { id: true },
    });
    if (prior) {
      await tx.fact.update({ where: { id: prior.id }, data: { supersededById: created.id } });
    }
  }
}

/** What screen 2 collects. The subset the party needs; the route validates it. */
export interface BorrowerInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly dateOfBirth: string;
  readonly ssnVaultHandle?: string;
  readonly currentAddress: {
    readonly line1: string;
    readonly line2?: string;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly maritalStatus: string;
  readonly citizenship: string;
  readonly preferredLanguage: string;
  readonly firstTimeHomebuyer?: boolean | null;
  readonly isMilitary: boolean;
  readonly currentHousing: string;
  readonly monthlyRent?: number | null;
  /**
   * Optional because a revisit of screen 2 need not restate it: the fact
   * asserted the first time stands. The route decides when it is required.
   */
  readonly statedMonthlyIncome?: number;
}

/**
 * Record what a borrower said on screen 2, on the party.
 *
 * Finds or creates the party behind the file's owner (or a fresh one for a
 * demo file), gives it a principal, and asserts every collected field as a
 * fact — superseding the earlier assertion of each predicate, so saving screen
 * 2 twice is one person changing their mind rather than two people. Returns
 * the party id for the caller to put on the borrower row in the same
 * transaction.
 */
export async function recordBorrowerFacts(
  tx: Tx,
  args: { loanFileId: string; existingPartyId: string | null; input: BorrowerInput },
): Promise<string> {
  const { loanFileId, existingPartyId, input } = args;
  const owner = await tx.loanFile.findUniqueOrThrow({
    where: { id: loanFileId },
    select: { userId: true },
  });
  const partyId =
    existingPartyId ??
    (owner.userId ? await partyForUser(tx, owner.userId) : await partyForDemoBorrower(tx));
  const principalId = await principalForParty(tx, partyId);

  await assertFacts(tx, partyId, principalId, [
    { predicate: "legal_name", value: { first: input.firstName, last: input.lastName } },
    { predicate: "date_of_birth", value: input.dateOfBirth },
    { predicate: "email", value: input.email },
    { predicate: "phone", value: input.phone },
    { predicate: "current_address", value: { ...input.currentAddress } },
    { predicate: "marital_status", value: input.maritalStatus },
    { predicate: "citizenship", value: input.citizenship },
    { predicate: "is_military", value: input.isMilitary },
    // Three-state: yes, no, or not asked. "Not asked" is the ABSENCE of a
    // fact, not a fact whose value is null — a null-valued fact says nothing,
    // and the pin guard refuses one on exactly that principle.
    ...(input.firstTimeHomebuyer != null
      ? [{ predicate: "first_time_homebuyer", value: input.firstTimeHomebuyer }]
      : []),
    { predicate: "current_housing", value: input.currentHousing },
    { predicate: "preferred_language", value: input.preferredLanguage },
    // Stated, not verified. One of TRID's six pieces, and the reason screen 2
    // asks for it — see packages/shared/src/trid.ts. Only a real figure is a
    // fact: an absent one leaves the earlier assertion standing, and a zero
    // or negative would supersede a true income with a false one.
    ...(typeof input.statedMonthlyIncome === "number" && input.statedMonthlyIncome > 0
      ? [{ predicate: "monthly_income", value: input.statedMonthlyIncome }]
      : []),
    // The vault handle is a reference, never the number. Only on a first save,
    // or when it is being replaced.
    ...(input.ssnVaultHandle ? [{ predicate: "ssn_token", value: input.ssnVaultHandle }] : []),
    ...(input.monthlyRent != null ? [{ predicate: "monthly_rent", value: input.monthlyRent }] : []),
  ]);

  return partyId;
}
