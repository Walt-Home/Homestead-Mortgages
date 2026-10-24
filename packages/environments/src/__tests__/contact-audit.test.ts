/**
 * Staff errors and contact-audit: the contact center makes S-01 (a promise
 * not tracked) and S-02 (a complaint not logged) on a call the clean history
 * has, and a clean center is what it was; the twin is the clean history until
 * the call, every other call word for word, and the contact center's rules
 * from there; the labels tell the root from what follows. contact-audit's
 * rulebook is pinned, its spec cases give what their hand-written labels say,
 * every generated window can be audited from the rulebook and the tools, the
 * grader reads a root apart from its symptoms as boarding-triage does, a
 * clean window is a control, and every plan and symptom turns up.
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
      // The row: no promise, dispositioned as a call that records nothing; nothing else moved.
      expect([w.promise_id, w.resolution]).toEqual([null, "information_provided"]);
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
      expect(paused(clean).length).toBeGreaterThan(0);
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
      expect({ ...w, complaint_logged: true, related: c.related }).toEqual(c);
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
      // The borrower calls about it again, on the same issue, and nobody logs that either.
      const again = twin.contacts.find((x) => x.id === `${rootId}-S02`)!;
      expect(again).toBeDefined();
      expect([again.direction, again.mode, again.outcome, again.issue, again.reason]).toEqual([
        "inbound",
        "call",
        "conversation",
        c.issue,
        c.reason,
      ]);
      expect([again.complaint_voiced, again.complaint_logged, again.promise_id]).toEqual([
        true,
        false,
        null,
      ]);
      const lag = (Date.parse(again.on) - Date.parse(c.on)) / 86_400_000;
      expect(lag).toBeGreaterThanOrEqual(RAISED_AGAIN_AFTER[0]);
      expect(lag).toBeLessThanOrEqual(RAISED_AGAIN_AFTER[1] + 1);
      const said = transcriptOf(res.defective, book, again.id).turns.map((x) => x.said);
      expect(said.some((x) => COMPLAINT_PHRASES.some((p) => says(x, p)))).toBe(true);
      expect(said.some((x) => ACK_PHRASES.some((p) => says(x, p)))).toBe(false);
      // Every other contact is the clean one.
      expect(
        twin.contacts
          .filter((x) => x.id !== rootId && x.id !== again.id)
          .map((x) => ({ ...x, related: [] })),
      ).toEqual(clean.contacts.filter((x) => x.id !== rootId).map((x) => ({ ...x, related: [] })));
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
    // contact-audit/1.0.0/train/3/11#1: a hardship call the day after the promise call takes a promise of its own
    // once nobody recorded the first, so it is no longer escalated, and the follow-up S-02 was asked for is never
    // made. S-01 is made alone, and the planter says why.
    const key = "contact-audit/1.0.0/train/3/11#1";
    const got = drawContactAuditCandidate(key, "train", 3, 11)!;
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

describe("contact-audit", () => {
  it("pins what a model is told, and states each rule the way the labels hold it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // CONTACT_AUDIT_ENVIRONMENT_VERSION with this pin.
    expect(CONTACT_AUDIT_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "contact-audit",
        "rulebook_sha256": "be03388e01a2ac2d30e2b7949a530a5f1cba0bd9a162a7bc6ba5371bd83a4e39",
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
    expect(CONTACT_AUDIT_RULEBOOK).toContain(`at most ${AUDIT_EXTRA_FINDINGS_CAP} findings`);
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
    ]);
    for (const t of SPEC) expect(judgeContactAudit(t), t.id).toEqual([]);
    const r = await solveAll(SPEC);
    expect(r.misses).toEqual([]);
    expect(new Set(CONTACT_AUDIT_SPEC_CASES.map((c) => c.name)).size).toBe(SPEC.length);
  });

  it("grades a root apart from its symptoms: a symptom alone earns part of the credit, the root covers them", () => {
    for (const t of ofPlan("S-01+S-02").slice(0, 6)) {
      const right = expectedContactAudit(t);
      const grade = (findings: readonly AuditFinding[]) => gradeContactAudit(t, { findings });
      expect(grade(right.findings).pass).toBe(true);
      const roots = right.findings.filter((f) => f.kind === "root");
      expect(grade(roots).pass).toBe(true);
      const symptom = right.findings.find((f) => f.kind !== "root" && f.error === "S-02")!;
      const alone = grade([...roots.filter((f) => f.error === "S-01"), symptom]);
      expect(alone.pass).toBe(false);
      expect(alone.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual([
        `S-02 ${rootOf(t, "S-02")}: found`,
      ]);
      expect(alone.score).toBeGreaterThan(grade(roots.filter((f) => f.error === "S-01")).score);
      // The promise to the cent and the day; written either way.
      const s01 = roots.find((f) => f.error === "S-01")!;
      const cents = (a: string) => a.replace(/[$,]/g, "");
      expect(
        grade([
          ...roots.filter((f) => f !== s01),
          { ...s01, promise: { ...s01.promise!, amount: cents(s01.promise!.amount) } },
        ]).pass,
      ).toBe(true);
      const off = {
        ...s01,
        promise: {
          ...s01.promise!,
          amount: (Number(cents(s01.promise!.amount)) + 0.01).toFixed(2),
        },
      };
      expect(
        grade([...roots.filter((f) => f !== s01), off])
          .fields.filter((f) => !f.ok)
          .map((f) => f.field),
      ).toEqual([`S-01 ${rootOf(t, "S-01")}: promise`]);
      // Extra findings: up to the cap, then not; a duplicate is an extra.
      const stray: AuditFinding = {
        error: "S-01",
        kind: "dialed_in_window",
        contact: t.contacts[0]!.id,
        promise: null,
      };
      const extra = (n: number) =>
        grade([...right.findings, ...Array<AuditFinding>(n).fill(stray)]);
      const strayIsLabel = right.findings.some(
        (f) => f.kind === stray.kind && f.contact === stray.contact,
      );
      if (!strayIsLabel) {
        expect(extra(AUDIT_EXTRA_FINDINGS_CAP).pass).toBe(true);
        expect(extra(AUDIT_EXTRA_FINDINGS_CAP + 1).pass).toBe(false);
      }
      expect([gradeContactAudit(t, null).pass, gradeContactAudit(t, null).score]).toEqual([
        false,
        0,
      ]);
    }
    // A clean window is a control: nothing passes it, any finding fails it, and no submission is no decision.
    const clean = ofPlan("clean")[0]!;
    expect(gradeContactAudit(clean, { findings: [] }).pass).toBe(true);
    const one: AuditFinding = {
      error: "S-02",
      kind: "root",
      contact: clean.contacts[0]!.id,
      promise: null,
    };
    expect(
      gradeContactAudit(clean, { findings: [one] })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field),
    ).toEqual(["passed"]);
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

  it("gives floors to read a score against: nothing, every promise, every complaint", () => {
    const PROMISE =
      /(\$?\d{1,3}(?:,\d{3})+\.\d{2}|\$?\d+\.\d{2})\s+by\s+(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/i;
    const everyPromise = (t: ContactAuditTask): AuditFinding[] =>
      t.contacts.flatMap((c) => {
        const n = t.notes.find((x) => x.contact === c.id && x.user === c.agent);
        const m = n ? PROMISE.exec(n.text.split("| PREV:")[0]!) : null;
        if (!m) return [];
        const yy = m[4]!.length === 2 ? `20${m[4]}` : m[4]!;
        const payBy = `${yy}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
        return [
          { error: "S-01", kind: "root", contact: c.id, promise: { amount: m[1]!, pay_by: payBy } },
        ];
      });
    const everyComplaint = (t: ContactAuditTask): AuditFinding[] =>
      t.contacts
        .filter((c) =>
          (t.transcripts[c.id] ?? []).some((l) => COMPLAINT_PHRASES.some((p) => says(l.text, p))),
        )
        .map((c) => ({ error: "S-02", kind: "root", contact: c.id, promise: null }));
    const floor = (f: (t: ContactAuditTask) => readonly AuditFinding[]) => {
      const g = heldTasks().map((t) => gradeContactAudit(t, { findings: f(t) }));
      return {
        passed: g.filter((x) => x.pass).length,
        mean: Number((g.reduce((s, x) => s + x.score, 0) / g.length).toFixed(3)),
      };
    };
    expect(floor(() => [])).toEqual({ passed: 50, mean: 0.438 });
    expect(floor(everyPromise)).toEqual({ passed: 46, mean: 0.56 });
    expect(floor(everyComplaint)).toEqual({ passed: 51, mean: 0.553 });
    expect(floor((t) => [...everyPromise(t), ...everyComplaint(t)])).toEqual({
      passed: 55,
      mean: 0.665,
    });
  }, 120_000);

  it("can be audited from the rulebook and the tools: the reference passes the held-out suite and a training suite", async () => {
    for (const tasks of [heldTasks(), train()]) {
      const r = await solveAll(tasks);
      expect(r.misses).toEqual([]);
      // One turn of reading, one to add up a window's payments, one to submit.
      expect(r.turns).toBeLessThanOrEqual(3);
      expect(r.calls).toBeLessThanOrEqual(7);
    }
    expect(Math.max(...heldout().map((x) => x.attempts))).toBeLessThan(30);
  }, 600_000);

  it("draws every plan in turn, each a quarter, kept and broken promises, and every symptom", () => {
    for (const tasks of [heldTasks(), train()]) {
      const by = new Map<string, number>();
      for (const t of tasks)
        by.set(contactAuditVerdict(t), (by.get(contactAuditVerdict(t)) ?? 0) + 1);
      expect([...by.keys()].sort()).toEqual([...AUDIT_PLANS].sort());
      for (const n of by.values()) expect(n / tasks.length).toBeGreaterThan(0.15);
      for (const t of tasks) expect(contactAuditVerdict(t)).toBe(auditPlanOf(t.index));
    }
    const kinds = new Map<string, number>();
    for (const t of heldTasks())
      for (const f of expectedContactAudit(t).findings)
        kinds.set(`${f.error} ${f.kind}`, (kinds.get(`${f.error} ${f.kind}`) ?? 0) + 1);
    expect(Object.fromEntries([...kinds].sort())).toEqual({
      "S-01 broken_not_followed_up": 50,
      "S-01 dialed_in_window": 195,
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
    // Every window holds promises and complaints that were handled right, beside any that were not.
    for (const t of heldTasks()) {
      expect(t.promises.length + (t.plan.plan.includes("S-01") ? 1 : 0)).toBeGreaterThan(0);
      expect(t.complaints.length + (t.plan.plan.includes("S-02") ? 1 : 0)).toBeGreaterThan(0);
    }
  }, 600_000);

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
    // noise or a promise's payments put off the labels are turned away, and named.
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const got = drawContactAuditCandidate(contactAuditTaskId("train", 11, i), "train", 11, i);
      if (got?.issues.length) reasons.add(turnedAwayBecause(got.issues));
    }
    expect([...reasons].filter((x) => x.startsWith("other"))).toEqual([]);
    for (const d of heldout()) for (const x of d.turned_away) expect(x).not.toMatch(/^other/);
  }, 300_000);

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
      `"4b8245f7c86ea03e6ccbe77313d6ae883d63a2e765f65407294590ff9d712c3b"`,
    );
  }, 120_000);

  it("rebuilds a task from its coordinates, and never draws a held-out window into training", () => {
    expect(toJsonLine(generateContactAuditTask("train", 11, 17))).toBe(toJsonLine(train()[17]));
    const fp = (t: ContactAuditTask) => sha256(toJsonLine(contactAuditPayload(t)));
    const held = new Set(heldTasks().map(fp));
    expect(train().filter((t) => held.has(fp(t)))).toEqual([]);
    expect(contactAuditTaskId("heldout", 1, 0)).toBe("contact-audit/1.0.0/heldout/1/0");
    expect(drawsHeldoutStream(heldTasks()[0]!.id)).toBe(true);
    const answer: ContactAuditAnswer = expectedContactAudit(heldTasks()[1]!);
    expect(gradeContactAudit(heldTasks()[1]!, answer).pass).toBe(true);
  }, 120_000);
});
