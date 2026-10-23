/**
 * The reference policy for ei-clocks: the rulebook followed literally,
 * through the tools. Comparing dates, finding the oldest unpaid
 * installment and counting calls is reading; every date reached by adding
 * days, and every day count, is a tool call. Calls that do not depend on
 * each other go together in one turn, as a model may make them. Held to the
 * grader on every generated task, it is the proof that each loan's clocks
 * can be read from the rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { EI_SUBMIT_TOOL } from "./tools.js";

/** One call of a batch: the tool, its input, and the key its answer is read back by. */
type Want = readonly [name: string, input: Json, key: string];

let batches = 0;
/** Independent calls made together in one turn, read back by id. */
function* together(wants: readonly Want[]): Step<unknown[]> {
  if (wants.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = wants.map(([name, input], k) => ({
    id: `ei-${batch}-${k}`,
    name,
    input,
  }));
  const observations = yield calls;
  return calls.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return (JSON.parse(o.content) as Record<string, unknown>)[wants[k]![2]];
  });
}

/** A set of dates each wanted once, and the answers read back by date. */
class Dated {
  private readonly wanted = new Map<string, Want>();
  private readonly got = new Map<string, string>();
  constructor(private readonly make: (d: string) => Want) {}
  want(d: string): void {
    if (!this.wanted.has(d) && !this.got.has(d)) this.wanted.set(d, this.make(d));
  }
  pending(): [string, Want][] {
    return [...this.wanted];
  }
  take(answers: Map<string, string>): void {
    for (const [d, v] of answers) this.got.set(d, v);
    this.wanted.clear();
  }
  of(d: string): string {
    const v = this.got.get(d);
    if (v === undefined) throw new Error(`no answer for ${d}`);
    return v;
  }
}

/** Every pending call across the sets, in one turn. */
function* resolve(sets: readonly Dated[]): Step<void> {
  const pending = sets.flatMap((s) => s.pending().map(([d, w]) => ({ s, d, w })));
  const answers = yield* together(pending.map((x) => x.w));
  const by = new Map<Dated, Map<string, string>>();
  pending.forEach((x, k) => {
    const m = by.get(x.s) ?? new Map<string, string>();
    m.set(x.d, String(answers[k]));
    by.set(x.s, m);
  });
  for (const s of sets) s.take(by.get(s) ?? new Map());
}

const plus =
  (n: number) =>
  (d: string): Want => ["date_add", { date: d, days: n }, "date"];

interface Inst {
  due_date: string;
  credited_as_of: string | null;
}
interface Contact {
  on: string;
  direction: "outbound" | "inbound";
  channel: string;
  person: "borrower" | "co_borrower";
  outcome: string;
  callback_requested: boolean;
}
interface Leg {
  due: string;
  status: string;
  late: boolean;
}

export function* eiSteps(p: Json, _call: Call): Step<Json> {
  const asOf = String(p["as_of"]);
  const loan = p["loan"] as { principal_residence: boolean; debt_collector: boolean };
  const insts = p["installments"] as Inst[];
  const contacts = p["contacts"] as Contact[];
  const notices = p["notices"] as { provided_on: string; variant: string }[];
  const assignments = p["assignments"] as string[];
  const bk = p["bankruptcy"] as { petition_on: string; discharged_on: string | null } | null;
  const cease = loan.debt_collector ? ((p["fdcpa_cease_on"] ?? null) as string | null) : null;
  const pr = loan.principal_residence;

  const unpaidOn = (i: Inst, t: string) => i.credited_as_of === null || i.credited_as_of > t;
  const second = (d: string) => `${d.slice(0, 8)}02`;
  const eighteenth = (d: string) => `${d.slice(0, 8)}18`;
  const isLive = (c: Contact) => c.outcome === "conversation";
  /** E for a day: the earliest due on or before it of an installment unpaid on it. */
  const earliestUnpaid = (t: string) =>
    insts.find((i) => i.due_date <= t && unpaidOn(i, t)) ?? null;
  const dues = insts.filter(
    (i) =>
      second(i.due_date) <= asOf && (i.credited_as_of === null || i.credited_as_of > i.due_date),
  );

  // Step 5's delinquencies are reading: day 1 and the cure day.
  const episodes: { due: string; day1: string; ended: string | null }[] = [];
  for (const w of dues) {
    const older = insts.filter((i) => i.due_date < w.due_date);
    if (older.some((i) => unpaidOn(i, w.due_date))) continue;
    // The cure: the first credited day, from this installment on, with nothing due before it unpaid.
    let ended: string | null = null;
    for (const i of insts.filter((x) => x.due_date >= w.due_date)) {
      const t = i.credited_as_of;
      if (t === null || t > asOf) break;
      if (!insts.some((x) => x.due_date < t && unpaidOn(x, t))) {
        ended = t;
        break;
      }
    }
    episodes.push({ due: w.due_date, day1: second(w.due_date), ended });
  }

  // The first turn: every date that depends on nothing but the task.
  const add36 = new Dated(plus(36));
  const add45 = new Dated(plus(45));
  const add180 = new Dated(plus(180));
  const add190 = new Dated(plus(190));
  const add7 = new Dated(plus(7));
  const less7 = new Dated(plus(-7));
  const since = new Dated((d) => ["days_between", { from: d, to: asOf }, "days"]);
  for (const w of dues) {
    add36.want(w.due_date);
    add45.want(w.due_date);
  }
  for (const n of notices) (n.variant === "fdcpa" ? add190 : add180).want(n.provided_on);
  if (bk) add45.want(bk.petition_on);
  const e = earliestUnpaid(asOf);
  if (e) since.want(e.due_date);
  const attempt = (c: Contact) => c.direction === "outbound" && c.channel !== "letter";
  for (const c of contacts) if (attempt(c)) add7.want(c.on);
  const counted = contacts.filter(
    (c) =>
      c.direction === "outbound" &&
      (c.channel === "ai_voice" || c.channel === "human_voice") &&
      c.outcome !== "busy_or_failed" &&
      !c.callback_requested,
  );
  if (loan.debt_collector) {
    less7.want(asOf);
    for (const c of counted) less7.want(c.on);
  }
  yield* resolve([add36, add45, add180, add190, add7, less7, since]);

  // Step 1.
  const regxDays = e ? Number(since.of(e.due_date)) : 0;

  // Step 3's cycle ends, needed by Step 2's openings.
  const cycleEnd = (n: { provided_on: string; variant: string }) =>
    (n.variant === "fdcpa" ? add190 : add180).of(n.provided_on);

  // Step 2, as events in date order: each day's sweep, then the openings, then the day's event.
  const live = new Map<string, Leg>();
  const notice = new Map<string, Leg>();
  type Ev = { on: string; rank: number; act: () => void };
  const events: Ev[] = [];
  const sweep = (t: string) => {
    for (const l of [...live.values(), ...notice.values()])
      if (l.status === "open" && l.due < t) l.status = "breached";
  };
  for (const w of dues) {
    const d = w.due_date;
    const opens = second(d);
    events.push({
      on: opens,
      rank: 0,
      act: () => {
        const l: Leg = { due: add36.of(d), status: "open", late: false };
        const n: Leg = { due: add45.of(d), status: "open", late: false };
        if (!pr) {
          l.status = "not_applicable";
          n.status = "not_applicable";
        } else if (bk && bk.discharged_on !== null && bk.discharged_on < opens) {
          l.status = "exempt_discharge";
          n.status = "exempt_discharge";
        } else if (bk && bk.petition_on < opens) {
          l.status = "exempt_bk";
          n.status =
            cease !== null && cease < bk.petition_on ? "exempt_bk_cease" : "bk_modified_required";
        } else {
          if (cease !== null && cease < opens) l.status = "exempt_fdcpa_cease";
          const last = notices.filter((x) => x.provided_on < opens).at(-1);
          if (last && cycleEnd(last) >= n.due) n.status = "satisfied_by_prior_180";
        }
        live.set(d, l);
        notice.set(d, n);
      },
    });
  }
  for (const i of insts) {
    const t = i.credited_as_of;
    if (t === null || t > asOf) continue;
    events.push({
      on: t,
      rank: 1,
      act: () => {
        const l = live.get(i.due_date);
        const n = notice.get(i.due_date);
        if (l && l.status === "open" && t <= l.due) l.status = "cancelled_paid";
        if (n && n.status === "open" && t <= n.due) n.status = "cancelled_paid";
      },
    });
  }
  if (bk)
    events.push({
      on: bk.petition_on,
      rank: 1,
      act: () => {
        for (const l of live.values()) if (l.status === "open") l.status = "exempt_bk";
        for (const n of notice.values())
          if (n.status === "open")
            n.status =
              cease !== null && cease < bk.petition_on ? "exempt_bk_cease" : "bk_modified_required";
      },
    });
  if (cease !== null)
    events.push({
      on: cease,
      rank: 1,
      act: () => {
        for (const l of live.values()) if (l.status === "open") l.status = "exempt_fdcpa_cease";
      },
    });
  if (bk && bk.discharged_on !== null)
    events.push({
      on: bk.discharged_on,
      rank: 1,
      act: () => {
        for (const n of notice.values())
          if (n.status === "bk_modified_required") n.status = "exempt_discharge";
      },
    });
  for (const c of contacts)
    if (isLive(c))
      events.push({
        on: c.on,
        rank: 1,
        act: () => {
          for (const l of live.values()) if (l.status === "open") l.status = "satisfied_live";
        },
      });
  for (const x of notices)
    events.push({
      on: x.provided_on,
      rank: 1,
      act: () => {
        const legs = [...notice.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, n]) => n);
        for (const n of legs) {
          if (n.status === "breached") {
            n.status = "sent";
            n.late = true;
          } else if (n.status === "bk_modified_required") n.status = "sent";
        }
        const oldest = legs.find((n) => n.status === "open");
        if (oldest) oldest.status = "sent";
        for (const n of legs) if (n.status === "open") n.status = "satisfied_by_prior_180";
      },
    });
  events.sort((a, b) => (a.on !== b.on ? (a.on < b.on ? -1 : 1) : a.rank - b.rank));
  for (const ev of events) {
    sweep(ev.on);
    ev.act();
  }
  sweep(asOf);
  const windows = dues.map((w) => {
    const l = live.get(w.due_date)!;
    const n = notice.get(w.due_date)!;
    return {
      due_date: w.due_date,
      live_due: l.due,
      live: l.status,
      live_late:
        l.status === "breached" && contacts.some((c) => isLive(c) && c.on > l.due && c.on <= asOf),
      notice_due: n.due,
      notice: n.status,
      notice_late: n.late,
    };
  });

  // Step 3: what each reviewed cycle needs.
  type Review = { n: { provided_on: string; variant: string }; end: string; e: Inst | null };
  const reviews: Review[] = [];
  const cycles: Json[] = notices.map((n, k) => {
    const end = cycleEnd(n);
    const next = notices[k + 1];
    const base = { provided_on: n.provided_on, cycle_end: end };
    if (next && next.provided_on < end)
      return { ...base, outcome: "superseded", next_required_by: null, repeat: null };
    if (asOf < end) return { ...base, outcome: "running", next_required_by: null, repeat: null };
    reviews.push({ n, end, e: earliestUnpaid(end) });
    return base;
  });
  const daysAt = new Dated((d) => {
    const r = reviews.find((x) => x.e?.due_date === d.split("|")[0] && x.end === d.split("|")[1])!;
    return ["days_between", { from: r.e!.due_date, to: r.end }, "days"];
  });
  for (const r of reviews) if (r.e) daysAt.want(`${r.e.due_date}|${r.end}`);

  // The second turn: the business-day rolls and the review counters.
  const roll = new Dated((d) => ["next_business_day", { date: d }, "date"]);
  const plans = episodes.map((ep) => {
    const opens = eighteenth(ep.due);
    const petition = bk?.petition_on ?? null;
    if ((petition !== null && petition < ep.day1) || (cease !== null && cease < ep.day1))
      return null;
    const stops = [ep.ended, petition, cease].filter((d): d is string => d !== null);
    const close = stops.length ? stops.reduce((a, b) => (a < b ? a : b)) : null;
    if (asOf < opens || (close !== null && close <= opens)) return null;
    const attempts = contacts
      .filter(
        (c) => attempt(c) && c.on >= opens && c.on <= asOf && (close === null || c.on < close),
      )
      .map((c) => c.on);
    roll.want(add36.of(ep.due));
    attempts.forEach((a, k) => {
      const next = attempts[k + 1];
      // A next attempt on or before a + 7 meets the rolled deadline, which is never earlier.
      if (next === undefined || next > add7.of(a)) roll.want(add7.of(a));
    });
    return { close, attempts };
  });
  yield* resolve([roll, daysAt]);

  const after45 = new Dated(plus(45));
  for (const r of reviews)
    if (r.e && Number(daysAt.of(`${r.e.due_date}|${r.end}`)) < 45) after45.want(r.e.due_date);
  yield* resolve([after45]);
  for (const r of reviews) {
    const k = notices.indexOf(r.n);
    const next = notices[k + 1];
    const days = r.e ? Number(daysAt.of(`${r.e.due_date}|${r.end}`)) : 0;
    const base = cycles[k] as Json;
    if (days >= 45)
      cycles[k] = {
        ...base,
        outcome: "repeat_required",
        next_required_by: r.end,
        repeat: next
          ? next.provided_on === r.end
            ? "sent"
            : "late"
          : asOf > r.end
            ? "breached"
            : "open",
      };
    else if (r.e) {
      const e45 = after45.of(r.e.due_date);
      cycles[k] = {
        ...base,
        outcome: "not_required",
        next_required_by: r.n.variant === "fdcpa" && r.end > e45 ? r.end : e45,
        repeat: null,
      };
    } else cycles[k] = { ...base, outcome: "not_required", next_required_by: null, repeat: null };
  }

  // Step 4.
  let bkNotice: Json | null = null;
  if (bk && pr) {
    const pt = bk.petition_on;
    if (cease !== null && cease < pt) bkNotice = { due: null, status: "exempt" };
    else {
      const delinquent = insts.some((i) => i.due_date < pt && unpaidOn(i, pt));
      const first = dues.find(
        (w) =>
          second(w.due_date) > pt &&
          (bk.discharged_on === null || bk.discharged_on > second(w.due_date)),
      );
      const due = delinquent ? add45.of(pt) : first ? add45.of(first.due_date) : null;
      if (due === null) bkNotice = { due: null, status: "not_yet_required" };
      else {
        const sent = notices.find((n) => n.variant === "bk" && n.provided_on >= pt);
        bkNotice = {
          due,
          status: sent
            ? sent.provided_on <= due
              ? "sent"
              : "late"
            : asOf > due
              ? "breached"
              : "open",
        };
      }
    }
  }

  // Step 5.
  const episodeAnswers = episodes.map((ep, k) => {
    const inside = (d: string) => d >= ep.day1 && (ep.ended === null || d < ep.ended);
    let continuity: Json;
    if (!pr) continuity = { assign_by: null, basis: null, status: "not_required" };
    else {
      const d45 = add45.of(ep.due);
      const n = notices.find((x) => inside(x.provided_on));
      const byNotice = n !== undefined && n.provided_on < d45;
      const assignBy = byNotice ? n.provided_on : d45;
      const basis = byNotice ? "ei_notice" : "day_45";
      let status: string;
      if (ep.ended !== null && ep.ended <= assignBy) status = "not_due";
      else {
        const a = assignments.find((x) => inside(x) && x <= asOf);
        status = a ? (a <= assignBy ? "met" : "late") : asOf > assignBy ? "breached" : "open";
      }
      continuity = { assign_by: assignBy, basis, status };
    }
    const plan = plans[k];
    let outbound: Json | null = null;
    if (plan) {
      const start = roll.of(add36.of(ep.due));
      let x = start;
      const missed: string[] = [];
      plan.attempts.forEach((a, j) => {
        if (a > x) missed.push(x);
        const next = plan.attempts[j + 1];
        x = next === undefined || next > add7.of(a) ? roll.of(add7.of(a)) : add7.of(a);
      });
      // x is a + 7 itself only where the next attempt meets it whichever way it rolls.
      if (plan.close !== null) {
        if (plan.close > x) missed.push(x);
        outbound = { start_due: start, missed, next_due: null };
      } else {
        if (asOf > x) missed.push(x);
        outbound = { start_due: start, missed, next_due: x };
      }
    }
    return { day_1: ep.day1, ended_on: ep.ended, continuity, outbound };
  });

  // Step 6.
  let regf: Json | null = null;
  if (loan.debt_collector) {
    const from = less7.of(asOf);
    const last7 = (who: string) => counted.filter((c) => c.person === who && c.on > from).length;
    const over: { on: string; person: string }[] = [];
    counted.forEach((c, k) => {
      const n = counted
        .slice(0, k + 1)
        .filter((x) => x.person === c.person && x.on > less7.of(c.on)).length;
      if (n > 7) over.push({ on: c.on, person: c.person });
    });
    regf = {
      counted_last_7: { borrower: last7("borrower"), co_borrower: last7("co_borrower") },
      over_cap: over,
    };
  }

  return {
    regx_days_delinquent: regxDays,
    windows,
    cycles,
    bk_notice: bkNotice,
    episodes: episodeAnswers,
    regf,
  };
}

export class EiReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", eiSteps, EI_SUBMIT_TOOL);
  }
}
