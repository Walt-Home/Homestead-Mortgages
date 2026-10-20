/**
 * The refi-policy environment: refi-tape's tasks, tools and grader, with
 * the review stated as a policy instead of a procedure. The system prompt is
 * the only difference, so a score here against refi-tape's on the same
 * tasks measures what the procedure was doing for the model.
 */

import { PORT_VERSION, RULE_SET_VERSION } from "@hm/refi-review";
import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import type { RefiAnswer } from "../refi/grader.js";
import { SUBMIT_TOOL, executeTool } from "../refi/tools.js";
import { TAPE_TOOLS } from "../refi-tape/index.js";
import { gradeTapeAnswer, parseTapeSubmission } from "../refi-tape/grader.js";
import { renderTapeTask, type RefiTapeTask } from "../refi-tape/task.js";
import { POLICY } from "./policy.js";

export const POLICY_ENVIRONMENT_NAME = "refi-policy";
/**
 * Bump on any change to the policy, or to anything refi-tape's version covers.
 *
 * 1.2.0 (20 Oct 2026): the PMI sentence is two. In 1.0.0 and 1.1.0 it ended
 * "…divided by 100 to three decimals, whenever it is above 5; otherwise the
 * premium is 0", and both models read the "otherwise" as belonging to the
 * rate of 5: on a loan with PMI at 0.25 % both took the premium as 0 and
 * missed the same NPV. 1.1.0 had renamed the premium apart from the quote's
 * field, which was a guess at the cause and did not fix it.
 */
export const POLICY_ENVIRONMENT_VERSION = "1.2.0";

/** refi-tape's task, with "the rulebook" read as "the policy". */
export const renderPolicyTask = (task: RefiTapeTask): string =>
  renderTapeTask(task).replace(
    "Read the loan off the record and the tape by the rulebook, review it,",
    "Apply the policy to the record and the tape,",
  );

export const refiPolicy: Environment<RefiTapeTask, RefiAnswer> = {
  name: POLICY_ENVIRONMENT_NAME,
  version: POLICY_ENVIRONMENT_VERSION,
  system: POLICY,
  tools: TAPE_TOOLS,
  submitTool: SUBMIT_TOOL,
  render: renderPolicyTask,
  execute: executeTool,
  parseAnswer: parseTapeSubmission,
  grade: gradeTapeAnswer,
};

export const POLICY_FINGERPRINT = {
  environment: {
    name: POLICY_ENVIRONMENT_NAME,
    version: POLICY_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(POLICY),
    tools_sha256: sha256(JSON.stringify(TAPE_TOOLS)),
  },
  grader: { rule_set_version: RULE_SET_VERSION, port_version: PORT_VERSION },
} as const;

export { POLICY } from "./policy.js";
