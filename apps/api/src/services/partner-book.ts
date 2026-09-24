/**
 * A book is a tape, read once.
 *
 * The first production writer the loan model has had. A servicer's tape comes
 * in through `@hm/partner-book`, which reads it into the one shape a
 * partner's file may enter the product in; this is where those records become
 * rows. Per record, in one transaction:
 *
 *   - a loan the servicer has not sent before becomes an `imported_unclaimed`
 *     loan through `createImportedLoan` — not monitored, because the database
 *     holds that nothing about an unclaimed loan is, and the claim is what
 *     turns the review on — on a PROVISIONAL party of its own
 *     with the partner's spelling of the name and, when the supplement
 *     carried one, a date of birth — as PARTNER_SHARED facts asserted by the
 *     partner's principal, never higher;
 *   - a loan the servicer has sent before is found by its servicer loan
 *     number, its party's partner facts are re-asserted only where the
 *     spelling changed, and nothing about its state is touched;
 *   - either way, one `servicing_observations` row: what the servicer said the
 *     loan looked like on that date, appended, never overwritten;
 *   - a tape that says the loan ended moves it, through `moveLoanIfLegal`, as
 *     `servicer_reported`. Paid off, charged off and matured have edges from
 *     every live state. "Transferred" does not from an unclaimed loan — the
 *     machine models a transfer as a window with two ends, and a tape reports
 *     only that it closed — so it is recorded and reported, and the loan waits.
 *
 * What this never does: read the supplement's e-mail or phone (the reader
 * has nowhere to put them), link a row to a party somebody has signed in as
 * (a loan that appears in an account without a claim is the oracle the 404
 * rule suppresses), or write an observation for a rejected tape (nothing is
 * written until the header gate has passed).
 *
 * The one lossy step is named: the loan's `note_rate_bps` is an integer and a
 * note is quoted in eighths, so the column rounds and the observation keeps
 * the servicer's figure to the thousandth of a percent.
 */

import { prisma } from "@hm/db";
import type {
  LienPosition,
  LoanProgram,
  LoanRateType,
  LoanState,
  Occupancy,
  Prisma,
  ScenarioObjective,
  ServicingStatus,
} from "@hm/db";
import {
  profileById,
  readBook,
  type BookFile,
  type GapCounts,
  type RowException,
} from "@hm/partner-book";
import { canonicalRecordHash, type ImportedLoanRecord } from "@hm/shared/portfolio";
import { type Db, inChunks, ownsTransaction } from "./db.js";
import { moveLoanIfLegal } from "./loan-transition.js";
import { toDomainLoanState } from "./loan-transition.js";
import { createImportedLoans } from "./loans.js";
import { assertPartnerFactsMany, createProvisionalParties, type PartnerFact } from "./party.js";

export interface ImportBookInput {
  readonly servicerId: string;
  /** The PARTNER principal every row this import causes is attributed to. */
  readonly principalId: string;
  readonly profile: string;
  /** YYYY-MM-DD. Defaults to the tape's own as-of cell, then to today. */
  readonly asOf?: string | null;
  readonly tape: BookFile;
  readonly supplement?: BookFile | null;
}

export type LoanChange = "created" | "updated" | "unchanged";

export interface ImportReportLoan {
  readonly loan_id: string;
  readonly servicer_loan_number: string;
  readonly change: LoanChange;
  readonly state: LoanState;
  /** The loan event the tape's status caused, or why none did. */
  readonly moved: string | null;
}

export interface ImportReport {
  readonly profile: string;
  readonly as_of: string;
  readonly rows_total: number;
  readonly rows_loaded: number;
  readonly rows_rejected: number;
  readonly exceptions: RowException[];
  readonly gaps: GapCounts;
  readonly supplement: { readonly rows: number; readonly ignored_columns: string[] };
  readonly loans: ImportReportLoan[];
  /** The servicer's live loans this tape did not carry. Reported, never moved. */
  readonly not_on_tape: {
    loan_id: string;
    servicer_loan_number: string;
    last_as_of: string | null;
  }[];
}

export interface ImportCounts {
  readonly rows_total: number;
  readonly rows_loaded: number;
  readonly rows_rejected: number;
  readonly loans_created: number;
  readonly loans_updated: number;
  readonly loans_unchanged: number;
  readonly parties_created: number;
}

export type ImportBookResult =
  | { readonly status: "rejected"; readonly missing_headers: string[] }
  | { readonly status: "already_loaded"; readonly importId: string }
  | {
      readonly status: "loaded";
      readonly importId: string;
      readonly counts: ImportCounts;
      readonly report: ImportReport;
    };

const TERMINAL_EVENT: Partial<
  Record<
    ImportedLoanRecord["servicing"]["status"],
    "payoff_posted" | "charge_off_posted" | "term_completed"
  >
> = {
  paid_off: "payoff_posted",
  charged_off: "charge_off_posted",
  matured: "term_completed",
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const dateOrNull = (day: string | null): Date | null => (day === null ? null : dateOf(day));
/** The contract's lower-case words are the schema's enum names, lowered. */
const enumOf = <T extends string>(v: string | null): T | null =>
  v === null ? null : (v.toUpperCase() as T);

/**
 * A note is quoted in eighths and the column is integer basis points, so
 * 6.375 % becomes 638 here and stays 6.375 on the observation. The same
 * rounding `applications.ts` applies to a scenario's rate.
 */
export const rateToBps = (pct: string): number => Math.round(Number(pct) * 100);

export async function importPartnerBook(
  input: ImportBookInput,
  db: Db = prisma,
): Promise<ImportBookResult> {
  const profile = profileById(input.profile);
  const servicer = await db.servicer.findUniqueOrThrow({
    where: { id: input.servicerId },
    select: { id: true, slug: true },
  });
  const asOfDefault = input.asOf ?? isoDay(new Date());
  const book = readBook(profile, servicer.slug, asOfDefault, input.tape, input.supplement ?? null);
  if (book.rejected) return { status: "rejected", missing_headers: book.rejected.missing_headers };

  const already = await db.partnerBookImport.findUnique({
    where: {
      servicerId_tapeSha256_supplementSha256: {
        servicerId: servicer.id,
        tapeSha256: book.tape_sha256,
        supplementSha256: book.supplement_sha256,
      },
    },
    select: { id: true },
  });
  if (already) return { status: "already_loaded", importId: already.id };

  // The import's date is the tape's, which every record carries; the caller's
  // stands in only when the tape has no as-of column at all.
  const asOf =
    input.asOf ??
    book.records
      .map((r) => r.record.servicing.asOf.slice(0, 10))
      .sort()
      .at(-1) ??
    asOfDefault;

  const run = (tx: Db) => load(tx, { servicer, principalId: input.principalId, asOf, book });
  return ownsTransaction(db)
    ? prisma.$transaction(run, { maxWait: 10_000, timeout: 120_000 })
    : run(db);
}

async function load(
  tx: Db,
  args: {
    servicer: { id: string; slug: string };
    principalId: string;
    asOf: string;
    book: ReturnType<typeof readBook>;
  },
): Promise<ImportBookResult> {
  const { servicer, principalId, asOf, book } = args;
  const asOfDate = dateOf(asOf);

  // Pass 1: what the servicer has sent before, by its own number.
  const numbers = book.records.map((r) => r.record.sourceLoanKey);
  const existing = await tx.loan.findMany({
    where: { servicerId: servicer.id, servicerLoanNumber: { in: numbers } },
    select: {
      id: true,
      servicerLoanNumber: true,
      status: true,
      parties: { where: { role: "PRIMARY_BORROWER" }, select: { partyId: true }, take: 1 },
      observations: {
        orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
        take: 1,
        select: { recordHash: true },
      },
    },
  });
  const byNumber = new Map(existing.map((l) => [l.servicerLoanNumber!, l]));

  // Pass 2: the loans, so the report can name every id before the import row
  // that the observations will point at is written. Set-based: a book is
  // thousands of rows and one transaction, so the people, their facts, the
  // loans and who is on them go in as a few statements each, in that order,
  // and a loan is never committed without its party.
  type Placed = {
    loanId: string;
    record: ImportedLoanRecord;
    facts: Record<string, unknown>;
    change: LoanChange;
    hash: string;
    /** Where the loan stands before this tape moves it. */
    state: LoanState;
  };
  const fresh: { record: ImportedLoanRecord; facts: Record<string, unknown>; hash: string }[] = [];
  for (const { record, facts } of book.records) {
    if (!byNumber.has(record.sourceLoanKey)) {
      fresh.push({ record, facts, hash: canonicalRecordHash(record) });
    }
  }
  const partyIds = await createProvisionalParties(tx, fresh.length, {
    sourceFirstSeen: `partner_import:${servicer.slug}`,
  });
  const { loanIds } = await createImportedLoans(
    tx,
    fresh.map(({ record }, i) => {
      const t = record.terms;
      return {
        terms: {
          rateType: enumOf<LoanRateType>(t.rateType)!,
          noteRateBps: rateToBps(t.noteRatePct),
          termMonths: t.termMonths,
          originalPrincipalCents: t.originalPrincipalCents,
          originatedOn: dateOrNull(t.originatedOn),
          firstPaymentOn: dateOrNull(t.firstPaymentOn),
          maturityOn: dateOrNull(t.maturityOn),
        },
        property: {
          line1: record.property.line1,
          line2: record.property.line2,
          city: record.property.city,
          state: record.property.state,
          postalCode: record.property.postalCode,
          apn: record.property.apn,
        },
        axes: {
          objective: enumOf<ScenarioObjective>(t.objective),
          program: enumOf<LoanProgram>(t.program),
          lienPosition: enumOf<LienPosition>(t.lienPosition),
          occupancy: enumOf<Occupancy>(t.occupancy),
        },
        parties: [{ partyId: partyIds[i]!, role: "PRIMARY_BORROWER" as const }],
        servicerId: servicer.id,
        servicerLoanNumber: record.sourceLoanKey,
      };
    }),
  );
  const freshByKey = new Map(fresh.map((f, i) => [f.record.sourceLoanKey, { ...f, i }]));

  // The partner's spelling of every person on the tape: a new party takes all
  // of it, a known one only what changed.
  await assertPartnerFactsMany(tx, {
    principalId,
    assertions: book.records.flatMap(({ record }) => {
      const partnerFacts = personFacts(record, asOfDate);
      const known = freshByKey.get(record.sourceLoanKey);
      if (known) return [{ partyId: partyIds[known.i]!, facts: partnerFacts }];
      const partyId = byNumber.get(record.sourceLoanKey)?.parties[0]?.partyId;
      return partyId ? [{ partyId, facts: partnerFacts }] : [];
    }),
  });

  const placed: Placed[] = book.records.map(({ record, facts }) => {
    const known = freshByKey.get(record.sourceLoanKey);
    if (known) {
      return {
        loanId: loanIds[known.i]!,
        record,
        facts,
        change: "created",
        hash: known.hash,
        state: "IMPORTED_UNCLAIMED",
      };
    }
    const prior = byNumber.get(record.sourceLoanKey)!;
    const hash = canonicalRecordHash(record);
    return {
      loanId: prior.id,
      record,
      facts,
      change: prior.observations[0]?.recordHash === hash ? "unchanged" : "updated",
      hash,
      state: prior.status,
    };
  });
  const partiesCreated = fresh.length;

  const notOnTape = await tx.loan.findMany({
    where: {
      servicerId: servicer.id,
      servicerLoanNumber: { not: null, notIn: numbers },
      status: { in: ["IMPORTED_UNCLAIMED", "MONITORING_ONLY", "ACTIVE", "IN_SERVICING_TRANSFER"] },
    },
    select: {
      id: true,
      servicerLoanNumber: true,
      observations: { orderBy: { asOf: "desc" }, take: 1, select: { asOf: true } },
    },
  });

  const counts: ImportCounts = {
    rows_total: book.rows_total,
    rows_loaded: placed.length,
    // A rejected row is one that made no record. A row with an unreadable
    // cell loads with that fact blank and is an exception, not a rejection —
    // and the CHECK on the import row holds the three counts to adding up.
    rows_rejected: book.rows_total - book.records.length,
    loans_created: placed.filter((p) => p.change === "created").length,
    loans_updated: placed.filter((p) => p.change === "updated").length,
    loans_unchanged: placed.filter((p) => p.change === "unchanged").length,
    parties_created: partiesCreated,
  };

  // The report is built before the import row so the row carries it whole;
  // the state each loan ends in is filled after the moves below.
  const loans: ImportReportLoan[] = [];
  const report = {
    profile: book.profile,
    as_of: asOf,
    rows_total: counts.rows_total,
    rows_loaded: counts.rows_loaded,
    rows_rejected: counts.rows_rejected,
    exceptions: book.exceptions,
    gaps: book.gaps,
    supplement: book.supplement,
    loans,
    not_on_tape: notOnTape.map((l) => ({
      loan_id: l.id,
      servicer_loan_number: l.servicerLoanNumber!,
      last_as_of: l.observations[0] ? isoDay(l.observations[0].asOf) : null,
    })),
  } satisfies ImportReport;

  // Pass 3: the moves a tape's status causes, then the rows that record it.
  for (const p of placed) {
    const event = TERMINAL_EVENT[p.record.servicing.status];
    let moved: string | null = null;
    if (event) {
      const r = await moveLoanIfLegal(
        {
          id: p.loanId,
          event,
          actorPrincipalId: principalId,
          reasonCode: "servicer_reported",
          causedBy: `partner_book:${servicer.slug}:${asOf}`,
        },
        tx,
      );
      moved = "skipped" in r ? `${event}:${r.skipped}` : event;
    } else if (p.record.servicing.status === "transferred") {
      moved = "transfer_reported:no_edge";
    }
    // Only a move can have changed where the loan stands; the rest is known.
    const state = event
      ? (await tx.loan.findUniqueOrThrow({ where: { id: p.loanId }, select: { status: true } }))
          .status
      : p.state;
    loans.push({
      loan_id: p.loanId,
      servicer_loan_number: p.record.sourceLoanKey,
      change: p.change,
      state,
      moved,
    });
  }

  const row = await tx.partnerBookImport.create({
    data: {
      servicerId: servicer.id,
      principalId,
      asOf: asOfDate,
      profile: book.profile,
      tapeSha256: book.tape_sha256,
      supplementSha256: book.supplement_sha256,
      rowsTotal: counts.rows_total,
      rowsLoaded: counts.rows_loaded,
      rowsRejected: counts.rows_rejected,
      loansCreated: counts.loans_created,
      loansUpdated: counts.loans_updated,
      loansUnchanged: counts.loans_unchanged,
      partiesCreated: counts.parties_created,
      report: report as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await inChunks(placed, (chunk) =>
    tx.servicingObservation.createMany({
      data: chunk.map((p) => {
        const sv = p.record.servicing;
        return {
          loanId: p.loanId,
          importId: row.id,
          asOf: dateOf(sv.asOf.slice(0, 10)),
          status: enumOf<ServicingStatus>(sv.status)!,
          principalBalanceCents: sv.principalBalanceCents,
          escrowBalanceCents: sv.escrowBalanceCents,
          scheduledPaymentCents: sv.scheduledPaymentCents,
          currentRatePct: sv.currentRatePct,
          nextPaymentDueOn: dateOrNull(sv.nextPaymentDueOn),
          delinquencyDays: sv.delinquencyDays,
          facts: p.facts as Prisma.InputJsonValue,
          recordHash: p.hash,
        };
      }),
    }),
  );

  return { status: "loaded", importId: row.id, counts, report };
}

/** The partner's word for who the primary borrower is, as facts. */
function personFacts(record: ImportedLoanRecord, observedAt: Date): PartnerFact[] {
  const p = record.parties[0]!;
  const facts: PartnerFact[] = [
    {
      predicate: "legal_name",
      value: {
        first: p.legalName.given,
        last: p.legalName.surname,
        ...(p.legalName.middle ? { middle: p.legalName.middle } : {}),
      },
      observedAt,
    },
  ];
  if (p.dateOfBirth) facts.push({ predicate: "date_of_birth", value: p.dateOfBirth, observedAt });
  return facts;
}

/** The imports a servicer has made, newest first. */
export async function listPartnerBookImports(servicerId: string, db: Db = prisma) {
  const rows = await db.partnerBookImport.findMany({
    where: { servicerId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      asOf: true,
      profile: true,
      rowsTotal: true,
      rowsLoaded: true,
      rowsRejected: true,
      loansCreated: true,
      loansUpdated: true,
      loansUnchanged: true,
      partiesCreated: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, asOf: isoDay(r.asOf) }));
}

/** One import with its report, or null — a stranger's import is a missing one. */
export async function partnerBookImport(servicerId: string, importId: string, db: Db = prisma) {
  const row = await db.partnerBookImport.findFirst({ where: { id: importId, servicerId } });
  if (!row) return null;
  return { ...row, asOf: isoDay(row.asOf), report: row.report as unknown as ImportReport };
}

/** Where the servicer's book stands: how many tapes, the latest as-of, the loans by state. */
export async function partnerBookStatus(servicerId: string, db: Db = prisma) {
  const [imports, latest, loans] = await Promise.all([
    db.partnerBookImport.count({ where: { servicerId } }),
    db.partnerBookImport.findFirst({
      where: { servicerId },
      orderBy: { asOf: "desc" },
      select: { asOf: true },
    }),
    db.loan.groupBy({
      by: ["status"],
      where: { servicerId, servicerLoanNumber: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const byState: Partial<Record<string, number>> = {};
  for (const g of loans) byState[toDomainLoanState(g.status)] = g._count._all;
  // The newest day the book was looked at, and how the verdicts fell.
  const newest = await db.loanReview.aggregate({
    _max: { asOf: true },
    where: { loan: { servicerId } },
  });
  const verdicts = { candidate: 0, watching: 0, not_now: 0, excluded: 0 };
  if (newest._max.asOf) {
    const groups = await db.loanReview.groupBy({
      by: ["verdict"],
      where: { asOf: newest._max.asOf, loan: { servicerId } },
      _count: { _all: true },
    });
    for (const g of groups)
      verdicts[g.verdict.toLowerCase() as keyof typeof verdicts] = g._count._all;
  }
  return {
    imports,
    lastAsOf: latest ? isoDay(latest.asOf) : null,
    loans: { total: loans.reduce((n, g) => n + g._count._all, 0), byState },
    analysis: newest._max.asOf ? { asOf: isoDay(newest._max.asOf), verdicts } : null,
  };
}
