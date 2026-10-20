/**
 * The refi-hard environments: refi-tape's tasks placed on the rules' edges.
 *
 * Only the generator differs. `refiHard` is refi-tape's rulebook, tools and
 * grader over the hard tasks, so a score here beside refi-tape's measures
 * what the edges cost a model; `refiHardPolicy` is refi-policy's wording
 * over the same tasks, so the two effects can be told apart.
 */

import { PORT_VERSION, RULE_SET_VERSION } from "@hm/refi-review";
import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import type { RefiAnswer } from "../refi/grader.js";
import { POLICY, POLICY_ENVIRONMENT_VERSION, refiPolicy } from "../refi-policy/index.js";
import { TAPE_RULEBOOK, TAPE_TOOLS, refiTape } from "../refi-tape/index.js";
import type { RefiTapeTask } from "../refi-tape/task.js";
import { HARD_ENVIRONMENT_NAME, HARD_ENVIRONMENT_VERSION } from "./generator.js";

export const HARD_POLICY_ENVIRONMENT_NAME = "refi-hard-policy";
/** The generator's version, and the policy's after it, since either changes what is measured. */
export const HARD_POLICY_ENVIRONMENT_VERSION = `${HARD_ENVIRONMENT_VERSION}+policy.${POLICY_ENVIRONMENT_VERSION}`;

export const refiHard: Environment<RefiTapeTask, RefiAnswer> = {
  ...refiTape,
  name: HARD_ENVIRONMENT_NAME,
  version: HARD_ENVIRONMENT_VERSION,
};

export const refiHardPolicy: Environment<RefiTapeTask, RefiAnswer> = {
  ...refiPolicy,
  name: HARD_POLICY_ENVIRONMENT_NAME,
  version: HARD_POLICY_ENVIRONMENT_VERSION,
};

const grader = { rule_set_version: RULE_SET_VERSION, port_version: PORT_VERSION } as const;
const tools_sha256 = sha256(JSON.stringify(TAPE_TOOLS));

export const HARD_FINGERPRINT = {
  environment: {
    name: HARD_ENVIRONMENT_NAME,
    version: HARD_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(TAPE_RULEBOOK),
    tools_sha256,
  },
  grader,
} as const;

export const HARD_POLICY_FINGERPRINT = {
  environment: {
    name: HARD_POLICY_ENVIRONMENT_NAME,
    version: HARD_POLICY_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(POLICY),
    tools_sha256,
  },
  grader,
} as const;

export * from "./generator.js";
