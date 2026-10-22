/**
 * The aus-decision environment, assembled: the shadow AUS's decision
 * (`underwrite` in `@hm/underwriting`) written out as the rulebook;
 * regz-price-tests' date and Appendix J tools, an APOR lookup over a frozen
 * table, and refi's payment, month and arithmetic tools; a loan file as the
 * task; and the engine itself, on the production path, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { FROZEN_APOR_TABLE } from "./apor-frozen.js";
import { gradeAus, parseAusSubmission, type AusAnswer } from "./grader.js";
import { AUS_RULEBOOK } from "./rulebook.js";
import {
  AUS_ENVIRONMENT_NAME,
  AUS_ENVIRONMENT_VERSION,
  renderAusTask,
  type AusTask,
} from "./task.js";
import { AUS_SUBMIT_TOOL, AUS_TOOLS, executeAusTool } from "./tools.js";

export const ausDecision: Environment<AusTask, AusAnswer> = {
  name: AUS_ENVIRONMENT_NAME,
  version: AUS_ENVIRONMENT_VERSION,
  system: AUS_RULEBOOK,
  tools: AUS_TOOLS,
  submitTool: AUS_SUBMIT_TOOL,
  render: renderAusTask,
  execute: executeAusTool,
  parseAnswer: parseAusSubmission,
  grade: gradeAus,
};

/** The frozen APOR table the grader and the `apor` tool read, by its hash. */
export const FROZEN_APOR_SHA256 = sha256(JSON.stringify(FROZEN_APOR_TABLE));

export const AUS_FINGERPRINT = {
  environment: {
    name: AUS_ENVIRONMENT_NAME,
    version: AUS_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(AUS_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(AUS_TOOLS)),
  },
  grader: {
    rule_set_version: `shadow AUS on the production path; fee schedule hm-2026-01; Regulation Z 2026 thresholds (FR 2025-22773); FFIEC APOR frozen at sha256 ${FROZEN_APOR_SHA256}`,
    port_version: "@hm/underwriting underwrite (imported, not ported)",
  },
} as const;

export * from "./apor-frozen.js";
export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
