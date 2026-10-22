/**
 * The regz-policy environment: regz-price-tests's tasks, tools and grader,
 * with the tests stated as a policy instead of a procedure. The system
 * prompt and one sentence of the task are the only differences, so a score
 * here against regz-price-tests's on the same tasks measures what the
 * procedure was doing for the model.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import type { RegzAnswer } from "./grader.js";
import { regzPriceTests, REGZ_FINGERPRINT } from "./index.js";
import { REGZ_POLICY } from "./policy.js";
import { renderRegzTask, type RegzTask } from "./task.js";

export const REGZ_POLICY_ENVIRONMENT_NAME = "regz-policy";
/**
 * Bump on any change to the policy, or to anything regz-price-tests's version covers.
 *
 * 1.1.0 (21 Oct 2026): with regz-price-tests 1.1.0.
 */
export const REGZ_POLICY_ENVIRONMENT_VERSION = "1.2.0";

/** regz-price-tests's task, with "the rulebook" read as "the policy". */
export const renderRegzPolicyTask = (task: RegzTask): string =>
  renderRegzTask(task).replace(
    "Follow the rulebook, use the tools for every figure,",
    "Apply the policy, use the tools for every figure,",
  );

export const regzPolicy: Environment<RegzTask, RegzAnswer> = {
  ...regzPriceTests,
  name: REGZ_POLICY_ENVIRONMENT_NAME,
  version: REGZ_POLICY_ENVIRONMENT_VERSION,
  system: REGZ_POLICY,
  render: renderRegzPolicyTask,
};

export const REGZ_POLICY_FINGERPRINT = {
  environment: {
    ...REGZ_FINGERPRINT.environment,
    name: REGZ_POLICY_ENVIRONMENT_NAME,
    version: REGZ_POLICY_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(REGZ_POLICY),
  },
  grader: REGZ_FINGERPRINT.grader,
} as const;

export { REGZ_POLICY } from "./policy.js";
