/**
 * The arm-adjustment environment, assembled: the servicing app's ARM
 * interest-rate and payment change (its spec §7.2, Regulation Z
 * §1026.20(c), and §7.3's §1026.20(d) initial notice on the first change) as
 * the rulebook, refi's payment, balance, date and arithmetic tools, a loan on
 * its change date with the index as published as the task, and the servicing
 * app's own two ARM engines, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeArm, parseArmSubmission, type ArmAnswer } from "./grader.js";
import { ARM_RULEBOOK } from "./rulebook.js";
import {
  ARM_ENVIRONMENT_NAME,
  ARM_ENVIRONMENT_VERSION,
  renderArmTask,
  type ArmTask,
} from "./task.js";
import { ARM_SUBMIT_TOOL, ARM_TOOLS, executeArmTool } from "./tools.js";

export const armAdjustment: Environment<ArmTask, ArmAnswer> = {
  name: ARM_ENVIRONMENT_NAME,
  version: ARM_ENVIRONMENT_VERSION,
  system: ARM_RULEBOOK,
  tools: ARM_TOOLS,
  submitTool: ARM_SUBMIT_TOOL,
  render: renderArmTask,
  execute: executeArmTool,
  parseAnswer: parseArmSubmission,
  grade: gradeArm,
};

export const ARM_FINGERPRINT = {
  environment: {
    name: ARM_ENVIRONMENT_NAME,
    version: ARM_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(ARM_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(ARM_TOOLS)),
  },
  grader: {
    rule_set_version:
      "regz.1026.20c.2013; fnma.svc.c2_1_02.2025-08 (servicing §7.2, §7.3 initial notice window)",
    port_version: "apps/servicing@293261b3 src/domain/notices/{arm,arm-verify}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
