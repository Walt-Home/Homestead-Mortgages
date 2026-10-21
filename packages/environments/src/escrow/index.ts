/**
 * The escrow-analysis environment, assembled: the servicing app's annual
 * escrow analysis (RESPA §1024.17; its spec §3.2) as the rulebook, refi's
 * date and arithmetic tools, the account as the task, and the servicing
 * app's own engine, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeEscrow, parseEscrowSubmission, type EscrowAnswer } from "./grader.js";
import { ESCROW_RULEBOOK } from "./rulebook.js";
import {
  ESCROW_ENVIRONMENT_NAME,
  ESCROW_ENVIRONMENT_VERSION,
  renderEscrowTask,
  type EscrowTask,
} from "./task.js";
import { ESCROW_SUBMIT_TOOL, ESCROW_TOOLS, executeEscrowTool } from "./tools.js";

export const escrowAnalysis: Environment<EscrowTask, EscrowAnswer> = {
  name: ESCROW_ENVIRONMENT_NAME,
  version: ESCROW_ENVIRONMENT_VERSION,
  system: ESCROW_RULEBOOK,
  tools: ESCROW_TOOLS,
  submitTool: ESCROW_SUBMIT_TOOL,
  render: renderEscrowTask,
  execute: executeEscrowTool,
  parseAnswer: parseEscrowSubmission,
  grade: gradeEscrow,
};

/** What a run record says the environment and the grader were. */
export const ESCROW_FINGERPRINT = {
  environment: {
    name: ESCROW_ENVIRONMENT_NAME,
    version: ESCROW_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(ESCROW_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(ESCROW_TOOLS)),
  },
  grader: {
    rule_set_version: "servicing §3.2 R1–R10, §3.4",
    port_version: "apps/servicing@293261b3 src/domain/escrow/analysis.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
