/**
 * A tape-intake task: one partner's monthly tape as the tape desk receives
 * it, beside the last tape the desk loaded, before it is loaded.
 *
 * The partner is a servicer whose book Supermortgage watches. Its tape for a
 * month is one file in the m3-v1 layout, written by the life generator's tape
 * writer from a book of loans the generator ran month by month. The delivery
 * may carry tape-stream defects (what a delivery does to right values,
 * src/life/tape-defects.ts) and history errors that show on the tape (a
 * vendor's or a system's, src/life/defects.ts); a clean delivery carries none
 * and is the negative. The model names each defect, says whether the delivery
 * can be loaded, and says what to ask the partner.
 *
 * What the model is shown is what the desk shows: the delivery's name, day,
 * row count and header row exactly as written; the last tape loaded, by its
 * month, name and rows; and what the reader made of the delivery (`desk.ts`).
 * The cells are read through the tools. The labels are never rendered.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, type Split } from "../refi/task.js";
import type { DeskReading } from "./desk.js";
import type { IntakeExpected } from "./grader.js";

export const INTAKE_ENVIRONMENT_NAME = "tape-intake";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const INTAKE_ENVIRONMENT_VERSION = "1.0.0";

/** One file as the desk holds it: a header row and data rows, every cell text. */
export interface IntakeFile {
  readonly name: string;
  /** The month the partner said it was for. */
  readonly for_month: string;
  readonly received_on: PlainDate;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface TapeIntakeTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** What the delivery was drawn to carry (`INTAKE_ARMS`); never rendered. */
  readonly arm: string;
  readonly partner: string;
  readonly delivery: IntakeFile;
  readonly last_loaded: IntakeFile;
  readonly desk_reading: DeskReading;
  /** The findings and verdict the labels give; never rendered. */
  readonly expected: IntakeExpected;
}

export function intakePayload(task: TapeIntakeTask): Record<string, unknown> {
  const d = task.delivery;
  const l = task.last_loaded;
  return {
    partner: task.partner,
    layout: "m3-v1",
    delivery: {
      for_month: d.for_month,
      received_on: d.received_on,
      file: d.name,
      rows: d.rows.length,
      headers: [...d.headers],
    },
    last_loaded: {
      for_month: l.for_month,
      received_on: l.received_on,
      file: l.name,
      rows: l.rows.length,
    },
    desk_reading: task.desk_reading,
  };
}

export function renderIntakeTask(task: TapeIntakeTask): string {
  return [
    `Review this tape before it is loaded: ${task.partner}'s delivery for ${task.delivery.for_month}, received on ${task.delivery.received_on}, beside the last tape the desk loaded. The headers are the delivery's exactly as written; read its cells, and the last tape's, with the tools.`,
    "",
    PAYLOAD_START,
    JSON.stringify(intakePayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every lookup and every figure, and finish by calling submit_intake with the verdict and every defect you find.",
  ].join("\n");
}
