/**
 * The tape-intake environment, assembled: a reviewer's checks of a partner's
 * monthly tape before the desk loads it as the rulebook, the two tapes'
 * rows, a comparison of them, the reader's date parsing and the layout as the
 * tools, one month of a stream the life generator wrote as the task, and the
 * delivery's labels as the grader, read the way the servicing app's own test
 * reads its sample's designed outcomes.
 */

import type { Environment } from "../episode.js";
import { LIFE_VERSION } from "../life/generate.js";
import { TAPE_VERSION } from "../life/tape.js";
import { sha256 } from "../record.js";
import { gradeIntakeAgainst, parseIntakeSubmission, type IntakeAnswer } from "./grader.js";
import { INTAKE_RULEBOOK } from "./rulebook.js";
import {
  INTAKE_ENVIRONMENT_NAME,
  INTAKE_ENVIRONMENT_VERSION,
  renderIntakeTask,
  type TapeIntakeTask,
} from "./task.js";
import { INTAKE_SUBMIT_TOOL, INTAKE_TOOLS, executeIntakeTool } from "./tools.js";

export const tapeIntake: Environment<TapeIntakeTask, IntakeAnswer> = {
  name: INTAKE_ENVIRONMENT_NAME,
  version: INTAKE_ENVIRONMENT_VERSION,
  system: INTAKE_RULEBOOK,
  tools: INTAKE_TOOLS,
  submitTool: INTAKE_SUBMIT_TOOL,
  render: renderIntakeTask,
  execute: executeIntakeTool,
  parseAnswer: parseIntakeSubmission,
  grade: (task, answer) => gradeIntakeAgainst(task.expected, answer),
  // Decided 26 October 2026: DeepSeek's held-out run passed 106 of 200 at
  // 16,000 tokens and 175 at 32,000, nearly every answer it submitted
  // passing; at 16,000 it mostly spent the budget before it answered.
  outputBudget: 32000,
};

export const INTAKE_FINGERPRINT = {
  environment: {
    name: INTAKE_ENVIRONMENT_NAME,
    version: INTAKE_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(INTAKE_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(INTAKE_TOOLS)),
  },
  grader: {
    rule_set_version:
      "the delivery's label manifest (T-01 to T-05; V-01, V-02, D-25) + partner-book m3-v1",
    port_version: `packages/partner-book src/m3-v1.ts + life generator ${LIFE_VERSION}, tape writer ${TAPE_VERSION}`,
  },
} as const;

export * from "./desk.js";
export * from "./generator.js";
export * from "./grader.js";
export * from "./layout.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
