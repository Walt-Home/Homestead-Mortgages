/**
 * The contact-audit environment, assembled: one loan's contact history over a
 * window as the task, the audit desk's two staff-error rules as the rulebook,
 * the comment log, the transcripts, the promise and complaint logs, the
 * payments and the calculator as the tools, and the twin's labels as the
 * grader, read the way boarding-triage reads a package's manifest: a root
 * apart from its symptoms, with the symptoms required beside it and a root no
 * label names failing the window.
 */

import { CONTACTS_VERSION } from "../contacts/center.js";
import type { Environment } from "../episode.js";
import { LIFE_VERSION } from "../life/generate.js";
import { sha256 } from "../record.js";
import {
  gradeContactAudit,
  parseContactAuditSubmission,
  type ContactAuditAnswer,
} from "./grader.js";
import { CONTACT_AUDIT_RULEBOOK } from "./rulebook.js";
import {
  CONTACT_AUDIT_ENVIRONMENT_NAME,
  CONTACT_AUDIT_ENVIRONMENT_VERSION,
  renderContactAuditTask,
  type ContactAuditTask,
} from "./task.js";
import {
  CONTACT_AUDIT_SUBMIT_TOOL,
  CONTACT_AUDIT_TOOLS,
  executeContactAuditTool,
} from "./tools.js";

export const contactAudit: Environment<ContactAuditTask, ContactAuditAnswer> = {
  name: CONTACT_AUDIT_ENVIRONMENT_NAME,
  version: CONTACT_AUDIT_ENVIRONMENT_VERSION,
  system: CONTACT_AUDIT_RULEBOOK,
  tools: CONTACT_AUDIT_TOOLS,
  submitTool: CONTACT_AUDIT_SUBMIT_TOOL,
  render: renderContactAuditTask,
  execute: executeContactAuditTool,
  parseAnswer: parseContactAuditSubmission,
  grade: gradeContactAudit,
  // Decided 26 October 2026: DeepSeek's held-out run passed 160 of 200 at
  // 16,000 tokens, 160 of the 162 answers it submitted passing; 37 of its 40
  // misses spent the budget before it answered.
  outputBudget: 32000,
};

export const CONTACT_AUDIT_FINGERPRINT = {
  environment: {
    name: CONTACT_AUDIT_ENVIRONMENT_NAME,
    version: CONTACT_AUDIT_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(CONTACT_AUDIT_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(CONTACT_AUDIT_TOOLS)),
  },
  grader: {
    rule_set_version: `the twin's labels, each root with its symptoms, a root no label names failing the window (S-01, S-02); servicing spec 4.5 SM_COMPLAINT_ACK_1BD, SM_COMPLAINT_RESOLVE_15; contacts ${CONTACTS_VERSION} over life ${LIFE_VERSION}`,
    port_version: "none: the contact center's own rules, src/contacts/staff.ts",
  },
} as const;

export * from "./generator.js";
export * from "./grader.js";
export * from "./materials.js";
export * from "./reference.js";
export * from "./rulebook.js";
export * from "./spec.js";
export * from "./task.js";
export * from "./tools.js";
