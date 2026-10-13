/**
 * Suggestions, computed on read and stored nowhere.
 *
 * `suggestionsFor` is pure: no database, no clock. It takes what the route has
 * already loaded about the reader — their own newest bank snapshot, and what
 * they have dismissed — and returns zero or more suggestions. Each rule is a
 * named function returning at most one, and the refusals live here rather
 * than on the screens: nothing bank-sourced from a snapshot whose recorded
 * purpose is not an extension of credit; nothing the reader dismissed on this
 * snapshot (a newer one offers again); nothing for a key the type cannot name.
 *
 * `readSuggestions` is the one impure half: it loads the reader's rows, calls
 * the pure half, and records `autofill_shown` once per suggestion and snapshot
 * so fair-lending monitoring can tell "never offered" from "offered and
 * declined". It is the one write on a read path, bounded by that key.
 *
 * The engine reads none of this. `LoanFile` has no suggestions key and the
 * requirements and underwriting packages import nothing from here, which
 * `engine-reads-nothing.test.ts` holds.
 */

import type { Db } from "./db.js";
import { AUTOFILL_RULES, dismissalKey, EXTENSION_OF_CREDIT } from "@hm/shared";
import type { AssetReport, Suggestion, SuggestionKey } from "@hm/shared";

/** The reader's own newest bank report, with the row it came from. */
export interface OwnBankSnapshot {
  readonly id: string;
  readonly retrievedAt: string;
  /** What the bank route certified to the bureau when it ordered the report. */
  readonly permissiblePurpose: string | null;
  readonly assets: AssetReport;
}

export interface AutofillInput {
  readonly partyId: string;
  readonly own: OwnBankSnapshot | null;
  readonly dismissed: ReadonlySet<string>;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * The rent, from the longest category-gated run of payments to one payee.
 *
 * Suggested, never filled: the screen renders it under the rent input after
 * the person has chosen Rent, with one tap. Only a positive figure can be
 * suggested (absence is never No, and a homeowner with no rent run gets no
 * caption), and only from a report the bureau was told is for an extension
 * of credit.
 */
function foundRent(input: AutofillInput): Suggestion | null {
  const own = input.own;
  if (!own || own.permissiblePurpose !== EXTENSION_OF_CREDIT) return null;
  const key: SuggestionKey = "current_monthly_rent";
  if (input.dismissed.has(dismissalKey(key, own.id))) return null;
  const run = own.assets.alternativeReferences.find(
    (r) => r.kind === "rent" && r.monthsOfHistory >= 3 && r.monthlyAmount > 0,
  );
  const amount = own.assets.identifiedMonthlyRent;
  if (!run || typeof amount !== "number" || amount <= 0) return null;
  return {
    key,
    screen: "declarations",
    mode: "suggest",
    target: { kind: "residence", residencyType: "Current", field: "monthlyRent" },
    value: amount,
    source: "bank",
    tag: "From your bank activity",
    basis: `Your bank shows ${money.format(amount)} a month to ${run.payeeName}`,
    evidence: { snapshotId: own.id, retrievedAt: own.retrievedAt },
    evidenceTier: "estimated",
    partyId: input.partyId,
  };
}

const RULES: readonly ((input: AutofillInput) => Suggestion | null)[] = [foundRent];

export function suggestionsFor(input: AutofillInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const rule of RULES) {
    const s = rule(input);
    if (s) out.push(s);
  }
  return out;
}

/** The newest bank report that is this person's own on this file, or null. */
export async function ownBankSnapshot(
  db: Db,
  loanFileId: string,
  partyId: string,
): Promise<OwnBankSnapshot | null> {
  const row = await db.connectorSnapshot.findFirst({
    where: { loanFileId, partyId, kind: "bank" },
    orderBy: { writeSeq: "desc" },
    select: { id: true, payload: true, retrievedAt: true, permissiblePurpose: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    retrievedAt: row.retrievedAt.toISOString(),
    permissiblePurpose: row.permissiblePurpose,
    assets: row.payload as unknown as AssetReport,
  };
}

/** What this person has dismissed on this file, as `key@snapshotId`. */
export async function dismissedBy(
  db: Db,
  loanFileId: string,
  partyId: string,
): Promise<Set<string>> {
  const rows = await db.fileEvent.findMany({
    where: { loanFileId, kind: "autofill_dismissed" },
    select: { payload: true },
  });
  const out = new Set<string>();
  for (const { payload } of rows) {
    const p = payload as { key?: unknown; snapshotId?: unknown; partyId?: unknown } | null;
    if (p?.partyId === partyId && typeof p.key === "string" && typeof p.snapshotId === "string") {
      out.add(dismissalKey(p.key as SuggestionKey, p.snapshotId));
    }
  }
  return out;
}

/**
 * The suggestions a reader gets with their file, and the record that they
 * were offered.
 *
 * `autofill_shown` is written the first time a given suggestion on a given
 * snapshot is served to this person, found by reading back the file's events
 * for the key; a duplicate under a race is harmless, a missing one would make
 * "never rendered" and "rendered and abandoned" the same thing.
 */
export async function readSuggestions(
  db: Db,
  loanFileId: string,
  partyId: string,
): Promise<Suggestion[]> {
  const [own, dismissed] = await Promise.all([
    ownBankSnapshot(db, loanFileId, partyId),
    dismissedBy(db, loanFileId, partyId),
  ]);
  const suggestions = suggestionsFor({ partyId, own, dismissed });
  if (suggestions.length === 0) return suggestions;

  const shown = await db.fileEvent.findMany({
    where: { loanFileId, kind: "autofill_shown" },
    select: { payload: true },
  });
  const already = new Set(
    shown
      .map((e) => e.payload as { key?: string; snapshotId?: string; partyId?: string } | null)
      .filter((p) => p?.partyId === partyId && p.key && p.snapshotId)
      .map((p) => dismissalKey(p!.key as SuggestionKey, p!.snapshotId!)),
  );
  for (const s of suggestions) {
    if (already.has(dismissalKey(s.key, s.evidence.snapshotId))) continue;
    await db.fileEvent.create({
      data: {
        loanFileId,
        kind: "autofill_shown",
        actor: "system",
        requirementId: "APP-026",
        payload: {
          key: s.key,
          snapshotId: s.evidence.snapshotId,
          partyId,
          proposed: s.value,
          rules: AUTOFILL_RULES,
        },
      },
    });
  }
  return suggestions;
}
