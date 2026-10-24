/**
 * The collections spec's own examples, as calls
 * (apps/servicing/spec/sections/11-early-intervention-collections/11-1-live-contact.md).
 * Each is held to the finding the spec states: 11.1-T12's three dial times,
 * T10's mobile without consent, T21's fourth landline call, T13's eighth
 * counted call, T7's dial into a Chapter 13 case, rule 13's $4,165.00 and a
 * balance the agent worked out instead, design item 1's disclosure, Q3's
 * voicemail, the guardrails' threat and negotiation, T23's recording notice,
 * and the edge cases' cease and counsel. The loan, the people and the words
 * around each example are ours; the figures, times and dates the spec gives
 * are its own.
 */

import type { CallFacts, CallNote, PreDialFacts, RecordView } from "../calls/index.js";
import {
  CALL_QA_ENVIRONMENT_NAME,
  CALL_QA_ENVIRONMENT_VERSION,
  type CallQaTask,
  type TranscriptLine,
} from "./task.js";

/** The rule-3 loan of 11.1, the November and December installments of $2,000.00 unpaid on 2026-12-21, with two late charges of $82.50 (rule 13). */
export const SPEC_RECORD: RecordView = {
  on: "2026-12-21",
  servicer: {
    name: "Supermortgage",
    phone: "1-800-555-0187",
    hours_open: 8,
    hours_close: 9,
    transfer_shield_days: 60,
    payoff_statement_business_days: 7,
    credit_report_days: 30,
    mi_request_ltv_pct: 80,
    mi_auto_ltv_pct: 78,
    shortage_spread_months: 12,
    qwr_ack_business_days: 5,
    qwr_response_business_days: 30,
    reset_link_minutes: 15,
    form_number: 1098,
  },
  loan: {
    number: "0041172903",
    number_last4: "2903",
    rate_pct: "6.25",
    principal_balance: "$276,412.18",
    grace_days: 15,
    late_charge_pct: "5",
    escrowed: true,
  },
  borrowers: [
    { role: "borrower", name: "Avery Lindqvist", date_of_birth: "1984-04-17", ssn_last4: "6631" },
  ],
  property: {
    street: "418 Cedar Ln",
    street_number: "418",
    city: "Albany",
    state: "NY",
    zip: "12208",
  },
  phones_last4: ["7342"],
  next_installment: {
    due: "2026-11-01",
    amount: "$2,000.00",
    principal_interest: "$1,650.00",
    escrow: "$350.00",
    grace_ends: "2026-11-16",
  },
  past_due: {
    oldest_due: "2026-11-01",
    installments: 2,
    days: 50,
    installment_total: "$4,000.00",
    late_charges: "$165.00",
    total: "$4,165.00",
  },
  last_payment: {
    on: "2026-10-02",
    amount: "$2,000.00",
    applied_to: "2026-10-01",
    to_suspense: "$0.00",
    curtailment: "$0.00",
    forwarded: false,
  },
  escrow_statement: { as_of: "2026-11-30", balance: "$1,412.60" },
  escrow_analysis: null,
  annual_statement: null,
  arm_change: null,
  tax_paid: null,
  hazard_paid: null,
  escrow_refund: null,
  late_charge: { due: "2026-12-01", assessed_on: "2026-12-17", amount: "$82.50", paid_on: null },
  form_1098: null,
  mortgage_insurance: { active: false, terminated_on: null },
  transfer: null,
  payoff: null,
  credit_reporting: { month: "2026-11", days_delinquent: 29 },
  promises: [],
  bankruptcy: null,
  authorization_on: null,
};

const BASE_CALL: CallFacts = {
  id: "SPEC-K0001",
  on: "2026-12-21",
  direction: "outbound",
  voice: "ai",
  outcome: "conversation",
  with: "borrower",
  identity_verified: true,
  complaint_logged: false,
  debt_collector: false,
  servicemember_active_duty: false,
};

/** The dialer's facts for an AI call to the borrower's consenting mobile in New York, nothing on file to stop it. */
const BASE_PRE: PreDialFacts = {
  dial_at: "2026-12-21T17:00:00.000Z",
  mode: "ai_voice",
  time_zones: ["America/New_York"],
  line_type: "mobile",
  tcpa_voice_consent_active: true,
  written_consent: false,
  ai_voice_attempts_at: [],
  fdcpa_debt_collector: false,
  state: "NY",
  counted_call_attempts_at: [],
  voicemails_to_number_7d: 0,
  cease_active: false,
  written_cease: false,
  bk_active: false,
  attorney_represented: false,
};

type Who = "Agent" | "Customer" | "";
const lines = (...xs: readonly (readonly [Who, string])[]): TranscriptLine[] =>
  xs.map(([speaker, text], k) => ({
    line: k + 1,
    at: `00:00:${String(Math.min(59, k * 6)).padStart(2, "0")}`,
    speaker,
    text,
  }));

/** An AI collection call that does everything right: the disclosure, the recording notice, the checks, the mini-Miranda and the ledger's figure. */
const AI_CALL = (amount = "$4,165.00", over: readonly (readonly [Who, string])[] = []) =>
  lines(
    ["Agent", "Hi, may I speak with Avery Lindqvist?"],
    ["Customer", "Speaking."],
    [
      "Agent",
      "Hi Avery, I'm an automated assistant calling for Supermortgage, your mortgage servicer. You can ask for a person at any time.",
    ],
    ["Agent", "This call is being recorded."],
    ["Agent", "Before I go any further, can you verify your date of birth?"],
    ["Customer", "April 17th, 1984."],
    ["Agent", "Thank you, you're verified."],
    [
      "Agent",
      "I do need to let you know, this is an attempt to collect a debt and any information obtained will be used for that purpose.",
    ],
    [
      "Agent",
      `As of today the account is 50 days past due, and the amount to bring it current is ${amount}.`,
    ],
    ["Customer", "I know. My hours got cut at work."],
    [
      "Agent",
      "I'm sorry to hear that. If you're having a hardship, there are options like a repayment plan or a forbearance, and you'd apply so we can review them.",
    ],
    ...over,
    ["Agent", "Is there anything else I can help you with today?"],
    ["Customer", "No, thanks."],
  );

const VOICEMAIL = lines([
  "Agent",
  "Hi, this message is for Avery. This is Supermortgage. Please call us back at 1-800-555-0187. Thank you.",
]);

const NOTE: CallNote = {
  on: "2026-12-21",
  at: "12:09",
  user: "AIVOICE",
  text: "OB CALL TO B1. RPC. VRFD DOB. MM GIVEN. ACCT 50 DPD, TAD $4,165.00. RFD: HOURS CUT. ADV LM OPTIONS.",
  copied_from: null,
};

export interface SpecCall {
  readonly call?: Partial<CallFacts>;
  readonly transcript: readonly TranscriptLine[];
  readonly record?: RecordView;
  readonly pre_dial?: Partial<PreDialFacts> | null;
  readonly note?: CallNote | null;
}

export const CALL_QA_SPEC_CASES: readonly { readonly name: string; readonly spec: SpecCall }[] = [
  {
    name: "11.1-T12: property in New York, area code in Los Angeles, dialed at 20:45 ET: refused (17:45 PT passes, 20:45 ET is past the 20:30 voice policy)",
    spec: {
      transcript: AI_CALL(),
      pre_dial: {
        dial_at: "2026-12-22T01:45:00.000Z",
        time_zones: ["America/New_York", "America/Los_Angeles"],
      },
    },
  },
  {
    name: "11.1-T12: dialed at 11:00 ET, 08:00 PT: refused for PT",
    spec: {
      transcript: AI_CALL(),
      pre_dial: {
        dial_at: "2026-12-21T16:00:00.000Z",
        time_zones: ["America/New_York", "America/Los_Angeles"],
      },
    },
  },
  {
    name: "11.1-T12: dialed at 12:00 ET, 09:00 PT: permitted",
    spec: {
      transcript: AI_CALL(),
      pre_dial: {
        dial_at: "2026-12-21T17:00:00.000Z",
        time_zones: ["America/New_York", "America/Los_Angeles"],
      },
      note: NOTE,
    },
  },
  {
    name: "11.1-T10: an AI-voice call to a mobile number with no TCPA voice consent: refused",
    spec: { transcript: AI_CALL(), pre_dial: { tcpa_voice_consent_active: false } },
  },
  {
    name: "11.1-T21: a landline with no written consent, a fourth AI-voice call in 30 days: refused",
    spec: {
      transcript: AI_CALL(),
      pre_dial: {
        line_type: "landline",
        tcpa_voice_consent_active: false,
        ai_voice_attempts_at: [
          "2026-11-25T15:00:00.000Z",
          "2026-12-05T19:30:00.000Z",
          "2026-12-15T14:10:00.000Z",
        ],
      },
    },
  },
  {
    name: "11.1-T21: the same landline when the first of the three fell 30 days before: the third in 30 days, permitted",
    spec: {
      transcript: AI_CALL(),
      pre_dial: {
        line_type: "landline",
        tcpa_voice_consent_active: false,
        ai_voice_attempts_at: [
          "2026-11-21T17:00:00.000Z",
          "2026-12-05T19:30:00.000Z",
          "2026-12-15T14:10:00.000Z",
        ],
      },
    },
  },
  {
    name: "11.1-T13: on a debt collector's loan, an eighth counted call to B within 7 days: refused",
    spec: {
      call: { voice: "human", debt_collector: true },
      transcript: AI_CALL().map((l) =>
        l.line === 3
          ? { ...l, text: "Hi Avery, this is Jordan with Supermortgage, your mortgage servicer." }
          : l,
      ),
      pre_dial: {
        mode: "human_voice",
        fdcpa_debt_collector: true,
        counted_call_attempts_at: [
          "2026-12-14T16:55:00.000Z",
          "2026-12-15T14:05:00.000Z",
          "2026-12-15T23:40:00.000Z",
          "2026-12-16T17:10:00.000Z",
          "2026-12-17T13:30:00.000Z",
          "2026-12-18T23:05:00.000Z",
          "2026-12-20T14:05:00.000Z",
          "2026-12-21T13:40:00.000Z",
        ],
      },
    },
  },
  {
    name: "11.1-T7: a Chapter 13 petition on day 20: no outbound attempt is dialable",
    spec: {
      call: { voice: "human", outcome: "voicemail_left", identity_verified: null },
      transcript: VOICEMAIL,
      record: {
        ...SPEC_RECORD,
        bankruptcy: {
          chapter: 13,
          petition_on: "2026-11-21",
          noticed_on: "2026-11-23",
          case_last4: "4471",
          discharged_on: null,
          attorney: "Dana Whitfield",
          firm: "Whitfield Legal Group",
        },
      },
      pre_dial: { mode: "human_voice", bk_active: true },
      note: null,
    },
  },
  {
    name: "11.1 rule 13: past due 2 x $2,000.00 and late charges 2 x $82.50, $4,165.00 stated as of the call date: read from the ledger",
    spec: { transcript: AI_CALL(), note: NOTE },
  },
  {
    name: "11.1 rule 13: the AI never computes balances itself: $4,082.50 is not the ledger's figure",
    spec: { transcript: AI_CALL("$4,082.50"), note: NOTE },
  },
  {
    name: "11.1 design item 1: an AI voice that does not say it is an automated assistant",
    spec: {
      transcript: AI_CALL().map((l) =>
        l.line === 3
          ? { ...l, text: "Hi Avery, this is Supermortgage calling about your mortgage." }
          : l,
      ),
    },
  },
  {
    name: "11.1-Q3: a second voicemail on the number within 7 days",
    spec: {
      call: { voice: "human", outcome: "voicemail_left", identity_verified: null },
      transcript: VOICEMAIL,
      pre_dial: { mode: "human_voice", voicemails_to_number_7d: 1 },
      note: null,
    },
  },
  {
    name: "11.1 guardrail (§1006.18(c)): no threat of action not intended or lawful",
    spec: {
      transcript: AI_CALL("$4,165.00", [
        ["Agent", "If we don't get a payment, we will foreclose next week."],
      ]),
    },
  },
  {
    name: "11.1 guardrail: no negotiation of modification terms, only intake and referral",
    spec: {
      transcript: AI_CALL("$4,165.00", [
        [
          "Agent",
          "Honestly, I can get you a modification today: I'll lower your rate and extend your term, so your payment comes down.",
        ],
      ]),
    },
  },
  {
    name: "11.1-T23: in an all-party-consent state, the recording notice on every recorded call",
    spec: {
      transcript: AI_CALL()
        .filter((l) => l.line !== 4)
        .map((l, k) => ({ ...l, line: k + 1 })),
      record: {
        ...SPEC_RECORD,
        property: { ...SPEC_RECORD.property, state: "CA", city: "Sacramento", zip: "95814" },
      },
      pre_dial: {
        state: "CA",
        time_zones: ["America/Los_Angeles"],
        dial_at: "2026-12-21T20:00:00.000Z",
      },
    },
  },
  {
    name: "11.1 edge cases: an FDCPA cease on a debt collector's loan: no outbound call",
    spec: {
      call: { debt_collector: true },
      transcript: AI_CALL(),
      pre_dial: { fdcpa_debt_collector: true, written_cease: true },
    },
  },
  {
    name: "11.1 edge cases (§1006.6(b)(2)): counsel is known: no direct contact",
    spec: { transcript: AI_CALL(), pre_dial: { attorney_represented: true } },
  },
];

export function callQaSpecTasks(): CallQaTask[] {
  return CALL_QA_SPEC_CASES.map((c, index) => {
    const record = c.spec.record ?? SPEC_RECORD;
    const call: CallFacts = {
      ...BASE_CALL,
      id: `SPEC-K${String(index + 1).padStart(4, "0")}`,
      ...c.spec.call,
    };
    const pre: PreDialFacts | null =
      c.spec.pre_dial === null || call.direction === "inbound"
        ? null
        : { ...BASE_PRE, ...c.spec.pre_dial };
    return {
      id: `${CALL_QA_ENVIRONMENT_NAME}/${CALL_QA_ENVIRONMENT_VERSION}/spec/0/${index}`,
      split: "spec",
      suite_seed: 0,
      index,
      call,
      transcript: c.spec.transcript,
      record,
      pre_dial: pre,
      note: c.spec.note === undefined ? null : c.spec.note,
      source: { kind: "fixed", records: [record] },
      copied_record: null,
      planted: null,
    };
  });
}
