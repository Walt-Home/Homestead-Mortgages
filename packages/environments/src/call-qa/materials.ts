/**
 * A call as the QA desk receives it, from the contact center: the row, the
 * transcript's lines, the record on the day, the dialer's facts, the note.
 *
 * The same call is read two ways. The reviewer reads what the recorder
 * wrote: the channel labels and the recognizer's text. The generator also
 * reads what was said, by whom, to hold the rubric's findings on the words
 * to its findings on the recognizer's text (generator.ts): v1 draws a call
 * only where the two agree.
 */

import { addDays, daysBetween, zonedEpochMs, type PlainDate } from "@hm/kernel/calendar";
import type { LoanLife } from "../life/simulate.js";
import { clock } from "../contacts/format.js";
import type {
  BankruptcyCase,
  ContactRecord,
  LoanContacts,
  NoteRecord,
  Speaker,
  Turn,
} from "../contacts/types.js";
import type {
  CallFacts,
  CallLine,
  CallNote,
  CallOutcome,
  CallUnderReview,
  LineSpeaker,
  PreDialFacts,
  RecordView,
} from "../calls/index.js";
import type { TranscriptLine } from "./task.js";
import { recordView } from "./view.js";

/** The property's time zone, by the life generator's states (life/draw.ts `STATES`). */
export const STATE_ZONE: Readonly<Record<string, string>> = {
  CA: "America/Los_Angeles",
  TX: "America/Chicago",
  FL: "America/New_York",
  NY: "America/New_York",
  IL: "America/Chicago",
  PA: "America/New_York",
  OH: "America/New_York",
  GA: "America/New_York",
  NC: "America/New_York",
  MI: "America/Detroit",
  NJ: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  AZ: "America/Phoenix",
  MA: "America/New_York",
  CO: "America/Denver",
};
/** The zones a number's area code can put a borrower in. */
export const AREA_ZONES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export const zoneOf = (state: string): string => {
  const z = STATE_ZONE[state];
  if (!z) throw new RangeError(`no time zone for ${state}`);
  return z;
};

const SPEAKER: Readonly<Record<Speaker, LineSpeaker>> = {
  AGENT: "agent",
  AGENT_2: "agent",
  CALLER: "caller",
  INTERPRETER: "interpreter",
  IVR: "ivr",
  SYSTEM: "system",
};
/** A stereo recording's channel labels, as the reviewer reads them. */
export const LABEL_SPEAKER: Readonly<Record<string, LineSpeaker>> = {
  Agent: "agent",
  Customer: "caller",
  Interpreter: "interpreter",
  IVR: "ivr",
  "": "system",
};

export const transcriptLines = (turns: readonly Turn[]): TranscriptLine[] =>
  turns.map((t, k) => ({ line: k + 1, at: clock(t.start_s), speaker: t.label, text: t.text }));

/** The lines as the reviewer reads them: the labels and the recognizer's text. */
export const heardLines = (lines: readonly TranscriptLine[]): CallLine[] =>
  lines.map((l) => {
    const speaker = LABEL_SPEAKER[l.speaker];
    if (!speaker) throw new RangeError(`no speaker for the label ${JSON.stringify(l.speaker)}`);
    return { line: l.line, speaker, text: l.text };
  });

/** The lines as they were said, by who said them. */
export const saidLines = (turns: readonly Turn[]): CallLine[] =>
  turns.map((t, k) => ({ line: k + 1, speaker: SPEAKER[t.speaker], text: t.said }));

export function callFacts(
  c: ContactRecord,
  loan: LoanContacts,
  over: { voice?: "human" | "ai"; servicemember?: boolean } = {},
): CallFacts {
  return {
    id: c.id,
    on: c.on,
    direction: c.direction,
    voice: over.voice ?? "human",
    outcome: c.outcome as CallOutcome,
    with: c.party,
    identity_verified: c.identity_verified,
    complaint_logged: c.complaint_logged,
    debt_collector: loan.profile.debt_collector,
    servicemember_active_duty: over.servicemember ?? false,
  };
}

/** An instant from the day and the wall time at the property. */
export const instantAt = (on: PlainDate, hhmm: string, zone: string): string =>
  new Date(zonedEpochMs(on, hhmm, zone)).toISOString();

/** The person a dialed call counts against: the one reached, or the borrower a wrong number was meant for. */
const personOf = (c: ContactRecord) => (c.party === "co_borrower" ? "co_borrower" : "borrower");

/** Contacts before `c` in the log: earlier days, and earlier on its own day. */
const before = (loan: LoanContacts, c: ContactRecord) => {
  const k = loan.contacts.findIndex((x) => x.id === c.id);
  return loan.contacts.slice(0, k);
};

/** How far back the dialer's snapshot lists counted calls: past the cap's 7 days, so a reader has to read the window. */
export const COUNTED_LOOKBACK_DAYS = 12;

/** The facts the dialer held when it dialed `c`, as the contact center's log gives them. */
export function preDialOf(
  life: LoanLife,
  loan: LoanContacts,
  c: ContactRecord,
  areaZone: string,
  mode: PreDialFacts["mode"],
  aiAttempts: readonly string[] = [],
): PreDialFacts {
  const state = life.draw.property.state;
  const zone = zoneOf(state);
  const phone = loan.profile.phones.find((p) => p.id === c.phone_number_id);
  if (!phone) throw new RangeError(`${c.id}: no number on file`);
  const prior = before(loan, c);
  const counted = prior.filter(
    (x) =>
      x.direction === "outbound" &&
      x.mode === "call" &&
      x.regf_counted &&
      personOf(x) === personOf(c) &&
      daysBetween(x.on, c.on) <= COUNTED_LOOKBACK_DAYS,
  );
  const voicemails = prior.filter(
    (x) =>
      x.outcome === "voicemail_left" &&
      x.phone_number_id === c.phone_number_id &&
      daysBetween(x.on, c.on) < 7,
  );
  return {
    dial_at: instantAt(c.on, c.at, zone),
    mode,
    time_zones: zone === areaZone ? [zone] : [zone, areaZone],
    line_type: phone.kind,
    tcpa_voice_consent_active: phone.tcpa_voice,
    written_consent: false,
    ai_voice_attempts_at: [...aiAttempts],
    fdcpa_debt_collector: loan.profile.debt_collector,
    state,
    counted_call_attempts_at: counted.map((x) => instantAt(x.on, x.at, zone)),
    voicemails_to_number_7d: voicemails.length,
    cease_active: false,
    written_cease: false,
    bk_active: false,
    attorney_represented: false,
  };
}

/** The agent's note on a call, and the day of the note it copied forward. */
export function noteOf(
  loan: LoanContacts,
  notes: readonly NoteRecord[],
  c: ContactRecord,
  user?: string,
): { note: CallNote; copiedOn: PlainDate | null } | null {
  const n = notes.find((x) => x.kind === "agent" && x.contact_id === c.id);
  if (!n) return null;
  const prev = n.copied_from ? notes.find((x) => x.id === n.copied_from) : undefined;
  if (n.copied_from && !prev) throw new RangeError(`${n.id}: copied from a note not in the log`);
  return {
    note: {
      on: n.on,
      at: n.at,
      user: user ?? n.user,
      text: n.text,
      copied_from: prev ? { on: prev.on } : null,
    },
    copiedOn: prev ? prev.on : null,
  };
}

/** The call under review, read either way. */
export function underReview(
  call: CallFacts,
  lines: readonly CallLine[],
  record: RecordView,
  preDial: PreDialFacts | null,
  note: CallNote | null,
  copied: RecordView | null,
): CallUnderReview {
  return { call, lines, record, pre_dial: preDial, note, copied_record: copied };
}

/** The records a call is read against: its day's, and the day a copied note was first written. */
export function recordsFor(
  life: LoanLife,
  loan: LoanContacts,
  on: PlainDate,
  copiedOn: PlainDate | null,
  bankruptcy: BankruptcyCase | null,
): { record: RecordView; copied: RecordView | null } {
  return {
    record: recordView(life, loan, on, bankruptcy),
    copied: copiedOn ? recordView(life, loan, copiedOn, bankruptcy) : null,
  };
}

/** Instants `days` days before the call's day, at the given minutes of the day at the property. */
export function priorInstants(
  on: PlainDate,
  zone: string,
  days: readonly number[],
  minutes: readonly number[],
): string[] {
  return days.map((d, k) => {
    const m = minutes[k % minutes.length]!;
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return instantAt(addDays(on, -d), `${hh}:${mm}`, zone);
  });
}
