/**
 * The boarding-triage environment, assembled: a reviewer's checks of a
 * servicing-transfer package beyond the servicing app's gate as the
 * rulebook, a file reader, the layout's code lists and the calculator as the
 * tools, one package the life generator wrote as the task, and its label
 * manifest as the grader, read the way the servicing app's own test reads the
 * sample batch's designed outcomes.
 */

import type { Environment } from "../episode.js";
import { LIFE_VERSION } from "../life/generate.js";
import { sha256 } from "../record.js";
import { gradeTriage, parseTriageSubmission, type TriageAnswer } from "./grader.js";
import { BOARDING_RULEBOOK } from "./rulebook.js";
import {
  BOARDING_ENVIRONMENT_NAME,
  BOARDING_ENVIRONMENT_VERSION,
  renderBoardingTask,
  type BoardingTask,
} from "./task.js";
import { BOARDING_SUBMIT_TOOL, BOARDING_TOOLS, executeBoardingTool } from "./tools.js";

export const boardingTriage: Environment<BoardingTask, TriageAnswer> = {
  name: BOARDING_ENVIRONMENT_NAME,
  version: BOARDING_ENVIRONMENT_VERSION,
  system: BOARDING_RULEBOOK,
  tools: BOARDING_TOOLS,
  submitTool: BOARDING_SUBMIT_TOOL,
  render: renderBoardingTask,
  execute: executeBoardingTool,
  parseAnswer: parseTriageSubmission,
  grade: gradeTriage,
  // Decided 26 October 2026: DeepSeek's held-out run passed 28 of 200 at
  // 16,000 tokens and 95 at 32,000, nearly every answer it submitted passing;
  // at 16,000 it mostly spent the budget before it answered.
  outputBudget: 32000,
};

export const BOARDING_FINGERPRINT = {
  environment: {
    name: BOARDING_ENVIRONMENT_NAME,
    version: BOARDING_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(BOARDING_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(BOARDING_TOOLS)),
  },
  grader: {
    rule_set_version:
      "boarding.dq.v1 + the package's label manifest, roots and symptoms (D-42, D-35, D-03, D-01, D-12, D-37, D-18, D-24, D-25, D-15)",
    port_version: `apps/servicing@293261b3 src/domain/boarding/{tape-codec,rules,min}.ts + life generator ${LIFE_VERSION}`,
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./layout.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
