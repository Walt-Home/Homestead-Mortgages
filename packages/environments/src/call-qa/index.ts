/**
 * The call-qa environment, assembled: one recorded call from the contact
 * center as the task, the QA desk's form as the rulebook, a search of the
 * transcript, the record on another day and two clock readings as the tools,
 * and the call rubric (src/calls), which runs the servicing app's own
 * provenance and verbatim checks beside the collections spec's rules, as the
 * grader.
 */

import { CONTACTS_VERSION } from "../contacts/center.js";
import type { Environment } from "../episode.js";
import { LIFE_VERSION } from "../life/generate.js";
import { sha256 } from "../record.js";
import { gradeCallQa, parseCallQaSubmission, type CallQaAnswer } from "./grader.js";
import { CALL_QA_RULEBOOK } from "./rulebook.js";
import {
  CALL_QA_ENVIRONMENT_NAME,
  CALL_QA_ENVIRONMENT_VERSION,
  renderCallQaTask,
  type CallQaTask,
} from "./task.js";
import { CALL_QA_SUBMIT_TOOL, CALL_QA_TOOLS, executeCallQaTool } from "./tools.js";

export const callQa: Environment<CallQaTask, CallQaAnswer> = {
  name: CALL_QA_ENVIRONMENT_NAME,
  version: CALL_QA_ENVIRONMENT_VERSION,
  system: CALL_QA_RULEBOOK,
  tools: CALL_QA_TOOLS,
  submitTool: CALL_QA_SUBMIT_TOOL,
  render: renderCallQaTask,
  execute: executeCallQaTool,
  parseAnswer: (raw) => parseCallQaSubmission(raw),
  grade: gradeCallQa,
};

export const CALL_QA_FINGERPRINT = {
  environment: {
    name: CALL_QA_ENVIRONMENT_NAME,
    version: CALL_QA_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(CALL_QA_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(CALL_QA_TOOLS)),
  },
  grader: {
    rule_set_version: `servicing §11.1 decision record and guardrails + preDialChecks + eval checks (1) provenance, (2) verbatim; contacts ${CONTACTS_VERSION} over life ${LIFE_VERSION}`,
    port_version: "apps/servicing@293261b3 src/domain/borrower/eval/{checks,types}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./materials.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./spec.js";
export * from "./task.js";
export * from "./tools.js";
export * from "./view.js";
