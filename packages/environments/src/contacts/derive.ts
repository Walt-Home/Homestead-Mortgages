/**
 * The contact rows a contact center would hold for one loan, derived from its
 * history as the life generator wrote it.
 *
 * What the history decides, the rows follow: a delinquency opens the
 * outbound cadence on day 17 and it runs until the cure, an attempt at least
 * every 7 days (apps/servicing/src/domain/early-intervention/plan.ts:16-17,
 * :151-155), ceased while a promise is pending and suspended for good by a
 * bankruptcy (plan.ts:179-181); the written early-intervention notice goes
 * out by day 45; an escrow analysis, a transfer, a disaster, a late charge,
 * a payoff and an ARM change each bring their own calls; the January after a
 * year of interest brings the 1098 calls. A promise a call records is kept
 * when a receipt in the history keeps it.
 *
 * What the history does not decide is drawn here, from streams keyed by the
 * loan and the month, the delinquency or the event, never by anything that
 * reads another stream's result: the volume and mix of ordinary calls by
 * status and month, the channel, who calls, how each attempt ends, how long
 * each call takes. The volume is the calibration's (`rates.ts`): the
 * all-loans inquiries per loan-year, split by status with the multipliers
 * below, which over a book at the all-loans delinquency mix average to the
 * public figure (calibration-acceptance.json, contacts-per-loan-year-by-status).
 *
 * The life generator also draws a few inbound contacts a year of its own (a
 * reason and a duration, flat across the year). Those are its placeholder;
 * this module draws the volume itself, so the calibration is met once, and
 * reads only the scripted promise calls among them, through `behavior`.
 *
 * Every share and multiplier here is a design choice and names its reason.
 */

import {
  addBusinessDays,
  addDays,
  addMonths,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  endOfMonth,
  isFederalHoliday,
  parts,
  rollForward,
  servicer as servicerCalendar,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { LoanLife } from "../life/simulate.js";
import { rngFor, type Rng } from "../rng.js";
import { drawProfile } from "./profile.js";
import { CONTACT_DEFAULTS, type ContactRates } from "./rates.js";
import { recordOn, servicerOn, type RecordFacts } from "./record.js";
import type {
  BankruptcyCase,
  CadenceEpisode,
  ContactMode,
  ContactOutcome,
  ContactProfile,
  ContactPurpose,
  ContactRecord,
  InquiryReason,
  PartyRole,
  ProfilePins,
  PromiseRecord,
  Resolution,
} from "./types.js";

/* ── design choices ──────────────────────────────────────────────────────── */

/**
 * Inquiries per loan-year by the loan's status in the month, as multiples of
 * the calibration's all-loans figure: 1.7, 6, 9 and 10 a loan-year at 2.0, the
 * acceptance file's split (calibration-acceptance.json,
 * contacts-per-loan-year-by-status), so a change to the calibration moves all
 * four together.
 */
export const STATUS_MULTIPLIER = { current: 0.85, d30: 3, d60: 4.5, d90_plus: 5 } as const;
export type StatusBucket = keyof typeof STATUS_MULTIPLIER;
/**
 * A loan's ordinary calls are its status's share less what its events bring
 * (an analysis, a late charge, the 1098 in January, a payoff, a transfer, a
 * disaster, a follow-up), so the total lands on the share. Measured on
 * three-hundred-loan books at the public 2.0 a loan-year: a current loan's
 * events bring about 0.6 calls a year, a delinquent loan's (mostly the late
 * charge each month) one and a half to two and a half.
 */
export const EVENT_CALLS: Readonly<Record<StatusBucket, number>> = {
  current: 0.58,
  d30: 1.6,
  d60: 2.4,
  d90_plus: 2.4,
};
/** A share of the inquiries that come in by e-mail (when one is on file), by text (with consent), and by letter. */
const EMAIL_SHARE = 0.09;
const TEXT_SHARE = 0.04;
/** The share of each reason's calls that end in the phone menu, served by it. */
const IVR_SELF_SERVE: Partial<Record<InquiryReason, number>> = {
  payment_received: 0.55,
  make_payment: 0.5,
  form_1098: 0.45,
  statement_copy: 0.35,
  payoff_request: 0.2,
  tax: 0.2,
  insurance: 0.1,
  online_access: 0.1,
  escrow_analysis: 0.08,
};
const IVR_ABANDON = 0.04;
const LETTER_SHARE: Partial<Record<InquiryReason, number>> = {
  hardship: 0.05,
  payoff_request: 0.06,
  statement_copy: 0.03,
  late_fee: 0.03,
  insurance: 0.03,
  escrow_analysis: 0.02,
};
/** Who calls: a caller who cannot be verified, the spouse not on the note, the co-borrower, a housing counselor on a hardship. */
const UNVERIFIED_CALLER = 0.025;
const SPOUSE_CALLS = 0.12;
const SPOUSE_WITH_BORROWER_PRESENT = 0.4;
const CO_BORROWER_CALLS = 0.3;
const COUNSELOR_ON_HARDSHIP = 0.2;
/** A complaint voiced on a call an agent handled, before the reason's weight; an irritated borrower complains more. */
const COMPLAINT_BASE = 0.03;
const IRRITATED_COMPLAINT = 2.5;
/** A follow-up call on an issue left open, within two weeks. */
const FOLLOW_UP = 0.25;
/** Outbound attempts to a working number: how each ends. Conversations are a small share, as on any dialer. */
const ATTEMPT_OUTCOMES: readonly (readonly [ContactOutcome, number])[] = [
  ["no_answer", 0.41],
  ["voicemail_left", 0.32],
  ["busy_or_failed", 0.05],
  ["answered_unverified", 0.04],
  ["refused", 0.03],
  ["conversation", 0.15],
];
/** The gap to the next attempt, in days, before the calendar moves it: never more than 7 (D2-2-02). */
const ATTEMPT_GAP: readonly (readonly [number, number])[] = [
  [1, 0.05],
  [2, 0.1],
  [3, 0.15],
  [4, 0.2],
  [5, 0.2],
  [6, 0.15],
  [7, 0.15],
];
/**
 * When the dialer calls, in minutes of the day at the property: after 08:00
 * and through 20:30 on a weekday (the voice window of 11.1 rule 8, which
 * policy narrows from Reg F's 08:00 to 21:00), mornings, afternoons and
 * evenings for A4-2.1-04's varied times, and 09:00 to 15:00 on a Saturday.
 */
const DIAL_MINUTES = {
  morning: [8 * 60 + 1, 12 * 60 - 1],
  afternoon: [12 * 60, 17 * 60 - 1],
  evening: [17 * 60, 20 * 60 + 30],
  saturday: [9 * 60, 15 * 60 - 1],
} as const;
/**
 * Massachusetts allows two calls to a borrower in seven days (940 CMR 7.04),
 * which the servicing app's `stateOverlay` (early-intervention/ops.ts:499)
 * applies to every loan there, a debt collector's too. There the dialer
 * waits at least this long after an attempt, and a third attempt is at
 * least eight days after the first of the two before it.
 */
const TWO_IN_SEVEN_GAP = 4;
/** A conversation that records a promise when the borrower pays within three weeks, or that promises and breaks it. */
const BROKEN_PROMISE = 0.35;
const LOSSMIT_PACKAGE_AFTER_HARDSHIP = 0.4;
/** A bankruptcy on a delinquency that reaches day 30, and the share of them that are Chapter 13. */
export const PETITION_SHARE = 0.02;
const CHAPTER_13_SHARE = 0.7;
/** A payment reminder between days 6 and 9 when the installment is still unpaid, and a STOP in reply. */
const STOP_REPLY = 0.04;
const EMAIL_REMINDER = 0.6;
/** Portal sessions a year for a portal user, and the share of online-access calls followed by one. */
const PORTAL_PER_YEAR = 4;
/** A declarations page mailed in before a renewal; a qualified written request after a complaint, and out of nowhere. */
const DEC_PAGE = 0.25;
const QWR_AFTER_COMPLAINT = 0.15;
const QWR_PER_LOAN_YEAR = 0.004;
const HARDSHIP_LETTER_AFTER_CALL = 0.3;
const WELCOME_CALL = 0.35;
/** The handle time of a call, by reason, relative to the mean: a hardship takes longest, a statement copy least. */
const HANDLE_FACTOR: Record<InquiryReason, number> = {
  payment_received: 0.7,
  make_payment: 0.9,
  payment_change: 1.3,
  rate_change: 1.3,
  payment_arrangement: 1.3,
  hardship: 1.8,
  escrow_analysis: 1.4,
  insurance: 1.0,
  tax: 0.9,
  form_1098: 0.7,
  online_access: 0.9,
  autopay_setup: 1.0,
  statement_copy: 0.6,
  account_update: 0.7,
  late_fee: 1.0,
  payoff_request: 0.9,
  lien_release: 0.8,
  servicing_transfer: 1.1,
  disaster_assistance: 1.7,
  mi_cancellation: 1.1,
  credit_reporting: 1.1,
  bankruptcy: 0.6,
};
const COLLECTION_HANDLE_FACTOR = 1.2;
const INTERPRETER_FACTOR = 1.35;

/** Why a performing borrower calls, and why one who is behind does. Design choices until a partner's reason codes arrive. */
const MIX_CURRENT: Partial<Record<InquiryReason, number>> = {
  payment_received: 0.2,
  make_payment: 0.08,
  payment_change: 0.05,
  escrow_analysis: 0.05,
  insurance: 0.07,
  tax: 0.05,
  form_1098: 0.02,
  online_access: 0.1,
  autopay_setup: 0.06,
  statement_copy: 0.06,
  account_update: 0.07,
  late_fee: 0.04,
  payoff_request: 0.07,
  mi_cancellation: 0.03,
  credit_reporting: 0.02,
  payment_arrangement: 0.01,
  hardship: 0.02,
};
const MIX_BEHIND: Partial<Record<InquiryReason, number>> = {
  hardship: 0.28,
  payment_arrangement: 0.24,
  make_payment: 0.14,
  payment_received: 0.1,
  late_fee: 0.06,
  credit_reporting: 0.04,
  payment_change: 0.03,
  statement_copy: 0.03,
  escrow_analysis: 0.02,
  insurance: 0.02,
  payoff_request: 0.02,
  online_access: 0.02,
};
/** The 1098 in January and February: added to the month's mix before it is renormalized. */
const JANUARY_1098 = 0.08;
const FEBRUARY_1098 = 0.03;

/** Each reason's complaint category, in both vocabularies the calibration has used: the CFPB's twelve and the defaults' eight. */
export const COMPLAINT_CATEGORY: Record<InquiryReason, readonly [string, string]> = {
  payment_received: ["payment_process", "payment"],
  make_payment: ["payment_process", "payment"],
  payment_change: ["payment_process", "payment"],
  rate_change: ["interest_rate", "payment"],
  payment_arrangement: ["payment_process", "payment"],
  hardship: ["loss_mitigation", "hardship"],
  escrow_analysis: ["escrow_taxes_insurance", "escrow"],
  insurance: ["escrow_taxes_insurance", "insurance"],
  tax: ["escrow_taxes_insurance", "tax"],
  form_1098: ["servicing_communication", "statement"],
  online_access: ["servicing_communication", "other"],
  autopay_setup: ["payment_process", "payment"],
  statement_copy: ["servicing_communication", "statement"],
  account_update: ["servicing_communication", "other"],
  late_fee: ["fees", "payment"],
  payoff_request: ["payoff", "payoff"],
  lien_release: ["lien_release", "payoff"],
  servicing_transfer: ["servicing_transfer", "other"],
  disaster_assistance: ["loss_mitigation", "hardship"],
  mi_cancellation: ["mortgage_insurance", "other"],
  credit_reporting: ["credit_reporting", "other"],
  bankruptcy: ["foreclosure", "other"],
};

/* ── the context ─────────────────────────────────────────────────────────── */

export interface DeriveContext {
  /** The center's stream key: contacts/<version>/<book seed>. */
  readonly key: string;
  readonly rates: ContactRates;
  readonly pins?: ProfilePins;
}

export const statusOf = (days: number): StatusBucket =>
  days >= 90 ? "d90_plus" : days >= 60 ? "d60" : days >= 30 ? "d30" : "current";

const poisson = (r: Rng, lambda: number): number => {
  if (lambda <= 0) return 0;
  let k = 0;
  let p = Math.exp(-lambda);
  let cdf = p;
  const u = r.next();
  while (u > cdf && k < 20) {
    k++;
    p *= lambda / k;
    cdf += p;
  }
  return k;
};
const lognormalMeanOne = (r: Rng, sigma: number): number => {
  const u1 = Math.max(r.next(), 1e-12);
  const u2 = r.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(sigma * z - (sigma * sigma) / 2);
};
const weightedOf = <T extends string>(r: Rng, w: Partial<Record<T, number>>): T => {
  const pairs = (Object.entries(w) as [T, number][]).filter(([, x]) => x > 0);
  return r.weighted(pairs);
};
/** A day the dialer runs: Monday to Saturday, not a federal holiday. */
export const isDialDay = (d: PlainDate): boolean => dayOfWeek(d) !== 0 && !isFederalHoliday(d);
const dialOnOrAfter = (d: PlainDate): PlainDate => {
  let x = d;
  while (!isDialDay(x)) x = addDays(x, 1);
  return x;
};
const minutesAt = (r: Rng, from: number, to: number) => r.int(from * 60, to * 60 - 1);
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The handle-time factor's mean over a performing book's mix, so the mean handle time is the calibration's. */
/**
 * The mean of the factors over the calls agents actually handle: the reason's,
 * the interpreter's, and the 90-second floor, over the performing mix and the
 * calls events and delinquencies bring (escrow and payment-change calls after
 * an analysis, hardships, collection calls). Measured on three-hundred-loan
 * books, so a book's mean handle time is the calibration's; a loan's draws
 * never read another loan's.
 */
const HANDLE_NORM = 1.14;

/** Complaint weight per category: the calibration's complaint share over the performing mix's share, so complaints follow the complaint mix. */
function complaintWeights(rates: ContactRates): (reason: InquiryReason) => number {
  const mix = new Map(rates.complaint_mix);
  if (mix.size === 0) return () => 1;
  const vocab = [...mix.keys()].some((k) => k.includes("_")) ? 0 : 1;
  const ordinary = new Map<string, number>();
  let tot = 0;
  for (const [k, x] of Object.entries(MIX_CURRENT) as [InquiryReason, number][]) {
    const c = COMPLAINT_CATEGORY[k][vocab];
    ordinary.set(c, (ordinary.get(c) ?? 0) + x);
    tot += x;
  }
  const raw = new Map<string, number>();
  let norm = 0;
  for (const [c, o] of ordinary) {
    const w = Math.min(8, Math.max(0.2, (mix.get(c) ?? 0) / (o / tot)));
    raw.set(c, w);
    norm += (o / tot) * w;
  }
  return (reason) => (raw.get(COMPLAINT_CATEGORY[reason][vocab]) ?? 0.2) / (norm || 1);
}

/* ── delinquencies ───────────────────────────────────────────────────────── */

interface Episode {
  readonly start: PlainDate;
  /** The first day not delinquent, or null when the history ends delinquent. */
  readonly cured_on: PlainDate | null;
  readonly day17: PlainDate | null;
  readonly day30: PlainDate | null;
  /** The days a notice window opens: day 38 of the delinquency counted from the earliest unpaid installment. */
  readonly day38s: readonly PlainDate[];
}

/** The days delinquent at the end of `on` (§1024.31: from the earliest installment due and unpaid). */
export function daysDelinquent(life: LoanLife, on: PlainDate): number {
  for (const i of life.installments) {
    if (i.due >= on) return 0;
    if (i.satisfied_on === null || i.satisfied_on > on) return daysBetween(i.due, on);
  }
  return 0;
}

/** Every delinquency in the history, up to `end`, as the outbound cadence and the notice see it. */
export function delinquencies(life: LoanLife, end: PlainDate): Episode[] {
  const spans: { a: PlainDate; b: PlainDate | null }[] = [];
  for (const i of life.installments) {
    if (i.due >= end) break;
    if (i.satisfied_on !== null && i.satisfied_on <= i.due) continue;
    const a = addDays(i.due, 1);
    const b = i.satisfied_on;
    const cur = spans[spans.length - 1];
    if (cur && (cur.b === null || a <= cur.b)) {
      if (cur.b !== null && (b === null || b > cur.b)) cur.b = b;
    } else spans.push({ a, b });
  }
  return spans.map(({ a, b }) => {
    const stop = b ?? addDays(end, 1);
    let day17: PlainDate | null = null;
    let day30: PlainDate | null = null;
    const day38s: PlainDate[] = [];
    for (let d = a; d < stop && d <= end; d = addDays(d, 1)) {
      const n = daysDelinquent(life, d);
      if (n >= 17 && !day17) day17 = d;
      if (n >= 30 && !day30) day30 = d;
      if (n === 38) day38s.push(d);
    }
    return { start: a, cured_on: b, day17, day30, day38s };
  });
}

/* ── the rows ────────────────────────────────────────────────────────────── */

interface Draft {
  on: PlainDate;
  minute: number;
  seq: number;
  direction: "inbound" | "outbound";
  mode: ContactMode;
  party: PartyRole;
  party_name: string | null;
  phone_number_id: string | null;
  outcome: ContactOutcome;
  live_contact: boolean;
  live_contact_basis: ContactRecord["live_contact_basis"];
  qrpc: boolean;
  identity_verified: boolean | null;
  purpose: ContactPurpose;
  reason: InquiryReason | null;
  resolution: Resolution;
  issue: string;
  language: "en" | "es";
  interpreter: boolean;
  duration_s: number;
  handle_s: number;
  human_agent: string | null;
  tcpa_basis: ContactRecord["tcpa_basis"];
  tcpa_consent: boolean;
  regf_counted: boolean;
  disclosures_marked: ContactRecord["disclosures_marked"];
  complaint_voiced: boolean;
  complaint_logged: boolean;
  counts_as_inquiry: boolean;
  transcript: boolean;
  promise: Omit<PromiseRecord, "id" | "contact_id"> | null;
}

/** The servicer's agents: invented names and user ids, one pool per servicer. */
export const AGENTS: Readonly<
  Record<"us" | "prior", readonly { readonly id: string; readonly name: string }[]>
> = {
  us: [
    ["DMR4471", "Dana"],
    ["KLT2208", "Kevin"],
    ["JHS9032", "Jasmine"],
    ["RBC1176", "Ruben"],
    ["AMW5520", "Angela"],
    ["TPN3381", "Tyler"],
    ["MSG7045", "Monique"],
    ["BFK6612", "Brian"],
    ["LEO2890", "Lena"],
    ["CQD4157", "Carlos"],
    ["SVR8823", "Shonda"],
    ["NHY1934", "Nathan"],
    ["IPB5076", "Irene"],
    ["OGT6348", "Omar"],
    ["YLM2461", "Yolanda"],
    ["WKS7709", "Wesley"],
    ["FAJ3195", "Fatima"],
    ["EZR8540", "Eric"],
    ["GTH1023", "Gloria"],
    ["HVN4686", "Hector"],
  ].map(([id, name]) => ({ id: id!, name: name! })),
  prior: [
    ["P10442", "Melissa"],
    ["P10587", "Derek"],
    ["P11036", "Tamika"],
    ["P11290", "Scott"],
    ["P11745", "Rosa"],
    ["P12018", "Jared"],
    ["P12331", "Keisha"],
    ["P12764", "Paul"],
  ].map(([id, name]) => ({ id: id!, name: name! })),
};
const ATTORNEYS = [
  ["Laura Bennett", "Bennett & Cole"],
  ["Marcus Hale", "Hale Law Group"],
  ["Diane Okafor", "Okafor Bankruptcy Law"],
  ["Steven Ruiz", "Ruiz & Partners"],
] as const;

export interface DerivedLoan {
  readonly profile: ContactProfile;
  readonly contacts: ContactRecord[];
  readonly promises: PromiseRecord[];
  readonly bankruptcy: BankruptcyCase | null;
  readonly cadence: CadenceEpisode[];
  /** A third party's authorization by the day it was received, for the record on later days. */
  readonly authorizations: readonly PlainDate[];
}

export function deriveLoan(life: LoanLife, ctx: DeriveContext): DerivedLoan {
  const lk = `${ctx.key}/${life.loan_id}`;
  const profile = drawProfile(rngFor(`${lk}/profile`), life, ctx.pins);
  const d = life.draw;
  const R = ctx.rates;
  const complaintW = complaintWeights(R);
  const lastMonth = life.months[life.months.length - 1];
  const endOn: PlainDate =
    life.payoff?.on ?? life.transfer_out_on ?? (lastMonth ? lastMonth.as_of : d.first_due);
  const active = (on: PlainDate) => on <= endOn;
  const drafts: Draft[] = [];
  let seq = 0;
  const authorizations: PlainDate[] = [];
  const b1 = d.parties[0]!;
  const b2 = d.parties[1];
  const full = (p: { given_name: string; surname: string }) => `${p.given_name} ${p.surname}`;
  const agentFor = (r: Rng, on: PlainDate) => r.pick(AGENTS[servicerOn(life, on)]);

  /* bankruptcy: drawn on a delinquency that reaches day 30 */
  const episodes = delinquencies(life, endOn);
  let bankruptcy: BankruptcyCase | null = null;
  {
    const r = rngFor(`${lk}/bk`);
    for (const ep of episodes) {
      if (!ep.day30) continue;
      const u = r.next();
      const lag = r.int(0, 30);
      const ch13 = r.chance(CHAPTER_13_SHARE);
      const noticeLag = r.int(1, 3);
      const disch = ch13 ? r.int(36, 60) : r.int(100, 130);
      const who = r.pick(ATTORNEYS);
      const last4 = String(r.int(1000, 9999));
      if (!(u < PETITION_SHARE || ctx.pins?.bankruptcy === true)) continue;
      const lastDay = ep.cured_on ? addDays(ep.cured_on, -1) : endOn;
      let petition = addDays(ep.day30, lag);
      if (petition > lastDay) petition = lastDay;
      const discharged = ch13 ? addMonths(petition, disch) : addDays(petition, disch);
      bankruptcy = {
        chapter: ch13 ? 13 : 7,
        petition_on: petition,
        noticed_on: addDays(petition, noticeLag),
        discharged_on: discharged <= endOn ? discharged : null,
        attorney: who[0],
        firm: who[1],
        case_last4: last4,
      };
      break;
    }
  }
  const bk = bankruptcy;
  /** Collection is barred from the petition, until a Chapter 13 discharge; after a Chapter 7 discharge it never resumes. */
  const barred = (on: PlainDate) =>
    bk !== null &&
    on >= bk.petition_on &&
    !(bk.chapter === 13 && bk.discharged_on !== null && on >= bk.discharged_on);
  const disclaimer = (on: PlainDate) =>
    bk !== null &&
    on >= bk.noticed_on &&
    !(bk.chapter === 13 && bk.discharged_on !== null && on >= bk.discharged_on);

  const rec = (on: PlainDate) =>
    recordOn(life, on, {
      profile,
      bankruptcy: bk,
      authorization_on: authorizations.filter((a) => a <= on).pop() ?? null,
    });

  /** A promise window: from the call to the day it is due, when the cadence is ceased (ptp_pending). */
  const promiseWindows: { from: PlainDate; to: PlainDate }[] = [];
  const pending = (on: PlainDate) => promiseWindows.find((w) => w.from <= on && on <= w.to);

  /** A promise drawn from what the borrower then did: the next receipt within three weeks keeps it; otherwise it may be made and broken. */
  const drawPromise = (r: Rng, on: PlainDate, f: RecordFacts): Draft["promise"] => {
    const uBroken = r.next();
    const lagBroken = r.int(7, 14);
    if (promiseWindows.some((w) => w.from <= addDays(on, 21) && w.to >= on)) return null;
    const next = life.receipts.find((x) => x.on > on && x.mode !== "payoff");
    if (next && daysBetween(on, next.on) <= 21) {
      return {
        made_on: on,
        pay_by: next.on,
        amount: next.amount,
        status: "kept",
        receipt_id: next.id,
        scripted: false,
      };
    }
    if (uBroken < BROKEN_PROMISE && f.past_due) {
      const by = addDays(on, lagBroken);
      if (by <= endOn)
        return {
          made_on: on,
          pay_by: by,
          amount: f.past_due.total,
          status: "broken",
          receipt_id: null,
          scripted: false,
        };
    }
    return null;
  };

  const voiceDisclosures = (on: PlainDate, f: RecordFacts, conversation: boolean) => ({
    recording: conversation,
    fdcpa: conversation && (profile.debt_collector || (f.past_due !== null && !disclaimer(on))),
    bankruptcy: conversation && disclaimer(on),
  });

  const handleSeconds = (r: Rng, factor: number, interpreter: boolean) => {
    const mean = R.handle_minutes.mean * 60;
    const x =
      mean *
      (factor / HANDLE_NORM) *
      lognormalMeanOne(r, 0.5) *
      (interpreter ? INTERPRETER_FACTOR : 1);
    return Math.max(90, Math.round(x));
  };
  const acwOf = (r: Rng, handle: number) => Math.min(Math.round(handle * 0.25), r.int(20, 90));

  /* ── inbound ─────────────────────────────────────────────────────────── */

  interface InboundOpts {
    readonly issue?: string;
    readonly party?: PartyRole;
    readonly forceChannel?: ContactMode;
    readonly purpose?: ContactPurpose;
    readonly scriptedPromise?: Draft["promise"];
    readonly followUp?: boolean;
  }
  const inbound = (
    r: Rng,
    on: PlainDate,
    reason: InquiryReason,
    o: InboundOpts = {},
  ): Draft | null => {
    if (!active(on) && reason !== "lien_release") return null;
    const f = rec(on);
    const uChannel = r.next();
    const uIvr = r.next();
    const uParty = r.next();
    const uPresent = r.next();
    const uComplaint = r.next();
    const uRes = r.next();
    const minute = minutesAt(r, 8, 21);
    const agent = agentFor(r, on);
    const hs = handleSeconds(r, HANDLE_FACTOR[reason], profile.language === "es");
    const acw = acwOf(r, hs);
    const ivrSecs = r.int(45, 240);
    const promiseR = rngFor(`${lk}/promise/${on}/${reason}`);
    const smsOk = smsConsentOn(on);
    const issue = o.issue ?? `${reason}:${on.slice(0, 7)}`;
    const base: Omit<
      Draft,
      | "mode"
      | "outcome"
      | "party"
      | "party_name"
      | "live_contact"
      | "live_contact_basis"
      | "identity_verified"
      | "resolution"
      | "duration_s"
      | "handle_s"
      | "human_agent"
      | "transcript"
      | "disclosures_marked"
      | "complaint_voiced"
      | "complaint_logged"
      | "qrpc"
      | "promise"
      | "interpreter"
    > = {
      on,
      minute,
      seq: seq++,
      direction: "inbound",
      phone_number_id: null,
      purpose:
        o.purpose ??
        (o.scriptedPromise
          ? "promise_to_pay"
          : reason === "bankruptcy"
            ? "bankruptcy_notice"
            : "borrower_inquiry"),
      reason,
      issue,
      language: profile.language,
      tcpa_basis: "n/a",
      tcpa_consent: false,
      regf_counted: false,
      counts_as_inquiry: true,
    };
    const quiet = {
      party: "borrower" as PartyRole,
      party_name: full(b1),
      live_contact: false,
      live_contact_basis: null,
      identity_verified: null,
      human_agent: null,
      transcript: false,
      disclosures_marked: { recording: false, fdcpa: false, bankruptcy: false },
      complaint_voiced: false,
      complaint_logged: false,
      qrpc: false,
      promise: null,
      interpreter: false,
    };
    // The channel: a letter, an e-mail, a text, or the phone.
    let channel: ContactMode = o.forceChannel ?? "call";
    if (!o.forceChannel && !o.scriptedPromise && reason !== "bankruptcy") {
      const pLetter = LETTER_SHARE[reason] ?? 0;
      const pEmail = profile.email_on_file && reason !== "disaster_assistance" ? EMAIL_SHARE : 0;
      const pText =
        smsOk && (reason === "payment_received" || reason === "make_payment") ? TEXT_SHARE : 0;
      if (uChannel < pLetter) channel = "letter";
      else if (uChannel < pLetter + pEmail) channel = "email";
      else if (uChannel < pLetter + pEmail + pText) channel = "sms";
    }
    if (channel === "letter" || channel === "email" || channel === "sms") {
      return {
        ...base,
        ...quiet,
        mode: channel,
        outcome: "received",
        purpose:
          o.purpose ??
          (channel === "letter" && reason === "hardship" ? "hardship_letter" : base.purpose),
        resolution: reason === "hardship" ? "pending_documents" : "information_provided",
        duration_s: 0,
        handle_s: 0,
        human_agent: agent.id,
      };
    }
    // The phone: the menu first.
    if (!o.scriptedPromise && !o.followUp && reason !== "bankruptcy" && channel === "call") {
      const self = IVR_SELF_SERVE[reason] ?? 0.03;
      if (uIvr < IVR_ABANDON)
        return {
          ...base,
          ...quiet,
          mode: "ivr",
          outcome: "ivr_abandoned",
          resolution: "unresolved",
          duration_s: Math.min(ivrSecs, 90),
          handle_s: 0,
        };
      if (uIvr < IVR_ABANDON + self)
        return {
          ...base,
          ...quiet,
          purpose: "self_service",
          mode: "ivr",
          outcome: "ivr_self_served",
          resolution: "self_served",
          duration_s: ivrSecs,
          handle_s: 0,
        };
    }
    // An agent: who is calling, and whether they pass the checks.
    let party: PartyRole = o.party ?? "borrower";
    let partyName: string | null = full(b1);
    let verified = true;
    let basis: ContactRecord["live_contact_basis"] = "borrower_initiated";
    if (!o.party) {
      if (uParty < UNVERIFIED_CALLER) {
        party = "unknown_caller";
        partyName = null;
        verified = false;
      } else if (profile.spouse && uParty < UNVERIFIED_CALLER + SPOUSE_CALLS) {
        party = "spouse_not_on_note";
        partyName = profile.spouse.name;
        verified = profile.spouse.authorized || uPresent < SPOUSE_WITH_BORROWER_PRESENT;
        basis = profile.spouse.authorized ? "authorized_agent" : "borrower_initiated";
      } else if (
        reason === "hardship" &&
        f.past_due &&
        f.past_due.days >= 30 &&
        uParty > 1 - COUNSELOR_ON_HARDSHIP
      ) {
        party = "housing_counselor";
        partyName = null;
        basis = "authorized_agent";
        // The counselor's authorization reaches the servicer first, by fax or mail.
        const auth = rollForward(addDays(on, -r.int(2, 8)), servicerCalendar);
        authorizations.push(auth);
        drafts.push({
          ...base,
          ...quiet,
          on: auth,
          minute: minutesAt(r, 9, 17),
          seq: seq++,
          mode: "letter",
          outcome: "received",
          party: "housing_counselor",
          party_name: null,
          purpose: "third_party_authorization",
          reason: "hardship",
          resolution: "acknowledged",
          duration_s: 0,
          handle_s: 0,
          counts_as_inquiry: false,
        });
      } else if (b2 && uParty > 1 - CO_BORROWER_CALLS) {
        party = "co_borrower";
        partyName = full(b2);
      }
    } else if (party === "attorney") {
      partyName = bk ? bk.attorney : null;
      basis = "authorized_agent";
    }
    const interpreter =
      profile.language === "es" && party !== "attorney" && party !== "housing_counselor";
    const live = verified && party !== "unknown_caller";
    const complaintP =
      COMPLAINT_BASE *
      complaintW(reason) *
      (profile.style === "irritated" ? IRRITATED_COMPLAINT : 1);
    const complaint = live && uComplaint < complaintP;
    const behind = f.past_due !== null;
    const promise =
      live &&
      behind &&
      !barred(on) &&
      (reason === "payment_arrangement" || reason === "hardship" || o.scriptedPromise)
        ? (o.scriptedPromise ?? drawPromise(promiseR, on, f))
        : null;
    if (promise) promiseWindows.push({ from: promise.made_on, to: promise.pay_by });
    const resolution: Resolution = !live
      ? "unresolved"
      : promise
        ? "promise_recorded"
        : complaint
          ? "escalated"
          : reason === "hardship" || reason === "disaster_assistance"
            ? uRes < 0.5
              ? "transferred"
              : "referred_lossmit"
            : reason === "late_fee"
              ? uRes < 0.4
                ? "escalated"
                : "information_provided"
              : reason === "online_access" ||
                  reason === "autopay_setup" ||
                  reason === "account_update"
                ? "resolved"
                : reason === "payoff_request" || reason === "statement_copy"
                  ? "resolved"
                  : reason === "insurance" && uRes < 0.3
                    ? "pending_documents"
                    : uRes < 0.06
                      ? "callback_scheduled"
                      : "information_provided";
    const handle = live ? hs : Math.min(hs, r.int(60, 180));
    return {
      ...base,
      mode: "call",
      outcome: live ? "conversation" : "answered_unverified",
      party,
      party_name: partyName,
      live_contact: live,
      live_contact_basis: live
        ? party === "co_borrower" ||
          party === "borrower" ||
          (party === "spouse_not_on_note" && basis === "borrower_initiated")
          ? "borrower_initiated"
          : basis
        : null,
      qrpc: live && behind && (reason === "hardship" || reason === "payment_arrangement"),
      identity_verified: verified,
      resolution,
      interpreter,
      duration_s: handle - acw,
      handle_s: handle,
      human_agent: agent.id,
      transcript: true,
      // The attorney's call is how the servicer learns of the case: the disclaimer and the mini-Miranda are for the borrower.
      // Nothing about the debt is said to a caller nobody verified (§1006.6(d)(1)): the menu's recording notice alone.
      disclosures_marked:
        party === "attorney" || !live
          ? { recording: true, fdcpa: false, bankruptcy: false }
          : { ...voiceDisclosures(on, f, true), recording: true },
      complaint_voiced: complaint,
      complaint_logged: complaint,
      promise,
    };
  };

  /* consent to text, and the STOP that ends it */
  let smsRevokedOn: PlainDate | null = null;
  const smsConsentOn = (on: PlainDate) =>
    profile.sms_consent && (smsRevokedOn === null || on < smsRevokedOn);

  const push = (x: Draft | null) => {
    if (x) drafts.push(x);
    return x;
  };

  /* scripted promise calls: the scenario's, through the history's behavior rows */
  for (const b of life.behavior) {
    if (b.kind !== "promise_made") continue;
    const outcome = life.behavior.find(
      (x) => x.on >= b.on && (x.kind === "promise_kept" || x.kind === "promise_broken"),
    );
    if (!outcome) continue;
    const kept = outcome.kind === "promise_kept";
    const receipt = kept
      ? life.receipts.find((x) => x.on === outcome.on && x.mode === "promise")
      : undefined;
    const f = rec(b.on);
    const amount: Cents | undefined = receipt?.amount ?? f.past_due?.total ?? f.next?.amount;
    if (amount === undefined) continue;
    push(
      inbound(rngFor(`${lk}/ptp/${b.on}`), b.on, "payment_arrangement", {
        party: "borrower",
        issue: `dq:${episodes.find((e) => e.start <= b.on && (e.cured_on === null || b.on < e.cured_on))?.start ?? b.on}`,
        scriptedPromise: {
          made_on: b.on,
          pay_by: outcome.on,
          amount,
          status: kept ? "kept" : "broken",
          receipt_id: receipt?.id ?? null,
          scripted: true,
        },
      }),
    );
  }

  /* ordinary inbound, month by month, by status */
  const perYear = R.per_loan_year;
  // The events' calls are shares of the calibrated volume: at the public 2.0 a loan-year they are the rates below.
  const eventScale = perYear / CONTACT_DEFAULTS.per_loan_year;
  const firstMonth = d.first_due;
  for (let k = 0; k < life.months.length; k++) {
    const m = life.months[k]!;
    const monthStart = addMonths(firstMonth, k);
    const r = rngFor(`${lk}/in/${m.month}`);
    const bucket = statusOf(m.days_delinquent);
    const yearly = Math.max(
      0.1,
      perYear * STATUS_MULTIPLIER[bucket] - EVENT_CALLS[bucket] * eventScale,
    );
    const n = poisson(r, yearly / 12);
    const { y, m: mo } = parts(monthStart);
    const dim = daysInMonth(y, mo);
    if (n === 0) continue;
    const f0 = rec(monthStart);
    const mix: Partial<Record<InquiryReason, number>> = {
      ...(bucket === "current" ? MIX_CURRENT : MIX_BEHIND),
    };
    if (mo === 1) mix.form_1098 = (mix.form_1098 ?? 0) + JANUARY_1098;
    if (mo === 2) mix.form_1098 = (mix.form_1098 ?? 0) + FEBRUARY_1098;
    if (!d.escrowed) {
      mix.escrow_analysis = 0;
      mix.tax = (mix.tax ?? 0) * 0.3;
    }
    if (!f0.mi.active) mix.mi_cancellation = 0;
    if (!f0.late_charge) mix.late_fee = 0;
    // From the day the servicer holds the notice, a borrower calls about the case, not to arrange a payment: read by
    // the call's day, since the month the notice arrives holds days on both sides of it.
    const stayed: Partial<Record<InquiryReason, number>> = {
      ...mix,
      payment_arrangement: 0,
      hardship: 0,
      bankruptcy: 0.15,
    };
    for (let c = 0; c < n; c++) {
      const day = r.int(1, dim);
      let on = ymd(y, mo, day);
      if (dayOfWeek(on) === 0) on = addDays(on, 1);
      const reason = weightedOf(r, bk && on >= bk.noticed_on ? stayed : mix);
      const rr = rngFor(`${lk}/in/${m.month}/${c}`);
      if (on > endOfMonth(monthStart)) continue;
      push(inbound(rr, on, reason));
    }
  }

  /* calls the events bring */
  const spike = (
    key: string,
    lambda: number,
    from: PlainDate,
    days: readonly [number, number],
    reasons: Partial<Record<InquiryReason, number>>,
    issue: string,
  ) => {
    const r = rngFor(`${lk}/ev/${key}`);
    const n = poisson(r, lambda * eventScale);
    for (let c = 0; c < n; c++) {
      let on = addDays(from, r.int(days[0], days[1]));
      if (dayOfWeek(on) === 0) on = addDays(on, 1);
      const reason = weightedOf(r, reasons);
      push(inbound(rngFor(`${lk}/ev/${key}/${c}`), on, reason, { issue }));
    }
  };
  for (const a of life.analyses) {
    const changed = a.shortage !== null || a.new_payment * 100n > a.old_payment * 105n;
    const lambda = 0.15 + (changed ? 0.3 : 0) + (a.anomalies.length ? 0.15 : 0);
    spike(
      `analysis/${a.year}`,
      lambda,
      a.sent_on,
      [4, 40],
      changed ? { escrow_analysis: 0.55, payment_change: 0.45 } : { escrow_analysis: 1 },
      `escrow:${a.year}`,
    );
  }
  for (const a of life.arm_changes)
    spike(
      `arm/${a.change}`,
      0.35,
      a.notice_sent_on,
      [3, 30],
      { rate_change: 1 },
      `arm:${a.change}`,
    );
  if (life.transfer_in_on)
    spike(
      "boarding",
      0.7,
      life.transfer_in_on,
      [2, 45],
      { servicing_transfer: 0.45, payment_received: 0.2, online_access: 0.2, autopay_setup: 0.15 },
      "transfer",
    );
  for (const b of life.behavior) {
    if (b.kind === "disaster")
      spike(
        `disaster/${b.on}`,
        0.4,
        b.on,
        [3, 50],
        { disaster_assistance: 0.6, insurance: 0.4 },
        `disaster:${b.on}`,
      );
    if (b.kind === "stale_bill_pay")
      spike(
        `stale/${b.on}`,
        0.5,
        b.on,
        [3, 20],
        { payment_change: 0.7, late_fee: 0.3 },
        `stale:${b.on}`,
      );
  }
  for (const fee of life.fees)
    spike(`fee/${fee.due}`, 0.12, fee.assessed_on, [2, 25], { late_fee: 1 }, `fee:${fee.due}`);
  for (const x of life.pmi)
    if (x.status === "terminated" && x.effective_on)
      spike(`mi/${x.on}`, 0.2, x.effective_on, [10, 40], { mi_cancellation: 1 }, "mi");
  for (const x of life.disbursements)
    if (x.kind === "refund")
      spike(`refund/${x.on}`, 0.1, x.on, [5, 25], { escrow_analysis: 1 }, `refund:${x.on}`);
  {
    // The 1098 in January, for a loan that paid interest to this servicer the year before.
    for (let y = parts(d.first_due).y + 1; y <= parts(endOn).y; y++) {
      const jan = ymd(y, 1, 10);
      if (!active(jan)) break;
      const f = rec(addDays(jan, 5));
      if (f.form_1098) spike(`1098/${y}`, 0.08, jan, [0, 36], { form_1098: 1 }, `1098:${y - 1}`);
    }
  }
  if (life.payoff) {
    spike("payoff/before", 0.6, life.payoff.on, [-40, -7], { payoff_request: 1 }, "payoff");
    spike("payoff/after", 0.35, life.payoff.on, [15, 45], { lien_release: 1 }, "payoff");
  }
  if (bk) {
    // The attorney's call with the notice of filing, and the notice itself by mail.
    push(
      inbound(rngFor(`${lk}/bk/call`), bk.noticed_on, "bankruptcy", {
        party: "attorney",
        issue: "bankruptcy",
      }),
    );
    const r = rngFor(`${lk}/bk/letter`);
    drafts.push({
      on: rollForward(addDays(bk.noticed_on, r.int(1, 5)), servicerCalendar),
      minute: minutesAt(r, 9, 16),
      seq: seq++,
      direction: "inbound",
      mode: "letter",
      party: "attorney",
      party_name: bk.attorney,
      phone_number_id: null,
      outcome: "received",
      live_contact: false,
      live_contact_basis: null,
      qrpc: false,
      identity_verified: null,
      purpose: "bankruptcy_notice",
      reason: "bankruptcy",
      resolution: "acknowledged",
      issue: "bankruptcy",
      language: "en",
      interpreter: false,
      duration_s: 0,
      handle_s: 0,
      human_agent: null,
      tcpa_basis: "n/a",
      tcpa_consent: false,
      regf_counted: false,
      disclosures_marked: { recording: false, fdcpa: false, bankruptcy: false },
      complaint_voiced: false,
      complaint_logged: false,
      counts_as_inquiry: false,
      transcript: false,
      promise: null,
    });
  }

  /* follow-ups on issues left open */
  for (const x of [...drafts]) {
    if (x.direction !== "inbound" || x.mode !== "call" || x.outcome !== "conversation" || !x.reason)
      continue;
    if (
      !["pending_documents", "unresolved", "escalated", "callback_scheduled"].includes(x.resolution)
    )
      continue;
    const r = rngFor(`${lk}/fu/${x.on}/${x.seq}`);
    const go = r.chance(FOLLOW_UP);
    const lag = r.int(3, 15);
    if (go)
      push(
        inbound(rngFor(`${lk}/fu/${x.on}/${x.seq}/call`), addDays(x.on, lag), x.reason, {
          issue: x.issue,
          followUp: true,
        }),
      );
  }

  /* outbound: payment reminders by text and e-mail, between days 6 and 9 */
  for (const inst of life.installments) {
    if (inst.due > endOn) break;
    const r = rngFor(`${lk}/rem/${inst.due}`);
    const day = addDays(inst.due, r.int(6, 9));
    const uStop = r.next();
    const uEmail = r.next();
    const minute = minutesAt(r, 9, 19);
    if (inst.satisfied_on !== null && inst.satisfied_on <= day) continue;
    if (!active(day) || barred(day)) continue;
    const textOk = smsConsentOn(day);
    const mode: ContactMode | null = textOk
      ? "sms"
      : profile.paperless && uEmail < EMAIL_REMINDER
        ? "email"
        : null;
    if (!mode) continue;
    drafts.push(outboundWritten(day, minute, mode, "payment_reminder", `dq:${inst.due}`, textOk));
    if (mode === "sms" && uStop < STOP_REPLY) {
      smsRevokedOn = addDays(day, 0);
      drafts.push({
        ...outboundWritten(day, minute + 7, "sms", "consent_revocation", "consent", true),
        direction: "inbound",
        outcome: "received",
        resolution: "resolved",
        counts_as_inquiry: false,
      });
    }
  }
  function outboundWritten(
    on: PlainDate,
    minute: number,
    mode: ContactMode,
    purpose: ContactPurpose,
    issue: string,
    consent: boolean,
  ): Draft {
    return {
      on,
      minute,
      seq: seq++,
      direction: "outbound",
      mode,
      party: "borrower",
      party_name: full(b1),
      phone_number_id: mode === "sms" ? profile.phones[0]!.id : null,
      outcome: mode === "sms" ? "sms_sent" : mode === "email" ? "email_sent" : "mail_sent",
      live_contact: false,
      live_contact_basis: null,
      qrpc: false,
      identity_verified: null,
      purpose,
      reason: null,
      resolution: "sent",
      issue,
      language: profile.language,
      interpreter: false,
      duration_s: 0,
      handle_s: 0,
      human_agent: null,
      tcpa_basis: mode === "sms" ? "consent" : "n/a",
      tcpa_consent: mode === "sms" ? consent : false,
      regf_counted: false,
      disclosures_marked: { recording: false, fdcpa: false, bankruptcy: false },
      complaint_voiced: false,
      complaint_logged: false,
      counts_as_inquiry: false,
      transcript: false,
      promise: null,
    };
  }

  /* outbound: the cadence, from day 17 to the cure */
  const cadence: CadenceEpisode[] = [];
  const voicemailOn = new Map<string, PlainDate>();
  const badCount = new Map<string, number>();
  const removed = new Set<string>();
  const notices: PlainDate[] = [];
  const twoInSeven = d.property.state === "MA";
  /** The day of every attempt so far, for Massachusetts' two calls in seven days. */
  const dialed: PlainDate[] = [];
  for (const ep of episodes) {
    const issue = `dq:${ep.start}`;
    const r = rngFor(`${lk}/dq/${ep.start}`);
    const paused: { from: PlainDate; to: PlainDate; reason: "ptp_pending" | "bankruptcy" }[] = [];
    let stop = ep.cured_on ?? addDays(endOn, 1);
    if (stop > addDays(endOn, 1)) stop = addDays(endOn, 1);
    let closed: PlainDate | null = null;
    if (ep.day17 && ep.day17 < stop) {
      let packageSent = false;
      let dd = dialOnOrAfter(ep.day17);
      let n = 0;
      while (dd < stop) {
        if (barred(dd)) {
          paused.push({ from: dd, to: addDays(stop, -1), reason: "bankruptcy" });
          break;
        }
        const w = pending(dd);
        if (w) {
          paused.push({ from: w.from > ep.day17 ? w.from : dd, to: w.to, reason: "ptp_pending" });
          dd = dialOnOrAfter(addDays(w.to, 1));
          continue;
        }
        // Massachusetts: the third call at least eight days after the first of the two before it.
        const twoBack = dialed[dialed.length - 2];
        if (twoInSeven && twoBack !== undefined && daysBetween(twoBack, dd) < 8) {
          dd = dialOnOrAfter(addDays(twoBack, 8));
          continue;
        }
        const ar = rngFor(`${lk}/dq/${ep.start}/${n}`);
        const a = attempt(ar, dd, n, issue);
        drafts.push(a);
        dialed.push(dd);
        n++;
        if (
          a.outcome === "conversation" &&
          a.qrpc &&
          !packageSent &&
          ar.chance(LOSSMIT_PACKAGE_AFTER_HARDSHIP)
        ) {
          packageSent = true;
          const day = addBusinessDays(dd, ar.int(1, 2), servicerCalendar);
          if (day < stop)
            drafts.push(
              outboundWritten(day, minutesAt(ar, 9, 17), "letter", "lossmit_package", issue, false),
            );
        }
        if (a.promise) {
          promiseWindows.push({ from: a.promise.made_on, to: a.promise.pay_by });
          paused.push({ from: dd, to: a.promise.pay_by, reason: "ptp_pending" });
          dd = dialOnOrAfter(addDays(a.promise.pay_by, 1));
          continue;
        }
        if (a.outcome === "conversation" && profile.debt_collector) {
          // Reg F §1006.14(b)(2)(ii): no call in the seven days after a conversation; day 8 is the cadence's day 7.
          dd = addDays(dd, 7);
          continue;
        }
        const g = r.weighted(ATTEMPT_GAP);
        let nx = addDays(dd, twoInSeven ? Math.max(g, TWO_IN_SEVEN_GAP) : g);
        while (!isDialDay(nx) && nx > addDays(dd, 1)) nx = addDays(nx, -1);
        if (!isDialDay(nx)) nx = dialOnOrAfter(nx);
        dd = nx;
      }
      closed = addDays(stop, -1);
    }
    // The written notice by day 45: mailed between days 38 and 44, at most once in 180 days.
    for (const d38 of ep.day38s) {
      const nr = rngFor(`${lk}/ein/${d38}`);
      const day = rollForward(addDays(d38, nr.int(0, 4)), servicerCalendar);
      const prev = notices[notices.length - 1];
      if (day >= stop || barred(day) || (prev && daysBetween(prev, day) < 180)) continue;
      notices.push(day);
      drafts.push(
        outboundWritten(day, minutesAt(nr, 6, 8), "letter", "ei_written_notice", issue, false),
      );
    }
    cadence.push({
      start: ep.start,
      cured_on: ep.cured_on,
      opened_on: ep.day17 && ep.day17 < stop ? ep.day17 : null,
      closed_on: closed,
      paused,
    });
  }

  function attempt(r: Rng, on: PlainDate, n: number, issue: string): Draft {
    const usable = profile.phones.filter((p) => !removed.has(p.id));
    const phone = usable[n % Math.max(1, usable.length)] ?? profile.phones[0]!;
    const sat = dayOfWeek(on) === 6;
    const minute = sat
      ? r.int(...DIAL_MINUTES.saturday)
      : r.weighted([
          [r.int(...DIAL_MINUTES.morning), 0.3],
          [r.int(...DIAL_MINUTES.afternoon), 0.4],
          [r.int(...DIAL_MINUTES.evening), 0.3],
        ] as const);
    const coB = b2 !== undefined && r.chance(0.25);
    const agent = agentFor(r, on);
    const durRing = r.int(22, 40);
    const durVm = r.int(35, 58);
    const durShort = r.int(5, 14);
    const durWrong = r.int(30, 70);
    const durUnv = r.int(45, 130);
    const durRefused = r.int(15, 40);
    const hs = handleSeconds(r, COLLECTION_HANDLE_FACTOR, profile.language === "es");
    const acw = acwOf(r, hs);
    const promiseR = rngFor(`${lk}/promise/out/${on}`);
    let outcome: ContactOutcome;
    if (phone.status === "disconnected") {
      outcome = "disconnected";
      const c = (badCount.get(phone.id) ?? 0) + 1;
      badCount.set(phone.id, c);
      if (c >= 2) removed.add(phone.id);
    } else if (phone.status === "reassigned") {
      outcome = "wrong_number";
      removed.add(phone.id);
    } else {
      outcome = r.weighted(ATTEMPT_OUTCOMES);
      if (outcome === "voicemail_left") {
        const last = voicemailOn.get(phone.id);
        // 11.1 guardrail: no more than one voicemail per number per 7 days.
        if (last && daysBetween(last, on) < 7) outcome = "no_voicemail";
        else voicemailOn.set(phone.id, on);
      }
    }
    const f = rec(on);
    const conv = outcome === "conversation";
    const person = coB && conv ? b2! : b1;
    const promise = conv ? drawPromise(promiseR, on, f) : null;
    const voice =
      outcome === "conversation" ||
      outcome === "answered_unverified" ||
      outcome === "refused" ||
      outcome === "wrong_number" ||
      outcome === "voicemail_left";
    const duration =
      outcome === "conversation"
        ? hs - acw
        : outcome === "voicemail_left"
          ? durVm
          : outcome === "no_answer" || outcome === "no_voicemail"
            ? durRing
            : outcome === "wrong_number"
              ? durWrong
              : outcome === "answered_unverified"
                ? durUnv
                : outcome === "refused"
                  ? durRefused
                  : durShort;
    return {
      on,
      minute,
      seq: seq++,
      direction: "outbound",
      mode: "call",
      party: outcome === "wrong_number" ? "wrong_party" : coB && conv ? "co_borrower" : "borrower",
      party_name: outcome === "wrong_number" ? null : full(person),
      phone_number_id: phone.id,
      outcome,
      live_contact: conv,
      live_contact_basis: conv ? "human_voice" : null,
      qrpc: conv,
      identity_verified: conv
        ? true
        : outcome === "answered_unverified" || outcome === "refused" || outcome === "wrong_number"
          ? false
          : null,
      purpose: "collection",
      reason: null,
      resolution: conv
        ? promise
          ? "promise_recorded"
          : r.chance(0.5)
            ? "referred_lossmit"
            : "information_provided"
        : "no_contact",
      issue,
      language: profile.language,
      interpreter: conv && profile.language === "es",
      duration_s: duration,
      handle_s: conv
        ? hs
        : outcome === "answered_unverified"
          ? duration + acwOf(r, duration)
          : duration,
      human_agent: agent.id,
      tcpa_basis: phone.tcpa_voice ? "consent" : "human_manual_dial",
      tcpa_consent: phone.tcpa_voice,
      regf_counted: outcome !== "busy_or_failed" && outcome !== "disconnected",
      // Whoever answers hears the recording notice; nothing about the debt is said to someone unverified (§1006.6(d)(1)).
      disclosures_marked: {
        ...voiceDisclosures(on, f, conv),
        recording: conv || outcome === "answered_unverified",
      },
      complaint_voiced: false,
      complaint_logged: false,
      counts_as_inquiry: false,
      transcript: voice,
      promise,
    };
  }

  /* outbound: a welcome call after a transfer */
  if (life.transfer_in_on) {
    const r = rngFor(`${lk}/welcome`);
    if (r.chance(WELCOME_CALL)) {
      const on = dialOnOrAfter(addDays(life.transfer_in_on, r.int(7, 21)));
      // In Massachusetts, never within a week of a collection attempt, so no seven days hold three calls.
      const crowded = twoInSeven && dialed.some((x) => Math.abs(daysBetween(x, on)) < 8);
      if (active(on) && !barred(on) && !crowded) {
        const a = attempt(r, on, 0, "transfer");
        drafts.push({
          ...a,
          purpose: "welcome",
          qrpc: false,
          promise: null,
          resolution: a.outcome === "conversation" ? "information_provided" : "no_contact",
          disclosures_marked: { ...a.disclosures_marked, fdcpa: false },
        });
      }
    }
  }

  /* documents: declarations pages before renewals, hardship letters after calls, qualified written requests */
  if (d.escrowed)
    for (const x of life.disbursements) {
      if (x.kind !== "bill" || x.line !== "hazard") continue;
      const r = rngFor(`${lk}/dec/${x.on}`);
      if (!r.chance(DEC_PAGE)) continue;
      const on = rollForward(addDays(x.on, -r.int(10, 40)), servicerCalendar);
      if (!active(on)) continue;
      drafts.push({
        ...outboundWritten(
          on,
          minutesAt(r, 9, 17),
          "letter",
          "insurance_document",
          `insurance:${x.on}`,
          false,
        ),
        direction: "inbound",
        outcome: "received",
        party: r.chance(0.6) ? "insurance_agent" : "borrower",
        resolution: "acknowledged",
        reason: "insurance",
      });
    }
  for (const x of [...drafts]) {
    if (x.direction !== "inbound" || x.mode !== "call" || x.outcome !== "conversation") continue;
    const r = rngFor(`${lk}/doc/${x.on}/${x.seq}`);
    const uLetter = r.next();
    const lag = r.int(5, 20);
    const uQwr = r.next();
    const qLag = r.int(4, 25);
    if (x.reason === "hardship" && uLetter < HARDSHIP_LETTER_AFTER_CALL) {
      const on = rollForward(addDays(x.on, lag), servicerCalendar);
      if (active(on))
        drafts.push({
          ...outboundWritten(on, minutesAt(r, 9, 17), "letter", "hardship_letter", x.issue, false),
          direction: "inbound",
          outcome: "received",
          resolution: "pending_documents",
          reason: "hardship",
        });
    }
    if (x.complaint_voiced && uQwr < QWR_AFTER_COMPLAINT)
      qwr(r, rollForward(addDays(x.on, qLag), servicerCalendar), x.reason ?? "late_fee", x.issue);
  }
  {
    const r = rngFor(`${lk}/qwr`);
    const n = poisson(r, QWR_PER_LOAN_YEAR * (life.months.length / 12));
    for (let c = 0; c < n; c++) {
      const on = rollForward(
        addDays(d.first_due, r.int(30, Math.max(31, life.months.length * 30))),
        servicerCalendar,
      );
      qwr(
        r,
        on,
        r.pick(["late_fee", "escrow_analysis", "payment_received", "credit_reporting"] as const),
        `qwr:${on}`,
      );
    }
  }
  function qwr(r: Rng, on: PlainDate, reason: InquiryReason, issue: string) {
    if (!active(on)) return;
    drafts.push({
      ...outboundWritten(
        on,
        minutesAt(r, 9, 17),
        "letter",
        "qualified_written_request",
        issue,
        false,
      ),
      direction: "inbound",
      outcome: "received",
      resolution: "acknowledged",
      reason,
      counts_as_inquiry: true,
    });
    const ack = addBusinessDays(on, r.int(2, 5), servicerCalendar);
    drafts.push(
      outboundWritten(ack, minutesAt(r, 6, 8), "letter", "qwr_acknowledgment", issue, false),
    );
  }

  /* portal sessions */
  if (profile.portal_user) {
    for (let k = 0; k < life.months.length; k++) {
      const m = life.months[k]!;
      const monthStart = addMonths(firstMonth, k);
      const r = rngFor(`${lk}/web/${m.month}`);
      const { y, m: mo } = parts(monthStart);
      const bump =
        (life.analyses.some((a) => a.sent_on.slice(0, 7) === m.month) ? 0.5 : 0) +
        (mo === 1 ? 0.3 : 0);
      const n = poisson(r, PORTAL_PER_YEAR / 12 + bump);
      for (let c = 0; c < n; c++) {
        const on = ymd(y, mo, r.int(1, daysInMonth(y, mo)));
        if (!active(on)) continue;
        drafts.push({
          ...outboundWritten(
            on,
            minutesAt(r, 6, 23),
            "portal",
            "self_service",
            `web:${m.month}`,
            false,
          ),
          direction: "inbound",
          outcome: "portal_session",
          resolution: "self_served",
          duration_s: r.int(60, 900),
          counts_as_inquiry: false,
          phone_number_id: null,
        });
      }
    }
  }

  /* order, ids, related contacts, promises */
  drafts.sort((a, b) =>
    a.on !== b.on
      ? a.on < b.on
        ? -1
        : 1
      : a.minute !== b.minute
        ? a.minute - b.minute
        : a.seq - b.seq,
  );
  const byIssue = new Map<string, string[]>();
  const contacts: ContactRecord[] = [];
  const promises: PromiseRecord[] = [];
  drafts.forEach((x, i) => {
    const id = `${life.loan_id}-K${String(i + 1).padStart(4, "0")}`;
    const prior = byIssue.get(x.issue) ?? [];
    const promiseId = x.promise ? `${id}-P` : null;
    if (x.promise && promiseId) promises.push({ id: promiseId, contact_id: id, ...x.promise });
    contacts.push({
      id,
      loan_id: life.loan_id,
      servicer: servicerOn(life, x.on),
      on: x.on,
      at: hhmm(Math.min(x.minute, 23 * 60 + 59)),
      direction: x.direction,
      mode: x.mode,
      party: x.party,
      party_name: x.party_name,
      phone_number_id: x.phone_number_id,
      outcome: x.outcome,
      live_contact: x.live_contact,
      live_contact_basis: x.live_contact_basis,
      qrpc: x.qrpc,
      identity_verified: x.identity_verified,
      purpose: x.purpose,
      reason: x.reason,
      resolution: x.resolution,
      issue: x.issue,
      related: [...prior],
      language: x.language,
      interpreter: x.interpreter,
      duration_s: x.duration_s,
      handle_s: x.handle_s,
      human_agent: x.human_agent,
      tcpa_basis: x.tcpa_basis,
      tcpa_consent: x.tcpa_consent,
      regf_counted: x.regf_counted,
      disclosures_marked: x.disclosures_marked,
      complaint_voiced: x.complaint_voiced,
      complaint_logged: x.complaint_logged,
      counts_as_inquiry: x.counts_as_inquiry,
      transcript: x.transcript,
      promise_id: promiseId,
    });
    byIssue.set(x.issue, [...prior, id]);
  });
  return {
    profile,
    contacts,
    promises,
    bankruptcy,
    cadence,
    authorizations: [...authorizations].sort(),
  };
}
