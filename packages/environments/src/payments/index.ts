/**
 * The payments-posting environment, assembled: the servicing app's
 * cashiering (its spec §2.1, §2.2, §2.4, §2.7) as the rulebook, refi's date
 * and arithmetic tools plus the servicer's business-day calendar, a loan and
 * its month of receipts as the task, and the servicing app's own allocation
 * and late-charge engine, ported, as the grader.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { gradePayments, parsePaymentsSubmission, type PaymentsAnswer } from "./grader.js";
import { PAYMENTS_RULEBOOK } from "./rulebook.js";
import {
  PAYMENTS_ENVIRONMENT_NAME,
  PAYMENTS_ENVIRONMENT_VERSION,
  renderPaymentsTask,
  type PaymentsTask,
} from "./task.js";
import { PAYMENTS_SUBMIT_TOOL, PAYMENTS_TOOLS, executePaymentsTool } from "./tools.js";

export const paymentsPosting: Environment<PaymentsTask, PaymentsAnswer> = {
  name: PAYMENTS_ENVIRONMENT_NAME,
  version: PAYMENTS_ENVIRONMENT_VERSION,
  system: PAYMENTS_RULEBOOK,
  tools: PAYMENTS_TOOLS,
  submitTool: PAYMENTS_SUBMIT_TOOL,
  render: renderPaymentsTask,
  execute: executePaymentsTool,
  parseAnswer: parsePaymentsSubmission,
  grade: gradePayments,
};

export const PAYMENTS_FINGERPRINT = {
  environment: {
    name: PAYMENTS_ENVIRONMENT_NAME,
    version: PAYMENTS_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(PAYMENTS_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(PAYMENTS_TOOLS)),
  },
  grader: {
    rule_set_version: "cashiering.allocation.v1 (servicing §2.1, §2.2, §2.4, §2.7)",
    port_version:
      "apps/servicing@293261b3 src/domain/cashiering/{types,biweekly,allocation,latecharges}.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./task.js";
export * from "./tools.js";
