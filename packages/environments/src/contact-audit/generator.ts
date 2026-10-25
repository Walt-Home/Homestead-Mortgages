/**
 * Synthetic contact histories, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). Its loan comes from a
 * life book of one, seeded from the task's key, run thirty months through the
 * contact center: a borrower who falls behind every two to four months and
 * promises to pay each time (the scenario's promise, kept or broken, beside the
 * promises the contact center draws from the receipts), calls often, and
 * complains often, because the borrower is irritated and has a grievance (the
 * contact center's pins, `AUDIT_PINS`). Two calls are the task's anchors, in
 * turn by index: a promise call (one the borrower kept, then one broken) and a
 * complaint call, within 120 days of each other. What the anchors need runs
 * from ten days before the first to a week past the promise's pay-by date and
 * past the last day the complaint can be raised again; the window adds 90 to
 * 210 days more, split at random between before and after, so where the
 * anchors sit in it says nothing. The plan, in turn by index, says what is
 * made on them (`plantStaffErrors`):
 *
 *   - clean: nothing, the control; both calls handled as the rules say;
 *   - S-01: the promise not recorded;
 *   - S-02: the complaint not logged;
 *   - both, on the two calls.
 *
 * Beside the roots every window holds promises recorded and complaints logged,
 * drawn as the contact center draws them, several of each in most: a root these
 * rules do not give fails a window, so reporting every promise or every
 * complaint names a false root. A draw whose window holds fewer than
 * `AUDIT_MIN_HANDLED` of either is redrawn.
 *
 * A draw is kept only when it is fair to grade: the reference, the rulebook as
 * code reading the window through the tools, finds exactly the labels' roots
 * and the symptoms a rule names, and nothing else (none at all in a clean
 * window). Where the recognizer's noise hides a complaint, or a promise's
 * payments read otherwise than the promise log does, the draw is redrawn, and
 * docs/environments.md says how often.
 */

import { addDays, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import type { Scenario, ScenarioEvent } from "../life/scenario.js";
import {
  RAISED_AGAIN_AFTER,
  STAFF_ERRORS,
  plantStaffErrors,
  type ContactRecord,
  type ProfilePins,
  type StaffErrorRequest,
} from "../contacts/index.js";
import { COMPLAINT_PHRASES, says } from "../calls/index.js";
import { rebuild } from "../call-qa/view.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { expectedContactAudit, parseContactAuditSubmission, amountCents } from "./grader.js";
import { materialsOf, type Window } from "./materials.js";
import { contactAuditSteps } from "./reference.js";
import {
  CONTACT_AUDIT_ENVIRONMENT_NAME,
  CONTACT_AUDIT_ENVIRONMENT_VERSION,
  contactAuditPayload,
  type AuditPlan,
  type ContactAuditTask,
} from "./task.js";
import { executeContactAuditTool } from "./tools.js";

export const contactAuditTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${CONTACT_AUDIT_ENVIRONMENT_NAME}/${CONTACT_AUDIT_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

/** The plans, taken in turn by index, so a quarter of any run of indexes is each. */
export const AUDIT_PLANS: readonly AuditPlan[] = ["clean", "S-01", "S-02", "S-01+S-02"];
export const auditPlanOf = (index: number): AuditPlan => AUDIT_PLANS[index % AUDIT_PLANS.length]!;
/** The promise anchor's arm, in turn within a plan: one the borrower kept (0), one broken (1). */
export const auditArmOf = (index: number): number => Math.floor(index / AUDIT_PLANS.length) % 2;

/** Thirty months from the first payment: a delinquency every two to four months, each with a promise. */
export const AUDIT_HISTORY_MONTHS = 30;
/**
 * The contact center's pins on every task's loan: an English-speaking borrower (v1 reads no interpreted
 * call), irritated, with a grievance that makes a complaint five times as likely on an inbound call an
 * agent handles (an outbound call carries none), who calls six times as often as the calibration's
 * borrower in the same status, and who pays within three weeks of a conversation without having promised
 * to on it three times in five. docs/environments.md gives what the pins make of a window.
 */
export const AUDIT_PINS: ProfilePins = {
  language: "en",
  style: "irritated",
  complaint_multiplier: 5,
  call_multiplier: 6,
  kept_promise_share: 0.4,
};
/** How far apart the promise call and the complaint call may be. */
export const ANCHOR_SPAN_DAYS = 120;
/** The days the window runs beyond what the two anchors need, split at random between before and after. */
export const AUDIT_WINDOW_EXTRA: readonly [number, number] = [90, 210];
/** Beside the roots, a window holds at least this many promises recorded and complaints logged. */
export const AUDIT_MIN_HANDLED = 1;

/** The scenario a key's draw runs, read off the key's stream before anything else is. */
export const auditScenario = (key: string): Scenario => scenarioFor(rngFor(key));

function scenarioFor(r: Rng): Scenario {
  const events: ScenarioEvent[] = [];
  let k = r.int(3, 6);
  for (let n = 0; n < 12 && k <= AUDIT_HISTORY_MONTHS - 6; n++) {
    events.push({ kind: "missed_payment", loan: 0, month: k });
    if (r.chance(0.5)) events.push({ kind: "missed_payment", loan: 0, month: k + 1 });
    events.push({
      kind: "promise_to_pay",
      loan: 0,
      month: k,
      day: r.int(18, 26),
      pay_in_days: r.int(5, 14),
      kept: r.chance(0.5),
    });
    k += r.int(2, 4);
  }
  return { loans: 1, months: AUDIT_HISTORY_MONTHS, events };
}

/** Why a draw is not fair to grade, or [] when it is: the reference, reading the window, lands off the labels. */
export function judgeContactAudit(task: ContactAuditTask): string[] {
  const want = expectedContactAudit(task);
  let raw: unknown;
  try {
    raw = solveNow(
      contactAuditSteps,
      JSON.parse(JSON.stringify(contactAuditPayload(task))) as Record<string, unknown>,
      (n, i) => executeContactAuditTool(n, i, task),
    );
  } catch (e) {
    return [`the reference threw: ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseContactAuditSubmission(raw);
  if (!parsed.ok) return [`the reference's submission: ${parsed.error}`];
  const keyOf = (f: {
    error: string;
    kind: string;
    contact: string;
    promise: { amount: string; pay_by: string } | null;
  }) =>
    `${f.error} ${f.kind} ${f.contact}${f.promise ? ` ${amountCents(f.promise.amount)} ${f.promise.pay_by}` : ""}`;
  const a = new Set(want.findings.map(keyOf));
  const b = new Set(parsed.answer.findings.map(keyOf));
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(`the reference misses ${x}`);
  for (const x of b) if (!a.has(x)) out.push(`the reference finds ${x}, which no label names`);
  if (parsed.answer.findings.length !== b.size) out.push("the reference names a finding twice");
  return out;
}

const endOf = (life: ReturnType<typeof rebuild>["book"]["loans"][number]): PlainDate => {
  const last = life.months[life.months.length - 1];
  return (life.payoff?.on ??
    life.transfer_out_on ??
    last?.as_of ??
    life.draw.first_due) as PlainDate;
};

/**
 * One candidate: a loan from the key, its anchors, the plan made on them, the
 * window read off the center the plan leaves. Null when the loan has no pair
 * of anchors that fit; otherwise the task with its issues ([] when fair).
 */
export function drawContactAuditCandidate(
  key: string,
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: ContactAuditTask; issues: string[] } | null {
  const plan = auditPlanOf(index);
  const arm = auditArmOf(index);
  const r = rngFor(key);
  const scenario = scenarioFor(r);
  const pins = AUDIT_PINS;
  const { book, center } = rebuild(key, scenario, pins);
  const life = book.loans[0]!;
  const loan = center.loans[0]!;
  const end = endOf(life);
  const start = loan.contacts[0]?.on;
  if (!start) return null;
  const promiseOf = (c: ContactRecord) => loan.promises.find((p) => p.id === c.promise_id)!;
  const promiseCalls = loan.contacts.filter((c) => {
    if (c.servicer !== "us" || !STAFF_ERRORS["S-01"].eligible(c)) return false;
    const p = promiseOf(c);
    return p.status === (arm === 0 ? "kept" : "broken") && addDays(p.pay_by, 7) <= end;
  });
  const complaintCalls = loan.contacts.filter(
    (c) =>
      c.servicer === "us" &&
      STAFF_ERRORS["S-02"].eligible(c) &&
      addDays(c.on, RAISED_AGAIN_AFTER[1] + 1) <= end,
  );
  const pairs = promiseCalls.flatMap((p) =>
    complaintCalls
      .filter((c) => c.id !== p.id && Math.abs(daysBetween(p.on, c.on)) <= ANCHOR_SPAN_DAYS)
      .map((c) => [p, c] as const),
  );
  if (!pairs.length) return null;
  const [p, c] = pairs[r.int(0, pairs.length - 1)]!;
  const promise = promiseOf(p);
  const first = p.on < c.on ? p.on : c.on;
  // What the anchors need: from ten days before the first to a week past the promise's date and past the latest day
  // the complaint is raised again. The rest of the window is split at random, so where the anchors sit says nothing.
  const tail = addDays(promise.pay_by, 7);
  const after = addDays(c.on, RAISED_AGAIN_AFTER[1] + 1);
  const extra = r.int(AUDIT_WINDOW_EXTRA[0], AUDIT_WINDOW_EXTRA[1]);
  const lead = r.int(0, extra);
  let from = addDays(first, -(10 + lead));
  if (from < start) from = start;
  let to = addDays(tail > after ? tail : after, extra - lead);
  if (to > end) to = end;
  const window: Window = { from, to };

  const requests: StaffErrorRequest[] = [];
  if (plan === "S-01" || plan === "S-01+S-02") requests.push({ id: "S-01", contacts: [p.id] });
  if (plan === "S-02" || plan === "S-01+S-02") requests.push({ id: "S-02", contacts: [c.id] });
  const res = requests.length
    ? plantStaffErrors(center, book, requests, { pins: { 0: pins } })
    : null;
  const used = res?.defective ?? center;
  const { ids, ...m } = materialsOf(used, book, 0, window);
  // The graded labels, with the desk's ids for the center's.
  const labels = (res?.labels ?? [])
    .filter((l) => l.root_cause || l.symptom !== null)
    .map((l) => ({
      ...l,
      row: ids.get(l.row) ?? l.row,
      contact: l.contact === null ? null : (ids.get(l.contact) ?? l.contact),
    }));
  const task: ContactAuditTask = {
    id: contactAuditTaskId(split, suiteSeed, index),
    split,
    suite_seed: suiteSeed,
    index,
    ...m,
    labels,
    plan: { plan, arm },
    source: {
      seed: key,
      scenario,
      pins,
      roots: {
        ...(plan === "S-01" || plan === "S-01+S-02" ? { "S-01": p.id } : {}),
        ...(plan === "S-02" || plan === "S-01+S-02" ? { "S-02": c.id } : {}),
      },
    },
  };
  const issues: string[] = [];
  const shown = new Set(m.contacts.map((x) => x.id));
  for (const l of labels)
    if (!l.contact || !shown.has(l.contact))
      issues.push(`${l.defect_id} ${l.symptom ?? "root"} on ${l.contact} is outside the window`);
  if (res?.skipped.length) issues.push(`the planter skipped ${JSON.stringify(res.skipped)}`);
  const held = handledBeside(task);
  if (held.promises < AUDIT_MIN_HANDLED || held.complaints < AUDIT_MIN_HANDLED)
    issues.push(
      `the window holds ${held.promises} promises recorded and ${held.complaints} complaints logged beside its roots`,
    );
  issues.push(...judgeContactAudit(task));
  return { task, issues };
}

/**
 * The promises recorded and the complaints logged in a window, which no root can be: every call whose promise the
 * promise log holds, and every call whose complaint was logged and whose transcript says it in the rubric's words
 * (one the recognizer hid is no false root a reviewer could name).
 */
export function handledBeside(task: ContactAuditTask): { promises: number; complaints: number } {
  const recorded = new Set(task.promises.map((p) => p.contact));
  const voiced = (id: string) =>
    (task.transcripts[id] ?? []).some((l) => COMPLAINT_PHRASES.some((ph) => says(l.text, ph)));
  return {
    promises: task.contacts.filter((c) => recorded.has(c.id)).length,
    complaints: task.contacts.filter((c) => c.complaint_logged && voiced(c.id)).length,
  };
}

/** Why a draw was turned away, by kind: each a filter on the suite, which docs/environments.md names. */
export function turnedAwayBecause(issues: readonly string[]): string {
  const all = issues.join("\n");
  if (/does not make this call/.test(all))
    return "S-01's twin does not make the call S-02 was asked for";
  if (/misses S-02 root/.test(all)) return "the recognizer hid the complaint";
  if (/misses S-02 raised_again/.test(all)) return "the recognizer hid the complaint raised again";
  if (/(kept_not_marked|broken_not_followed_up)/.test(all))
    return "the payments read otherwise than the promise log";
  if (/beside its roots/.test(all)) return "too few promises recorded or complaints logged";
  return `other: ${all}`;
}

/** Draws from the task's own stream, and again from `${id}#n`, until a draw is fair to grade. */
export const AUDIT_MAX_ATTEMPTS = 60;

export function drawContactAuditTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: ContactAuditTask; attempts: number; turned_away: readonly string[] } {
  const id = contactAuditTaskId(split, suiteSeed, index);
  const turned: string[] = [];
  for (let a = 0; a < AUDIT_MAX_ATTEMPTS; a++) {
    const got = drawContactAuditCandidate(a === 0 ? id : `${id}#${a}`, split, suiteSeed, index);
    if (!got) {
      turned.push("no anchors");
      continue;
    }
    if (got.issues.length === 0) return { task: got.task, attempts: a + 1, turned_away: turned };
    turned.push(turnedAwayBecause(got.issues));
  }
  throw new Error(`${id}: no fair ${auditPlanOf(index)} window in ${AUDIT_MAX_ATTEMPTS} draws`);
}

export const generateContactAuditTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): ContactAuditTask => drawContactAuditTask(split, suiteSeed, index).task;

export function generateContactAuditSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): ContactAuditTask[] {
  return Array.from({ length: n }, (_, i) => generateContactAuditTask(split, suiteSeed, i));
}

export const CONTACT_AUDIT_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };
