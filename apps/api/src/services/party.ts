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

import type { Prisma } from "@hm/db";

type Tx = Prisma.TransactionClient;

/** The party behind a signed-in user, created on first use. */
export async function partyForUser(tx: Tx, userId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { partyId: true },
  });
  if (user.partyId) return user.partyId;

  // A person who signed in is not provisional: they came to us.
  const party = await tx.party.create({
    data: { kind: "PERSON", claimStatus: "CLAIMED", sourceFirstSeen: "self_signup" },
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
  readonly statedMonthlyIncome: number;
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
    // asks for it — see services/application.ts.
    { predicate: "monthly_income", value: input.statedMonthlyIncome },
    // The vault handle is a reference, never the number. Only on a first save,
    // or when it is being replaced.
    ...(input.ssnVaultHandle ? [{ predicate: "ssn_token", value: input.ssnVaultHandle }] : []),
    ...(input.monthlyRent != null ? [{ predicate: "monthly_rent", value: input.monthlyRent }] : []),
  ]);

  return partyId;
}
