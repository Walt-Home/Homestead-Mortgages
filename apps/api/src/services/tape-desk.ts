/**
 * The tape desk: a servicer's book loaded by hand, reviewed before it is
 * written, and the people on it invited to claim their mortgage.
 *
 * Recapture is what a partner is here for. A tape arrives, the people on it
 * become watched mortgages, the review finds the ones worth a refinance,
 * and none of that reaches anyone until they have claimed the loan as
 * theirs. So the desk is three acts, each with a receipt:
 *
 *   preview   read the tape with the same reader the import uses, write
 *             nothing, and say row by row what loading it would do — the
 *             profile it matches, the required headers it lacks, which loans
 *             are new, changed or unchanged against what we hold, which are
 *             already claimed, which rows are refused and why, and which
 *             loans the supplement gives an address for
 *   load      the import, exactly as the partner door runs it, under the
 *             servicer's own PARTNER principal — the facts are the tape's
 *             assertions whoever carried the file — with the servicer row
 *             made on first sight
 *   invite    one claim per loan, minted the way the partner door mints it
 *             and delivered by mail to the address the supplement carried,
 *             with the outcome on the claim row and, where mail is not on,
 *             the link handed back so a person can deliver it
 *
 * The supplement's address is used once, to send, and stored nowhere: the
 * import deliberately reads no contact into the party, and this keeps that.
 * What the claim row keeps is where the mail went and what the mailer said.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import {
  M3_V1,
  readBook,
  readTabular,
  type BookFile,
  type GapCounts,
  type RowException,
  type TapeProfile,
} from "@hm/partner-book";
import type { ReviewVerdict } from "@hm/refi-review";
import { canonicalRecordHash } from "@hm/shared/portfolio";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { connectors } from "./connectors.js";
import type { Db } from "./db.js";
import { claimUrl, hashInvitationToken } from "./invitations.js";
import { mintLoanClaim } from "./loan-claims.js";
import { reviewLoans } from "./loan-review.js";
import { toDomainLoanState } from "./loan-transition.js";
import {
  importPartnerBook,
  listPartnerBookImports,
  partnerBookStatus,
  type ImportBookResult,
} from "./partner-book.js";
import { partnerPrincipal } from "./party.js";

const PROFILES: Readonly<Record<string, TapeProfile>> = { "m3-v1": M3_V1 };

export function tapeProfile(name: string): TapeProfile {
  const p = PROFILES[name];
  if (!p) throw new AppError(400, `No tape profile named ${name}.`, "UNKNOWN_PROFILE");
  return p;
}

/** A servicer as the desk names one: the slug our rows key on, and the name people read. */
export interface DeskServicer {
  readonly slug: string;
  readonly displayName: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function assertSlug(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new AppError(
      400,
      "A servicer's slug is lowercase letters, digits and hyphens.",
      "BAD_SLUG",
    );
  }
  return slug;
}

/* ── the supplement's addresses, read once and kept nowhere ─────────────── */

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
const NUMBER_KEYS = ["servicer_loan_number", "loan_number", "loan_id", "loan"];
const EMAIL_KEYS = ["borrower_email", "email", "e_mail", "email_address"];

/** Loan number → the supplement's e-mail for it, for the rows that carry one. */
export function supplementEmails(supplement: BookFile | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!supplement) return out;
  let parsed;
  try {
    parsed = readTabular(supplement.filename, supplement.bytes);
  } catch {
    return out;
  }
  const keys = parsed.headers.map(norm);
  const numberAt = keys.findIndex((k) => NUMBER_KEYS.includes(k));
  const emailAt = keys.findIndex((k) => EMAIL_KEYS.includes(k));
  if (numberAt < 0 || emailAt < 0) return out;
  for (const row of parsed.rows) {
    const number = (row[numberAt] ?? "").trim();
    const email = (row[emailAt] ?? "").trim();
    if (number && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.set(number, email);
  }
  return out;
}

/* ── preview ─────────────────────────────────────────────────────────────── */

export type PreviewChange = "created" | "updated" | "unchanged";

export interface PreviewRow {
  readonly row: number;
  readonly number: string;
  readonly borrower: string | null;
  readonly property: string | null;
  readonly balanceCents: string | null;
  readonly ratePct: string | null;
  readonly standing: string | null;
  readonly change: PreviewChange;
  /** The loan's state as we hold it; null for one the tape would create. */
  readonly loanState: string | null;
  readonly claimed: boolean;
  readonly email: string | null;
  /** The newest analysis of the loan, when the book has been looked at. */
  readonly review: { readonly verdict: ReviewVerdict; readonly asOf: string } | null;
  readonly exceptions: readonly RowException[];
}

export interface TapePreview {
  readonly profile: string;
  readonly asOf: string;
  readonly servicer: DeskServicer & { readonly exists: boolean };
  readonly headers: {
    readonly matched: boolean;
    readonly required: number;
    readonly missing: readonly string[];
  };
  readonly rejected: boolean;
  readonly alreadyLoaded: { readonly importId: string; readonly loadedAt: string } | null;
  readonly rowsTotal: number;
  readonly rowsReadable: number;
  readonly rowsRefused: number;
  readonly counts: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
  };
  readonly claimed: number;
  readonly supplement: {
    readonly rows: number;
    readonly matched: number;
    readonly withEmail: number;
    readonly ignoredColumns: readonly string[];
  } | null;
  readonly gaps: GapCounts;
  readonly rows: readonly PreviewRow[];
  /** The first few hundred row exceptions, for the eye; the count is `exceptionsTotal`. */
  readonly exceptions: readonly RowException[];
  readonly exceptionsTotal: number;
  /** Every exception the tape raised, by what and where, with how many rows. */
  readonly exceptionSummary: readonly { code: string; column: string | null; rows: number }[];
}

const EXCEPTIONS_SHOWN = 500;

function summarizeExceptions(
  all: readonly RowException[],
): { code: string; column: string | null; rows: number }[] {
  const counts = new Map<string, { code: string; column: string | null; rows: number }>();
  for (const e of all) {
    const column = typeof e.column === "string" ? e.column : null;
    const key = `${e.code}\u0000${column ?? ""}`;
    const entry = counts.get(key) ?? { code: e.code, column, rows: 0 };
    entry.rows += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.rows - a.rows);
}

export interface TapeInput {
  readonly servicer: DeskServicer;
  readonly profile: string;
  readonly asOf?: string | null;
  readonly tape: BookFile;
  readonly supplement?: BookFile | null;
}

const todayEt = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** The one as-of date every readable row carries, or null when they differ. */
function asOfOfTape(book: ReturnType<typeof readBook>): string | null {
  const dates = new Set(
    book.records.map((r) => (r.record.servicing as { asOf?: string }).asOf?.slice(0, 10) ?? ""),
  );
  dates.delete("");
  return dates.size === 1 ? [...dates][0]! : null;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const verdictOf = (v: string): ReviewVerdict => v.toLowerCase() as ReviewVerdict;

/** Every loan's verdict from the book's newest day of analysis, by loan id. */
async function newestVerdicts(
  db: Db,
  servicerId: string | null,
): Promise<Map<string, { verdict: ReviewVerdict; asOf: string }>> {
  const out = new Map<string, { verdict: ReviewVerdict; asOf: string }>();
  if (!servicerId) return out;
  const latest = await db.loanReview.aggregate({
    _max: { asOf: true },
    where: { loan: { servicerId } },
  });
  const day = latest._max.asOf;
  if (!day) return out;
  const rows = await db.loanReview.findMany({
    where: { asOf: day, loan: { servicerId } },
    select: { loanId: true, verdict: true },
  });
  for (const r of rows) out.set(r.loanId, { verdict: verdictOf(r.verdict), asOf: isoDay(day) });
  return out;
}

export async function previewTape(input: TapeInput, db: Db = prisma): Promise<TapePreview> {
  const profile = tapeProfile(input.profile);
  const slug = assertSlug(input.servicer.slug);
  const asOfDefault = input.asOf ?? todayEt();
  const book = readBook(profile, slug, asOfDefault, input.tape, input.supplement ?? null);
  // The tape's own date when it carries one and every row agrees; the form's
  // is only the fallback for a tape without one.
  const asOf = asOfOfTape(book) ?? asOfDefault;
  const required = profile.columns.filter((c) => c.required).map((c) => c.header);
  const emails = supplementEmails(input.supplement ?? null);

  const servicer = await db.servicer.findUnique({ where: { slug }, select: { id: true } });
  const already = servicer
    ? await db.partnerBookImport.findUnique({
        where: {
          servicerId_tapeSha256_supplementSha256: {
            servicerId: servicer.id,
            tapeSha256: book.tape_sha256,
            supplementSha256: book.supplement_sha256,
          },
        },
        select: { id: true, createdAt: true },
      })
    : null;

  const numbers = book.records.map((r) => r.row.servicer_loan_number);
  const held = servicer
    ? await db.loan.findMany({
        where: { servicerId: servicer.id, servicerLoanNumber: { in: numbers } },
        select: {
          id: true,
          servicerLoanNumber: true,
          status: true,
          observations: {
            orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
            take: 1,
            select: { recordHash: true },
          },
        },
      })
    : [];
  const byNumber = new Map(held.map((l) => [l.servicerLoanNumber!, l]));
  const verdictByLoan = await newestVerdicts(db, servicer?.id ?? null);

  const rows: PreviewRow[] = book.records.map(({ row, record }) => {
    const prior = byNumber.get(row.servicer_loan_number);
    const change: PreviewChange = !prior
      ? "created"
      : prior.observations[0]?.recordHash === canonicalRecordHash(record)
        ? "unchanged"
        : "updated";
    const state = prior ? toDomainLoanState(prior.status) : null;
    const who = record.parties[0]?.legalName;
    const sv = record.servicing as {
      principalBalanceCents?: bigint;
      currentRatePct?: string | null;
      status?: string;
    };
    return {
      row: row.row,
      number: row.servicer_loan_number,
      borrower: who ? [who.given, who.surname].filter(Boolean).join(" ") : null,
      property: [record.property.city, record.property.state].filter(Boolean).join(", ") || null,
      balanceCents:
        sv.principalBalanceCents !== undefined ? sv.principalBalanceCents.toString() : null,
      ratePct: sv.currentRatePct ?? record.terms.noteRatePct ?? null,
      standing: sv.status ?? null,
      change,
      loanState: state,
      claimed: state !== null && state !== "imported_unclaimed",
      email: emails.get(row.servicer_loan_number) ?? null,
      review: prior ? (verdictByLoan.get(prior.id) ?? null) : null,
      exceptions: row.exceptions,
    };
  });

  return {
    profile: book.profile,
    asOf,
    servicer: { ...input.servicer, slug, exists: servicer !== null },
    headers: {
      matched: book.rejected === null,
      required: required.length,
      missing: book.rejected?.missing_headers ?? [],
    },
    rejected: book.rejected !== null,
    alreadyLoaded: already
      ? { importId: already.id, loadedAt: already.createdAt.toISOString() }
      : null,
    rowsTotal: book.rows_total,
    rowsReadable: rows.length,
    // A refused row is one that made no record; a row with an unreadable
    // cell still loads, and is an exception rather than a refusal.
    rowsRefused: book.rejected ? book.rows_total : book.rows_total - rows.length,
    counts: {
      created: rows.filter((r) => r.change === "created").length,
      updated: rows.filter((r) => r.change === "updated").length,
      unchanged: rows.filter((r) => r.change === "unchanged").length,
    },
    claimed: rows.filter((r) => r.claimed).length,
    supplement: input.supplement
      ? {
          rows: book.supplement.rows,
          matched: book.records.filter((r) => r.row.supplement !== null).length,
          withEmail: rows.filter((r) => r.email !== null).length,
          ignoredColumns: book.supplement.ignored_columns,
        }
      : null,
    gaps: book.gaps,
    rows,
    exceptions: book.exceptions.slice(0, EXCEPTIONS_SHOWN),
    exceptionsTotal: book.exceptions.length,
    exceptionSummary: summarizeExceptions(book.exceptions),
  };
}

/* ── load ────────────────────────────────────────────────────────────────── */

export interface TapeLoad {
  readonly servicer: DeskServicer & { readonly id: string; readonly created: boolean };
  readonly result: ImportBookResult;
}

/**
 * The import, as the partner door runs it, for a servicer the desk names.
 * The row is made on first sight at the depth the servicing app holds the
 * book, because a tape reaching this desk has already been loaded there.
 */
export async function loadTape(input: TapeInput, db: Db = prisma): Promise<TapeLoad> {
  tapeProfile(input.profile);
  const slug = assertSlug(input.servicer.slug);
  const displayName = input.servicer.displayName.trim();
  if (!displayName) throw new AppError(400, "The servicer needs a name.", "BAD_REQUEST");
  const existing = await db.servicer.findUnique({ where: { slug }, select: { id: true } });
  const servicer =
    existing ??
    (await db.servicer.create({
      data: { slug, displayName, integrationDepth: "API" },
      select: { id: true },
    }));
  const principalId = await partnerPrincipal(db, slug);
  let result: ImportBookResult;
  try {
    result = await importPartnerBook(
      {
        servicerId: servicer.id,
        principalId,
        profile: input.profile,
        asOf: input.asOf ?? null,
        tape: input.tape,
        supplement: input.supplement ?? null,
      },
      db,
    );
  } catch (err) {
    if (err instanceof RangeError) throw new AppError(400, err.message, "UNKNOWN_PROFILE");
    throw err;
  }
  return {
    servicer: { slug, displayName, id: servicer.id, created: existing === null },
    result,
  };
}

/* ── the first look ──────────────────────────────────────────────────────── */

export type VerdictCounts = Record<ReviewVerdict, number>;

export interface BookAnalysis {
  readonly asOf: string;
  /** Unclaimed loans on the book. */
  readonly unclaimed: number;
  /** Analyzed on this run; the rest were already analyzed today or skipped. */
  readonly analyzed: number;
  readonly alreadyReviewed: number;
  readonly skipped: number;
  /** Today's verdicts over the whole book, counted. */
  readonly counts: VerdictCounts;
  /** Today's verdict per servicer loan number. */
  readonly verdicts: Record<string, ReviewVerdict>;
}

const emptyCounts = (): VerdictCounts => ({ candidate: 0, watching: 0, not_now: 0, excluded: 0 });

/**
 * The book's first look: the daily review's engine over every unclaimed
 * loan the servicer has, as analysis — a verdict per loan against today's
 * rate, no offer, no contact — so the desk can say which loans are worth
 * inviting first. Once a day, like the review; a second run the same day
 * writes nothing and still answers every verdict.
 */
export async function analyzeBook(
  input: { readonly servicerSlug: string },
  db: Db = prisma,
): Promise<BookAnalysis> {
  const slug = assertSlug(input.servicerSlug);
  const servicer = await db.servicer.findUnique({ where: { slug }, select: { id: true } });
  if (!servicer) throw new AppError(404, "No such servicer.", "NOT_FOUND");
  const run = await reviewLoans({ servicerId: servicer.id, scope: "unclaimed", analyst: null }, db);
  const counts = emptyCounts();
  const verdicts: Record<string, ReviewVerdict> = {};
  const today = await db.loanReview.findMany({
    where: {
      asOf: new Date(`${run.asOf}T00:00:00.000Z`),
      loan: { servicerId: servicer.id, status: "IMPORTED_UNCLAIMED" },
    },
    select: { verdict: true, loan: { select: { servicerLoanNumber: true } } },
  });
  for (const t of today) {
    const v = verdictOf(t.verdict);
    counts[v] += 1;
    if (t.loan.servicerLoanNumber) verdicts[t.loan.servicerLoanNumber] = v;
  }
  return {
    asOf: run.asOf,
    unclaimed: run.unclaimed,
    analyzed: run.reviewed.length,
    alreadyReviewed: run.alreadyReviewed,
    skipped: run.skipped.length,
    counts,
    verdicts,
  };
}

/* ── invite ──────────────────────────────────────────────────────────────── */

export type InvitationOutcome =
  | {
      readonly number: string;
      readonly status: "sent";
      readonly to: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "not_delivered";
      readonly to: string;
      readonly reason: string;
      /** For a person to deliver by hand, since the mailer could not. */
      readonly link: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "no_address";
      readonly link: string;
      readonly expiresAt: string;
    }
  | { readonly number: string; readonly status: "not_claimable"; readonly reason: string };

export function claimMessage(input: {
  readonly to: string;
  readonly servicerName: string;
  readonly place: string | null;
  readonly link: string;
  readonly expiresAt: Date;
}) {
  const until = input.expiresAt.toISOString().slice(0, 10);
  const where = input.place ? ` on your home in ${input.place}` : "";
  return {
    to: input.to,
    subject: `Confirm your mortgage with Supermortgage`,
    text: [
      "Hi,",
      "",
      `${input.servicerName} shared the mortgage${where} with Supermortgage so we can watch it for a better rate and tell you when one is worth a look.`,
      "Nothing is looked up about you until you confirm it's yours, and confirming is not a credit request.",
      "",
      "Confirm it here:",
      input.link,
      "",
      `The link works once and is good until ${until}. If this isn't your mortgage, you can ignore this message.`,
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/**
 * One claim per loan, delivered. Every loan answers, one way or another —
 * the desk shows a table, not an exception — and a mailer that is not on
 * says so per loan rather than pretending, with the link beside it.
 */
export async function inviteToClaim(
  input: {
    readonly servicerSlug: string;
    readonly invitations: readonly { readonly number: string; readonly email: string | null }[];
  },
  db: Db = prisma,
): Promise<readonly InvitationOutcome[]> {
  const slug = assertSlug(input.servicerSlug);
  const servicer = await db.servicer.findUnique({
    where: { slug },
    select: { id: true, displayName: true },
  });
  if (!servicer) throw new AppError(404, "No such servicer.", "NOT_FOUND");
  const principalId = await partnerPrincipal(db, slug);
  const mail = connectors().mail;
  const mailIsOff = mail.capabilities.mode === "fixture" && config.nodeEnv === "production";

  const out: InvitationOutcome[] = [];
  for (const inv of input.invitations) {
    let minted;
    try {
      minted = await mintLoanClaim(
        { servicerId: servicer.id, servicerLoanNumber: inv.number, principalId },
        db,
      );
    } catch (err) {
      out.push({
        number: inv.number,
        status: "not_claimable",
        reason: err instanceof AppError ? err.message : "The claim could not be minted.",
      });
      continue;
    }
    const link = claimUrl(minted.token);
    if (!inv.email) {
      out.push({ number: inv.number, status: "no_address", link, expiresAt: minted.expiresAt });
      continue;
    }
    const loan = await db.loan.findUnique({
      where: { id: minted.loanId },
      select: { propertyCity: true, propertyState: true },
    });
    const place = [loan?.propertyCity, loan?.propertyState].filter(Boolean).join(", ") || null;
    const message = claimMessage({
      to: inv.email,
      servicerName: servicer.displayName,
      place,
      link,
      expiresAt: new Date(minted.expiresAt),
    });
    const outcome = mailIsOff
      ? { status: "not_delivered" as const, reason: "Mail is not configured on this deployment." }
      : await mail.send(message).catch((e: unknown) => ({
          status: "not_delivered" as const,
          reason: e instanceof Error ? e.message : String(e),
        }));
    await db.loanClaim.update({
      where: { tokenHash: hashInvitationToken(minted.token) },
      data: {
        deliveredTo: inv.email,
        deliveredAt: outcome.status === "sent" ? new Date() : null,
        delivery: outcome as unknown as Prisma.InputJsonValue,
      },
    });
    if (outcome.status === "sent") {
      out.push({ number: inv.number, status: "sent", to: inv.email, expiresAt: minted.expiresAt });
    } else {
      out.push({
        number: inv.number,
        status: "not_delivered",
        to: inv.email,
        reason: outcome.reason,
        link,
        expiresAt: minted.expiresAt,
      });
    }
  }
  return out;
}

/* ── the desk's own reads ────────────────────────────────────────────────── */

export async function deskServicers(db: Db = prisma) {
  const rows = await db.servicer.findMany({
    orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, integrationDepth: true },
  });
  return Promise.all(
    rows.map(async (s) => ({
      slug: s.slug,
      displayName: s.displayName,
      integrationDepth: s.integrationDepth,
      book: await partnerBookStatus(s.id, db),
    })),
  );
}

export async function deskImports(slug: string, db: Db = prisma) {
  const servicer = await db.servicer.findUnique({
    where: { slug: assertSlug(slug) },
    select: { id: true },
  });
  if (!servicer) return [];
  const rows = await listPartnerBookImports(servicer.id, db);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
