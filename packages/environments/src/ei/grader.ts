/**
 * The grader: the servicing app's own early-intervention windows engine
 * (`ported/windows.ts`), folded over the loan's history as §11.1's and
 * §11.2's state machines run it, and beside it the rules outside that
 * engine, each restated with the line it comes from.
 *
 * The servicing app has no fold of its own. Its counter job's
 * `projectWindows` writes the windows table without calling this engine: a
 * late payment cancels a breached leg there, and one live contact satisfies
 * every later window (docs/servicing-engine-defects.md, ei-2). Its unit of
 * work never wires the reader that cancels a paid window's clocks (ei-1),
 * and its counter never hands the engine the notice cycle that covers later
 * windows (ei-3). So the fold here is written from the spec, and each step
 * names its line:
 *
 *   - a window opens on D + 1 for every installment D unpaid then, before
 *     anything else that day (11.1 rule 1; ops.ts:75-76, the 00:05 counter);
 *   - each day starts with the sweep: a leg still open past its deadline is
 *     breached and never deleted (11.1 and 11.2 state machines; windows.ts
 *     `sweep`);
 *   - the installment credited on or before a leg's deadline cancels it,
 *     later leaves the duty standing (11.1 rule 1, comment 39(a)-1;
 *     windows.ts `installmentPaid`);
 *   - a live contact satisfies every open live leg whose window contains its
 *     day (11.1 rule 1, 11.1-T4; windows.ts `applyContact`);
 *   - a petition, a cease and a discharge move what they move
 *     (windows.ts `applyBankruptcyPetition`, `applyFdcpaCease`, and
 *     `openWindow`'s `bankruptcy` option);
 *   - a notice provided is the notice for every leg that is breached or
 *     waiting on the bankruptcy notice, and for the oldest open leg; every
 *     other open leg is inside the cycle it starts, so it is
 *     `satisfied_by_prior_180` (11.2 rule 4, 11.2-T3: the Dec 14 notice
 *     covers the Dec 1 window, which opened on Dec 2), as `openWindow` marks
 *     a window opened inside a cycle (windows.ts:74);
 *   - each notice starts a cycle; one superseded by the next notice before
 *     its end is never reviewed, and one that runs to its end is reviewed
 *     there with the counter that day (11.2 rule 3; windows.ts
 *     `cycleEndReview`).
 *
 * The rules outside the engine:
 *   - the §1024.40 assignment: by the written notice, and in any event by
 *     day 45 (continuity.ts:4, servicing-requests/ops.ts:178-182);
 *   - the D2-2-02 outbound cadence: open from day 17, a first attempt by day
 *     36 and then every 7 days, each deadline moved to the servicer's next
 *     open day (plan.ts:16-17, :64, :95; 11.1 timer rows
 *     FNMA_D2202_OUTBOUND_START_36 and _EVERY_7), suspended by a petition or
 *     a cease (plan.ts:179-181) and ended by the cure (plan.ts:151-155);
 *   - Reg F's call cap: at most 7 counted calls to a person in 7 days
 *     (ops.ts:222-231; section11.ts:328; evaluator-kit.ts:24).
 */

import { addDays, rollForward, servicer, type PlainDate } from "@hm/kernel/calendar";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  earliestUnpaidDueDate,
  regxDaysDelinquent,
  type AppliedInstallment,
} from "../pmi/ported/delinquency.js";
import {
  applyBankruptcyPetition,
  applyContact,
  applyFdcpaCease,
  bkModifiedNoticeDue,
  BK_NOTICE_DAYS,
  cycleEndReview,
  installmentPaid,
  noticeCycle,
  noticeProvided,
  openWindow,
  sweep,
  type Cycle,
  type LiveStatus,
  type NoticeStatus,
  type Variant,
  type Window,
} from "./ported/windows.js";
import type { Contact, EiTask, Person } from "./task.js";

/* ── the rules outside the engine, with the lines they come from ──────────── */

/** §1024.40(a)(1): `assignmentDue` is the unpaid due date + 45 (continuity.ts:4). */
export const ASSIGN_DAYS = 45;
/** The D2-2-02 plan opens on day 17 of a delinquency (plan.ts:16 FIRST_ATTEMPT_DAY, 11.1 rule 5). */
export const CADENCE_OPENS_DAY = 17;
/** The first outbound attempt by day 36, then every 7 days (plan.ts:17, :193; 11.1 timer rows). */
export const OUTBOUND_START_DAYS = 36;
export const OUTBOUND_EVERY_DAYS = 7;
/** Reg F §1006.14(b)(2): more than 7 counted calls to a person in 7 days (ops.ts:230-231). */
export const REGF_CAP = 7;
export const REGF_DAYS = 7;

/**
 * `assignmentTrigger` (servicing-requests/ops.ts:178-182): personnel are
 * assigned by the day the written notice is provided when that comes first,
 * and in any event by day 45 of the delinquency.
 */
export function assignmentBy(
  dueUnpaid: PlainDate,
  noticeOn: PlainDate | null,
): { assign_by: PlainDate; basis: "day_45" | "ei_notice" } {
  const d = addDays(dueUnpaid, ASSIGN_DAYS);
  return noticeOn && noticeOn < d
    ? { assign_by: noticeOn, basis: "ei_notice" }
    : { assign_by: d, basis: "day_45" };
}

/** A D2-2-02 deadline on a day the servicer is closed moves to the next open day (plan.ts:64, A4-2.1-04). */
export const shiftOpen = (d: PlainDate): PlainDate => rollForward(d, servicer);

/** A live contact: speaking with a borrower, outbound or inbound (comment 39(a)-2; plan.ts:98, :105). */
export const isLiveContact = (c: Contact): boolean => c.outcome === "conversation";
/** An outbound contact attempt under D2-2-02: every outbound attempt but a letter (plan.ts:191). */
export const isOutboundAttempt = (c: Contact): boolean =>
  c.direction === "outbound" && c.channel !== "letter";
/**
 * A call Reg F counts: an outbound voice call that connected, not one the
 * person asked for (ops.ts:222 `counts`; section11.ts:328 `regf_counted`).
 */
export const isCountedCall = (c: Contact): boolean =>
  c.direction === "outbound" &&
  (c.channel === "ai_voice" || c.channel === "human_voice") &&
  c.outcome !== "busy_or_failed" &&
  !c.callback_requested;

/* ── the answer ───────────────────────────────────────────────────────────── */

export const LIVE_STATUSES = [
  "open",
  "satisfied_live",
  "cancelled_paid",
  "exempt_bk",
  "exempt_fdcpa_cease",
  "exempt_discharge",
  "not_applicable",
  "breached",
] as const satisfies readonly LiveStatus[];
export const NOTICE_STATUSES = [
  "open",
  "sent",
  "satisfied_by_prior_180",
  "cancelled_paid",
  "bk_modified_required",
  "exempt_bk_cease",
  "exempt_discharge",
  "not_applicable",
  "breached",
] as const satisfies readonly NoticeStatus[];
export const CYCLE_OUTCOMES = ["superseded", "running", "repeat_required", "not_required"] as const;
export const REPEAT_STATUSES = ["sent", "late", "open", "breached"] as const;
export const BK_STATUSES = [
  "sent",
  "late",
  "open",
  "breached",
  "exempt",
  "not_yet_required",
] as const;
export const CONTINUITY_STATUSES = [
  "met",
  "late",
  "open",
  "breached",
  "not_due",
  "not_required",
] as const;
export const PERSONS: readonly Person[] = ["borrower", "co_borrower"];

export interface WindowAnswer {
  readonly due_date: string;
  readonly live_due: string;
  readonly live: (typeof LIVE_STATUSES)[number];
  readonly live_late: boolean;
  readonly notice_due: string;
  readonly notice: (typeof NOTICE_STATUSES)[number];
  readonly notice_late: boolean;
}
export interface CycleAnswer {
  readonly provided_on: string;
  readonly cycle_end: string;
  readonly outcome: (typeof CYCLE_OUTCOMES)[number];
  readonly next_required_by: string | null;
  readonly repeat: (typeof REPEAT_STATUSES)[number] | null;
}
export interface BkNoticeAnswer {
  readonly due: string | null;
  readonly status: (typeof BK_STATUSES)[number];
}
export interface ContinuityAnswer {
  readonly assign_by: string | null;
  readonly basis: "day_45" | "ei_notice" | null;
  readonly status: (typeof CONTINUITY_STATUSES)[number];
}
export interface OutboundAnswer {
  readonly start_due: string;
  readonly missed: readonly string[];
  readonly next_due: string | null;
}
export interface EpisodeAnswer {
  readonly day_1: string;
  readonly ended_on: string | null;
  readonly continuity: ContinuityAnswer;
  readonly outbound: OutboundAnswer | null;
}
export interface RegfAnswer {
  readonly counted_last_7: { readonly borrower: number; readonly co_borrower: number };
  readonly over_cap: readonly { readonly on: string; readonly person: Person }[];
}
export interface EiAnswer {
  readonly regx_days_delinquent: number;
  readonly windows: readonly WindowAnswer[];
  readonly cycles: readonly CycleAnswer[];
  readonly bk_notice: BkNoticeAnswer | null;
  readonly episodes: readonly EpisodeAnswer[];
  readonly regf: RegfAnswer | null;
}

/* ── the loan's counter ───────────────────────────────────────────────────── */

/** The installments as the boarding FIFO holds them: `satisfied_on` is the day credited. */
const appliedOf = (task: EiTask): AppliedInstallment[] =>
  task.installments.map((i) => ({
    due_date: i.due_date,
    amount_cents: 0n,
    satisfied_on: i.credited_as_of,
    paid_cents: 0n,
  }));

/** §1024.31's counter on a day (boarding/delinquency.ts, ported for pmi-termination). */
export const regxDaysOn = (task: EiTask, day: PlainDate): number =>
  regxDaysDelinquent(appliedOf(task), day);
export const earliestUnpaidOn = (task: EiTask, day: PlainDate): PlainDate | null =>
  earliestUnpaidDueDate(appliedOf(task), day);

/** The installments a window opens for: unpaid on D + 1 (credited after D, or never), with D + 1 on or before the day. */
export const windowDues = (task: EiTask): PlainDate[] =>
  task.installments
    .filter(
      (i) =>
        addDays(i.due_date, 1) <= task.as_of &&
        (i.credited_as_of === null || i.credited_as_of > i.due_date),
    )
    .map((i) => i.due_date);

/* ── the fold ─────────────────────────────────────────────────────────────── */

export interface Folded {
  readonly window: Window;
  /** The notice that took this leg was provided after its deadline (`noticeProvided`'s `provided_late`). */
  readonly notice_late: boolean;
  /** A breached live leg met by a live contact after its deadline: the clock is satisfied late (kernel/timers/engine.ts:172). */
  readonly live_late: boolean;
}

const cycleOf = (n: { provided_on: PlainDate; variant: Variant }, k: number): Cycle =>
  noticeCycle(n.provided_on, n.variant, `notice-${k}`);

/** The windows, folded day by day to the end of `as_of`. */
export function foldWindows(task: EiTask): Folded[] {
  const dues = windowDues(task);
  if (dues.length === 0) return [];
  const pr = task.loan.principal_residence;
  const cease = task.loan.debt_collector ? task.fdcpa_cease_on : null;
  const bk = task.bankruptcy;
  const windows: Window[] = [];
  const late = new Map<PlainDate, boolean>();
  const byDue = new Map<PlainDate, Window>();
  for (let t = addDays(dues[0]!, 1); t <= task.as_of; t = addDays(t, 1)) {
    sweep(windows, t);
    // 11.1 rule 1: the 00:05 counter opens window(D) on D + 1, with the overlays standing before today.
    for (const d of dues) {
      if (addDays(d, 1) !== t) continue;
      const before = task.notices.map((n, k) => ({ n, k })).filter(({ n }) => n.provided_on < t);
      const last = before[before.length - 1];
      const w = openWindow(d, {
        principal_residence: pr,
        active_cycle: last ? cycleOf(last.n, last.k) : null,
        bankruptcy:
          bk && bk.petition_on < t
            ? bk.discharged_on !== null && bk.discharged_on < t
              ? "discharged"
              : "active"
            : "none",
        fdcpa_cease: cease !== null && cease < t,
        options_available: true,
      });
      windows.push(w);
      byDue.set(d, w);
    }
    for (const i of task.installments) {
      const w = byDue.get(i.due_date);
      if (w && i.credited_as_of === t) installmentPaid(w, t);
    }
    if (bk && bk.petition_on === t)
      applyBankruptcyPetition(windows, {
        fdcpa_cease: cease !== null && cease <= t,
        options_available: true,
      });
    if (cease === t) applyFdcpaCease(windows, { options_available: true });
    for (const c of task.contacts)
      if (c.on === t && isLiveContact(c)) applyContact(windows, t, "live", c.direction);
    task.notices.forEach((n, k) => {
      if (n.provided_on !== t) return;
      const cycle = cycleOf(n, k);
      // Every leg breached, or waiting on the bankruptcy notice, takes it (noticeProvided's own guard).
      for (const w of windows) {
        if (w.notice !== "breached" && w.notice !== "bk_modified_required") continue;
        late.set(w.due_date, noticeProvided(w, t, cycle.id, n.variant).provided_late);
      }
      // The oldest open leg takes it on time; every other open leg is inside the cycle it starts.
      const first = windows.find((w) => w.notice === "open");
      if (first)
        late.set(first.due_date, noticeProvided(first, t, cycle.id, n.variant).provided_late);
      for (const w of windows) {
        if (w.notice !== "open" || cycle.cycle_end_at < w.notice_due_at) continue;
        w.notice = "satisfied_by_prior_180";
        w.covering_cycle_id = cycle.id;
      }
    });
  }
  return windows.map((w) => ({
    window: w,
    notice_late: late.get(w.due_date) === true,
    live_late:
      w.live === "breached" &&
      task.contacts.some((c) => isLiveContact(c) && c.on > w.live_due_at && c.on <= task.as_of),
  }));
}

/* ── the cycles ───────────────────────────────────────────────────────────── */

export function cyclesOf(task: EiTask): CycleAnswer[] {
  const ns = task.notices.filter((n) => n.provided_on <= task.as_of);
  return ns.map((n, k): CycleAnswer => {
    const c = cycleOf(n, k);
    const next = ns[k + 1];
    const base = { provided_on: n.provided_on, cycle_end: c.cycle_end_at };
    if (next && next.provided_on < c.cycle_end_at)
      return { ...base, outcome: "superseded", next_required_by: null, repeat: null };
    if (task.as_of < c.cycle_end_at)
      return { ...base, outcome: "running", next_required_by: null, repeat: null };
    // 11.2 rule 3: the nightly review on cycle_end_at, with the counter as it stands that day.
    const r = cycleEndReview(c, {
      today: c.cycle_end_at,
      regx_days_delinquent: regxDaysOn(task, c.cycle_end_at),
      earliest_unpaid_due: earliestUnpaidOn(task, c.cycle_end_at),
    });
    if (!r.repeat_required)
      return {
        ...base,
        outcome: "not_required",
        next_required_by: r.next_required_by,
        repeat: null,
      };
    return {
      ...base,
      outcome: "repeat_required",
      next_required_by: r.next_required_by,
      repeat: next
        ? next.provided_on === c.cycle_end_at
          ? "sent"
          : "late"
        : task.as_of > c.cycle_end_at
          ? "breached"
          : "open",
    };
  });
}

/* ── the bankruptcy notice ────────────────────────────────────────────────── */

/**
 * §1024.39(c)(1)(iii): one modified notice per case, 45 days after the
 * petition when the borrower is delinquent then (`bkModifiedNoticeDue`), or
 * 45 days after the first due date missed during the case (the counter's
 * `first_delinquency_in_case` anchor, ops.ts:81, as the 11.2 timer row
 * anchors it); none when a cease stood at the petition (windows.ts:126).
 */
export function bkNoticeOf(task: EiTask): BkNoticeAnswer | null {
  const bk = task.bankruptcy;
  if (!bk || !task.loan.principal_residence) return null;
  const p = bk.petition_on;
  const cease = task.loan.debt_collector ? task.fdcpa_cease_on : null;
  if (cease !== null && cease < p) return { due: null, status: "exempt" };
  let due: PlainDate | null;
  if (regxDaysOn(task, p) >= 1) due = bkModifiedNoticeDue(p, false);
  else {
    const first = windowDues(task).find((d) => {
      const opened = addDays(d, 1);
      return opened > p && (bk.discharged_on === null || bk.discharged_on > opened);
    });
    due = first ? addDays(first, BK_NOTICE_DAYS) : null;
  }
  if (due === null) return { due: null, status: "not_yet_required" };
  const sent = task.notices.find((n) => n.variant === "bk" && n.provided_on >= p);
  return {
    due,
    status: sent
      ? sent.provided_on <= due
        ? "sent"
        : "late"
      : task.as_of > due
        ? "breached"
        : "open",
  };
}

/* ── delinquencies: the assignment and the outbound cadence ──────────────── */

/** Each run of days with the counter at 1 or more: its day 1, and the day it ended (the counter back at 0). */
export function delinquencies(task: EiTask): { day_1: PlainDate; ended_on: PlainDate | null }[] {
  const out: { day_1: PlainDate; ended_on: PlainDate | null }[] = [];
  if (task.installments.length === 0) return out;
  let behind = false;
  for (let t = task.installments[0]!.due_date; t <= task.as_of; t = addDays(t, 1)) {
    const now = regxDaysOn(task, t) >= 1;
    if (now && !behind) out.push({ day_1: t, ended_on: null });
    if (!now && behind) out[out.length - 1] = { ...out[out.length - 1]!, ended_on: t };
    behind = now;
  }
  return out;
}

export function continuityOf(
  task: EiTask,
  e: { day_1: PlainDate; ended_on: PlainDate | null },
): ContinuityAnswer {
  if (!task.loan.principal_residence)
    return { assign_by: null, basis: null, status: "not_required" };
  const inside = (d: PlainDate) => d >= e.day_1 && (e.ended_on === null || d < e.ended_on);
  const notice = task.notices.find((n) => inside(n.provided_on))?.provided_on ?? null;
  const { assign_by, basis } = assignmentBy(addDays(e.day_1, -1), notice);
  if (e.ended_on !== null && e.ended_on <= assign_by)
    return { assign_by, basis, status: "not_due" };
  const a = task.assignments.find((d) => inside(d) && d <= task.as_of);
  const status = a
    ? a <= assign_by
      ? "met"
      : "late"
    : task.as_of > assign_by
      ? "breached"
      : "open";
  return { assign_by, basis, status };
}

export function outboundOf(
  task: EiTask,
  e: { day_1: PlainDate; ended_on: PlainDate | null },
): OutboundAnswer | null {
  const due = addDays(e.day_1, -1);
  const opens = addDays(due, CADENCE_OPENS_DAY);
  const petition = task.bankruptcy?.petition_on ?? null;
  const cease = task.loan.debt_collector ? task.fdcpa_cease_on : null;
  // suspended{bankruptcy} and suspended{cease_request} hold for good in v1 (plan.ts:179-181).
  if ((petition !== null && petition < e.day_1) || (cease !== null && cease < e.day_1)) return null;
  const stops = [e.ended_on, petition, cease].filter((d): d is PlainDate => d !== null);
  const close = stops.length ? stops.reduce((a, b) => (a < b ? a : b)) : null;
  if (task.as_of < opens || (close !== null && close <= opens)) return null;
  const start = shiftOpen(addDays(due, OUTBOUND_START_DAYS));
  const attempts = task.contacts.filter(
    (c) =>
      isOutboundAttempt(c) &&
      c.on >= opens &&
      c.on <= task.as_of &&
      (close === null || c.on < close),
  );
  let x = start;
  const missed: PlainDate[] = [];
  for (const a of attempts) {
    if (a.on > x) missed.push(x);
    x = shiftOpen(addDays(a.on, OUTBOUND_EVERY_DAYS));
  }
  if (close !== null) {
    if (close > x) missed.push(x);
    return { start_due: start, missed, next_due: null };
  }
  if (task.as_of > x) missed.push(x);
  return { start_due: start, missed, next_due: x };
}

/* ── Reg F ────────────────────────────────────────────────────────────────── */

/**
 * `countedCalls` (ops.ts:224-226) over the seven days ending on a call's day
 * (`a.at_ms > atMs - 7 * DAY`, the evaluator's `< 7 days`, evaluator-kit.ts:24,
 * with every call on its day), and `regfDialCheck`'s cap of 7 (ops.ts:231).
 */
export function regfOf(task: EiTask): RegfAnswer | null {
  if (!task.loan.debt_collector) return null;
  const counted = task.contacts.filter((c) => isCountedCall(c) && c.on <= task.as_of);
  const since = (day: PlainDate) => addDays(day, -REGF_DAYS);
  const last7 = (p: Person) =>
    counted.filter((c) => c.person === p && c.on > since(task.as_of)).length;
  const over: { on: string; person: Person }[] = [];
  counted.forEach((c, k) => {
    const n = counted
      .slice(0, k + 1)
      .filter((x) => x.person === c.person && x.on > since(c.on)).length;
    if (n > REGF_CAP) over.push({ on: c.on, person: c.person });
  });
  return {
    counted_last_7: { borrower: last7("borrower"), co_borrower: last7("co_borrower") },
    // In date order, the borrower's calls on a day before the co-borrower's: the parser's order.
    over_cap: [...over].sort((a, b) =>
      a.on !== b.on
        ? a.on < b.on
          ? -1
          : 1
        : a.person < b.person
          ? -1
          : a.person > b.person
            ? 1
            : 0,
    ),
  };
}

/* ── the expected answer ──────────────────────────────────────────────────── */

export function expectedEi(task: EiTask): EiAnswer {
  return {
    regx_days_delinquent: regxDaysOn(task, task.as_of),
    windows: foldWindows(task).map(({ window: w, live_late, notice_late }) => ({
      due_date: w.due_date,
      live_due: w.live_due_at,
      live: w.live as WindowAnswer["live"],
      live_late,
      notice_due: w.notice_due_at,
      notice: w.notice as WindowAnswer["notice"],
      notice_late,
    })),
    cycles: cyclesOf(task),
    bk_notice: bkNoticeOf(task),
    episodes: delinquencies(task).map((e) => ({
      day_1: e.day_1,
      ended_on: e.ended_on,
      continuity: continuityOf(task, e),
      outbound: outboundOf(task, e),
    })),
    regf: regfOf(task),
  };
}

/** Breached when any clock was missed, owed when one is still running, clear when none is. */
export function eiVerdictOf(a: EiAnswer): "breached" | "owed" | "clear" {
  const breached =
    a.windows.some((w) => w.live === "breached" || w.notice === "breached" || w.notice_late) ||
    a.cycles.some((c) => c.repeat === "late" || c.repeat === "breached") ||
    (a.bk_notice !== null &&
      (a.bk_notice.status === "late" || a.bk_notice.status === "breached")) ||
    a.episodes.some(
      (e) =>
        e.continuity.status === "late" ||
        e.continuity.status === "breached" ||
        (e.outbound !== null && e.outbound.missed.length > 0),
    ) ||
    (a.regf !== null && a.regf.over_cap.length > 0);
  if (breached) return "breached";
  const owed =
    a.windows.some(
      (w) => w.live === "open" || w.notice === "open" || w.notice === "bk_modified_required",
    ) ||
    a.cycles.some((c) => c.repeat === "open") ||
    a.bk_notice?.status === "open" ||
    a.episodes.some(
      (e) =>
        e.continuity.status === "open" || (e.outbound !== null && e.outbound.next_due !== null),
    );
  return owed ? "owed" : "clear";
}
export const eiVerdict = (task: EiTask): string => eiVerdictOf(expectedEi(task));

/* ── grading ──────────────────────────────────────────────────────────────
 * A pass is every field right. Each window is two fields, its live leg and
 * its notice leg, each with its deadline, its status and whether it was met
 * late; each notice's cycle is one; the bankruptcy notice is one; each
 * delinquency is two, its assignment and its outbound cadence; Reg F is one;
 * and the counter is one. The lists of windows and of delinquencies are a
 * field each. A window, a cycle or a delinquency answered that the loan does
 * not have is a field of its own, so hedging is never cheaper than
 * committing. A section neither the engine nor the answer has (the
 * bankruptcy notice, Reg F, a delinquency's cadence) is not a field: a null
 * that is right by default earns nothing.
 */

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);

const liveOf = (w: WindowAnswer) => ({
  live_due: w.live_due,
  live: w.live,
  live_late: w.live_late,
});
const noticeOf = (w: WindowAnswer) => ({
  notice_due: w.notice_due,
  notice: w.notice,
  notice_late: w.notice_late,
});
const cycleBody = (c: CycleAnswer) => ({
  cycle_end: c.cycle_end,
  outcome: c.outcome,
  next_required_by: c.next_required_by,
  repeat: c.repeat,
});

export function gradeEiAgainst(want: EiAnswer, answer: EiAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const check = (field: string, expected: unknown, got: unknown) => {
    const e = canon(expected);
    const g = answer ? canon(got) : null;
    fields.push({ field, expected: e, got: g, ok: g === e });
  };
  const extra = (field: string, got: unknown) =>
    fields.push({ field, expected: "absent", got: canon(got), ok: false });

  check("regx_days_delinquent", want.regx_days_delinquent, answer?.regx_days_delinquent);
  check(
    "windows",
    want.windows.map((w) => w.due_date),
    answer?.windows.map((w) => w.due_date),
  );
  for (const w of want.windows) {
    const got = answer?.windows.find((x) => x.due_date === w.due_date);
    check(`window ${w.due_date} live`, liveOf(w), got ? liveOf(got) : null);
    check(`window ${w.due_date} notice`, noticeOf(w), got ? noticeOf(got) : null);
  }
  for (const x of answer?.windows ?? [])
    if (!want.windows.some((w) => w.due_date === x.due_date)) extra(`window ${x.due_date}`, x);

  for (const c of want.cycles) {
    const got = answer?.cycles.find((x) => x.provided_on === c.provided_on);
    check(`cycle ${c.provided_on}`, cycleBody(c), got ? cycleBody(got) : null);
  }
  for (const x of answer?.cycles ?? [])
    if (!want.cycles.some((c) => c.provided_on === x.provided_on))
      extra(`cycle ${x.provided_on}`, x);

  if (want.bk_notice !== null || (answer?.bk_notice ?? null) !== null)
    check("bk_notice", want.bk_notice, answer?.bk_notice ?? null);

  check(
    "episodes",
    want.episodes.map((e) => ({ day_1: e.day_1, ended_on: e.ended_on })),
    answer?.episodes.map((e) => ({ day_1: e.day_1, ended_on: e.ended_on })),
  );
  for (const e of want.episodes) {
    const got = answer?.episodes.find((x) => x.day_1 === e.day_1);
    check(`episode ${e.day_1} continuity`, e.continuity, got?.continuity ?? null);
    if (e.outbound !== null || (got?.outbound ?? null) !== null)
      check(`episode ${e.day_1} outbound`, e.outbound, got?.outbound ?? null);
  }
  for (const x of answer?.episodes ?? [])
    if (!want.episodes.some((e) => e.day_1 === x.day_1)) extra(`episode ${x.day_1}`, x);

  if (want.regf !== null || (answer?.regf ?? null) !== null)
    check("regf", want.regf, answer?.regf ?? null);

  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeEi = (task: EiTask, answer: EiAnswer | null): Grade =>
  gradeEiAgainst(expectedEi(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

class Bounce extends Error {}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function exactly(v: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) throw new Bounce(`${what} must be an object`);
  const extraKeys = Object.keys(v).filter((k) => !keys.includes(k));
  if (extraKeys.length)
    throw new Bounce(`${what} has ${extraKeys.join(", ")}, which the schema does not name`);
  const missing = keys.filter((k) => !(k in v));
  if (missing.length) throw new Bounce(`${what} needs ${missing.join(", ")}`);
  return v;
}
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Bounce(`${what} must be a list`);
  return v;
};
const whole = (v: unknown, what: string, lo = 0, hi = 100_000): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new Bounce(`${what} must be a whole number from ${lo} to ${hi}`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new Bounce(`${what} must be true or false`);
  return v;
};
const date = (v: unknown, what: string): string => {
  if (!isDate(v)) throw new Bounce(`${what} must be a date, YYYY-MM-DD`);
  return v;
};
const dateOrNull = (v: unknown, what: string): string | null => (v === null ? null : date(v, what));
function oneOf<T extends string>(v: unknown, what: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v))
    throw new Bounce(`${what} must be one of ${values.join(", ")}`);
  return v as T;
}
const distinct = (keys: readonly string[], what: string) => {
  if (new Set(keys).size !== keys.length) throw new Bounce(`${what} lists one twice`);
};

export const EI_ANSWER_KEYS = [
  "regx_days_delinquent",
  "windows",
  "cycles",
  "bk_notice",
  "episodes",
  "regf",
] as const;
const WINDOW_KEYS = [
  "due_date",
  "live_due",
  "live",
  "live_late",
  "notice_due",
  "notice",
  "notice_late",
];
const CYCLE_KEYS = ["provided_on", "cycle_end", "outcome", "next_required_by", "repeat"];
const EPISODE_KEYS = ["day_1", "ended_on", "continuity", "outbound"];

function windowOf(v: unknown, k: number): WindowAnswer {
  const what = `windows[${k}]`;
  const w = exactly(v, what, WINDOW_KEYS);
  const live = oneOf(w["live"], `${what}.live`, LIVE_STATUSES);
  const notice = oneOf(w["notice"], `${what}.notice`, NOTICE_STATUSES);
  const liveLate = bool(w["live_late"], `${what}.live_late`);
  const noticeLate = bool(w["notice_late"], `${what}.notice_late`);
  if (liveLate && live !== "breached")
    throw new Bounce(`${what}.live_late is true only on a breached live leg`);
  if (noticeLate && notice !== "sent")
    throw new Bounce(`${what}.notice_late is true only on a notice leg that was sent`);
  return {
    due_date: date(w["due_date"], `${what}.due_date`),
    live_due: date(w["live_due"], `${what}.live_due`),
    live,
    live_late: liveLate,
    notice_due: date(w["notice_due"], `${what}.notice_due`),
    notice,
    notice_late: noticeLate,
  };
}

function cycleOfAnswer(v: unknown, k: number): CycleAnswer {
  const what = `cycles[${k}]`;
  const c = exactly(v, what, CYCLE_KEYS);
  const outcome = oneOf(c["outcome"], `${what}.outcome`, CYCLE_OUTCOMES);
  const next = dateOrNull(c["next_required_by"], `${what}.next_required_by`);
  const repeat =
    c["repeat"] === null ? null : oneOf(c["repeat"], `${what}.repeat`, REPEAT_STATUSES);
  if ((repeat !== null) !== (outcome === "repeat_required"))
    throw new Bounce(`${what}.repeat is given when, and only when, the outcome is repeat_required`);
  if ((outcome === "superseded" || outcome === "running") && next !== null)
    throw new Bounce(`${what}.next_required_by is null for a cycle that was never reviewed`);
  if (outcome === "repeat_required" && next === null)
    throw new Bounce(`${what}.next_required_by is the repeat's deadline when one is required`);
  return {
    provided_on: date(c["provided_on"], `${what}.provided_on`),
    cycle_end: date(c["cycle_end"], `${what}.cycle_end`),
    outcome,
    next_required_by: next,
    repeat,
  };
}

function episodeOf(v: unknown, k: number): EpisodeAnswer {
  const what = `episodes[${k}]`;
  const e = exactly(v, what, EPISODE_KEYS);
  const c = exactly(e["continuity"], `${what}.continuity`, ["assign_by", "basis", "status"]);
  const status = oneOf(c["status"], `${what}.continuity.status`, CONTINUITY_STATUSES);
  const assignBy = dateOrNull(c["assign_by"], `${what}.continuity.assign_by`);
  const basis =
    c["basis"] === null
      ? null
      : oneOf(c["basis"], `${what}.continuity.basis`, ["day_45", "ei_notice"] as const);
  if (
    (status === "not_required") !== (assignBy === null) ||
    (assignBy === null) !== (basis === null)
  )
    throw new Bounce(
      `${what}.continuity has assign_by and basis exactly when assignment is required`,
    );
  let outbound: OutboundAnswer | null = null;
  if (e["outbound"] !== null) {
    const o = exactly(e["outbound"], `${what}.outbound`, ["start_due", "missed", "next_due"]);
    const missed = list(o["missed"], `${what}.outbound.missed`).map((d, j) =>
      date(d, `${what}.outbound.missed[${j}]`),
    );
    distinct(missed, `${what}.outbound.missed`);
    outbound = {
      start_due: date(o["start_due"], `${what}.outbound.start_due`),
      // The order carries nothing: put in date order, not graded.
      missed: [...missed].sort(),
      next_due: dateOrNull(o["next_due"], `${what}.outbound.next_due`),
    };
  }
  return {
    day_1: date(e["day_1"], `${what}.day_1`),
    ended_on: dateOrNull(e["ended_on"], `${what}.ended_on`),
    continuity: { assign_by: assignBy, basis, status },
    outbound,
  };
}

function regfOfAnswer(v: unknown): RegfAnswer | null {
  if (v === null) return null;
  const r = exactly(v, "regf", ["counted_last_7", "over_cap"]);
  const n = exactly(r["counted_last_7"], "regf.counted_last_7", ["borrower", "co_borrower"]);
  const over = list(r["over_cap"], "regf.over_cap").map((x, j) => {
    const o = exactly(x, `regf.over_cap[${j}]`, ["on", "person"]);
    return {
      on: date(o["on"], `regf.over_cap[${j}].on`),
      person: oneOf(o["person"], `regf.over_cap[${j}].person`, PERSONS),
    };
  });
  return {
    counted_last_7: {
      borrower: whole(n["borrower"], "regf.counted_last_7.borrower", 0, 1000),
      co_borrower: whole(n["co_borrower"], "regf.counted_last_7.co_borrower", 0, 1000),
    },
    // In date order, a person's calls on one day together: the order carries nothing.
    over_cap: [...over].sort((a, b) =>
      a.on !== b.on
        ? a.on < b.on
          ? -1
          : 1
        : a.person < b.person
          ? -1
          : a.person > b.person
            ? 1
            : 0,
    ),
  };
}

export function parseEiSubmission(raw: unknown): Parsed<EiAnswer> {
  try {
    const s = exactly(raw, "the submission", EI_ANSWER_KEYS);
    const windows = list(s["windows"], "windows").map(windowOf);
    distinct(
      windows.map((w) => w.due_date),
      "windows",
    );
    const cycles = list(s["cycles"], "cycles").map(cycleOfAnswer);
    distinct(
      cycles.map((c) => c.provided_on),
      "cycles",
    );
    let bk: BkNoticeAnswer | null = null;
    if (s["bk_notice"] !== null) {
      const b = exactly(s["bk_notice"], "bk_notice", ["due", "status"]);
      const status = oneOf(b["status"], "bk_notice.status", BK_STATUSES);
      const due = dateOrNull(b["due"], "bk_notice.due");
      if ((due === null) !== (status === "exempt" || status === "not_yet_required"))
        throw new Bounce(
          "bk_notice.due is null exactly when the notice is exempt or not yet required",
        );
      bk = { due, status };
    }
    const episodes = list(s["episodes"], "episodes").map(episodeOf);
    distinct(
      episodes.map((e) => e.day_1),
      "episodes",
    );
    return {
      ok: true,
      answer: {
        regx_days_delinquent: whole(s["regx_days_delinquent"], "regx_days_delinquent", 0, 100_000),
        windows: [...windows].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)),
        cycles: [...cycles].sort((a, b) => (a.provided_on < b.provided_on ? -1 : 1)),
        bk_notice: bk,
        episodes: [...episodes].sort((a, b) => (a.day_1 < b.day_1 ? -1 : 1)),
        regf: regfOfAnswer(s["regf"]),
      },
    };
  } catch (e) {
    if (!(e instanceof Bounce)) throw e;
    return {
      ok: false,
      error: `${e.message}. Nothing was submitted; fix it and call submit_clocks again.`,
    };
  }
}
