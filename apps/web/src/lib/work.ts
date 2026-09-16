/**
 * URLA 1b, per current job: whose jobs they are, what is still unanswered, and
 * what the answers read back as.
 *
 * The questions live in `outcomes.ts` with the rest of screen 5's words. This
 * is the part that is not words: which employments belong to the person being
 * asked, whether the set is complete, and the body the route takes.
 *
 * It is a module rather than four helpers inside `ReviewPage.tsx` because the
 * completeness rule is enforced twice and must be the same rule both times.
 * `POST /files/:id/employment-declarations` refuses a partial set with a 422
 * naming the job left out — the whole set or nothing, so a stored answer never
 * sits beside an unasked sibling that a screen would then render as answered.
 * The screen asks the same question before it posts, so a borrower meets the
 * rule as a disabled button rather than as a translated refusal.
 *
 * Nothing here derives an answer. A payroll pull knows what a job pays and
 * cannot know whether the employer is the property seller; a job with no
 * declaration is UNASKED, and unasked is not "no".
 */

import type { FileEmployment } from "@hm/shared";
import type { YesNo } from "./declarations.js";
import type { LoanFileView } from "./file.js";
import { WORK_COPY } from "./outcomes.js";

/** One job's two answers, each unanswered until somebody picks. */
export interface JobAnswer {
  readonly selfEmployed: YesNo;
  readonly partyToTransaction: YesNo;
}

/**
 * What the borrower has changed on this screen, by employment id.
 *
 * Only the changes. The effective answer is this over the stored declaration —
 * see `answerFor` — which is why there is no seeding effect: a form seeded
 * from fetched data is empty on the first render and has to be filled in by an
 * effect, and the one render that matters here is the first one.
 */
export type WorkForm = Readonly<Record<string, Partial<JobAnswer> | undefined>>;

const yesNo = (value: boolean | null | undefined): YesNo =>
  value == null ? "" : value ? "yes" : "no";

/**
 * The jobs one person holds NOW, on this file.
 *
 * Keyed on the party rather than on the borrower row: an employment names who
 * it belongs to across files, and the borrower id is this file's row for them.
 * An absent party answers with nothing rather than with everything — a
 * comparison of two undefined ids is true, and it would hand one borrower's
 * jobs to every reader of a file that has not loaded its people yet.
 *
 * Ended jobs are excluded because URLA 1b is asked about current employment.
 * A job that ended is history the pull reports and nobody attests to.
 */
export function currentJobsFor(
  file: Pick<LoanFileView, "employment"> | undefined,
  partyId: string | null | undefined,
): readonly FileEmployment[] {
  if (!partyId) return [];
  return (file?.employment ?? []).filter(
    (job) => job.partyId === partyId && job.status === "active",
  );
}

/** The answer on screen: what they have picked, or what was already stored. */
export function answerFor(job: FileEmployment, form: WorkForm): JobAnswer {
  const changed = form[job.id];
  return {
    selfEmployed: changed?.selfEmployed ?? yesNo(job.declaration?.selfEmployed),
    partyToTransaction:
      changed?.partyToTransaction ?? yesNo(job.declaration?.employedByPartyToTransaction),
  };
}

/**
 * Whether every current job has both of its answers.
 *
 * True for a borrower with no current job at all, which is the honest answer:
 * there is nothing outstanding, and a gate that reads "false" on an empty set
 * would hold the signature on a question nobody can be asked.
 */
export function workAnswered(jobs: readonly FileEmployment[], form: WorkForm): boolean {
  return jobs.every((job) => {
    const answer = answerFor(job, form);
    return answer.selfEmployed !== "" && answer.partyToTransaction !== "";
  });
}

/**
 * The body `POST /files/:id/employment-declarations` takes.
 *
 * No `borrowerId`: this screen answers for the signer, and the route reads an
 * absent one as Borrower 1. Naming somebody would be this screen claiming to
 * speak for them, which is the thing the co-borrower blocks exist to stop.
 */
export function workBody(jobs: readonly FileEmployment[], form: WorkForm) {
  return {
    answers: jobs.map((job) => {
      const answer = answerFor(job, form);
      return {
        employmentId: job.id,
        selfEmployed: answer.selfEmployed === "yes",
        employedByPartyToTransaction: answer.partyToTransaction === "yes",
      };
    }),
  };
}

/** The heading over one job's questions: what they do, and who for. */
export function jobHeading(job: FileEmployment): string {
  return job.position ? `${job.position} at ${job.employerName}` : job.employerName;
}

/**
 * One answered job, read back.
 *
 * In the words of the thing answered rather than as "Yes" and "No" under the
 * questions, because these are rendered without the questions beside them: a
 * co-borrower's jobs are shown back to somebody who was never asked about
 * them. Jobs with no declaration produce no line — unasked is not "no", and a
 * line reading "not self-employed" about a question nobody put is the derived
 * declaration all over again with the subject changed.
 */
export function workLines(jobs: readonly FileEmployment[]): readonly string[] {
  return jobs.flatMap((job) =>
    job.declaration
      ? [
          `${job.employerName} — ${
            job.declaration.selfEmployed ? WORK_COPY.isSelfEmployed : WORK_COPY.notSelfEmployed
          }; ${
            job.declaration.employedByPartyToTransaction
              ? WORK_COPY.isPartyToTransaction
              : WORK_COPY.notPartyToTransaction
          }`,
        ]
      : [],
  );
}
