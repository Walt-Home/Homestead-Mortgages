/**
 * The comment log, as a partner sends it: one line per note, with the loan,
 * the day and time, the user, an area code and the text.
 *
 * System notes outnumber agent notes, as they do in a real log: every dialer
 * attempt, phone-menu session, portal login, text and letter writes one, and
 * so do the history's own events (a late charge, an analysis, a disbursement,
 * a transfer, a payoff, the 1098 in January). An agent writes one note per
 * call they handled, and one per letter or e-mail they worked.
 *
 * An agent's note is the writer's coded note in that agent's hand: some
 * write in capitals and codes, some in lower case, some in sentences; each
 * misspells at a rate of their own; a collector working the same delinquency
 * often copies the last note forward and adds to it, so its figures are of
 * the day it was first written (`copied_from`). The note is short because
 * agents' notes are short, and a longer call leaves a longer one.
 */

import { addDays, parts, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { LoanLife } from "../life/simulate.js";
import { hash32, rngFor, type Rng } from "../rng.js";
import { noteDate, noteMoney } from "./format.js";
import { kindOf, planCall, type CallPlan } from "./plan.js";
import { recordOn, servicerOn } from "./record.js";
import type { ContactRecord, LoanContacts, NoteArea, NoteRecord } from "./types.js";
import { slotsOf, templateWriter, type ContactTextWriter } from "./writer.js";

/** An agent's habits: how they write, and how often they misspell. */
export function handOf(agentId: string): {
  readonly style: 0 | 1 | 2;
  readonly money: 0 | 1 | 2;
  readonly date: 0 | 1 | 2;
  readonly misspell: number;
} {
  const h = hash32(`hand/${agentId}`);
  return {
    style: (h % 3) as 0 | 1 | 2,
    money: ((h >>> 4) % 3) as 0 | 1 | 2,
    date: ((h >>> 8) % 3) as 0 | 1 | 2,
    misspell: 0.01 + ((h >>> 12) % 5) * 0.01,
  };
}

const SPELL_OUT: Readonly<Record<string, string>> = {
  B1: "borrower",
  B2: "co-borrower",
  BWR: "borrower",
  CLD: "called",
  CI: "called in",
  RE: "regarding",
  ABT: "about",
  PMT: "payment",
  RCVD: "received",
  ADV: "advised",
  VRFD: "verified",
  ACCT: "account",
  ESC: "escrow",
  EFF: "effective",
  SHTG: "shortage",
  MOS: "months",
  LC: "late charge",
  ASSD: "assessed",
  REQ: "request",
  INT: "interest",
  PD: "paid",
  XFER: "transfer",
  XFERRED: "transferred",
  PIF: "paid in full",
  LM: "loss mitigation",
  PTP: "promise to pay",
  DPD: "days past due",
  TAD: "total amount due",
  RFD: "reason for default",
  NFA: "no further action",
  OB: "outbound",
  RPC: "right party contact",
  PH: "phone",
  LCM: "limited content message",
  MSG: "message",
  HAZ: "hazard",
  INS: "insurance",
  PG: "page",
  POI: "proof of insurance",
  STMT: "statement",
  CONF: "confirmed",
  ADDR: "address",
  ADDL: "additional",
  INQ: "inquired",
  ATTY: "attorney",
  BK: "bankruptcy",
  CH: "chapter",
  MM: "mini Miranda",
  TPA: "third party authorization",
  PTY: "party",
  HSG: "housing",
  NBS: "non-borrower spouse",
  CMPLT: "complaint",
  CANX: "cancellation",
  REQS: "requirements",
  ESTMT: "e-statements",
  SVC: "servicing",
  CHG: "change",
  LN: "loan",
  DOB: "DOB",
  SSN: "SSN",
  ANS: "answered",
  INTERP: "interpreter",
  SPANISH: "Spanish",
  W: "with",
};
const MISSPELL: Readonly<Record<string, string>> = {
  received: "recieved",
  borrower: "borower",
  payment: "payemnt",
  verified: "verifed",
  escrow: "escorw",
  insurance: "insurnace",
  advised: "advsied",
  request: "requset",
  account: "acount",
  transfer: "tranfser",
  statement: "statment",
  called: "caled",
  confirmed: "confimed",
  assessed: "assesed",
  promise: "promsie",
  RECEIVED: "RECIEVED",
  BORROWER: "BORROWER",
  PAYMENT: "PAYMNET",
  ADVISED: "ADVSD",
  VERIFIED: "VERIFED",
  ESCROW: "ESCORW",
  INSURANCE: "INSURANCE",
  ACCOUNT: "ACCOUNT",
  REQUEST: "REQUET",
  STATEMENT: "STATMENT",
};

function misspell(r: Rng, text: string, rate: number): string {
  return text
    .split(" ")
    .map((w) => {
      const u = r.next();
      const v = r.int(0, 2);
      if (u >= rate || /\d|\$|\//.test(w) || w.length < 5) return w;
      const core = w.replace(/[.,;:]+$/, "");
      const tail = w.slice(core.length);
      if (MISSPELL[core]) return MISSPELL[core] + tail;
      const i = 1 + (hash32(core) % Math.max(1, core.length - 2));
      if (v === 0) return core.slice(0, i) + core[i + 1] + core[i] + core.slice(i + 2) + tail;
      if (v === 1) return core.slice(0, i) + core.slice(i + 1) + tail;
      return core.slice(0, i) + core[i] + core.slice(i) + tail;
    })
    .join(" ");
}

/** The writer's coded note in the agent's hand. */
export function inHand(r: Rng, coded: string, agentId: string): string {
  const h = handOf(agentId);
  let text = coded;
  if (h.style === 1) text = text.toLowerCase();
  else if (h.style === 2) {
    text = text
      .split(" ")
      .map((w) => {
        const core = w.replace(/[.,;:]+$/, "");
        const tail = w.slice(core.length);
        const x = SPELL_OUT[core];
        return x ? x + tail : /\d/.test(w) ? w : w.toLowerCase();
      })
      .join(" ")
      .replace(/(^|[.]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  }
  return misspell(r, text, h.misspell);
}

/** Fill a coded note's figures, `⟨money:key⟩`, `⟨date:key⟩`, `⟨int:key⟩`, in the agent's hand. */
export function fillFigures(coded: string, p: CallPlan, agentId: string): string {
  const h = handOf(agentId);
  const f = p.facts;
  const m = new Map<string, Cents | null | undefined>([
    ["last_amount", f.last_payment?.amount],
    ["new_total", f.analysis?.new_total],
    ["shortage", f.analysis?.shortage],
    ["new_pi", f.arm?.new_pi],
    ["late_amount", f.late_charge?.amount],
    ["interest_1098", f.form_1098?.interest],
    ["tax_amount", f.tax_paid?.amount],
    ["past_due_total", f.past_due?.total],
    ["promise_amount", f.promise?.amount],
  ]);
  const d = new Map<string, PlainDate | null | undefined>([
    ["last_on", f.last_payment?.on],
    ["effective", f.analysis?.effective],
    ["first_new_payment", f.arm?.first_new_payment],
    ["late_assessed", f.late_charge?.assessed_on],
    ["tax_on", f.tax_paid?.on],
    ["transfer_on", f.transfer?.on],
    ["payoff_on", f.payoff?.on],
    ["mi_terminated_on", f.mi.terminated_on],
    ["petition_on", f.bankruptcy?.petition_on],
    ["promise_date", f.promise?.pay_by],
  ]);
  const ints = new Map<string, number | undefined>([
    ["days", f.past_due?.days],
    ["chapter", f.bankruptcy?.chapter],
  ]);
  return coded.replace(/⟨(money|date|int):([a-z_0-9]+)⟩/gi, (_all, kind: string, key: string) => {
    const k = key.toLowerCase();
    if (kind.toLowerCase() === "money") {
      const v = m.get(k);
      if (v === null || v === undefined) throw new RangeError(`note figure ${k} has no value`);
      return noteMoney(v, h.money);
    }
    if (kind.toLowerCase() === "date") {
      const v = d.get(k);
      if (!v) throw new RangeError(`note date ${k} has no value`);
      return noteDate(v, h.date);
    }
    const v = ints.get(k);
    if (v === undefined) throw new RangeError(`note count ${k} has no value`);
    return String(v);
  });
}

const DIALER: Partial<Record<ContactRecord["outcome"], string>> = {
  no_answer: "DIALER: OB ATTEMPT - NO ANSWER",
  busy_or_failed: "DIALER: OB ATTEMPT - BUSY/FAILED",
  voicemail_left: "DIALER: OB ATTEMPT - LCM LEFT",
  no_voicemail: "DIALER: OB ATTEMPT - VM, NO MSG (VM LEFT W/IN 7 DAYS)",
  disconnected: "DIALER: OB ATTEMPT - NUMBER DISCONNECTED - BAD PH COUNT INCREMENTED",
  wrong_number: "DIALER: OB ATTEMPT - WRONG PARTY - PH FLAGGED",
  refused: "DIALER: OB ATTEMPT - RPC REFUSED",
  answered_unverified: "DIALER: OB ATTEMPT - ANSWERED, NOT VERIFIED",
  conversation: "DIALER: OB ATTEMPT - CONNECTED",
};

const AREA_OF: Partial<Record<string, NoteArea>> = {
  payment_received: "CS",
  make_payment: "PMT",
  payment_change: "ESC",
  rate_change: "ARM",
  payment_arrangement: "COLL",
  hardship: "LM",
  escrow_analysis: "ESC",
  insurance: "INS",
  tax: "TAX",
  form_1098: "CS",
  online_access: "WEB",
  autopay_setup: "PMT",
  statement_copy: "CS",
  account_update: "CS",
  late_fee: "CS",
  payoff_request: "PIF",
  lien_release: "PIF",
  servicing_transfer: "TRF",
  disaster_assistance: "LM",
  mi_cancellation: "MI",
  credit_reporting: "CS",
  bankruptcy: "BK",
};

interface Draft {
  on: PlainDate;
  minute: number;
  order: number;
  user: string;
  kind: "system" | "agent";
  area: NoteArea;
  text: string;
  contact_id: string | null;
  copied_from_contact: string | null;
}

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const at = (m: number) => {
  const x = Math.min(Math.max(0, Math.round(m)), 23 * 60 + 59);
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** Every note on one loan, oldest first. */
export function notesFor(
  life: LoanLife,
  loan: Omit<LoanContacts, "notes">,
  centerKey: string,
  writer: ContactTextWriter = templateWriter,
): NoteRecord[] {
  const drafts: Draft[] = [];
  let order = 0;
  const sys = (
    on: PlainDate,
    minute: number,
    user: string,
    area: NoteArea,
    text: string,
    contact: string | null = null,
  ) =>
    drafts.push({
      on,
      minute,
      order: order++,
      user,
      kind: "system",
      area,
      text,
      contact_id: contact,
      copied_from_contact: null,
    });
  const lk = `${centerKey}/${life.loan_id}/notes`;
  const ctx = { profile: loan.profile, bankruptcy: loan.bankruptcy };
  const m$ = (c: Cents) => noteMoney(c, 0);
  const d$ = (d: PlainDate) => noteDate(d, 0);
  const full = loan as LoanContacts;
  const lastAgentNote = new Map<string, { text: string; contact: string }>();

  for (const c of loan.contacts) {
    const t = hm(c.at);
    const end = t + Math.ceil(c.handle_s / 60);
    const kind = kindOf(c);
    if (c.mode === "call" && c.direction === "outbound")
      sys(c.on, t + 1, "DIALER", "COLL", DIALER[c.outcome] ?? "DIALER: OB ATTEMPT", c.id);
    if (c.mode === "call" && kind && kind !== "voicemail" && c.human_agent) {
      const plan = planCall(life, full, c, centerKey);
      const r = rngFor(`${lk}/${c.id}`);
      // A complaint the agent did not log (S-02's twin) is not in the agent's note either: the note is written as
      // C-04's is, from the call's turns with the complaint left out of what the agent writes down.
      const noted: CallPlan =
        c.complaint_voiced && !c.complaint_logged
          ? { ...plan, needs: { ...plan.needs, complaint: false } }
          : plan;
      let text = inHand(
        r,
        fillFigures(writer.callNote(noted, writer.callTurns(plan)), noted, c.human_agent),
        c.human_agent,
      );
      let copied: string | null = null;
      const prev = lastAgentNote.get(c.issue);
      if (c.direction === "outbound" && c.purpose === "collection" && prev && r.chance(0.4)) {
        text = `${text} | PREV: ${prev.text}`;
        copied = prev.contact;
      }
      drafts.push({
        on: c.on,
        minute: end,
        order: order++,
        user: c.human_agent,
        kind: "agent",
        area: c.reason ? (AREA_OF[c.reason] ?? "CS") : "COLL",
        text,
        contact_id: c.id,
        copied_from_contact: copied,
      });
      if (
        c.purpose === "collection" ||
        c.reason === "payment_arrangement" ||
        c.reason === "hardship"
      )
        lastAgentNote.set(c.issue, { text: text.split(" | PREV: ")[0]!, contact: c.id });
      if (c.promise_id) {
        const p = loan.promises.find((x) => x.id === c.promise_id)!;
        sys(c.on, end + 1, "SYSTEM", "COLL", `PTP SET ${m$(p.amount)} DUE ${d$(p.pay_by)}`, c.id);
        sys(
          p.pay_by,
          23 * 60 + 30,
          "SYSTEM",
          "COLL",
          p.status === "kept" ? "PTP KEPT" : "PTP BROKEN - CADENCE RESUMED",
          c.id,
        );
      }
      if (c.complaint_logged)
        sys(
          c.on,
          end + 1,
          "SYSTEM",
          "CMPL",
          `COMPLAINT LOGGED - ${(c.reason ?? "collection").toUpperCase().replace(/_/g, " ")} - ROUTED TO RESOLUTION TEAM`,
          c.id,
        );
      if (c.resolution === "transferred")
        sys(c.on, end, "SYSTEM", "LM", "CALL TRANSFERRED TO LOSS MITIGATION QUEUE", c.id);
      if (c.reason === "bankruptcy" && loan.bankruptcy && c.party === "attorney")
        sys(
          c.on,
          end + 2,
          "SYSTEM",
          "BK",
          `BK FLAG SET CH ${loan.bankruptcy.chapter} FILED ${d$(loan.bankruptcy.petition_on)} - COLLECTIONS SUSPENDED`,
          c.id,
        );
      continue;
    }
    switch (c.mode) {
      case "ivr": {
        if (c.outcome === "ivr_abandoned")
          sys(c.on, t, "IVR", "IVR", "IVR SESSION - CALLER DISCONNECTED BEFORE AGENT", c.id);
        else {
          const f = recordOn(life, c.on, ctx);
          const tail =
            (c.reason === "payment_received" || c.reason === "make_payment") && f.last_payment
              ? ` - LAST PMT ${d$(f.last_payment.on)} ${m$(f.last_payment.amount)} PLAYED`
              : "";
          sys(
            c.on,
            t,
            "IVR",
            "IVR",
            `IVR SESSION - ${(c.reason ?? "menu").toUpperCase().replace(/_/g, " ")} - SELF SERVICE${tail}`,
            c.id,
          );
        }
        break;
      }
      case "portal":
        sys(c.on, t, "WEB", "WEB", "WEB LOGIN", c.id);
        break;
      case "sms":
        if (c.direction === "outbound")
          sys(c.on, t, "SYSTEM", "COLL", "SMS PMT REMINDER SENT", c.id);
        else if (c.purpose === "consent_revocation")
          sys(c.on, t, "SYSTEM", "CS", "SMS STOP RECEIVED - TEXT CONSENT REVOKED", c.id);
        else if (c.human_agent)
          drafts.push({
            on: c.on,
            minute: t + 20,
            order: order++,
            user: c.human_agent,
            kind: "agent",
            area: "CS",
            text: inHand(
              rngFor(`${lk}/${c.id}`),
              `TEXT RCVD RE ${(c.reason ?? "acct").toUpperCase().replace(/_/g, " ")}. RESPONDED VIA TEXT.`,
              c.human_agent,
            ),
            contact_id: c.id,
            copied_from_contact: null,
          });
        break;
      case "email":
        if (c.direction === "outbound")
          sys(c.on, t, "SYSTEM", "COLL", "EMAIL PMT REMINDER SENT", c.id);
        else {
          sys(c.on, t, "SYSTEM", "CS", "EMAIL RECEIVED - ROUTED TO CS QUEUE", c.id);
          if (c.human_agent)
            drafts.push({
              on: addDays(c.on, 1),
              minute: 10 * 60,
              order: order++,
              user: c.human_agent,
              kind: "agent",
              area: c.reason ? (AREA_OF[c.reason] ?? "CS") : "CS",
              text: inHand(
                rngFor(`${lk}/${c.id}`),
                `EMAIL RCVD RE ${(c.reason ?? "acct").toUpperCase().replace(/_/g, " ")}. REVIEWED ACCT, RESPONDED BY EMAIL.`,
                c.human_agent,
              ),
              contact_id: c.id,
              copied_from_contact: null,
            });
        }
        break;
      case "letter": {
        const text: Partial<Record<ContactRecord["purpose"], string>> =
          c.direction === "outbound"
            ? {
                ei_written_notice: "LTR MAILED: EARLY INTERVENTION WRITTEN NOTICE",
                lossmit_package: "LTR MAILED: LM APPLICATION PKG",
                qwr_acknowledgment: "LTR MAILED: QWR/NOE ACKNOWLEDGMENT",
              }
            : {
                hardship_letter: "MAIL RCVD: HARDSHIP LTR - IMAGED, ROUTED TO LM",
                insurance_document: "MAIL RCVD: HAZ DEC PAGE - SENT TO INS TRACKING",
                third_party_authorization:
                  "MAIL RCVD: 3RD PTY AUTHORIZATION (HSG COUNSELOR) - ADDED TO ACCT",
                qualified_written_request: "MAIL RCVD: QWR/NOE - CASE OPENED",
                bankruptcy_notice: "MAIL RCVD: BK NOTICE OF FILING - SENT TO BK DEPT",
                borrower_inquiry: "MAIL RCVD: BWR CORRESPONDENCE - ROUTED TO CS",
              };
        sys(c.on, t, "SYSTEM", "LTR", text[c.purpose] ?? "MAIL RCVD - IMAGED", c.id);
        break;
      }
    }
  }

  // The history's own events.
  const d = life.draw;
  const who = (on: PlainDate) => servicerOn(life, on);
  if (life.transfer_in_on) {
    sys(
      life.transfer_in_on,
      2 * 60 + 10,
      "BATCH",
      "TRF",
      `LOAN BOARDED - SVC TRANSFERRED FROM PRIOR SERVICER EFF ${d$(life.transfer_in_on)}`,
    );
    sys(life.transfer_in_on, 6 * 60, "SYSTEM", "LTR", "LTR MAILED: WELCOME/TRANSFER NOTICE");
  }
  for (const f of life.fees)
    sys(
      f.assessed_on,
      0 * 60 + 35,
      "BATCH",
      "PMT",
      `LATE CHARGE ASSESSED ${m$(f.amount)} FOR ${d$(f.due)} INSTALLMENT`,
    );
  for (const a of life.analyses) {
    const head =
      a.decision === "shortage" && a.shortage !== null
        ? `SHORTAGE ${m$(a.shortage)}`
        : a.surplus !== null && a.surplus > 0n
          ? `SURPLUS ${m$(a.surplus)}`
          : "NO SHORTAGE/SURPLUS";
    sys(
      a.as_of,
      3 * 60 + 5,
      "BATCH",
      "ESC",
      `ESCROW ANALYSIS COMPLETED. ${head}. NEW ESC PMT ${m$(a.new_payment)} EFF ${d$(a.effective)}${a.anomalies.length ? " - FLAGGED FOR REVIEW" : ""}`,
    );
    sys(
      a.sent_on,
      6 * 60 + 15,
      "SYSTEM",
      "LTR",
      "LTR MAILED: ANNUAL ESCROW ACCOUNT DISCLOSURE STMT",
    );
  }
  for (const x of life.disbursements) {
    const line =
      x.line === "mi_borrower_paid"
        ? "MI PREMIUM"
        : x.line === "hazard"
          ? "HAZARD PREMIUM"
          : x.line === "flood"
            ? "FLOOD PREMIUM"
            : x.line.toUpperCase().replace("_", " ");
    if (x.kind === "bill" && x.line === "mi_borrower_paid") continue; // monthly MI remittances are in the ledger, not the log
    sys(
      x.on,
      4 * 60 + 20,
      "BATCH",
      x.line.startsWith("tax") ? "TAX" : "ESC",
      x.kind === "bill"
        ? `ESC DISB ${line} ${m$(x.amount)}`
        : x.kind === "refund"
          ? `ESCROW SURPLUS REFUND ISSUED ${m$(x.amount)}`
          : `ESCROW REFUND AFTER PIF ${m$(x.amount)}`,
    );
  }
  for (const rc of life.receipts) {
    if (rc.to_suspense > 0n)
      sys(
        rc.on,
        5 * 60,
        "BATCH",
        "PMT",
        `PARTIAL PMT ${m$(rc.amount)} - ${m$(rc.to_suspense)} TO SUSPENSE`,
      );
    if (rc.curtailment > 0n)
      sys(rc.on, 5 * 60 + 1, "BATCH", "PMT", `ADDL PRIN ${m$(rc.curtailment)} APPLIED`);
    if (rc.channel === "transferor_forward")
      sys(
        rc.on,
        5 * 60 + 2,
        "BATCH",
        "TRF",
        `PMT FWD FROM PRIOR SVCR ${m$(rc.amount)} EFF ${d$(rc.credited_as_of)}`,
      );
  }
  for (const a of life.arm_changes)
    sys(
      a.notice_sent_on,
      6 * 60 + 30,
      "SYSTEM",
      "ARM",
      `ARM CHANGE NOTICE MAILED. NEW RATE ${Number(a.new_rate_pct)}% NEW P&I ${m$(a.new_pi)} EFF ${d$(a.first_new_payment)}`,
    );
  for (const x of life.pmi)
    if (x.status === "terminated" && x.effective_on)
      sys(x.on, 3 * 60 + 40, "BATCH", "MI", `PMI TERMINATED (AUTOMATIC) EFF ${d$(x.effective_on)}`);
  for (const b of life.behavior) {
    if (b.kind === "disaster")
      sys(b.on, 7 * 60, "SYSTEM", "LM", "DISASTER FLAG SET - FEMA DECLARED AREA");
    if (b.kind === "plan_started") sys(b.on, 15 * 60, "SYSTEM", "LM", "REPAYMENT PLAN SET UP");
    if (b.kind === "plan_completed")
      sys(b.on, 23 * 60, "SYSTEM", "LM", "REPAYMENT PLAN COMPLETED - LATE CHARGES WAIVED");
    if (b.kind === "plan_failed") sys(b.on, 23 * 60, "SYSTEM", "LM", "REPAYMENT PLAN FAILED");
    if (b.kind === "transfer_out")
      sys(b.on, 2 * 60, "BATCH", "TRF", "SVC TRANSFERRED OUT - GOODBYE LTR MAILED");
  }
  if (life.payoff)
    sys(
      life.payoff.on,
      16 * 60,
      "SYSTEM",
      "PIF",
      `PAID IN FULL ${d$(life.payoff.on)} - FUNDS ${m$(life.payoff.funds)} - LIEN RELEASE REQUESTED`,
    );
  // The 1098 in January, for a year with interest.
  for (
    let y = parts(d.first_due).y + 1;
    y <= parts(life.months[life.months.length - 1]?.as_of ?? d.first_due).y + 1;
    y++
  ) {
    const on = `${y}-01-31` as PlainDate;
    const f = recordOn(life, on, ctx);
    if (
      f.form_1098 &&
      (!life.payoff || life.payoff.on >= `${y - 1}-01-01`) &&
      (!life.transfer_out_on || life.transfer_out_on >= `${y - 1}-01-01`)
    )
      sys(on, 1 * 60, "BATCH", "CS", `1098 MAILED FOR ${y - 1}`);
  }
  void who;

  drafts.sort((a, b) =>
    a.on !== b.on
      ? a.on < b.on
        ? -1
        : 1
      : a.minute !== b.minute
        ? a.minute - b.minute
        : a.order - b.order,
  );
  const ids = new Map<string, string>();
  const out: NoteRecord[] = drafts.map((x, i) => {
    const id = `${life.loan_id}-N${String(i + 1).padStart(5, "0")}`;
    if (x.kind === "agent" && x.contact_id) ids.set(x.contact_id, id);
    return {
      id,
      loan_id: life.loan_id,
      servicer: servicerOn(life, x.on),
      on: x.on,
      at: at(x.minute),
      user: x.user,
      kind: x.kind,
      area: x.area,
      text: x.text,
      contact_id: x.contact_id,
      copied_from: x.copied_from_contact,
    };
  });
  // A copied note names the note it copied, not the call.
  return out.map((n) =>
    n.copied_from ? { ...n, copied_from: ids.get(n.copied_from) ?? null } : n,
  );
}

/** The plan's figures, as slots, for a writer that wants them (re-exported for model writers). */
export const planSlots = (p: CallPlan) => slotsOf(p);
