/**
 * Recording what Desktop Underwriter answered.
 *
 * One answer, one row, plus the findings report as rows under it. A
 * resubmission writes another set beside them and overwrites nothing — the
 * reason `connector_snapshots` and `decisions` are append-only is that "your
 * situation changed" is a diff between two answers, and this is the same shape
 * for the same reason. A trigger refuses an UPDATE, so nothing here has to be
 * careful about it.
 *
 * **This does not move the application, and that is the decision rather than an
 * omission.** A DU recommendation is Fannie Mae's assessment of a loan they
 * might buy; the creditor is Grander and an extension of credit is theirs to
 * make. Every move in the nineteen-state machine carries an actor principal and
 * a reason code from a closed set, and DU is not a principal here — the column
 * points at `principals`, which are the people and the model versions we
 * operate, so "who decided this" stays answerable as somebody we can ask. An
 * Approve/Eligible that advanced a file on its own would start ECOA clocks on a
 * third party's verdict about data nobody had finished verifying, and an
 * errored response would be a state change made on a value we could not read.
 *
 * So a move BECAUSE of a response is somebody's move, made later, naming this
 * row's id in `application_transitions.caused_by`. The database already refuses
 * a status change with no ledger row behind it; what this module promises is
 * that it asks for none.
 *
 * The one column it does write outside these two tables is
 * `applications.du_casefile_id`, which has been empty since it was added
 * because nothing had ever asked DU for a casefile. It is write-once by
 * trigger: a rewrite of the same value is a no-op, so a duplicate delivery is
 * an ordinary retry, and a different value raises.
 *
 * **Both words DU chose are read before anything is written.** A response whose
 * status or recommendation this system does not recognize stores nothing and
 * takes no casefile. Defaulting either is worse than failing: an unrecognized
 * status read as "errored" files a verdict DU gave as a casefile DU could not
 * evaluate, and it claims the write-once column on the way past.
 */

import {
  prisma,
  type DuRecommendation as StoredRecommendation,
  type DuResponseStatus as StoredStatus,
} from "@hm/db";
import type { ConnectorResult, DuSubmission } from "@hm/connectors";
import {
  parseDuRecommendation,
  parseDuResponseStatus,
  type DuAnswer,
  type DuRecommendation,
  type DuResponse,
  type DuResponseStatus,
} from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { type Db, ownsTransaction } from "./db.js";

/**
 * DU's spelling, as the column stores it.
 *
 * Exhaustive over the domain type, so a recommendation added to `@hm/shared`
 * and not to the Postgres enum is a compile error here rather than a failed
 * insert in front of whoever was submitting. That is the compile-time half; a
 * string a real adapter hands us at runtime is not narrowed by anything, which
 * is why this map is only ever reached through `parseDuRecommendation` and can
 * no longer miss.
 */
const STORED: Record<DuRecommendation, StoredRecommendation> = {
  "Approve/Eligible": "APPROVE_ELIGIBLE",
  "Approve/Ineligible": "APPROVE_INELIGIBLE",
  "Refer/Eligible": "REFER_ELIGIBLE",
  "Refer/Ineligible": "REFER_INELIGIBLE",
  "Refer with Caution": "REFER_WITH_CAUTION",
  "Out of Scope": "OUT_OF_SCOPE",
};

/**
 * Which of the two shapes the row records, as the column spells it.
 *
 * Exhaustive for the same reason `STORED` is, and it is the more important of
 * the two: this is the field anything downstream reads to decide whether a
 * recommendation is there to be read at all.
 */
const STORED_STATUS: Record<DuResponseStatus, StoredStatus> = {
  answered: "ANSWERED",
  errored: "ERRORED",
};

/** The stored spellings back to DU's own, for a reader. */
const WIRE: Record<StoredRecommendation, DuRecommendation> = Object.fromEntries(
  Object.entries(STORED).map(([wire, stored]) => [stored, wire]),
) as Record<StoredRecommendation, DuRecommendation>;
const WIRE_STATUS: Record<StoredStatus, DuResponseStatus> = {
  ANSWERED: "answered",
  ERRORED: "errored",
};

/** What DU last answered about this file's application, or null when nothing has been sent. */
export async function latestDuAnswer(
  loanFileId: string,
  db: Db = prisma,
): Promise<DuAnswer | null> {
  const row = await db.duResponse.findFirst({
    where: { application: { loanFileId } },
    orderBy: { seq: "desc" },
    select: {
      seq: true,
      status: true,
      recommendation: true,
      duCasefileId: true,
      provider: true,
      submittedAt: true,
      receivedAt: true,
      messages: { orderBy: { ordinal: "asc" }, select: { category: true, code: true, text: true } },
    },
  });
  if (!row) return null;
  return {
    seq: row.seq,
    status: WIRE_STATUS[row.status],
    recommendation: row.recommendation === null ? null : WIRE[row.recommendation],
    duCasefileId: row.duCasefileId,
    provider: row.provider,
    submittedAt: row.submittedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    messages: row.messages,
  };
}

export interface RecordedDuResponse {
  readonly id: string;
  readonly seq: number;
}

/**
 * Write one answer down.
 *
 * `submittedAt` is the caller's, because only the caller knows when it sent —
 * the adapter reports when it answered. The gap between the two is what a
 * timeout looks like afterwards.
 */
export async function recordDuResponse(
  submission: DuSubmission,
  answer: ConnectorResult<DuResponse>,
  submittedAt: Date,
  db: Db = prisma,
): Promise<RecordedDuResponse> {
  if (ownsTransaction(db)) {
    return prisma.$transaction((tx) => write(tx, submission, answer, submittedAt));
  }
  return write(db, submission, answer, submittedAt);
}

async function write(
  tx: Db,
  submission: DuSubmission,
  answer: ConnectorResult<DuResponse>,
  submittedAt: Date,
): Promise<RecordedDuResponse> {
  const response = answer.data;

  // Both words DU chose, read before anything is written. A status or a
  // recommendation nobody here recognizes throws before the row is built AND
  // before the write-once casefile is claimed — because an unreadable answer
  // that had already taken `applications.du_casefile_id` would leave the one
  // column a resubmission depends on spent on an answer nobody could act on.
  const status = parseDuResponseStatus(response.status);
  // Narrowed on the field rather than on `status` so the union below opens,
  // and the line above is what makes that narrowing true of the value that
  // arrived rather than only of the type somebody declared for it.
  const recommendation: StoredRecommendation | null =
    response.status === "answered" ? STORED[parseDuRecommendation(response.recommendation)] : null;

  // Taken before the sequence is read, not after. Two answers about one
  // application — a retry landing beside the delivery it was retrying — both
  // compute the same number otherwise, and the unique index gives the loser an
  // error instead of a row. Same lock, same reason, as allocating a borrower's
  // position.
  const locked = await tx.$queryRaw<
    { loan_file_id: string }[]
  >`SELECT "loan_file_id" FROM "applications" WHERE "id" = ${submission.applicationId}::uuid FOR UPDATE`;
  const application = locked[0];
  if (!application) {
    throw new AppError(
      404,
      "There is no application to record a Desktop Underwriter response against.",
      "NOT_FOUND",
    );
  }
  // The submission told the connector guard which file's signatures its tokens
  // had to have been minted on, and nothing outside this process had checked
  // that claim against a row. `applications.loan_file_id` is the answer, and
  // here is the first moment it can be asked: a pair that disagrees means the
  // permissions this casefile went out under were not this application's.
  if (application.loan_file_id !== submission.loanFileId) {
    throw new AppError(
      409,
      "This submission names a different loan file than the application it was sent for.",
      "FILE_MISMATCH",
    );
  }

  // Before the response row, because the trigger on `du_responses` requires the
  // application to already carry the case DU named. Write-once: the same value
  // again is a no-op, a different one raises rather than starting a second case
  // at Fannie while our records still say one.
  if (response.duCasefileId !== null) {
    await tx.application.update({
      where: { id: submission.applicationId },
      data: { duCasefileId: response.duCasefileId },
    });
  }

  const last = await tx.duResponse.findFirst({
    where: { applicationId: submission.applicationId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });

  const created = await tx.duResponse.create({
    data: {
      applicationId: submission.applicationId,
      seq: (last?.seq ?? 0) + 1,
      status: STORED_STATUS[status],
      recommendation,
      duCasefileId: response.duCasefileId,
      ausCasefileId: submission.ausCasefileId,
      provider: answer.provider,
      submittedAt,
      receivedAt: new Date(response.respondedAt),
      messages: {
        create: response.messages.map((m, i) => ({
          // One-based, matching every other ordinal in this schema and the
          // CHECK that refuses a zero.
          ordinal: i + 1,
          category: m.category,
          code: m.code,
          text: m.text,
        })),
      },
    },
    select: { id: true, seq: true },
  });

  return created;
}
