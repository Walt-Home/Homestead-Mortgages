/**
 * The payoff-statement environment, assembled: the servicing app's payoff
 * statement and payoff remittance (its spec §16.1, §7.6's 1026.36(c)(3)
 * clock, §16.2 and §5.2 rule 6) as the rulebook, refi's date and arithmetic
 * tools plus the business-day calendars, one loan's payoff from the request
 * to the funds as the task, and the servicing app's own payoff engine,
 * ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradePayoff, parsePayoffSubmission, type PayoffAnswer } from "./grader.js";
import { PAYOFF_RULEBOOK } from "./rulebook.js";
import {
  PAYOFF_ENVIRONMENT_NAME,
  PAYOFF_ENVIRONMENT_VERSION,
  renderPayoffTask,
  type PayoffTask,
} from "./task.js";
import { PAYOFF_SUBMIT_TOOL, PAYOFF_TOOLS, executePayoffTool } from "./tools.js";

export const payoffStatement: Environment<PayoffTask, PayoffAnswer> = {
  name: PAYOFF_ENVIRONMENT_NAME,
  version: PAYOFF_ENVIRONMENT_VERSION,
  system: PAYOFF_RULEBOOK,
  tools: PAYOFF_TOOLS,
  submitTool: PAYOFF_SUBMIT_TOOL,
  render: renderPayoffTask,
  execute: executePayoffTool,
  parseAnswer: parsePayoffSubmission,
  grade: gradePayoff,
};

export const PAYOFF_FINGERPRINT = {
  environment: {
    name: PAYOFF_ENVIRONMENT_NAME,
    version: PAYOFF_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(PAYOFF_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(PAYOFF_TOOLS)),
  },
  grader: {
    rule_set_version: "payoff.v1 (servicing §16.1, §7.6, §16.2, §5.2 rule 6)",
    port_version:
      "apps/servicing@293261b3 src/domain/payoff/{quote,remit}.ts, src/domain/investor/{remittance,types}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
