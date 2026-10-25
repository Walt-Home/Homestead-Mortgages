/**
 * The contact center over a book: every loan's contact rows, promises,
 * bankruptcy and cadence (derive.ts), its comment log (notes.ts), and its
 * transcripts on demand (transcript.ts). A transcript is rendered when asked
 * for, from the call's plan, because a book's calls run to tens of millions
 * of words and a reader wants a few.
 *
 * `plantContactDefects` makes the defective twin: the same center with the
 * planted calls and notes changed, and a label for each. Every stream hangs
 * off `contacts/<version>/<book seed>`, and the life book is a function of
 * its own seed, so a center is a function of the book's seed and nothing else.
 */

import type { LifeBook } from "../life/generate.js";
import { loadCalibration, type Calibration } from "../life/calibration.js";
import type { LoanLife } from "../life/simulate.js";
import { rngFor } from "../rng.js";
import {
  CONTACT_DEFECTS,
  contactDefectById,
  plantInNote,
  type ContactDefectId,
  type ContactDefectLabel,
} from "./defects.js";
import { deriveLoan, STATUS_MULTIPLIER, statusOf, type StatusBucket } from "./derive.js";
import { fillFigures, inHand, notesFor } from "./notes.js";
import { kindOf, planCall, type CallPlan } from "./plan.js";
import { contactRates, type ContactRates } from "./rates.js";
import { buildTranscript, type BuiltTranscript } from "./transcript.js";
import type { ContactRecord, LoanContacts, NoteRecord, ProfilePins, Transcript } from "./types.js";
import { templateWriter, type ContactTextWriter } from "./writer.js";

/**
 * Bump on any change to what the contact center draws or writes. Every stream hangs off it (`contacts/<version>/<book
 * seed>`), so a bump draws every center again.
 *
 * 1.1.0 (24 October 2026): a petition the life scenario dates is the contact center's case; a complaint is said with
 * no filler inside it; the recognizer keeps the word that makes a number a rate; the transfer shield runs the 60 days
 * beginning on the transfer date, through day 59, as the record dates it and the agents say it.
 *
 * 1.2.0 (24 October 2026): the record holds the annual escrow statement mailed with an analysis and the analysis's
 * plan; a call about the escrow analysis is answered from them, the statement's item (viii) read line by line, and
 * its note records what was explained; C-05 and C-08 plant a wrong figure in that explanation; no statement is
 * mailed to a borrower more than 30 days behind at the analysis; a pin draws the borrower's call about each one;
 * and an interpreted call's note no longer reads the interpreter's relay of the question as a second question.
 */
export const CONTACTS_VERSION = "1.2.0";

export interface ContactCenter {
  readonly version: string;
  readonly seed: string;
  readonly life_version: string;
  /** The stream key every draw hangs off. */
  readonly key: string;
  readonly rates: ContactRates;
  readonly warnings: readonly string[];
  readonly writer: string;
  readonly loans: readonly LoanContacts[];
  /** The calls with a planted defect, by contact id. Empty on a clean center. */
  readonly planted: Readonly<Record<string, ContactDefectId>>;
}

export interface ContactCenterOptions {
  /** The calibration to read the contact rates from; default, the life generator's file through its reader. */
  readonly calibration?: Calibration;
  /** Profile fields pinned per loan, by book index. */
  readonly pins?: Readonly<Record<number, ProfilePins>>;
  readonly writer?: ContactTextWriter;
}

export function contactCenter(book: LifeBook, opts: ContactCenterOptions = {}): ContactCenter {
  const cal = opts.calibration ?? loadCalibration();
  const rates = contactRates(cal);
  const key = `contacts/${CONTACTS_VERSION}/${book.seed}`;
  const writer = opts.writer ?? templateWriter;
  const loans: LoanContacts[] = book.loans.map((life, index) => {
    const d = deriveLoan(life, {
      key,
      rates,
      ...(opts.pins?.[index] ? { pins: opts.pins[index] } : {}),
    });
    const partial = {
      loan_id: life.loan_id,
      index,
      profile: d.profile,
      contacts: d.contacts,
      promises: d.promises,
      bankruptcy: d.bankruptcy,
      cadence: d.cadence,
    };
    return { ...partial, notes: notesFor(life, partial, key, writer) };
  });
  return {
    version: CONTACTS_VERSION,
    seed: book.seed,
    life_version: book.version,
    key,
    rates,
    warnings: [...rates.warnings],
    writer: writer.id,
    loans,
    planted: {},
  };
}

const loanIdOf = (contactId: string) => contactId.replace(/-K\d+$/, "");

function locate(
  center: ContactCenter,
  book: LifeBook,
  contactId: string,
): { life: LoanLife; loan: LoanContacts; contact: ContactRecord } {
  const id = loanIdOf(contactId);
  const loan = center.loans.find((l) => l.loan_id === id);
  const life = book.loans.find((l) => l.loan_id === id);
  const contact = loan?.contacts.find((c) => c.id === contactId);
  if (!loan || !life || !contact)
    throw new RangeError(`no contact ${contactId} in this center and book`);
  if (book.seed !== center.seed)
    throw new RangeError(`the center is seed ${center.seed}'s; the book is seed ${book.seed}'s`);
  return { life, loan, contact };
}

export function callPlan(center: ContactCenter, book: LifeBook, contactId: string): CallPlan {
  const { life, loan, contact } = locate(center, book, contactId);
  return planCall(life, loan, contact, center.key);
}

/** A call's transcript, with its planted defect when the center has one there. */
export function transcriptOf(
  center: ContactCenter,
  book: LifeBook,
  contactId: string,
  writer: ContactTextWriter = templateWriter,
): Transcript {
  const built = buildTranscript(callPlan(center, book, contactId), {
    writer,
    defect: center.planted[contactId] ?? null,
  });
  if (!built) throw new RangeError(`${contactId}: the planted defect has no turn to go in`);
  return built.transcript;
}

/** Every call on a loan with a transcript. */
export const callsOf = (loan: LoanContacts): ContactRecord[] =>
  loan.contacts.filter((c) => kindOf(c) !== null);

/* ── defects ─────────────────────────────────────────────────────────────── */

export type ContactDefectRequest =
  | ContactDefectId
  | { readonly id: ContactDefectId; readonly rate?: number; readonly contacts?: readonly string[] };

/** How often each is planted, among the contacts it fits: a design choice until a partner's QA findings arrive. */
export const DEFAULT_DEFECT_RATE = 0.02;

export interface ContactDefectResult {
  readonly clean: ContactCenter;
  readonly defective: ContactCenter;
  readonly labels: readonly ContactDefectLabel[];
}

export function plantContactDefects(
  center: ContactCenter,
  book: LifeBook,
  requests: readonly ContactDefectRequest[],
): ContactDefectResult {
  const planted: Record<string, ContactDefectId> = { ...center.planted };
  const labels: ContactDefectLabel[] = [];
  const contactsByLoan = new Map(
    center.loans.map((l) => [l.loan_id, new Map(l.contacts.map((c) => [c.id, c]))]),
  );
  const notesByLoan = new Map(center.loans.map((l) => [l.loan_id, [...l.notes]]));
  const taken = new Set<string>(Object.keys(planted));
  for (const req of requests) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = contactDefectById(r.id);
    const rate = r.rate ?? DEFAULT_DEFECT_RATE;
    const candidates: string[] = r.contacts
      ? [...r.contacts]
      : center.loans.flatMap((l) =>
          l.contacts
            .filter(
              (c) =>
                def.eligible(c) && rngFor(`${center.key}/defects/${def.id}/${c.id}`).next() < rate,
            )
            .map((c) => c.id),
        );
    for (const cid of candidates) {
      if (taken.has(cid)) continue;
      const { life, loan, contact } = locate(center, book, cid);
      if (!def.eligible(contact))
        throw new RangeError(
          `${def.id} cannot be planted on ${cid}: ${def.title.toLowerCase()} needs a contact it fits`,
        );
      const plan = planCall(life, loan, contact, center.key);
      if (def.id === "C-08") {
        const notes = notesByLoan.get(loan.loan_id)!;
        const k = notes.findIndex((n) => n.kind === "agent" && n.contact_id === cid);
        if (k < 0) continue;
        const note = notes[k]!;
        const p = plantInNote(
          rngFor(`${center.key}/defects/C-08/${cid}/note`),
          note.text.split(" | PREV: ")[0]!,
          plan,
        );
        const rest = note.text.includes(" | PREV: ")
          ? note.text.slice(note.text.indexOf(" | PREV: "))
          : "";
        notes[k] = { ...note, text: p.text + rest };
        labels.push(
          label(
            life,
            def.id,
            "contact_notes",
            "text",
            note.id,
            note.on,
            null,
            p.true_value,
            p.planted_value,
            true,
          ),
        );
        taken.add(cid);
        continue;
      }
      const clean = buildTranscript(plan);
      const bad = buildTranscript(plan, { defect: def.id });
      if (!clean || !bad || !bad.plant) continue;
      planted[cid] = def.id;
      taken.add(cid);
      if (def.id === "C-04") {
        // The row says no complaint was logged; the turn where it was voiced is where to look.
        const voiced = bad.transcript.turns.findIndex((t) => t.tag === "complaint");
        const rows = contactsByLoan.get(loan.loan_id)!;
        rows.set(cid, { ...contact, complaint_logged: false });
        labels.push(
          label(
            life,
            "C-04",
            "contacts",
            "complaint_logged",
            cid,
            contact.on,
            voiced,
            "true",
            "false",
            true,
          ),
        );
        labels.push(
          label(
            life,
            "C-04",
            "contact_transcripts",
            "said",
            cid,
            contact.on,
            bad.plant.at,
            bad.plant.true_value,
            bad.plant.planted_value,
            false,
          ),
        );
        const notes = notesByLoan.get(loan.loan_id)!;
        const sysIdx = notes.findIndex((n) => n.contact_id === cid && n.area === "CMPL");
        if (sysIdx >= 0) {
          const gone = notes[sysIdx]!;
          notes.splice(sysIdx, 1);
          labels.push(
            label(
              life,
              "C-04",
              "contact_notes",
              "text",
              gone.id,
              gone.on,
              null,
              gone.text,
              null,
              false,
            ),
          );
        }
        const agentIdx = notes.findIndex((n) => n.kind === "agent" && n.contact_id === cid);
        if (agentIdx >= 0 && contact.human_agent) {
          const before = notes[agentIdx]!;
          const quiet: CallPlan = { ...plan, needs: { ...plan.needs, complaint: false } };
          const after = inHand(
            rngFor(`${center.key}/${life.loan_id}/notes/${cid}`),
            fillFigures(
              templateWriter.callNote(quiet, templateWriter.callTurns(plan)),
              quiet,
              contact.human_agent,
            ),
            contact.human_agent,
          );
          notes[agentIdx] = { ...before, text: after };
          labels.push(
            label(
              life,
              "C-04",
              "contact_notes",
              "text",
              before.id,
              before.on,
              null,
              before.text,
              after,
              false,
            ),
          );
        }
        continue;
      }
      labels.push(
        label(
          life,
          def.id,
          "contact_transcripts",
          "said",
          cid,
          contact.on,
          bad.plant.at,
          bad.plant.true_value,
          bad.plant.planted_value,
          true,
        ),
      );
    }
  }
  const defective: ContactCenter = {
    ...center,
    planted,
    loans: center.loans.map((l) => ({
      ...l,
      contacts: l.contacts.map((c) => contactsByLoan.get(l.loan_id)!.get(c.id)!),
      notes: notesByLoan.get(l.loan_id)!,
    })),
  };
  return { clean: center, defective, labels };
}

function label(
  life: LoanLife,
  id: ContactDefectId,
  table: string,
  field: string,
  row: string,
  on: ContactRecord["on"],
  turn: number | null,
  truth: string | null,
  planted: string | null,
  root: boolean,
): ContactDefectLabel {
  const def = CONTACT_DEFECTS[id];
  return {
    loan: life.loan_id,
    defect_id: id,
    file_or_table: table,
    field,
    row,
    on,
    turn,
    true_value: truth,
    planted_value: planted,
    expected_handling: root
      ? def.handling
      : `Downstream of ${id}: corrects when the root cause is corrected.`,
    root_cause: root,
  };
}

/* ── volumes ─────────────────────────────────────────────────────────────── */

export interface VolumeSummary {
  readonly loan_years: number;
  readonly inquiries: number;
  readonly per_loan_year: number;
  readonly by_status: Readonly<
    Record<
      StatusBucket,
      {
        readonly loan_years: number;
        readonly inquiries: number;
        readonly per_loan_year: number;
        readonly target: number;
      }
    >
  >;
  /** What the calibration and the status mix of this book say the whole should be. */
  readonly target: number;
}

/** Inquiries per loan-year, over the book and by the loan's status in the month of the contact. */
export function contactVolumes(center: ContactCenter, book: LifeBook): VolumeSummary {
  const months: Record<StatusBucket, number> = { current: 0, d30: 0, d60: 0, d90_plus: 0 };
  const count: Record<StatusBucket, number> = { current: 0, d30: 0, d60: 0, d90_plus: 0 };
  center.loans.forEach((loan, i) => {
    const life = book.loans[i]!;
    const status = new Map(life.months.map((m) => [m.month, statusOf(m.days_delinquent)]));
    for (const m of life.months) months[statusOf(m.days_delinquent)]++;
    for (const c of loan.contacts) {
      if (!c.counts_as_inquiry) continue;
      const s = status.get(c.on.slice(0, 7));
      if (s) count[s]++;
    }
  });
  const per = center.rates.per_loan_year;
  const by = {} as Record<
    StatusBucket,
    { loan_years: number; inquiries: number; per_loan_year: number; target: number }
  >;
  let ly = 0;
  let n = 0;
  let target = 0;
  for (const s of Object.keys(months) as StatusBucket[]) {
    const y = months[s] / 12;
    by[s] = {
      loan_years: y,
      inquiries: count[s],
      per_loan_year: y ? count[s] / y : 0,
      target: per * STATUS_MULTIPLIER[s],
    };
    ly += y;
    n += count[s];
    target += y * per * STATUS_MULTIPLIER[s];
  }
  return {
    loan_years: ly,
    inquiries: n,
    per_loan_year: ly ? n / ly : 0,
    by_status: by,
    target: ly ? target / ly : 0,
  };
}

/** The last day of contact with the borrower on or before `asOf`, by the contact center's log: what a tape's last-contact date reads. */
export function lastContactOn(
  loan: LoanContacts,
  asOf: ContactRecord["on"],
): ContactRecord["on"] | null {
  let last: ContactRecord["on"] | null = null;
  for (const c of loan.contacts) {
    if (c.on > asOf) break;
    if (c.live_contact || (c.direction === "inbound" && c.mode !== "portal")) last = c.on;
  }
  return last;
}

export type { BuiltTranscript, NoteRecord };
