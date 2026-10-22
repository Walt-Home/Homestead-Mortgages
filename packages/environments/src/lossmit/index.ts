/**
 * The lossmit-retention environment, assembled: the servicing app's
 * evaluation of a complete loss-mitigation application under Fannie Mae's
 * workout hierarchy (its spec §12.2, with §12.4 forbearance, §12.5
 * repayment plans and §12.6 payment deferral) as the rulebook, refi's date
 * and arithmetic tools plus Fannie Mae's business-day step, one delinquent
 * loan's complete application as the task, and the servicing app's own
 * hierarchy walk, plans and deferral engines, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeLossmit, parseLossmitSubmission, type LossmitAnswer } from "./grader.js";
import { LOSSMIT_RULEBOOK } from "./rulebook.js";
import {
  LOSSMIT_ENVIRONMENT_NAME,
  LOSSMIT_ENVIRONMENT_VERSION,
  renderLossmitTask,
  type LossmitTask,
} from "./task.js";
import { LOSSMIT_SUBMIT_TOOL, LOSSMIT_TOOLS, executeLossmitTool } from "./tools.js";

export const lossmitRetention: Environment<LossmitTask, LossmitAnswer> = {
  name: LOSSMIT_ENVIRONMENT_NAME,
  version: LOSSMIT_ENVIRONMENT_VERSION,
  system: LOSSMIT_RULEBOOK,
  tools: LOSSMIT_TOOLS,
  submitTool: LOSSMIT_SUBMIT_TOOL,
  render: renderLossmitTask,
  execute: executeLossmitTool,
  parseAnswer: parseLossmitSubmission,
  grade: gradeLossmit,
};

export const LOSSMIT_FINGERPRINT = {
  environment: {
    name: LOSSMIT_ENVIRONMENT_NAME,
    version: LOSSMIT_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(LOSSMIT_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(LOSSMIT_TOOLS)),
  },
  grader: {
    rule_set_version: "fnma.workout.retention.v1 (servicing §12.2, §12.4, §12.5, §12.6)",
    port_version: "apps/servicing@293261b3 src/domain/lossmit/{evaluation,plans,deferral}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
