/**
 * The ei-clocks environment, assembled: the servicing app's early-intervention
 * clocks (its spec §11.1 live contact, §11.2 written notice, §4.3's
 * assignment, §11.1's D2-2-02 cadence and Reg F call cap) as the rulebook,
 * refi's date step and day count plus the servicer's business-day roll as
 * the tools, one loan's delinquency picture on one day as the task, and the
 * servicing app's own windows engine, ported and folded as its spec's state
 * machines run it, with the rules outside it, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeEi, parseEiSubmission, type EiAnswer } from "./grader.js";
import { EI_RULEBOOK } from "./rulebook.js";
import { EI_ENVIRONMENT_NAME, EI_ENVIRONMENT_VERSION, renderEiTask, type EiTask } from "./task.js";
import { EI_SUBMIT_TOOL, EI_TOOLS, executeEiTool } from "./tools.js";

export const eiClocks: Environment<EiTask, EiAnswer> = {
  name: EI_ENVIRONMENT_NAME,
  version: EI_ENVIRONMENT_VERSION,
  system: EI_RULEBOOK,
  tools: EI_TOOLS,
  submitTool: EI_SUBMIT_TOOL,
  render: renderEiTask,
  execute: executeEiTool,
  parseAnswer: parseEiSubmission,
  grade: gradeEi,
};

export const EI_FINGERPRINT = {
  environment: {
    name: EI_ENVIRONMENT_NAME,
    version: EI_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(EI_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(EI_TOOLS)),
  },
  grader: {
    rule_set_version:
      "regx.1024.39-40 + fnma.d2-2-02 + regf.1006.14 (servicing §11.1, §11.2, §4.3)",
    port_version: "apps/servicing@293261b3 src/domain/early-intervention/windows.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
