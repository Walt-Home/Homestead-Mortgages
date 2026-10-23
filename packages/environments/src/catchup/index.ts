/**
 * The catchup-posting environment, assembled: a catch-up receipt on a loan
 * that fell behind, drawn from a ten-year history the life generator wrote,
 * on a note whose late-charge cap the servicing system may have lost at
 * boarding (D-03). The rulebook is D-03's correction and cashiering's
 * waterfall, the tool is refi's calculator, and the grader is the servicing
 * app's own late-charge function and allocation engine, ported.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeCatchup, parseCatchupSubmission, type CatchupAnswer } from "./grader.js";
import { CATCHUP_RULEBOOK } from "./rulebook.js";
import {
  CATCHUP_ENVIRONMENT_NAME,
  CATCHUP_ENVIRONMENT_VERSION,
  renderCatchupTask,
  type CatchupTask,
} from "./task.js";
import { CATCHUP_SUBMIT_TOOL, CATCHUP_TOOLS, executeCatchupTool } from "./tools.js";

export const catchupPosting: Environment<CatchupTask, CatchupAnswer> = {
  name: CATCHUP_ENVIRONMENT_NAME,
  version: CATCHUP_ENVIRONMENT_VERSION,
  system: CATCHUP_RULEBOOK,
  tools: CATCHUP_TOOLS,
  submitTool: CATCHUP_SUBMIT_TOOL,
  render: renderCatchupTask,
  execute: executeCatchupTool,
  parseAnswer: parseCatchupSubmission,
  grade: gradeCatchup,
};

export const CATCHUP_FINGERPRINT = {
  environment: {
    name: CATCHUP_ENVIRONMENT_NAME,
    version: CATCHUP_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(CATCHUP_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(CATCHUP_TOOLS)),
  },
  grader: {
    rule_set_version:
      "cashiering.allocation.v1 + lateChargeAmount (servicing §2.1, §2.7; D-03's correction)",
    port_version:
      "apps/servicing@293261b3 src/domain/cashiering/{types,biweekly,allocation,latecharges}.ts; life 1.0.0",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
