/**
 * A call's plan: everything a writer needs to write the call and its note,
 * decided before a word is written. The record on the day comes first
 * (`recordOn`), then the call's shape from the contact row (who called, why,
 * whether they passed the checks, what the agent had to disclose, whether a
 * complaint was voiced, a promise recorded, a transfer made), then what the
 * row does not say, drawn from the call's own stream: the agent's manner, a
 * second question, the side topics that fill a long call, the holds.
 *
 * The plan is the seam a model writer would take as its prompt (writer.ts):
 * the facts and the shape, and nothing it could get wrong by inventing.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import type { LoanLife } from "../life/simulate.js";
import { hash32, rngFor } from "../rng.js";
import { AGENTS } from "./derive.js";
import { recordOn, type RecordFacts } from "./record.js";
import type { ContactRecord, InquiryReason, LoanContacts, PartyRole } from "./types.js";

export type CallKind =
  | "inbound"
  | "inbound_unverified"
  | "outbound"
  | "outbound_unverified"
  | "voicemail"
  | "wrong_number"
  | "refused";

/** Side topics that fill a long call: each is a short exchange, written by the writer and noted by the agent. */
export const TOPICS = [
  "confirm_phone",
  "confirm_email",
  "paperless",
  "autopay_offer",
  "text_offer",
  "portal_offer",
  "small_talk",
  "system_slow",
  "repeat_figure",
  "spell_name",
  "mailing_address",
  "survey",
  "hours",
  "payment_options",
  "statement_walkthrough",
  "occupancy_check",
  "insurance_check",
  "scra_check",
  "statement_delivery",
  "fraud_warning",
] as const;
export type Topic = (typeof TOPICS)[number];
/** The side topics an agent raises with someone calling for the borrower: nothing that asks them to speak as the borrower. */
export const THIRD_PARTY_TOPICS: ReadonlySet<Topic> = new Set([
  "payment_options",
  "hours",
  "survey",
  "statement_walkthrough",
  "fraud_warning",
  "system_slow",
]);

export interface CallPlan {
  readonly key: string;
  readonly contact: ContactRecord;
  readonly facts: RecordFacts;
  readonly kind: CallKind;
  readonly reason: InquiryReason | null;
  /** Further questions asked before the call ends, in order. */
  readonly seconds: readonly InquiryReason[];
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly manner: "scripted" | "casual" | "new";
  };
  /** The specialist a transfer reaches. */
  readonly agent2: { readonly name: string } | null;
  readonly caller: {
    readonly role: PartyRole;
    readonly full: string | null;
    readonly first: string | null;
    /** Which borrower the account's checks are answered for: 0 or 1. */
    readonly party: 0 | 1;
    readonly agency: string | null;
  };
  readonly borrower: { readonly full: string; readonly first: string };
  readonly style: "brief" | "chatty" | "anxious" | "irritated";
  readonly language: "en" | "es";
  readonly interpreter: boolean;
  readonly needs: {
    readonly recording: boolean;
    readonly mini_miranda: boolean;
    readonly bk_disclaimer: boolean;
    readonly credit_question: boolean;
    readonly complaint: boolean;
    readonly transfer: boolean;
    readonly promise: boolean;
    readonly hardship: string | null;
    /** The spouse not on the note, with the borrower beside them to authorize. */
    readonly borrower_joins: boolean;
  };
  readonly topics: readonly Topic[];
  readonly holds: readonly number[];
  readonly transfer_s: number;
  /** The seconds an interpreter takes to join. */
  readonly conference_s: number;
  readonly recording: "stereo" | "mono";
  /** The seconds from the agent's answer to the hang-up, which the transcript fills exactly. */
  readonly talk_s: number;
  /** About how many words the agent's part of the call should run to. */
  readonly words_target: number;
}

const HARDSHIPS = [
  "job_loss",
  "hours_cut",
  "medical",
  "divorce",
  "car",
  "family",
  "business",
  "overtime",
] as const;
const AGENCIES = [
  "Neighborhood Housing Services",
  "Community Housing Partners",
  "HomeFree Counseling",
  "Clearpoint Housing Counsel",
] as const;
const SPECIALISTS = ["Marisol", "Trevor", "Bianca", "Leon", "Priya", "Walter"] as const;
/** Words a second over the time not on hold: speech runs about 150 a minute, and a call has dead air while the agent reads and types. */
export const WORDS_PER_SECOND = 2.0;
const LIGHT_SECONDS: readonly InquiryReason[] = [
  "statement_copy",
  "account_update",
  "online_access",
  "insurance",
  "tax",
  "autopay_setup",
];

export function mannerOf(agentId: string): "scripted" | "casual" | "new" {
  const h = hash32(agentId) % 10;
  return h < 4 ? "scripted" : h < 8 ? "casual" : "new";
}

export function kindOf(c: ContactRecord): CallKind | null {
  if (c.mode !== "call" || !c.transcript) return null;
  if (c.direction === "inbound")
    return c.outcome === "conversation" ? "inbound" : "inbound_unverified";
  switch (c.outcome) {
    case "conversation":
      return "outbound";
    case "answered_unverified":
      return "outbound_unverified";
    case "voicemail_left":
      return "voicemail";
    case "wrong_number":
      return "wrong_number";
    case "refused":
      return "refused";
    default:
      return null;
  }
}

export function planCall(
  life: LoanLife,
  loan: LoanContacts,
  contact: ContactRecord,
  centerKey: string,
): CallPlan {
  const kind = kindOf(contact);
  if (!kind) throw new RangeError(`${contact.id} is not a call with a voice on it`);
  // A promise the call recorded, or one it made that nobody recorded (S-01): the words are the same either way.
  const promise = contact.promise_id
    ? (loan.promises.find((p) => p.id === contact.promise_id) ?? null)
    : (loan.unrecorded_promises?.find((p) => p.contact_id === contact.id) ?? null);
  const auth = [...loan.contacts]
    .filter((c) => c.purpose === "third_party_authorization" && c.on <= contact.on)
    .map((c) => c.on)
    .pop();
  const facts = recordOn(life, contact.on, {
    profile: loan.profile,
    bankruptcy: loan.bankruptcy,
    promise: promise ? { amount: promise.amount, pay_by: promise.pay_by } : null,
    authorization_on: (auth as PlainDate | undefined) ?? null,
  });
  const key = `${centerKey}/${life.loan_id}/call/${contact.id}`;
  const r = rngFor(`${key}/plan`);
  const pool = AGENTS[contact.servicer];
  const agent = pool.find((a) => a.id === contact.human_agent) ?? pool[0]!;
  const d = life.draw;
  const b1 = d.parties[0]!;
  const b2 = d.parties[1];
  const party: 0 | 1 = contact.party === "co_borrower" && b2 ? 1 : 0;
  const who = party === 1 ? b2! : b1;
  const uAgency = r.int(0, AGENCIES.length - 1);
  const uSpecialist = r.int(0, SPECIALISTS.length - 1);
  const uCredit = r.next();
  const uSecond = [r.next(), r.next(), r.next()];
  const uHard = r.int(0, HARDSHIPS.length - 1);
  const uHolds = [r.next(), r.next(), r.next()];
  const uStereo = r.next();
  const holdSecs = [r.int(25, 150), r.int(20, 120), r.int(30, 200)];
  const transferS = r.int(20, 80);
  const conferenceS = r.int(15, 45);
  const conversation = kind === "inbound" || kind === "outbound";
  const behind = facts.past_due !== null;
  const reason = contact.reason;
  const transfer = contact.resolution === "transferred" && conversation;
  const borrowerOnLine = contact.party === "borrower" || contact.party === "co_borrower";
  const credit =
    conversation &&
    behind &&
    borrowerOnLine &&
    !facts.bankruptcy &&
    reason !== "credit_reporting" &&
    uCredit < 0.4;
  const talk = contact.duration_s;
  // A longer call covers more: a second question on one call in four, more on a long one; a hold on most
  // calls past four minutes, a second past ten, a third past seventeen.
  const lightOk = LIGHT_SECONDS.filter(
    (x) =>
      x !== reason && (x !== "insurance" || facts.hazard_paid) && (x !== "tax" || facts.tax_paid),
  );
  const secondShare = [
    talk < 400 ? 0.25 : talk < 900 ? 0.5 : 0.9,
    talk < 400 ? 0 : talk < 900 ? 0.15 : 0.5,
    talk < 900 ? 0 : 0.2,
  ];
  const seconds: InquiryReason[] = [];
  if (kind === "inbound" && reason !== "bankruptcy")
    for (let k = 0; k < 3 && lightOk.length; k++) {
      if (uSecond[k]! >= secondShare[k]!) break;
      seconds.push(lightOk.splice(r.int(0, lightOk.length - 1), 1)[0]!);
    }
  const holds: number[] = [];
  if (conversation) {
    if (talk > 240 && uHolds[0]! < 0.55) holds.push(holdSecs[0]!);
    if (talk > 600 && uHolds[1]! < 0.4) holds.push(holdSecs[1]!);
    if (talk > 1000 && uHolds[2]! < 0.5) holds.push(holdSecs[2]!);
  }
  let held =
    holds.reduce((s, x) => s + x, 0) +
    (transfer ? transferS : 0) +
    (contact.interpreter ? conferenceS : 0);
  while (holds.length && held > talk * 0.35) {
    held -= holds.pop()!;
  }
  const speak = Math.max(20, talk - held);
  const wordsTarget = Math.round((speak * WORDS_PER_SECOND) / (contact.interpreter ? 1.7 : 1));
  const applicable = TOPICS.filter(
    (t) =>
      (t !== "confirm_email" || loan.profile.email_on_file) &&
      (t !== "paperless" || (loan.profile.email_on_file && !loan.profile.paperless)) &&
      (t !== "text_offer" ||
        (!loan.profile.sms_consent && loan.profile.phones[0]!.kind === "mobile")) &&
      (t !== "portal_offer" || !loan.profile.portal_user) &&
      (t !== "autopay_offer" || !behind) &&
      (t !== "statement_walkthrough" || facts.next !== null),
  );
  const order = [...applicable];
  for (let i = order.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return {
    key,
    contact,
    facts,
    kind,
    reason,
    seconds,
    agent: { id: agent.id, name: agent.name, manner: mannerOf(agent.id) },
    agent2: transfer ? { name: SPECIALISTS[uSpecialist]! } : null,
    caller: {
      role: contact.party,
      full: contact.party_name,
      first: contact.party_name ? contact.party_name.split(" ")[0]! : null,
      party,
      agency: contact.party === "housing_counselor" ? AGENCIES[uAgency]! : null,
    },
    borrower: { full: `${who.given_name} ${who.surname}`, first: who.given_name },
    style: loan.profile.style,
    language: contact.language,
    interpreter: contact.interpreter,
    needs: {
      recording: conversation || kind === "outbound_unverified",
      mini_miranda: contact.disclosures_marked.fdcpa,
      bk_disclaimer: contact.disclosures_marked.bankruptcy,
      credit_question: credit,
      complaint: contact.complaint_voiced,
      transfer,
      promise: promise !== null,
      hardship: behind || reason === "hardship" ? HARDSHIPS[uHard]! : null,
      borrower_joins:
        contact.party === "spouse_not_on_note" &&
        contact.identity_verified === true &&
        !(loan.profile.spouse?.authorized ?? false),
    },
    topics: !conversation
      ? []
      : contact.party === "borrower" || contact.party === "co_borrower"
        ? order
        : order.filter((t) => THIRD_PARTY_TOPICS.has(t)),
    holds,
    transfer_s: transfer ? transferS : 0,
    conference_s: contact.interpreter ? conferenceS : 0,
    recording: uStereo < 0.7 ? "stereo" : "mono",
    talk_s: talk,
    words_target: wordsTarget,
  };
}
