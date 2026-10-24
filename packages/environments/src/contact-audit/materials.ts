/**
 * A loan's contact history over a window, as the audit desk receives it:
 * the contact log, the comment log, the calls' transcripts as the recorder
 * exported them, the promise log and the complaint log as they stood at the
 * window's end, and the payments. Everything is read off one contact center
 * (the clean one or a twin with a staff error) and the loan's history, and
 * nothing the reviewer reads says which.
 */

import type { LifeBook } from "../life/generate.js";
import type { LoanLife } from "../life/simulate.js";
import {
  PRIOR_SERVICER,
  SERVICER,
  complaintLog,
  kindOf,
  money,
  transcriptOf,
  type ContactCenter,
  type LoanContacts,
} from "../contacts/index.js";
import { clock } from "../contacts/format.js";
import type {
  AuditComplaint,
  AuditContact,
  AuditLine,
  AuditNote,
  AuditPayment,
  AuditPromise,
  ContactAuditTask,
} from "./task.js";

export interface Window {
  readonly from: string;
  readonly to: string;
}

const inWindow = (on: string, w: Window) => on >= w.from && on <= w.to;

type Materials = Pick<
  ContactAuditTask,
  "loan" | "window" | "contacts" | "notes" | "transcripts" | "promises" | "complaints" | "payments"
>;

/** Everything the reviewer may read, for one loan of a center over the window. */
export function materialsOf(
  center: ContactCenter,
  book: LifeBook,
  index: number,
  w: Window,
): Materials {
  const life: LoanLife = book.loans[index]!;
  const loan: LoanContacts = center.loans[index]!;
  const d = life.draw;
  const rows = loan.contacts.filter((c) => inWindow(c.on, w));
  const contacts: AuditContact[] = rows.map((c) => ({
    id: c.id,
    on: c.on,
    at: c.at,
    direction: c.direction,
    mode: c.mode,
    with: c.party,
    outcome: c.outcome,
    purpose: c.purpose,
    reason: c.reason,
    resolution: c.resolution,
    issue: c.issue,
    agent: c.human_agent,
    duration_s: c.duration_s,
    promise_id: c.promise_id,
    complaint_logged: c.complaint_logged,
    transcript: kindOf(c) !== null,
  }));
  const transcripts: Record<string, AuditLine[]> = {};
  for (const c of rows) {
    if (kindOf(c) === null) continue;
    transcripts[c.id] = transcriptOf(center, book, c.id).turns.map((t, k) => ({
      line: k + 1,
      at: clock(t.start_s),
      speaker: t.label,
      text: t.text,
    }));
  }
  const notes: AuditNote[] = loan.notes
    .filter((n) => inWindow(n.on, w))
    .map((n) => ({
      id: n.id,
      on: n.on,
      at: n.at,
      user: n.user,
      area: n.area,
      text: n.text,
      contact: n.contact_id,
    }));
  const promises: AuditPromise[] = loan.promises
    .filter((p) => inWindow(p.made_on, w))
    .map((p) => ({
      id: p.id,
      contact: p.contact_id,
      made_on: p.made_on,
      pay_by: p.pay_by,
      amount: money(p.amount),
      status: p.pay_by <= w.to ? p.status : "pending",
    }));
  const complaints: AuditComplaint[] = complaintLog(loan, center.key)
    .filter((x) => inWindow(x.received_on, w))
    .map((x) => {
      const sent = x.responded_on <= w.to;
      return {
        id: x.id,
        contact: x.contact_id,
        received_on: x.received_on,
        channel: x.channel,
        category: x.category,
        acknowledged_on: x.acknowledged_on,
        respond_by: x.respond_by,
        responded_on: sent ? x.responded_on : null,
        response: sent ? x.response : null,
      };
    });
  const payments: AuditPayment[] = life.receipts
    .filter((r) => inWindow(r.on, w))
    .map((r) => ({
      id: r.id,
      on: r.on,
      amount: money(r.amount),
      applied_to: r.installments.map((i) => i.due),
      to_suspense: money(r.to_suspense),
    }));
  const us = rows.every((c) => c.servicer === "us");
  return {
    loan: {
      number: d.servicer_loan_number,
      borrowers: d.parties.map((p) => `${p.given_name} ${p.surname}`),
      state: d.property.state,
      servicer: us ? SERVICER.name : PRIOR_SERVICER.name,
    },
    window: { ...w },
    contacts,
    notes,
    transcripts,
    promises,
    complaints,
    payments,
  };
}
