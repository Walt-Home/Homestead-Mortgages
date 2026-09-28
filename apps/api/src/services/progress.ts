/**
 * What a long write says about itself while it runs.
 *
 * A book is thousands of rows and one transaction; the desk that started
 * it deserves better than a spinner. The load and the first review take an
 * optional listener and call it as each chunk lands — a stage, how many of
 * that stage's things are done, and how many there are — and the streaming
 * routes forward every call as a line. Nothing here changes what is
 * written; a listener that throws is the caller's problem, not the load's.
 */

export type ProgressStage =
  /** The tape parsed; the total is rows. */
  | "reading"
  /** The people, one per new loan. */
  | "people"
  /** The loans, with who is on them. */
  | "loans"
  /** What the tape says about each person. */
  | "facts"
  /** The balances and standing, one per loan on the tape. */
  | "observations"
  /** Each loan against today's rate. */
  | "reviewing"
  /** The verdicts, written. */
  | "verdicts";

export interface Progress {
  readonly stage: ProgressStage;
  readonly done: number;
  readonly total: number;
}

export type OnProgress = (progress: Progress) => void;

/** A listener for one stage, in the shape `inChunks` reports: done so far, and the total. */
export const stageProgress =
  (onProgress: OnProgress | undefined, stage: ProgressStage) =>
  (done: number, total: number): void => {
    onProgress?.({ stage, done, total });
  };
