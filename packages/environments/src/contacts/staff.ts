/**
 * Staff errors: what an agent did not record, planted in a loan's contact
 * history as the life generator plants a vendor's or a system's error
 * (life/defects.ts, `history`). Each is made on one contact the clean history
 * has, so the twin is the clean history until that contact, and the contact
 * center's own rules from there. Two are planted, numbered apart from the
 * catalog's D-, V- and T- defects and from the call defects C-01 to C-08:
 *
 *   S-01  a promise not tracked: the borrower promises a payment on a call,
 *         the call's words and the agent's note carry it, and no promise
 *         record is written (the row's promise_id null, no promise in the
 *         log), the call dispositioned as it would have been without the
 *         promise, by the same draw (a hardship call transferred or referred
 *         to loss mitigation, a dialer's conversation referred or information
 *         provided half the time each, any other as its reason has it). It is
 *         made on a promise the contact center drew from a call, never on the
 *         scenario's own promise call, whose purpose code says
 *         promise_to_pay: a twin keeps every row's purpose, and that code on
 *         a call with no promise would give the error away without its note
 *         being read. What the contact center's rules then do: nothing ceases
 *         the dialer for the promise, so it calls inside the window; a kept
 *         promise is never marked kept; a broken one is never followed up;
 *   S-02  a complaint not logged: a complaint voiced on a call is not logged
 *         (C-04's error at the call: the row's flag, the agent's
 *         acknowledgment, the note), and nobody escalates it: the call is
 *         dispositioned as its reason would have it without the complaint, by
 *         the same draw, and followed up as a call of that row is (where the
 *         row is closed, nothing in the log holds its issue open, so the
 *         follow-up the escalation drew is not made). So the complaint system
 *         opens no case (complaints.ts), nothing acknowledges it, nobody
 *         answers it in writing, and nobody tells the borrower how to put it
 *         in writing, so no written request follows it as one may follow a
 *         logged complaint; nothing having come of it, the borrower calls
 *         about it again 3 to 60 days later, a call filed under an issue of
 *         its own because no case links it to the first, and that call is not
 *         logged either. It is the borrower's call again about the matter,
 *         which a pinned borrower makes about some of the matters an agent
 *         handled (derive.ts, `closed_follow_up`) and this one always makes:
 *         the one the clean history drew there is not made. Beside the
 *         complaint it is drawn as any call of its reason that reaches an
 *         agent is: who calls, how it is dispositioned, a promise taken on
 *         it, a follow-up and the letters after it.
 *
 * The twin is derived again with the error made (`StaffOverride`,
 * derive.ts): every draw is the clean history's, and the error changes only
 * what the contact center's rules make of it. Its rows keep the clean
 * history's ids where the two hold the same contact (`contactKey`: the day
 * and time, direction, mode, purpose, reason and issue), so every stream keyed
 * by a contact id draws the same and every other call is word for word the
 * clean one; a row the twin adds is named off the root (`<root>-S01-1`, the
 * borrower's call again `<root>-S02`, what follows from it `<root>-S02-1`), and
 * a row it drops keeps its id spent.
 *
 * The labels are the life generator's (`DefectLabel`), with the contact a
 * finding names for each and, for a symptom a reviewer's rule can name, which
 * one (`symptom`). The root is the call's missing record: S-01's row's
 * promise_id, S-02's row's complaint_logged. Every other difference between
 * the two histories, field by field, is a symptom: the contact log (but its
 * `related` lists, which are the log's own index of each issue), the promise
 * log, the comment log, the complaint log, the transcripts and the dialer's
 * pauses. A symptom a rule names:
 *
 *   dialed_in_window        S-01: an outbound collection attempt after the
 *                           promise call, on or before its pay-by date;
 *   kept_not_marked         S-01: the payments after the call met the promise
 *                           by its date, and no record marks it kept;
 *   broken_not_followed_up  S-01: they did not, and no record marks it broken
 *                           or resumes the dialer for it;
 *   no_acknowledgment       S-02: no acknowledgment on the call;
 *   no_response             S-02: no case, so no written response by the
 *                           fifteenth day;
 *   raised_again            S-02: the borrower's later call about it, with
 *                           the same reason, not logged either.
 *
 * A clean book is byte for byte what it was: nothing here runs unless an error
 * is asked for, and `StaffOverride` and `unrecorded_promises` are absent from
 * every clean history (where every complaint voiced is logged, so a written
 * request after one is drawn as it was). So neither CONTACTS_VERSION nor
 * LIFE_VERSION moves.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import type { LifeBook } from "../life/generate.js";
import type { DefectLabel } from "../life/defects.js";
import type { LoanLife } from "../life/simulate.js";
import { toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import type { ContactCenter } from "./center.js";
import { complaintLog } from "./complaints.js";
import { contactKey, deriveLoan, type DeriveContext, type StaffOverride } from "./derive.js";
import { money } from "./format.js";
import { notesFor } from "./notes.js";
import { kindOf, planCall } from "./plan.js";
import { buildTranscript } from "./transcript.js";
import type {
  ContactRecord,
  LoanContacts,
  NoteRecord,
  ProfilePins,
  PromiseRecord,
} from "./types.js";
import { templateWriter, type ContactTextWriter } from "./writer.js";

export type StaffErrorId = "S-01" | "S-02";
export const STAFF_ERROR_IDS: readonly StaffErrorId[] = ["S-01", "S-02"];

export const STAFF_SYMPTOMS = [
  "dialed_in_window",
  "kept_not_marked",
  "broken_not_followed_up",
  "no_acknowledgment",
  "no_response",
  "raised_again",
] as const;
export type StaffSymptom = (typeof STAFF_SYMPTOMS)[number];

export interface StaffError {
  readonly id: StaffErrorId;
  readonly title: string;
  /** Where the root lives: the call's row, and the field that should hold the record. */
  readonly table: "contacts";
  readonly field: "promise_id" | "complaint_logged";
  /** The symptoms a reviewer's rule can name. */
  readonly symptoms: readonly StaffSymptom[];
  /** Whether the error can be made on this contact, from its row alone. */
  eligible(c: ContactRecord): boolean;
  readonly handling: string;
}

const handledCall = (c: ContactRecord) =>
  c.mode === "call" && c.outcome === "conversation" && c.human_agent !== null;

export const STAFF_ERRORS: Readonly<Record<StaffErrorId, StaffError>> = {
  "S-01": {
    id: "S-01",
    title: "A promise to pay made on a call and not recorded",
    table: "contacts",
    field: "promise_id",
    symptoms: ["dialed_in_window", "kept_not_marked", "broken_not_followed_up"],
    // A call that also carries a complaint is left out: its disposition would be the complaint's either way. So is
    // the scenario's own promise call, whose purpose code says promise_to_pay: a twin keeps every row's purpose, and a
    // promise_to_pay call with no promise is one no clean history holds, found by its row without reading its note.
    eligible: (c) =>
      handledCall(c) &&
      c.promise_id !== null &&
      !c.complaint_voiced &&
      c.purpose !== "promise_to_pay",
    handling:
      "Record the promise as of the call (its amount and pay-by date as the borrower gave them), so the dialer is ceased " +
      "for its window (the servicing app's early-intervention plan ceases the cadence for a promise to pay) and the promise " +
      "is marked kept or broken against the payments. Review every call made inside the window for harm, follow up a " +
      "broken promise, and coach the agent.",
  },
  "S-02": {
    id: "S-02",
    title: "A complaint voiced on a call and never logged",
    table: "contacts",
    field: "complaint_logged",
    symptoms: ["no_acknowledgment", "no_response", "raised_again"],
    eligible: (c) => handledCall(c) && c.complaint_logged,
    handling:
      "Log the complaint as received on the call's day (spec 4.5: an oral complaint is a complaint), acknowledge it, and " +
      "answer it in writing; the response was due by the fifteenth day (SM_COMPLAINT_RESOLVE_15) and is late. Treat the " +
      "later calls as the same complaint raised again (4.5's repeat flag), check it for the substance of a notice of error " +
      "(comment 35(a)-2; §1024.35's procedures reach a written notice, and a call is not one, so the borrower is told how to " +
      "send one, §1024.38(b)(5)), and coach the agent.",
  },
};

export function staffErrorById(id: string): StaffError {
  const e = (STAFF_ERRORS as Record<string, StaffError>)[id];
  if (!e)
    throw new RangeError(`no staff error ${id}; there are ${Object.keys(STAFF_ERRORS).join(", ")}`);
  return e;
}

export interface StaffLabel extends DefectLabel {
  /** The contact a reviewer's finding names for it: the root's call, an attempt, the borrower's later call; null for a difference no finding names. */
  readonly contact: string | null;
  /** The symptom a reviewer's rule names, or null for the root and for every other difference. */
  readonly symptom: StaffSymptom | null;
  /** A transcript's turn, for a label on one. */
  readonly turn: number | null;
  /** On S-01's root: the promise the call made, as the record should have held it (the amount in dollars). */
  readonly promise?: { readonly amount: string; readonly pay_by: PlainDate };
}

export type StaffErrorRequest =
  | StaffErrorId
  | { readonly id: StaffErrorId; readonly rate?: number; readonly contacts?: readonly string[] };

/** How often each is made, among the contacts it fits: a design choice until a partner's QA findings arrive. */
export const DEFAULT_STAFF_ERROR_RATE = 0.02;

export interface StaffPlantOptions {
  /** The pins the center was drawn with, by book index: the twin is derived with the same. */
  readonly pins?: Readonly<Record<number, ProfilePins>>;
  readonly writer?: ContactTextWriter;
}

export interface StaffErrorResult {
  readonly clean: ContactCenter;
  readonly defective: ContactCenter;
  readonly labels: readonly StaffLabel[];
  /** Roots asked for and not made, with why: a loan takes one of each error. */
  readonly skipped: readonly {
    readonly id: StaffErrorId;
    readonly contact: string;
    readonly reason: string;
  }[];
}

const loanOf = (center: ContactCenter, contactId: string): number => {
  const k = center.loans.findIndex((l) => l.contacts.some((c) => c.id === contactId));
  if (k < 0) throw new RangeError(`no contact ${contactId} in this center`);
  return k;
};

export function plantStaffErrors(
  center: ContactCenter,
  book: LifeBook,
  requests: readonly StaffErrorRequest[],
  opts: StaffPlantOptions = {},
): StaffErrorResult {
  if (book.seed !== center.seed)
    throw new RangeError(`the center is seed ${center.seed}'s; the book is seed ${book.seed}'s`);
  const roots = new Map<number, { "S-01"?: ContactRecord; "S-02"?: ContactRecord }>();
  const skipped: { id: StaffErrorId; contact: string; reason: string }[] = [];
  for (const req of requests) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = staffErrorById(r.id);
    const rate = r.rate ?? DEFAULT_STAFF_ERROR_RATE;
    const candidates: string[] = r.contacts
      ? [...r.contacts]
      : center.loans.flatMap((l) =>
          l.contacts
            .filter(
              (c) =>
                def.eligible(c) && rngFor(`${center.key}/staff/${def.id}/${c.id}`).next() < rate,
            )
            .map((c) => c.id),
        );
    for (const cid of candidates) {
      const k = loanOf(center, cid);
      const c = center.loans[k]!.contacts.find((x) => x.id === cid)!;
      if (!def.eligible(c))
        throw new RangeError(
          `${def.id} cannot be made on ${cid}: ${def.title.toLowerCase()} needs a contact it fits`,
        );
      const at = roots.get(k) ?? {};
      const other = def.id === "S-01" ? at["S-02"] : at["S-01"];
      if (at[def.id]) {
        skipped.push({ id: def.id, contact: cid, reason: `the loan already carries ${def.id}` });
        continue;
      }
      if (other?.id === cid) {
        skipped.push({ id: def.id, contact: cid, reason: "one staff error a call" });
        continue;
      }
      roots.set(k, { ...at, [def.id]: c });
    }
  }
  const writer = opts.writer ?? templateWriter;
  if (writer.id !== center.writer)
    throw new RangeError(`the center was written by ${center.writer}, not ${writer.id}`);
  const labels: StaffLabel[] = [];
  const planted = { ...center.planted };
  const loans = [...center.loans];
  for (const [k, asked] of [...roots].sort((a, b) => a[0] - b[0])) {
    const base: DeriveContext = {
      key: center.key,
      rates: center.rates,
      ...(opts.pins?.[k] ? { pins: opts.pins[k] } : {}),
    };
    let made: Made = asked;
    let twin = twinLoan(center, book.loans[k]!, center.loans[k]!, made, base, writer);
    if ("gone" in twin) {
      // One error's twin does not make the call the other was asked for: S-01's, where a promise it let a later call
      // take ended the issue S-02's call followed up; S-02's, where a promise taken on the call raising the complaint
      // again ceased the dialer on S-01's day, or kept S-01's call from taking its own, or where S-01's call was the
      // borrower's call again about the complaint's matter, whose place the call raising it again takes. That one is
      // not made, and the other is made alone.
      const lost = twin.gone;
      const kept: StaffErrorId = lost === "S-02" ? "S-01" : "S-02";
      skipped.push({
        id: lost,
        contact: asked[lost]!.id,
        reason: `the twin with ${kept} does not make this call`,
      });
      made = { [kept]: asked[kept]! };
      twin = twinLoan(center, book.loans[k]!, center.loans[k]!, made, base, writer);
      if ("gone" in twin) throw new Error(`${asked[twin.gone]!.id}: a call no staff error removes`);
    }
    loans[k] = twin.loan;
    labels.push(...twin.labels);
    for (const id of twin.c04) planted[id] = "C-04";
  }
  return { clean: center, defective: { ...center, planted, loans }, labels, skipped };
}

/* ── the twin ────────────────────────────────────────────────────────────── */

const summary = (c: ContactRecord) =>
  `${c.direction} ${c.mode} ${c.outcome} ${c.purpose}${c.reason ? ` ${c.reason}` : ""}`;
const promiseText = (p: Pick<PromiseRecord, "amount" | "pay_by">) =>
  `${money(p.amount)} by ${p.pay_by}`;
/** Keys made unique by their occurrence: the second contact with one key is `key#2`. */
function occurrences(keys: readonly string[]): string[] {
  const n = new Map<string, number>();
  return keys.map((k) => {
    const i = (n.get(k) ?? 0) + 1;
    n.set(k, i);
    return i === 1 ? k : `${k}#${i}`;
  });
}
const noteKey = (n: NoteRecord) => `${n.on} ${n.at} ${n.user} ${n.area} ${n.contact_id ?? "-"}`;

/** The contact fields compared row by row: all but the id and `related`, the log's own index of an issue. */
const COMPARED: readonly (keyof ContactRecord)[] = [
  "servicer",
  "on",
  "at",
  "direction",
  "mode",
  "party",
  "party_name",
  "phone_number_id",
  "outcome",
  "live_contact",
  "live_contact_basis",
  "qrpc",
  "identity_verified",
  "purpose",
  "reason",
  "resolution",
  "issue",
  "language",
  "interpreter",
  "duration_s",
  "handle_s",
  "human_agent",
  "tcpa_basis",
  "tcpa_consent",
  "regf_counted",
  "disclosures_marked",
  "complaint_voiced",
  "complaint_logged",
  "counts_as_inquiry",
  "transcript",
  "promise_id",
];

/** `a` is after `b`: a later day, or the same day at a later time. */
const after = (a: Pick<ContactRecord, "on" | "at">, b: Pick<ContactRecord, "on" | "at">) =>
  a.on > b.on || (a.on === b.on && a.at > b.at);

interface Made {
  readonly "S-01"?: ContactRecord;
  readonly "S-02"?: ContactRecord;
}

function twinLoan(
  center: ContactCenter,
  life: LoanLife,
  clean: LoanContacts,
  made: Made,
  base: DeriveContext,
  writer: ContactTextWriter,
): { loan: LoanContacts; labels: StaffLabel[]; c04: string[] } | { gone: StaffErrorId } {
  // The clean history again, to hold the pins to the center's and to read its keys.
  const again = deriveLoan(life, base);
  if (
    toJsonLine(again.contacts) !== toJsonLine(clean.contacts) ||
    toJsonLine(again.profile) !== toJsonLine(clean.profile)
  )
    throw new RangeError(
      `${clean.loan_id}: the center was drawn with other pins than those given; pass the center's own`,
    );
  const cleanKeys = occurrences(again.keys);
  const s01 = made["S-01"];
  const s02 = made["S-02"];
  const keyOf = (c: ContactRecord) => contactKey(c);
  for (const root of [s01, s02])
    if (root && again.keys.filter((x) => x === keyOf(root)).length !== 1)
      throw new RangeError(`${root.id}: another contact on the loan shares its key`);
  const staff: StaffOverride = {
    ...(s01 ? { unrecorded_promise: keyOf(s01) } : {}),
    ...(s02 ? { unlogged_complaint: keyOf(s02) } : {}),
  };
  const d = deriveLoan(life, { ...base, staff });
  if (s01 && !d.unrecorded.length) {
    if (s02) return { gone: "S-01" };
    throw new Error(`${s01.id}: the twin recorded the promise`);
  }
  if (s02 && !d.keys.includes(keyOf(s02))) return { gone: "S-02" };

  // Ids: the clean one wherever the two hold the same contact.
  const cleanId = new Map(cleanKeys.map((k, i) => [k, clean.contacts[i]!.id]));
  const twinKeys = occurrences(d.keys);
  let added = 0;
  const finalOf = new Map<string, string>();
  twinKeys.forEach((k, i) => {
    const raw = d.contacts[i]!.id;
    const id =
      d.raised_again !== null && d.keys[i] === d.raised_again && s02
        ? `${s02.id}-S02`
        : (cleanId.get(k) ??
          (s01 ? `${s01.id}-S01-${++added}` : s02 ? `${s02.id}-S02-${++added}` : null));
    if (id === null) throw new Error(`${raw}: a row no staff error adds`);
    finalOf.set(raw, id);
  });
  const fid = (raw: string) => finalOf.get(raw)!;
  const contacts: ContactRecord[] = d.contacts.map((c) => ({
    ...c,
    id: fid(c.id),
    related: c.related.map(fid),
    promise_id: c.promise_id ? `${fid(c.id)}-P` : null,
  }));
  const remapPromise = (p: PromiseRecord): PromiseRecord => ({
    ...p,
    id: `${fid(p.contact_id)}-P`,
    contact_id: fid(p.contact_id),
  });
  const promises = d.promises.map(remapPromise);
  const unrecorded = d.unrecorded.map(remapPromise);
  const partial: Omit<LoanContacts, "notes"> = {
    loan_id: clean.loan_id,
    index: clean.index,
    profile: d.profile,
    contacts,
    promises,
    bankruptcy: d.bankruptcy,
    cadence: d.cadence,
    ...(unrecorded.length ? { unrecorded_promises: unrecorded } : {}),
  };
  if (toJsonLine(d.profile) !== toJsonLine(clean.profile))
    throw new Error(`${clean.loan_id}: the twin drew another profile`);

  // Notes: written from the twin's rows, then given the clean ids wherever the two hold the same note.
  const rawNotes = notesFor(life, partial, center.key, writer);
  const cleanNoteId = new Map(
    occurrences(clean.notes.map(noteKey)).map((k, i) => [k, clean.notes[i]!.id]),
  );
  const perContact = new Map<string, number>();
  const noteIds = new Map<string, string>();
  occurrences(rawNotes.map(noteKey)).forEach((k, i) => {
    const n = rawNotes[i]!;
    let id = cleanNoteId.get(k);
    if (!id) {
      const owner = n.contact_id ?? clean.loan_id;
      const j = (perContact.get(owner) ?? 0) + 1;
      perContact.set(owner, j);
      id = `${owner}-N${j}`;
    }
    noteIds.set(n.id, id);
  });
  const notes: NoteRecord[] = rawNotes.map((n) => ({
    ...n,
    id: noteIds.get(n.id)!,
    copied_from: n.copied_from ? noteIds.get(n.copied_from)! : null,
  }));
  const loan: LoanContacts = { ...partial, notes };

  /* ── labels ── */
  const labels: StaffLabel[] = [];
  const owner = (c: ContactRecord): StaffErrorId =>
    s02 && (c.id === s02.id || c.id === `${s02.id}-S02`) ? "S-02" : s01 ? "S-01" : "S-02";
  const label = (
    id: StaffErrorId,
    table: string,
    field: string,
    row: string,
    on: PlainDate,
    truth: string | null,
    plantedValue: string | null,
    o: {
      root?: boolean;
      contact?: string | null;
      symptom?: StaffSymptom | null;
      turn?: number | null;
      promise?: StaffLabel["promise"];
    } = {},
  ): StaffLabel => ({
    loan: life.loan_id,
    defect_id: id,
    file_or_table: table,
    field,
    row,
    on,
    true_value: truth,
    planted_value: plantedValue,
    expected_handling: o.root
      ? STAFF_ERRORS[id].handling
      : `Downstream of ${id}: corrects when the root cause is corrected.`,
    root_cause: o.root ?? false,
    contact: o.contact ?? null,
    symptom: o.symptom ?? null,
    turn: o.turn ?? null,
    ...(o.promise ? { promise: o.promise } : {}),
  });

  // The contact log.
  const cleanByKey = new Map(cleanKeys.map((k, i) => [k, clean.contacts[i]!]));
  const twinByKey = new Map(twinKeys.map((k, i) => [k, contacts[i]!]));
  const promise01 = unrecorded[0] ?? null;
  for (const [k, c] of cleanByKey) {
    const t = twinByKey.get(k);
    if (!t) {
      labels.push(label(s01 ? "S-01" : "S-02", "contacts", "*", c.id, c.on, summary(c), null));
      continue;
    }
    for (const f of COMPARED) {
      const a = toJsonLine(c[f] ?? null);
      const b = toJsonLine(t[f] ?? null);
      if (a === b) continue;
      const v = (x: unknown) => (x === null || x === undefined ? null : String(x));
      if (s01 && c.id === s01.id && f === "promise_id")
        labels.push(
          label("S-01", "contacts", f, c.id, c.on, v(c[f]), v(t[f]), {
            root: true,
            contact: c.id,
            ...(promise01
              ? { promise: { amount: money(promise01.amount), pay_by: promise01.pay_by } }
              : {}),
          }),
        );
      else if (s02 && c.id === s02.id && f === "complaint_logged")
        labels.push(
          label("S-02", "contacts", f, c.id, c.on, "true", "false", { root: true, contact: c.id }),
        );
      else
        labels.push(
          label(
            owner(c),
            "contacts",
            f,
            c.id,
            c.on,
            typeof c[f] === "object" ? a : v(c[f]),
            typeof t[f] === "object" ? b : v(t[f]),
          ),
        );
    }
  }
  for (const [k, t] of twinByKey) {
    if (cleanByKey.has(k)) continue;
    const s02again = s02 !== undefined && t.id === `${s02.id}-S02`;
    const inWindow =
      s01 !== undefined &&
      promise01 !== null &&
      t.direction === "outbound" &&
      t.mode === "call" &&
      t.purpose === "collection" &&
      after(t, s01) &&
      t.on <= promise01.pay_by;
    labels.push(
      label(s02again || !s01 ? "S-02" : "S-01", "contacts", "*", t.id, t.on, null, summary(t), {
        contact: s02again || inWindow ? t.id : null,
        symptom: s02again ? "raised_again" : inWindow ? "dialed_in_window" : null,
      }),
    );
  }

  // The promise log. A promise is the error's whose call made it; one S-02's call raising the complaint again takes
  // is S-02's, and every other one the twin moved is S-01's where S-01 is made.
  const promiseOwner = (p: PromiseRecord): StaffErrorId => {
    const c = contacts.find((x) => x.id === p.contact_id);
    return c ? owner(c) : s01 ? "S-01" : "S-02";
  };
  const cleanPromises = new Map(clean.promises.map((p) => [p.id, p]));
  const twinPromises = new Map(promises.map((p) => [p.id, p]));
  for (const [id, p] of cleanPromises) {
    const t = twinPromises.get(id);
    const isRoot = s01 !== undefined && p.contact_id === s01.id;
    if (!t) {
      labels.push(
        label(promiseOwner(p), "contact_promises", "*", id, p.made_on, promiseText(p), null),
      );
      if (isRoot)
        labels.push(
          label("S-01", "contact_promises", "status", id, p.pay_by, p.status, null, {
            contact: s01!.id,
            symptom: p.status === "kept" ? "kept_not_marked" : "broken_not_followed_up",
          }),
        );
      continue;
    }
    for (const f of ["made_on", "pay_by", "amount", "status", "receipt_id", "scripted"] as const)
      if (toJsonLine(p[f] ?? null) !== toJsonLine(t[f] ?? null))
        labels.push(
          label(
            promiseOwner(p),
            "contact_promises",
            f,
            id,
            p.made_on,
            toJsonLine(p[f] ?? null),
            toJsonLine(t[f] ?? null),
          ),
        );
  }
  for (const [id, t] of twinPromises)
    if (!cleanPromises.has(id))
      labels.push(
        label(promiseOwner(t), "contact_promises", "*", id, t.made_on, null, promiseText(t)),
      );

  // The comment log.
  const errorOfNote = (n: NoteRecord): StaffErrorId => {
    const c = n.contact_id
      ? (contacts.find((x) => x.id === n.contact_id) ??
        clean.contacts.find((x) => x.id === n.contact_id))
      : undefined;
    return c ? owner(c) : s01 ? "S-01" : "S-02";
  };
  const cleanNotes = new Map(clean.notes.map((n) => [n.id, n]));
  const twinNotes = new Map(notes.map((n) => [n.id, n]));
  for (const [id, n] of cleanNotes) {
    const t = twinNotes.get(id);
    if (!t) labels.push(label(errorOfNote(n), "contact_notes", "text", id, n.on, n.text, null));
    else if (t.text !== n.text || t.copied_from !== n.copied_from)
      labels.push(label(errorOfNote(n), "contact_notes", "text", id, n.on, n.text, t.text));
  }
  for (const [id, t] of twinNotes)
    if (!cleanNotes.has(id))
      labels.push(label(errorOfNote(t), "contact_notes", "text", id, t.on, null, t.text));

  // The complaint log.
  const cleanCases = complaintLog(clean, center.key);
  const twinCases = new Map(complaintLog(loan, center.key).map((x) => [x.id, x]));
  for (const x of cleanCases) {
    if (twinCases.has(x.id)) continue;
    labels.push(label("S-02", "complaints", "*", x.id, x.received_on, x.category, null));
    if (s02 && x.contact_id === s02.id)
      labels.push(
        label("S-02", "complaints", "responded_on", x.id, x.respond_by, x.responded_on, null, {
          contact: s02.id,
          symptom: "no_response",
        }),
      );
  }
  for (const [id, x] of twinCases)
    if (!cleanCases.some((y) => y.id === id))
      labels.push(label("S-02", "complaints", "*", id, x.received_on, null, x.category));

  // The dialer's pauses.
  for (const ep of clean.cadence) {
    const t = d.cadence.find((x) => x.start === ep.start);
    if (toJsonLine(ep) !== toJsonLine(t ?? null))
      labels.push(
        label(
          s01 ? "S-01" : "S-02",
          "contact_cadence",
          "paused",
          ep.start,
          ep.start,
          toJsonLine(ep.paused),
          t ? toJsonLine(t.paused) : null,
        ),
      );
  }

  // The transcripts: the root's acknowledgment, and any call whose words the twin changed.
  const c04: string[] = [];
  if (s02) {
    c04.push(s02.id);
    if (contacts.some((x) => x.id === `${s02.id}-S02`)) c04.push(`${s02.id}-S02`);
    const row = contacts.find((x) => x.id === s02.id)!;
    const bad = buildTranscript(planCall(life, loan, row, center.key), { writer, defect: "C-04" });
    if (!bad?.plant) throw new Error(`${s02.id}: the call has no acknowledgment to leave out`);
    labels.push(
      label(
        "S-02",
        "contact_transcripts",
        "said",
        s02.id,
        s02.on,
        bad.plant.true_value,
        bad.plant.planted_value,
        {
          contact: s02.id,
          symptom: "no_acknowledgment",
          turn: bad.plant.at,
        },
      ),
    );
  }
  const said = (lc: LoanContacts, x: ContactRecord): string | null =>
    kindOf(x) === null
      ? null
      : buildTranscript(planCall(life, lc, x, center.key), { writer })!
          .transcript.turns.map((u) => u.said)
          .join(" ");
  for (const t of contacts) {
    if (c04.includes(t.id)) continue;
    const c = clean.contacts.find((x) => x.id === t.id);
    if (!c || toJsonLine(c) === toJsonLine({ ...t, related: c.related })) continue;
    const a = said(clean, c);
    const b = said(loan, t);
    if (a !== b) labels.push(label(owner(t), "contact_transcripts", "said", t.id, t.on, a, b));
  }
  return { loan, labels, c04 };
}
