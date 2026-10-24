/**
 * A contact-audit task: one loan's contact history over a window, as a
 * servicer's quality-control desk audits it for staff errors.
 *
 * The model gets the loan and the window, and the contact log for the window
 * in the task itself: every call, phone-menu session, portal login, text,
 * e-mail, letter and dialer attempt, each with its disposition, the promise
 * it recorded and whether a complaint was logged. The rest it reads with the
 * tools: the comment log, each call's transcript as the recognizer wrote it,
 * the promise log, the complaint log and the payments. It reports each staff
 * error it finds at its root, with the symptoms the error caused.
 *
 * What the task was drawn from and what it holds are kept beside it and never
 * rendered: the labels the grader reads (each root and each symptom a rule
 * names), the plan and arm, and how to rebuild the book.
 */

import type { Scenario } from "../life/scenario.js";
import type { ProfilePins, StaffErrorId, StaffLabel, StaffSymptom } from "../contacts/index.js";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const CONTACT_AUDIT_ENVIRONMENT_NAME = "contact-audit";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const CONTACT_AUDIT_ENVIRONMENT_VERSION = "1.0.0";

/** A row of the contact log, as the audit desk reads it. */
export interface AuditContact {
  readonly id: string;
  readonly on: string;
  /** The time at the property, HH:MM. */
  readonly at: string;
  readonly direction: "inbound" | "outbound";
  readonly mode: string;
  /** Who it was with (or, for an attempt, who was asked for). */
  readonly with: string;
  readonly outcome: string;
  readonly purpose: string;
  readonly reason: string | null;
  readonly resolution: string;
  /** The matter the contact belongs to: a delinquency, an analysis, a reason in a month. */
  readonly issue: string;
  /** The agent who handled it, or null for one nobody handled. */
  readonly agent: string | null;
  readonly duration_s: number;
  /** The promise the call recorded, or null. */
  readonly promise_id: string | null;
  readonly complaint_logged: boolean;
  /** Whether the call was recorded: read_transcript reads it. */
  readonly transcript: boolean;
}

/** A line of the comment log. */
export interface AuditNote {
  readonly id: string;
  readonly on: string;
  readonly at: string;
  /** "SYSTEM", "DIALER", "BATCH", "IVR", "WEB", or the agent's user id. */
  readonly user: string;
  readonly area: string;
  readonly text: string;
  /** The contact it belongs to, or null for the history's own events. */
  readonly contact: string | null;
}

/** A transcript line as the recorder exports it. */
export interface AuditLine {
  readonly line: number;
  readonly at: string;
  /** "Agent", "Customer", "IVR" on a stereo recording; "Speaker 1", "Speaker 2" on a mono one; "" for markup. */
  readonly speaker: string;
  readonly text: string;
}

/** A row of the promise log, as it stood at the end of the window. */
export interface AuditPromise {
  readonly id: string;
  readonly contact: string;
  readonly made_on: string;
  readonly pay_by: string;
  readonly amount: string;
  /** "kept" or "broken" once its pay-by date has passed inside the window; "pending" before. */
  readonly status: "kept" | "broken" | "pending";
}

/** A case in the complaint log, as it stood at the end of the window. */
export interface AuditComplaint {
  readonly id: string;
  readonly contact: string;
  readonly received_on: string;
  readonly channel: string;
  readonly category: string;
  readonly acknowledged_on: string;
  readonly respond_by: string;
  /** The day the written response was mailed, or null while none has been by the end of the window. */
  readonly responded_on: string | null;
  readonly response: string | null;
}

/** A payment received. */
export interface AuditPayment {
  readonly id: string;
  readonly on: string;
  readonly amount: string;
  /** The installments it paid, by due date. */
  readonly applied_to: readonly string[];
  readonly to_suspense: string;
}

/** How to rebuild the task's book: its seed and scenario, the contact center's pins, and the roots planted. */
export interface AuditSource {
  readonly seed: string;
  readonly scenario: Scenario;
  readonly pins: ProfilePins;
  readonly roots: Readonly<Partial<Record<StaffErrorId, string>>>;
}

export type AuditPlan = "clean" | "S-01" | "S-02" | "S-01+S-02";

export interface ContactAuditTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly loan: {
    readonly number: string;
    readonly borrowers: readonly string[];
    readonly state: string;
    readonly servicer: string;
  };
  readonly window: { readonly from: string; readonly to: string };
  readonly contacts: readonly AuditContact[];
  /** Read by the tools, never rendered whole. */
  readonly notes: readonly AuditNote[];
  readonly transcripts: Readonly<Record<string, readonly AuditLine[]>>;
  readonly promises: readonly AuditPromise[];
  readonly complaints: readonly AuditComplaint[];
  readonly payments: readonly AuditPayment[];
  /** Never rendered: the roots and the symptoms a rule names, which the grader reads. */
  readonly labels: readonly StaffLabel[];
  /** Never rendered: what was planted, and the arm. */
  readonly plan: { readonly plan: AuditPlan; readonly arm: number };
  /** Never rendered: the book the task was read from; null for a spec case. */
  readonly source: AuditSource | null;
}

export type { StaffSymptom };

export function contactAuditPayload(task: ContactAuditTask): Record<string, unknown> {
  return plain({
    loan: task.loan,
    window: task.window,
    contacts: task.contacts,
  }) as Record<string, unknown>;
}

/** The payload as JSON, each contact on a line of its own. */
export function contactAuditJson(task: ContactAuditTask): string {
  const p = contactAuditPayload(task);
  const mark = "__CONTACTS__";
  const rows = (p["contacts"] as unknown[]).map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  return JSON.stringify({ ...p, contacts: mark }, null, 2).replace(
    `"${mark}"`,
    rows ? `[\n${rows}\n  ]` : "[]",
  );
}

export function renderContactAuditTask(task: ContactAuditTask): string {
  return [
    `Audit loan ${task.loan.number}'s contact history from ${task.window.from} through ${task.window.to} for staff errors.`,
    "",
    PAYLOAD_START,
    contactAuditJson(task),
    "```",
    "",
    "Follow the rulebook, read the logs and transcripts with the tools, and finish by calling submit_audit.",
  ].join("\n");
}
