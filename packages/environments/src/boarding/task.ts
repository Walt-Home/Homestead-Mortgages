/**
 * A boarding-triage task: one transfer package, before it boards.
 *
 * The package is what the life generator's transfer-package writer produces
 * for a batch of one to four loans the generator boarded by transfer on one
 * date: the twelve files of the servicing app's sample layout and the prior
 * servicer's correspondence. Some loans carry a planted defect in a cell; the
 * others are clean twins, the negatives. The model reads the package, names
 * every defect it finds and says what to do about each, and passes the rest.
 *
 * What the model is shown is the package, trimmed to what a reviewer reads:
 * the final tape loan by loan, the short detail files in full, the images
 * manifest without its hashes. The payment history and the correspondence
 * are long, and are read through the `read_file` tool; the fair-lending file
 * is restricted, and a reviewer does not read it. The labels are never
 * rendered.
 */

import { addDays, type PlainDate } from "@hm/kernel/calendar";
import {
  CORRESPONDENCE_FILE,
  type PackageFile,
  type PackageLabel,
  type TransferBatch,
} from "../life/transfer-package.js";
import { parseCsv } from "./ported/tape-codec.js";
import { PAYLOAD_START, type Split } from "../refi/task.js";

export const BOARDING_ENVIRONMENT_NAME = "boarding-triage";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const BOARDING_ENVIRONMENT_VERSION = "1.0.0";

export interface BoardingTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly batch: TransferBatch;
  /** The package as written, every file whole. */
  readonly files: Readonly<Record<PackageFile, string>>;
  /** The loans, by transferor loan number, in the tape's order. */
  readonly loans: readonly string[];
  /** The planted cells; never rendered. */
  readonly labels: readonly PackageLabel[];
}

/** The files the task shows whole, and the ones it lists and leaves to `read_file`. */
export const SHOWN: readonly PackageFile[] = [
  "boarding_tape.final.csv",
  "escrow_history.csv",
  "escrow_analysis.csv",
  "lossmit_file.csv",
  "fc_bk_file.csv",
  "consents_file.csv",
  "images_manifest.csv",
  "trial_balance.csv",
  "fnma_position.csv",
  "mers_lookup.csv",
];
export const READ_WITH_THE_TOOL: readonly PackageFile[] = [
  "payment_history.csv",
  CORRESPONDENCE_FILE,
];
export const RESTRICTED: readonly PackageFile[] = ["fair_lending.csv"];

/** The columns a reviewer does not read, left out of what is shown (the tool returns the file whole). */
const TRIMMED: Readonly<Partial<Record<PackageFile, readonly string[]>>> = {
  "images_manifest.csv": ["sha256"],
};

export function boardingPayload(task: BoardingTask): Record<string, unknown> {
  const rows = (f: PackageFile) =>
    parseCsv(task.files[f]).map((r) => {
      const drop = TRIMMED[f] ?? [];
      return Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k)));
    });
  const count = (f: PackageFile) => parseCsv(task.files[f]).length;
  return {
    transfer: {
      batch_id: task.batch.batch_id,
      transfer_date: task.batch.transfer_date,
      as_of: addDays(task.batch.transfer_date, -1) as PlainDate,
      transferor: task.batch.transferor_name,
      transferor_servicer_number: task.batch.transferor_servicer_number,
      transferee: "Supermortgage",
      transferee_servicer_number: task.batch.partner_servicer_number,
      loans: [...task.loans],
    },
    files: Object.fromEntries(SHOWN.map((f) => [f, rows(f)])),
    not_shown: Object.fromEntries([
      ...READ_WITH_THE_TOOL.map((f) => [f, `${count(f)} rows: read it with read_file`]),
      ...RESTRICTED.map((f) => [
        f,
        `${count(f)} rows: restricted, and not read in a boarding review`,
      ]),
    ]),
  };
}

export function renderBoardingTask(task: BoardingTask): string {
  const n = task.loans.length;
  return [
    `Review this transfer package before it boards: ${n} ${n === 1 ? "loan" : "loans"} from ${task.batch.transferor_name} to Supermortgage on ${task.batch.transfer_date}, as of the close of business the day before. Each file's rows are shown as objects keyed by the file's columns; a cell is exactly the text the file holds, and "" is a blank cell.`,
    "",
    PAYLOAD_START,
    JSON.stringify(boardingPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every lookup and every figure, and finish by calling submit_triage with every defect you find.",
  ].join("\n");
}
