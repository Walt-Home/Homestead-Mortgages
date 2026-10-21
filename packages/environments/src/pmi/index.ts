/**
 * The pmi-termination environment, assembled: the servicing app's mortgage
 * insurance administration under the Homeowners Protection Act (its spec
 * §10.1, §10.2, §10.3, §10.5) as the rulebook, refi's amortization, date and
 * arithmetic tools plus the servicer's business-day calendar, one loan's MI
 * on an evaluation date as the task, and the servicing app's own engine,
 * ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradePmi, parsePmiSubmission, type PmiAnswer } from "./grader.js";
import { PMI_RULEBOOK } from "./rulebook.js";
import {
  PMI_ENVIRONMENT_NAME,
  PMI_ENVIRONMENT_VERSION,
  renderPmiTask,
  type PmiTask,
} from "./task.js";
import { PMI_SUBMIT_TOOL, PMI_TOOLS, executePmiTool } from "./tools.js";

export const pmiTermination: Environment<PmiTask, PmiAnswer> = {
  name: PMI_ENVIRONMENT_NAME,
  version: PMI_ENVIRONMENT_VERSION,
  system: PMI_RULEBOOK,
  tools: PMI_TOOLS,
  submitTool: PMI_SUBMIT_TOOL,
  render: renderPmiTask,
  execute: executePmiTool,
  parseAnswer: parsePmiSubmission,
  grade: gradePmi,
};

export const PMI_FINGERPRINT = {
  environment: {
    name: PMI_ENVIRONMENT_NAME,
    version: PMI_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(PMI_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(PMI_TOOLS)),
  },
  grader: {
    rule_set_version: "hpa.1998 / fnma.mi.b8104.2019-05 (servicing §10.1, §10.2, §10.3, §10.5)",
    port_version:
      "apps/servicing@293261b3 src/domain/pmi/{schedule,termination,cancellation,refund}.ts, src/domain/boarding/{delinquency,types}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
