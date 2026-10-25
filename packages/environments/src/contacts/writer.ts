/**
 * The writers of a call's words, and the seam for a model to write them.
 *
 * `ContactTextWriter` is the seam. A writer takes a `CallPlan` (the record on
 * the day and the call's shape, plan.ts) and returns the call's turns, each
 * tagged with what it does, and the agent's note. `templateWriter` is the
 * one there is: a phrase grammar (grammar.ts) over templates, reproducible
 * from the seed, with no model call anywhere. A model writer slots in here
 * later and is held to the same three things the template writer is held to
 * by the tests:
 *
 *   - every number in a turn is one `factNumbers(plan.facts)` holds
 *     (`checkTurns`, check.ts), so a model that invents a figure is refused;
 *   - every tag a defect needs is present when the plan needs it
 *     (`recording_disclosure`, `mini_miranda`, `bk_disclaimer`,
 *     `credit_answer`, `complaint_ack`, `unverified_refusal`, a `quote:` turn
 *     for each statement), so defects plant the same way on its text;
 *   - it is reproducible: a model's text is written once, offline, and kept
 *     by contact id, so the book stays a function of its seed.
 *
 * The timing, the speech-recognition noise and the defects are applied after
 * the writer (transcript.ts), whoever wrote the words.
 */

import { addDays, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { rngFor, type Rng } from "../rng.js";
import { fecha, mesYear, money, monthName, monthYear, pct, pctEs, spokenDate } from "./format.js";
import { expand, say, type Slots } from "./grammar.js";
import type { CallPlan, Topic } from "./plan.js";
import { PRIOR_SERVICER, SERVICER } from "./record.js";

/** The statement's lines as the interpreter names them. */
const STATEMENT_LABEL_ES: Readonly<Record<string, string>> = {
  tax_county: "el impuesto del condado",
  tax_school: "el impuesto escolar",
  hazard: "el seguro de la casa",
  flood: "el seguro contra inundaciones",
  mi_borrower_paid: "el seguro hipotecario",
  refund: "el reembolso del sobrante",
};
import { hardshipEs, interpret } from "./spanish.js";
import type { InquiryReason, Speaker } from "./types.js";

/** A turn as a writer writes it, before timing and noise. */
export interface DraftTurn {
  readonly speaker: Speaker;
  readonly said: string;
  readonly tag: string;
  /** Spans of `said` that are personal data, which the recognizer redacts. */
  readonly pii: readonly string[];
  /** A hold, a transfer or the queue: markup with its seconds, and no words. */
  readonly hold_s?: number;
}

export interface ContactTextWriter {
  readonly id: string;
  callTurns(plan: CallPlan): DraftTurn[];
  /** The agent's note, written from the call: the plan and the turns the writer wrote for it. */
  callNote(plan: CallPlan, turns: readonly DraftTurn[]): string;
}

/* ── slots: the record on the day, as words ──────────────────────────────── */

export function slotsOf(p: CallPlan): Record<string, string> {
  const f = p.facts;
  const s: Record<string, string> = {};
  const dt = (k: string, d: PlainDate | null | undefined) => {
    if (!d) return;
    s[k] = spokenDate(d);
    s[`${k}_y`] = spokenDate(d, true);
    s[`${k}_es`] = fecha(d);
    s[`${k}_es_y`] = fecha(d, true);
  };
  const m = (k: string, c: Cents | null | undefined) => {
    if (c !== null && c !== undefined) s[k] = money(c);
  };
  const minute = Number(p.contact.at.slice(0, 2));
  s.daypart = minute < 12 ? "morning" : minute < 17 ? "afternoon" : "evening";
  s.servicer = f.servicer === "us" ? SERVICER.name : PRIOR_SERVICER.name;
  s.phone = f.servicer === "us" ? SERVICER.phone : PRIOR_SERVICER.phone;
  s.agent = p.agent.name;
  if (p.agent2) s.agent2 = p.agent2.name;
  s.b_first = p.borrower.first;
  s.b_full = p.borrower.full;
  s.caller_full = p.caller.full ?? p.borrower.full;
  s.caller_first = p.caller.first ?? p.borrower.first;
  if (p.caller.agency) s.agency = p.caller.agency;
  const party = f.parties[p.caller.party] ?? f.parties[0]!;
  s.ssn4 = party.ssn_last4;
  dt("dob", party.dob);
  s.street = f.property.street;
  s.city = f.property.city;
  s.zip = f.property.zip;
  s.loan_number = f.loan_number;
  s.loan4 = f.loan_last4;
  s.phone4 = f.phones_last4[0] ?? "";
  s.hours_open = String(SERVICER.hours_open);
  s.hours_close = String(SERVICER.hours_close);
  s.grace_days = String(f.grace_days);
  s.late_pct = pct(f.late_pct);
  s.rate = pct(f.rate_pct);
  s.report_days = String(SERVICER.credit_report_days);
  s.payoff_days = String(SERVICER.payoff_statement_business_days);
  s.shield_days = String(SERVICER.transfer_shield_days);
  s.spread_months = String(SERVICER.shortage_spread_months);
  s.reset_minutes = String(SERVICER.reset_link_minutes);
  s.ack_days = String(SERVICER.qwr_ack_business_days);
  s.mi_request = pct(String(SERVICER.mi_request_ltv_pct));
  s.mi_auto = pct(String(SERVICER.mi_auto_ltv_pct));
  s.mi_request_es = pctEs(String(SERVICER.mi_request_ltv_pct));
  s.mi_auto_es = pctEs(String(SERVICER.mi_auto_ltv_pct));
  m("upb", f.upb);
  if (f.next) {
    m("next_amount", f.next.amount);
    m("next_pi", f.next.pi);
    m("next_escrow", f.next.escrow);
    dt("next_due", f.next.due);
    dt("grace_end", f.next.grace_end);
  }
  if (f.past_due) {
    m("past_due_total", f.past_due.total);
    m("late_charges", f.past_due.late_charges);
    dt("oldest_due", f.past_due.oldest_due);
    s.days = String(f.past_due.days);
    s.days_past = f.past_due.days === 1 ? "1 day" : `${f.past_due.days} days`;
    s.dias = f.past_due.days === 1 ? "1 día" : `${f.past_due.days} días`;
    s.n_installments = String(f.past_due.installments);
  }
  if (f.last_payment) {
    m("last_amount", f.last_payment.amount);
    dt("last_on", f.last_payment.on);
    dt("applied_to", f.last_payment.applied_to);
    m("to_suspense", f.last_payment.to_suspense);
  }
  if (f.escrow_statement) {
    m(
      "esc_balance",
      f.escrow_statement.balance < 0n ? -f.escrow_statement.balance : f.escrow_statement.balance,
    );
    dt("esc_asof", f.escrow_statement.as_of);
  }
  if (f.analysis) {
    const a = f.analysis;
    m("old_escrow", a.old_escrow);
    m("new_escrow", a.new_escrow);
    m("first_escrow", a.first_month_escrow);
    m("old_total", a.old_total);
    m("new_total", a.new_total);
    dt("effective", a.effective);
    dt("sent_on", a.sent_on);
    m("shortage", a.shortage);
    m("surplus", a.surplus);
    m("tax_12m", a.tax_12m);
    m("tax_prior_12m", a.tax_prior_12m);
    m("haz_12m", a.hazard_12m);
    m("haz_prior_12m", a.hazard_prior_12m);
    m("shortage_installment", a.plan.shortage_installment);
    m("deficiency", a.plan.deficiency);
    m("deficiency_installment", a.plan.deficiency_installment);
    m("credit_monthly", a.plan.credit_monthly);
    dt("refund_by", a.plan.refund_by);
    if (a.plan.months !== null) s.plan_months = String(a.plan.months);
  }
  if (f.statement) {
    // Each of the statement's lines by its place: `st1_label`, `st1_month`, `st1_actual`, …
    f.statement.lines.forEach((l, i) => {
      const k = i + 1;
      s[`st${k}_label`] = l.label;
      const es = STATEMENT_LABEL_ES[l.line_type] ?? l.label;
      s[`st${k}_label_es`] = es;
      // "una factura del impuesto del condado": "de el" contracts to "del".
      s[`st${k}_label_del`] = es.startsWith("el ") ? `del ${es.slice(3)}` : `de ${es}`;
      s[`st${k}_month`] = monthYear(l.month);
      s[`st${k}_month_es`] = mesYear(l.month);
      m(`st${k}_actual`, l.actual);
      m(`st${k}_projected`, l.projected);
    });
    if (f.statement.low) {
      m("low_actual", f.statement.low.actual);
      m("low_projected", f.statement.low.projected);
    }
  }
  if (f.arm) {
    s.prior_rate = pct(f.arm.prior_rate);
    s.new_rate = pct(f.arm.new_rate);
    s.prior_rate_es = pctEs(f.arm.prior_rate);
    s.new_rate_es = pctEs(f.arm.new_rate);
    m("new_pi", f.arm.new_pi);
    m("old_pi", f.arm.old_pi);
    dt("change", f.arm.change);
    dt("first_new_payment", f.arm.first_new_payment);
  }
  if (f.tax_paid) {
    m("tax_amount", f.tax_paid.amount);
    dt("tax_on", f.tax_paid.on);
  }
  if (f.hazard_paid) {
    m("haz_amount", f.hazard_paid.amount);
    dt("haz_on", f.hazard_paid.on);
  }
  if (f.refund) {
    m("refund_amount", f.refund.amount);
    dt("refund_on", f.refund.on);
  }
  if (f.late_charge) {
    m("late_amount", f.late_charge.amount);
    dt("late_assessed", f.late_charge.assessed_on);
    dt("late_due", f.late_charge.due);
    dt("late_paid_on", f.late_charge.paid_on);
  }
  if (f.form_1098) {
    s.year_1098 = String(f.form_1098.year);
    m("interest_1098", f.form_1098.interest);
    m("taxes_1098", f.form_1098.taxes);
    dt("mailed_by", f.form_1098.mailed_by);
  }
  dt("mi_terminated_on", f.mi.terminated_on);
  if (f.transfer) {
    dt("transfer_on", f.transfer.on);
    dt("first_due_us", f.transfer.first_due);
    dt("shield_until", f.transfer.shield_until);
  }
  if (f.payoff) {
    dt("payoff_on", f.payoff.on);
    m("payoff_refund", f.payoff.refund);
    dt("payoff_refund_on", f.payoff.refund_on);
  }
  if (f.promise) {
    m("promise_amount", f.promise.amount);
    dt("promise_date", f.promise.pay_by);
  }
  if (f.bankruptcy) {
    s.chapter = String(f.bankruptcy.chapter);
    dt("petition_on", f.bankruptcy.petition_on);
    s.case4 = f.bankruptcy.case_last4;
  }
  if (f.bankruptcy) {
    s.firm = f.bankruptcy.firm;
    s.attorney = f.bankruptcy.attorney;
  }
  dt("auth_on", f.authorization_on);
  if (f.credit) s.credit_month = monthName(`${f.credit.month}-01` as PlainDate);
  return s;
}

/* ── the script being written ───────────────────────────────────────────── */

const LEAD_CALLER: Record<CallPlan["style"], readonly string[]> = {
  brief: ["", "", "", "Yeah, ", "Okay. "],
  chatty: ["Oh, ", "Well, ", "So, ", "Yeah, so ", "Okay so ", "", ""],
  anxious: ["Um, ", "Uh, ", "Okay, um, ", "Sorry, ", "", ""],
  irritated: ["Look, ", "Yeah. ", "Okay. ", "Listen, ", "", ""],
};
const LEAD_AGENT: Record<CallPlan["agent"]["manner"], readonly string[]> = {
  scripted: ["", "", "Certainly. ", "Absolutely. "],
  casual: ["Okay, ", "Alright, ", "So ", "Yeah, ", ""],
  new: ["Um, ", "Okay, let me see. ", "Uh, ", "", ""],
};
const BACKCHANNEL = [
  "Mm-hmm.",
  "Okay.",
  "Right.",
  "Yeah.",
  "Got it.",
  "Uh-huh.",
  "Okay, yeah.",
  "I see.",
  "Sure.",
] as const;

class Script {
  readonly turns: DraftTurn[] = [];
  words = 0;
  constructor(
    readonly r: Rng,
    readonly s: Slots,
    readonly p: CallPlan,
  ) {}

  private push(speaker: Speaker, said: string, tag: string, pii: readonly string[]) {
    const clean = said.trim();
    if (!clean) return;
    this.turns.push({ speaker, said: clean, tag, pii: pii.filter((x) => x && clean.includes(x)) });
    this.words += clean.split(/\s+/).length;
  }
  has(...keys: string[]) {
    return keys.every((k) => this.s[k] !== undefined && this.s[k] !== "");
  }
  agent(templates: readonly string[], tag = "talk", pii: readonly string[] = []) {
    const lead = this.r.chance(0.3) ? this.r.pick(LEAD_AGENT[this.p.agent.manner]) : "";
    this.push(
      this.p.agent2 && this.inTransfer ? "AGENT_2" : "AGENT",
      joinLead(lead, say(this.r, templates, this.s)),
      tag,
      pii,
    );
  }
  caller(templates: readonly string[], tag = "talk", pii: readonly string[] = []) {
    const lead = this.r.chance(0.35) ? this.r.pick(LEAD_CALLER[this.p.style]) : "";
    let text = joinLead(lead, say(this.r, templates, this.s));
    // Personal data is said plainly: a filler inside a date of birth would split it. So is a complaint, whose words
    // the call rubric reads (COMPLAINT_PHRASES): "I want I mean, this escalated" says none of them.
    if (this.p.style !== "brief" && pii.length === 0 && this.r.chance(0.2) && tag !== "complaint")
      text = disfluent(this.r, text);
    this.push("CALLER", text, tag, pii);
  }
  ivr(templates: readonly string[], tag = "ivr") {
    this.push("IVR", say(this.r, templates, this.s), tag, []);
  }
  mark(text: string, seconds: number, tag: string) {
    this.turns.push({ speaker: "SYSTEM", said: text, tag, pii: [], hold_s: seconds });
  }
  back(p = 0.45) {
    if (this.r.chance(p)) this.push("CALLER", this.r.pick(BACKCHANNEL), "backchannel", []);
  }
  inTransfer = false;
}

/** A lead-in and a sentence: "Okay, " and "Sure, I can help" make "Okay, sure, I can help". */
export function joinLead(lead: string, text: string): string {
  if (!lead) return text;
  const l = lead.endsWith(" ") ? lead : `${lead} `;
  if (/[.!?]\s*$/.test(l)) return l + text;
  return l + decap(text);
}

/** Lower-case a sentence's first letter, unless it is "I" or starts a name. */
export function decap(text: string): string {
  if (/^I\b|^I'/.test(text) || !/^[A-Z][a-z]/.test(text)) return text;
  const first = text.split(/[\s,.]/)[0]!;
  if (
    /^(Supermortgage|Spanish|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(
      first,
    )
  )
    return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

const MONTH_WORD =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i;

/** Natural speech: a filler, a repeated word, a restart; never inside a figure or a date. */
function disfluent(r: Rng, text: string): string {
  const words = text.split(" ");
  if (words.length < 5) return text;
  const i = r.int(1, words.length - 2);
  const w = words[i]!;
  const before = words[i - 1]!;
  if (/\d|\$/.test(w) || /\d|\$/.test(before) || MONTH_WORD.test(before.replace(/[,.]$/, "")))
    return text;
  const k = r.int(0, 2);
  if (k === 0) words.splice(i, 0, r.pick(["um,", "uh,", "like,", "you know,"]));
  else if (k === 1 && /^[a-zA-Z']+$/.test(w)) words.splice(i, 0, `${w}-`);
  else words.splice(i, 0, "I mean,");
  return words.join(" ");
}

/* ── the call's parts ───────────────────────────────────────────────────── */

function ivrPrelude(x: Script) {
  const us = x.p.contact.servicer === "us";
  x.ivr(
    us
      ? [
          "Thank you for calling {servicer}. [This call may be monitored or recorded|Calls may be monitored or recorded] for quality [assurance|and training purposes].",
        ]
      : [
          "Thank you for calling {servicer}. Your call [is important to us and |]may be recorded for quality purposes.",
        ],
    "recording_disclosure_ivr",
  );
  x.ivr(["Para español, oprima 2."], "ivr_language");
  if (x.p.language === "es") {
    x.mark("[DTMF 2]", 2, "dtmf");
    x.ivr(["Por favor, ingrese su número de préstamo."], "ivr_loan");
    x.mark("[DTMF]", 6, "dtmf");
    x.ivr(["Gracias. Su llamada será transferida a un representante."], "ivr_transfer");
  } else {
    x.ivr(
      ["Please [enter|say or enter] your loan number[, followed by the pound sign|]."],
      "ivr_loan",
    );
    x.mark("[DTMF]", 6, "dtmf");
    x.ivr(
      [
        "For payment information, press 1. For escrow, taxes or insurance, press 2. For a payoff, press 3. If you are having trouble making your payment, press 4. For all other questions, press 0.",
        "To make a payment or hear your last payment, press 1. For escrow, press 2. For payoff information, press 3. For assistance options, press 4. To speak with a representative, press 0.",
      ],
      "ivr_menu",
    );
    x.mark("[DTMF 0]", 2, "dtmf");
    x.ivr(
      [
        "[Please hold while we transfer your call.|Please hold for the next available representative.|Your call is being transferred.]",
      ],
      "ivr_transfer",
    );
  }
}

function greeting(x: Script) {
  const p = x.p;
  if (p.kind === "inbound" || p.kind === "inbound_unverified") {
    x.agent(
      [
        "[Thank you for calling|Thanks for calling|Good {daypart}, thank you for calling] {servicer}, [this is|my name is|you've reached] {agent}[| speaking]. [How can I help you today?|How may I help you?|Who am I speaking with today?|Can I start with your name?|What can I do for you?]",
      ],
      "greeting",
    );
    return;
  }
  x.agent(
    [
      "[Hi|Hello|Good {daypart}], [may I speak with|is this|I'm trying to reach] {b_full}?",
      "Hi, [I'm looking for|could I speak to] {b_full}[, please|]?",
    ],
    "ask_for",
  );
}

function interpreterJoin(x: Script) {
  x.caller(["[¿Habla español?|Español, por favor.|Perdón, no hablo mucho inglés.]"], "language");
  x.agent(
    [
      "[I'm going to bring an interpreter on the line|Let me get a Spanish interpreter on the line|One moment, I'll connect an interpreter], [one moment|please hold|just a moment].",
    ],
    "interpreter_call",
  );
  x.mark("[conferencing interpreter]", x.p.conference_s, "conference");
  x.turns.push({
    speaker: "INTERPRETER",
    said: say(x.r, [
      "[Spanish interpreter on the line.|Hello, this is the Spanish interpreter.|Interpreter here, go ahead.]",
    ]),
    tag: "interpreter_join",
    pii: [],
  });
}

function callerIntro(x: Script) {
  const p = x.p;
  switch (p.caller.role) {
    case "spouse_not_on_note":
      x.caller(
        [
          "[Hi, |Yeah, hi, |]this is {caller_full}. I'm calling about [my spouse's|my partner's|our] mortgage[, it's in their name|].",
        ],
        "intro",
      );
      return;
    case "housing_counselor":
      x.caller(
        [
          "Hi, my name is {caller_full}[| and] I'm a housing counselor with {agency}. I'm calling on behalf of {b_full}[ about their mortgage|].",
        ],
        "intro",
      );
      return;
    case "attorney":
      x.caller(
        [
          "Good {daypart}, this is {caller_full} [with|from] {firm}. I represent {b_full}.",
          "Hi, this is {caller_full}, I'm an attorney with {firm}, calling about my client {b_full}.",
        ],
        "intro",
      );
      return;
    case "unknown_caller":
      x.caller(
        [
          "Hi, I'm calling about the mortgage on {street}.",
          "Yeah, I need to [check on|ask about] the mortgage for the house on {street}.",
        ],
        "intro",
      );
      return;
    default:
      x.caller(
        [
          "Hi, [yes, |yeah, |]my name is {caller_full}[| and I have a question about my mortgage| and I'm calling about my loan].",
          "[Hi, |]this is {caller_full}[, I'm calling about my mortgage|].",
          "Yeah, hi. {caller_full}[. I had a question about my loan|].",
        ],
        "intro",
      );
  }
}

/** The identity checks: two or three of the loan number, the property address, the last four and the date of birth. */
function verify(x: Script, fail: boolean) {
  const p = x.p;
  const pii = [x.s.ssn4!, x.s.dob_y!, x.s.loan_number!, x.s.dob!];
  const factors = x.r.chance(0.5)
    ? ["address", "ssn"]
    : x.r.chance(0.5)
      ? ["loan", "dob"]
      : ["address", "dob", "ssn"];
  if (x.r.chance(0.3)) factors.reverse();
  x.agent(
    [
      "[I can help with that.|Sure, I can help you with that.|Okay.] [First|Before we get started], [I just need to verify|I'll need to verify|let me verify] [a few things|some information|your identity] [on the account|for security].",
    ],
    "verify_intro",
  );
  for (const f of factors) {
    if (f === "address") {
      x.agent(
        [
          "[Can you verify|Can you give me|What's] the property address?",
          "[And|Okay, and] the [address of the property|property address]?",
        ],
        "verify",
      );
      if (fail && x.r.chance(0.5)) x.caller(["It's {street}."], "verify_answer");
      else
        x.caller(
          ["[It's |]{street}, {city}[, {zip}|].", "{street}[ in {city}|]."],
          "verify_answer",
        );
    } else if (f === "ssn") {
      x.agent(
        [
          "[And|Okay, and] the last four of [your|the borrower's] social?",
          "[Can I get|And] the last four digits of [the|your] Social Security number?",
        ],
        "verify",
      );
      if (fail) {
        x.caller(
          [
            "[I don't have that with me.|I'd have to look that up.|I don't know it off the top of my head.|I'm not sure, it's not my social.]",
          ],
          "verify_fail",
        );
        return;
      }
      x.caller(["{ssn4}.", "[It's |]{ssn4}."], "verify_answer", pii);
    } else if (f === "loan") {
      x.agent(
        ["[Do you have|Do you happen to have] the loan number [handy|in front of you]?"],
        "verify",
      );
      if (x.r.chance(0.6)) x.caller(["[Yeah, it's |Yes, ]{loan_number}."], "verify_answer", pii);
      else {
        x.caller(["[No, I don't have it with me.|Not in front of me, sorry.]"], "verify_answer");
        x.agent(
          [
            "[That's okay|No problem], [I can look you up by the address|I'll find it by the property address]. [What's the address?|Go ahead with the address.]",
          ],
          "verify",
        );
        x.caller(["{street}, {city}."], "verify_answer");
      }
    } else {
      x.agent(
        [
          "[And|Can you verify] [your|the borrower's] date of birth?",
          "[And the date of birth on the account?|What's your date of birth?]",
        ],
        "verify",
      );
      if (fail) {
        x.caller(["[Um, I'm not sure.|I don't know it.|I'd rather not say.]"], "verify_fail");
        return;
      }
      x.caller(["{dob_y}.", "[It's |]{dob_y}."], "verify_answer", pii);
    }
  }
  if (!fail)
    x.agent(
      [
        "[Thank you for verifying|Perfect, thank you|Great, you're verified|Thanks, I've got the account up|Thank you, that matches].",
      ],
      "verify_ok",
    );
  if (p.caller.role === "spouse_not_on_note" && !p.needs.borrower_joins)
    x.agent(
      [
        "[I see you're listed as an authorized party on the account.|You're on file as authorized to discuss the loan.]",
      ],
      "verify_authorized",
    );
}

function refusal(x: Script) {
  x.agent(
    [
      "[I'm sorry|I apologize], but [I'm not able to|I can't] [discuss|share] [any |]account information [unless|until] [I can verify|we can verify] [your identity|that you're authorized on the loan]. [The borrower can call us at|You can have the borrower call us at] {phone}[, and we're open {hours_open} AM to {hours_close} PM|].",
      "[Unfortunately|I'm sorry], without [verification|being able to verify you] I [can't|cannot] [give out|go over] [any details on the loan|anything about the account]. [If the borrower calls us at {phone}, we can help them directly.|The borrower can send us a written authorization, and then we could talk with you.]",
    ],
    "unverified_refusal",
  );
}

function miniMiranda(x: Script) {
  x.agent(
    [
      "[Before we go any further|Before I go over the account|I do need to let you know], this is an attempt to collect a debt[,| and] any information obtained will be used for that purpose.",
      "[I'm required to tell you that|Just so you're aware,] this is a communication from a debt collector. This is an attempt to collect a debt, and any information obtained will be used for that purpose.",
    ],
    "mini_miranda",
  );
  x.back(0.5);
}

function bkDisclaimer(x: Script) {
  x.agent(
    [
      "[Because|Since] [our records show|the account shows] [an active bankruptcy|a bankruptcy filing], [I want to let you know|I need to let you know] this [call|conversation] is for informational purposes only and is not an attempt to collect a debt[ or to impose personal liability|].",
      "[I do have to mention|One thing I have to say first]: [since there's a bankruptcy on the account|because of the bankruptcy], this is not an attempt to collect a debt, [it's informational only|just information about the loan].",
    ],
    "bk_disclaimer",
  );
  x.back(0.4);
}

/* ── statements: one agent turn each, quoting the record ─────────────────── */

const st = {
  lastPayment(x: Script) {
    x.agent(
      [
        "[Yes, I do see|Okay, so I'm showing|I see] a payment of {last_amount} [received|posted|that came in] on {last_on}[, and it was applied to the {applied_to} installment|].",
        "[Your last payment|The most recent payment] was {last_amount}, [received|posted] {last_on}[. It went to the {applied_to} payment|].",
      ].map((t) =>
        // A payment that went to no installment (held in suspense, or all principal): the clause naming one is left out.
        x.has("applied_to") ? t : t.replace(/\[[^[\]]*\{applied_to\}[^[\]]*\|\]/, ""),
      ),
      "quote:last_payment",
    );
  },
  suspense(x: Script) {
    x.agent(
      [
        "[Now,|One thing,] {to_suspense} of that [went into|is being held in] suspense, because it wasn't [enough to cover|a full] [a full payment|payment].",
      ],
      "quote:suspense",
    );
  },
  nextPayment(x: Script, grace = true) {
    x.agent(
      [
        grace && x.has("grace_end")
          ? "[Your next payment|The next installment|The next one], {next_amount}, is due {next_due}[, and you have until {grace_end} before a late charge|. The grace period runs through {grace_end}]."
          : "[Your next payment|The next installment] of {next_amount} is due {next_due}.",
        "[You're all set until|Your next due date is] {next_due}, [and that'll be|for] {next_amount}.",
      ],
      "quote:next_payment",
    );
  },
  pastDue(x: Script) {
    const lc = x.p.facts.past_due && x.p.facts.past_due.late_charges > 0n;
    x.agent(
      [
        lc
          ? "[Our records show|I'm showing|The account shows] the [loan|account] is {days_past} past due, [and|with] [the total needed to bring it current|the amount past due] [at|of] {past_due_total}, [which includes|including] {late_charges} in late charges."
          : "[Our records show|I'm showing|The account shows] the [loan|account] is {days_past} past due, [and|with] {past_due_total} [needed to bring it current|past due].",
        "[Right now|As of today] [it's|the account is] {days_past} behind[, going back to the {oldest_due} payment|], [and the amount to bring it current is|so to get caught up you'd need] {past_due_total}.",
      ],
      "quote:past_due",
    );
  },
  payAmount(x: Script) {
    const behind = x.p.facts.past_due !== null;
    x.agent(
      [
        behind
          ? "[To bring the account current|The amount to get current], [it would be|you'd need] {past_due_total}."
          : "[Your regular payment|The amount due] is {next_amount}[, due {next_due}|].",
      ],
      "quote:pay_amount",
    );
  },
  processed(x: Script) {
    x.agent(
      [
        "[Okay, that's|Alright, I've] [processed|submitted] [your payment of|a payment for] {last_amount}[ effective today|], [and you'll get a confirmation by e-mail|you should see it on your account in a day or two].",
      ],
      "quote:processed",
    );
  },
  analysisChange(x: Script) {
    x.agent(
      [
        "[Your escrow portion is going from|The escrow part of your payment changes from] {old_escrow} to {first_escrow}[ starting with the {effective} payment|], [so your total payment will be|which makes your new total] {new_total}.",
        "[Starting|Beginning] {effective}, your [new|total] payment [will be|is] {new_total}, [because|since] the escrow [went from|changed from] {old_escrow} to {first_escrow}.",
      ],
      "quote:analysis",
    );
  },
  shortage(x: Script) {
    x.agent(
      [
        "[There was|The analysis found] a shortage of {shortage}[, and that's spread over the next {spread_months} months|. We spread that over {spread_months} months unless you'd rather pay it in one lump sum|].",
      ],
      "quote:shortage",
    );
  },
  surplus(x: Script) {
    x.agent(
      [
        x.has("refund_on")
          ? "[The analysis showed a surplus of|You had an overage of] {surplus}[, and the refund for {refund_amount} was mailed on {refund_on}|. We mailed a refund of {refund_amount} on {refund_on}]."
          : "[The analysis showed a surplus of|You had an overage of] {surplus}[, which is being returned to you|].",
      ],
      "quote:surplus",
    );
  },
  taxIncrease(x: Script) {
    x.agent(
      [
        "[The main reason is|It looks like] your [property taxes|county taxes] went up: [we paid|the county was paid] {tax_12m} [this past year|over the last {spread_months} months][,| compared to] {tax_prior_12m} the year before.",
      ],
      "quote:tax_increase",
    );
  },
  hazardIncrease(x: Script) {
    x.agent(
      [
        "[Your insurance premium also went up|The homeowners premium increased too]: {haz_12m} [this year|this past year] [against|compared to] {haz_prior_12m} [last year|the year before].",
      ],
      "quote:hazard_increase",
    );
  },
  escrowBalance(x: Script) {
    const short = x.p.facts.escrow_statement !== null && x.p.facts.escrow_statement.balance < 0n;
    x.agent(
      short
        ? [
            "[As of your last statement|On your last statement], [the escrow account was overdrawn by|we had advanced] {esc_balance}[, because the bills came in higher than what was collected|].",
          ]
        : [
            "[As of your last statement|On your last statement], the escrow balance was {esc_balance}.",
            "[As of your last statement|On your last statement], you had {esc_balance} in escrow.",
          ],
      "quote:escrow_balance",
    );
  },
  arm(x: Script) {
    x.agent(
      [
        "[Your loan is an adjustable-rate mortgage|You have an adjustable rate loan], and the rate [adjusted|changed] on {change}. It went from {prior_rate} to {new_rate}, [so your principal and interest is now|and your new principal and interest is] {new_pi}[, starting with the {first_new_payment} payment|].",
        "The rate [reset|changed] [on|as of] {change}, from {prior_rate} to {new_rate}. [Principal and interest|The P and I] goes from {old_pi} to {new_pi} [with the {first_new_payment} payment|starting {first_new_payment}].",
      ],
      "quote:arm",
    );
  },
  hazardPaid(x: Script) {
    x.agent(
      [
        "[We paid your premium of|The last premium we paid was] {haz_amount} on {haz_on}[ from your escrow account|].",
      ],
      "quote:hazard_paid",
    );
  },
  taxPaid(x: Script) {
    x.agent(
      [
        "[We paid|The county was paid] {tax_amount} on {tax_on}[ out of escrow|].",
        "[The last tax payment|Your last tax disbursement] was {tax_amount}, [sent|paid] on {tax_on}.",
      ],
      "quote:tax_paid",
    );
  },
  form1098(x: Script) {
    x.agent(
      [
        "[It was mailed by|We mailed it on or before] {mailed_by}[, and it's also in the online portal|]. [The interest paid in {year_1098} was|For {year_1098}, the mortgage interest was] {interest_1098}[, and property taxes paid were {taxes_1098}|].",
        "For {year_1098}, [it shows|you paid] {interest_1098} in interest[ and {taxes_1098} in property taxes|]. [It went out by {mailed_by}.|It was mailed by {mailed_by}.]",
      ],
      "quote:form_1098",
    );
  },
  lateFee(x: Script) {
    x.agent(
      [
        x.has("late_paid_on")
          ? "[That late charge of {late_amount} was assessed on|The late fee, {late_amount}, was assessed] {late_assessed}, [because|since] the {late_due} payment [came in|was received] on {late_paid_on}, after the grace period."
          : "[That late charge of {late_amount} was assessed on|The late fee, {late_amount}, was assessed] {late_assessed}, [because|since] the {late_due} payment [wasn't received by the end of the grace period|hadn't come in by the end of the grace period].",
      ],
      "quote:late_fee",
    );
    x.agent(
      [
        "[Payments are due on the first|The payment is due on the first], and [the grace period is|you have] {grace_days} days[ after that|].",
      ],
      "quote:grace",
    );
  },
  upb(x: Script) {
    x.agent(
      [
        "[Your principal balance right now is|The current principal balance is] {upb}[, but the payoff will be higher because it includes interest through the good-through date|].",
      ],
      "quote:upb",
    );
  },
  payoffTiming(x: Script) {
    x.agent(
      [
        "[It'll be sent within|You'll receive it within] {payoff_days} business days[, by e-mail or fax|, and there's no charge for it|].",
      ],
      "quote:payoff_timing",
    );
  },
  payoffDone(x: Script) {
    x.agent(
      [
        "[The loan was paid in full on|I see the loan was paid off on] {payoff_on}. [The lien release is sent to the county for recording|We send the release to the county], [and they mail it to you once it's recorded|which can take a few weeks].",
      ],
      "quote:payoff_done",
    );
    if (x.p.facts.payoff && x.p.facts.payoff.refund > 0n)
      x.agent(
        [
          x.has("payoff_refund_on")
            ? "[Your escrow refund of {payoff_refund} was mailed on {payoff_refund_on}.|We mailed the escrow refund, {payoff_refund}, on {payoff_refund_on}.]"
            : "[Your escrow refund of {payoff_refund} is being processed.|The escrow refund, {payoff_refund}, should go out shortly.]",
        ],
        "quote:payoff_refund",
      );
  },
  transfer(x: Script) {
    x.agent(
      [
        "[Yes, we took over the servicing of your loan on {transfer_on}.|Your loan was transferred to us effective {transfer_on}.] [Your terms don't change|Nothing about your loan terms changes], [just where you send the payment|only who you pay].",
      ],
      "quote:transfer",
    );
    if (x.has("first_due_us"))
      x.agent(
        [
          "[Your first payment to us is the one due {first_due_us}.|The first payment due to us is {first_due_us}.]",
        ],
        "quote:transfer_first_due",
      );
    x.agent(
      [
        "[And for the {shield_days} days starting on the transfer date, through {shield_until}, a payment your previous servicer gets by the end of the grace period won't be considered late.|If the old servicer gets it on time by {shield_until}, the last of the {shield_days} days starting on the transfer date, it won't be late.]",
      ],
      "quote:shield",
    );
  },
  miTerminated(x: Script) {
    x.agent(
      [
        "[Your mortgage insurance was cancelled effective {mi_terminated_on}.|PMI came off the loan as of {mi_terminated_on}.]",
      ],
      "quote:mi_terminated",
    );
  },
  miRules(x: Script) {
    x.agent(
      [
        "[You can request cancellation once the balance reaches|You can ask to cancel it when the principal gets down to] {mi_request} of the original value, [and it ends automatically at {mi_auto}|otherwise it drops off on its own at {mi_auto}].",
      ],
      "quote:mi_rules",
    );
    x.agent(
      ["[Your current principal balance is {upb}.|Right now the balance is {upb}.]"],
      "quote:upb",
    );
  },
  creditRule(x: Script) {
    x.agent(
      [
        "[We report to the credit bureaus every month|We furnish to the bureaus monthly], and a payment is reported late only if it's {report_days} [or more days past due|days or more past due].",
      ],
      "quote:credit_rule",
    );
  },
  bankruptcy(x: Script) {
    x.caller(
      [
        "[I'm calling to let you know|I wanted to notify you] that [my client|{b_full}] filed a chapter {chapter} bankruptcy on {petition_on}. [The case number ends in {case4}.|It's case number ending {case4}.]",
      ],
      "bk_notice",
    );
  },
  promise(x: Script) {
    x.caller(
      [
        "[I can|I'll be able to] [pay|send] {promise_amount} [on|by] {promise_date}.",
        "[I get paid next week, so|Okay, so] [I can do|I'll make a payment of] {promise_amount} [by|on] {promise_date}.",
      ],
      "promise_stated",
    );
    x.agent(
      [
        "[Okay, so I have you down for|Alright, I'll note a promise of|Got it, I'm noting] {promise_amount} by {promise_date}. [You can pay online, over the phone, or by mail.|Do you want to make that by phone or online?|That can be done online or through our automated line.]",
      ],
      "quote:promise",
    );
  },
};

/* ── bodies: why the call was made, and what was said about it ───────────── */

const LOOKUP = [
  "[Let me take a look.|Okay, let me pull that up.|One second here.|Sure, give me just a moment.|Let me check that for you.|Bear with me one second.]",
];

const REASON_ASK: Record<InquiryReason, readonly string[]> = {
  payment_received: [
    "I'm [calling to|trying to] [make sure|see if|check if|confirm] you [got|received] my [last |]payment[| for this month].",
    "I [mailed|sent] my payment [last week|a few days ago|on Monday] and I [just |]want to make sure it [went through|posted].",
    "My bank says the payment cleared, but I [wanted to|just wanted to] double-check on your end.",
  ],
  make_payment: [
    "I [want to|need to|would like to] make a payment[ over the phone| today|].",
    "[How do I|Can I] pay [this month's payment|my mortgage] [by phone|today]?",
  ],
  payment_change: [
    "I [got|received] a [statement|letter|notice] saying my payment [is going up|changed|went up][, and I don't understand why|].",
    "Why did my [mortgage |]payment [change|go up]? [Nobody told me.|I didn't change anything.|It's more than last month.]",
  ],
  rate_change: [
    "I got a letter that my [rate|interest rate] [is changing|went up] and my payment is [changing|going up]. [Can you explain it?|What happened?]",
  ],
  payment_arrangement: [
    "[I know I'm behind|I'm behind on my payment] and I [want to|need to] [set something up|get it taken care of].",
    "I [got|received] [a letter|a call] about my [past due amount|late payment] and I want to [figure out|work out] a plan.",
  ],
  hardship: [
    "{hardship_line} and [I'm behind on|I'm going to have trouble making|I can't make] my [mortgage|payments].",
  ],
  escrow_analysis: [
    "I [got|received] my escrow [analysis|statement] and [I don't understand it|I have some questions about it|the numbers don't make sense to me].",
  ],
  insurance: [
    "I [changed|switched] [insurance companies|homeowners insurance] and [want to make sure you have the new policy|need to know where to send the declarations page].",
    "I have a question about my [homeowners insurance|insurance renewal|insurance policy].",
  ],
  tax: ["I [wanted to make sure|need to know if] my property taxes [were paid|got paid]."],
  form_1098: [
    "I [need|am looking for] my [1098|mortgage interest statement] [for my taxes|for last year].",
  ],
  online_access: [
    "I [can't log in to|got locked out of|forgot my password for] [the website|the online portal|my account online].",
  ],
  autopay_setup: [
    "[I want to|How do I] set up automatic payments?",
    "I'd like to [sign up for|start] autopay.",
  ],
  statement_copy: [
    "[I need a copy of|Can you send me] my [last statement|mortgage statement|escrow statement]?",
  ],
  account_update: ["I [need to|want to] update my [phone number|mailing address|e-mail address]."],
  late_fee: [
    "[Why was I charged|I see a late fee of] {late_amount}[ on my account|]?",
    "I was charged a late fee and I [don't think|don't understand why] [I should have been|it's right].",
  ],
  payoff_request: [
    "I need a payoff [quote|statement][, we're refinancing|, we're selling the house|].",
  ],
  lien_release: [
    "I paid off my loan[ a while ago|] and [haven't gotten the lien release|I'm waiting on my escrow refund].",
  ],
  servicing_transfer: [
    "I got a letter [saying my loan was transferred|from you guys] and I'm [confused|not sure who to pay now].",
    "Who do I pay now? [I got a transfer letter.|My loan got sold or something.]",
  ],
  disaster_assistance: [
    "[We were hit by the storm|Our house was damaged in the storm|We had flooding] and [I don't know if I can make my payment|I wanted to know what help there is].",
  ],
  mi_cancellation: [
    "[I want to get rid of my PMI.|How do I cancel my mortgage insurance?|When does my PMI come off?|Why did my payment go down? Was it the mortgage insurance?]",
  ],
  credit_reporting: [
    "[I'm looking at my credit report|My credit report shows] [and something doesn't look right|a late payment from you].",
  ],
  bankruptcy: [
    "[I filed for bankruptcy and|My attorney said to call you,] [I don't know where to send payments now|I wanted to ask how this works with my mortgage].",
  ],
};

const HARDSHIP_LINE: Record<string, readonly string[]> = {
  job_loss: ["I [lost my job|got laid off] [last month|a few weeks ago]"],
  hours_cut: ["My hours [got cut|were reduced] at work"],
  medical: [
    "I had a [medical emergency|surgery] and I've been out of work",
    "My [husband|wife|son] has been in the hospital",
  ],
  divorce: ["I'm going through a divorce"],
  car: ["My car broke down and [the repair|fixing it] took my [whole check|savings]"],
  family: ["We had a family emergency [out of state|back home]"],
  business: ["My business has been slow[ the last couple of months|]"],
  overtime: ["I lost my overtime[ at work|]"],
};

/**
 * Why the escrow payment changed, answered from the analysis and the annual statement mailed with it: the new
 * payment beside the one on the loan's terms today (the payment the servicing app compares it with), the shortage
 * or surplus and how it is spread or refunded (the statement's items (vi) and (vii), in the words of the servicing
 * app's `decisionText` and `planText`), then item (viii) line by line as its engine writes it, a month's "01/2030"
 * read aloud as "January 2030". A year the engine cannot print the low of (escrow-4) is explained without it, and
 * the agent says so.
 */
function statementCall(x: Script) {
  const f = x.p.facts;
  const a = f.analysis!;
  const s = f.statement!;
  x.agent(
    [
      "[That's the annual escrow analysis we sent on {sent_on}, with your annual escrow statement.|We sent the analysis and the annual statement together on {sent_on}.|That's your yearly escrow analysis. It went out on {sent_on}, with the annual statement.]",
    ],
    "quote:analysis_sent",
  );
  // The payment on the loan's terms is the old one until the effective date's payment, and the new one from it: a call
  // on or after that day says the change in the past tense, never that the old payment is today's.
  const changed = f.on >= a.effective;
  x.agent(
    changed
      ? [
          "[Before the change|Until the {effective} payment] the escrow part of your payment was {old_escrow}. [Starting with the {effective} payment it became|From the {effective} payment on, it's been] {new_escrow}.",
          "The analysis [set|changed] your escrow payment from {old_escrow} to {new_escrow}, starting with the {effective} payment.",
        ]
      : [
          "[Right now|Today] the escrow part of your payment is {old_escrow}. [Starting with the {effective} payment it will be|From the {effective} payment on, it's] {new_escrow}.",
          "The analysis [sets|changes] your escrow payment from {old_escrow} to {new_escrow}, starting with the {effective} payment.",
        ],
    "quote:analysis_compare",
  );
  if (a.first_month_escrow !== a.new_escrow)
    x.agent(
      [
        changed
          ? "[That first month it was|The first payment at the new amount carried] {first_escrow}[ of escrow|], because of the credit."
          : "[That first month it's|The first payment at the new amount carries] {first_escrow}[ of escrow|], because of the credit.",
      ],
      "quote:analysis_first",
    );
  x.agent(
    [
      changed
        ? "[So your total payment|With principal and interest, your payment] [was|came to] {new_total}[ that month|]."
        : "[So your total payment|With principal and interest, your payment] [will be|comes to] {new_total}[ that month|].",
    ],
    "quote:analysis_total",
  );
  x.back(0.5);
  if (a.decision === "shortage" && a.plan.deficiency !== null)
    x.agent(
      [
        "The analysis found a deficiency of {deficiency} and a shortage of {shortage}. [Each is spread over|We spread both over] {plan_months} months: {shortage_installment} a month for the shortage and {deficiency_installment} a month for the deficiency, beginning with the {effective} payment.",
      ],
      "quote:deficiency_plan",
    );
  else if (a.decision === "shortage")
    x.agent(
      [
        "[The analysis found|There's] a shortage of {shortage}. [That's spread over|We spread that over] {plan_months} months, {shortage_installment} a month for {plan_months} months beginning with the {effective} payment.",
      ],
      "quote:shortage_plan",
    );
  else if (a.decision === "refund") {
    x.agent(
      [
        "[The analysis found|There's] a surplus of {surplus}, [and it's being refunded to you by|which we're refunding to you by] {refund_by}.",
      ],
      "quote:refund_plan",
    );
    if (f.refund && f.refund.amount === a.surplus)
      x.agent(
        ["[That refund went out on {refund_on}.|We mailed it on {refund_on}.]"],
        "quote:refund_sent",
      );
  } else if (a.decision === "credit")
    x.agent(
      [
        "[The analysis found|There's] a surplus of {surplus}. [It's credited against next year's payments at|It comes off next year's payments at] {credit_monthly} a month.",
      ],
      "quote:credit_plan",
    );
  else x.agent(["The analysis found no surplus, shortage or deficiency."], "analysis_balanced");
  // The low point is promised only where the statement compares it: an overdrawn year has no low line (escrow-4), nor
  // does a year whose low was the projected one.
  if (s.low !== null || s.lines.length === 0)
    x.agent(
      [
        "[The annual statement shows why|Your annual statement explains it]: [what came in differently from last year's projection|the bills that came in other than we projected], and [the low point of the account|where the balance bottomed out].",
      ],
      "stmt_intro",
    );
  else
    x.agent(
      [
        "[The annual statement shows why|Your annual statement explains it]: [what came in differently from last year's projection|the bills that came in other than we projected].",
      ],
      "stmt_intro_bills",
    );
  s.lines.forEach((l, i) => {
    const sub = (t: string) => t.replace(/\{st_/g, `{st${i + 1}_`);
    if (l.kind === "differs")
      x.agent(
        [
          "[The|Your] {st_label} paid in {st_month} was {st_actual} versus {st_projected} projected.",
          "[On the statement,|The statement shows] the {st_label} paid in {st_month} was {st_actual}, against {st_projected} projected.",
        ].map(sub),
        `quote:stmt_moved:${i + 1}`,
      );
    else
      x.agent(
        [
          "[There's also|And there was] a {st_label} bill of {st_actual} paid in {st_month}[, which wasn't projected| that wasn't projected].",
          "A {st_label} bill of {st_actual} was paid in {st_month}, and that one wasn't projected at all.",
        ].map(sub),
        `quote:stmt_unprojected:${i + 1}`,
      );
    // Whether the call is before the bill or after it, the statement shows what the analysis counted on.
    if (l.anticipated)
      x.agent(
        [
          "[That one falls after the analysis date, so the statement shows the amount the analysis expected.|That bill is dated after the analysis ran, so the statement shows what the analysis counted on.]",
        ],
        "stmt_anticipated",
      );
    x.back(0.4);
  });
  if (s.overdrawn)
    x.agent(
      [
        "[I'll be straight with you:|One thing I should tell you plainly:] the account was overdrawn during the year, so the statement doesn't compare your low balance with the projected one.",
      ],
      "stmt_overdrawn",
    );
  else if (s.low)
    x.agent(
      [
        s.low.is_cushion
          ? "[And|So] the low balance was {low_actual} versus {low_projected} projected[. The projected low is the cushion.|, and that projected low is the cushion we keep.]"
          : "[And|So] the low balance was {low_actual} versus {low_projected} projected.",
      ],
      "quote:stmt_low",
    );
  else if (!s.lines.length)
    x.agent(
      [
        "[Everything on the statement came in as projected.|The year went as projected: no bill came in differently.]",
      ],
      "stmt_as_projected",
    );
  if (a.decision === "shortage") {
    x.caller(
      [
        "[Can I pay the shortage now instead?|So if I pay the shortage, my payment goes down?|What if I pay that off?]",
      ],
      "ask",
    );
    x.agent(
      [
        "[Yes,|You can,] if you pay the shortage in full, [we'll recalculate|the payment would be recalculated] without it[, and it would just be the new base escrow|].",
      ],
      "explain",
    );
  }
  x.agent(
    [
      "[We also keep a cushion of up to two months of escrow payments, which the law allows.|Part of it is the cushion, which is up to two months of escrow.]",
    ],
    "explain",
  );
}

function body(x: Script, reason: InquiryReason, primary: boolean) {
  const f = x.p.facts;
  const prefix = primary
    ? ""
    : expand(x.r, "[While I have you, |Also, |Oh, and one more thing, |One other thing. |]");
  const ask = REASON_ASK[reason].map((t) => (prefix ? joinLead(prefix, expand(x.r, t, x.s)) : t));
  const tag = `reason:${reason}`;
  if (reason === "bankruptcy" && x.p.caller.role === "attorney") {
    // The attorney's notice is the reason for the call, and how the servicer learns of the case.
    st.bankruptcy(x);
    x.agent(
      [
        "[Thank you for letting us know.|Okay, I'll get that noted.] [I'll flag the account|We'll place the account in bankruptcy status], [and collection activity will stop|and refer it to our bankruptcy team]. [Can you send a copy of the notice of filing?|Please fax or mail the notice to our bankruptcy department.]",
      ],
      "bk_ack",
    );
    x.caller(
      ["[It's going out today.|We'll send it over.|You should have it this week.]"],
      "react",
    );
    x.agent(
      [
        "[Going forward, please direct anything on the loan to our bankruptcy department.|We'll communicate through your office from here on.]",
      ],
      "bk_ack",
    );
    return;
  }
  if (reason === "hardship" && x.p.needs.hardship) {
    const line = x.r.pick(HARDSHIP_LINE[x.p.needs.hardship]!);
    x.caller(
      [
        expand(x.r, line, x.s) +
          " and [I'm behind on|I'm going to have trouble making|I can't make] my [mortgage|payments].",
      ],
      tag,
    );
  } else if (reason !== "late_fee" || x.has("late_amount")) x.caller(ask, tag);
  else
    x.caller(
      ["I was charged a late fee and I don't [think|understand why] I should have been."],
      tag,
    );
  if (x.r.chance(0.7)) x.agent(LOOKUP, "lookup");
  switch (reason) {
    case "payment_received":
      if (f.last_payment && daysBetween(f.last_payment.on, f.on) <= 40) {
        st.lastPayment(x);
        if (f.last_payment.to_suspense > 0n) st.suspense(x);
        if (f.last_payment.forwarded)
          x.agent(
            [
              "[That one was forwarded to us by your previous servicer.|It looks like it went to your prior servicer and they forwarded it to us.]",
            ],
            "forwarded",
          );
      } else {
        x.agent(
          [
            f.last_payment
              ? "[I'm not seeing|I don't see] [anything|a new payment] posted [since|after] {last_on}."
              : "[I'm not seeing a payment posted yet.|Nothing has posted yet.]",
          ],
          f.last_payment ? "quote:no_payment" : "no_payment",
        );
        x.caller(["[Oh no.|Hmm.|Okay, that's weird.|Really?]"], "react");
        x.agent(
          [
            "[If you mailed it, it can take a few days to arrive and post.|Sometimes it takes a couple of business days to show up.|If it was mailed, give it a few more days.]",
          ],
          "advise",
        );
      }
      if (f.past_due) st.pastDue(x);
      else if (f.next) st.nextPayment(x);
      break;
    case "make_payment":
      if (f.last_payment && f.last_payment.on === f.on) {
        // Nothing to quote when the borrower is current and no installment is left to come (until contact-audit's
        // busier books reached one, this threw rather than wrote the call).
        if (f.past_due || f.next) st.payAmount(x);
        x.agent(
          ["[Is that coming from checking or savings?|What account would you like to use?]"],
          "ask_account",
        );
        x.caller(
          [
            "[Checking.|It's checking.] The routing number is ‹routing number› and the account is ‹account number›.",
          ],
          "account",
          ["‹routing number›", "‹account number›"],
        );
        st.processed(x);
      } else {
        if (f.past_due || f.next) st.payAmount(x);
        x.agent(
          [
            "[You can pay online, through our automated line, or by mail.|The easiest way is online, but you can also use the automated phone line or mail a check.]",
          ],
          "payment_ways",
        );
        x.caller(
          [
            "[Okay, I'll do it online.|I'll just do it through the website then.|Okay, I'll mail it.]",
          ],
          "react",
        );
      }
      break;
    case "payment_change":
    case "escrow_analysis":
      if (reason === "escrow_analysis" && f.analysis && f.statement) statementCall(x);
      else if (f.analysis) {
        if (reason === "escrow_analysis" && x.r.chance(0.5))
          x.agent(
            [
              "[That's the annual escrow analysis we sent on {sent_on}.|We sent that analysis on {sent_on}.]",
            ],
            "quote:analysis_sent",
          );
        else
          x.agent(
            [
              "[That's from your annual escrow analysis.|That would be your yearly escrow review.|What happened is your escrow was reanalyzed.]",
            ],
            "explain",
          );
        if (f.analysis.surplus !== null && f.analysis.surplus > 0n) st.surplus(x);
        st.analysisChange(x);
        if (f.analysis.shortage !== null && f.analysis.shortage > 0n) {
          st.shortage(x);
          x.caller(
            [
              "[Can I pay the shortage now instead?|So if I pay the shortage, my payment goes down?|What if I pay that off?]",
            ],
            "ask",
          );
          x.agent(
            [
              "[Yes,|You can,] if you pay the shortage in full, [we'll recalculate|the payment would be recalculated] without it[, and it would just be the new base escrow|].",
            ],
            "explain",
          );
        }
        if (f.analysis.tax_prior_12m > 0n && f.analysis.tax_12m > f.analysis.tax_prior_12m)
          st.taxIncrease(x);
        if (f.analysis.hazard_prior_12m > 0n && f.analysis.hazard_12m > f.analysis.hazard_prior_12m)
          st.hazardIncrease(x);
        x.agent(
          [
            "[We also keep a cushion of up to two months of escrow payments, which the law allows.|Part of it is the cushion, which is up to two months of escrow.]",
          ],
          "explain",
        );
      } else if (f.arm) st.arm(x);
      else if (f.last_payment && f.last_payment.to_suspense > 0n) {
        st.lastPayment(x);
        st.suspense(x);
      } else if (f.escrowed && f.escrow_statement) st.escrowBalance(x);
      if (f.next && reason === "payment_change") st.nextPayment(x, false);
      break;
    case "rate_change":
      if (f.arm) st.arm(x);
      else if (f.next) st.nextPayment(x, false);
      x.caller(
        ["[Is it going to keep going up?|How often does it change?|Can it go higher than that?]"],
        "ask",
      );
      x.agent(
        [
          "[It can change again at each adjustment date, within the caps in your note.|There are caps in your note that limit how much it can move at each change.]",
        ],
        "explain",
      );
      break;
    case "payment_arrangement":
      if (f.past_due) st.pastDue(x);
      else if (f.next) st.nextPayment(x);
      if (x.p.needs.promise) st.promise(x);
      else if (x.p.needs.bk_disclaimer)
        // In a bankruptcy case nobody is asked when they will pay: that is an act to collect.
        lossmitOptions(x);
      else {
        x.agent(
          [
            "[When do you think you'll be able to make a payment?|What are you able to do right now?]",
          ],
          "ask_when",
        );
        x.caller(
          [
            "[I'm not sure yet.|Probably at the end of the month, I'll have to see.|I'm waiting on a check.]",
          ],
          "react",
        );
        lossmitOptions(x);
      }
      break;
    case "hardship":
      x.agent(
        [
          "[I'm sorry to hear that.|I'm really sorry you're going through that.|That's a lot, I'm sorry.]",
        ],
        "empathy",
      );
      if (f.past_due) st.pastDue(x);
      if (x.p.needs.promise) st.promise(x);
      lossmitOptions(x);
      break;
    case "insurance":
      if (f.hazard_paid && f.escrowed) st.hazardPaid(x);
      x.agent(
        [
          f.escrowed
            ? "[If you've changed carriers,|For a new policy,] [have your agent send us the declarations page|we'll need a copy of the declarations page], [by fax, mail, or upload in the portal|you can upload it in the portal]."
            : "[Since you pay your own insurance,|Because the loan isn't escrowed,] we just need proof of coverage[ each year|]: the declarations page.",
        ],
        "explain",
      );
      break;
    case "tax":
      if (f.escrowed && f.tax_paid) st.taxPaid(x);
      else
        x.agent(
          [
            "[Your loan isn't escrowed, so you pay the taxes directly to the county.|We don't pay the taxes on your loan, since there's no escrow account.]",
          ],
          "explain",
        );
      break;
    case "form_1098":
      if (f.form_1098) st.form1098(x);
      else
        x.agent(
          [
            "[I'm not showing interest reported for last year on this account.|There wasn't any interest paid to us last year, so there's no 1098 from us.]",
          ],
          "explain",
        );
      break;
    case "online_access":
      x.agent(
        [
          "[I can help with that.|No problem.] [I'll send a password reset link to the e-mail on file|I'm sending you a reset link now]. [The link is good for {reset_minutes} minutes.|It expires in {reset_minutes} minutes.]",
        ],
        "quote:reset",
      );
      x.caller(
        ["[Got it, it just came through.|Okay, I see it.|Hold on, let me check. Yeah, I got it.]"],
        "react",
      );
      break;
    case "autopay_setup":
      x.agent(
        [
          "[I can set that up for you|You can enroll online, or I can do it over the phone]. [The draft comes out on your due date each month.|We'd draft the full payment on the due date.]",
        ],
        "explain",
      );
      x.caller(
        [
          "[Let's do it over the phone.|Okay, go ahead.] The routing number is ‹routing number› and the account number is ‹account number›.",
        ],
        "account",
        ["‹routing number›", "‹account number›"],
      );
      x.agent(
        [
          "[You're enrolled.|That's all set up.] [It'll start with your next payment.|You'll get a confirmation letter.]",
        ],
        "resolve",
      );
      break;
    case "statement_copy":
      x.agent(
        [
          "[I can mail a copy to the address on file, or you can download it from the portal.|It's in the portal under documents, but I can also mail one out.]",
        ],
        "explain",
      );
      x.caller(["[Mail it, please.|I'll just get it online.]"], "react");
      if (f.escrowed && f.escrow_statement && x.r.chance(0.5)) st.escrowBalance(x);
      break;
    case "account_update":
      x.agent(["[Sure, what's the new information?|Okay, go ahead.]"], "ask");
      x.caller(
        ["[It's ‹new contact information›.|The new one is ‹new contact information›.]"],
        "update",
        ["‹new contact information›"],
      );
      x.agent(
        ["[I've updated that for you.|That's been updated.|Okay, that's changed in the system.]"],
        "resolve",
      );
      break;
    case "late_fee":
      if (f.late_charge) st.lateFee(x);
      else
        x.agent(
          [
            "[I'm not showing a late charge on the account right now.|There's no late fee showing currently.]",
          ],
          "explain",
        );
      x.caller(
        [
          "[Can you waive it?|Is there any way to get that removed?|This is the first time I've been late.]",
        ],
        "ask",
      );
      x.agent(
        [
          "[I can submit a waiver request,|I'll send a request to have it reviewed,] [but I can't promise it'll be approved|and you'll hear back in a few days].",
        ],
        "resolve",
      );
      break;
    case "payoff_request":
      x.agent(
        [
          "[I can request that for you.|Sure, I'll order a payoff statement.|I can get that started.]",
        ],
        "resolve",
      );
      st.upb(x);
      st.payoffTiming(x);
      x.caller(["[Can you e-mail it?|Can it go to my title company?|Okay, perfect.]"], "react");
      x.agent(
        [
          "[Yes, we can send it to you or to the title company with your authorization.|We can e-mail it to you, and the title company can request one too.]",
        ],
        "explain",
      );
      break;
    case "lien_release":
      if (f.payoff) st.payoffDone(x);
      else
        x.agent(
          ["[I'm not showing the loan as paid off yet.|The loan still shows active on my end.]"],
          "explain",
        );
      break;
    case "servicing_transfer":
      if (f.transfer) {
        st.transfer(x);
        x.agent(
          ["[Your loan number with us ends in {loan4}.|The new loan number ends in {loan4}.]"],
          "quote:loan4",
        );
      } else
        x.agent(
          [
            "[We've been servicing your loan for a while now.|Your loan has been with us for some time.]",
          ],
          "explain",
        );
      if (f.next) st.nextPayment(x, false);
      break;
    case "disaster_assistance":
      x.agent(
        ["[I'm so sorry to hear that.|I'm really sorry, I hope you and your family are okay.]"],
        "empathy",
      );
      x.agent(
        [
          "[Since you're in a declared disaster area, there are options|We do have disaster assistance options], [like pausing or reducing payments for a while|including a forbearance]. [Nothing is decided on this call, but I can get it started.|A specialist will go over what you qualify for.]",
        ],
        "lossmit",
      );
      x.agent(
        [
          "[If you file an insurance claim, the check will usually be made out to you and to us, and we'll help with the endorsement.|Make sure you file a claim with your insurance company.]",
        ],
        "explain",
      );
      break;
    case "mi_cancellation":
      if (f.mi.terminated_on) st.miTerminated(x);
      else if (f.mi.active) st.miRules(x);
      else
        x.agent(
          ["[I'm not showing mortgage insurance on this loan.|There's no PMI on your loan.]"],
          "explain",
        );
      break;
    case "credit_reporting":
      st.creditRule(x);
      if (!f.credit)
        x.agent(
          [
            "[I'd have to look at the history to see what was reported.|Nothing has been reported on this loan yet.]",
          ],
          "credit_status",
        );
      else if (f.credit.days >= 30)
        x.agent(
          [
            "[The {credit_month} report shows the account past due.|For {credit_month}, it was reported past due.]",
          ],
          "credit_status",
        );
      else
        x.agent(
          [
            "[The last report shows the account current.|For {credit_month}, we reported it current.]",
          ],
          "credit_status",
        );
      x.caller(["[I want to dispute it.|How do I dispute that?|Okay, that makes sense.]"], "ask");
      x.agent(
        [
          "[You can dispute it with us in writing, or through the credit bureau.|If you think it's wrong, you can send us a written dispute and we'll investigate.]",
        ],
        "explain",
      );
      break;
    case "bankruptcy":
      x.agent(
        [
          "[Since you're in an active chapter {chapter} case, I'd check with your attorney about how payments are handled under the plan.|Your attorney can tell you how the mortgage payments are handled in the case.]",
        ],
        "explain",
      );
      if (f.next) st.nextPayment(x, false);
      break;
  }
}

function lossmitOptions(x: Script) {
  x.agent(
    [
      "[If you're having trouble making your payments,|If you're experiencing a hardship,] [there are options that might help|we have assistance programs][, like a repayment plan, a forbearance or a modification|]. [I can't tell you which one you'd qualify for until you apply.|You'd need to complete an application so we can review it.]",
    ],
    "lossmit",
  );
  x.caller(
    ["[Yeah, please send it.|Okay, sure.|I'll think about it.|What do I need to send?]"],
    "react",
  );
  x.agent(
    [
      "[I'll mail you an application today, and you can also apply online.|You'll get a package in the mail with everything we need.|I'm sending the application to the address on file.]",
    ],
    "lossmit_package",
  );
}

function creditQuestion(x: Script) {
  x.caller(
    [
      "[Is this going to|Will this] [hurt|affect|show up on] my credit?",
      "Is this going on my credit report?",
    ],
    "credit_question",
  );
  x.agent(
    [
      "[I can't tell you it won't.|I don't want to give you the wrong idea.] We report to the credit bureaus every month, and a payment that's {report_days} days or more past due is reported as late.",
      "[I have to be honest with you,|To be upfront,] if a payment is {report_days} or more days past due when we report, it does show as late on your credit.",
    ],
    "credit_answer",
  );
}

function complaint(x: Script) {
  x.caller(
    [
      "[Honestly,|You know what,|I have to say,] I'm [really|very] [unhappy|frustrated|upset] with [how this has been handled|the service I've gotten|this whole thing]. [I want to file a complaint.|This is ridiculous.|I've called before about this and nobody fixed it.]",
      "[This is the third time I've called about this|Nobody ever calls me back] and I'm [done|fed up]. I want this [escalated|written up as a complaint].",
    ],
    "complaint",
  );
  x.agent(
    [
      "[I'm sorry to hear that|I understand your frustration|I apologize for the trouble], [and I'm going to document this as a complaint|I'm documenting your complaint now|I've logged this as a formal complaint], [so it gets reviewed|and our resolution team will review it][, and you'll receive a written response|].",
    ],
    "complaint_ack",
  );
}

function transferOut(x: Script) {
  x.agent(
    [
      "[Let me|I'm going to] transfer you to [our loss mitigation team|a specialist in our homeowner assistance department|someone who handles assistance options], [they'll be able to go over the options with you|they can help you with the next steps]. [Please hold.|One moment.|Stay on the line.]",
    ],
    "transfer",
  );
  x.mark("[transferring]", x.p.transfer_s, "transfer_hold");
  x.inTransfer = true;
  x.agent(
    [
      "[Homeowner assistance, this is|Thank you for holding, this is|Hi, this is] {agent2}. [I just need to verify a couple of things again.|Can you verify the property address for me?|I have your account up, can you confirm the address?]",
    ],
    "greeting_2",
  );
  x.caller(["{street}[, {city}|]."], "verify_answer");
  x.agent(
    [
      "[Thank you.|Okay, thanks.] [I see what's going on with the account.|I have the notes from my colleague.] [Tell me a little about what's happening.|Can you walk me through the situation?]",
    ],
    "lossmit",
  );
  x.caller(
    [
      "[Like I said,|Yeah, so] {hardship_short}, and I [just need some time|want to keep the house|need to know my options].",
    ],
    "story",
  );
  x.agent(
    [
      "[What we'll do is get an application from you, and once it's complete we'll review you for every option we have.|The next step is the application. Once we have everything, we evaluate you for all the options.] [I can't promise a specific option on the call.|I can't tell you the outcome today.]",
    ],
    "lossmit",
  );
  x.caller(["[Okay.|Alright, that makes sense.|How long does that take?]"], "react");
  x.agent(
    [
      "[You'll get a letter once we receive it, and another if we need anything else.|We'll send you a letter acknowledging it, and we'll call if anything's missing.]",
    ],
    "lossmit",
  );
}

/* ── side topics: the long middle of a long call ─────────────────────────── */

function topic(x: Script, t: Topic) {
  switch (t) {
    case "confirm_phone":
      x.agent(
        [
          "[Is the number ending in {phone4} still the best number to reach you?|I have a phone number ending in {phone4}, is that still good?]",
        ],
        "confirm_phone",
        [x.s.phone4!],
      );
      x.caller(
        [
          "[Yes, that's my cell.|Yeah, that's fine.|That's my work number, actually, but it's okay.]",
        ],
        "react",
      );
      return;
    case "confirm_email":
      x.agent(
        ["[And is your e-mail still|Can I confirm the e-mail on file,] ‹e-mail address›?"],
        "confirm_email",
        ["‹e-mail address›"],
      );
      x.caller(["[Yes.|That's right.|Yep, that's it.]"], "react");
      return;
    case "paperless":
      x.agent(
        [
          "[Would you like to go paperless?|Did you know you can get your statements by e-mail instead of mail?] [It's faster, and you can still print them.|You'd get an e-mail when each statement is ready.]",
        ],
        "paperless",
      );
      x.caller(
        [
          "[No, I like getting the paper.|Sure, why not.|Maybe later.|Yeah, go ahead and sign me up.]",
        ],
        "react",
      );
      return;
    case "autopay_offer":
      x.agent(
        [
          "[Have you thought about automatic payments?|We do offer autopay, by the way.] [It comes out on the due date, so you never have to worry about it.|There's no fee, and you can stop it anytime.]",
        ],
        "autopay_offer",
      );
      x.caller(
        [
          "[I'd rather pay it myself.|Not right now.|Maybe, I'll look into it.|I'll think about it.]",
        ],
        "react",
      );
      return;
    case "text_offer":
      x.agent(
        [
          "[Would you like text reminders before your due date?|We can send you text message reminders, if you want.] [You can opt out anytime by replying STOP.|Message and data rates may apply.]",
        ],
        "text_offer",
      );
      x.caller(["[No thanks.|I get too many texts already.|Not right now.]"], "react");
      return;
    case "portal_offer":
      x.agent(
        [
          "[Are you registered for our online portal?|Do you use our website at all?] [You can see your payments, escrow and statements there.|Everything we talked about today is on there too.]",
        ],
        "portal_offer",
      );
      x.caller(
        ["[No, I've never set it up.|I keep meaning to.|I'm not really a computer person.]"],
        "react",
      );
      x.agent(
        [
          "[It just takes a few minutes with your loan number.|You'd just need your loan number and the property ZIP code.]",
        ],
        "portal_offer",
      );
      return;
    case "small_talk":
      x.caller(
        [
          "[Sorry, my dog is barking.|Hold on, sorry, my kids are being loud.|Sorry, I'm at work so I have to be quick.|Sorry, I'm driving.]",
          "[It's been such a crazy week.|This weather has been something, huh?|I've been meaning to call for days.]",
        ],
        "small_talk",
      );
      x.agent(
        ["[No problem at all.|Oh, no worries.|Take your time.|I completely understand.]"],
        "small_talk",
      );
      return;
    case "system_slow":
      x.agent(
        [
          "[Sorry, my system is running a little slow today.|Bear with me, the screen is loading.|Thanks for your patience, my computer is being slow.]",
        ],
        "system_slow",
      );
      x.back(0.8);
      return;
    case "repeat_figure": {
      const f = x.p.facts;
      x.caller(
        [
          "[By the way, what's the amount due right now?|And what do I owe right now, exactly?|What's the payment amount right now, by the way?]",
        ],
        "repeat_ask",
      );
      if (f.past_due)
        x.agent(["[Sure,|Of course,] {past_due_total}[ to bring it current|]."], "quote:repeat");
      else if (f.next)
        x.agent(["[Sure,|Of course,] {next_amount}[, due {next_due}|]."], "quote:repeat");
      else x.agent(["[The principal balance is|It's] {upb}."], "quote:repeat");
      x.caller(["[Okay, let me write that down.|Got it, thanks.|Okay.]"], "react");
      return;
    }
    case "spell_name":
      x.agent(
        [
          "[Can you spell your last name for me?|And just to make sure I have it right, how do you spell the last name?]",
        ],
        "spell",
      );
      x.caller(
        [
          `${(x.p.caller.full ?? x.p.borrower.full).split(" ").pop()!.toUpperCase().split("").join("-")}.`,
        ],
        "spell",
      );
      return;
    case "mailing_address":
      x.agent(
        [
          "[Is your mailing address the same as the property?|Do you still get mail at the property address?]",
        ],
        "mailing",
      );
      x.caller(["[Yes, same address.|Yeah, that's where I live.|Yes.]"], "react");
      return;
    case "survey":
      x.agent(
        [
          "[You might get a short survey after this call about how I did today.|After the call, there may be a quick survey, if you have a minute.]",
        ],
        "survey",
      );
      x.caller(["[Sure.|Okay.|No problem.]"], "react");
      return;
    case "hours":
      x.agent(
        [
          "[If you need anything else, we're open {hours_open} AM to {hours_close} PM.|You can reach us at {phone} anytime between {hours_open} AM and {hours_close} PM.]",
        ],
        "hours",
      );
      x.back(0.6);
      return;
    case "payment_options":
      x.agent(
        [
          "[You can pay online, through the automated phone line, or by mail.|Just so you know, the fastest ways to pay are online or through the automated line.] [Mailed payments take a few extra days to post.|If you mail it, give it about a week.]",
        ],
        "payment_ways",
      );
      x.back(0.6);
      return;
    case "occupancy_check":
      x.agent(
        [
          "[Is the property still your primary residence?|And you still live in the home, correct?|Just confirming, the house is still your primary residence?]",
        ],
        "occupancy_check",
      );
      x.caller(["[Yes, we live there.|Yeah, still there.|Yes, that's home.]"], "react");
      return;
    case "insurance_check":
      x.agent(
        [
          "[Do you still have your homeowners insurance with the same company?|Has your homeowners insurance company changed at all this year?]",
        ],
        "insurance_check",
      );
      x.caller(
        ["[Yes, same one.|No, it's the same company.|I think so, I'd have to check.]"],
        "react",
      );
      if (x.r.chance(0.5))
        x.agent(
          [
            "[If it ever changes, just have the new company send us the declarations page.|If you switch, we'll need the new declarations page, so we don't end up placing coverage.]",
          ],
          "insurance_check",
        );
      return;
    case "scra_check":
      x.agent(
        [
          "[Is anyone on the loan currently on active military duty?|Are you or anyone on the loan serving on active duty in the military?]",
        ],
        "scra_check",
      );
      x.caller(["[No.|No, nobody.|No, not anymore.]"], "react");
      x.agent(
        [
          "[Okay, thank you. If that changes, let us know, because there are protections that apply.|Thanks. If anyone is called to active duty, please tell us, there are protections for that.]",
        ],
        "scra_check",
      );
      return;
    case "statement_delivery":
      x.agent(
        [
          "[Are you getting your monthly statements okay?|Have your statements been coming every month?]",
        ],
        "statement_delivery",
      );
      if (x.r.chance(0.7))
        x.caller(["[Yeah, they come every month.|Yes, no problems there.]"], "react");
      else {
        x.caller(
          [
            "[Actually, I didn't get the last one.|I haven't seen one in a while, now that you mention it.]",
          ],
          "react",
        );
        x.agent(
          [
            "[I'll make a note and have a copy mailed out.|Let me request a copy for you, and I'll check that the address is right.]",
          ],
          "statement_delivery",
        );
      }
      return;
    case "fraud_warning":
      x.agent(
        [
          "[Just a reminder, we'll never ask for your full Social Security number by e-mail or text, so if you get something like that, call us.|One thing we're telling everyone: we will never ask you to send a payment somewhere new by e-mail, so if you get a message like that, call the number on your statement first.]",
        ],
        "fraud_warning",
      );
      x.caller(["[Good to know.|Oh, wow. Okay.|Yeah, I've gotten some weird texts.]"], "react");
      return;
    case "statement_walkthrough":
      x.agent(
        x.p.facts.escrowed
          ? [
              "[On your statement, the amount due is broken into principal and interest, and escrow.|Your statement shows the principal and interest and the escrow separately.] [The principal and interest is {next_pi}|Principal and interest is {next_pi}][, and escrow is {next_escrow}|].",
            ]
          : [
              "[On your statement, the amount due is your principal and interest.|Your statement shows the principal and interest due.] [That's {next_pi}.|It comes to {next_pi}.] [Since there's no escrow, taxes and insurance are paid by you directly.|There's no escrow on this loan.]",
            ],
        "quote:statement",
      );
      x.caller(
        ["[Oh, okay.|That makes more sense.|I never really looked at it that closely.]"],
        "react",
      );
      return;
  }
}

function recapAndClose(x: Script) {
  const f = x.p.facts;
  if (x.r.chance(0.6)) {
    if (x.p.needs.promise)
      x.agent(
        [
          "[So just to recap|Okay, so to summarize|Alright, so], [you'll be paying|I have] {promise_amount} by {promise_date}.",
        ],
        "quote:recap",
      );
    else if (f.past_due && !f.bankruptcy)
      x.agent(
        [
          "[So just to recap|Okay, so to summarize], the amount to bring the account current is {past_due_total}.",
        ],
        "quote:recap",
      );
    else if (f.next)
      x.agent(
        ["[So just to recap|Okay, so], your next payment is {next_amount} on {next_due}."],
        "quote:recap",
      );
  }
  if (f.past_due && !f.bankruptcy && x.p.kind === "outbound")
    x.agent(
      [
        "[And it's really important to make your payments on or before the due date going forward.|Going forward, please try to make the payment on or before the due date.]",
      ],
      "emphasize",
    );
  x.agent(
    [
      "[Is there anything else I can help you with today?|Anything else I can do for you?|Is there anything else?]",
    ],
    "anything_else",
  );
  x.caller(
    [
      "[No, that's it.|Nope, that's all.|No, thank you.|I think that covers it.|No, you've been very helpful.]",
    ],
    "react",
  );
  x.agent(
    x.p.contact.direction === "outbound"
      ? [
          "[Thanks for your time|Thank you, {b_first}|Alright, thank you], [have a great|have a good|enjoy the rest of your] [day|evening|week].",
        ]
      : [
          "[Thank you for calling {servicer}|Thanks for calling|Thank you], [have a great|have a good|enjoy the rest of your] [day|evening|week].",
        ],
    "closing",
  );
  x.caller(["[You too.|Thanks, bye.|Bye-bye.|Thank you, you too.|Okay, bye.]"], "closing");
}

/* ── the talk no note mentions ──────────────────────────────────────────── */

function hold(x: Script, seconds: number) {
  x.agent(
    [
      "[Can I put you on a brief hold|Do you mind if I place you on a short hold|Let me put you on hold for a minute|I'm going to place you on hold] [while I look into that|while I check something|to review the history|so I can pull up the details]?",
    ],
    "hold_ask",
  );
  x.caller(["[Sure.|That's fine.|Okay.|Yeah, go ahead.|No problem.]"], "react");
  x.mark("[hold]", seconds, "hold");
  x.agent(
    [
      "[Thank you for holding.|Thanks for your patience.|Okay, I'm back, thank you for holding.|Sorry about the wait.|Thanks for holding, I appreciate it.]",
    ],
    "hold_return",
  );
}

const FILLERS = [
  "weather",
  "family",
  "work",
  "typing",
  "clarify",
  "best_time",
  "authorize_other",
  "privacy",
  "escrow_explainer",
  "web_tour",
  "upload",
  "refi_question",
  "hold_music",
  "callback",
  "first_name",
  "read_back",
  "thanks",
  "how_long",
  "spouse_handles",
  "pen",
  "next_steps",
  "letter_question",
] as const;
type Filler = (typeof FILLERS)[number];

/** The talk that fits a call from someone acting for the borrower. */
const THIRD_PARTY_FILLERS: ReadonlySet<Filler> = new Set([
  "typing",
  "clarify",
  "next_steps",
  "how_long",
  "hold_music",
  "upload",
  "weather",
]);

/** The fillers that fit this call, in a drawn order: no hold-music remark on a call we placed, no refinance question from a borrower who is behind. */
function fillerOrder(r: Rng, p: CallPlan): Filler[] {
  const inbound = p.contact.direction === "inbound";
  const a = FILLERS.filter(
    (f) =>
      (f !== "hold_music" || inbound) &&
      (f !== "refi_question" || (inbound && !p.facts.past_due && !p.facts.bankruptcy)) &&
      (f !== "escrow_explainer" || p.facts.escrowed) &&
      (f !== "work" || p.style !== "brief") &&
      (p.caller.role === "borrower" ||
        p.caller.role === "co_borrower" ||
        THIRD_PARTY_FILLERS.has(f)),
  );
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function smallTalk(x: Script, f: Filler) {
  const p = x.p;
  switch (f) {
    case "weather":
      x.caller(
        [
          "[It's been so hot here lately.|We've had so much rain this week.|It's freezing out today.|Beautiful day out, at least.]",
        ],
        "small_talk",
      );
      x.agent(
        [
          "[Oh, I bet.|Same here, honestly.|I hear that.|Well, I hope it gets better for you.] [I'm stuck inside all day anyway.|At least I'm indoors.|]",
        ],
        "small_talk",
      );
      return;
    case "family":
      x.caller(
        [
          "[Sorry, my daughter is asking me something.|Hold on one second. Sorry, my son just got home.|Sorry, my mom is visiting and she's talking to me.]",
        ],
        "small_talk",
      );
      x.agent(
        ["[No problem at all, take your time.|That's okay, I'll be right here.|No worries.]"],
        "small_talk",
      );
      x.caller(["[Okay, sorry about that.|Okay, I'm back.|Sorry, go ahead.]"], "react");
      return;
    case "work":
      x.caller(
        [
          "[I'm on my lunch break, so I don't have a ton of time.|I'm calling from work, so if I have to go, I'm sorry.|I just got off a double shift, so bear with me.]",
        ],
        "small_talk",
      );
      x.agent(
        [
          "[I'll try to be quick, then.|I understand, we'll get you taken care of.|No problem, I'll keep it short.]",
        ],
        "small_talk",
      );
      return;
    case "typing":
      x.agent(
        [
          "[Let me just add some notes to the account here.|Give me one second, I'm typing up the notes.|I'm just documenting what we talked about.]",
        ],
        "typing",
      );
      x.back(0.9);
      x.agent(
        ["[Okay, that's all noted.|Alright, I've got that documented.|Okay, it's on the account.]"],
        "typing",
      );
      return;
    case "clarify":
      x.caller(
        [
          "[So I don't need to do anything else?|So is there anything I need to send you?|So that's it, I'm all set?]",
        ],
        "clarify",
      );
      x.agent(
        [
          "[Not right now. If we need anything else, we'll send you a letter.|No, you're all set for now. You'd get something in the mail if anything changes.|Nothing else on your end right now.]",
        ],
        "clarify",
      );
      return;
    case "best_time":
      x.agent(
        [
          "[What's the best time to reach you if we need to follow up?|If we need to call you back, when's a good time?]",
        ],
        "best_time",
      );
      x.caller(
        ["[Evenings are best.|After work, usually.|Mornings, before work.|Anytime, really.]"],
        "react",
      );
      return;
    case "authorize_other":
      x.agent(
        [
          "[Is there anyone else you'd like to authorize to speak with us about the loan?|Would you like to add anyone as an authorized party on the account?]",
        ],
        "authorize_other",
      );
      x.caller(["[No, just me.|Not right now.|Maybe my daughter. How would I do that?]"], "react");
      x.agent(
        [
          "[If you ever want to, there's a third-party authorization form on the website.|You'd just send us a signed authorization form, and we'd add them.]",
        ],
        "authorize_other",
      );
      return;
    case "privacy":
      x.agent(
        [
          "[You'll also get our privacy notice in the mail once a year. Nothing has changed with it, it's just required.|Just so you know, the annual privacy notice will be coming in the mail. You don't need to do anything with it.]",
        ],
        "privacy",
      );
      x.back(0.7);
      return;
    case "escrow_explainer":
      if (!p.facts.escrowed) return smallTalk(x, "upload");
      x.agent(
        [
          "[Just so you understand how it works,|The way escrow works is,] part of your monthly payment goes into an escrow account, and we pay your property taxes and your homeowners insurance out of it when they come due. Once a year we look at what we paid and what's coming up, and we adjust the payment so there's enough.",
        ],
        "escrow_explainer",
      );
      x.caller(
        ["[Okay, that makes sense.|Oh, I didn't know that's how it worked.|Got it.]"],
        "react",
      );
      return;
    case "web_tour":
      x.agent(
        [
          "[On the website, once you log in, your payment history is on the left, and the documents tab has your statements and letters.|If you log in online, you can see every payment and download your statements under documents.]",
        ],
        "web_tour",
      );
      x.caller(["[Okay, I'll take a look.|Good to know.|I'll check it out.]"], "react");
      return;
    case "upload":
      x.agent(
        [
          "[If you ever need to send us something, you can upload it in the portal, fax it, or mail it to the address on your statement.|For any documents, the portal is the fastest, but mail works too.]",
        ],
        "upload",
      );
      x.back(0.8);
      return;
    case "refi_question":
      x.caller(
        [
          "[My neighbor said I should refinance. Should I?|Do you guys do refinancing? Would that lower my payment?|Is it worth refinancing right now?]",
        ],
        "refi_question",
      );
      x.agent(
        [
          "[I'm not able to give advice on that, but if you'd like, I can have a licensed loan officer contact you.|That's not something I can advise on, but I can refer you to someone licensed to talk about it.]",
        ],
        "refi_question",
      );
      x.caller(["[Maybe later.|No, that's okay.|Sure, have someone call me.]"], "react");
      return;
    case "hold_music":
      x.caller(
        [
          "[That hold music is something else.|I was on hold for a while before I got you.|I almost hung up, the wait was long.]",
        ],
        "small_talk",
      );
      x.agent(
        [
          "[I'm sorry about the wait.|I apologize, it's been busy today.|I hear that a lot, sorry about that.]",
        ],
        "small_talk",
      );
      return;
    case "callback":
      x.agent(
        [
          "[If we get disconnected, is this the best number to call you back on?|In case we get cut off, can I call you back at this number?]",
        ],
        "callback",
      );
      x.caller(["[Yes, this is my cell.|Yeah, that's fine.|Yes.]"], "react");
      return;
    case "first_name":
      x.agent(
        [
          "[I'm sorry, could you repeat your first name for me?|And how do you spell your first name?]",
        ],
        "spell",
      );
      x.caller([`${(p.caller.full ?? p.borrower.full).split(" ")[0]!}.`], "spell");
      return;
    case "thanks":
      x.caller(
        [
          "[I really appreciate your help. The last person I talked to wasn't very helpful.|Thank you for explaining all that, nobody ever explains anything.|You've been really patient with me, thank you.]",
        ],
        "small_talk",
      );
      x.agent(
        [
          "[I'm glad I could help.|Of course, that's what I'm here for.|I'm happy to help, really.]",
        ],
        "small_talk",
      );
      return;
    case "how_long":
      x.caller(
        ["[How long does that usually take?|When should I expect to hear something?]"],
        "clarify",
      );
      x.agent(
        [
          "[Usually a few business days, but it can take a little longer.|You should see something in the mail within a week or two.]",
        ],
        "clarify",
      );
      return;
    case "spouse_handles":
      x.caller(
        [
          "[My spouse usually handles all of this, honestly.|Normally my husband deals with the mortgage.|My wife usually takes care of the bills.]",
        ],
        "small_talk",
      );
      x.agent(
        [
          "[That's fine, they're welcome to call too. They'd just need to be verified, or authorized if they're not on the loan.|No problem. If they're on the loan they can call anytime; if not, you can authorize them.]",
        ],
        "small_talk",
      );
      return;
    case "pen":
      x.caller(
        ["[Hold on, let me grab a pen.|Wait, let me find something to write on.]"],
        "small_talk",
      );
      x.back(0.9);
      x.caller(["[Okay, go ahead.|Okay, I'm ready.]"], "react");
      x.agent(
        [
          "[I was just saying, everything we talked about will be on the account notes, so if you call back, anyone can see it.|No problem. Everything from today is documented, so whoever you talk to next will see it.]",
        ],
        "small_talk",
      );
      return;
    case "next_steps":
      x.agent(
        [
          "[So what happens next is, I'll document everything we went over, and if anything needs to go out in the mail, it'll go out in the next few days.|From here, I'll add notes on everything, and anything we owe you in writing goes out in a few business days.]",
        ],
        "next_steps",
      );
      x.back(0.7);
      return;
    case "letter_question":
      x.caller(
        [
          "[I also got some letter about my privacy rights, do I need to do anything with that?|There was a letter about my information being shared, what is that?]",
        ],
        "clarify",
      );
      x.agent(
        [
          "[That's the privacy notice. It just explains how we handle your information, and you don't need to send anything back.|That's our annual privacy notice, nothing you need to do, unless you want to opt out of sharing.]",
        ],
        "clarify",
      );
      return;
    case "read_back":
      if (p.facts.next)
        x.agent(
          [
            "[Just to make sure you have it,|So you have it,] your next payment is {next_amount}, due {next_due}.",
          ],
          "quote:read_back",
        );
      else
        x.agent(
          [
            "[Is there anything on the account you'd like me to go over again?|Did you have any questions about what we went over?]",
          ],
          "read_back",
        );
      x.caller(["[Okay, got it.|Thanks.|No, I think I've got it.]"], "react");
      return;
  }
}

/* ── the template writer ─────────────────────────────────────────────────── */

function writeCall(p: CallPlan): DraftTurn[] {
  const r = rngFor(`${p.key}/words`);
  const slots = slotsOf(p);
  if (p.needs.hardship) {
    const line = r.pick(HARDSHIP_LINE[p.needs.hardship]!);
    slots.hardship_line = expand(r, line, slots);
    slots.hardship_short =
      slots.hardship_line.charAt(0).toLowerCase() + slots.hardship_line.slice(1);
  } else {
    slots.hardship_line = "Things have been tight";
    slots.hardship_short = "things have been tight";
  }
  slots.hardship_es = hardshipEs(p.needs.hardship);
  const x = new Script(r, slots, p);

  switch (p.kind) {
    case "voicemail":
      x.agent(
        [
          "Hi, this message is for {b_first}. [This is|My name is] {agent} [with|from] {servicer}. Please [call us back|return my call] at {phone}. [Thank you.|Have a good day.|Thanks.]",
          "Hello, this is {agent} calling from {servicer} for {b_first}. [Please give us a call back at|You can reach us at] {phone}[, we're open until {hours_close} PM|]. Thank you.",
        ],
        "voicemail",
      );
      return x.turns;
    case "wrong_number":
      greeting(x);
      x.caller(
        [
          "[No, you have the wrong number.|There's nobody here by that name.|Wrong number.|I think you have the wrong number, I just got this number.]",
        ],
        "wrong_party",
      );
      x.agent(
        [
          "[I'm sorry to bother you.|Sorry about that.|My apologies.] [I'll update our records.|Have a good day.|I'll take this number off.]",
        ],
        "unverified_refusal",
      );
      return x.turns;
    case "refused":
      greeting(x);
      x.caller(
        [
          "[I can't talk right now.|I'm at work, I can't talk.|Now's not a good time.|Who is this? I'm busy.]",
        ],
        "refuse",
      );
      x.agent(
        [
          "[I understand.|No problem.] [You can call us back at {phone}.|We'll try you another time.]",
        ],
        "unverified_refusal",
      );
      x.mark("[call ended]", 1, "hangup");
      return x.turns;
    case "outbound_unverified":
      greeting(x);
      if (x.r.chance(0.5)) {
        x.caller(
          [
            "[They're not here right now.|They're not available.|They're at work.] [Can I take a message?|Who's calling?]",
          ],
          "third_party",
        );
        // Whoever answers hears the recording notice (the row marks it); nothing about the debt.
        x.agent(
          [
            "[This is {agent} with {servicer}.|My name is {agent} with {servicer}.] [Just so you know, this call may be recorded.|This call may be recorded.]",
          ],
          "recording_disclosure",
        );
        x.agent(
          ["[Could you ask them to call us back at {phone}?|I'll try back another time.]"],
          "unverified_refusal",
        );
        x.caller(["[Sure.|Okay.|I'll let them know.]"], "react");
      } else {
        x.caller(["[Speaking.|This is them.|Yeah, that's me.]"], "speaking");
        x.agent(["Hi, [this is|my name is] {agent} [calling from|with] {servicer}."], "intro");
        x.agent(
          [
            "[This call is being recorded.|Just so you know, this call is recorded.|I do want to let you know this call may be recorded.]",
          ],
          "recording_disclosure",
        );
        x.agent(
          [
            "[For security, can you verify your date of birth?|Before I go any further, I need to verify your identity. Can you give me your date of birth?]",
          ],
          "verify",
        );
        x.caller(
          [
            "[I'm not giving that out over the phone.|How do I know who you are?|I don't do that on calls.]",
          ],
          "verify_fail",
        );
        x.agent(
          [
            "[That's completely fine.|I understand.] [I can't discuss the account without verifying, but you can call us directly at {phone}.|You can call the number on your statement, {phone}, and we can go over it then.]",
          ],
          "unverified_refusal",
        );
      }
      x.agent(["[Thank you.|Thanks, have a good day.]"], "closing");
      return x.turns;
    default:
      break;
  }

  const inbound = p.kind === "inbound" || p.kind === "inbound_unverified";
  if (inbound) ivrPrelude(x);
  const answerAt = x.turns.length;
  greeting(x);
  if (p.interpreter) interpreterJoin(x);
  if (inbound) callerIntro(x);
  else {
    x.caller(
      ["[Speaking.|This is {b_first}.|Yeah, this is {b_first}.|Who's calling?]"],
      "speaking",
    );
    x.agent(
      [
        "Hi {b_first}, [this is|my name is] {agent} [calling from|with] {servicer}[, your mortgage servicer|].",
      ],
      "intro",
    );
    x.agent(
      [
        "[This call is being recorded[ for quality purposes|].|Just so you know, this call is recorded.|I do want to let you know this call may be recorded.]",
      ],
      "recording_disclosure",
    );
  }
  if (p.kind === "inbound_unverified") {
    if (p.caller.role === "spouse_not_on_note") {
      x.agent(["[Are you listed on the loan?|Are you a borrower on the account?]"], "verify");
      x.caller(
        [
          "[No, it's in my spouse's name, but I pay the bills.|No, but I'm married to the borrower.]",
        ],
        "verify_fail",
      );
    } else verify(x, true);
    refusal(x);
    x.caller(
      ["[Okay, I'll have them call.|Fine.|Okay, thanks anyway.|That's ridiculous, but okay.]"],
      "react",
    );
    x.agent(["[Thank you for understanding.|Thanks for calling.|Have a good day.]"], "closing");
    void answerAt;
    return x.turns;
  }
  // Verification: the borrower, or the person the record lets the agent speak with.
  if (p.caller.role === "spouse_not_on_note" && p.needs.borrower_joins) {
    x.agent(["[Are you listed on the loan?|Are you a borrower on the account?]"], "verify");
    x.caller(
      ["[No, it's my spouse's loan, but they're right here.|No, but {b_first} is here with me.]"],
      "verify_answer",
    );
    x.agent(
      [
        "[Okay, can I speak with them for a moment to get verbal authorization?|If they can get on the line, I just need their permission to talk with you.]",
      ],
      "verify",
    );
    x.caller(
      [
        "[Hi, this is {b_first}. Yes, you can talk to them about the loan.|This is {b_first}, it's okay to talk to my spouse.]",
      ],
      "authorize",
    );
    verify(x, false);
  } else if (p.caller.role === "housing_counselor") {
    x.agent(
      [
        x.has("auth_on")
          ? "[I do see|I see] a third-party authorization on file, [received|dated] {auth_on}."
          : "[I do see a third-party authorization on file.|I see the authorization on file.]",
      ],
      "verify_authorization",
    );
    x.agent(
      [
        "[I'll still need to verify the borrower's information.|Can you verify the borrower's property address and last four?]",
      ],
      "verify",
    );
    x.caller(["[Sure,] {street}, and the last four are {ssn4}."], "verify_answer", [x.s.ssn4!]);
    x.agent(["[Thank you, that matches.|Okay, you're verified.]"], "verify_ok");
  } else if (p.caller.role === "attorney") {
    x.agent(
      [
        "[Thank you.|Okay.] [Can I get the property address on the loan?|What's the address of the property?]",
      ],
      "verify",
    );
    x.caller(["{street}, {city}."], "verify_answer");
  } else if (inbound) verify(x, false);
  else {
    x.agent(
      [
        "[For security, can you verify your date of birth?|Before I go any further, can you verify the last four of your social?]",
      ],
      "verify",
    );
    x.caller(x.r.chance(0.5) ? ["{dob_y}."] : ["{ssn4}."], "verify_answer", [
      x.s.dob_y!,
      x.s.ssn4!,
    ]);
    x.agent(["[Thank you.|Thanks, you're verified.|Perfect.]"], "verify_ok");
  }
  if (p.needs.bk_disclaimer) bkDisclaimer(x);
  else if (p.needs.mini_miranda) miniMiranda(x);

  if (inbound && p.reason) body(x, p.reason, true);
  else if (p.contact.purpose === "welcome") {
    x.agent(
      [
        "[I'm calling to welcome you to {servicer}|I just wanted to welcome you], [since your loan was recently transferred to us|now that we're servicing your loan].",
      ],
      "welcome",
    );
    if (p.facts.transfer) st.transfer(x);
    if (p.facts.next) st.nextPayment(x, false);
    x.caller(
      ["[Okay, thanks for letting me know.|Oh, okay. Good to know.|I got the letter, yeah.]"],
      "react",
    );
  } else {
    // An outbound collection call.
    x.agent(
      [
        "[The reason for my call|I'm calling] [is about|regarding] [your mortgage payment|the payment on your mortgage][ that was due {oldest_due}|].",
        "[I'm reaching out about|I'm calling about] [the account|your loan] being past due.",
      ].filter((t) => !t.includes("{oldest_due}") || x.has("oldest_due")),
      "purpose",
    );
    if (p.facts.past_due) st.pastDue(x);
    const hl = HARDSHIP_LINE[p.needs.hardship ?? "family"]!;
    x.caller(
      [
        "[Yeah, I know.|I'm aware.|I know, I know.|Yes, I know it's late.] " +
          expand(x.r, x.r.pick(hl), x.s) +
          ".",
      ],
      "story",
    );
    x.agent(["[I'm sorry to hear that.|I understand.|That's tough, I'm sorry.]"], "empathy");
    if (p.needs.promise) st.promise(x);
    else {
      x.agent(
        [
          "[When do you think you'll be able to make a payment?|Are you able to make a payment today?|What are you able to do?]",
        ],
        "ask_when",
      );
      x.caller(
        [
          "[I'm not sure right now.|I don't know yet, I'm waiting on a check.|Probably at the end of the month, I'll have to see.]",
        ],
        "react",
      );
      lossmitOptions(x);
    }
  }
  if (p.needs.credit_question) creditQuestion(x);
  if (p.needs.complaint) complaint(x);
  // The long middle, until the call has said about as much as its length holds: the holds, the
  // second questions, the side topics the note will mention, then the talk no note mentions.
  const close = 70;
  const budget = p.words_target - close - (p.needs.transfer ? 150 : 0);
  const holds = [...p.holds];
  const seconds = [...p.seconds];
  const fill = [...p.topics];
  // Each side topic and each filler at most once: a call runs out of things to say before it repeats
  // one, and what is left of its length is holds and dead air.
  const filler = fillerOrder(x.r, p);
  let steps = 0;
  while (steps < 80) {
    steps++;
    const short = x.words < budget;
    if (holds.length && (steps % 3 === 0 || !short)) {
      hold(x, holds.shift()!);
      continue;
    }
    if (!short) break;
    if (seconds.length && (steps % 2 === 0 || !fill.length)) {
      body(x, seconds.shift()!, false);
      continue;
    }
    const t = fill.shift();
    if (t && x.words < budget * 0.85) {
      topic(x, t);
      continue;
    }
    const f = filler.shift();
    if (f) smallTalk(x, f);
    else if (!t && !seconds.length) break;
  }
  if (p.needs.transfer) transferOut(x);
  recapAndClose(x);
  return p.interpreter ? interpret(rngFor(`${p.key}/es`), x.turns, slots) : x.turns;
}

/* ── the agent's note ────────────────────────────────────────────────────── */

const REASON_CODE: Record<InquiryReason, string> = {
  payment_received: "PMT STATUS",
  make_payment: "MAKE PMT",
  payment_change: "PMT CHANGE",
  rate_change: "ARM RATE CHG",
  payment_arrangement: "PAST DUE/PTP",
  hardship: "HARDSHIP",
  escrow_analysis: "ESC ANALYSIS",
  insurance: "HAZ INS",
  tax: "TAXES",
  form_1098: "1098",
  online_access: "WEB ACCESS",
  autopay_setup: "AUTOPAY",
  statement_copy: "STMT COPY",
  account_update: "DEMO UPDATE",
  late_fee: "LATE FEE",
  payoff_request: "PAYOFF REQ",
  lien_release: "LIEN RELEASE",
  servicing_transfer: "SVC TRANSFER",
  disaster_assistance: "DISASTER",
  mi_cancellation: "PMI",
  credit_reporting: "CREDIT DISPUTE",
  bankruptcy: "BK",
};

/** A statement line, as an agent's note abbreviates it. */
const NOTE_LINE: Readonly<Record<string, string>> = {
  tax_county: "CNTY TAX",
  tax_school: "SCHL TAX",
  hazard: "HAZ INS",
  flood: "FLOOD INS",
  mi_borrower_paid: "MI",
  refund: "SURPLUS REFUND",
};

/** The figures a note repeats from its call, in the note's own shorthand: `⟨money:key⟩` and `⟨date:key⟩` are filled by notes.ts. */
function noteClauses(p: CallPlan, turns: readonly DraftTurn[]): string[] {
  const f = p.facts;
  const out: string[] = [];
  const reason = p.reason;
  const who =
    p.caller.role === "co_borrower"
      ? "B2"
      : p.caller.role === "spouse_not_on_note"
        ? "NBS (NON BWR SPOUSE)"
        : p.caller.role === "housing_counselor"
          ? "3RD PTY HSG COUNSELOR"
          : p.caller.role === "attorney"
            ? "BK ATTY"
            : p.caller.role === "unknown_caller"
              ? "UNVERIFIED CALLER"
              : "B1";
  if (p.kind === "inbound")
    out.push(`${who} [CLD|CALLED|CI] [RE|REGARDING|ABT] ${reason ? REASON_CODE[reason] : "ACCT"}.`);
  else if (p.kind === "inbound_unverified") {
    out.push(
      `${who} [CLD|CALLED|CI] [RE|ABT] ${reason ? REASON_CODE[reason] : "ACCT"}. [UNABLE TO VERIFY|FAILED VERIFICATION|COULD NOT AUTH].`,
    );
    out.push(
      "[NO ACCT INFO GIVEN|DID NOT DISCLOSE ACCT INFO|ADV CALLER TO HAVE BWR CALL]. [ADV TPA FORM|ADV BWR MUST AUTHORIZE].",
    );
    return out;
  } else if (p.kind === "outbound")
    out.push(`[OB CALL|OUTBOUND|OB] [TO|-] ${who}. [RPC|RIGHT PARTY CONTACT].`);
  else if (p.kind === "outbound_unverified") {
    out.push(
      "[OB CALL|OUTBOUND]. [3RD PARTY ANS|UNABLE TO VERIFY]. [NO MSG LEFT RE DEBT|LEFT CALLBACK # ONLY|NO ACCT INFO GIVEN].",
    );
    return out;
  } else if (p.kind === "wrong_number") {
    out.push(
      "[OB CALL|OUTBOUND]. [WRONG NUMBER|WRONG PARTY]. [PH FLAGGED BAD|REMOVED PH FROM ACCT|UPDATED PH STATUS].",
    );
    return out;
  } else if (p.kind === "refused") {
    out.push("[OB CALL|OUTBOUND]. [BWR ANS, REFUSED TO TALK|BWR HUNG UP|BWR STATED BAD TIME].");
    return out;
  } else if (p.kind === "voicemail") {
    out.push("[LM|LEFT MSG] [LCM|LIMITED CONTENT MSG] [W/ CALLBACK #|]");
    return out;
  }
  out.push(
    p.caller.role === "housing_counselor"
      ? "[TPA ON FILE|3RD PTY AUTH ON FILE]. [VRFD BWR INFO|VERIFIED]."
      : "[VRFD|VERIFIED|AUTH'D] [NAME/ADDR/SSN|DOB/ADDR|LN/ADDR|NAME/DOB].",
  );
  if (p.needs.bk_disclaimer)
    out.push("[BK DISCLAIMER GIVEN|GAVE BK DISCLOSURE|BK DISCLOSURE READ].");
  else if (p.needs.mini_miranda) out.push("[MINI MIRANDA GIVEN|MM GIVEN|FDCPA DISCLOSURE GIVEN].");
  if (p.interpreter) out.push("[USED LANGUAGE LINE|SPANISH INTERPRETER USED|INTERP ON LINE].");
  const r = reason;
  if (r === "payment_received" && f.last_payment && daysBetween(f.last_payment.on, f.on) <= 40)
    out.push("[ADV|ADVISED] PMT RCVD ⟨date:last_on⟩ ⟨money:last_amount⟩.");
  if (r === "escrow_analysis" && f.analysis && f.statement) {
    // What the call explained, from the analysis and the statement: the payment, the decision, the bills that moved.
    const a = f.analysis;
    out.push(
      "[EXPLAINED|REVIEWED] ESC ANALYSIS: ESC PMT ⟨money:old_escrow⟩ TO ⟨money:new_escrow⟩ EFF ⟨date:effective⟩.",
    );
    if (a.decision === "shortage")
      out.push(
        a.plan.deficiency !== null
          ? "DEFICIENCY ⟨money:deficiency⟩, SHTG ⟨money:shortage⟩ [SPREAD|OVER] ⟨int:plan_months⟩ MOS."
          : "[SHORTAGE|SHTG] ⟨money:shortage⟩ [SPREAD|OVER] ⟨int:plan_months⟩ MOS @ ⟨money:shortage_installment⟩.",
      );
    else if (a.decision === "refund")
      out.push("SURPLUS ⟨money:surplus⟩ [REFUND BY|REFUNDED BY] ⟨date:refund_by⟩.");
    else if (a.decision === "credit")
      out.push("SURPLUS ⟨money:surplus⟩ CREDITED ⟨money:credit_monthly⟩ A MO.");
    const lines = f.statement.lines.map((l, i) =>
      l.kind === "differs"
        ? `${NOTE_LINE[l.line_type] ?? l.label.toUpperCase()} ⟨money:st${i + 1}_actual⟩ VS ⟨money:st${i + 1}_projected⟩ PROJ`
        : `${NOTE_LINE[l.line_type] ?? l.label.toUpperCase()} ⟨money:st${i + 1}_actual⟩ NOT PROJ`,
    );
    if (lines.length) out.push(`[ANNUAL STMT|STMT]: ${lines.join("; ")}.`);
    if (f.statement.overdrawn)
      out.push("ACCT OVERDRAWN IN YR, STMT HAS NO LOW BAL COMPARISON - ADV BWR.");
    else if (f.statement.low) out.push("LOW BAL ⟨money:low_actual⟩ VS ⟨money:low_projected⟩ PROJ.");
  } else if ((r === "payment_change" || r === "escrow_analysis") && f.analysis) {
    out.push("[ADV|EXPLAINED] ESC ANALYSIS, NEW PMT ⟨money:new_total⟩ EFF ⟨date:effective⟩.");
    if (f.analysis.shortage !== null && f.analysis.shortage > 0n)
      out.push("[SHORTAGE|SHTG] ⟨money:shortage⟩ [SPREAD 12 MOS|OVER 12 MOS].");
  }
  if (r === "rate_change" && f.arm)
    out.push("[ADV|EXPLAINED] ARM CHG, NEW P&I ⟨money:new_pi⟩ EFF ⟨date:first_new_payment⟩.");
  if (r === "late_fee" && f.late_charge)
    out.push(
      "LC ⟨money:late_amount⟩ [ASSESSED|ASSD] ⟨date:late_assessed⟩. [SUBMITTED WAIVER REQ|SENT FOR REVIEW|ADV NO GUARANTEE OF WAIVER].",
    );
  if (r === "payoff_request")
    out.push("[PAYOFF ORDERED|ORDERED PAYOFF STMT|REQ PAYOFF]. [ADV 7 BUS DAYS|ADV WITHIN 7 BD].");
  if (r === "form_1098" && f.form_1098) out.push("[ADV|PROVIDED] 1098 INT ⟨money:interest_1098⟩.");
  if (r === "online_access") out.push("[SENT PW RESET|RESET LINK SENT|UNLOCKED WEB ACCT].");
  if (r === "autopay_setup") out.push("[ENROLLED ACH|SET UP AUTOPAY|ACH ENROLLMENT COMPLETED].");
  if (r === "insurance")
    out.push(
      f.escrowed
        ? "[ADV TO SEND DEC PG|REQ DEC PAGE FROM AGENT|ADV FAX DEC PG]."
        : "[ADV NEED POI|REQ PROOF OF INS].",
    );
  if (r === "tax" && f.tax_paid && f.escrowed)
    out.push("[ADV|CONFIRMED] TAXES PD ⟨date:tax_on⟩ ⟨money:tax_amount⟩.");
  if (r === "servicing_transfer" && f.transfer)
    out.push("[ADV|EXPLAINED] XFER EFF ⟨date:transfer_on⟩, 60 DAY [GRACE|PROTECTION].");
  if (r === "lien_release" && f.payoff)
    out.push(
      "[PIF|PAID IN FULL] ⟨date:payoff_on⟩. [ADV LIEN REL SENT TO COUNTY|ADV RELEASE IN PROCESS].",
    );
  if (r === "mi_cancellation")
    out.push(
      f.mi.terminated_on
        ? "[ADV PMI TERMINATED|PMI CANCELLED] ⟨date:mi_terminated_on⟩."
        : "[ADV PMI CANX REQS|EXPLAINED HPA CANCELLATION].",
    );
  if (r === "disaster_assistance")
    out.push("[DISASTER IMPACT|FEMA AREA]. [ADV ASSISTANCE OPTIONS|REFERRED TO LM].");
  if (r === "bankruptcy" && f.bankruptcy)
    out.push("BK CH ⟨int:chapter⟩ FILED ⟨date:petition_on⟩. [FLAGGED ACCT|REFERRED TO BK DEPT].");
  if (f.past_due && (r === "hardship" || r === "payment_arrangement" || p.kind === "outbound"))
    out.push("[ACCT|LOAN] ⟨int:days⟩ DPD, [AMT DUE|TAD] ⟨money:past_due_total⟩.");
  if (p.needs.hardship && f.past_due)
    out.push(`RFD: ${p.needs.hardship.toUpperCase().replace("_", " ")}.`);
  if (p.needs.promise && f.promise)
    out.push("[PTP|PROMISE] ⟨money:promise_amount⟩ BY ⟨date:promise_date⟩.");
  else if (f.past_due && (r === "hardship" || r === "payment_arrangement" || p.kind === "outbound"))
    out.push("[NO PTP|BWR UNABLE TO COMMIT]. [ADV LM OPTIONS|SENT LM PKG|ADV OF ASSISTANCE].");
  if (p.needs.credit_question)
    out.push(
      "[BWR ASKED ABT CREDIT|ASKED IF CREDIT AFFECTED], [ADV CR REPORTING|ADV REPORTED IF 30+ DPD].",
    );
  if (p.needs.complaint)
    out.push(
      "[BWR DISSATISFIED|BWR UPSET|EXPRESSED DISSATISFACTION]. [COMPLAINT LOGGED|LOGGED CMPLT|ESCALATED AS COMPLAINT].",
    );
  if (p.needs.transfer)
    out.push("[WARM XFER TO LM|XFERRED TO LOSS MIT|TRANSFERRED TO HOMEOWNER ASSIST].");
  // What else the call took up, read off its turns: a longer call leaves a longer note.
  const tags = new Set(turns.map((t) => t.tag));
  // The questions the caller asked, the interpreter's relays of them aside: until contacts 1.2.0 a relay read as a
  // second question, and every interpreted call's note asked about "undefined".
  const asked = turns
    .filter((t) => t.tag.startsWith("reason:") && !t.tag.endsWith(":relay"))
    .slice(1)
    .map((t) => t.tag.slice("reason:".length) as InquiryReason);
  for (const a of asked) out.push(`[ALSO|ADDL] [ASKED|INQ] ABT ${REASON_CODE[a]}.`);
  const extra: readonly (readonly [string, string])[] = [
    ["confirm_phone", "[CONF PH|VRFD PH ON FILE]."],
    ["confirm_email", "[CONF EMAIL|EMAIL VRFD]."],
    ["paperless", "[OFFERED PAPERLESS|ADV ESTMT]."],
    ["autopay_offer", "[OFFERED ACH|ADV AUTOPAY], [DECLINED|WILL CONSIDER]."],
    ["text_offer", "[OFFERED SMS|OFFERED TEXT REMINDERS], DECLINED."],
    ["portal_offer", "[ADV WEB REGISTRATION|OFFERED PORTAL]."],
    ["mailing", "[CONF MAILING ADDR|MAILING ADDR SAME]."],
    ["payment_ways", "[ADV PMT OPTIONS|REVIEWED WAYS TO PAY]."],
    ["quote:statement", "[REVIEWED STMT W/ BWR|EXPLAINED STMT]."],
    [
      "refi_question",
      "[BWR ASKED ABT REFI, OFFERED REFERRAL TO LICENSED LO|REFI INQ - REFERRED, NO ADVICE GIVEN].",
    ],
    ["authorize_other", "[ADV TPA FORM FOR ADDL AUTH PTY|OFFERED TO ADD AUTH PTY]."],
    ["best_time", "[BEST TIME TO CALL NOTED|UPDATED CONTACT PREF]."],
    ["occupancy_check", "[CONF OWNER OCC|OCCUPANCY CONFIRMED]."],
    ["insurance_check", "[CONF HOI CARRIER|HOI SAME CARRIER]."],
    ["scra_check", "[SCRA QUESTION ASKED, NOT ACTIVE DUTY|ASKED MILITARY STATUS - NO]."],
    ["statement_delivery", "[CONF STMT DELIVERY|ASKED ABT STMTS]."],
    ["fraud_warning", "[ADV FRAUD AWARENESS|GAVE PHISHING WARNING]."],
  ];
  for (const [tag, clause] of extra) if (tags.has(tag)) out.push(clause);
  if (tags.has("hold")) out.push("[PLACED ON HOLD TO RESEARCH|RESEARCHED HISTORY].");
  out.push(
    p.needs.transfer || p.needs.complaint
      ? ""
      : "[NFA|NO FURTHER ACTION|CALL COMPLETE|ISSUE RESOLVED].",
  );
  return out.filter(Boolean);
}

export const templateWriter: ContactTextWriter = {
  id: "templates/1.0.0",
  callTurns: writeCall,
  callNote: (p, turns) => {
    const r = rngFor(`${p.key}/note`);
    return noteClauses(p, turns)
      .map((c) => expand(r, c).toUpperCase())
      .join(" ");
  },
};

/** The day `n` days after `d`, for writers that need one: re-exported so a model writer's prompt can name the same helper. */
export const dayAfter = (d: PlainDate, n: number): PlainDate => addDays(d, n);
