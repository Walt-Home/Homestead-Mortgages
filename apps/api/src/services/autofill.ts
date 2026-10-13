/**
 * Suggestions, computed on read and stored nowhere.
 *
 * Two pure halves, one per scope, and the impure readers and writers around
 * them. Each rule is a named function returning at most one suggestion, and
 * the refusals live here rather than on the screens.
 *
 * File scope (`fileSuggestionsFor`, served beside `GET /files/:id`): the rent
 * from the reader's own bank report, and a returning person's phone on a
 * file where they have not said who they are yet.
 *
 * Person scope (`personSuggestionsFor`, served at `GET /api/suggestions`):
 * the income a person last stated, for screen 1 and the refinance offer card,
 * both of which ask before a file exists (and screen 1 again on a revisit,
 * which does not restore the figure into its field).
 *
 * A prior statement is the person's own: a live SELF_ATTESTED fact asserted
 * under their own principal. A figure a servicer's tape carried, or a name an
 * applicant typed for a co-borrower, is something said ABOUT them, and "what
 * you told us before" would be false of it.
 *
 * The engine reads none of this. `LoanFile` has no suggestions key and the
 * requirements and underwriting packages import nothing from here, which
 * `engine-reads-nothing.test.ts` holds.
 */

import { z } from "zod";
import {
  AUTOFILL_OUTCOMES,
  AUTOFILL_RULES,
  dismissalKey,
  EXTENSION_OF_CREDIT,
  PRIOR_STATEMENT_PREDICATE,
  SUGGESTION_KEYS,
  SUGGESTION_SOURCE,
  SUGGESTION_TAG,
} from "@hm/shared";
import type { AssetReport, AutofillOutcomeInput, Suggestion, SuggestionKey } from "@hm/shared";
import type { Db } from "./db.js";
import { AppError } from "../middleware/error-handler.js";

/** The requirement each key bears on, for the diary rows. */
const REQUIREMENT: Readonly<Record<SuggestionKey, string>> = {
  // The residence.
  current_monthly_rent: "APP-026",
  // One of TRID's six pieces.
  stated_monthly_income: "APP-002",
  // The person, as screen 2 establishes them.
  phone: "APP-001",
};

/** The reader's own newest bank report, with the row it came from. */
export interface OwnBankSnapshot {
  readonly id: string;
  readonly retrievedAt: string;
  /** What the bank route certified to the bureau when it ordered the report. */
  readonly permissiblePurpose: string | null;
  readonly assets: AssetReport;
}

/** A person's own earlier statement: the fact row, its value, when it was said. */
export interface PriorStatement {
  readonly id: string;
  readonly value: unknown;
  readonly observedAt: string;
}

export interface FileSuggestionInput {
  readonly partyId: string;
  readonly own: OwnBankSnapshot | null;
  readonly priorPhone: PriorStatement | null;
  /** Whether the reader already has an arrived borrower row of their own on this file. */
  readonly hasOwnRow: boolean;
  readonly dismissed: ReadonlySet<string>;
}

export interface PersonSuggestionInput {
  readonly partyId: string;
  readonly priorIncome: PriorStatement | null;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** "October 2026", from an ISO instant, without reading a clock. */
function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The last ten digits as 512-555-0142, or null for something that is not a US number. */
function displayPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/* ── File scope ───────────────────────────────────────────────────────── */

/**
 * The rent, from the longest category-gated run of payments to one payee.
 *
 * Suggested, never filled: the screen renders it under the rent input after
 * the person has chosen Rent, with one tap. Only a positive figure can be
 * suggested (absence is never No, and a homeowner with no rent run gets no
 * caption), and only from a report the bureau was told is for an extension
 * of credit.
 */
function foundRent(input: FileSuggestionInput): Suggestion | null {
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
    tag: SUGGESTION_TAG.bank,
    basis: `Your bank shows ${money.format(amount)} a month to ${run.payeeName}`,
    evidence: { kind: "snapshot", id: own.id, at: own.retrievedAt },
    evidenceTier: "estimated",
    partyId: input.partyId,
  };
}

/**
 * A returning person's phone, on a file where they have not said who they are.
 *
 * Only before they have a borrower row of their own here: once they have,
 * screen 2 reads their stored answer back into the field, which is theirs on
 * this file and not a suggestion. A number with fewer than ten digits is not
 * offered, because the bank screen will refuse it.
 */
function priorPhone(input: FileSuggestionInput): Suggestion | null {
  const prior = input.priorPhone;
  if (!prior || input.hasOwnRow) return null;
  const shown = displayPhone(prior.value);
  if (!shown) return null;
  const key: SuggestionKey = "phone";
  if (input.dismissed.has(dismissalKey(key, prior.id))) return null;
  return {
    key,
    screen: "identity",
    mode: "suggest",
    target: { kind: "fact", predicate: "phone" },
    value: shown,
    source: "prior_statement",
    tag: SUGGESTION_TAG.prior_statement,
    basis: shown,
    evidence: { kind: "fact", id: prior.id, at: prior.observedAt },
    evidenceTier: "attested",
    partyId: input.partyId,
  };
}

const FILE_RULES: readonly ((input: FileSuggestionInput) => Suggestion | null)[] = [
  foundRent,
  priorPhone,
];

export function fileSuggestionsFor(input: FileSuggestionInput): Suggestion[] {
  return FILE_RULES.map((rule) => rule(input)).filter((s): s is Suggestion => s !== null);
}

/* ── Person scope ─────────────────────────────────────────────────────── */

/**
 * The income a person last stated, as a one-tap line under the income field.
 *
 * Rounded to the dollar, because the field takes whole dollars and the
 * question asks for a rough figure. Never filled: a money figure accepted
 * with Continue is a statement nobody read, and this one is a piece of the
 * TRID application.
 */
function priorIncome(input: PersonSuggestionInput): Suggestion | null {
  const prior = input.priorIncome;
  if (!prior) return null;
  const n = typeof prior.value === "number" ? prior.value : Number(prior.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const value = Math.round(n);
  return {
    key: "stated_monthly_income",
    screen: "property",
    mode: "suggest",
    target: { kind: "fact", predicate: "monthly_income" },
    value,
    source: "prior_statement",
    tag: SUGGESTION_TAG.prior_statement,
    basis: `${money.format(value)} a month, in ${monthYear(prior.observedAt)}`,
    evidence: { kind: "fact", id: prior.id, at: prior.observedAt },
    evidenceTier: "attested",
    partyId: input.partyId,
  };
}

/**
 * No dismissals at this scope. One is recorded on the file the save creates,
 * and a person who waved the figure off typed another, which is a newer fact
 * and a different suggestion next time; one who waved it off and left made
 * no file to record it on.
 */
export function personSuggestionsFor(input: PersonSuggestionInput): Suggestion[] {
  const s = priorIncome(input);
  return s ? [s] : [];
}

/* ── Readers ──────────────────────────────────────────────────────────── */

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

/**
 * What a person last said about themselves, or null.
 *
 * Live, SELF_ATTESTED and asserted under the person's own principal. A read:
 * it finds the principal and never makes one, so a person nobody has heard
 * from has no statement and no row is written to say so.
 */
export async function priorStatement(
  db: Db,
  partyId: string,
  predicate: string,
): Promise<PriorStatement | null> {
  const own = await db.principal.findFirst({
    where: { kind: "BORROWER", partyId },
    select: { id: true },
  });
  if (!own) return null;
  const fact = await db.fact.findFirst({
    where: {
      partyId,
      predicate,
      subjectKey: "",
      supersededById: null,
      retractedAt: null,
      sourceKind: "SELF_ATTESTED",
      assertedByPrincipalId: own.id,
    },
    orderBy: { observedAt: "desc" },
    select: { id: true, value: true, observedAt: true },
  });
  return fact
    ? { id: fact.id, value: fact.value, observedAt: fact.observedAt.toISOString() }
    : null;
}

/** What this person has dismissed on this file, as `key@evidenceId`. */
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
    const p = payload as {
      key?: unknown;
      evidenceId?: unknown;
      snapshotId?: unknown;
      partyId?: unknown;
    } | null;
    // `snapshotId` is what the first rows, written for the rent alone, named
    // their evidence; read it so a dismissal made then still holds.
    const evidenceId = p?.evidenceId ?? p?.snapshotId;
    if (p?.partyId === partyId && typeof p.key === "string" && typeof evidenceId === "string") {
      out.add(dismissalKey(p.key as SuggestionKey, evidenceId));
    }
  }
  return out;
}

/**
 * The suggestions a reader gets with their file, and the record that they
 * were offered.
 *
 * `autofill_shown` is written the first time a given suggestion on given
 * evidence is served to this person, found by reading back the file's events;
 * a duplicate under a race is harmless, a missing one would make "never
 * rendered" and "rendered and abandoned" the same thing.
 */
export async function readFileSuggestions(
  db: Db,
  loanFileId: string,
  partyId: string,
  opts: { readonly hasOwnRow: boolean },
): Promise<Suggestion[]> {
  const [own, phone, dismissed] = await Promise.all([
    ownBankSnapshot(db, loanFileId, partyId),
    // Only asked when it could be offered, which is before screen 2.
    opts.hasOwnRow ? Promise.resolve(null) : priorStatement(db, partyId, "phone"),
    dismissedBy(db, loanFileId, partyId),
  ]);
  const suggestions = fileSuggestionsFor({
    partyId,
    own,
    priorPhone: phone,
    hasOwnRow: opts.hasOwnRow,
    dismissed,
  });
  if (suggestions.length === 0) return suggestions;

  const shown = await db.fileEvent.findMany({
    where: { loanFileId, kind: "autofill_shown" },
    select: { payload: true },
  });
  const already = new Set(
    shown
      .map(
        (e) =>
          e.payload as {
            key?: string;
            evidenceId?: string;
            snapshotId?: string;
            partyId?: string;
          } | null,
      )
      .filter((p) => p?.partyId === partyId && p.key && (p.evidenceId ?? p.snapshotId))
      .map((p) => dismissalKey(p!.key as SuggestionKey, (p!.evidenceId ?? p!.snapshotId)!)),
  );
  for (const s of suggestions) {
    if (already.has(dismissalKey(s.key, s.evidence.id))) continue;
    await db.fileEvent.create({
      data: {
        loanFileId,
        kind: "autofill_shown",
        actor: "system",
        requirementId: REQUIREMENT[s.key],
        payload: {
          key: s.key,
          evidenceId: s.evidence.id,
          partyId,
          proposed: s.value,
          rules: AUTOFILL_RULES,
        },
      },
    });
  }
  return suggestions;
}

/**
 * The suggestions a person gets before a file exists.
 *
 * Nothing is written: there is no file to write to. What the screen did with
 * the line is recorded with the save that creates the file, which is every
 * case there is a file to say it about.
 */
export async function readPersonSuggestions(db: Db, partyId: string): Promise<Suggestion[]> {
  return personSuggestionsFor({
    partyId,
    priorIncome: await priorStatement(db, partyId, PRIOR_STATEMENT_PREDICATE.stated_monthly_income),
  });
}

/* ── Outcomes ─────────────────────────────────────────────────────────── */

/**
 * What a screen reports with its save, for each suggestion it rendered.
 *
 * Optional on every save that takes it, and a body carrying outcomes and no
 * save is still just a save. Twenty at most: no screen renders more than one.
 */
export const autofillOutcomesSchema = z
  .array(
    z.object({
      key: z.enum(SUGGESTION_KEYS),
      evidenceId: z.string().uuid(),
      outcome: z.enum(AUTOFILL_OUTCOMES),
      proposed: z.unknown().optional(),
      given: z.unknown().optional(),
    }),
  )
  .max(20)
  .optional();

/**
 * Refuse an outcome whose evidence is not this person's own, BEFORE the save.
 *
 * A row naming somebody else's report or statement would be a client writing
 * another person's evidence into this person's diary. Bank evidence has to be
 * a bank snapshot of theirs on this file (and so cannot be named on a save
 * that creates the file); a prior statement has to be a SELF_ATTESTED fact of
 * theirs on the key's predicate. It need not still be live: the save about to
 * run may be the one that supersedes it.
 */
export async function assertOutcomesAreTheirs(
  db: Db,
  loanFileId: string | null,
  partyId: string | null,
  outcomes: readonly AutofillOutcomeInput[],
): Promise<void> {
  for (const o of outcomes) {
    const source = SUGGESTION_SOURCE[o.key];
    let theirs = false;
    if (partyId !== null && source === "bank" && loanFileId !== null) {
      theirs =
        (await db.connectorSnapshot.count({
          where: { id: o.evidenceId, loanFileId, partyId, kind: "bank" },
        })) === 1;
    } else if (partyId !== null && source === "prior_statement") {
      const predicate = PRIOR_STATEMENT_PREDICATE[o.key as keyof typeof PRIOR_STATEMENT_PREDICATE];
      theirs =
        (await db.fact.count({
          where: { id: o.evidenceId, partyId, predicate, sourceKind: "SELF_ATTESTED" },
        })) === 1;
    }
    if (!theirs) {
      throw new AppError(400, "That suggestion is not one of yours.", "AUTOFILL_NOT_YOURS");
    }
  }
}

/**
 * The outcomes as diary rows, AFTER the save: actor `borrower`, the key's
 * requirement, the evidence, and the rules version the suggestion was made
 * under. The answers themselves are written by the save exactly as they would
 * be without this.
 */
export async function recordAutofillOutcomes(
  db: Db,
  loanFileId: string,
  partyId: string,
  outcomes: readonly AutofillOutcomeInput[],
): Promise<void> {
  for (const o of outcomes) {
    await db.fileEvent.create({
      data: {
        loanFileId,
        kind: `autofill_${o.outcome}`,
        actor: "borrower",
        requirementId: REQUIREMENT[o.key],
        payload: {
          key: o.key,
          evidenceId: o.evidenceId,
          partyId,
          proposed: (o.proposed ?? null) as never,
          given: (o.given ?? null) as never,
          rules: AUTOFILL_RULES,
        },
      },
    });
  }
}
