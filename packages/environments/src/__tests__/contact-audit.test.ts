/**
 * Staff errors and contact-audit: the contact center makes S-01 (a promise
 * not tracked) and S-02 (a complaint not logged) on a call the clean history
 * has, and a clean center is what it was; the twin is the clean history until
 * the call, every other call word for word, and the contact center's rules
 * from there; the labels tell the root from what follows. contact-audit's
 * rulebook is pinned, its spec cases give what their hand-written labels say,
 * every generated window can be audited from the rulebook and the tools, the
 * grader requires a root's symptoms beside it and fails a root the window
 * does not hold, a clean window is a control, every window holds promises
 * recorded and complaints logged beside its roots, every plan and symptom
 * turns up, and no cheap policy passes much beyond the clean windows.
 */

import { describe, expect, it } from "vitest";
import { servicer as servicerCalendar } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { drawsHeldoutStream } from "../heldout-guard.js";
import { sha256, toJsonLine } from "../record.js";
import { rebuild } from "../call-qa/view.js";
import { COMPLAINT_PHRASES, says } from "../calls/index.js";
import {
  RAISED_AGAIN_AFTER,
  STAFF_ERRORS,
  complaintLog,
  contactKey,
  deriveLoan,
  plantContactDefects,
  plantStaffErrors,
  transcriptOf,
  type ContactCenter,
  type LoanContacts,
} from "../contacts/index.js";
import type { LifeBook } from "../life/generate.js";
import {
  ACK_PHRASES,
  AUDIT_EXTRA_FINDINGS_CAP,
  AUDIT_MIN_HANDLED,
  AUDIT_PLANS,
  CONTACT_AUDIT_FINGERPRINT,
  CONTACT_AUDIT_HELDOUT_SUITE,
  CONTACT_AUDIT_RULEBOOK,
  CONTACT_AUDIT_SPEC_CASES,
  ContactAuditReferencePolicy,
  auditArmOf,
  auditPlanOf,
  contactAudit,
  contactAuditPayload,
  contactAuditSpecTasks,
  contactAuditTaskId,
  contactAuditVerdict,
  drawContactAuditCandidate,
  drawContactAuditTask,
  executeContactAuditTool,
  expectedContactAudit,
  generateContactAuditSuite,
  generateContactAuditTask,
  gradeContactAudit,
  handledBeside,
  judgeContactAudit,
  parseContactAuditSubmission,
  renderContactAuditTask,
  turnedAwayBecause,
  type AuditFinding,
  type ContactAuditAnswer,
  type ContactAuditTask,
} from "../contact-audit/index.js";

const HELD = CONTACT_AUDIT_HELDOUT_SUITE;
let heldDraws: ReturnType<typeof drawContactAuditTask>[] | null = null;
const heldout = () =>
  (heldDraws ??= Array.from({ length: HELD.n }, (_, i) =>
    drawContactAuditTask(HELD.split, HELD.seed, i),
  ));
const heldTasks = () => heldout().map((x) => x.task);
let trainTasks: ContactAuditTask[] | null = null;
const train = () => (trainTasks ??= generateContactAuditSuite("train", 11, 300));
const SPEC = contactAuditSpecTasks();

const solveAll = async (tasks: readonly ContactAuditTask[]) => {
  const misses: string[] = [];
  let calls = 0;
  let turns = 0;
  for (const task of tasks) {
    const r = await runEpisode(contactAudit, task, new ContactAuditReferencePolicy());
    calls = Math.max(calls, r.tool_calls);
    turns = Math.max(turns, r.turns);
    if (!r.grade.pass)
      misses.push(
        `${task.id} ${r.outcome} ${r.error ?? ""} ${r.grade.fields
          .filter((f) => !f.ok)
          .map((f) => `${f.field} ${f.expected}/${f.got}`)
          .join("; ")}`,
      );
  }
  return { misses, calls, turns };
};

/** A held-out window's book rebuilt, and the twin its roots make, the way the generator made it. */
function twinOf(task: ContactAuditTask): {
  book: LifeBook;
  center: ContactCenter;
  res: ReturnType<typeof plantStaffErrors>;
  clean: LoanContacts;
  twin: LoanContacts;
} {
  const src = task.source!;
  const { book, center } = rebuild(src.seed, src.scenario, src.pins);
  const res = plantStaffErrors(
    center,
    book,
    Object.entries(src.roots).map(([id, c]) => ({ id: id as "S-01" | "S-02", contacts: [c] })),
    { pins: { 0: src.pins } },
  );
  return { book, center, res, clean: center.loans[0]!, twin: res.defective.loans[0]! };
}
const ofPlan = (plan: string) => heldTasks().filter((t) => t.plan.plan === plan);
/** A root's call, by the desk's id. */
const rootOf = (t: ContactAuditTask, id: "S-01" | "S-02") =>
  t.labels.find((l) => l.root_cause && l.defect_id === id)!.contact!;

describe("staff errors in the contact center", () => {
  it("leaves a clean center as it was: an override that names no contact draws the clean history", () => {
    for (const t of heldTasks().slice(0, 12)) {
      const src = t.source!;
      const { book, center } = rebuild(src.seed, src.scenario, src.pins);
      const life = book.loans[0]!;
      const base = { key: center.key, rates: center.rates, pins: src.pins };
      const a = deriveLoan(life, base);
      const b = deriveLoan(life, { ...base, staff: {} });
      expect(toJsonLine(b)).toBe(toJsonLine(a));
      expect(toJsonLine(a.contacts)).toBe(toJsonLine(center.loans[0]!.contacts));
      expect(a.unrecorded).toEqual([]);
      expect(a.raised_again).toBeNull();
      expect(center.loans[0]!.unrecorded_promises).toBeUndefined();
      // Nothing asked for is nothing made.
      const none = plantStaffErrors(center, book, [], { pins: { 0: src.pins } });
      expect(none.defective.loans).toEqual(center.loans);
      expect(none.labels).toEqual([]);
    }
  }, 120_000);

  it("S-01: the promise said and noted and never recorded, and what the contact center's rules make of that", () => {
    for (const t of ofPlan("S-01").slice(0, 12)) {
      const { book, center, res, clean, twin } = twinOf(t);
      const rootId = t.source!.roots["S-01"]!;
      const c = clean.contacts.find((x) => x.id === rootId)!;
      const w = twin.contacts.find((x) => x.id === rootId)!;
      const promise = clean.promises.find((p) => p.contact_id === rootId)!;
      // Never the scenario's own promise call, whose purpose code would give the error away.
      expect(c.purpose).not.toBe("promise_to_pay");
      // The row: no promise, dispositioned as the call would have been without it (a hardship call referred to loss
      // mitigation, never transferred, which would change its words); nothing else moved.
      expect([w.promise_id, w.resolution]).toEqual([
        null,
        c.reason === "hardship" ? "referred_lossmit" : "information_provided",
      ]);
      expect({
        ...w,
        promise_id: c.promise_id,
        resolution: c.resolution,
        related: c.related,
      }).toEqual(c);
      expect(twin.promises.some((p) => p.contact_id === rootId)).toBe(false);
      expect(twin.unrecorded_promises).toEqual([promise]);
      // The call's words and the agent's note are the clean call's; the system's PTP lines are gone.
      expect(toJsonLine(transcriptOf(res.defective, book, rootId))).toBe(
        toJsonLine(transcriptOf(center, book, rootId)),
      );
      const agentNote = (l: LoanContacts) =>
        l.notes.find((n) => n.contact_id === rootId && n.kind === "agent")!.text;
      expect(agentNote(twin)).toBe(agentNote(clean));
      expect(twin.notes.filter((n) => n.contact_id === rootId && /^PTP /.test(n.text))).toEqual([]);
      expect(
        clean.notes.filter((n) => n.contact_id === rootId && /^PTP /.test(n.text)),
      ).toHaveLength(2);
      // The clean history until the call: every earlier contact, row for row and id for id.
      const before = (l: LoanContacts) =>
        l.contacts.filter((x) => x.on < c.on || (x.on === c.on && x.at < c.at));
      expect(toJsonLine(before(twin).map((x) => ({ ...x, related: [] })))).toBe(
        toJsonLine(before(clean).map((x) => ({ ...x, related: [] }))),
      );
      // The labels: one root, the call's missing record, with the promise the record should have held.
      const roots = res.labels.filter((l) => l.root_cause);
      expect(roots.map((l) => [l.defect_id, l.file_or_table, l.field, l.row])).toEqual([
        ["S-01", "contacts", "promise_id", rootId],
      ]);
      expect(roots[0]!.true_value).toBe(promise.id);
      expect(roots[0]!.promise?.pay_by).toBe(promise.pay_by);
      // Each attempt inside the window is one the clean history never made, and the clean history paused there.
      const inWindow = res.labels.filter((l) => l.symptom === "dialed_in_window");
      for (const l of inWindow) {
        const a = twin.contacts.find((x) => x.id === l.contact)!;
        expect([a.direction, a.mode, a.purpose]).toEqual(["outbound", "call", "collection"]);
        expect(a.id.startsWith(`${rootId}-S01-`)).toBe(true);
        expect(a.on <= promise.pay_by && (a.on > c.on || a.at > c.at)).toBe(true);
        expect(clean.contacts.some((x) => contactKey(x) === contactKey(a))).toBe(false);
      }
      const paused = (l: { cadence: LoanContacts["cadence"] }) =>
        l.cadence
          .flatMap((e) => e.paused)
          .filter((p) => p.reason === "ptp_pending" && p.to === promise.pay_by);
      if (inWindow.length) expect(paused(clean).length).toBeGreaterThan(0);
      // The promise's outcome, as the clean log marked it: kept never marked, broken never followed up.
      const outcome = res.labels.filter(
        (l) => l.symptom === "kept_not_marked" || l.symptom === "broken_not_followed_up",
      );
      expect(outcome.map((l) => l.symptom)).toEqual([
        promise.status === "kept" ? "kept_not_marked" : "broken_not_followed_up",
      ]);
      // Every label names its loan, table, field, true and planted value and its handling.
      for (const l of res.labels) {
        expect(l.loan).toBe(clean.loan_id);
        expect(l.expected_handling.length).toBeGreaterThan(20);
        expect(l.true_value !== null || l.planted_value !== null).toBe(true);
      }
    }
  }, 300_000);

  it("S-02: the complaint never logged (C-04 at the call), no case, no answer, and the borrower calling again", () => {
    for (const t of ofPlan("S-02").slice(0, 12)) {
      const { book, center, res, clean, twin } = twinOf(t);
      const rootId = t.source!.roots["S-02"]!;
      const c = clean.contacts.find((x) => x.id === rootId)!;
      const w = twin.contacts.find((x) => x.id === rootId)!;
      expect([
        c.complaint_voiced,
        c.complaint_logged,
        w.complaint_voiced,
        w.complaint_logged,
      ]).toEqual([true, true, true, false]);
      // Nobody logged it, so nobody escalated it: the call is dispositioned as its reason is (a late fee may be
      // escalated anyway), never as a transfer, which would change its words.
      expect(c.resolution === "escalated" || c.resolution === "promise_recorded").toBe(true);
      if (c.resolution === "escalated")
        expect(w.resolution !== "escalated" || w.reason === "late_fee").toBe(true);
      expect(w.resolution).not.toBe("transferred");
      expect({
        ...w,
        complaint_logged: true,
        resolution: c.resolution,
        related: c.related,
      }).toEqual(c);
      // The call is C-04's: its acknowledgment, its note, its CMPL line, exactly as plantContactDefects leaves them.
      const c04 = plantContactDefects(center, book, [{ id: "C-04", contacts: [rootId] }]);
      expect(toJsonLine(transcriptOf(res.defective, book, rootId))).toBe(
        toJsonLine(transcriptOf(c04.defective, book, rootId)),
      );
      const noteOf = (l: LoanContacts) =>
        l.notes.filter((n) => n.contact_id === rootId).map((n) => n.text);
      expect(noteOf(twin)).toEqual(noteOf(c04.defective.loans[0]!));
      // The complaint system opens no case.
      expect(complaintLog(clean, center.key).some((x) => x.contact_id === rootId)).toBe(true);
      expect(complaintLog(twin, center.key).some((x) => x.contact_id === rootId)).toBe(false);
      // The borrower calls about it again, with the same reason, and nobody logs that either. No case links the
      // call to the first, so it is filed as any call about its reason is that day, under an issue of its own.
      const again = twin.contacts.find((x) => x.id === `${rootId}-S02`)!;
      expect(again).toBeDefined();
      expect([again.direction, again.mode, again.outcome, again.issue, again.reason]).toEqual([
        "inbound",
        "call",
        "conversation",
        `${c.reason}:${again.on.slice(0, 7)}`,
        c.reason,
      ]);
      expect([again.complaint_voiced, again.complaint_logged, again.promise_id]).toEqual([
        true,
        false,
        null,
      ]);
      expect(again.resolution !== "escalated" || again.reason === "late_fee").toBe(true);
      const lag = (Date.parse(again.on) - Date.parse(c.on)) / 86_400_000;
      expect(lag).toBeGreaterThanOrEqual(RAISED_AGAIN_AFTER[0]);
      expect(lag).toBeLessThanOrEqual(RAISED_AGAIN_AFTER[1] + 1);
      const said = transcriptOf(res.defective, book, again.id).turns.map((x) => x.said);
      expect(said.some((x) => COMPLAINT_PHRASES.some((p) => says(x, p)))).toBe(true);
      expect(said.some((x) => ACK_PHRASES.some((p) => says(x, p)))).toBe(false);
      // Nobody told the borrower how to put it in writing, so no written request follows it, as one may follow a
      // logged complaint: every contact the twin drops is one such, on the root's issue, and every other is the
      // clean one.
      const dropped = clean.contacts.filter(
        (x) => x.id !== rootId && !twin.contacts.some((y) => y.id === x.id),
      );
      for (const x of dropped) {
        expect(["qualified_written_request", "qwr_acknowledgment"]).toContain(x.purpose);
        expect(x.issue).toBe(c.issue);
      }
      expect(
        twin.contacts
          .filter((x) => x.id !== rootId && x.id !== again.id)
          .map((x) => ({ ...x, related: [] })),
      ).toEqual(
        clean.contacts
          .filter((x) => x.id !== rootId && !dropped.includes(x))
          .map((x) => ({ ...x, related: [] })),
      );
      expect(
        res.labels
          .filter((l) => l.root_cause || l.symptom)
          .map((l) => [l.root_cause ? "root" : l.symptom, l.contact])
          .sort(),
      ).toEqual(
        [
          ["root", rootId],
          ["no_acknowledgment", rootId],
          ["no_response", rootId],
          ["raised_again", again.id],
        ].sort(),
      );
    }
  }, 300_000);

  it("makes both on one loan, and S-02 alone where S-01's twin does not make its call", () => {
    for (const t of ofPlan("S-01+S-02").slice(0, 8)) {
      const { res } = twinOf(t);
      expect(new Set(res.labels.filter((l) => l.root_cause).map((l) => l.defect_id))).toEqual(
        new Set(["S-01", "S-02"]),
      );
      expect(res.skipped).toEqual([]);
    }
    // contact-audit/1.0.0/train/3/7843#2: a hardship call thirteen days after the promise call takes a promise of its
    // own once nobody recorded the first, so it is no longer escalated, and its follow-up, the call S-02 was asked
    // for, is never made. S-01 is made alone, and the planter says why.
    const key = "contact-audit/1.0.0/train/3/7843#2";
    const got = drawContactAuditCandidate(key, "train", 3, 7843)!;
    expect(got.issues.join(" ")).toMatch(/does not make this call/);
    expect(got.task.labels.filter((l) => l.root_cause).map((l) => l.defect_id)).toEqual(["S-01"]);
  }, 120_000);

  it("refuses a contact an error does not fit, and makes one of each on a loan", () => {
    const t = ofPlan("S-01")[0]!;
    const src = t.source!;
    const { book, center } = rebuild(src.seed, src.scenario, src.pins);
    const loan = center.loans[0]!;
    const notCall = loan.contacts.find((c) => c.mode !== "call")!;
    expect(() =>
      plantStaffErrors(center, book, [{ id: "S-01", contacts: [notCall.id] }], {
        pins: { 0: src.pins },
      }),
    ).toThrow(/cannot be made/);
    expect(() =>
      plantStaffErrors(center, book, [{ id: "S-02", contacts: [notCall.id] }], {
        pins: { 0: src.pins },
      }),
    ).toThrow(/cannot be made/);
    const promises = loan.contacts.filter((c) => STAFF_ERRORS["S-01"].eligible(c));
    if (promises.length > 1) {
      const res = plantStaffErrors(
        center,
        book,
        [{ id: "S-01", contacts: promises.slice(0, 2).map((c) => c.id) }],
        { pins: { 0: src.pins } },
      );
      expect(res.skipped).toEqual([
        { id: "S-01", contact: promises[1]!.id, reason: "the loan already carries S-01" },
      ]);
    }
    // The pins are the center's, or the twin would be another loan's.
    expect(() =>
      plantStaffErrors(center, book, [{ id: "S-01", contacts: [promises[0]!.id] }], {
        pins: { 0: { language: "en" } },
      }),
    ).toThrow(/other pins/);
    expect(STAFF_ERRORS["S-01"].eligible({ ...promises[0]!, complaint_voiced: true })).toBe(false);
    // Nor on the scenario's own promise call: its purpose code says promise_to_pay, and a twin keeps it.
    const scripted = loan.contacts.find(
      (c) =>
        c.purpose === "promise_to_pay" &&
        c.promise_id !== null &&
        c.outcome === "conversation" &&
        !c.complaint_voiced,
    )!;
    expect(scripted).toBeDefined();
    expect(STAFF_ERRORS["S-01"].eligible(scripted)).toBe(false);
    expect(() =>
      plantStaffErrors(center, book, [{ id: "S-01", contacts: [scripted.id] }], {
        pins: { 0: src.pins },
      }),
    ).toThrow(/cannot be made/);
  }, 60_000);

  it("answers every logged complaint in writing within 15 days, on a servicer business day", () => {
    let n = 0;
    for (const t of heldTasks().slice(0, 40)) {
      const src = t.source!;
      const { center } = rebuild(src.seed, src.scenario, src.pins);
      for (const x of complaintLog(center.loans[0]!, center.key)) {
        n++;
        expect(x.responded_on > x.received_on).toBe(true);
        expect(x.responded_on <= x.respond_by).toBe(true);
        expect(servicerCalendar.isBusinessDay(x.responded_on)).toBe(true);
        expect(x.acknowledged_on).toBe(x.received_on);
      }
    }
    expect(n).toBeGreaterThan(40);
  }, 60_000);
});

/* ── the floors: cheap policies, each a choice of roots with the symptoms the rules give them ─────────── */

const PROMISE_NOTE =
  /(\$?\d{1,3}(?:,\d{3})+\.\d{2}|\$?\d+\.\d{2})\s+by\s+(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/i;
type Row = ContactAuditTask["contacts"][number];
const dayOf = (on: string) => Date.parse(`${on}T00:00:00Z`) / 86_400_000;
const after = (a: Row, b: Row) => a.on > b.on || (a.on === b.on && a.at > b.at);
const saysAny = (t: ContactAuditTask, id: string, phrases: readonly string[]) =>
  (t.transcripts[id] ?? []).some((l) => phrases.some((p) => says(l.text, p)));
const voiced = (t: ContactAuditTask, c: Row) => saysAny(t, c.id, COMPLAINT_PHRASES);
/** The promise a call's agent note states in its own part, as the rulebook reads one. */
function notePromise(t: ContactAuditTask, c: Row): { amount: string; pay_by: string } | null {
  const n = t.notes.find((x) => x.contact === c.id && x.user === c.agent);
  const m = n ? PROMISE_NOTE.exec(n.text.split(" | PREV: ")[0]!) : null;
  if (!m) return null;
  const yy = m[4]!.length === 2 ? `20${m[4]}` : m[4]!;
  return { amount: m[1]!, pay_by: `${yy}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` };
}
const cents = (s: string) => BigInt(s.replace(/[$,]/g, "").replace(".", ""));
/** An S-01 root on a call, with the promise its note gives (or none) and every symptom the rules then give it. */
function asS01(t: ContactAuditTask, c: Row): AuditFinding[] {
  const promise = notePromise(t, c) ?? { amount: "0.00", pay_by: c.on };
  const out: AuditFinding[] = [{ error: "S-01", kind: "root", contact: c.id, promise }];
  for (const a of t.contacts)
    if (
      a.direction === "outbound" &&
      a.mode === "call" &&
      a.purpose === "collection" &&
      after(a, c) &&
      a.on <= promise.pay_by
    )
      out.push({ error: "S-01", kind: "dialed_in_window", contact: a.id, promise: null });
  const paid = t.payments
    .filter((x) => x.on > c.on && x.on <= promise.pay_by)
    .reduce((s, x) => s + cents(x.amount), 0n);
  out.push({
    error: "S-01",
    kind: paid >= cents(promise.amount) ? "kept_not_marked" : "broken_not_followed_up",
    contact: c.id,
    promise: null,
  });
  return out;
}
/** An S-02 root on a call, with every symptom the rules then give it. */
function asS02(t: ContactAuditTask, c: Row): AuditFinding[] {
  const out: AuditFinding[] = [{ error: "S-02", kind: "root", contact: c.id, promise: null }];
  if (!saysAny(t, c.id, ACK_PHRASES))
    out.push({ error: "S-02", kind: "no_acknowledgment", contact: c.id, promise: null });
  if (!t.complaints.some((x) => x.contact === c.id))
    out.push({ error: "S-02", kind: "no_response", contact: c.id, promise: null });
  for (const x of t.contacts)
    if (after(x, c) && x.reason === c.reason && !x.complaint_logged && voiced(t, x))
      out.push({ error: "S-02", kind: "raised_again", contact: x.id, promise: null });
  return out;
}
const handledInbound = (c: Row) =>
  c.direction === "inbound" && c.mode === "call" && c.outcome === "conversation" && !!c.agent;
/** A conversation the contact center may take a promise on: a payment arrangement or hardship call, or the dialer's. */
const promiseCall = (c: Row) =>
  c.mode === "call" &&
  c.outcome === "conversation" &&
  !!c.agent &&
  (c.direction === "inbound"
    ? c.reason === "payment_arrangement" || c.reason === "hardship"
    : c.purpose === "collection");
const firstPerReason = (xs: readonly Row[]) =>
  xs.filter((c, i) => xs.findIndex((x) => x.reason === c.reason) === i);
const onlyOne = (xs: readonly Row[]) => (xs.length === 1 ? xs : []);
/** Calls with no promise that a payment followed within three weeks, none of them near a promise the log holds. */
const paidSoon = (t: ContactAuditTask) =>
  t.contacts.filter(
    (c) =>
      promiseCall(c) &&
      !c.promise_id &&
      t.payments.some((x) => x.on > c.on && dayOf(x.on) - dayOf(c.on) <= 21) &&
      !t.promises.some((p) => dayOf(p.made_on) - 21 <= dayOf(c.on) && c.on <= p.pay_by),
  );
/** An unlogged call with a later unlogged call for the same reason inside the days a complaint is raised again. */
const pairedLater = (t: ContactAuditTask, c: Row) =>
  t.contacts.some(
    (x) =>
      handledInbound(x) &&
      x.reason === c.reason &&
      !x.complaint_logged &&
      dayOf(x.on) - dayOf(c.on) >= RAISED_AGAIN_AFTER[0] &&
      dayOf(x.on) - dayOf(c.on) <= RAISED_AGAIN_AFTER[1] + 1,
  );
const paired = (t: ContactAuditTask) =>
  firstPerReason(
    t.contacts.filter((c) => handledInbound(c) && !c.complaint_logged && pairedLater(t, c)),
  );
const centerOf = (t: ContactAuditTask) => (dayOf(t.window.from) + dayOf(t.window.to)) / 2;

/** Each policy names its roots; the symptoms the rules give them are added, so a floor is the roots' alone. */
const CHEAP: Record<
  string,
  {
    s01?: (t: ContactAuditTask) => readonly Row[];
    s02?: (t: ContactAuditTask) => readonly Row[];
  }
> = {
  // The four the rule was written against.
  nothing: {},
  "every promise": { s01: (t) => t.contacts.filter((c) => notePromise(t, c)) },
  "every complaint": { s02: (t) => t.contacts.filter((c) => voiced(t, c)) },
  "every promise and every complaint": {
    s01: (t) => t.contacts.filter((c) => notePromise(t, c)),
    s02: (t) => t.contacts.filter((c) => voiced(t, c)),
  },
  // Dispositions alone.
  "S-01 by disposition: a promise call with no promise, information provided": {
    s01: (t) =>
      t.contacts.filter(
        (c) => promiseCall(c) && !c.promise_id && c.resolution === "information_provided",
      ),
  },
  "the first such call": {
    s01: (t) =>
      t.contacts
        .filter((c) => promiseCall(c) && !c.promise_id && c.resolution === "information_provided")
        .slice(0, 1),
  },
  "S-02 by disposition: escalated and not logged, the first on its issue": {
    s02: (t) =>
      t.contacts.filter(
        (c, i, xs) =>
          c.resolution === "escalated" &&
          !c.complaint_logged &&
          !!c.agent &&
          xs.findIndex((x) => x.resolution === "escalated" && x.issue === c.issue) === i,
      ),
  },
  "both by disposition": {
    s01: (t) =>
      t.contacts.filter(
        (c) => promiseCall(c) && !c.promise_id && c.resolution === "information_provided",
      ),
    s02: (t) =>
      t.contacts.filter((c) => c.resolution === "escalated" && !c.complaint_logged && !!c.agent),
  },
  // The logs' structure.
  "every promise call with no promise_id": {
    s01: (t) => t.contacts.filter((c) => promiseCall(c) && !c.promise_id),
  },
  "a promise_to_pay call with no promise_id": {
    s01: (t) => t.contacts.filter((c) => c.purpose === "promise_to_pay" && !c.promise_id),
  },
  "a hardship call with no promise, information provided": {
    s01: (t) =>
      t.contacts.filter(
        (c) =>
          handledInbound(c) && c.reason === "hardship" && c.resolution === "information_provided",
      ),
  },
  "a promise call with no promise that a payment followed within three weeks": { s01: paidSoon },
  "the same, only where it is the only one": { s01: (t) => onlyOne(paidSoon(t)) },
  "every handled call with no CMPL note": {
    s02: (t) =>
      t.contacts.filter(
        (c) => handledInbound(c) && !t.notes.some((n) => n.contact === c.id && n.area === "CMPL"),
      ),
  },
  "every call with no CMPL note whose reason a logged complaint has": {
    s02: (t) =>
      t.contacts.filter(
        (c) =>
          handledInbound(c) &&
          !t.notes.some((n) => n.contact === c.id && n.area === "CMPL") &&
          t.contacts.some((x) => x.complaint_logged && x.reason === c.reason),
      ),
  },
  "an unlogged call another unlogged call for its reason follows within 3 to 60 days": {
    s02: paired,
  },
  "the first such pair": { s02: (t) => paired(t).slice(0, 1) },
  "the same, only where it is the only pair": { s02: (t) => onlyOne(paired(t)) },
  "a written request on an issue no logged call has": {
    s02: (t) =>
      t.contacts
        .filter((q) => q.purpose === "qualified_written_request")
        .map((q) => t.contacts.find((c) => c.issue === q.issue && handledInbound(c)))
        .filter(
          (c): c is Row =>
            !!c && !t.contacts.some((x) => x.issue === c.issue && x.complaint_logged),
        ),
  },
  "a closed call followed on its issue within 15 days": {
    s02: (t) =>
      t.contacts.filter(
        (c) =>
          handledInbound(c) &&
          !c.complaint_logged &&
          ["information_provided", "resolved", "referred_lossmit", "promise_recorded"].includes(
            c.resolution,
          ) &&
          t.contacts.some(
            (x) =>
              x.issue === c.issue &&
              handledInbound(x) &&
              after(x, c) &&
              dayOf(x.on) - dayOf(c.on) <= 15,
          ),
      ),
  },
  "the promise note nearest the window's middle": {
    s01: (t) =>
      t.contacts
        .filter((c) => notePromise(t, c))
        .sort((a, b) => Math.abs(dayOf(a.on) - centerOf(t)) - Math.abs(dayOf(b.on) - centerOf(t)))
        .slice(0, 1),
  },
  // The rules with one clause left out.
  "every complaint not logged, the raised-again clause left out": {
    s02: (t) => t.contacts.filter((c) => voiced(t, c) && !c.complaint_logged),
  },
};
/** The roots the rules give, with no symptom: what a reviewer who found every root and stopped would submit. */
const rootsOnly = (t: ContactAuditTask): AuditFinding[] =>
  expectedContactAudit(t).findings.filter((f) => f.kind === "root");
const policyFindings = (t: ContactAuditTask, p: (typeof CHEAP)[string]): AuditFinding[] => [
  ...(p.s01?.(t) ?? []).flatMap((c) => asS01(t, c)),
  ...(p.s02?.(t) ?? []).flatMap((c) => asS02(t, c)),
];
/** Windows passed: all, then clean, S-01 alone, S-02 alone and both. */
function floorOf(
  tasks: readonly ContactAuditTask[],
  submit: (t: ContactAuditTask) => readonly AuditFinding[],
): number[] {
  const out = [0, 0, 0, 0, 0];
  for (const t of tasks)
    if (gradeContactAudit(t, { findings: submit(t) }).pass) {
      out[0]!++;
      out[1 + AUDIT_PLANS.indexOf(t.plan.plan)]!++;
    }
  return out;
}

describe("contact-audit", () => {
  it("pins what a model is told, and states each rule the way the labels hold it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // CONTACT_AUDIT_ENVIRONMENT_VERSION with this pin.
    expect(CONTACT_AUDIT_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "contact-audit",
        "rulebook_sha256": "084e33d8c1e6211b243ed8804be80ef2ac20b64a6fef6a078c4b89981b43339d",
        "tools_sha256": "26db4045200d8b9077ed9eefa994a3602e333d32755523e5213811a35e4794fb",
        "version": "1.0.0",
      }
    `);
    for (const p of [...COMPLAINT_PHRASES, ...ACK_PHRASES])
      expect(CONTACT_AUDIT_RULEBOOK).toContain(`"${p}"`);
    for (const k of [...STAFF_ERRORS["S-01"].symptoms, ...STAFF_ERRORS["S-02"].symptoms])
      expect(CONTACT_AUDIT_RULEBOOK).toMatch(new RegExp(`- ${k}:`));
    expect(CONTACT_AUDIT_RULEBOOK).toContain(
      "within 15 calendar days of the call (SM_COMPLAINT_RESOLVE_15)",
    );
    expect(CONTACT_AUDIT_RULEBOOK).toContain(`at most ${AUDIT_EXTRA_FINDINGS_CAP} other findings`);
    expect(CONTACT_AUDIT_RULEBOOK).toContain("a root these rules do not give fails the task");
    expect(CONTACT_AUDIT_RULEBOOK).toContain("every symptom these rules give it");
    expect(CONTACT_AUDIT_RULEBOOK).toContain("an earlier call in the window with the same reason");
    const t = ofPlan("S-01+S-02")[0]!;
    const shown = renderContactAuditTask(t);
    expect(shown).not.toMatch(/S-0[12]|label|planted|complaint_voiced|unrecorded|-S0[12]\b/);
  });

  it("gives the hand-built histories what their labels say, and the reference reaches them", async () => {
    expect(SPEC.map((t) => contactAuditVerdict(t))).toEqual([
      "clean",
      "S-01",
      "S-01",
      "S-01",
      "S-01",
      "clean",
      "clean",
      "S-02",
      "S-02",
      "S-01+S-02",
      "clean",
      "S-01",
      "S-02",
      "S-02",
      "S-01",
    ]);
    expect(
      SPEC.map((t) => expectedContactAudit(t).findings.map((f) => `${f.kind} ${f.contact}`)),
    ).toEqual([
      [],
      [
        "root SPEC-K0003",
        "dialed_in_window SPEC-K0004",
        "dialed_in_window SPEC-K0005",
        "kept_not_marked SPEC-K0003",
      ],
      ["root SPEC-K0003", "dialed_in_window SPEC-K0004", "broken_not_followed_up SPEC-K0003"],
      ["root SPEC-K0003", "dialed_in_window SPEC-K0004", "kept_not_marked SPEC-K0003"],
      ["root SPEC-K0003", "kept_not_marked SPEC-K0003"],
      [],
      [],
      [
        "root SPEC-K0020",
        "no_acknowledgment SPEC-K0020",
        "no_response SPEC-K0020",
        "raised_again SPEC-K0021",
      ],
      ["root SPEC-K0020", "no_acknowledgment SPEC-K0020", "no_response SPEC-K0020"],
      [
        "root SPEC-K0003",
        "dialed_in_window SPEC-K0004",
        "kept_not_marked SPEC-K0003",
        "root SPEC-K0020",
        "no_acknowledgment SPEC-K0020",
        "no_response SPEC-K0020",
        "raised_again SPEC-K0021",
      ],
      [],
      ["root SPEC-K0003", "dialed_in_window SPEC-K0004", "kept_not_marked SPEC-K0003"],
      [
        "root SPEC-K0020",
        "no_acknowledgment SPEC-K0020",
        "no_response SPEC-K0020",
        "raised_again SPEC-K0021",
      ],
      [
        "root SPEC-K0020",
        "no_acknowledgment SPEC-K0020",
        "no_response SPEC-K0020",
        "raised_again SPEC-K0021",
      ],
      [
        "root SPEC-K0003",
        "dialed_in_window SPEC-K0004",
        "dialed_in_window SPEC-K0005",
        "broken_not_followed_up SPEC-K0003",
      ],
    ]);
    for (const t of SPEC) expect(judgeContactAudit(t), t.id).toEqual([]);
    const r = await solveAll(SPEC);
    expect(r.misses).toEqual([]);
    expect(new Set(CONTACT_AUDIT_SPEC_CASES.map((c) => c.name)).size).toBe(SPEC.length);
    // The histories the false-root rule was written for: beside promises recorded and complaints logged, blanket
    // reporting names a false root, the call raising a complaint again is no root, and a root needs its symptoms.
    const failed = (t: ContactAuditTask, findings: readonly AuditFinding[]) =>
      gradeContactAudit(t, { findings })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    for (const i of [10, 11, 12]) {
      const t = SPEC[i]!;
      expect(failed(t, policyFindings(t, CHEAP["every promise"]!)), t.id).toContain("false roots");
      expect(failed(t, policyFindings(t, CHEAP["every complaint"]!)), t.id).toContain(
        "false roots",
      );
    }
    for (const i of [7, 9, 12, 13]) {
      const t = SPEC[i]!;
      const again = CHEAP["every complaint not logged, the raised-again clause left out"]!;
      expect(failed(t, policyFindings(t, again)), t.id).toContain("false roots");
    }
    for (const t of SPEC.filter((x) => x.labels.length))
      expect(
        failed(t, rootsOnly(t)).every((f) => f.endsWith(": symptoms")),
        t.id,
      ).toBe(true);
  });

  it("grades a root with its symptoms, and fails a root the window does not hold", () => {
    const failed = (t: ContactAuditTask, findings: readonly AuditFinding[]) =>
      gradeContactAudit(t, { findings })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    for (const t of ofPlan("S-01+S-02").slice(0, 6)) {
      const right = expectedContactAudit(t);
      const grade = (findings: readonly AuditFinding[]) => gradeContactAudit(t, { findings });
      expect(grade(right.findings).pass).toBe(true);
      const s01 = `S-01 ${rootOf(t, "S-01")}`;
      const s02 = `S-02 ${rootOf(t, "S-02")}`;
      // A root's symptoms are required: the roots alone fail on them and on nothing else.
      const roots = right.findings.filter((f) => f.kind === "root");
      expect(failed(t, roots).sort()).toEqual([`${s01}: symptoms`, `${s02}: symptoms`]);
      // Its symptoms without it earn their field and miss the root.
      const unfound = right.findings.filter((f) => !(f.kind === "root" && f.error === "S-02"));
      expect(failed(t, unfound)).toEqual([`${s02}: found`]);
      expect(grade(unfound).score).toBeGreaterThan(
        grade(right.findings.filter((f) => f.error === "S-01")).score,
      );
      // A root the window does not hold fails it, whatever else is right: the call raising the complaint again, a
      // promise the log holds, a complaint logged, or a root's call under the other error.
      const plus = (f: AuditFinding) => failed(t, [...right.findings, f]);
      const again = right.findings.find((f) => f.kind === "raised_again")!;
      expect(plus({ ...again, kind: "root" })).toEqual(["false roots"]);
      const held = t.promises[0]!;
      expect(
        plus({
          error: "S-01",
          kind: "root",
          contact: held.contact,
          promise: { amount: held.amount, pay_by: held.pay_by },
        }),
      ).toEqual(["false roots"]);
      const logged = t.contacts.find((c) => c.complaint_logged)!;
      expect(plus({ error: "S-02", kind: "root", contact: logged.id, promise: null })).toEqual([
        "false roots",
      ]);
      expect(
        plus({ error: "S-02", kind: "root", contact: rootOf(t, "S-01"), promise: null }),
      ).toEqual(["false roots"]);
      // The promise to the cent and the day; written either way.
      const root01 = roots.find((f) => f.error === "S-01")!;
      const plain = (a: string) => a.replace(/[$,]/g, "");
      const others = right.findings.filter((f) => f !== root01);
      expect(
        grade([
          ...others,
          { ...root01, promise: { ...root01.promise!, amount: plain(root01.promise!.amount) } },
        ]).pass,
      ).toBe(true);
      const off = (Number(plain(root01.promise!.amount)) + 0.01).toFixed(2);
      expect(
        failed(t, [...others, { ...root01, promise: { ...root01.promise!, amount: off } }]),
      ).toEqual([`${s01}: promise`]);
      // Extra findings: symptoms up to the cap, then not; a second finding on a root is an extra, not a false root.
      const stray: AuditFinding = {
        error: "S-01",
        kind: "dialed_in_window",
        contact: t.contacts[0]!.id,
        promise: null,
      };
      if (!right.findings.some((f) => f.kind === stray.kind && f.contact === stray.contact)) {
        const extra = (n: number) =>
          grade([...right.findings, ...Array<AuditFinding>(n).fill(stray)]);
        expect(extra(AUDIT_EXTRA_FINDINGS_CAP).pass).toBe(true);
        expect(
          failed(t, [
            ...right.findings,
            ...Array<AuditFinding>(AUDIT_EXTRA_FINDINGS_CAP + 1).fill(stray),
          ]),
        ).toEqual(["extra findings"]);
      }
      expect(grade([...right.findings, root01]).pass).toBe(true);
      expect(failed(t, [...right.findings, root01, root01, root01])).toEqual(["extra findings"]);
      expect([gradeContactAudit(t, null).pass, gradeContactAudit(t, null).score]).toEqual([
        false,
        0,
      ]);
    }
    // A clean window is a control: it passes with no root, any root fails it, a stray symptom is an extra, and no
    // submission is no decision.
    const clean = ofPlan("clean")[0]!;
    expect(gradeContactAudit(clean, { findings: [] }).pass).toBe(true);
    const one: AuditFinding = {
      error: "S-02",
      kind: "root",
      contact: clean.contacts[0]!.id,
      promise: null,
    };
    expect(failed(clean, [one])).toEqual(["false roots"]);
    expect(gradeContactAudit(clean, { findings: [{ ...one, kind: "no_response" }] }).pass).toBe(
      true,
    );
    expect(gradeContactAudit(clean, null).pass).toBe(false);
  });

  it("reads a submission strictly, as the schema says", () => {
    const ok = (findings: unknown[]) => parseContactAuditSubmission({ findings });
    expect(ok([]).ok).toBe(true);
    expect(parseContactAuditSubmission({}).ok).toBe(false);
    expect(parseContactAuditSubmission({ findings: [], verdict: "clean" }).ok).toBe(false);
    expect(ok([{ error: "S-03", kind: "root", contact: "x", promise: null }]).ok).toBe(false);
    expect(ok([{ error: "S-01", kind: "raised_again", contact: "x", promise: null }]).ok).toBe(
      false,
    );
    expect(ok([{ error: "S-01", kind: "root", contact: "x", promise: null }]).ok).toBe(false);
    expect(
      ok([
        {
          error: "S-01",
          kind: "root",
          contact: "x",
          promise: { amount: "12", pay_by: "2027-01-01" },
        },
      ]).ok,
    ).toBe(false);
    expect(
      ok([
        {
          error: "S-01",
          kind: "root",
          contact: "x",
          promise: { amount: "$1,234.56", pay_by: "1/2/27" },
        },
      ]).ok,
    ).toBe(false);
    expect(
      ok([
        {
          error: "S-01",
          kind: "root",
          contact: "x",
          promise: { amount: "$1,234.56", pay_by: "2027-01-02" },
        },
      ]).ok,
    ).toBe(true);
    expect(
      ok([
        {
          error: "S-02",
          kind: "root",
          contact: "x",
          promise: { amount: "1.00", pay_by: "2027-01-02" },
        },
      ]).ok,
    ).toBe(false);
    expect(ok([{ error: "S-02", kind: "no_response", contact: " ", promise: null }]).ok).toBe(
      false,
    );
  });

  it("gives floors to read a score against, and no cheap policy passes much beyond the clean windows", () => {
    const tasks = heldTasks();
    const floors = Object.fromEntries(
      Object.entries(CHEAP).map(([name, p]) => [name, floorOf(tasks, (t) => policyFindings(t, p))]),
    );
    floors["the roots alone, no symptom"] = floorOf(tasks, rootsOnly);
    // [all, clean, S-01 alone, S-02 alone, both], of 200, 50 of each.
    expect(floors).toEqual({
      nothing: [50, 50, 0, 0, 0],
      "every promise": [0, 0, 0, 0, 0],
      "every complaint": [0, 0, 0, 0, 0],
      "every promise and every complaint": [0, 0, 0, 0, 0],
      "S-01 by disposition: a promise call with no promise, information provided": [10, 4, 6, 0, 0],
      "the first such call": [23, 4, 19, 0, 0],
      "S-02 by disposition: escalated and not logged, the first on its issue": [39, 39, 0, 0, 0],
      "both by disposition": [9, 3, 6, 0, 0],
      "every promise call with no promise_id": [0, 0, 0, 0, 0],
      "a promise_to_pay call with no promise_id": [50, 50, 0, 0, 0],
      "a hardship call with no promise, information provided": [50, 50, 0, 0, 0],
      "a promise call with no promise that a payment followed within three weeks": [
        48, 37, 11, 0, 0,
      ],
      "the same, only where it is the only one": [54, 43, 11, 0, 0],
      "every handled call with no CMPL note": [0, 0, 0, 0, 0],
      "every call with no CMPL note whose reason a logged complaint has": [12, 12, 0, 0, 0],
      "an unlogged call another unlogged call for its reason follows within 3 to 60 days": [
        21, 9, 0, 12, 0,
      ],
      "the first such pair": [23, 9, 0, 14, 0],
      "the same, only where it is the only pair": [31, 19, 0, 12, 0],
      "a written request on an issue no logged call has": [50, 50, 0, 0, 0],
      "a closed call followed on its issue within 15 days": [39, 33, 0, 6, 0],
      "the promise note nearest the window's middle": [15, 0, 15, 0, 0],
      "every complaint not logged, the raised-again clause left out": [50, 50, 0, 0, 0],
      "the roots alone, no symptom": [50, 50, 0, 0, 0],
    });
    const clean = tasks.filter((t) => t.plan.plan === "clean").length;
    for (const [name, [all, , ...arms]] of Object.entries(floors)) {
      // A few points past the clean windows at most, and never a majority of any error's windows.
      expect(all!, name).toBeLessThanOrEqual(clean + Math.round(tasks.length * 0.03));
      for (const n of arms) expect(n, name).toBeLessThan(25);
    }
    // Nor of either promise arm within one: the windows of each error plan whose promise was kept, and broken.
    for (const [name, p] of Object.entries(CHEAP))
      for (const plan of ["S-01", "S-02", "S-01+S-02"] as const)
        for (const arm of [0, 1]) {
          const group = tasks.filter((t) => t.plan.plan === plan && t.plan.arm === arm);
          const passed = group.filter(
            (t) => gradeContactAudit(t, { findings: policyFindings(t, p) }).pass,
          ).length;
          expect(passed, `${name}, ${plan}, arm ${arm}`).toBeLessThan(group.length / 2);
        }
    // The rule, clause by clause, passes every window: the floors are what leaving a clause out costs.
    const rule = {
      s01: (t: ContactAuditTask) => t.contacts.filter((c) => notePromise(t, c) && !c.promise_id),
      s02: (t: ContactAuditTask) =>
        firstPerReason(t.contacts.filter((c) => voiced(t, c) && !c.complaint_logged)),
    };
    expect(floorOf(tasks, (t) => policyFindings(t, rule))).toEqual([200, 50, 50, 50, 50]);
  }, 300_000);

  it("can be audited from the rulebook and the tools: the reference passes the held-out suite and a training suite", async () => {
    for (const tasks of [heldTasks(), train()]) {
      const r = await solveAll(tasks);
      expect(r.misses).toEqual([]);
      // One turn of reading, one to add up a window's payments, one to submit.
      expect(r.turns).toBeLessThanOrEqual(3);
      expect(r.calls).toBeLessThanOrEqual(7);
    }
    expect(Math.max(...heldout().map((x) => x.attempts))).toBeLessThan(30);
  }, 1_800_000);

  it("draws every plan in turn, each a quarter, kept and broken promises, every symptom, and handled promises and complaints beside them", () => {
    for (const tasks of [heldTasks(), train()]) {
      const by = new Map<string, number>();
      for (const t of tasks)
        by.set(contactAuditVerdict(t), (by.get(contactAuditVerdict(t)) ?? 0) + 1);
      expect([...by.keys()].sort()).toEqual([...AUDIT_PLANS].sort());
      for (const n of by.values()) expect(n / tasks.length).toBeGreaterThan(0.15);
      for (const t of tasks) expect(contactAuditVerdict(t)).toBe(auditPlanOf(t.index));
      // Beside the roots, every window holds a promise recorded and a complaint logged.
      for (const t of tasks) {
        const h = handledBeside(t);
        expect(Math.min(h.promises, h.complaints), t.id).toBeGreaterThanOrEqual(AUDIT_MIN_HANDLED);
      }
    }
    const kinds = new Map<string, number>();
    for (const t of heldTasks())
      for (const f of expectedContactAudit(t).findings)
        kinds.set(`${f.error} ${f.kind}`, (kinds.get(`${f.error} ${f.kind}`) ?? 0) + 1);
    expect(Object.fromEntries([...kinds].sort())).toEqual({
      "S-01 broken_not_followed_up": 50,
      "S-01 dialed_in_window": 197,
      "S-01 kept_not_marked": 50,
      "S-01 root": 100,
      "S-02 no_acknowledgment": 100,
      "S-02 no_response": 100,
      "S-02 raised_again": 100,
      "S-02 root": 100,
    });
    // The promise anchor's arm: kept on even turns, broken on odd.
    for (const t of heldTasks().filter((x) => x.plan.plan === "S-01"))
      expect(
        expectedContactAudit(t).findings.some((f) =>
          auditArmOf(t.index) === 0
            ? f.kind === "kept_not_marked"
            : f.kind === "broken_not_followed_up",
        ),
      ).toBe(true);
    // Several of each in most windows: how many hold at least two, and at least three, of each.
    const held = heldTasks().map(handledBeside);
    expect([
      held.filter((h) => h.promises >= 2).length,
      held.filter((h) => h.promises >= 3).length,
      held.filter((h) => h.complaints >= 2).length,
      held.filter((h) => h.complaints >= 3).length,
    ]).toEqual([192, 176, 175, 153]);
  }, 1_800_000);

  it("keeps a draw only when it is fair to grade", () => {
    for (const t of heldTasks()) expect(judgeContactAudit(t), t.id).toEqual([]);
    // A label the reference cannot reach, or one it reaches that no label names, turns a draw away.
    const t = ofPlan("S-02")[0]!;
    const missing = { ...t, labels: t.labels.filter((l) => l.symptom !== "raised_again") };
    expect(judgeContactAudit(missing).join(" ")).toMatch(/no label names/);
    const added = {
      ...t,
      labels: [
        ...t.labels,
        {
          ...t.labels[0]!,
          symptom: "raised_again" as const,
          root_cause: false,
          contact: t.contacts[0]!.id,
        },
      ],
    };
    expect(judgeContactAudit(added).join(" ")).toMatch(/misses/);
    // First draws of training tasks: the ones with no pair of anchors draw again, and the ones the recognizer's
    // noise, a promise's payments or too few promises recorded and complaints logged put off the labels are
    // turned away, and named.
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const got = drawContactAuditCandidate(contactAuditTaskId("train", 11, i), "train", 11, i);
      if (got?.issues.length) reasons.add(turnedAwayBecause(got.issues));
    }
    expect([...reasons].filter((x) => x.startsWith("other"))).toEqual([]);
    for (const d of heldout()) for (const x of d.turned_away) expect(x).not.toMatch(/^other/);
  }, 600_000);

  it("reads the window's own records with the tools, and nothing outside it", () => {
    const t = ofPlan("S-01+S-02")[0]!;
    const run = (name: string, input: unknown) =>
      JSON.parse(executeContactAuditTool(name, input, t)) as Record<string, unknown>;
    const all = run("read_notes", {})["notes"] as { on: string; contact: string | null }[];
    expect(all.every((n) => n.on >= t.window.from && n.on <= t.window.to)).toBe(true);
    const root = rootOf(t, "S-01");
    expect((run("read_notes", { contact: root })["notes"] as unknown[]).length).toBeGreaterThan(0);
    expect(
      (run("read_transcript", { contact: root })["lines"] as unknown[]).length,
    ).toBeGreaterThan(5);
    const silent = t.contacts.find((c) => !c.transcript)!;
    expect(() => executeContactAuditTool("read_transcript", { contact: silent.id }, t)).toThrow(
      /no transcript/,
    );
    expect(() => executeContactAuditTool("read_transcript", { contact: "nobody" }, t)).toThrow(
      /no contact/,
    );
    const hits = run("search_transcripts", { phrases: ["thank you"] })["matches"] as {
      lines: { contact: string; line: number; text: string }[];
    }[];
    for (const l of hits[0]!.lines) expect(says(l.text, "thank you")).toBe(true);
    const pays = run("read_payments", { from: t.window.from, to: t.window.from })["payments"] as {
      on: string;
    }[];
    expect(pays.every((p) => p.on === t.window.from)).toBe(true);
    expect(JSON.parse(executeContactAuditTool("calculate", { expression: "1.10 + 2.20" }))).toEqual(
      { value: "3.3" },
    );
    expect(() => executeContactAuditTool("read_promises", {})).toThrow(/reads the task/);
    expect(() => executeContactAuditTool("verdict", {}, t)).toThrow(/no tool named/);
    expect(() => executeContactAuditTool("read_notes", { from: "1/2/27" }, t)).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump CONTACT_AUDIT_ENVIRONMENT_VERSION, then the pin. The suite is drawn
    // from the life generator and the contact center: a change to either moves it too.
    expect(sha256(heldTasks().map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"a0dc825e1b2ef86d41f1ab67459fbbc85ea13d9e1fef91fcc61df0aa48e728e0"`,
    );
  }, 600_000);

  it("rebuilds a task from its coordinates, and never draws a held-out window into training", () => {
    expect(toJsonLine(generateContactAuditTask("train", 11, 17))).toBe(toJsonLine(train()[17]));
    const fp = (t: ContactAuditTask) => sha256(toJsonLine(contactAuditPayload(t)));
    const held = new Set(heldTasks().map(fp));
    expect(train().filter((t) => held.has(fp(t)))).toEqual([]);
    expect(contactAuditTaskId("heldout", 1, 0)).toBe("contact-audit/1.0.0/heldout/1/0");
    expect(drawsHeldoutStream(heldTasks()[0]!.id)).toBe(true);
    const answer: ContactAuditAnswer = expectedContactAudit(heldTasks()[1]!);
    expect(gradeContactAudit(heldTasks()[1]!, answer).pass).toBe(true);
  }, 600_000);
});
