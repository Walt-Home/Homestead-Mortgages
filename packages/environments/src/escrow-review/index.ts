/**
 * The escrow-review environment, assembled: an annual escrow analysis drawn
 * from a ten-year history the life generator wrote, half of them after a
 * reassessment or a premium increase, reviewed before approval.
 * escrow-analysis's rulebook through Step 9 with the servicing app's
 * anomaly triggers and the flag after it, escrow-analysis's tools, and the
 * servicing app's own escrow engine, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { LIFE_VERSION } from "../life/generate.js";
import { sha256 } from "../record.js";
import { ESCROW_FINGERPRINT } from "../escrow/index.js";
import { gradeReview, parseReviewSubmission, type EscrowReviewAnswer } from "./grader.js";
import { REVIEW_RULEBOOK } from "./rulebook.js";
import {
  REVIEW_ENVIRONMENT_NAME,
  REVIEW_ENVIRONMENT_VERSION,
  renderReviewTask,
  type EscrowReviewTask,
} from "./task.js";
import { REVIEW_SUBMIT_TOOL, REVIEW_TOOLS, executeReviewTool } from "./tools.js";

export const escrowReview: Environment<EscrowReviewTask, EscrowReviewAnswer> = {
  name: REVIEW_ENVIRONMENT_NAME,
  version: REVIEW_ENVIRONMENT_VERSION,
  system: REVIEW_RULEBOOK,
  tools: REVIEW_TOOLS,
  submitTool: REVIEW_SUBMIT_TOOL,
  render: renderReviewTask,
  execute: executeReviewTool,
  parseAnswer: parseReviewSubmission,
  grade: gradeReview,
};

export const REVIEW_FINGERPRINT = {
  environment: {
    name: REVIEW_ENVIRONMENT_NAME,
    version: REVIEW_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(REVIEW_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(REVIEW_TOOLS)),
  },
  grader: {
    rule_set_version: `${ESCROW_FINGERPRINT.grader.rule_set_version}; R10 with compareBillToPriorYear`,
    port_version: `${ESCROW_FINGERPRINT.grader.port_version}; life ${LIFE_VERSION}`,
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
