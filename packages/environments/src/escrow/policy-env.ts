/**
 * The escrow-policy environment: escrow-analysis's tasks, tools and grader,
 * with the analysis stated as a policy instead of a procedure. The system
 * prompt and one sentence of the task are the only differences, so a score
 * here against escrow-analysis's on the same tasks measures what the
 * procedure was doing for the model.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import type { EscrowAnswer } from "./grader.js";
import { escrowAnalysis, ESCROW_FINGERPRINT } from "./index.js";
import { ESCROW_POLICY } from "./policy.js";
import { renderEscrowTask, type EscrowTask } from "./task.js";

export const ESCROW_POLICY_ENVIRONMENT_NAME = "escrow-policy";
/** Bump on any change to the policy, or to anything escrow-analysis's version covers. */
export const ESCROW_POLICY_ENVIRONMENT_VERSION = "1.0.0";

/** escrow-analysis's task, with "the rulebook" read as "the policy". */
export const renderEscrowPolicyTask = (task: EscrowTask): string =>
  renderEscrowTask(task).replace(
    "Follow the rulebook, use the tools for every figure and date,",
    "Apply the policy, use the tools for every figure and date,",
  );

export const escrowPolicy: Environment<EscrowTask, EscrowAnswer> = {
  ...escrowAnalysis,
  name: ESCROW_POLICY_ENVIRONMENT_NAME,
  version: ESCROW_POLICY_ENVIRONMENT_VERSION,
  system: ESCROW_POLICY,
  render: renderEscrowPolicyTask,
};

export const ESCROW_POLICY_FINGERPRINT = {
  environment: {
    ...ESCROW_FINGERPRINT.environment,
    name: ESCROW_POLICY_ENVIRONMENT_NAME,
    version: ESCROW_POLICY_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(ESCROW_POLICY),
  },
  grader: ESCROW_FINGERPRINT.grader,
} as const;

export { ESCROW_POLICY } from "./policy.js";
