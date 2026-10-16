/**
 * The refi-review environment, assembled: the rulebook as the system
 * prompt, the tools, the rendered task, and the engine as the grader.
 */

import { PORT_VERSION, RULE_SET_VERSION } from "@hm/refi-review";
import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeAnswer, parseSubmission, type RefiAnswer } from "./grader.js";
import { RULEBOOK } from "./rulebook.js";
import { ENVIRONMENT_NAME, ENVIRONMENT_VERSION, renderTask, type RefiTask } from "./task.js";
import { SUBMIT_TOOL, TOOLS, executeTool } from "./tools.js";

export const refiReview: Environment<RefiTask, RefiAnswer> = {
  name: ENVIRONMENT_NAME,
  version: ENVIRONMENT_VERSION,
  system: RULEBOOK,
  tools: TOOLS,
  submitTool: SUBMIT_TOOL,
  render: renderTask,
  execute: executeTool,
  parseAnswer: parseSubmission,
  grade: gradeAnswer,
};

/** What a run record says the environment and the grader were. */
export const REFI_FINGERPRINT = {
  environment: {
    name: ENVIRONMENT_NAME,
    version: ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(RULEBOOK),
    tools_sha256: sha256(JSON.stringify(TOOLS)),
  },
  grader: { rule_set_version: RULE_SET_VERSION, port_version: PORT_VERSION },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
