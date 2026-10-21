/**
 * The flexmod-terms environment, assembled: the servicing app's Flex
 * Modification evaluation (Fannie Mae F-1-27; its spec §12.8) as the
 * rulebook, refi's payment, date and arithmetic tools plus the closed-form
 * principal, a delinquent loan as the task, and the servicing app's own
 * waterfall, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeFlex, parseFlexSubmission, type FlexAnswer } from "./grader.js";
import { FLEX_RULEBOOK } from "./rulebook.js";
import {
  FLEX_ENVIRONMENT_NAME,
  FLEX_ENVIRONMENT_VERSION,
  renderFlexTask,
  type FlexTask,
} from "./task.js";
import { FLEX_SUBMIT_TOOL, FLEX_TOOLS, executeFlexTool } from "./tools.js";

export const flexmodTerms: Environment<FlexTask, FlexAnswer> = {
  name: FLEX_ENVIRONMENT_NAME,
  version: FLEX_ENVIRONMENT_VERSION,
  system: FLEX_RULEBOOK,
  tools: FLEX_TOOLS,
  submitTool: FLEX_SUBMIT_TOOL,
  render: renderFlexTask,
  execute: executeFlexTool,
  parseAnswer: parseFlexSubmission,
  grade: gradeFlex,
};

export const FLEX_FINGERPRINT = {
  environment: {
    name: FLEX_ENVIRONMENT_NAME,
    version: FLEX_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(FLEX_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(FLEX_TOOLS)),
  },
  grader: {
    rule_set_version: "fnma.flexmod.2025-08 (servicing §12.8)",
    port_version: "apps/servicing@293261b3 src/domain/lossmit/flexmod.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
