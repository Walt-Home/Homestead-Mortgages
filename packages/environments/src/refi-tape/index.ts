/**
 * The refi-tape environment, assembled: Step 0 and the review's rules as the
 * system prompt, refi-review's tools with a fifth verdict, the record and
 * the tape as the task, and the tape reader then the review as the grader.
 */

import { PORT_VERSION, RULE_SET_VERSION } from "@hm/refi-review";
import type { Environment, ToolSpec } from "../episode.js";
import { sha256 } from "../record.js";
import type { RefiAnswer } from "../refi/grader.js";
import { SUBMIT_TOOL, TOOLS, executeTool } from "../refi/tools.js";
import { TAPE_VERDICTS, gradeTapeAnswer, parseTapeSubmission } from "./grader.js";
import { TAPE_RULEBOOK } from "./rulebook.js";
import {
  TAPE_ENVIRONMENT_NAME,
  TAPE_ENVIRONMENT_VERSION,
  renderTapeTask,
  type RefiTapeTask,
} from "./task.js";

/** refi-review's tools, with the submit tool's verdicts widened to the fifth. */
export const TAPE_TOOLS: readonly ToolSpec[] = TOOLS.map((t) => {
  if (t.name !== SUBMIT_TOOL) return t;
  const schema = t.input_schema as { properties: Record<string, unknown> };
  return {
    ...t,
    input_schema: {
      ...t.input_schema,
      properties: { ...schema.properties, verdict: { type: "string", enum: [...TAPE_VERDICTS] } },
    },
  };
});

export const refiTape: Environment<RefiTapeTask, RefiAnswer> = {
  name: TAPE_ENVIRONMENT_NAME,
  version: TAPE_ENVIRONMENT_VERSION,
  system: TAPE_RULEBOOK,
  tools: TAPE_TOOLS,
  submitTool: SUBMIT_TOOL,
  render: renderTapeTask,
  execute: executeTool,
  parseAnswer: parseTapeSubmission,
  grade: gradeTapeAnswer,
};

export const TAPE_FINGERPRINT = {
  environment: {
    name: TAPE_ENVIRONMENT_NAME,
    version: TAPE_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(TAPE_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(TAPE_TOOLS)),
  },
  grader: { rule_set_version: RULE_SET_VERSION, port_version: PORT_VERSION },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
