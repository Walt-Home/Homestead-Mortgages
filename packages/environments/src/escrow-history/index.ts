/**
 * The escrow-history environment, assembled: escrow-analysis's rulebook with
 * Step 0 in front, its tools, the account as a ledger, and the servicing
 * app's escrow engine as the grader over the account the ledger reads as.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { ESCROW_FINGERPRINT } from "../escrow/index.js";
import {
  expectedEscrow,
  gradeEscrowAgainst,
  parseEscrowSubmission,
  type EscrowAnswer,
} from "../escrow/grader.js";
import { ESCROW_SUBMIT_TOOL, ESCROW_TOOLS, executeEscrowTool } from "../escrow/tools.js";
import { HISTORY_RULEBOOK } from "./rulebook.js";
import {
  HISTORY_ENVIRONMENT_NAME,
  HISTORY_ENVIRONMENT_VERSION,
  readHistory,
  renderHistoryTask,
  type EscrowHistoryTask,
} from "./task.js";

export const expectedHistory = (task: EscrowHistoryTask): EscrowAnswer =>
  expectedEscrow(readHistory(task));

export const escrowHistory: Environment<EscrowHistoryTask, EscrowAnswer> = {
  name: HISTORY_ENVIRONMENT_NAME,
  version: HISTORY_ENVIRONMENT_VERSION,
  system: HISTORY_RULEBOOK,
  tools: ESCROW_TOOLS,
  submitTool: ESCROW_SUBMIT_TOOL,
  render: renderHistoryTask,
  execute: executeEscrowTool,
  parseAnswer: parseEscrowSubmission,
  grade: (task, answer) => gradeEscrowAgainst(expectedHistory(task), answer),
};

export const HISTORY_FINGERPRINT = {
  environment: {
    name: HISTORY_ENVIRONMENT_NAME,
    version: HISTORY_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(HISTORY_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(ESCROW_TOOLS)),
  },
  grader: ESCROW_FINGERPRINT.grader,
} as const;

export * from "./generator.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
