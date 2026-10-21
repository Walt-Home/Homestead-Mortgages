/**
 * The regz-price-tests environment, assembled: Regulation Z's price tests
 * as the shadow AUS runs them, written out as the rulebook; the engine's own
 * lookups and solve as tools; a quoted loan as the task; and
 * `@hm/underwriting` itself as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradeRegz, parseRegzSubmission, type RegzAnswer } from "./grader.js";
import { REGZ_RULEBOOK } from "./rulebook.js";
import {
  REGZ_ENVIRONMENT_NAME,
  REGZ_ENVIRONMENT_VERSION,
  renderRegzTask,
  type RegzTask,
} from "./task.js";
import { REGZ_SUBMIT_TOOL, REGZ_TOOLS, executeRegzTool } from "./tools.js";

export const regzPriceTests: Environment<RegzTask, RegzAnswer> = {
  name: REGZ_ENVIRONMENT_NAME,
  version: REGZ_ENVIRONMENT_VERSION,
  system: REGZ_RULEBOOK,
  tools: REGZ_TOOLS,
  submitTool: REGZ_SUBMIT_TOOL,
  render: renderRegzTask,
  execute: executeRegzTool,
  parseAnswer: parseRegzSubmission,
  grade: gradeRegz,
};

/** What a run record says the environment and the grader were. */
export const REGZ_FINGERPRINT = {
  environment: {
    name: REGZ_ENVIRONMENT_NAME,
    version: REGZ_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(REGZ_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(REGZ_TOOLS)),
  },
  grader: {
    rule_set_version: "Regulation Z 2026 thresholds (FR 2025-22773), FFIEC APOR",
    port_version: "@hm/underwriting runComplianceTests",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
