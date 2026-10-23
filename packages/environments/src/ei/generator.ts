/**
 * Synthetic delinquencies, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan's history is
 * monthly installments due on the 1st, some paid on time, then a
 * delinquency: installments credited late, together, or not at all, as a
 * borrower falls behind and catches up. Around it sit the servicer's
 * contacts (the D2-2-02 cadence from day 17, some of them conversations),
 * the written notices, the assignment of personnel, and now and then a
 * bankruptcy or a debt collector's written cease. The task is then aimed, in
 * turn by index, at one edge of the clocks, and within an edge its arms are
 * taken in turn too, so each arm's share is fixed rather than drawn:
 *   - live_36: a live contact on day 36, day 37, early, or never;
 *   - overlap: one contact on the next due date, on day 36 or on day 37 of
 *     the first of three windows (11.1-T4);
 *   - paid_36: the installment credited on day 36, day 37, or early;
 *   - paid_45: credited on day 45 or day 46, with no notice;
 *   - notice_45: the notice on day 45, day 46, day 30 (covering the next
 *     window), or never;
 *   - cycle_cover: a window whose day 45 is the notice's day 180, or a day
 *     past it;
 *   - cycle_review: the cycle reviewed at day 180 at 45 days or more with
 *     the repeat on time, late or missing, under 45 days, and current;
 *   - bankruptcy: a petition while delinquent with the bankruptcy notice on
 *     time, late or missing, a petition while current, one after a cease,
 *     and a discharge;
 *   - cease: a debt collector's written cease mid-window, before the
 *     delinquency, and an fdcpa notice's 190-day cover at its edge;
 *   - investment: a property that is not the borrower's residence;
 *   - rolling: each installment paid on the next due date (11.1-T3), or
 *     before day 36;
 *   - continuity: personnel assigned on day 45 or 46, by a notice on day 30
 *     or the day after it, none, and a cure on day 45 or 46;
 *   - outbound: a gap of 7 days or 8, a deadline on a weekend or a holiday
 *     met on the next open day or the day after, and a first attempt on day
 *     36 or 37;
 *   - regf: seven counted calls in seven days, eight, nine, and eight over
 *     eight days, among calls that do not count.
 *
 * What v1 leaves out is in docs/environments.md. `eiInScope` keeps a loan
 * only when nothing in it sits where the engine, the servicing app around
 * it, or the spec is in doubt. A loan is then kept only once the reference,
 * working through the tools, lands exactly where the grader does; the tests
 * hold both to zero misses on unfiltered draws.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  plainDate,
  servicer,
  startOfMonth,
  type PlainDate,
} from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  CADENCE_OPENS_DAY,
  cyclesOf,
  delinquencies,
  earliestUnpaidOn,
  expectedEi,
  gradeEiAgainst,
  isCountedCall,
  isLiveContact,
  isOutboundAttempt,
  parseEiSubmission,
  regxDaysOn,
  shiftOpen,
  windowDues,
} from "./grader.js";
import { cycleEndReview, nextNoticeDue, noticeCycle, type Variant } from "./ported/windows.js";
import { eiSteps } from "./reference.js";
import {
  EI_ENVIRONMENT_NAME,
  EI_ENVIRONMENT_VERSION,
  eiPayload,
  type Channel,
  type Contact,
  type EiTask,
  type Person,
} from "./task.js";
import { executeEiTool } from "./tools.js";

export const eiTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${EI_ENVIRONMENT_NAME}/${EI_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const EI_EDGES = [
  "live_36",
  "overlap",
  "paid_36",
  "paid_45",
  "notice_45",
  "cycle_cover",
  "cycle_review",
  "bankruptcy",
  "cease",
  "investment",
  "rolling",
  "continuity",
  "outbound",
  "regf",
] as const;
export type EiEdge = (typeof EI_EDGES)[number];
export const eiEdgeOf = (index: number): EiEdge => EI_EDGES[index % EI_EDGES.length]!;
/** An edge's arm: taken in turn by index, so each arm's share of the edge is fixed. */
export const eiArmOf = (index: number, arms: number): number =>
  Math.floor(index / EI_EDGES.length) % arms;

/* ── the draft a loan is built in ─────────────────────────────────────────── */

type Cadence = "steady" | "sparse" | "stop" | "none";

/** A loan under construction, with the switches the background reads. */
class Draft {
  pr = true;
  dc = false;
  dues: PlainDate[] = [];
  credited: (PlainDate | null)[] = [];
  contacts: Contact[] = [];
  notices: { provided_on: PlainDate; variant: Variant }[] = [];
  assignments: PlainDate[] = [];
  bankruptcy: { petition_on: PlainDate; discharged_on: PlainDate | null } | null = null;
  cease: PlainDate | null = null;
  asOf: PlainDate = plainDate("2026-01-01");
  /** Days carrying a credit, a live contact, a notice, the petition, the discharge or the cease. */
  readonly taken = new Set<PlainDate>();
  /** Live contacts the edge placed, made outbound inside a cadence and inbound outside one. */
  readonly live: { on: PlainDate; person: Person }[] = [];
  /** Windows whose live leg the edge decides: the background puts no live contact inside them. */
  readonly protectLive = new Set<PlainDate>();
  cadence: Cadence = "steady";
  backgroundLive = 0.85;
  backgroundNotices = true;
  backgroundAssignments = true;
  /** Outbound attempts the edge placed itself; the background adds none to that delinquency. */
  readonly attempts = new Map<PlainDate, Contact[]>();

  start(first: PlainDate, asOf: PlainDate, onTime: number): void {
    this.asOf = asOf;
    this.dues = [];
    for (let d = first; d <= asOf; d = addMonths(d, 1)) this.dues.push(d);
    this.credited = this.dues.map(() => null);
    for (let k = 0; k < onTime && k < this.dues.length; k++)
      this.credit(k, addDays(this.dues[k]!, -((k * 3) % 6)));
  }
  /** Never on the day after the installment's own due date (see `eiScopeIssues`). */
  credit(k: number, on: PlainDate): void {
    const at = on === addDays(this.dues[k]!, 1) ? addDays(on, 1) : on;
    this.credited[k] = at;
    this.taken.add(at);
  }
  /** The next `n` unpaid installments credited on `on`, oldest first. */
  pay(on: PlainDate, n: number): void {
    const ks: number[] = [];
    for (let k = 0; k < this.dues.length && ks.length < n; k++)
      if (this.credited[k] === null) ks.push(k);
    let at = on;
    while (ks.some((k) => at === addDays(this.dues[k]!, 1))) at = addDays(at, 1);
    for (const k of ks) this.credit(k, at);
  }
  /** Installments credited on their due date or a few days before, from index k on. */
  onTimeFrom(k: number, r: Rng): void {
    for (let j = k; j < this.dues.length; j++)
      if (this.credited[j] === null) this.credit(j, addDays(this.dues[j]!, -r.int(0, 5)));
  }
  index(due: PlainDate): number {
    return this.dues.indexOf(due);
  }
  /** The nearest day on or after `day` that carries no exclusive event (and is no 2nd, when asked). */
  free(day: PlainDate, avoidSecond = true): PlainDate {
    let d = day;
    while (this.taken.has(d) || (avoidSecond && parts(d).d === 2)) d = addDays(d, 1);
    return d;
  }
  liveOn(on: PlainDate, r: Rng): void {
    this.live.push({ on, person: r.chance(0.85) ? "borrower" : "co_borrower" });
    this.taken.add(on);
  }
  notice(on: PlainDate, variant: Variant): void {
    this.notices.push({ provided_on: on, variant });
    this.notices.sort((a, b) => (a.provided_on < b.provided_on ? -1 : 1));
    this.taken.add(on);
  }
  task(id: string, split: Split, suiteSeed: number, index: number): EiTask {
    return {
      id,
      split,
      suite_seed: suiteSeed,
      index,
      as_of: this.asOf,
      loan: { principal_residence: this.pr, debt_collector: this.dc },
      installments: this.dues.map((d, k) => ({ due_date: d, credited_as_of: this.credited[k]! })),
      contacts: [...this.contacts].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)),
      notices: [...this.notices],
      assignments: [...this.assignments].sort(),
      bankruptcy: this.bankruptcy,
      fdcpa_cease_on: this.dc ? this.cease : null,
    };
  }
}

const FIRST_MONTH = plainDate("2025-03-01");
const MONTHS_DRAWN = 40;
const monthIn = (r: Rng, lo = 0, hi = MONTHS_DRAWN - 1): PlainDate =>
  addMonths(FIRST_MONTH, r.int(lo, hi));

const call = (
  on: PlainDate,
  person: Person,
  channel: Channel,
  outcome: Contact["outcome"],
  callback = false,
): Contact => ({
  on,
  direction: channel === "phone" ? "inbound" : "outbound",
  channel,
  person,
  outcome,
  callback_requested: callback,
});

/** An ordinary attempt: mostly calls, unanswered or a voicemail; now and then a text, an email or a dropped line. */
function attemptOn(r: Rng, on: PlainDate): Contact {
  const person: Person = r.chance(0.85) ? "borrower" : "co_borrower";
  const kind = r.weighted([
    ["ai_voice", 50],
    ["human_voice", 25],
    ["sms", 12],
    ["email", 8],
    ["busy", 5],
  ] as const);
  if (kind === "sms" || kind === "email") return call(on, person, kind, "sent");
  if (kind === "busy")
    return call(on, person, r.chance(0.5) ? "ai_voice" : "human_voice", "busy_or_failed");
  return call(on, person, kind, r.chance(0.6) ? "no_answer" : "voicemail");
}

/* ── the edges ───────────────────────────────────────────────────────────── */

type Build = (r: Rng, arm: number, d: Draft) => void;

/** A first missed due date with `onTime` paid installments before it, and the picture `days` after it. */
function begin(
  r: Rng,
  d: Draft,
  days: number,
  onTime = r.int(0, 2),
  lo = 2,
  hi = MONTHS_DRAWN - 6,
): PlainDate {
  const d0 = monthIn(r, lo, hi);
  d.start(addMonths(d0, -onTime), addDays(d0, days), onTime);
  return d0;
}

const EDGES: Record<EiEdge, { arms: number; build: Build }> = {
  live_36: {
    arms: 4,
    build: (r, arm, d) => {
      const d0 = begin(r, d, r.int(46, 80));
      d.protectLive.add(d0);
      const day = [addDays(d0, 36), addDays(d0, 37), addDays(d0, r.int(8, 30)), null][arm];
      if (day) d.liveOn(day, r);
      if (r.chance(0.4)) {
        const on = d.free(addDays(d0, r.int(48, 75)), false);
        if (on <= d.asOf) d.pay(on, 2);
      }
    },
  },
  overlap: {
    arms: 3,
    build: (r, arm, d) => {
      const d0 = begin(r, d, 0);
      const d1 = addMonths(d0, 1);
      d.start(d.dues[0]!, addDays(addMonths(d0, 2), r.int(5, 40)), d.index(d0));
      d.protectLive.add(d0);
      d.protectLive.add(d1);
      d.protectLive.add(addMonths(d0, 2));
      d.liveOn([d1, addDays(d0, 36), addDays(d0, 37)][arm]!, r);
    },
  },
  paid_36: {
    arms: 3,
    build: (r, arm, d) => {
      const d0 = begin(r, d, 0);
      const paid = addDays(d0, [36, 37, r.int(3, 30)][arm]!);
      d.start(d.dues[0]!, addDays(paid, r.int(4, 40)), d.index(d0));
      d.protectLive.add(d0);
      d.credit(d.index(d0), paid);
      // The next installment: on time, late, or with the catch-up.
      const k = d.index(d0) + 1;
      if (k < d.dues.length) {
        const late = r.weighted([
          ["with", 3],
          ["after", 3],
          ["unpaid", 2],
        ] as const);
        if (late === "with" && paid > d.dues[k]!) d.credit(k, paid);
        else if (late === "after") {
          const on = d.free(addDays(paid, r.int(3, 25)), false);
          if (on <= d.asOf) d.credit(k, on);
        }
      }
      if (r.chance(0.5)) d.backgroundNotices = false;
    },
  },
  paid_45: {
    arms: 2,
    build: (r, arm, d) => {
      const d0 = begin(r, d, 0);
      const paid = addDays(d0, 45 + arm);
      d.start(d.dues[0]!, addDays(paid, r.int(1, 30)), d.index(d0));
      d.credit(d.index(d0), paid);
      d.backgroundNotices = false;
      const k = d.index(d0) + 1;
      if (k < d.dues.length && r.chance(0.5)) d.credit(k, paid);
    },
  },
  notice_45: {
    arms: 4,
    build: (r, arm, d) => {
      const d0 = begin(r, d, 0);
      d.backgroundNotices = false;
      const day = [45, 46, 30, null][arm] ?? null;
      const on = day === null ? null : addDays(d0, day);
      d.start(d.dues[0]!, addDays(on ?? addDays(d0, 46), r.int(1, 40)), d.index(d0));
      if (on && parts(on).d !== 2 && !d.taken.has(on)) d.notice(on, "standard");
      else if (on) d.notice(d.free(on), "standard");
    },
  },
  cycle_cover: {
    arms: 2,
    build: (r, arm, d) => {
      // A window D whose day 45 is the notice's day 180 (covered) or a day past it (not).
      let dk = monthIn(r, 7, MONTHS_DRAWN - 1);
      let p = addDays(dk, -(135 + arm));
      while (parts(p).d === 2) {
        dk = addMonths(dk, 1);
        p = addDays(dk, -(135 + arm));
      }
      const d0 = parts(p).d >= 4 ? startOfMonth(p) : addMonths(startOfMonth(p), -1);
      const onTime = r.int(0, 1);
      d.start(addMonths(d0, -onTime), addDays(dk, r.int(1, 43)), onTime);
      d.notice(p, "standard");
      d.backgroundNotices = false;
      d.cadence = "stop";
      // A catch-up of two now and then, never to current.
      if (r.chance(0.4)) {
        const on = d.free(addDays(addMonths(d0, 2), r.int(3, 20)), false);
        if (on < dk) d.pay(on, 2);
      }
    },
  },
  cycle_review: {
    arms: 5,
    build: (r, arm, d) => {
      const d0 = monthIn(r, 2, MONTHS_DRAWN - 9);
      let notice = addDays(d0, r.int(30, 44));
      while (parts(notice).d === 2 || parts(addDays(notice, 180)).d === 2)
        notice = addDays(notice, 1);
      const end = addDays(notice, 180);
      const onTime = r.int(0, 1);
      // The repeat a day or more late, and the picture drawn after it.
      let late = addDays(end, r.int(1, 15));
      while (parts(late).d === 2) late = addDays(late, 1);
      // With no repeat, the picture is drawn on the cycle's end itself half the time: still due.
      const asOf =
        arm === 1
          ? addDays(late, r.int(0, 10))
          : addDays(end, arm === 2 && r.chance(0.5) ? 0 : r.int(1, 25));
      d.start(addMonths(d0, -onTime), asOf, onTime);
      d.notice(notice, "standard");
      // The review day carries no credit: the counter is read at 00:05.
      d.taken.add(end);
      d.backgroundNotices = false;
      d.cadence = "stop";
      if (arm === 0) d.notice(end, "standard");
      if (arm === 1) d.notice(late, "standard");
      if (arm === 3) {
        // Caught up to within 45 days, still behind: E is the 1st on or before the cycle's end.
        const e = parts(end).d >= 3 ? startOfMonth(end) : addMonths(startOfMonth(end), -1);
        const on = d.free(addDays(e, r.int(1, Math.max(1, daysBetween(e, end) - 1))), false);
        if (on < end) d.pay(on, d.dues.filter((x) => x < e).length - onTime);
      }
      if (arm === 4) {
        // Current at the cycle's end: cured before the 1st of its month, then on time past it.
        const cure = d.free(addDays(startOfMonth(end), -r.int(2, 10)), false);
        d.pay(cure, d.dues.filter((x) => x < cure).length - onTime);
        for (let j = d.dues.findIndex((x) => x >= cure); j >= 0 && j < d.dues.length; j++) {
          const due = d.dues[j]!;
          if (due > addDays(end, 1) && r.chance(0.5)) break;
          const on = addDays(due, -r.int(0, 4));
          d.credit(j, on < cure ? cure : on === end ? addDays(on, -1) : on);
        }
      }
    },
  },
  bankruptcy: {
    arms: 6,
    build: (r, arm, d) => {
      // A petition while delinquent: the notice on time, late or never, or a cease before it;
      // a petition while current, the notice owed from the first due date missed; a discharge.
      const current = arm === 3;
      const d0 = monthIn(r, 2, MONTHS_DRAWN - 6);
      const onTime = r.int(1, 2);
      let p = current ? addDays(d0, -r.int(3, 25)) : addDays(d0, r.int(5, 60));
      // No petition on a 2nd; a discharge needs a day between the notice's due and the next window.
      while (parts(p).d === 2 || (arm === 5 && parts(addDays(p, 45)).d <= 2)) p = addDays(p, 1);
      const due = addDays(current ? d0 : p, 45);
      if (arm === 4) {
        d.dc = true;
        d.cease = addDays(d0, r.int(3, Math.max(3, daysBetween(d0, p) - 2)));
        if (d.cease >= p) d.cease = addDays(p, -1);
        d.taken.add(d.cease);
      }
      const sends = arm === 0 || arm === 1 || arm === 5 || (current && r.chance(0.6));
      let bkOn: PlainDate | null = null;
      if (sends) {
        const lo = current ? addDays(d0, 3) : addDays(p, 3);
        // Before a discharge, inside due's own month, so no window opens between them.
        const back = arm === 5 ? parts(due).d - 3 : 15;
        bkOn =
          arm === 1 || (current && r.chance(0.3))
            ? addDays(due, r.int(1, 25))
            : addDays(due, -r.int(0, Math.max(0, Math.min(back, daysBetween(lo, due)))));
        if (parts(bkOn).d === 2) bkOn = addDays(bkOn, bkOn > due ? 1 : -1);
      }
      // One notice serves the case, and the engine opens a later window waiting on it again
      // (windows.ts:71): the picture is drawn before the next window opens after it.
      const nextOpening = (x: PlainDate) => {
        let y = addDays(x, 1);
        while (parts(y).d !== 2) y = addDays(y, 1);
        return y;
      };
      let discharge: PlainDate | null = null;
      let asOf: PlainDate;
      if (arm === 5 && bkOn) {
        const room = daysBetween(due, nextOpening(bkOn)) - 1;
        discharge = addDays(due, room >= 1 ? r.int(1, room) : 1);
        asOf = addDays(discharge, r.int(20, 60));
      } else if (bkOn) asOf = addDays(bkOn, r.int(0, daysBetween(bkOn, nextOpening(bkOn)) - 1));
      else if (current && r.chance(0.4))
        // Current at the petition, and nothing missed in the case yet: the notice is not yet owed.
        asOf = addDays(p, r.int(1, daysBetween(p, d0)));
      else {
        // No notice yet: drawn before its due half the time, and after it.
        asOf = addDays(due, r.chance(0.5) ? -r.int(0, 10) : r.int(1, 30));
        if (asOf <= p) asOf = addDays(p, r.int(1, 10));
      }
      d.start(addMonths(d0, -onTime), asOf, onTime);
      d.bankruptcy = { petition_on: p, discharged_on: discharge };
      d.taken.add(p);
      if (discharge) d.taken.add(discharge);
      if (bkOn && bkOn <= d.asOf) d.notice(bkOn, "bk");
    },
  },
  cease: {
    arms: 3,
    build: (r, arm, d) => {
      d.dc = true;
      if (arm === 2) {
        // An fdcpa notice's 190 days reaching a window's day 45 exactly, or a day short.
        const short = r.chance(0.5) ? 1 : 0;
        let dk = monthIn(r, 7, MONTHS_DRAWN - 1);
        let p = addDays(dk, -(145 + short));
        while (parts(p).d === 2) {
          dk = addMonths(dk, 1);
          p = addDays(dk, -(145 + short));
        }
        const d0 = parts(p).d >= 12 ? startOfMonth(p) : addMonths(startOfMonth(p), -1);
        const onTime = r.int(0, 1);
        d.start(addMonths(d0, -onTime), addDays(dk, r.int(1, 40)), onTime);
        d.cease = addDays(d0, r.int(3, Math.max(3, daysBetween(d0, p) - 3)));
        d.taken.add(d.cease);
        d.notice(p, "fdcpa");
        d.backgroundNotices = false;
        d.cadence = "stop";
        return;
      }
      const d0 = begin(r, d, r.int(40, 75));
      d.cease = d.free(arm === 0 ? addDays(d0, r.int(5, 30)) : addDays(d0, -r.int(3, 40)));
      d.taken.add(d.cease);
    },
  },
  investment: {
    arms: 2,
    build: (r, arm, d) => {
      d.pr = false;
      d.dc = arm === 1;
      begin(r, d, r.int(25, 85));
      d.cadence = r.chance(0.6) ? "steady" : "sparse";
      const k = d.credited.indexOf(null);
      const on = d.free(addDays(d.dues[k]!, r.int(20, 50)), false);
      if (k >= 0 && on <= d.asOf && r.chance(0.7)) {
        // Caught up in one payment, then on time; or one installment and still behind.
        if (r.chance(0.6)) {
          d.pay(on, d.dues.filter((x) => x < on).length - k);
          for (let j = k; j < d.dues.length; j++) {
            if (d.credited[j] !== null) continue;
            const due = addDays(d.dues[j]!, -r.int(0, 4));
            d.credit(j, due < on ? on : due);
          }
        } else d.pay(on, 1);
      }
    },
  },
  rolling: {
    arms: 2,
    build: (r, arm, d) => {
      // Paid on the next due date (11.1-T3), or between day 20 and day 36: every window
      // cancelled. The picture is drawn on the last due date now and then, the borrower current.
      const months = r.int(2, 4);
      const d0 = monthIn(r, 1, MONTHS_DRAWN - 6);
      const onTime = r.int(0, 1);
      const last = addMonths(d0, months);
      const asOf = r.chance(0.5) ? last : addDays(last, r.int(1, 20));
      d.start(addMonths(d0, -onTime), asOf, onTime);
      for (let k = onTime; k < d.dues.length; k++) {
        const due = d.dues[k]!;
        const on = arm === 0 ? addMonths(due, 1) : addDays(due, r.int(20, 36));
        // FIFO: never before the installment ahead of it.
        const prev = k > 0 ? d.credited[k - 1] : null;
        const at = prev && on < prev ? prev : on;
        if (at <= d.asOf) d.credit(k, at);
      }
      d.backgroundNotices = false;
      // The windows are the payment's to cancel: no conversation reaches them first.
      d.backgroundLive = 0;
      if (r.chance(0.15)) d.pr = false;
    },
  },
  continuity: {
    arms: 7,
    build: (r, arm, d) => {
      const d0 = begin(r, d, 0);
      d.backgroundNotices = false;
      d.backgroundAssignments = false;
      const at = (n: number) => addDays(d0, n);
      if (arm === 5 || arm === 6) {
        // Cured on day 45 or 46: the installment and the next one credited together.
        const cure = at(45 + (arm - 5));
        d.start(d.dues[0]!, addDays(cure, r.int(1, 30)), d.index(d0));
        d.pay(cure, 2);
        d.onTimeFrom(d.index(d0) + 2, r);
        return;
      }
      d.start(d.dues[0]!, addDays(d0, r.int(47, 80)), d.index(d0));
      if (arm === 0) d.assignments.push(at(45));
      if (arm === 1) d.assignments.push(at(46));
      // The notice on day 45 itself: on time, and no earlier than day 45, so the deadline stays day 45.
      if (arm <= 2 && !d.taken.has(at(45)) && r.chance(0.8)) d.notice(at(45), "standard");
      if (arm === 3 || arm === 4) {
        const on = d.free(at(30));
        d.notice(on, "standard");
        d.assignments.push(arm === 3 ? on : addDays(on, 1));
      }
    },
  },
  outbound: {
    arms: 6,
    build: (r, arm, d) => {
      const d0 = begin(r, d, r.int(60, 85));
      const opens = addDays(d0, CADENCE_OPENS_DAY);
      const plan: PlainDate[] = [];
      if (arm === 4 || arm === 5) {
        // The first attempt on day 36 (rolled) or the day after.
        const start = shiftOpen(addDays(d0, 36));
        plan.push(addDays(start, arm - 4));
      } else plan.push(addDays(opens, r.int(0, 3)));
      // Steady gaps, then the aimed one.
      while (plan.length < 3) plan.push(addDays(plan[plan.length - 1]!, r.int(4, 7)));
      let a = plan[plan.length - 1]!;
      if (arm <= 1) {
        while (!servicer.isBusinessDay(addDays(a, 7))) a = addDays(a, 1);
        plan.push(a);
        plan.push(addDays(a, 7 + arm));
      } else if (arm <= 3) {
        // a + 7 on a closed day: met on the next open day, or missed by one.
        let k = 0;
        while (servicer.isBusinessDay(addDays(a, 7)) && k++ < 14) a = addDays(a, 1);
        plan.push(a);
        plan.push(addDays(shiftOpen(addDays(a, 7)), arm - 2));
      }
      // Then the steady cadence through the picture's day.
      for (
        let t = addDays(plan[plan.length - 1]!, r.int(3, 7));
        t <= d.asOf;
        t = addDays(t, r.int(4, 7))
      )
        plan.push(t);
      const attempts = [...new Set(plan)].sort().filter((x) => x <= d.asOf);
      d.attempts.set(
        d0,
        attempts.map((x) => attemptOn(r, x)),
      );
      if (r.chance(0.15)) d.pr = false;
    },
  },
  regf: {
    arms: 4,
    build: (r, arm, d) => {
      d.dc = true;
      const d0 = begin(r, d, r.int(40, 70));
      d.backgroundLive = 0;
      const opens = addDays(d0, CADENCE_OPENS_DAY);
      // A burst inside the cadence: counted calls to the borrower, among calls that do not count.
      const burst = addDays(opens, r.int(2, 10));
      const n = [7, 8, 9, 8][arm]!;
      const span = arm === 3 ? 8 : 7;
      const days = Array.from({ length: n }, (_, k) =>
        addDays(burst, Math.min(span - 1, Math.floor((k * span) / n))),
      );
      const out: Contact[] = days.map((x) =>
        call(
          x,
          "borrower",
          r.chance(0.6) ? "ai_voice" : "human_voice",
          r.chance(0.6) ? "no_answer" : "voicemail",
        ),
      );
      // What Reg F leaves out: a dropped line, a text, the co-borrower, and a call asked for.
      for (const x of [addDays(burst, 1), addDays(burst, 3)])
        out.push(call(x, "borrower", "ai_voice", "busy_or_failed"));
      out.push(call(addDays(burst, 2), "borrower", "sms", "sent"));
      out.push(call(addDays(burst, 4), "co_borrower", "ai_voice", "no_answer"));
      if (r.chance(0.5))
        out.push(call(addDays(burst, 5), "borrower", "human_voice", "no_answer", true));
      // Before and after the burst, the ordinary cadence, a week clear of it either side.
      const before: Contact[] = [];
      for (let t = addDays(burst, -7); t >= opens; t = addDays(t, -r.int(4, 7)))
        before.push(attemptOn(r, t));
      const last = addDays(burst, span - 1);
      for (let t = addDays(last, 7); t <= d.asOf; t = addDays(t, r.int(4, 7)))
        before.push(attemptOn(r, t));
      // The picture is drawn on the burst's last day now and then, so the seven days ending on it carry it.
      if (r.chance(0.4)) {
        d.asOf = last;
        d.dues = d.dues.filter((x) => x <= last);
        d.credited = d.credited.slice(0, d.dues.length);
      }
      d.attempts.set(
        d0,
        [...before, ...out].filter((c) => c.on <= d.asOf),
      );
    },
  },
};

/* ── the background ──────────────────────────────────────────────────────── */

const draftTask = (d: Draft) => d.task("draft", "train", 0, 0);

/** The cadence periods, [D + 17, close), of the draft's delinquencies. */
function periods(
  d: Draft,
): { due: PlainDate; opens: PlainDate; close: PlainDate | null; ended: PlainDate | null }[] {
  const t = draftTask(d);
  return delinquencies(t).flatMap((e) => {
    const due = addDays(e.day_1, -1);
    const opens = addDays(due, CADENCE_OPENS_DAY);
    const petition = d.bankruptcy?.petition_on ?? null;
    const cease = d.dc ? d.cease : null;
    if ((petition !== null && petition < e.day_1) || (cease !== null && cease < e.day_1)) return [];
    const stops = [e.ended_on, petition, cease].filter((x): x is PlainDate => x !== null);
    const close = stops.length ? stops.reduce((a, b) => (a < b ? a : b)) : null;
    if (close !== null && close <= opens) return [];
    return [{ due, opens, close, ended: e.ended_on }];
  });
}

function background(r: Rng, d: Draft): void {
  const t0 = draftTask(d);
  const wins = windowDues(t0);
  const protectedDay = (day: PlainDate) =>
    [...d.protectLive].some((w) => day > w && day <= addDays(w, 36));

  // The cadence and the conversations inside it.
  for (const p of periods(d)) {
    const end = p.close ? addDays(p.close, -1) : d.asOf;
    let attempts = d.attempts.get(p.due);
    if (!attempts) {
      attempts = [];
      if (d.cadence !== "none") {
        let t = addDays(p.opens, r.int(0, 3));
        let n = 0;
        const limit = d.cadence === "stop" ? r.int(2, 5) : 60;
        while (t <= end && n < limit) {
          attempts.push(attemptOn(r, t));
          n++;
          t = addDays(t, d.cadence === "sparse" ? r.int(3, 11) : r.int(4, 7));
        }
      }
    }
    attempts = attempts.filter((c) => c.on >= p.opens && c.on <= end);
    // The edge's own live contacts inside the cadence are its calls.
    for (const l of d.live)
      if (l.on >= p.opens && l.on <= end) {
        attempts = attempts.filter((c) => c.on !== l.on);
        attempts.push(
          call(l.on, l.person, r.chance(0.6) ? "ai_voice" : "human_voice", "conversation"),
        );
      }
    // A conversation in some windows the edge leaves alone.
    if (d.backgroundLive > 0)
      for (const w of wins) {
        if (w < addDays(p.due, 0) || !r.chance(d.backgroundLive)) continue;
        const from = w > addDays(p.opens, -1) ? addDays(w, 1) : p.opens;
        const to = addDays(w, 36) < end ? addDays(w, 36) : end;
        const options: Contact[] = attempts.filter(
          (c) =>
            c.on >= from &&
            c.on <= to &&
            c.on >= p.opens &&
            c.direction === "outbound" &&
            (c.channel === "ai_voice" || c.channel === "human_voice") &&
            !d.taken.has(c.on) &&
            !protectedDay(c.on),
        );
        if (options.length === 0) continue;
        const pick: Contact = r.pick(options);
        attempts = attempts.map((c): Contact =>
          c === pick ? { ...c, outcome: "conversation" } : c,
        );
        d.taken.add(pick.on);
      }
    d.contacts.push(...attempts);
  }
  // Live contacts the edge placed outside any cadence come in from the borrower.
  for (const l of d.live)
    if (!d.contacts.some((c) => c.on === l.on && isLiveContact(c)))
      d.contacts.push(call(l.on, l.person, "phone", "conversation"));

  // Reg F's seven days after a conversation: no other counted call to that person (11.1-T14).
  // A second conversation inside them would be one; it is a text instead, still an attempt.
  if (d.dc) {
    d.contacts.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    const kept: Contact[] = [];
    for (const c of d.contacts) {
      const near = kept.some(
        (x) =>
          isLiveContact(x) && x.person === c.person && c.on >= x.on && c.on <= addDays(x.on, 6),
      );
      kept.push(
        isLiveContact(c) && isCountedCall(c) && near
          ? { ...c, channel: "sms", outcome: "sent" }
          : c,
      );
    }
    d.contacts = kept;
    const talks = d.contacts.filter(isLiveContact);
    d.contacts = d.contacts.map((c) =>
      isCountedCall(c) &&
      !isLiveContact(c) &&
      talks.some((x) => x.person === c.person && c.on >= x.on && c.on <= addDays(x.on, 6))
        ? { ...c, channel: "sms", outcome: "sent" }
        : c,
    );
  }
  // Nothing reaches a borrower after a petition or a cease.
  const stop = [d.bankruptcy?.petition_on ?? null, d.dc ? d.cease : null]
    .filter((x): x is PlainDate => x !== null)
    .sort()[0];
  if (stop) d.contacts = d.contacts.filter((c) => c.on < stop);

  // The written notice: mailed between day 38 and day 44 of the oldest window still owed one.
  const t1 = draftTask(d);
  const eps = delinquencies(t1);
  if (d.backgroundNotices && d.pr)
    for (const [k, e] of eps.entries()) {
      const due = addDays(e.day_1, -1);
      const day = addDays(due, r.int(38, 44));
      const on = d.free(day);
      if (on > d.asOf || (e.ended_on !== null && on >= e.ended_on)) continue;
      if (!r.chance(0.92)) continue;
      if (d.bankruptcy && on >= d.bankruptcy.petition_on) continue;
      // Nothing may start inside its cycle after a cure, and no cycle runs to its review here.
      const end = addDays(on, d.dc && d.cease !== null && d.cease < on ? 190 : 180);
      if (eps.slice(k + 1).some((x) => x.day_1 <= end) || end <= d.asOf) continue;
      if (d.dc && d.cease !== null && d.cease > on && d.cease < end) continue;
      const idx = d.index(due);
      if (d.credited[idx] !== null && d.credited[idx]! <= on) continue;
      d.notice(on, d.dc && d.cease !== null && d.cease < on ? "fdcpa" : "standard");
    }

  // Personnel assigned, mostly in time.
  if (d.backgroundAssignments && d.pr)
    for (const e of eps) {
      const due = addDays(e.day_1, -1);
      const kind = r.weighted([
        ["in_time", 88],
        ["late", 5],
        ["none", 7],
      ] as const);
      if (kind === "none") continue;
      let on = addDays(due, kind === "late" ? r.int(46, 60) : r.int(3, 44));
      if (on < e.day_1) on = e.day_1;
      if (on > d.asOf || (e.ended_on !== null && on >= e.ended_on)) continue;
      d.assignments.push(on);
    }
}

/* ── what v1 keeps out ───────────────────────────────────────────────────── */

const sameDayReview = (task: EiTask, end: PlainDate) =>
  task.installments.some((i) => i.credited_as_of === end);

/**
 * Every reason the loan sits where the engine, the servicing app around it
 * or the spec is in doubt, or could not have happened; empty when it is in
 * scope.
 *   - The facts cohere: installments on consecutive 1sts through as_of,
 *     credited oldest first and never after as_of; everything dated on or
 *     before as_of and in order.
 *   - No installment credited on the day after it fell due. The 00:05
 *     counter opens its window and starts a delinquency that day
 *     (ops.ts:76, :79), while §1024.31's count at the day's end, the one the
 *     ported FIFO keeps, never reaches 1: whether that day is a delinquency
 *     of its own is a reading v1 does not grade.
 *   - No day carries two of a credit, a live contact, a notice, the petition,
 *     the discharge and the cease, so no answer turns on their order within
 *     a day; and no notice, petition or discharge falls on a window's
 *     opening day.
 *   - A cease only on a debt collector's loan, and never after the petition:
 *     the engine leaves a leg waiting on the bankruptcy notice when the cease
 *     comes second, where §1024.39(c)(1)(ii) and (d)(2) exempt it.
 *   - Nothing reaches a borrower on or after the petition or the cease, and
 *     every outbound attempt falls inside a cadence: from day 17 of a
 *     delinquency (the plan opens then, plan.ts:16, :70-71) to its close.
 *   - On a debt collector's loan, no counted call to a person in the seven
 *     days after a conversation with them (Reg F §1006.14(b)(2)(ii), 11.1-T14),
 *     which v1 does not grade.
 *   - Each notice is the variant §11.2 rule 1 sends: bk during the case,
 *     fdcpa after a cease, standard otherwise; none after a discharge, and
 *     one bk notice a case.
 *   - No window opens inside a notice's cycle after a cure that followed the
 *     notice. 11.2's state machine closes a cycle when the delinquency ends;
 *     §1024.39(b)(1) excuses a second notice within 180 days whatever came
 *     between. v1 draws neither reading.
 *   - No cycle is reviewed on or after a petition (the case's notice is the
 *     modified one, "regardless of" the 180 days), or after a cease received
 *     inside it (11.2's state machine moves the running cycle to 190 days,
 *     which the engine is never handed), or with an installment credited on
 *     its review day. No cease falls inside a running standard cycle.
 *   - An fdcpa cycle reviewed gives the same answer at day 180, where
 *     §1024.39(d)(3)(iii) tests the delinquency, as at day 190, where
 *     `cycleEndReview` tests it.
 *   - A bankruptcy: no installment credited on or after the petition (a
 *     discharged borrower's notice resumes on any payment after it, which
 *     v1 does not model), a discharge only after the bankruptcy notice was
 *     due, and a case whose notice is owed.
 *   - No delinquency closes on its start deadline with no attempt, where the
 *     timer row and `fnmaCadenceBreaches`'s `end >= startDue`
 *     (plan.ts:193) part.
 *   - Personnel are assigned only during a delinquency of a principal
 *     residence.
 */
export function eiScopeIssues(task: EiTask): string[] {
  const out: string[] = [];
  const insts = task.installments;
  if (insts.length === 0) return ["no installments"];
  for (let k = 0; k < insts.length; k++) {
    const i = insts[k]!;
    if (parts(i.due_date).d !== 1) out.push(`${i.due_date} is not a 1st`);
    if (k > 0 && i.due_date !== addMonths(insts[k - 1]!.due_date, 1))
      out.push(`${i.due_date} skips a month`);
    if (i.credited_as_of !== null && i.credited_as_of > task.as_of)
      out.push(`${i.due_date} credited after as_of`);
    if (i.credited_as_of === addDays(i.due_date, 1))
      out.push(`${i.due_date} credited the day after it fell due`);
    const prev = k > 0 ? insts[k - 1]!.credited_as_of : undefined;
    if (k > 0 && prev === null && i.credited_as_of !== null)
      out.push(`${i.due_date} credited ahead of an older one`);
    if (k > 0 && prev && i.credited_as_of !== null && i.credited_as_of < prev)
      out.push(`${i.due_date} credited before an older one`);
  }
  if (
    insts[insts.length - 1]!.due_date > task.as_of ||
    addMonths(insts[insts.length - 1]!.due_date, 1) <= task.as_of
  )
    out.push("installments do not run through as_of");
  const dates = [
    ...task.contacts.map((c) => c.on),
    ...task.notices.map((n) => n.provided_on),
    ...task.assignments,
    ...(task.bankruptcy
      ? [task.bankruptcy.petition_on, task.bankruptcy.discharged_on ?? task.bankruptcy.petition_on]
      : []),
    ...(task.fdcpa_cease_on ? [task.fdcpa_cease_on] : []),
  ];
  if (dates.some((x) => x > task.as_of)) out.push("an event after as_of");
  for (let k = 1; k < task.contacts.length; k++)
    if (task.contacts[k]!.on < task.contacts[k - 1]!.on) out.push("contacts out of order");
  for (let k = 1; k < task.notices.length; k++)
    if (task.notices[k]!.provided_on <= task.notices[k - 1]!.provided_on)
      out.push("notices out of order");

  // Exclusive days.
  const kinds = new Map<PlainDate, Set<string>>();
  const mark = (day: PlainDate, kind: string) => {
    const s = kinds.get(day) ?? new Set<string>();
    s.add(kind);
    kinds.set(day, s);
  };
  for (const i of insts) if (i.credited_as_of) mark(i.credited_as_of, "credit");
  for (const c of task.contacts) if (isLiveContact(c)) mark(c.on, "live");
  for (const n of task.notices) mark(n.provided_on, "notice");
  if (task.bankruptcy) {
    mark(task.bankruptcy.petition_on, "petition");
    if (task.bankruptcy.discharged_on) mark(task.bankruptcy.discharged_on, "discharge");
  }
  if (task.fdcpa_cease_on) mark(task.fdcpa_cease_on, "cease");
  for (const [day, s] of kinds) if (s.size > 1) out.push(`${day} carries ${[...s].join(" and ")}`);
  const seconds = [
    ...task.notices.map((n) => n.provided_on),
    ...(task.bankruptcy ? [task.bankruptcy.petition_on, task.bankruptcy.discharged_on] : []),
  ].filter((x): x is PlainDate => x !== null);
  if (seconds.some((x) => parts(x).d === 2)) out.push("a notice, petition or discharge on a 2nd");

  const bk = task.bankruptcy;
  const cease = task.fdcpa_cease_on;
  if (cease !== null && !task.loan.debt_collector)
    out.push("a cease on a loan with no debt collector");
  if (bk && bk.discharged_on !== null && bk.discharged_on <= bk.petition_on)
    out.push("a discharge before the petition");
  if (bk && cease !== null && cease >= bk.petition_on) out.push("a cease on or after the petition");
  const stop = [bk?.petition_on ?? null, cease].filter((x): x is PlainDate => x !== null).sort()[0];
  if (stop && task.contacts.some((c) => c.on >= stop))
    out.push("a contact after the petition or the cease");

  // Every outbound attempt inside a cadence.
  const eps = delinquencies(task);
  const cadences = eps.flatMap((e) => {
    const due = addDays(e.day_1, -1);
    const opens = addDays(due, CADENCE_OPENS_DAY);
    if ((bk && bk.petition_on < e.day_1) || (cease !== null && cease < e.day_1)) return [];
    const stops = [e.ended_on, bk?.petition_on ?? null, cease].filter(
      (x): x is PlainDate => x !== null,
    );
    const close = stops.length ? stops.reduce((a, b) => (a < b ? a : b)) : null;
    return [{ due, opens, close }];
  });
  for (const c of task.contacts)
    if (
      isOutboundAttempt(c) &&
      !cadences.some((p) => c.on >= p.opens && (p.close === null || c.on < p.close))
    )
      out.push(`an outbound attempt on ${c.on} outside a cadence`);
  for (const c of task.contacts) {
    if (
      c.callback_requested &&
      !(c.direction === "outbound" && (c.channel === "ai_voice" || c.channel === "human_voice"))
    )
      out.push("a callback that is not an outbound call");
    if ((c.channel === "phone") !== (c.direction === "inbound"))
      out.push("an inbound contact not by phone");
    if (c.direction === "inbound" && c.outcome !== "conversation")
      out.push("an inbound contact that is not a conversation");
    const written = c.channel === "sms" || c.channel === "email" || c.channel === "letter";
    if (written !== (c.outcome === "sent")) out.push("a written contact not sent, or a call sent");
  }
  // No tie on a start deadline.
  for (const p of cadences) {
    if (p.close === null) continue;
    const start = shiftOpen(addDays(p.due, 36));
    const any = task.contacts.some(
      (c) => isOutboundAttempt(c) && c.on >= p.opens && c.on < p.close!,
    );
    if (!any && p.close === start) out.push("a delinquency closed on its start deadline");
  }

  // Reg F's cooling-off after a conversation.
  if (task.loan.debt_collector)
    task.contacts.forEach((c, k) => {
      if (!isLiveContact(c)) return;
      task.contacts.forEach((x, j) => {
        if (j === k || !isCountedCall(x) || x.person !== c.person) return;
        if (x.on >= c.on && x.on <= addDays(c.on, 6))
          out.push(`a counted call on ${x.on} inside ${c.on}'s seven days`);
      });
    });

  // Variants.
  let bkNotices = 0;
  for (const n of task.notices) {
    const t = n.provided_on;
    if (bk && bk.discharged_on !== null && t >= bk.discharged_on)
      out.push("a notice after the discharge");
    const want: Variant =
      bk && bk.petition_on <= t ? "bk" : cease !== null && cease < t ? "fdcpa" : "standard";
    if (n.variant !== want) out.push(`the ${t} notice is ${n.variant}, not ${want}`);
    if (n.variant === "bk") bkNotices++;
  }
  if (bkNotices > 1) out.push("two bankruptcy notices in one case");

  // Cycles.
  const cycles = cyclesOf(task);
  const cures = eps.map((e) => e.ended_on).filter((x): x is PlainDate => x !== null);
  const opened = windowDues(task).map((d) => addDays(d, 1));
  task.notices.forEach((n, k) => {
    const c = noticeCycle(n.provided_on, n.variant, `n${k}`);
    for (const o of opened)
      if (o > n.provided_on && o <= c.cycle_end_at && cures.some((x) => x > n.provided_on && x < o))
        out.push(`a window opens on ${o} inside the ${n.provided_on} cycle after a cure`);
    if (
      n.variant === "standard" &&
      cease !== null &&
      cease > n.provided_on &&
      cease < addDays(n.provided_on, 180)
    )
      out.push("a cease inside a running standard cycle");
    const cy = cycles[k];
    if (!cy || (cy.outcome !== "repeat_required" && cy.outcome !== "not_required")) return;
    if (bk && bk.petition_on <= c.cycle_end_at) out.push("a cycle reviewed after a petition");
    if (sameDayReview(task, c.cycle_end_at)) out.push("an installment credited on a review day");
    if (n.variant === "fdcpa") {
      const day180 = addDays(n.provided_on, 180);
      const days = regxDaysOn(task, day180);
      const e = earliestUnpaidOn(task, day180);
      const at190 = cycleEndReview(c, {
        today: c.cycle_end_at,
        regx_days_delinquent: regxDaysOn(task, c.cycle_end_at),
        earliest_unpaid_due: earliestUnpaidOn(task, c.cycle_end_at),
      });
      const repeat = days >= 45;
      const next = repeat ? c.cycle_end_at : e ? nextNoticeDue(c, days, e).due_on : null;
      if (repeat !== at190.repeat_required || next !== at190.next_required_by)
        out.push("an fdcpa cycle that day 180 and day 190 review differently");
      if (task.installments.some((i) => i.credited_as_of === day180))
        out.push("a credit on an fdcpa cycle's day 180");
    }
  });

  // Bankruptcy.
  if (bk) {
    if (insts.some((i) => i.credited_as_of !== null && i.credited_as_of >= bk.petition_on))
      out.push("a credit on or after the petition");
    // One notice serves a case (§1024.39(c)(1)(iii)(C)), and `openWindow` opens a later window
    // in the case waiting on it again (windows.ts:71, :126).
    const sent = task.notices.find((n) => n.variant === "bk");
    if (
      sent &&
      opened.some(
        (o) => o > sent.provided_on && (bk.discharged_on === null || o < bk.discharged_on),
      )
    )
      out.push("a window opens in the case after its notice");
    const want = expectedEi(task).bk_notice;
    if (task.loan.principal_residence && want && bk.discharged_on !== null) {
      if (want.due === null && want.status !== "exempt")
        out.push("a discharge before the case's notice was owed");
      if (want.due !== null && bk.discharged_on <= want.due)
        out.push("a discharge before the bankruptcy notice was due");
    }
  }
  // Assignments inside delinquencies of a principal residence.
  for (const a of task.assignments)
    if (
      !task.loan.principal_residence ||
      !eps.some((e) => a >= e.day_1 && (e.ended_on === null || a < e.ended_on))
    )
      out.push(`an assignment on ${a} outside a delinquency`);
  return out;
}

export const eiInScope = (task: EiTask): boolean => eiScopeIssues(task).length === 0;

/** Whether the rulebook followed through the tools lands exactly where the grader does. */
export function eiFairToGrade(task: EiTask): boolean {
  const payload = JSON.parse(JSON.stringify(eiPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(eiSteps, payload, executeEiTool);
  } catch {
    return false;
  }
  const parsed = parseEiSubmission(byRules);
  return parsed.ok && gradeEiAgainst(expectedEi(task), parsed.answer).pass;
}

/* ── drawing ─────────────────────────────────────────────────────────────── */

export function drawEiCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): EiTask {
  const edge = eiEdgeOf(index);
  const { arms, build } = EDGES[edge];
  const d = new Draft();
  d.dc = r.chance(0.2);
  build(r, eiArmOf(index, arms), d);
  background(r, d);
  return d.task(id, split, suiteSeed, index);
}

const ATTEMPTS = 40;

export function drawEiTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: EiTask; attempts: number } {
  const id = eiTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawEiCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (eiInScope(task) && eiFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no loan in scope in ${ATTEMPTS} draws`);
}

export const generateEiTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawEiTask(split, suiteSeed, index).task;

export function generateEiSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): EiTask[] {
  return Array.from({ length: n }, (_, i) => generateEiTask(split, suiteSeed, i));
}

export const EI_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's own cases ────────────────────────────────────────────────── */

type SpecLoan = Omit<EiTask, "id" | "split" | "suite_seed" | "index">;

const D = plainDate;
const unpaid = (...dues: string[]) => dues.map((x) => ({ due_date: D(x), credited_as_of: null }));
const paid = (due: string, on: string) => ({ due_date: D(due), credited_as_of: D(on) });
const ai = (on: string, outcome: Contact["outcome"] = "no_answer", person: Person = "borrower") =>
  call(D(on), person, "ai_voice", outcome);
const LOAN = { principal_residence: true, debt_collector: false };
const NONE = { notices: [], assignments: [], bankruptcy: null, fdcpa_cease_on: null } as const;
/** 11.1 rule 5's cadence: the first attempt on day 17, then every three or four days. */
const rhythm = (first: string, until: string): Contact[] => {
  const out: Contact[] = [];
  let k = 0;
  for (let t = D(first); t <= D(until); t = addDays(t, k++ % 2 === 0 ? 3 : 4)) out.push(ai(t));
  return out;
};
/** 11.1-T3's attempts, as `rollingDelinquency` places them (ops.ts:142-160): day 17, then +3, +4 in turn, until the cure. */
const rollingAttempts = (dues: readonly string[]): Contact[] => {
  const out: Contact[] = [];
  let n = 0;
  for (const due of dues) {
    const paidOn = addMonths(D(due), 1);
    let next: PlainDate | null = null;
    for (let t = addDays(D(due), 17); t < paidOn; t = addDays(t, 1))
      if (next === null || t >= next) {
        out.push(ai(t));
        next = addDays(t, n % 2 === 0 ? 3 : 4);
        n++;
      }
  }
  return out;
};

/** Eight installments from 2026-11-01 unpaid through 2027-06-12, and the December notice (11.2 rule 3). */
const SIX_MONTHS = unpaid(
  "2026-11-01",
  "2026-12-01",
  "2027-01-01",
  "2027-02-01",
  "2027-03-01",
  "2027-04-01",
  "2027-05-01",
  "2027-06-01",
);

export const EI_SPEC_CASES: readonly { readonly name: string; readonly loan: SpecLoan }[] = [
  {
    name: "11.1 rule 3 / 11.1-T1, T2: the Nov 1 installment credited 2026-12-10, on 2026-12-11 (10 days delinquent)",
    loan: {
      as_of: D("2026-12-11"),
      loan: LOAN,
      installments: [paid("2026-11-01", "2026-12-10"), ...unpaid("2026-12-01")],
      contacts: rhythm("2026-11-18", "2026-12-11"),
      ...NONE,
    },
  },
  {
    name: "11.1 rule 3: the same $2,000 applied on 2026-12-05 cancels both legs of the Nov 1 window",
    loan: {
      as_of: D("2026-12-11"),
      loan: LOAN,
      installments: [paid("2026-11-01", "2026-12-05"), ...unpaid("2026-12-01")],
      contacts: rhythm("2026-11-18", "2026-12-11"),
      ...NONE,
    },
  },
  {
    name: "11.2-T2: paid 2026-12-17 with no notice provided by 12-16: the notice leg breached",
    loan: {
      as_of: D("2026-12-17"),
      loan: LOAN,
      installments: [paid("2026-11-01", "2026-12-17"), ...unpaid("2026-12-01")],
      contacts: rhythm("2026-11-18", "2026-12-16"),
      ...NONE,
    },
  },
  {
    name: "11.2-T2: paid 2026-12-17 with the notice provided 2026-12-16: on time",
    loan: {
      as_of: D("2026-12-17"),
      loan: LOAN,
      installments: [paid("2026-11-01", "2026-12-17"), ...unpaid("2026-12-01")],
      contacts: rhythm("2026-11-18", "2026-12-15"),
      ...NONE,
      notices: [{ provided_on: D("2026-12-16"), variant: "standard" }],
    },
  },
  {
    name: "11.2-T3: the notice provided 2026-12-14 covers the Dec 1 window (satisfied_by_prior_180)",
    loan: {
      as_of: D("2026-12-31"),
      loan: LOAN,
      installments: unpaid("2026-11-01", "2026-12-01"),
      contacts: rhythm("2026-11-18", "2026-12-31"),
      ...NONE,
      notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
    },
  },
  {
    name: "11.1-T4: a live AI contact on 2027-02-05 satisfies the Jan 1 and Feb 1 windows; Mar 1 open on 2027-04-06",
    loan: {
      as_of: D("2027-04-06"),
      loan: LOAN,
      installments: unpaid("2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01"),
      contacts: [ai("2027-02-05", "conversation")],
      ...NONE,
    },
  },
  {
    name: "11.1-T4: and the Mar 1 window breached on 2027-04-07",
    loan: {
      as_of: D("2027-04-07"),
      loan: LOAN,
      installments: unpaid("2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01"),
      contacts: [ai("2027-02-05", "conversation")],
      ...NONE,
    },
  },
  {
    name: "11.1-T3: each installment paid on the next due date (rolling 30): every window cancelled_paid, no breach",
    loan: {
      as_of: D("2027-05-08"),
      loan: LOAN,
      installments: [
        paid("2027-01-01", "2027-02-01"),
        paid("2027-02-01", "2027-03-01"),
        paid("2027-03-01", "2027-04-01"),
        paid("2027-04-01", "2027-05-01"),
        paid("2027-05-01", "2027-05-01"),
      ],
      contacts: rollingAttempts(["2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01"]),
      ...NONE,
    },
  },
  {
    name: "11.2-T4: 45 days or more delinquent on 2027-06-12, the repeat due that day",
    loan: {
      as_of: D("2027-06-12"),
      loan: LOAN,
      installments: SIX_MONTHS,
      contacts: [],
      ...NONE,
      notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
    },
  },
  {
    name: "11.2-T4: June 1 the earliest unpaid on 2027-06-12, the duty moved to its window, due 2027-07-16",
    loan: {
      as_of: D("2027-06-20"),
      loan: LOAN,
      installments: [
        ...SIX_MONTHS.slice(0, 7).map((i) => paid(i.due_date, "2027-06-05")),
        ...unpaid("2027-06-01"),
      ],
      contacts: [],
      ...NONE,
      notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
    },
  },
  {
    name: "11.2-T5: an fdcpa notice provided 2026-12-14, 45 days or more delinquent, the repeat due 2027-06-22",
    loan: {
      as_of: D("2027-06-22"),
      loan: { principal_residence: true, debt_collector: true },
      installments: [...SIX_MONTHS],
      contacts: rhythm("2026-11-18", "2026-12-03"),
      notices: [{ provided_on: D("2026-12-14"), variant: "fdcpa" }],
      assignments: [],
      bankruptcy: null,
      fdcpa_cease_on: D("2026-12-04"),
    },
  },
  {
    name: "11.2 rule 5 / 11.2-T6: a Chapter 13 petition 2027-01-20 while delinquent, the bankruptcy notice due 2027-03-06",
    loan: {
      as_of: D("2027-03-06"),
      loan: LOAN,
      installments: unpaid("2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"),
      contacts: rhythm("2026-11-18", "2027-01-19"),
      notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
      assignments: [],
      bankruptcy: { petition_on: D("2027-01-20"), discharged_on: null },
      fdcpa_cease_on: null,
    },
  },
  {
    name: "11.2-T6: the bankruptcy notice provided 2027-03-05, the once-per-case notice for every leg waiting on it",
    loan: {
      as_of: D("2027-03-10"),
      loan: LOAN,
      installments: unpaid("2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"),
      contacts: rhythm("2026-11-18", "2027-01-19"),
      notices: [
        { provided_on: D("2026-12-14"), variant: "standard" },
        { provided_on: D("2027-03-05"), variant: "bk" },
      ],
      assignments: [],
      bankruptcy: { petition_on: D("2027-01-20"), discharged_on: null },
      fdcpa_cease_on: null,
    },
  },
  {
    name: "11.1-T8 / 11.2-T7: a Chapter 7 discharge 2027-04-15 with no payment after the petition: the next window exempt_discharge",
    loan: {
      as_of: D("2027-05-20"),
      loan: LOAN,
      installments: unpaid(
        "2026-11-01",
        "2026-12-01",
        "2027-01-01",
        "2027-02-01",
        "2027-03-01",
        "2027-04-01",
        "2027-05-01",
      ),
      contacts: rhythm("2026-11-18", "2027-01-19"),
      notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
      assignments: [],
      bankruptcy: { petition_on: D("2027-01-20"), discharged_on: D("2027-04-15") },
      fdcpa_cease_on: null,
    },
  },
  {
    name: "11.1-T15: the last attempt Thursday 2026-11-19, the next due Friday 11-27 past Thanksgiving",
    loan: {
      as_of: D("2026-11-27"),
      loan: LOAN,
      installments: unpaid("2026-10-01", "2026-11-01"),
      contacts: [
        "2026-10-19",
        "2026-10-23",
        "2026-10-30",
        "2026-11-05",
        "2026-11-12",
        "2026-11-19",
      ].map((x) => ai(x)),
      ...NONE,
    },
  },
  {
    name: "4.3-T1: due 2026-09-01 unpaid, the notice requested 2026-10-09: personnel assigned by the notice",
    loan: {
      as_of: D("2026-10-20"),
      loan: LOAN,
      installments: unpaid("2026-09-01", "2026-10-01"),
      contacts: rhythm("2026-09-18", "2026-10-20"),
      notices: [{ provided_on: D("2026-10-09"), variant: "standard" }],
      assignments: [D("2026-10-09")],
      bankruptcy: null,
      fdcpa_cease_on: null,
    },
  },
  {
    name: "4.3-T2: no notice by day 45, personnel assigned 2026-10-16 all the same",
    loan: {
      as_of: D("2026-10-20"),
      loan: LOAN,
      installments: unpaid("2026-09-01", "2026-10-01"),
      contacts: rhythm("2026-09-18", "2026-10-20"),
      notices: [],
      assignments: [D("2026-10-16")],
      bankruptcy: null,
      fdcpa_cease_on: null,
    },
  },
  {
    name: "11.1 rule 10 / 11.1-T13: Reg F counts B 1, 2, 2, 2, 3, 4 and C 1, the 12-15 callback excluded",
    loan: {
      as_of: D("2026-12-15"),
      loan: { principal_residence: true, debt_collector: true },
      installments: unpaid("2026-11-01", "2026-12-01"),
      contacts: [
        ai("2026-12-07"),
        ai("2026-12-08", "voicemail"),
        call(D("2026-12-09"), "borrower", "human_voice", "busy_or_failed"),
        ai("2026-12-09", "no_answer", "co_borrower"),
        call(D("2026-12-10"), "borrower", "human_voice", "no_answer"),
        ai("2026-12-11", "conversation"),
        call(D("2026-12-15"), "borrower", "ai_voice", "conversation", true),
      ],
      ...NONE,
    },
  },
  {
    name: "11.1-T22 / 11.2-T13: an investment property: no Reg X window applies, the D2-2-02 cadence runs",
    loan: {
      as_of: D("2026-11-20"),
      loan: { principal_residence: false, debt_collector: false },
      installments: unpaid("2026-09-01", "2026-10-01", "2026-11-01"),
      contacts: rhythm("2026-09-18", "2026-11-20"),
      ...NONE,
    },
  },
];

export function eiSpecTasks(): EiTask[] {
  return EI_SPEC_CASES.map((c, index) => ({
    id: `${EI_ENVIRONMENT_NAME}/${EI_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c.loan,
  }));
}
