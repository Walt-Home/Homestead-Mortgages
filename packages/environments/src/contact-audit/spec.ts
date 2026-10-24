/**
 * Hand-built contact histories, each held to what the rules say of it: the
 * contact center's handling of a promise (the dialer ceased through its date,
 * marked kept or broken) and spec 4.5's of a complaint (acknowledged on the
 * call, logged, answered in writing within 15 days: SM_COMPLAINT_ACK_1BD,
 * SM_COMPLAINT_RESOLVE_15), and the two staff errors on their edges. The
 * loan, the people and the words are ours; every label is written by hand,
 * and the reference must reach them from the rulebook and the tools alone.
 */

import {
  STAFF_ERRORS,
  type StaffErrorId,
  type StaffLabel,
  type StaffSymptom,
} from "../contacts/index.js";
import {
  CONTACT_AUDIT_ENVIRONMENT_NAME,
  CONTACT_AUDIT_ENVIRONMENT_VERSION,
  type AuditComplaint,
  type AuditContact,
  type AuditLine,
  type AuditNote,
  type AuditPayment,
  type AuditPlan,
  type AuditPromise,
  type ContactAuditTask,
} from "./task.js";

const LOAN = {
  number: "0041172903",
  borrowers: ["Avery Lindqvist"],
  state: "NY",
  servicer: "Supermortgage",
} as const;
const LOAN_ID = "SPEC-LN-1";

/* ── builders ───────────────────────────────────────────────────────────── */

const row = (
  n: number,
  on: string,
  at: string,
  o: Partial<AuditContact> & Pick<AuditContact, "direction" | "outcome" | "purpose">,
): AuditContact => ({
  id: `SPEC-K${String(n).padStart(4, "0")}`,
  on,
  at,
  mode: "call",
  with: "borrower",
  reason: null,
  resolution: o.outcome === "conversation" ? "information_provided" : "no_contact",
  issue: "dq:2027-03-02",
  agent: "DMR4471",
  duration_s: o.outcome === "conversation" ? 312 : 30,
  promise_id: null,
  complaint_logged: false,
  transcript: o.outcome === "conversation" || o.outcome === "voicemail_left",
  ...o,
});
/** An outbound dialer attempt that reached nobody. */
const attempt = (n: number, on: string, at: string): AuditContact =>
  row(n, on, at, {
    direction: "outbound",
    outcome: "no_answer",
    purpose: "collection",
    transcript: false,
  });
const inboundCall = (n: number, on: string, at: string, o: Partial<AuditContact> = {}) =>
  row(n, on, at, {
    direction: "inbound",
    outcome: "conversation",
    purpose: "borrower_inquiry",
    ...o,
  });

const note = (
  id: number,
  on: string,
  at: string,
  user: string,
  area: string,
  text: string,
  contact: string | null,
): AuditNote => ({ id: `SPEC-N${String(id).padStart(5, "0")}`, on, at, user, area, text, contact });

type Who = "Agent" | "Customer" | "IVR" | "";
const lines = (...xs: readonly (readonly [Who, string])[]): AuditLine[] =>
  xs.map(([speaker, text], k) => ({
    line: k + 1,
    at: `00:${String(Math.floor((k * 9) / 60)).padStart(2, "0")}:${String((k * 9) % 60).padStart(2, "0")}`,
    speaker,
    text,
  }));

const OPENING: readonly (readonly [Who, string])[] = [
  [
    "Agent",
    "Thank you for calling Supermortgage, this is Dana. This call is recorded. How can I help you?",
  ],
  ["Customer", "Hi, this is Avery Lindqvist, calling about my mortgage."],
  ["Agent", "Okay. Can you verify the property address?"],
  ["Customer", "418 Cedar Lane, Albany."],
  ["Agent", "Thank you, you're verified."],
];
const PROMISE_CALL = (amount: string, date: string) =>
  lines(
    ...OPENING,
    ["Agent", "I do need to let you know, this is an attempt to collect a debt."],
    ["Customer", "I know I'm behind. I get paid next week."],
    ["Customer", `I can pay ${amount} by ${date}.`],
    ["Agent", `Okay, so I have you down for ${amount} by ${date}. You can pay online or by phone.`],
    ["Customer", "Thanks."],
  );
const COMPLAINT_CALL = (ack: string) =>
  lines(
    ...OPENING,
    ["Customer", "Why was I charged a late fee this month?"],
    ["Agent", "The payment came in after the grace period, so the late charge was assessed."],
    ["Customer", "I'm really unhappy with how this has been handled. I want to file a complaint."],
    ["Agent", ack],
    ["Customer", "Okay."],
  );
const ACKED =
  "I'm sorry to hear that, and I'm going to document this as a complaint, so it gets reviewed.";
const BRUSHED = "I understand. That's just how the system works.";
const ORDINARY = lines(
  ...OPENING,
  ["Customer", "Did you get my payment?"],
  ["Agent", "Yes, it posted on the fourth."],
  ["Customer", "Great, thanks."],
);

const payment = (n: number, on: string, amount: string, applied: string[]): AuditPayment => ({
  id: `SPEC-R${String(n).padStart(4, "0")}`,
  on,
  amount,
  applied_to: applied,
  to_suspense: "$0.00",
});

const label = (
  error: StaffErrorId,
  o: {
    readonly root?: boolean;
    readonly symptom?: StaffSymptom;
    readonly contact: string;
    readonly on: string;
    readonly promise?: { readonly amount: string; readonly pay_by: string };
  },
): StaffLabel => ({
  loan: LOAN_ID,
  defect_id: error,
  file_or_table: o.root ? "contacts" : o.symptom === "no_response" ? "complaints" : "contacts",
  field: o.root ? STAFF_ERRORS[error].field : "*",
  row: o.contact,
  on: o.on as StaffLabel["on"],
  true_value: null,
  planted_value: null,
  expected_handling: o.root
    ? STAFF_ERRORS[error].handling
    : `Downstream of ${error}: corrects when the root cause is corrected.`,
  root_cause: o.root ?? false,
  contact: o.contact,
  symptom: o.root ? null : (o.symptom ?? null),
  turn: null,
  ...(o.promise
    ? { promise: { amount: o.promise.amount, pay_by: o.promise.pay_by as StaffLabel["on"] } }
    : {}),
});

interface SpecHistory {
  readonly window: { readonly from: string; readonly to: string };
  readonly contacts: readonly AuditContact[];
  readonly notes: readonly AuditNote[];
  readonly transcripts: Readonly<Record<string, readonly AuditLine[]>>;
  readonly promises?: readonly AuditPromise[];
  readonly complaints?: readonly AuditComplaint[];
  readonly payments?: readonly AuditPayment[];
  readonly labels: readonly StaffLabel[];
}

/* ── the histories ──────────────────────────────────────────────────────── */

const W = { from: "2027-03-15", to: "2027-05-10" } as const;
const K = (n: number) => `SPEC-K${String(n).padStart(4, "0")}`;

/** A promise call on 2027-03-22 for $2,165.00 by 2027-04-02, and the dialer around it. */
function promiseHistory(o: {
  readonly recorded: boolean;
  readonly attempts: readonly (readonly [string, string])[];
  readonly payments: readonly AuditPayment[];
  readonly kept: boolean;
  readonly before?: readonly [string, string];
}): Pick<SpecHistory, "contacts" | "notes" | "transcripts" | "promises" | "payments"> {
  const call = inboundCall(3, "2027-03-22", "14:10", {
    purpose: "promise_to_pay",
    reason: "payment_arrangement",
    resolution: o.recorded ? "promise_recorded" : "information_provided",
    promise_id: o.recorded ? `${K(3)}-P` : null,
  });
  const early = o.before ? [attempt(2, o.before[0], o.before[1])] : [];
  const rows = [
    attempt(1, "2027-03-18", "10:02"),
    ...early,
    call,
    ...o.attempts.map(([on, at], k) => attempt(4 + k, on, at)),
  ];
  const notes: AuditNote[] = [
    note(1, "2027-03-18", "10:03", "DIALER", "COLL", "DIALER: OB ATTEMPT - NO ANSWER", K(1)),
    ...(o.before
      ? [
          note(
            2,
            o.before[0],
            o.before[1],
            "DIALER",
            "COLL",
            "DIALER: OB ATTEMPT - NO ANSWER",
            K(2),
          ),
        ]
      : []),
    note(
      3,
      "2027-03-22",
      "14:16",
      "DMR4471",
      "COLL",
      "B1 CLD RE PAST DUE/PTP. VRFD NAME/ADDR. MINI MIRANDA GIVEN. ACCT 21 DPD, TAD $2,165.00. RFD: HOURS CUT. PTP $2,165.00 BY 04/02/27.",
      K(3),
    ),
    ...(o.recorded
      ? [
          note(4, "2027-03-22", "14:17", "SYSTEM", "COLL", "PTP SET $2165.00 DUE 04/02/27", K(3)),
          note(
            5,
            "2027-04-02",
            "23:30",
            "SYSTEM",
            "COLL",
            o.kept ? "PTP KEPT" : "PTP BROKEN - CADENCE RESUMED",
            K(3),
          ),
        ]
      : []),
    ...o.attempts.map(([on, at], k) =>
      note(10 + k, on, at, "DIALER", "COLL", "DIALER: OB ATTEMPT - NO ANSWER", K(4 + k)),
    ),
  ];
  return {
    contacts: rows,
    notes,
    transcripts: { [K(3)]: PROMISE_CALL("$2,165.00", "April 2nd") },
    promises: o.recorded
      ? [
          {
            id: `${K(3)}-P`,
            contact: K(3),
            made_on: "2027-03-22",
            pay_by: "2027-04-02",
            amount: "$2,165.00",
            status: o.kept ? "kept" : "broken",
          },
        ]
      : [],
    payments: o.payments,
  };
}

/** A complaint call on 2027-03-24 about a late fee. */
function complaintHistory(o: {
  readonly logged: boolean;
  readonly again?: string;
  readonly elsewhere?: boolean;
}): Pick<SpecHistory, "contacts" | "notes" | "transcripts" | "complaints"> {
  const issue = "late_fee:2027-03";
  const call = inboundCall(20, "2027-03-24", "11:30", {
    reason: "late_fee",
    issue,
    resolution: "escalated",
    complaint_logged: o.logged,
  });
  const later = o.again
    ? [
        inboundCall(21, o.again, "09:40", {
          reason: "late_fee",
          issue: o.elsewhere ? "late_fee:2027-04" : issue,
          resolution: "escalated",
          complaint_logged: o.elsewhere ?? false,
        }),
      ]
    : [];
  return {
    contacts: [call, ...later],
    notes: [
      note(
        20,
        "2027-03-24",
        "11:37",
        "KLT2208",
        "CS",
        o.logged
          ? "B1 CLD RE LATE FEE. VRFD NAME/ADDR. LC $82.50 ASSESSED 03/17/27. SENT FOR REVIEW. BWR UPSET. COMPLAINT LOGGED."
          : "B1 CLD RE LATE FEE. VRFD NAME/ADDR. LC $82.50 ASSESSED 03/17/27. SENT FOR REVIEW.",
        K(20),
      ),
      ...(o.logged
        ? [
            note(
              21,
              "2027-03-24",
              "11:38",
              "SYSTEM",
              "CMPL",
              "COMPLAINT LOGGED - LATE FEE - ROUTED TO RESOLUTION TEAM",
              K(20),
            ),
          ]
        : []),
      ...later.map((c) =>
        note(
          22,
          c.on,
          "09:47",
          "KLT2208",
          "CS",
          o.elsewhere
            ? "B1 CLD RE LATE FEE. VRFD NAME/ADDR. BWR UPSET. COMPLAINT LOGGED."
            : "B1 CLD RE LATE FEE. VRFD NAME/ADDR. SENT FOR REVIEW.",
          c.id,
        ),
      ),
    ],
    transcripts: {
      [K(20)]: COMPLAINT_CALL(o.logged ? ACKED : BRUSHED),
      ...(later.length
        ? {
            [K(21)]: COMPLAINT_CALL(o.elsewhere ? ACKED : BRUSHED).map((l) =>
              l.line === 8
                ? {
                    ...l,
                    text: "This is the third time I've called about this and I'm fed up. I want this escalated.",
                  }
                : l,
            ),
          }
        : {}),
    },
    complaints: [
      ...(o.logged
        ? [
            {
              id: `${K(20)}-C`,
              contact: K(20),
              received_on: "2027-03-24",
              channel: "call",
              category: "fees",
              acknowledged_on: "2027-03-24",
              respond_by: "2027-04-08",
              responded_on: "2027-04-02",
              response: "NTC_COMPLAINT_RESPONSE",
            },
          ]
        : []),
      ...(o.elsewhere && o.again
        ? [
            {
              id: `${K(21)}-C`,
              contact: K(21),
              received_on: o.again,
              channel: "call",
              category: "fees",
              acknowledged_on: o.again,
              respond_by: "2027-05-03",
              responded_on: "2027-04-27",
              response: "NTC_COMPLAINT_RESPONSE",
            },
          ]
        : []),
    ],
  };
}

const sortRows = (xs: readonly AuditContact[]) =>
  [...xs].sort((a, b) => (a.on !== b.on ? (a.on < b.on ? -1 : 1) : a.at < b.at ? -1 : 1));
const sortNotes = (xs: readonly AuditNote[]) =>
  [...xs].sort((a, b) => (a.on !== b.on ? (a.on < b.on ? -1 : 1) : a.at < b.at ? -1 : 1));

const merge = (...hs: Partial<SpecHistory>[]): Omit<SpecHistory, "window" | "labels"> => ({
  contacts: sortRows(hs.flatMap((h) => h.contacts ?? [])),
  notes: sortNotes(hs.flatMap((h) => h.notes ?? [])),
  transcripts: Object.assign({}, ...hs.map((h) => h.transcripts ?? {})) as Record<
    string,
    AuditLine[]
  >,
  promises: hs.flatMap((h) => h.promises ?? []),
  complaints: hs.flatMap((h) => h.complaints ?? []),
  payments: hs.flatMap((h) => h.payments ?? []),
});

const ordinary = (): Partial<SpecHistory> => ({
  contacts: [
    inboundCall(30, "2027-04-20", "10:15", {
      reason: "payment_received",
      issue: "payment_received:2027-04",
    }),
  ],
  notes: [
    note(
      30,
      "2027-04-20",
      "10:19",
      "JHS9032",
      "CS",
      "B1 CLD RE PMT STATUS. VRFD NAME/ADDR. ADV PMT RCVD 04/04/27 $2,165.00. NFA.",
      K(30),
    ),
  ],
  transcripts: { [K(30)]: ORDINARY },
});

const KEPT = [payment(1, "2027-04-02", "$2,165.00", ["2027-03-01", "2027-04-01"])];
const PROMISE = { amount: "$2,165.00", pay_by: "2027-04-02" } as const;
const S01 = (on = "2027-03-22") =>
  label("S-01", { root: true, contact: K(3), on, promise: PROMISE });
const S01s = (symptom: StaffSymptom, contact: string, on: string) =>
  label("S-01", { symptom, contact, on });
const S02 = () => label("S-02", { root: true, contact: K(20), on: "2027-03-24" });
const S02s = (symptom: StaffSymptom, contact = K(20), on = "2027-03-24") =>
  label("S-02", { symptom, contact, on });

export const CONTACT_AUDIT_SPEC_CASES: readonly {
  readonly name: string;
  readonly history: SpecHistory;
}[] = [
  {
    name: "A promise recorded and kept: the dialer ceased through its date, and the promise marked kept: clean",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: true,
          attempts: [["2027-04-05", "11:00"]],
          payments: KEPT,
          kept: true,
        }),
        ordinary(),
      ),
      labels: [],
    },
  },
  {
    name: "S-01: a promise noted and not recorded, kept by its date: the dialer called twice inside its window",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: false,
          attempts: [
            ["2027-03-25", "09:30"],
            ["2027-03-30", "18:05"],
          ],
          payments: KEPT,
          kept: true,
        }),
        ordinary(),
      ),
      labels: [
        S01(),
        S01s("dialed_in_window", K(4), "2027-03-25"),
        S01s("dialed_in_window", K(5), "2027-03-30"),
        S01s("kept_not_marked", K(3), "2027-04-02"),
      ],
    },
  },
  {
    name: "S-01's window includes its pay-by date and not the day after; a payment a cent short breaks it",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: false,
          attempts: [
            ["2027-04-02", "12:00"],
            ["2027-04-03", "10:00"],
          ],
          payments: [payment(1, "2027-04-01", "$2,164.99", ["2027-03-01"])],
          kept: false,
        }),
        ordinary(),
      ),
      labels: [
        S01(),
        S01s("dialed_in_window", K(4), "2027-04-02"),
        S01s("broken_not_followed_up", K(3), "2027-04-02"),
      ],
    },
  },
  {
    name: "S-01's window starts at the call: an attempt earlier that day is outside it, one later that day inside",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: false,
          before: ["2027-03-22", "09:15"],
          attempts: [["2027-03-22", "18:40"]],
          payments: KEPT,
          kept: true,
        }),
        ordinary(),
      ),
      labels: [
        S01(),
        S01s("dialed_in_window", K(4), "2027-03-22"),
        S01s("kept_not_marked", K(3), "2027-04-02"),
      ],
    },
  },
  {
    name: "S-01 kept by two payments after the call's day that add up to it, the second on its date; one on the call's own day does not count",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: false,
          attempts: [],
          payments: [
            payment(1, "2027-03-22", "$500.00", ["2027-03-01"]),
            payment(2, "2027-03-26", "$1,000.00", []),
            payment(3, "2027-04-02", "$1,165.00", ["2027-03-01", "2027-04-01"]),
          ],
          kept: true,
        }),
        ordinary(),
      ),
      labels: [S01(), S01s("kept_not_marked", K(3), "2027-04-02")],
    },
  },
  {
    name: "A copied-forward note's earlier promise is not this call's: clean",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: true,
          attempts: [["2027-04-05", "11:00"]],
          payments: KEPT,
          kept: true,
        }),
        {
          contacts: [
            row(40, "2027-04-07", "16:20", {
              direction: "outbound",
              outcome: "conversation",
              purpose: "collection",
            }),
          ],
          notes: [
            note(
              40,
              "2027-04-07",
              "16:27",
              "DMR4471",
              "COLL",
              "OB CALL TO B1. RPC. VRFD NAME/ADDR. NO PTP. ADV LM OPTIONS. | PREV: B1 CLD RE PAST DUE/PTP. PTP $2,165.00 BY 04/02/27.",
              K(40),
            ),
          ],
          transcripts: { [K(40)]: ORDINARY },
        },
      ),
      labels: [],
    },
  },
  {
    name: "A complaint acknowledged, logged and answered on day 9 (SM_COMPLAINT_ACK_1BD, SM_COMPLAINT_RESOLVE_15): clean",
    history: { window: W, ...merge(complaintHistory({ logged: true }), ordinary()), labels: [] },
  },
  {
    name: "S-02: a complaint voiced and not logged, nothing answering it, and the borrower raising it again 20 days later",
    history: {
      window: W,
      ...merge(complaintHistory({ logged: false, again: "2027-04-13" }), ordinary()),
      labels: [
        S02(),
        S02s("no_acknowledgment"),
        S02s("no_response", K(20), "2027-04-08"),
        S02s("raised_again", K(21), "2027-04-13"),
      ],
    },
  },
  {
    name: "S-02: a later complaint on another issue, logged, is not the first raised again",
    history: {
      window: W,
      ...merge(
        complaintHistory({ logged: false, again: "2027-04-18", elsewhere: true }),
        ordinary(),
      ),
      labels: [S02(), S02s("no_acknowledgment"), S02s("no_response", K(20), "2027-04-08")],
    },
  },
  {
    name: "S-01 and S-02 on one loan",
    history: {
      window: W,
      ...merge(
        promiseHistory({
          recorded: false,
          attempts: [["2027-03-29", "10:10"]],
          payments: KEPT,
          kept: true,
        }),
        complaintHistory({ logged: false, again: "2027-04-20" }),
      ),
      labels: [
        S01(),
        S01s("dialed_in_window", K(4), "2027-03-29"),
        S01s("kept_not_marked", K(3), "2027-04-02"),
        S02(),
        S02s("no_acknowledgment"),
        S02s("no_response", K(20), "2027-04-08"),
        S02s("raised_again", K(21), "2027-04-20"),
      ],
    },
  },
];

const planOf = (labels: readonly StaffLabel[]): AuditPlan => {
  const ids = [...new Set(labels.filter((l) => l.root_cause).map((l) => l.defect_id))].sort();
  return ids.length === 0 ? "clean" : (ids.join("+") as AuditPlan);
};

export function contactAuditSpecTasks(): ContactAuditTask[] {
  return CONTACT_AUDIT_SPEC_CASES.map((c, index) => ({
    id: `${CONTACT_AUDIT_ENVIRONMENT_NAME}/${CONTACT_AUDIT_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec" as const,
    suite_seed: 0,
    index,
    loan: LOAN,
    window: c.history.window,
    contacts: c.history.contacts,
    notes: c.history.notes,
    transcripts: c.history.transcripts,
    promises: c.history.promises ?? [],
    complaints: c.history.complaints ?? [],
    payments: c.history.payments ?? [],
    labels: c.history.labels,
    plan: { plan: planOf(c.history.labels), arm: 0 },
    source: null,
  }));
}
