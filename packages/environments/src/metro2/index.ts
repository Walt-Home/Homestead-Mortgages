/**
 * The metro2-furnishing environment, assembled: the servicing app's monthly
 * Metro 2 credit reporting (its spec §8.1) as the rulebook, refi's date
 * steps and exact calculator as the tools, a loan's ledger, books and last
 * record as the task, and the servicing app's own furnishing engine, ported,
 * as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeMetro2, parseMetro2Submission, type Metro2Answer } from "./grader.js";
import { METRO2_RULEBOOK } from "./rulebook.js";
import {
  METRO2_ENVIRONMENT_NAME,
  METRO2_ENVIRONMENT_VERSION,
  renderMetro2Task,
  type Metro2Task,
} from "./task.js";
import { METRO2_SUBMIT_TOOL, METRO2_TOOLS, executeMetro2Tool } from "./tools.js";

export const metro2Furnishing: Environment<Metro2Task, Metro2Answer> = {
  name: METRO2_ENVIRONMENT_NAME,
  version: METRO2_ENVIRONMENT_VERSION,
  system: METRO2_RULEBOOK,
  tools: METRO2_TOOLS,
  submitTool: METRO2_SUBMIT_TOOL,
  render: renderMetro2Task,
  execute: executeMetro2Tool,
  parseAnswer: parseMetro2Submission,
  grade: gradeMetro2,
};

export const METRO2_FINGERPRINT = {
  environment: {
    name: METRO2_ENVIRONMENT_NAME,
    version: METRO2_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(METRO2_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(METRO2_TOOLS)),
  },
  grader: {
    rule_set_version: "crrg.metro2.base (servicing §8.1)",
    port_version:
      "apps/servicing@293261b3 src/domain/credit-reporting/{metro2,types}.ts, boarding/delinquency.ts (pmi's port)",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
