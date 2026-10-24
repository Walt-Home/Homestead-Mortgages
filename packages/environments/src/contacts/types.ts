/**
 * The contact center's records: contact rows shaped like the servicing app's
 * `contacts` table (apps/servicing/db/migrations/0005_servicing_requests.sql:201,
 * with `outcome`, `purpose`, the disclosures, the TCPA basis and the Reg F
 * count added at 0013_early_intervention.sql:53), the flat comment log a
 * partner sends (loan, date, user, area, text), the promises a call records,
 * and the call transcripts.
 *
 * A few fields are ours, and say so: the inquiry reason and resolution (the
 * rate card's "inbound contact resolved" is a field, not a guess), the issue
 * a contact belongs to and the earlier contacts on it, and whether a row
 * counts as an inquiry for the calibration's volume.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { Servicer } from "../life/simulate.js";

/** `contacts.mode`: the baseline's call, sms, email, letter and portal, and the phone menu, which it has no word for. */
export type ContactMode = "call" | "ivr" | "portal" | "email" | "sms" | "letter";

/**
 * `contacts.outcome`. The calls' and the written channels' words are the
 * spec's 11.1 list (11-1-live-contact.md, "Data model"): "wrong party" is
 * `wrong_number` (someone answered who is not the borrower) and "bad number"
 * is `disconnected`. The last four are ours, for the channels the list has
 * no word for.
 */
export type ContactOutcome =
  | "no_answer"
  | "busy_or_failed"
  | "voicemail_left"
  | "no_voicemail"
  | "wrong_number"
  | "disconnected"
  | "answered_unverified"
  | "conversation"
  | "refused"
  | "sms_sent"
  | "email_sent"
  | "mail_sent"
  | "ivr_self_served"
  | "ivr_abandoned"
  | "portal_session"
  | "received";

/** Who the contact was with (or, for an attempt, who was asked for). */
export type PartyRole =
  | "borrower"
  | "co_borrower"
  | "spouse_not_on_note"
  | "attorney"
  | "housing_counselor"
  | "unknown_caller"
  | "wrong_party"
  | "insurance_agent";

/** `contacts.purpose`: why the servicer made the contact, or what the borrower's contact was for. */
export type ContactPurpose =
  | "borrower_inquiry"
  | "collection"
  | "payment_reminder"
  | "ei_written_notice"
  | "lossmit_package"
  | "welcome"
  | "promise_to_pay"
  | "bankruptcy_notice"
  | "third_party_authorization"
  | "insurance_document"
  | "hardship_letter"
  | "qualified_written_request"
  | "qwr_acknowledgment"
  | "consent_revocation"
  | "self_service";

/** Why a borrower got in touch (ours). */
export const INQUIRY_REASONS = [
  "payment_received",
  "make_payment",
  "payment_change",
  "rate_change",
  "payment_arrangement",
  "hardship",
  "escrow_analysis",
  "insurance",
  "tax",
  "form_1098",
  "online_access",
  "autopay_setup",
  "statement_copy",
  "account_update",
  "late_fee",
  "payoff_request",
  "lien_release",
  "servicing_transfer",
  "disaster_assistance",
  "mi_cancellation",
  "credit_reporting",
  "bankruptcy",
] as const;
export type InquiryReason = (typeof INQUIRY_REASONS)[number];

/** What came of the contact (ours: the rate card's "inbound contact resolved" is this field). */
export type Resolution =
  | "resolved"
  | "information_provided"
  | "promise_recorded"
  | "referred_lossmit"
  | "transferred"
  | "escalated"
  | "callback_scheduled"
  | "pending_documents"
  | "unresolved"
  | "self_served"
  | "acknowledged"
  | "sent"
  | "no_contact";

export interface ContactRecord {
  /** `contacts.id`: the loan's id and the contact's place in its log. */
  readonly id: string;
  readonly loan_id: string;
  readonly servicer: Servicer;
  /** `attempted_at`, as the day and the local time at the property. */
  readonly on: PlainDate;
  readonly at: string;
  readonly direction: "inbound" | "outbound";
  readonly mode: ContactMode;
  /** Who it was with, or for an attempt, whom it asked for. */
  readonly party: PartyRole;
  readonly party_name: string | null;
  /** `phone_number_id`: which of the profile's numbers was dialed or called from. */
  readonly phone_number_id: string | null;
  readonly outcome: ContactOutcome;
  readonly live_contact: boolean;
  readonly live_contact_basis: "human_voice" | "borrower_initiated" | "authorized_agent" | null;
  readonly qrpc: boolean;
  /** Whether the person passed the identity checks; null when nobody spoke. */
  readonly identity_verified: boolean | null;
  readonly purpose: ContactPurpose;
  readonly reason: InquiryReason | null;
  readonly resolution: Resolution;
  /** The issue the contact belongs to: a delinquency, an analysis, a transfer, a reason in a month. */
  readonly issue: string;
  /** Earlier contacts on the same issue, oldest first. */
  readonly related: readonly string[];
  readonly language: "en" | "es";
  readonly interpreter: boolean;
  /** `duration_s`: from the agent's answer (or the first ring, or the menu's first prompt) to the hang-up. */
  readonly duration_s: number;
  /** The handle time: the duration and the after-call work, for a call an agent handled. */
  readonly handle_s: number;
  readonly human_agent: string | null;
  readonly tcpa_basis: "consent" | "human_manual_dial" | "n/a";
  /** The text or voice consent the contact relied on was on file that day. */
  readonly tcpa_consent: boolean;
  /** `regf_counted`: an outbound voice call that connected (§1006.14(b); section11.ts:328). */
  readonly regf_counted: boolean;
  /** What the agent marked as given: `recording_disclosure_at`, `fdcpa_disclosure_at`, and the bankruptcy disclaimer. */
  readonly disclosures_marked: {
    readonly recording: boolean;
    readonly fdcpa: boolean;
    readonly bankruptcy: boolean;
  };
  readonly complaint_voiced: boolean;
  readonly complaint_logged: boolean;
  /** Ours: an inbound call, phone-menu session, e-mail, text or letter that asks something (the calibration's volume). */
  readonly counts_as_inquiry: boolean;
  /** `transcript_document_id`: a call with a voice on it has one. */
  readonly transcript: boolean;
  readonly promise_id: string | null;
}

/** One line of the comment log. */
export interface NoteRecord {
  readonly id: string;
  readonly loan_id: string;
  readonly servicer: Servicer;
  readonly on: PlainDate;
  readonly at: string;
  /** "SYSTEM", "DIALER", "IVR", "WEB", or the agent's user id. */
  readonly user: string;
  readonly kind: "system" | "agent";
  readonly area: NoteArea;
  readonly text: string;
  readonly contact_id: string | null;
  /** The note this one copied forward, whose numbers are of its own day. */
  readonly copied_from: string | null;
}

export type NoteArea =
  | "CS"
  | "COLL"
  | "ESC"
  | "INS"
  | "TAX"
  | "LM"
  | "BK"
  | "PIF"
  | "TRF"
  | "CMPL"
  | "WEB"
  | "IVR"
  | "LTR"
  | "PMT"
  | "ARM"
  | "MI";

/** A promise to pay a call recorded: the one figure a borrower brings to a call, written to the record by the call. */
export interface PromiseRecord {
  readonly id: string;
  readonly contact_id: string;
  readonly made_on: PlainDate;
  readonly pay_by: PlainDate;
  readonly amount: Cents;
  readonly status: "kept" | "broken";
  /** The receipt that kept it. */
  readonly receipt_id: string | null;
  /** Scripted by the scenario (the life generator's promise), or drawn here from the receipts that followed. */
  readonly scripted: boolean;
}

/**
 * A bankruptcy the contact center learned of: the petition a scenario dates (`LoanLife.bankruptcy`), which the history
 * keeps open to its end, or, on a loan whose history has none, one the contact center draws (derive.ts).
 */
export interface BankruptcyCase {
  readonly chapter: 7 | 13;
  readonly petition_on: PlainDate;
  /** The day the attorney's notice reached the servicer. */
  readonly noticed_on: PlainDate;
  readonly discharged_on: PlainDate | null;
  readonly attorney: string;
  readonly firm: string;
  /** The case number's last four digits. */
  readonly case_last4: string;
  /**
   * The last day the servicer whose books the loan is on knows of the case: absent while every servicer does, and the
   * day before the transfer on a boarding that left it off (D-37's twin), from which the servicer calls as if none
   * were open.
   */
  readonly known_until?: PlainDate;
}

export interface PhoneOnFile {
  readonly id: string;
  readonly kind: "mobile" | "landline";
  readonly last4: string;
  /** A good number, one that no longer works, or one reassigned to somebody else. */
  readonly status: "good" | "disconnected" | "reassigned";
  /** TCPA consent to autodialed calls (a mobile number given to the creditor for the loan). */
  readonly tcpa_voice: boolean;
}

/** Who the borrower is to the contact center, drawn once per loan. */
export interface ContactProfile {
  readonly language: "en" | "es";
  readonly phones: readonly PhoneOnFile[];
  /** Consent to text messages, and the day a STOP revoked it. */
  readonly sms_consent: boolean;
  readonly email_on_file: boolean;
  readonly email: string | null;
  readonly paperless: boolean;
  readonly portal_user: boolean;
  /** A spouse not on the note, and whether the borrower has authorized the servicer to speak with them. */
  readonly spouse: { readonly name: string; readonly authorized: boolean } | null;
  /** The last four of each party's taxpayer number, in the order of the draw's parties. */
  readonly ssn_last4: readonly string[];
  readonly style: "brief" | "chatty" | "anxious" | "irritated";
  /** The servicer is a debt collector for the loan: it reached us 30 or more days delinquent. */
  readonly debt_collector: boolean;
}

/** Profile fields a test or a scenario may pin per loan. */
export interface ProfilePins {
  readonly language?: "en" | "es";
  readonly spouse?: { readonly name: string; readonly authorized: boolean } | null;
  readonly sms_consent?: boolean;
  readonly portal_user?: boolean;
  /** Draw a bankruptcy on the first delinquency that reaches day 30, whatever the rate. */
  readonly bankruptcy?: boolean;
}

/** The cadence's state over one delinquency, kept so a reader can hold the attempts to it. */
export interface CadenceEpisode {
  /** The first day delinquent, and the day a payment cured it (or null). */
  readonly start: PlainDate;
  readonly cured_on: PlainDate | null;
  /** The day the plan opened (day 17), or null when the delinquency ended first. */
  readonly opened_on: PlainDate | null;
  /** The last day attempts were due: the day before the cure, the loan's end or the petition. */
  readonly closed_on: PlainDate | null;
  /** Stretches when the cadence was ceased: a promise pending, or suspended by a bankruptcy. */
  readonly paused: readonly {
    readonly from: PlainDate;
    readonly to: PlainDate;
    readonly reason: "ptp_pending" | "bankruptcy";
  }[];
}

export interface LoanContacts {
  readonly loan_id: string;
  readonly index: number;
  readonly profile: ContactProfile;
  readonly contacts: readonly ContactRecord[];
  readonly notes: readonly NoteRecord[];
  readonly promises: readonly PromiseRecord[];
  readonly bankruptcy: BankruptcyCase | null;
  readonly cadence: readonly CadenceEpisode[];
}

/* ── transcripts ─────────────────────────────────────────────────────────── */

export type Speaker = "AGENT" | "AGENT_2" | "CALLER" | "IVR" | "INTERPRETER" | "SYSTEM";

/** One way the speech recognizer's text departs from what was said. */
export type NoiseOp =
  | { readonly kind: "misheard_number"; readonly said: string; readonly heard: string }
  | { readonly kind: "misheard_word"; readonly said: string; readonly heard: string }
  | { readonly kind: "dropped_word"; readonly said: string }
  | { readonly kind: "inaudible"; readonly said: string }
  | { readonly kind: "redacted"; readonly said: string; readonly pii: boolean }
  | { readonly kind: "speaker_swapped"; readonly label: string }
  | { readonly kind: "crosstalk" };

export interface Turn {
  readonly speaker: Speaker;
  /** The label the recording system printed, which a mono recording sometimes swaps. */
  readonly label: string;
  readonly start_s: number;
  readonly end_s: number;
  /** What was said. Every number in it is one the record held that day, but a planted wrong amount. */
  readonly said: string;
  /** What the speech recognizer wrote. */
  readonly text: string;
  readonly noise: readonly NoiseOp[];
  /** What the turn does in the call (`greeting`, `verify`, `quote:next_amount`, `mini_miranda`, …). */
  readonly tag: string;
  /** The facts the turn states, by key. */
  readonly facts: readonly string[];
  /** The defect planted in this turn, if one was. */
  readonly defect: string | null;
}

export interface Transcript {
  readonly contact_id: string;
  readonly loan_id: string;
  readonly on: PlainDate;
  /** "stereo": agent and caller on their own channels, labels right; "mono": one channel, labels by diarization. */
  readonly recording: "stereo" | "mono";
  /** When the agent answered: the phone menu runs before it on an inbound call. */
  readonly answered_at_s: number;
  /** The contact row's duration: from the agent's answer to the hang-up. */
  readonly duration_s: number;
  readonly turns: readonly Turn[];
  /** The writer that wrote it: the templates, or later a model (see writer.ts). */
  readonly writer: string;
}
