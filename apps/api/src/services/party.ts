/**
 * Who a person is, across files.
 *
 * The borrower screens still write a `borrowers` row per file. That row is a
 * snapshot; the party is the person. This module finds-or-creates the party
 * behind a sign-in, gives it a principal to assert things as, and writes what
 * screen 2 collects as FACTS on the party — in the same transaction as the
 * legacy row, so a request either records the person both ways or not at all.
 *
 * Nothing in the borrower screens reads any of this yet. That is the strangler's
 * first move: dual-write, prove the new rows agree with the old, then read from
 * the new, then stop writing the old. Each is its own change.
 *
 * Not every party came to us, though, and the second half of this module is
 * about the ones that did not: a person a partner's feed named, held
 * provisionally, asserted about at the tier a partner's word earns, and folded
 * into their own party if they ever turn up and prove it is them.
 */

import type { AuthorizationPurpose, Fact, Prisma } from "@hm/db";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import { AppError } from "../middleware/error-handler.js";
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
 * `claim_flow` and `retention` are the two the loan ledger needs, and they are
 * SERVICE principals for a structural reason rather than a stylistic one: a
 * loan outlives its parties, so a move recorded under a person's own principal
 * would be an account that cannot be deleted. Found or created on the
 * `(kind, subject)` unique, never assumed by id: the test harness truncates
 * principals, and the migration's fixed ids are a convenience for a fresh
 * database, not a promise.
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
  subject: "application_flow" | "shadow_aus" | "claim_flow" | "retention",
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
  /**
   * Absent is "not asked". Screen 2 does not collect it — screen 3 does, into
   * `du_residences`, and this column is the copy derived from that row. The
   * fact this used to assert on every save was the string `"rent"`.
   */
  readonly currentHousing?: string | null;
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
 * Finds or creates the party behind the file's owner, gives it a principal,
 * and asserts every collected field as a fact — superseding the earlier
 * assertion of each predicate, so saving screen 2 twice is one person changing
 * their mind rather than two people. Returns the party id for the caller to
 * put on the borrower row in the same transaction.
 *
 * Every file has an owner. The ownerless demo file the old seed made is gone;
 * a sample borrower is a real user with a real party, which is what lets one
 * be walked through the same doors as anybody else.
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
  // An ownerless file has nobody to be the party of. The column is still
  // nullable and the old demo seed used to leave files that way; nothing
  // creates one now, and minting a fresh party for each save would give one
  // person a new identity every time they corrected a typo.
  if (!existingPartyId && !owner.userId) {
    throw new AppError(409, "A file with no owner cannot record a person.", "NO_OWNER");
  }
  const partyId = existingPartyId ?? (await partyForUser(tx, owner.userId!));
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
    // Same three-state rule as first_time_homebuyer above: an unasked question
    // asserts no fact at all, rather than a fact whose value is a guess.
    ...(input.currentHousing != null
      ? [{ predicate: "current_housing", value: input.currentHousing }]
      : []),
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

/**
 * A person a partner told us about, who has never contacted us.
 *
 * Never routed through `partyForUser`, whose whole contract is "the party
 * behind a sign-in": that one takes a `SELECT … FOR UPDATE` on a `users` row
 * that does not exist here, and it hardcodes `CLAIMED`, which is the one thing
 * this party is not. `sourceFirstSeen` is required rather than defaulted,
 * because "where did this record come from" is the question a person asking
 * why we hold anything about them is owed an answer to, and a default is how
 * that answer becomes "self_signup" for somebody who never signed up.
 */
export async function createProvisionalParty(
  tx: Tx,
  opts: { sourceFirstSeen: string },
): Promise<string> {
  const party = await tx.party.create({
    data: {
      kind: "PERSON",
      claimStatus: "PROVISIONAL",
      sourceFirstSeen: opts.sourceFirstSeen,
    },
    select: { id: true },
  });
  return party.id;
}

/**
 * The principal a partner's feed asserts as. One per partner, not one per
 * record, so "who told us this" is answerable per feed.
 *
 * `party_id` is null and the shipped `principals_party_id_matches_kind` CHECK
 * forces it: a partner is not a person, and a principal that cascaded from a
 * party would take the attribution with the person when they close their
 * account.
 *
 * Insert-then-read, like `servicePrincipal` and for the same recorded reason:
 * Prisma's `upsert` on a compound unique is a SELECT then an INSERT, so two
 * first callers race and the loser's uniqueness error aborts the whole
 * transaction it was handed.
 */
export async function partnerPrincipal(tx: Tx, partner: string): Promise<string> {
  await tx.principal.createMany({
    data: [{ kind: "PARTNER", subject: partner, partyId: null }],
    skipDuplicates: true,
  });
  const row = await tx.principal.findUniqueOrThrow({
    where: { kind_subject: { kind: "PARTNER", subject: partner } },
    select: { id: true },
  });
  return row.id;
}

/** What a partner said, and when they say it was true. */
export interface PartnerFact {
  readonly predicate: string;
  readonly value: Prisma.InputJsonValue;
  /** Required, unlike `AssertedFact`'s: a feed states an as-of, and guessing
   *  "now" would date a servicer's month-old file to the minute we read it. */
  readonly observedAt: Date;
}

/**
 * Write facts a partner shared, superseding any live prior assertion of the
 * same predicate.
 *
 * A sibling of `assertFacts` rather than a flag on it. That one hardcodes
 * `SELF_ATTESTED` / `ATTESTED`, which are the two words for "the borrower said
 * so"; labeling a servicer's file that way would put somebody's own statement
 * and a partner's spelling of their name in the same tier, which is the
 * distinction the confidence ladder exists to keep.
 *
 * The supersession half is kept byte for byte, because `liveFact` and the pin
 * reconciler both depend on there being exactly one live row per predicate,
 * and a second writer that skipped it would break them for the first.
 *
 * Supersession is what makes the party this is pointed at matter. It matches
 * on `(party, predicate)` and reads neither who asserted the prior row nor
 * what tier it sits at, so the caller has to hand over the party a partner is
 * speaking about — the one the feed's own record of this person names — and
 * never the party of somebody who signed in and said something themselves.
 * That party keeps taking a partner's facts after a claim folds it into its
 * survivor: the feed goes on arriving every month, the facts stay where they
 * were asserted, and `partnerFactsFor` reads them through the pointer.
 *
 * `PARTNER_SHARED` / `UNVERIFIED` is as high as this can go, and
 * `facts_partner_may_not_verify` makes anything higher impossible rather than
 * merely wrong.
 */
export async function assertPartnerFacts(
  tx: Tx,
  args: {
    partyId: string;
    principalId: string;
    facts: readonly PartnerFact[];
  },
): Promise<void> {
  const { partyId, principalId, facts } = args;
  for (const f of facts) {
    const created = await tx.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: partyId,
        partyId,
        predicate: f.predicate,
        value: f.value,
        sourceKind: "PARTNER_SHARED",
        confidence: "UNVERIFIED",
        assertedByPrincipalId: principalId,
        observedAt: f.observedAt,
      },
      select: { id: true },
    });
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

/**
 * Fold a provisional party into the party of the person who turned out to be
 * them.
 *
 * It moves `loan_parties` rows and it touches no facts. Three reasons, and
 * they compound. `facts` is append-only by trigger — only `superseded_by_id`,
 * `retracted_at` and `retraction_reason` may change — so a physical move is
 * not available. Re-asserting a partner's `legal_name` onto the survivor would
 * supersede the person's own live attested name with a servicer's spelling of
 * it, at a lower tier, on the least-exercised path here. And retracting them
 * would say the person never said it, which they never did.
 *
 * So the facts stay where they were asserted, the row stays, and
 * `partnerFactsFor` is the reader that follows the pointer. They die with the
 * person, because account deletion takes the parties merged into theirs too.
 */
export async function mergePartyInto(
  tx: Tx,
  fromPartyId: string,
  intoPartyId: string,
): Promise<void> {
  if (fromPartyId === intoPartyId) {
    throw new Error("a party cannot merge into itself");
  }
  // Both ends are read, because a chain can be built from either. The survivor
  // must be CLAIMED, and CLAIMED has no edge out, so it can never itself become
  // MERGED. The party being folded must be one nobody has claimed, so it is not
  // one that was folded into somebody already — that end is the one the
  // survivor check cannot see, and folding a second time would move a
  // stranger's record off the account holder who claimed it and onto one who
  // did not, silently, while every check above passed.
  //
  // Two things downstream are complete only because neither end can chain:
  // `partnerFactsFor` resolves one hop, and `users_delete_takes_party` deletes
  // one hop of merged-from rows. A far end two hops away is a stranger's date
  // of birth that no reader reaches and no account deletion takes.
  //
  // The claimant's own party is what the caller has in hand anyway: the claim
  // takes `partyForUser` first and merges into that, and `partyForUser` writes
  // CLAIMED.
  const from = await tx.party.findUniqueOrThrow({
    where: { id: fromPartyId },
    select: { claimStatus: true },
  });
  if (from.claimStatus !== "PROVISIONAL" && from.claimStatus !== "CLAIM_PENDING") {
    throw new Error(
      `party ${fromPartyId} is ${from.claimStatus}; only a party nobody has claimed can be folded into another`,
    );
  }
  const into = await tx.party.findUniqueOrThrow({
    where: { id: intoPartyId },
    select: { claimStatus: true },
  });
  if (into.claimStatus === "MERGED") {
    throw new Error(`party ${intoPartyId} was itself merged; merge into its survivor instead`);
  }
  if (into.claimStatus !== "CLAIMED") {
    throw new Error(
      `party ${intoPartyId} is ${into.claimStatus}; a merge survivor must be a claimed party`,
    );
  }
  // Not skipped on collision. The survivor being already on this loan would
  // mean one person holding two roles on one mortgage, which is not a shape
  // the import or the claim can produce; if it ever became one, the unique
  // index refusing the move is a better answer than silently dropping a row
  // that says what somebody's role is.
  await tx.loanParty.updateMany({
    where: { partyId: fromPartyId },
    data: { partyId: intoPartyId },
  });
  // One UPDATE, and it has to be. A statement that set MERGED and left the
  // pointer to a second one would be refused by
  // `parties_claim_status_moves_forward` for naming nobody, and the second one
  // would then be refused for moving a merged party's pointer.
  await tx.party.update({
    where: { id: fromPartyId },
    data: { claimStatus: "MERGED", mergedIntoPartyId: intoPartyId },
  });
}

/**
 * Everything a partner shared about this person, including what they shared
 * before we knew who they were.
 *
 * The one named reader that follows `merged_into_party_id`. A merge that left
 * the facts behind a pointer nothing reads would make them invisible, which is
 * the same as losing them; this is the pointer's reader, and a refinance
 * prefilled from a servicer's file is its caller.
 *
 * One hop, and one hop is all of them: `mergePartyInto` accepts only a CLAIMED
 * survivor and only an unclaimed party to fold, and once a party is MERGED the
 * trigger will not let the pointer move again — so nothing can put a party two
 * hops away from the person it belongs to. Live rows only, and
 * `PARTNER_SHARED` only — what the person told us themselves is not this
 * function's subject, and mixing the two is how a partner's spelling ends up
 * presented as the borrower's own.
 */
export async function partnerFactsFor(db: Db, partyId: string): Promise<readonly Fact[]> {
  const mergedFrom = await db.party.findMany({
    where: { mergedIntoPartyId: partyId },
    select: { id: true },
  });
  return db.fact.findMany({
    where: {
      partyId: { in: [partyId, ...mergedFrom.map((p) => p.id)] },
      sourceKind: "PARTNER_SHARED",
      ...LIVE,
    },
    orderBy: { observedAt: "desc" },
  });
}
