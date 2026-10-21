/**
 * The qualifying-income environment, assembled: Fannie Mae B3-3 qualifying
 * income as the servicing app's origination engine computes it (its spec
 * §22.3) as the rulebook, refi's date and arithmetic tools, one purchase
 * application's borrowers and income as the task, and the engine's own
 * calculators, ported, as the grader. The origination side's second
 * environment family, beside Regulation Z's price tests.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeIncome, parseIncomeSubmission, type IncomeAnswer } from "./grader.js";
import { RULE_SET_VERSION } from "./ported/ops-22-3.js";
import { INCOME_RULEBOOK } from "./rulebook.js";
import {
  INCOME_ENVIRONMENT_NAME,
  INCOME_ENVIRONMENT_VERSION,
  renderIncomeTask,
  type IncomeTask,
} from "./task.js";
import { INCOME_SUBMIT_TOOL, INCOME_TOOLS, executeIncomeTool } from "./tools.js";

export const qualifyingIncome: Environment<IncomeTask, IncomeAnswer> = {
  name: INCOME_ENVIRONMENT_NAME,
  version: INCOME_ENVIRONMENT_VERSION,
  system: INCOME_RULEBOOK,
  tools: INCOME_TOOLS,
  submitTool: INCOME_SUBMIT_TOOL,
  render: renderIncomeTask,
  execute: executeIncomeTool,
  parseAnswer: parseIncomeSubmission,
  grade: gradeIncome,
};

export const INCOME_FINGERPRINT = {
  environment: {
    name: INCOME_ENVIRONMENT_NAME,
    version: INCOME_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(INCOME_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(INCOME_TOOLS)),
  },
  grader: {
    rule_set_version: `${RULE_SET_VERSION} (servicing §22.3, B3-3)`,
    port_version: "apps/servicing@293261b3 src/domain/verification/{ops-22-3,ops-22-1}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
