/**
 * URLA 1b, per job: what the borrower says about each of their current
 * employments, recorded with who said it.
 *
 * Two questions the form asks about every current job — business owner or
 * self-employed; employed by a family member, the property seller, a real
 * estate agent or another party to the transaction — and neither is knowable
 * from a pull. They are asked on the review screen, once the pulls have said
 * which jobs there are, above the signature that attests to them. This is the
 * writer, and it keeps the same three promises `recordDeclaration` keeps:
 *
 *   - the whole set or nothing. A borrower answers for every current job at
 *     once; a partial submit is refused, so a stored answer never sits beside
 *     an unasked sibling that a screen would then render as "answered";
 *   - about your own jobs, by you. Every employment named must belong to the
 *     file and to the borrower being answered for, and the principal asserting
 *     must be allowed to speak for that borrower — a co-borrower's jobs are
 *     theirs to answer;
 *   - who said it, and when. The principal is the requester's, never the
 *     subject's, for the reason the declarations route gives: a row stamped
 *     with the subject's principal is somebody on record attesting to a form
 *     they never saw.
 */

import { prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { assertMaySpeakFor, borrowerEdge } from "./declarations.js";
import type { Db } from "./db.js";

export interface EmploymentAnswer {
  readonly employmentId: string;
  readonly selfEmployed: boolean;
  readonly employedByPartyToTransaction: boolean;
}

export interface EmploymentDeclarationView {
  readonly employmentId: string;
  readonly employerName: string;
  readonly selfEmployed: boolean;
  readonly employedByPartyToTransaction: boolean;
  readonly declaredAt: string;
}

function ownsTransaction(db: Db): boolean {
  return db === prisma;
}

export async function recordEmploymentDeclarations(
  loanFileId: string,
  input: {
    readonly answers: readonly EmploymentAnswer[];
    /** Whose jobs. Absent is borrower 1, the person whose request this is. */
    readonly borrowerId?: string;
    /** Who is asserting, which is whoever made the request. */
    readonly assertedByPrincipalId: string;
  },
  db: Db = prisma,
): Promise<EmploymentDeclarationView[]> {
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => recordEmploymentDeclarations(loanFileId, input, tx));
  }

  const { borrower } = await borrowerEdge(db, loanFileId, input.borrowerId);
  await assertMaySpeakFor(db, input.assertedByPrincipalId, borrower.partyId);

  // Every live current job this person has on this file — the set the form
  // asks about, and the set the answers must cover exactly.
  const jobs = await db.employment.findMany({
    where: { loanFileId, partyId: borrower.partyId, retiredAt: null, status: "active" },
    select: { id: true, employerName: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const expected = new Set(jobs.map((j) => j.id));
  const given = new Map(input.answers.map((a) => [a.employmentId, a] as const));

  const strangers = input.answers.filter((a) => !expected.has(a.employmentId));
  if (strangers.length > 0) {
    // Not a 404: the id may well exist, on another file or another person.
    // Naming it either way is an oracle; refusing the submit is not.
    throw new AppError(
      422,
      "An answer names an employment that is not this borrower's on this file.",
      "EMPLOYMENT_NOT_THEIRS",
    );
  }
  const missing = jobs.filter((j) => !given.has(j.id));
  if (missing.length > 0) {
    throw new AppError(
      422,
      `Answer for every current job at once; still unanswered: ${missing
        .map((j) => j.employerName)
        .join(", ")}.`,
      "EMPLOYMENT_ANSWERS_INCOMPLETE",
    );
  }
  if (given.size !== input.answers.length) {
    throw new AppError(422, "One answer per job.", "EMPLOYMENT_ANSWERS_DUPLICATED");
  }

  const declaredAt = new Date();
  const views: EmploymentDeclarationView[] = [];
  for (const job of jobs) {
    const answer = given.get(job.id)!;
    await db.employment.update({
      where: { id: job.id },
      data: {
        selfEmployed: answer.selfEmployed,
        employedByPartyToTransaction: answer.employedByPartyToTransaction,
        declaredByPrincipalId: input.assertedByPrincipalId,
        declaredAt,
      },
    });
    views.push({
      employmentId: job.id,
      employerName: job.employerName,
      selfEmployed: answer.selfEmployed,
      employedByPartyToTransaction: answer.employedByPartyToTransaction,
      declaredAt: declaredAt.toISOString(),
    });
  }
  return views;
}
