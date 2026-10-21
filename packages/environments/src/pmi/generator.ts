/**
 * Synthetic loans and their mortgage insurance, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is a note
 * (a balance, a rate, a term of 180 to 360 months, sometimes ten years of
 * interest only), its original value from a sales price and an appraisal,
 * its units and occupancy, sometimes ARM rate changes or a modification with
 * forborne principal, borrower-paid MI on a monthly, annual or single
 * premium (or lender-paid), and a ledger of installments and receipts. Each
 * is a loan that could exist: no more borrowed than the property may borrow
 * (a second home 90%, an investment property 85% and only as a one-unit
 * purchase), a certificate effective between closing and the first payment,
 * no more than 30% of a modification forborne. The amortization is built
 * first, with no dates, and the trigger it gives is placed on a date the
 * edge wants; the note's dates are worked back from it. The evaluation date
 * is drawn apart from the trigger, up to thirteen months either side, and
 * the ledger runs back from it by a span of its own: neither says where the
 * trigger fell. Then the task is aimed, in turn by index, at one edge:
 *   - threshold: the 78% threshold on a row's scheduled balance to the cent,
 *     a cent either side of it, or half a cent under a row's balance, which
 *     only rounding half up puts on that row;
 *   - midpoint: the 78% row a payment either side of the midpoint, on
 *     interest-only loans and modifications; and a sweep the day before;
 *   - applicability: consummated 1999-07-28 or 29, a second home against an
 *     investment property, one unit against two to four, before 1999;
 *   - arm: one or two rate changes, up or down, re-amortized from the
 *     scheduled balance over the rows the note has left;
 *   - modification: a modification with forborne principal, its own 78% row
 *     and its own midpoint;
 *   - current: the month before the trigger paid on its last day, or on the
 *     trigger; February in a leap year as the test month;
 *   - cure: one to three months behind, cured on the trigger, on a month's
 *     last day, on a 1st, by partial or double receipts, in two steps, or
 *     never (each in turn by index); an older arrear caught up on the test
 *     month's last day;
 *   - refund: an annual premium on its anniversary, a day after it, and 365
 *     days into a coverage year with a 29 February; a single premium on a row
 *     of its refund schedule and a month short of one; a monthly premium
 *     (each in turn by index, the certificate's date chosen to land it);
 *   - request_ltv: a request whose evaluation balance is 80.00% (70.00% for
 *     two to four units or an investment property; 75.00% or 80.00% of a
 *     current value) in floored basis points, a basis point either side, at
 *     the top and the bottom of the basis point; deferred and forborne
 *     principal in the balance; a curtailment posted after the request;
 *   - request_history: a 30-day late in the last 12 months and a 60-day late
 *     in the 12 before, each alone, at 29 and 30 days, 59 and 60, February
 *     in a leap year; disaster exclusions; a 60-day late on a loan younger
 *     than 24 months; not current at the request, or current to the day; an
 *     installment 30 days late due on the request date (outside the windows)
 *     or due earlier that month and satisfied after it (inside them);
 *   - request_value: an AVM below, at and above the original value, or none;
 *     a borrower-paid valuation; the 120th day after delivery and the 121st;
 *     the current-value path with a valuation and without one (each in turn
 *     by index), by seasoning (23, 24, 59, 60 months), class and improvements;
 *   - lender_paid: the options notice.
 * Effective dates on 1sts before federal holidays, which the business-day
 * clocks step over, are drawn throughout.
 *
 * What v1 leaves out is in docs/environments.md. `pmiInScope` runs on the
 * engine's own outputs and keeps a task only when the engine does nothing in
 * it that its spec calls wrong; the generator aims around all of those
 * regions, so it is a guard, not a filter. A task is then kept only once the
 * reference, working through the tools, lands exactly where the engine does;
 * the tests hold both to zero misses on unfiltered draws.
 */

import {
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  isLeapYear,
  isWeekend,
  parts,
  plainDate,
  servicer,
  ymd,
  type Calendar,
  type PlainDate,
} from "@hm/kernel/calendar";
import { monthlyInterest, ratePercent, type Cents } from "@hm/kernel/money";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  analyzePmi,
  anniversaryOnOrBefore,
  expectedPmi,
  gradePmiAgainst,
  midpointOf,
  parsePmiSubmission,
  propertyClassOf,
  scheduleVersions,
  type ScheduleTermsOf,
} from "./grader.js";
import {
  currentValueThresholdBps,
  ltvBps,
  originalValue,
  originalValueThresholdBps,
  paymentHistory,
  seasoningMonths,
} from "./ported/cancellation.js";
import {
  scheduledDateForPct,
  scheduledUpb,
  thresholdCents,
  type ScheduleVersion,
} from "./ported/schedule.js";
import { pendingTriggerDate, rule78Applies } from "./ported/termination.js";
import { pmiSteps } from "./reference.js";
import {
  PMI_ENVIRONMENT_NAME,
  PMI_ENVIRONMENT_VERSION,
  pmiPayload,
  type CancellationRequestFacts,
  type Ledger,
  type Mi,
  type MiPlan,
  type Modification,
  type Occupancy,
  type PmiLoan,
  type PmiTask,
  type RateChange,
} from "./task.js";
import { executePmiTool } from "./tools.js";

export const pmiTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${PMI_ENVIRONMENT_NAME}/${PMI_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const PMI_EDGES = [
  "threshold",
  "midpoint",
  "applicability",
  "arm",
  "modification",
  "current",
  "cure",
  "refund",
  "request_ltv",
  "request_history",
  "request_value",
  "lender_paid",
] as const;
export type PmiEdge = (typeof PMI_EDGES)[number];
export const pmiEdgeOf = (index: number): PmiEdge => PMI_EDGES[index % PMI_EDGES.length]!;

/* ── small helpers ─────────────────────────────────────────────────────── */

/** Dates are laid out first against this placeholder first due, then moved onto the real one. */
const PLACEHOLDER = plainDate("2000-01-01");
const monthIndex = (d: PlainDate) => parts(d).y * 12 + parts(d).m - 1;
const monthsBetween = (a: PlainDate, b: PlainDate) => monthIndex(b) - monthIndex(a);
const firstOfMonth = (d: PlainDate) => ymd(parts(d).y, parts(d).m, 1);
const dollars = (r: Rng, lo: number, hi: number): Cents =>
  BigInt(r.int(lo, hi)) * 100n + BigInt(r.int(0, 99));
const eighths = (r: Rng, lo: number, hi: number) => (r.int(lo * 8, hi * 8) / 8).toFixed(3);
const maxDate = (a: PlainDate, b: PlainDate) => (a > b ? a : b);
const minDate = (a: PlainDate, b: PlainDate) => (a < b ? a : b);
const randomDay = (r: Rng, from: PlainDate, to: PlainDate) =>
  addDays(from, r.int(0, Math.max(0, daysBetween(from, to))));

/** Weekdays only: what a count that steps over no holiday would give. */
const weekdays: Calendar = { ...servicer, isBusinessDay: (d) => !isWeekend(d) };
/** 1sts whose two- or ten-business-day clocks step over a federal holiday, or that are one. */
const HOLIDAY_FIRSTS: readonly PlainDate[] = (() => {
  const out: PlainDate[] = [];
  for (let y = 2001; y <= 2048; y++)
    for (let m = 1; m <= 12; m++) {
      const d = ymd(y, m, 1);
      if (
        addBusinessDays(d, 2, servicer) !== addBusinessDays(d, 2, weekdays) ||
        addBusinessDays(d, 10, servicer) !== addBusinessDays(d, 10, weekdays)
      )
        out.push(d);
    }
  return out;
})();

/** 1sts less than a year after a 29 February: 365 days back from one is a day short of a year. */
const LEAP_SPAN_FIRSTS: readonly PlainDate[] = (() => {
  const out: PlainDate[] = [];
  for (let y = 2001; y <= 2048; y++)
    for (let m = 1; m <= 12; m++) {
      const d = ymd(y, m, 1);
      if (addMonths(addDays(d, -365), 12) > d) out.push(d);
    }
  return out;
})();

/** The smallest original value whose 78% threshold, rounded half up, is exactly `t`. */
function ovForThreshold(t: Cents): Cents {
  let ov = (t * 100n) / 78n - 3n;
  while (thresholdCents(ov, 78) < t) ov++;
  return ov;
}

/**
 * No New York: the engine reads a New York purchase's appraisal alone as the original value, and New
 * York's own 75% stop (N.Y. Ins. Law §6503(d), spec 10.2's overlay) ends the borrower's premium with no
 * request, which nothing ported computes. `pmiInScope` refuses the state outright.
 */
const STATES = ["TX", "CA", "FL", "OH", "GA", "NC", "AZ", "CO", "WA", "IL", "PA", "NJ"];

/**
 * The most a note lends against the original value, as the spec's extract of Fannie Mae's Eligibility
 * Matrix has it (23.2): a second home 90%, an investment property 85% and only on a purchase, which a
 * two- to four-unit investment property never reaches with mortgage insurance on it; otherwise 96.5%.
 */
const maxLtvBps = (occupancy: Occupancy): number =>
  occupancy === "investment" ? 8_500 : occupancy === "second_home" ? 9_000 : 9_650;

/* ── the note and what changed it ──────────────────────────────────────── */

interface Note {
  principal: Cents;
  rate: string;
  term: number;
  io: number;
  units: number;
  occupancy: Occupancy;
  isRefi: boolean;
  ov: Cents;
}

function loanOf(n: Note, firstDue: PlainDate, consummation: PlainDate): PmiLoan {
  return {
    state: "TX",
    consummation,
    is_refinance: n.isRefi,
    sales_price_cents: n.isRefi ? null : n.ov,
    appraised_value_cents: n.ov,
    units: n.units,
    occupancy_at_origination: n.occupancy,
    original_principal_cents: n.principal,
    note_rate_pct: n.rate,
    first_payment_due: firstDue,
    io_months: n.io,
    amortizing_term_months: n.term,
  };
}

/** Rate changes and a modification, laid against a first due: payment numbers stay, the modification moves with it. */
interface Changes {
  rateChanges: RateChange[];
  mod: (Omit<Modification, "first_modified_due"> & { readonly afterMonths: number }) | null;
}

function termsOf(n: Note, c: Changes, firstDue: PlainDate): ScheduleTermsOf {
  return {
    loan: loanOf(n, firstDue, addMonths(firstDue, -2)),
    rate_changes: c.rateChanges,
    modification: c.mod
      ? {
          first_modified_due: addMonths(firstDue, c.mod.afterMonths),
          ib_upb_cents: c.mod.ib_upb_cents,
          rate_pct: c.mod.rate_pct,
          term_months: c.mod.term_months,
          forborne_principal_cents: c.mod.forborne_principal_cents,
        }
      : null,
  };
}

interface Position {
  versions: ScheduleVersion[];
  version: ScheduleVersion;
  d78: { due_date: PlainDate; n: number } | null;
  d80: { due_date: PlainDate; n: number } | null;
  midpointTermination: PlainDate;
  trigger: PlainDate;
  rule78: boolean;
}

function positionOf(terms: ScheduleTermsOf, ov: Cents): Position {
  const versions = scheduleVersions(terms);
  const version = versions[versions.length - 1]!;
  const d78 = scheduledDateForPct(version, ov, 78);
  const d80 = scheduledDateForPct(version, ov, 80);
  const mp = midpointOf(terms);
  const l = terms.loan;
  const rule78 = rule78Applies({
    consummation: l.consummation,
    units: l.units,
    occupancy_at_origination: l.occupancy_at_origination,
  });
  return {
    versions,
    version,
    d78,
    d80,
    midpointTermination: mp.midpoint_termination_date,
    trigger: pendingTriggerDate(d78?.due_date ?? null, mp.midpoint_termination_date, rule78),
    rule78,
  };
}

/** A modification first due before the note's own 78% date and its midpoint termination, whatever the rule. */
function modificationInTime(note: ScheduleTermsOf, m: Modification, ov: Cents): boolean {
  const p = positionOf(note, ov);
  return (
    (p.d78 === null || m.first_modified_due < p.d78.due_date) &&
    m.first_modified_due < p.midpointTermination
  );
}

/**
 * Whether the schedule is one v1 grades: every rate change before the 78% row
 * and the midpoint of the schedule then in effect, no rate change on an
 * interest-only note, a modification before the note's own 78% date and
 * midpoint with no more than 30% of its gross balance forborne (the Flex
 * Modification's cap), a 78% row that is not a schedule's last, and an
 * original LTV above 80% and within what the property may borrow.
 */
function scheduleSound(n: Note, c: Changes, ov: Cents): boolean {
  if (n.principal * 100n <= ov * 80n) return false;
  if (n.principal * 10_000n > ov * BigInt(maxLtvBps(n.occupancy))) return false;
  if (n.occupancy === "investment" && (n.units !== 1 || n.isRefi)) return false;
  if (c.mod && c.mod.forborne_principal_cents * 7n > c.mod.ib_upb_cents * 3n) return false;
  if (c.rateChanges.length > 0 && (n.io > 0 || c.mod)) return false;
  const terms = termsOf(n, c, PLACEHOLDER);
  const p = positionOf(terms, ov);
  for (let i = 0; i < c.rateChanges.length; i++) {
    const k = c.rateChanges[i]!.payment_number;
    const before = scheduledDateForPct(p.versions[i]!, ov, 78);
    if (!before || before.n <= k) return false;
    if (addMonths(PLACEHOLDER, k - 1) >= p.midpointTermination) return false;
  }
  if (c.mod && !modificationInTime({ ...terms, modification: null }, terms.modification!, ov))
    return false;
  const lastRow = p.version.rows[p.version.rows.length - 1]!.n;
  if (!p.d78 || p.d78.n >= lastRow - 1) return false;
  // The first row of an interest-only note's amortization starts above the threshold.
  return (
    p.version.rows[0]!.upb_after_cents + p.version.forborne_principal_cents > thresholdCents(ov, 78)
  );
}

function drawNote(
  r: Rng,
  o: { io?: boolean; units?: number; occupancy?: Occupancy; isRefi?: boolean } = {},
): Note {
  const io = o.io ? 120 : 0;
  const term = io
    ? 240
    : r.weighted<number>([
        [360, 62],
        [300, 10],
        [240, 10],
        [180, 18],
      ]);
  const rate = io ? eighths(r, 4, 8) : eighths(r, 2.75, 8);
  const principal = dollars(r, 80_000, 950_000);
  let units = o.units ?? 1;
  let occupancy: Occupancy = o.occupancy ?? "principal";
  if (o.units === undefined && o.occupancy === undefined) {
    const kind = r.weighted<string>([
      ["1p", 80],
      ["1s", 8],
      ["1i", 7],
      ["np", 5],
    ]);
    units = kind.startsWith("1") ? 1 : r.int(2, 4);
    occupancy = kind.endsWith("p")
      ? "principal"
      : kind.endsWith("s")
        ? "second_home"
        : "investment";
  }
  const ltv = r.int(8_100, maxLtvBps(occupancy)) / 10_000;
  const ov = BigInt(Math.round(Number(principal) / ltv));
  return {
    principal,
    rate,
    term,
    io,
    units,
    occupancy,
    // An investment property carries mortgage insurance only on a purchase.
    isRefi: occupancy === "investment" ? false : (o.isRefi ?? r.chance(0.25)),
    ov,
  };
}

function drawRateChanges(r: Rng, n: Note): RateChange[] {
  const k1 = r.pick([37, 61, 61, 85, 121]);
  const step = () => (r.chance(0.6) ? 1 : -1) * (r.int(2, 20) / 8);
  const rate1 = Math.max(2, Number(n.rate) + step());
  const out: RateChange[] = [{ payment_number: k1, new_rate_pct: rate1.toFixed(3) }];
  if (r.chance(0.4)) {
    const rate2 = Math.max(2, rate1 + step());
    out.push({ payment_number: k1 + r.pick([12, 12, 24, 60]), new_rate_pct: rate2.toFixed(3) });
  }
  // Every change falls well inside the note's rows.
  return out.filter((c) => c.payment_number < n.io + n.term - 24);
}

function drawMod(r: Rng, n: Note): Changes["mod"] {
  const note = positionOf(termsOf(n, { rateChanges: [], mod: null }, PLACEHOLDER), n.ov);
  const triggerRow = monthsBetween(PLACEHOLDER, note.trigger) + 1;
  if (triggerRow < 48) return null;
  const afterMonths = r.int(24, triggerRow - 13);
  const v0 = note.version;
  const before = v0.rows.find((x) => x.n === afterMonths)!.upb_after_cents;
  const gross = (before * BigInt(r.int(103, 115))) / 100n;
  const forborne = r.chance(0.25) ? 0n : ((gross * BigInt(r.int(5, 30))) / 100n / 100n) * 100n;
  const total = n.io + n.term;
  const remaining = total - afterMonths;
  const term = r.weighted<number>([
    [480, 60],
    [360, 25],
    [remaining - (remaining % 2), 15],
  ]);
  return {
    afterMonths,
    ib_upb_cents: gross - forborne,
    rate_pct: eighths(r, 2, 7),
    term_months: Math.max(120, term),
    forborne_principal_cents: forborne,
  };
}

/* ── aiming the threshold ──────────────────────────────────────────────── */

type ThresholdAim = "on" | "cent_below" | "cent_above" | "half_cent";

/** Row `row`'s balance plus forborne principal on the schedule in effect, or null when it has no such row. */
function rowBalance(n: Note, c: Changes, row: number): Cents | null {
  const versions = scheduleVersions(termsOf(n, c, PLACEHOLDER));
  const v = versions[versions.length - 1]!;
  const at = v.rows.find((x) => x.n === row);
  return at ? at.upb_after_cents + v.forborne_principal_cents : null;
}

/**
 * The original value that puts the 78% threshold on row `row`'s balance (plus forborne), or a cent
 * either side; or, for half a cent, exactly half a cent under it. Original value × 78 = 100·B − 50
 * makes B the threshold rounded half up and B − 1 rounded down, and with B odd (B ≡ 59, mod 78) half
 * to even rounds down too: so only rounding half up finds row `row`. The balance a row lands on is the
 * schedule's, so the principal (the modification's balance, on a modification) is moved a cent at a
 * time until it does; `n` and `c` carry the move.
 */
function aimThreshold(n: Note, c: Changes, row: number, aim: ThresholdAim): Cents | null {
  if (aim === "half_cent") {
    for (let k = 0; k < 2_000; k++) {
      const delta = BigInt(k % 2 === 0 ? k / 2 : -(k + 1) / 2);
      const nn: Note = c.mod ? n : { ...n, principal: n.principal + delta };
      const cc: Changes = c.mod
        ? { ...c, mod: { ...c.mod, ib_upb_cents: c.mod.ib_upb_cents + delta } }
        : c;
      const B = rowBalance(nn, cc, row);
      if (B === null) return null;
      if (B % 78n !== 59n) continue;
      n.principal = nn.principal;
      c.mod = cc.mod;
      return (100n * B - 50n) / 78n;
    }
    return null;
  }
  const B = rowBalance(n, c, row);
  if (B === null) return null;
  return ovForThreshold(B + (aim === "cent_below" ? -1n : aim === "cent_above" ? 1n : 0n));
}

/* ── the ledger ────────────────────────────────────────────────────────── */

interface Pay {
  readonly on: PlainDate;
  readonly amount: Cents;
}

/** Receipts that pay installment i on date dates[i] (never earlier than the one before), merged or split as drawn. */
function receiptsFor(
  r: Rng,
  dues: readonly PlainDate[],
  dates: readonly (PlainDate | null)[],
  A: Cents,
  o: { partials?: number } = {},
): Pay[] {
  const pays: Pay[] = [];
  let i = 0;
  while (i < dues.length) {
    const on = dates[i];
    if (!on) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < dues.length && dates[j + 1] === on) j++;
    const count = BigInt(j - i + 1);
    if (r.chance(0.55)) pays.push({ on, amount: A * count });
    else for (let k = i; k <= j; k++) pays.push({ on, amount: A });
    i = j + 1;
  }
  // Partials: one receipt split in two, the first too small to satisfy anything on its own.
  for (let k = 0; k < (o.partials ?? 0) && pays.length > 0; k++) {
    const at = r.int(0, pays.length - 1);
    const p = pays[at]!;
    const first = (A * BigInt(r.int(20, 80))) / 100n;
    const earlier = addDays(p.on, -r.int(1, 9));
    if ((at > 0 && earlier <= pays[at - 1]!.on) || earlier < dues[0]!) continue;
    pays.splice(at, 1, { on: earlier, amount: first }, { on: p.on, amount: p.amount - first });
  }
  return pays.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}

/** Pay dates that never run backwards: each at least the one before it. */
function monotone(dates: (PlainDate | null)[]): (PlainDate | null)[] {
  let last: PlainDate | null = null;
  return dates.map((d) => {
    if (d === null) return null;
    const out = last && d < last ? last : d;
    last = out;
    return out;
  });
}

function ledgerOf(
  dues: readonly PlainDate[],
  A: Cents,
  pays: readonly Pay[],
  asOf: PlainDate,
): Ledger {
  return {
    from: dues[0]!,
    installments: dues.map((due_date) => ({ due_date, amount_cents: A })),
    receipts: pays
      .filter((p) => p.on <= asOf)
      .map((p) => ({ received_on: p.on, amount_cents: p.amount })),
  };
}

const duesBetween = (from: PlainDate, through: PlainDate): PlainDate[] => {
  const out: PlainDate[] = [];
  for (let d = from; d <= through; d = addMonths(d, 1)) out.push(d);
  return out;
};

/* ── the MI ────────────────────────────────────────────────────────────── */

type RefundAim = "on" | "day_after" | "full_year" | "boundary" | "month_short" | "none";

/**
 * The MI as certified: its effective date any day from consummation to the day before the first
 * payment, and a single premium's refund schedule a row every twelve months in force from 0.
 */
function drawMi(r: Rng, n: Note, plan: MiPlan, consummation: PlainDate, firstDue: PlainDate): Mi {
  const annualBps = BigInt(r.int(25, 120));
  const monthly = (n.principal * annualBps + 60_000n) / 120_000n;
  const coverage_start = randomDay(r, consummation, addDays(firstDue, -1));
  if (plan === "monthly" || plan === "lender_paid")
    return { plan, premium_cents: monthly, coverage_start };
  if (plan === "annual") return { plan, premium_cents: monthly * 12n, coverage_start };
  const premium = (n.principal * BigInt(r.int(125, 375))) / 10_000n;
  return { plan, premium_cents: premium, coverage_start, refund_schedule: refundSchedule(r) };
}

/** A single premium's refund schedule: a row every 12 months in force from 0, falling to nothing. */
function refundSchedule(r: Rng): Mi["refund_schedule"] {
  const rows: { months_in_force_from: number; refund_pct: string }[] = [
    { months_in_force_from: 0, refund_pct: (r.int(8_500, 9_800) / 100).toFixed(2) },
  ];
  let pct = Number(rows[0]!.refund_pct);
  for (let m = 12; m <= 240; m += 12) {
    pct = Math.max(0, pct - r.int(300, 900) / 100);
    rows.push({ months_in_force_from: m, refund_pct: pct.toFixed(2) });
  }
  return rows;
}

/**
 * The certificate's effective date that lands E where the aim wants, chosen among the days from
 * consummation to the day before the first payment, the only days a certificate takes effect; null
 * when none of them does. The effective date is never moved for it.
 */
function aimRefund(
  r: Rng,
  mi: Mi,
  E: PlainDate,
  consummation: PlainDate,
  firstDue: PlainDate,
  aim: RefundAim,
): Mi | null {
  if (aim === "none" || mi.plan === "monthly" || mi.plan === "lender_paid") return mi;
  const lands = (start: PlainDate): boolean => {
    if (mi.plan === "single") {
      // Rows fall every twelve months in force: on one, or a month short of one.
      const months = seasoningMonths(start, E);
      return aim === "boundary" ? months % 12 === 0 : aim === "month_short" && months % 12 === 11;
    }
    const days = daysBetween(anniversaryOnOrBefore(start, E), E);
    return aim === "on" ? days === 0 : aim === "day_after" ? days === 1 : days === 365;
  };
  const starts: PlainDate[] = [];
  for (let d = consummation; d < firstDue; d = addDays(d, 1)) if (lands(d)) starts.push(d);
  return starts.length ? { ...mi, coverage_start: r.pick(starts) } : null;
}

/* ── a sweep: the trigger, the ledger around it, and the MI ────────────── */

type SweepAim = "on_time" | "last_day" | "on_trigger" | "behind" | "nothing_yet";
const CURE_AIMS = ["on_trigger", "month_end", "first", "random", "two_steps", "never"] as const;
type CureAim = (typeof CURE_AIMS)[number];
/** How far, in days, the evaluation date may fall from the trigger (or the catch-up) either way. */
const SWEEP_SPAN = 400;

interface Coordinates {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
}

/** The refund edge's plans and aims, taken in turn by index: a draw that misses its aim is drawn again for the same one. */
const REFUND_ARMS: readonly (readonly [MiPlan, RefundAim | null])[] = [
  ["annual", "on"],
  ["single", "boundary"],
  ["annual", "full_year"],
  ["monthly", null],
  ["annual", "day_after"],
  ["single", "month_short"],
  ["annual", "full_year"],
  ["monthly", null],
];

function trySweep(r: Rng, edge: PmiEdge, c: Coordinates): PmiTask | null {
  // The refund edge settles its plan and aim first: a coverage year with a 29 February in it needs
  // its trigger placed for it.
  const [refundPlan, refundAim] =
    edge === "refund"
      ? REFUND_ARMS[Math.floor(c.index / PMI_EDGES.length) % REFUND_ARMS.length]!
      : [null, null];
  // 1. The note, as the edge wants it.
  let applicability: "boundary" | "pre1999" | "occupancy" | "units" | null = null;
  let o: Parameters<typeof drawNote>[1] = {};
  if (edge === "applicability") {
    applicability = r.pick(["boundary", "boundary", "pre1999", "occupancy", "units"] as const);
    if (applicability === "occupancy")
      o = { units: 1, occupancy: r.pick(["second_home", "investment"] as const) };
    if (applicability === "units") o = { units: r.int(1, 4), occupancy: "principal" };
    if (applicability === "boundary" || applicability === "pre1999")
      o = { units: 1, occupancy: "principal" };
  }
  if (edge === "lender_paid") o = { units: 1, occupancy: "principal" };
  const midIo = edge === "midpoint" && r.chance(0.6);
  if (
    midIo ||
    (edge !== "arm" && edge !== "applicability" && edge !== "midpoint" && r.chance(0.06))
  )
    o = { ...o, io: true };
  const n = drawNote(r, o);

  // 2. What changed the schedule.
  const ch: Changes = { rateChanges: [], mod: null };
  if (n.io === 0 && (edge === "arm" || (edge !== "applicability" && r.chance(0.07))))
    ch.rateChanges = drawRateChanges(r, n);
  if (
    ch.rateChanges.length === 0 &&
    n.io === 0 &&
    (edge === "modification" || (edge === "midpoint" && !midIo) || r.chance(0.05))
  )
    ch.mod = drawMod(r, n);
  if ((edge === "modification" || (edge === "midpoint" && !midIo)) && !ch.mod) return null;

  // 3. The original value: on a row, or near the midpoint, as aimed.
  if (edge === "threshold" || r.chance(0.08)) {
    const aim = r.pick(["on", "on", "cent_below", "cent_above", "half_cent"] as const);
    const p = positionOf(termsOf(n, ch, PLACEHOLDER), n.ov);
    if (!p.d78) return null;
    const row = p.d78.n + r.int(-1, 1);
    const ov = aimThreshold(n, ch, row, aim);
    if (ov === null) return null;
    n.ov = ov;
  }
  if (edge === "midpoint") {
    // Row term ÷ 2 + 1 falls due on the midpoint termination itself: a row before it triggers first,
    // a row after it does not.
    const term = ch.mod ? ch.mod.term_months : n.io + n.term;
    const row = 1 + term / 2 + r.pick([-2, -1, 1, 2, 3]);
    if (ch.mod) {
      // The forborne principal that puts the threshold on that row of the modification.
      const terms = termsOf(
        n,
        { ...ch, mod: { ...ch.mod, forborne_principal_cents: 0n } },
        PLACEHOLDER,
      );
      const v = positionOf(terms, n.ov).version;
      const at = v.rows.find((x) => x.n === row);
      if (!at) return null;
      const forborne = thresholdCents(n.ov, 78) - at.upb_after_cents;
      // No more than 30% of the gross balance forborne, the Flex Modification's cap (scheduleSound holds it).
      if (forborne < 0n || forborne * 7n > ch.mod.ib_upb_cents * 3n) return null;
      ch.mod = { ...ch.mod, forborne_principal_cents: forborne };
    } else {
      const ov = aimThreshold(n, ch, row, r.chance(0.8) ? "on" : "cent_below");
      if (ov === null) return null;
      n.ov = ov;
    }
  }
  if (!scheduleSound(n, ch, n.ov)) return null;

  // 4. Where the trigger falls, counted from the first due. The rule's reach decides the trigger, so
  // the consummation is settled first where the edge sets it.
  let consummation: PlainDate | null = null;
  let firstDue: PlainDate;
  if (applicability === "boundary")
    consummation = plainDate(r.chance(0.5) ? "1999-07-28" : "1999-07-29");
  if (applicability === "pre1999") consummation = addDays(plainDate("1995-01-01"), r.int(0, 1630));
  const triggerOffset = (cons: PlainDate) => {
    const p = positionOf(
      { ...termsOf(n, ch, PLACEHOLDER), loan: { ...loanOf(n, PLACEHOLDER, cons) } },
      n.ov,
    );
    return monthsBetween(PLACEHOLDER, p.trigger);
  };
  let sweepAim: SweepAim = "on_time";
  let leapFeb = false;
  if (consummation) {
    firstDue = addMonths(firstOfMonth(consummation), 2);
  } else {
    // The trigger's month, worked back to a first due between 2000 and late 2026.
    const offset = triggerOffset(plainDate("2005-06-15"));
    const lo = monthIndex(plainDate("2000-03-01"));
    const hi = monthIndex(plainDate("2026-11-01"));
    const fits = (T: PlainDate) => {
      const f = monthIndex(T) - offset;
      return f >= lo && f <= hi;
    };
    let T: PlainDate | null = null;
    if (edge === "current" && r.chance(0.4)) {
      const leap = [2012, 2016, 2020, 2024, 2028, 2032, 2036, 2040, 2044, 2048]
        .map((y) => ymd(y, 3, 1))
        .filter(fits);
      if (leap.length) {
        T = r.pick(leap);
        leapFeb = true;
      }
    }
    if (edge === "refund" && refundAim === "full_year") {
      // A 1st less than a year after a 29 February: a coverage year 365 days back still has a day to run.
      const leapSpan = LEAP_SPAN_FIRSTS.filter(fits);
      if (leapSpan.length) T = r.pick(leapSpan);
    }
    if (!T && r.chance(0.25)) {
      const hol = HOLIDAY_FIRSTS.filter(fits);
      if (hol.length) T = r.pick(hol);
    }
    firstDue = T ? addMonths(T, -offset) : addMonths(plainDate("2000-03-01"), r.int(0, hi - lo));
  }
  if (!consummation) {
    const { y, m } = parts(addMonths(firstDue, -2));
    consummation = ymd(y, m, r.int(1, 28));
  }

  // 5. The task's terms on their dates.
  const terms = termsOf(n, ch, firstDue);
  const loan: PmiLoan = { ...loanOf(n, firstDue, consummation) };
  const pos = positionOf({ ...terms, loan }, n.ov);
  const T = pos.trigger;
  const modDue = terms.modification?.first_modified_due ?? null;

  // 6. The ledger and the evaluation date.
  const A = pos.version.pi_cents + BigInt(r.int(150, 950)) * 100n;
  if (edge === "current")
    sweepAim = r.pick(["last_day", "last_day", "on_trigger", "on_time"] as const);
  else if (edge === "cure") sweepAim = "behind";
  else if (
    (edge === "threshold" ||
      edge === "midpoint" ||
      edge === "arm" ||
      edge === "modification" ||
      edge === "lender_paid") &&
    r.chance(0.12)
  )
    sweepAim = "nothing_yet";
  else if (edge !== "lender_paid" && r.chance(0.18))
    sweepAim = r.pick(["behind", "last_day", "on_trigger"] as const);
  if (leapFeb && sweepAim === "on_time") sweepAim = "last_day";

  const testFirst = addMonths(T, -1);
  const testEnd = addDays(T, -1);
  const behind =
    sweepAim === "behind"
      ? r.weighted<number>([
          [1, 50],
          [2, 35],
          [3, 15],
        ])
      : 0;
  // The cure edge takes its aims in turn, so a suite of 200 has each of them.
  const cureAim: CureAim | null =
    sweepAim !== "behind"
      ? null
      : edge === "cure"
        ? CURE_AIMS[Math.floor(c.index / PMI_EDGES.length) % CURE_AIMS.length]!
        : r.weighted<CureAim>([
            ["on_trigger", 18],
            ["month_end", 18],
            ["first", 16],
            ["random", 20],
            ["two_steps", 14],
            ["never", 14],
          ]);
  const lateFirst = addMonths(testFirst, -(behind > 0 ? behind - 1 : 0));
  // Two or more behind, the oldest arrear sometimes caught up on the test month's last day itself: on
  // time for the test, while the installments after it are not.
  const oldestOnTestEnd = behind >= 2 && cureAim !== "two_steps" && r.chance(0.3);

  // The catch-up date for a loan behind; one that never catches up keeps paying a month at a time,
  // as far behind as it fell.
  let cure: PlainDate | null = null;
  if (cureAim === "on_trigger") cure = T;
  if (cureAim === "month_end") cure = endOfMonth(addMonths(T, r.int(0, 1)));
  if (cureAim === "first") cure = addMonths(T, r.int(1, 2));
  if (cureAim === "random" || cureAim === "two_steps") cure = addDays(T, r.int(1, 70));

  // The evaluation date, drawn apart from the trigger: a sweep any day up to thirteen months after it
  // (after the catch-up, on a loan that caught up), and a review that comes first any day up to
  // thirteen months before. The ledger runs back from the evaluation date by a span of its own. So
  // neither the date nor the ledger's first month says where the trigger fell: that is the schedule's.
  const lastChange = ch.rateChanges.length
    ? addMonths(firstDue, ch.rateChanges[ch.rateChanges.length - 1]!.payment_number - 1)
    : null;
  let asOf: PlainDate;
  if (sweepAim === "nothing_yet") {
    const floor = maxDate(
      addMonths(firstDue, 6),
      maxDate(modDue ?? firstDue, lastChange ?? firstDue),
    );
    const room = daysBetween(floor, T) - 1;
    if (room < 1) return null;
    asOf = r.chance(0.25) ? addDays(T, -1) : addDays(T, -r.int(1, Math.min(SWEEP_SPAN, room)));
  } else asOf = addDays(cure ?? T, r.int(0, SWEEP_SPAN));
  let from = addMonths(firstOfMonth(asOf), -r.int(12, 24));
  // A ledger starts no earlier than the payments its installments are: the note's first, the
  // modification's, the last rate change's.
  for (const d of [firstDue, modDue, lastChange]) if (d) from = maxDate(from, d);
  if (sweepAim !== "nothing_yet" && from > lateFirst) return null;

  const dues = duesBetween(from, asOf);
  // Each installment on time (within its own month) unless the aim says otherwise; never earlier
  // than the one before it, as a ledger applied oldest first would show it.
  const dates = monotone(
    dues.map((due): PlainDate => {
      if (sweepAim === "last_day" && due === testFirst) return testEnd;
      if (sweepAim === "on_trigger" && due === testFirst) return T;
      if (sweepAim === "on_trigger" && due === T)
        return r.chance(0.5) ? T : addDays(T, r.int(1, 20));
      if (sweepAim === "behind" && due >= lateFirst) {
        if (oldestOnTestEnd && due === lateFirst) return testEnd;
        // Never caught up: each installment paid as many months late as the loan fell behind.
        if (cureAim === "never") return addDays(addMonths(due, behind), r.int(0, 12));
        if (cure && due <= cure) {
          // The two-step cure: the oldest arrear paid first, the rest when the catch-up comes.
          if (cureAim === "two_steps" && due === lateFirst)
            return minDate(addDays(T, r.int(0, 12)), addDays(cure, -1));
          return cure;
        }
      }
      return addDays(due, r.int(-6, 12));
    }),
  );
  const pays = receiptsFor(r, dues, dates, A, {
    partials: sweepAim === "behind" || r.chance(0.1) ? r.int(0, 2) : 0,
  });
  const ledger = ledgerOf(dues, A, pays, asOf);

  // 7. The MI, and the refund aimed at the effective date.
  const plan: MiPlan =
    edge === "lender_paid"
      ? "lender_paid"
      : (refundPlan ??
        r.weighted<MiPlan>([
          ["monthly", 45],
          ["annual", 35],
          ["single", 20],
        ]));
  let mi = drawMi(r, n, plan, consummation, firstDue);
  const state = r.pick(STATES);
  let sp = n.isRefi ? null : n.ov;
  let ap = n.ov;
  if (!n.isRefi) {
    const other = n.ov + (n.ov * BigInt(r.int(2, 50))) / 1000n;
    const which = r.weighted<string>([
      ["sp_lower", 40],
      ["equal", 20],
      ["ap_lower", 40],
    ]);
    if (which === "sp_lower") ap = other;
    if (which === "ap_lower") sp = other;
  }
  const draft: PmiTask = {
    ...c,
    as_of: asOf,
    loan: { ...loan, state, sales_price_cents: sp, appraised_value_cents: ap },
    rate_changes: terms.rate_changes,
    modification: terms.modification,
    mi,
    ledger,
    request: null,
  };
  const E = effectiveOf(draft);
  if (E) {
    const aim: RefundAim =
      refundAim ??
      (plan === "single"
        ? r.pick(["boundary", "month_short", "none"] as const)
        : plan === "annual" && r.chance(0.3)
          ? r.pick(["on", "day_after", "full_year", "none"] as const)
          : "none");
    const aimed = aimRefund(r, mi, E, consummation, firstDue, aim);
    // The refund edge is drawn again when no certificate date lands its aim; any other keeps its own.
    if (!aimed && edge === "refund") return null;
    mi = aimed ?? mi;
  } else if (edge === "refund" && refundAim !== null) return null;
  return { ...draft, mi };
}

/* ── a request ─────────────────────────────────────────────────────────── */

type LtvAim = "bottom" | "top" | "inside";

/**
 * request_value's arms, taken in turn by index so that a suite of 200 holds each of them: the AVM
 * above, at or below the original value or none, a borrower's paid valuation, the 120th day after
 * delivery and the 121st, and the current-value path with a valuation and without one.
 */
const VALUE_ARMS = [
  "avm_above",
  "cv",
  "avm_equal",
  "cv",
  "avm_below",
  "expiry_120",
  "cv",
  "avm_none",
  "bpo",
  "cv_none",
  "cv",
  "expiry_121",
] as const;

type HistoryAim =
  "b" | "a" | "both" | "disaster" | "young" | "not_current" | "last_day" | "in_month" | "clean";

function tryRequest(r: Rng, edge: PmiEdge, c: Coordinates): PmiTask | null {
  // 1. The property and the path.
  const arm =
    edge === "request_value"
      ? VALUE_ARMS[Math.floor(c.index / PMI_EDGES.length) % VALUE_ARMS.length]!
      : null;
  const path: "original_value" | "current_value" = (
    arm === null
      ? r.chance(edge === "request_ltv" ? 0.25 : 0.1)
      : arm === "cv" || arm === "cv_none" || (arm.startsWith("expiry") && r.chance(0.5))
  )
    ? "current_value"
    : "original_value";
  const kind = r.weighted<string>([
    ["1p", 70],
    ["1s", 10],
    ["np", 12],
    ["1i", 8],
  ]);
  const units = kind.startsWith("1") ? 1 : r.int(2, 4);
  const occupancy: Occupancy = kind.endsWith("p")
    ? "principal"
    : kind.endsWith("s")
      ? "second_home"
      : "investment";
  const n = drawNote(r, { units, occupancy, io: r.chance(0.05) });
  const ch: Changes = { rateChanges: [], mod: null };
  if (n.io === 0 && r.chance(0.08)) ch.rateChanges = drawRateChanges(r, n);
  else if (n.io === 0 && r.chance(0.07)) ch.mod = drawMod(r, n);
  if (!scheduleSound(n, ch, n.ov)) return null;

  // 2. The dates: a first due, a consummation two months before it, and the request.
  const firstDue = addMonths(plainDate("2004-01-01"), r.int(0, 264));
  const { y: cy, m: cm } = parts(addMonths(firstDue, -2));
  let consummation = ymd(cy, cm, r.int(1, 28));
  if (r.chance(0.04) && isLeapYear(cy) && cm === 2) consummation = ymd(cy, 2, 29);
  const terms = termsOf(n, ch, firstDue);
  const loan = loanOf(n, firstDue, consummation);
  const pos = positionOf({ ...terms, loan }, n.ov);
  const pc = propertyClassOf(loan);
  const modDue = terms.modification?.first_modified_due ?? null;
  const lastChange = ch.rateChanges.length
    ? addMonths(firstDue, ch.rateChanges[ch.rateChanges.length - 1]!.payment_number - 1)
    : null;
  const earliest = maxDate(
    addMonths(firstDue, 6),
    maxDate(lastChange ?? firstDue, modDue ? addMonths(modDue, 3) : firstDue),
  );
  // The request comes before the trigger and, on the one-unit class, before the scheduled 80% date on
  // either path: after it the original-value path, which the spec evaluates first, grants on the
  // schedule alone, and the engine never looks.
  let latest = addMonths(pos.trigger, -3);
  if (pc === "1u_principal_or_second" && pos.d80)
    latest = minDate(latest, addMonths(pos.d80.due_date, -3));
  if (earliest >= latest) return null;

  // The loan's age at the request: aimed at the seasoning lines or the young-loan windows; and the
  // payment history the request is aimed at.
  const ageAim =
    path === "current_value" && r.chance(0.55)
      ? r.pick([23, 24, 24, 59, 60, 60])
      : edge === "request_history" && r.chance(0.25)
        ? r.int(13, 23)
        : null;
  const historyAim: HistoryAim =
    edge === "request_history"
      ? ageAim !== null
        ? "young"
        : r.pick([
            "b",
            "b",
            "a",
            "a",
            "a",
            "both",
            "disaster",
            "disaster",
            "not_current",
            "last_day",
            "in_month",
            "in_month",
          ] as const)
      : r.chance(0.12)
        ? r.pick(["b", "a", "not_current", "last_day", "in_month"] as const)
        : "clean";
  let received: PlainDate;
  if (ageAim !== null) {
    received = addMonths(consummation, ageAim);
    if (r.chance(0.3)) received = addDays(received, -1);
  } else received = randomDay(r, earliest, latest);
  if (historyAim === "in_month") {
    // A month of 31 days: its installment paid on its last day is exactly 30 days late. Received on
    // its 1st, that installment is due on the request date and outside both windows; received later in
    // the month, it is inside them, satisfied after the date they end on.
    const month =
      parts(endOfMonth(received)).d === 31
        ? firstOfMonth(received)
        : addMonths(firstOfMonth(received), 1);
    const { y, m } = parts(month);
    received = r.chance(0.5) ? month : ymd(y, m, r.int(2, 30));
  }
  if (received < earliest || received >= latest) return null;

  // 3. The valuation and the decision date.
  const age = seasoningMonths(consummation, received);
  const improvements = path === "current_value" && pc === "1u_principal_or_second" && r.chance(0.3);
  const currentTh = currentValueThresholdBps(pc, age, improvements);
  let valuation: CancellationRequestFacts["valuation"] = null;
  let decision = addDays(received, r.int(2, 40));
  let avm: Cents | null = null;
  const ov = n.ov;
  const valueAim: string =
    arm === null
      ? r.weighted<string>([
          ["avm_above", 85],
          ["avm_equal", 5],
          ["avm_below", 5],
          ["avm_none", 5],
        ])
      : arm.startsWith("expiry")
        ? "expiry"
        : arm;
  if (path === "original_value") {
    avm =
      valueAim === "avm_none"
        ? null
        : valueAim === "avm_equal"
          ? ov
          : valueAim === "avm_below" || valueAim === "bpo" || valueAim === "expiry"
            ? (ov * BigInt(r.int(850, 999))) / 1000n
            : (ov * BigInt(r.int(1_010, 1_400))) / 1000n;
    if (valueAim === "bpo" || valueAim === "expiry") {
      const delivered = addDays(received, r.int(7, 35));
      valuation = {
        value_cents: (ov * BigInt(r.int(1_000, 1_200))) / 1000n,
        delivered_on: delivered,
      };
    }
  } else {
    // A current-value request with no threshold is never drawn without a valuation.
    const none = arm === "cv_none" || (arm === null && r.chance(0.05));
    if (none && currentTh === null) return null;
    if (!none) {
      const delivered = addDays(received, r.int(5, 30));
      valuation = { value_cents: 0n, delivered_on: delivered };
    }
  }
  if (valuation) {
    decision =
      valueAim === "expiry"
        ? addDays(valuation.delivered_on, arm === "expiry_121" ? 121 : 120)
        : addDays(valuation.delivered_on, r.int(1, 25));
  }
  // The installment of the request's own month is paid on its 31st, and the decision comes after.
  if (historyAim === "in_month")
    decision = maxDate(decision, addDays(endOfMonth(received), r.int(0, 9)));
  if (decision >= pos.trigger) return null;
  if (pc === "1u_principal_or_second" && pos.d80 && decision >= pos.d80.due_date) return null;

  // 4. The balances: the scheduled balance at the request, curtailed to the aim.
  const forborne = terms.modification?.forborne_principal_cents ?? 0n;
  const deferred = r.chance(edge === "request_ltv" ? 0.3 : 0.1)
    ? BigInt(r.int(30, 400)) * 10_000n
    : 0n;
  const scheduled = scheduledUpb(pos.version, received);
  const value = (b: bigint) => b + deferred + forborne;
  const th = path === "original_value" ? originalValueThresholdBps(pc) : currentTh;
  const bandOf = (bps: number, V: Cents, aim: LtvAim): Cents => {
    const lo = (BigInt(bps) * V + 9_999n) / 10_000n;
    const hi = (BigInt(bps + 1) * V + 9_999n) / 10_000n - 1n;
    if (aim === "bottom") return lo;
    if (aim === "top") return hi;
    return lo + BigInt(r.int(0, Number(hi - lo)));
  };
  const ltvAim = r.pick(["bottom", "top", "inside"] as const);
  let upbOnReceipt = scheduled;
  const postings: { posted_on: PlainDate; upb_after_cents: Cents }[] = [];
  if (path === "original_value") {
    // A borrower who curtailed toward the line, or one who did not.
    const target =
      edge === "request_ltv"
        ? th! + r.pick([-1, 0, 0, 1])
        : r.chance(0.6)
          ? th! - r.int(1, 900)
          : null;
    if (target !== null) {
      const evalTarget = bandOf(target, ov, edge === "request_ltv" ? ltvAim : "inside");
      const ib = evalTarget - deferred - forborne;
      if (ib <= 0n || ib > scheduled) return null;
      if (historyAim !== "in_month" && r.chance(edge === "request_ltv" ? 0.35 : 0.15)) {
        // Above the line on receipt; a curtailment after it brings it there.
        const before = bandOf(th! + r.int(5, 400), ov, "inside") - deferred - forborne;
        if (before > scheduled || before <= ib) return null;
        upbOnReceipt = before;
        postings.push({
          posted_on: randomDay(r, addDays(received, 1), decision),
          upb_after_cents: ib,
        });
      } else upbOnReceipt = ib;
    }
  }
  // The scheduled payment posted after the request, when one falls due before the decision (not on
  // the in-month aim, whose windows end on the request date).
  const nextDue = addMonths(firstOfMonth(received), 1);
  const lastBalance = postings.length
    ? postings[postings.length - 1]!.upb_after_cents
    : upbOnReceipt;
  if (
    historyAim !== "in_month" &&
    nextDue <= decision &&
    r.chance(0.3) &&
    (postings.length === 0 || postings[0]!.posted_on < nextDue)
  ) {
    const interest = monthlyInterest(lastBalance, ratePercent(rateOf(terms, received)));
    const principal = pos.version.pi_cents - interest;
    const on = addDays(nextDue, r.int(0, 5));
    if (principal > 0n && on <= decision)
      postings.push({ posted_on: on, upb_after_cents: lastBalance - principal });
  }
  // Balances only fall.
  let prev = upbOnReceipt;
  for (const p of postings) {
    if (p.upb_after_cents > prev) return null;
    prev = p.upb_after_cents;
  }
  if (path === "current_value") {
    // The original-value paths, which the spec evaluates first, fail on the balance: a borrower they
    // would grant never needs the current value (10.1 R1).
    if (ltvBps(value(prev), ov) <= originalValueThresholdBps(pc)) return null;
  }
  if (path === "current_value" && valuation) {
    // The value that puts the LTV where it is aimed, against the balance at the decision.
    const E0 = value(prev);
    const bps =
      th === null
        ? r.int(6_500, 8_500)
        : th +
          (edge === "request_ltv"
            ? r.pick([-1, 0, 0, 1])
            : r.pick([-1, 0, 0, 1, -r.int(2, 600), r.int(2, 600)]));
    const vMax = (E0 * 10_000n) / BigInt(bps);
    const vMin = (E0 * 10_000n) / BigInt(bps + 1) + 1n;
    if (vMin > vMax) return null;
    const v =
      ltvAim === "bottom"
        ? vMax
        : ltvAim === "top"
          ? vMin
          : vMin + BigInt(r.int(0, Number(vMax - vMin)));
    valuation = { ...valuation, value_cents: v };
  }

  // 5. The ledger: from two years before the later of receipt and the date the threshold was reached.
  const draftRequest: CancellationRequestFacts = {
    received_on: received,
    path,
    improvements_accepted: improvements,
    avm_cents: avm,
    valuation,
    evidence_satisfied_on: valuation?.delivered_on ?? null,
    disaster_excluded: [],
    balance: {
      upb_on_receipt_cents: upbOnReceipt,
      postings,
      deferred_principal_cents: deferred,
      forborne_principal_cents: forborne,
    },
  };
  const reached = (() => {
    if (path !== "original_value") return null;
    const meets = (ib: Cents) => ltvBps(value(ib), ov) <= th!;
    if (meets(upbOnReceipt)) return received;
    return postings.find((p) => meets(p.upb_after_cents))?.posted_on ?? null;
  })();
  const D = reached && reached > received ? reached : received;
  const bStart = addMonths(D, -Math.min(12, age));
  const aStart = addMonths(D, -Math.min(24, age));
  let from = maxDate(addMonths(firstOfMonth(aStart), -1), firstDue);
  if (modDue) from = maxDate(from, modDue);
  const dues = duesBetween(from, decision);
  const A = pos.version.pi_cents + BigInt(r.int(150, 950)) * 100n;
  const precedingEnd = addDays(firstOfMonth(received), -1);
  const testDue = firstOfMonth(precedingEnd);

  const inB = dues.filter((d) => d >= bStart && d < addMonths(D, -1) && d !== testDue);
  const inA = dues.filter((d) => d >= aStart && d < addMonths(bStart, -2));
  const lates = new Map<PlainDate, number>();
  const late = (pool: PlainDate[], days: number[]) => {
    if (pool.length === 0) return null;
    const due = r.pick(pool);
    lates.set(due, r.pick(days));
    return due;
  };
  // February counts its own days: 30 days from 02-01 is 03-02 in a leap year and 03-03 otherwise.
  const allFebruaries = inB.filter((d) => parts(d).m === 2);
  const leapFebruaries = allFebruaries.filter((d) => isLeapYear(parts(d).y));
  const februaries = leapFebruaries.length && r.chance(0.7) ? leapFebruaries : allFebruaries;
  let disaster: PlainDate[] = [];
  if (historyAim === "b" || historyAim === "both" || historyAim === "disaster") {
    const due =
      historyAim !== "disaster" && februaries.length && r.chance(0.5)
        ? late(februaries, [29, 30])
        : late(inB, historyAim === "disaster" ? [30, 35, 61] : [29, 30, 30, 31, 45, 61]);
    if (historyAim === "disaster" && due) disaster = [due];
  }
  if (historyAim === "a" || historyAim === "both") late(inA, [59, 59, 60, 60, 61, 75]);
  if (historyAim === "young") {
    // A late of about 60 days on a loan under 24 months old. The windows shortened to the loan's age
    // reach back before its first installment (the request comes after it), so the late is counted
    // either way; the age clause is restated for fidelity and never changes an answer here.
    const pool = dues.filter((d) => d < addMonths(bStart, -2));
    late(pool, [59, 60, 61, 70]);
  }
  if (historyAim === "in_month") lates.set(firstOfMonth(received), 30);
  if (historyAim === "disaster" && r.chance(0.3))
    disaster = [...disaster, r.pick(dues.filter((d) => d < D))];

  const dates = dues.map((due): PlainDate | null => {
    let on = lates.has(due) ? addDays(due, lates.get(due)!) : addDays(due, r.int(-6, 10));
    if (historyAim === "not_current" && due === testDue) on = addDays(precedingEnd, r.int(1, 8));
    // Current to the day: the month before the request paid on its own last day.
    if (historyAim === "last_day" && due === testDue) on = precedingEnd;
    // Paid by the decision: nothing due on or before it is still open then.
    return on > decision ? decision : on;
  });
  const pays = receiptsFor(r, dues, monotone(dates), A, { partials: r.chance(0.15) ? 1 : 0 });
  const ledger = ledgerOf(dues, A, pays, decision);

  // 6. The MI: borrower-paid, the plans drawn as for a sweep.
  const plan = r.weighted<MiPlan>([
    ["monthly", 50],
    ["annual", 30],
    ["single", 20],
  ]);
  let mi = drawMi(r, n, plan, consummation, firstDue);
  const state = r.pick(STATES);
  let sp = n.isRefi ? null : ov;
  let ap = ov;
  if (!n.isRefi) {
    const other = ov + (ov * BigInt(r.int(2, 50))) / 1000n;
    const which = r.pick(["sp_lower", "equal", "ap_lower"]);
    if (which === "sp_lower") ap = other;
    if (which === "ap_lower") sp = other;
  }
  const draft: PmiTask = {
    ...c,
    as_of: decision,
    loan: { ...loan, state, sales_price_cents: sp, appraised_value_cents: ap },
    rate_changes: terms.rate_changes,
    modification: terms.modification,
    mi,
    ledger,
    request: { ...draftRequest, disaster_excluded: [...new Set(disaster)].sort() },
  };
  const E = effectiveOf(draft);
  if (E && mi.plan === "single") {
    const aim = r.pick(["boundary", "month_short", "none"] as const);
    mi = aimRefund(r, mi, E, consummation, firstDue, aim) ?? mi;
  }
  return { ...draft, mi };
}

/** The effective date the engine gives a draft, before its refund terms are aimed (a monthly stand-in). */
function effectiveOf(draft: PmiTask): PlainDate | null {
  if (draft.mi.plan === "lender_paid") return null;
  const standIn: Mi = {
    plan: "monthly",
    premium_cents: 100n,
    coverage_start: draft.mi.coverage_start,
  };
  return analyzePmi({ ...draft, mi: standIn }).clocks?.effective_on ?? null;
}

/** The note rate in effect on a date: the last rate change due by then, or the modification's. */
function rateOf(terms: ScheduleTermsOf, on: PlainDate): string {
  if (terms.modification && terms.modification.first_modified_due <= on)
    return terms.modification.rate_pct;
  let rate = terms.loan.note_rate_pct;
  for (const rc of terms.rate_changes)
    if (addMonths(terms.loan.first_payment_due, rc.payment_number - 1) <= on)
      rate = rc.new_rate_pct;
  return rate;
}

/* ── the candidate, the guard, and the draw ────────────────────────────── */

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawPmiCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): PmiTask {
  const edge = pmiEdgeOf(index);
  const c = { id, split, suite_seed: suiteSeed, index };
  // A draw that misses its own edge's construction (a row the aim cannot reach, an original LTV out of
  // range, a request that cannot come before its trigger) is drawn again under the next key, inside
  // the candidate. The guard is not consulted here: the tests run it on these candidates as drawn.
  for (let k = 0; k < 400; k++) {
    const rr = k === 0 ? r : rngFor(`${id}:${edge}:${k}`);
    const t = edge.startsWith("request_") ? tryRequest(rr, edge, c) : trySweep(rr, edge, c);
    if (t) return t;
  }
  throw new Error(`${id}: no ${edge} task in 400 tries`);
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function pmiFairToGrade(task: PmiTask): boolean {
  const payload = JSON.parse(JSON.stringify(pmiPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(pmiSteps, payload, executePmiTool);
  } catch {
    return false;
  }
  const parsed = parsePmiSubmission(byRules);
  return parsed.ok && gradePmiAgainst(expectedPmi(task), parsed.answer).pass;
}

/**
 * v1's guard, run on the engine's own outputs: a task is kept only when the
 * engine does nothing in it that its spec calls wrong.
 *   - every term is even and every due date a 1st (an odd term's
 *     midpoint is a month late; the current test misses an installment
 *     due after the 1st);
 *   - no New York loan: the engine reads a New York purchase's appraisal
 *     alone, and New York's own 75% stop (10.2's overlay, 10.1 R1's path
 *     (c)) is not ported;
 *   - the original value is the lesser of price and appraisal, or the
 *     appraisal on a refinance;
 *   - every rate change falls before the 78% row and the midpoint of the
 *     schedule then in effect, none on an interest-only note, and a
 *     modification falls before the note's own 78% date and midpoint;
 *   - receipts stop at the evaluation date;
 *   - a request is decided before the trigger; on a one-unit principal
 *     residence or second home, before the scheduled 80% date, on either
 *     path (the scheduled path is never evaluated);
 *   - a current-value request's balance is above the original-value
 *     threshold (the engine evaluates only the path asked for, where 10.1
 *     R1 evaluates the original-value paths first and grants on any);
 *   - a current-value request with no threshold is never without a
 *     valuation (it asks for a paid valuation that cannot help);
 *   - no borrower-paid valuation below the original value on the
 *     original-value path (it loops back to a value check);
 *   - Fannie Mae's current test and the HPA's agree (the HPA's is
 *     computed and discarded);
 *   - a delivered valuation is the evidence, and there is no evidence
 *     without one (the evidence date is ambiguous);
 *   - the late-payment counts anchored on the request date are the ones
 *     anchored on the later threshold date (spec R5 sends SMDU the first).
 */
export function pmiInScope(task: PmiTask): boolean {
  const l = task.loan;
  const even = (n: number) => n % 2 === 0;
  if (!even(l.io_months + l.amortizing_term_months)) return false;
  if (task.modification && !even(task.modification.term_months)) return false;
  const dueDates = [
    l.first_payment_due,
    ...(task.modification ? [task.modification.first_modified_due] : []),
    ...task.ledger.installments.map((i) => i.due_date),
  ];
  if (dueDates.some((d) => parts(d).d !== 1)) return false;
  if (l.state === "NY") return false;
  const ov = originalValue({
    sales_price_cents: l.sales_price_cents,
    appraised_value_cents: l.appraised_value_cents,
    is_refinance: l.is_refinance,
    state: l.state,
  });
  const lesser = l.is_refinance
    ? l.appraised_value_cents
    : l.sales_price_cents! < l.appraised_value_cents
      ? l.sales_price_cents!
      : l.appraised_value_cents;
  if (ov !== lesser) return false;
  if (task.ledger.receipts.some((x) => x.received_on > task.as_of)) return false;

  const a = analyzePmi(task);
  const versions = a.versions;
  if (task.rate_changes.length > 0 && (l.io_months > 0 || task.modification)) return false;
  for (let i = 0; i < task.rate_changes.length; i++) {
    const k = task.rate_changes[i]!.payment_number;
    const before = scheduledDateForPct(versions[i]!, a.original_value_cents, 78);
    if (!before || before.n <= k) return false;
    if (addMonths(l.first_payment_due, k - 1) >= a.midpoint.midpoint_termination_date) return false;
    if (addMonths(l.first_payment_due, k - 1) > task.as_of) return false;
  }
  if (task.modification) {
    const note = { ...task, modification: null };
    if (!modificationInTime(note, task.modification, a.original_value_cents)) return false;
    if (task.modification.first_modified_due > task.as_of) return false;
  }

  const r = task.request;
  if (!r) return true;
  if (task.mi.plan === "lender_paid") return false;
  if (task.as_of >= a.trigger || r.received_on > task.as_of) return false;
  const pc = propertyClassOf(l);
  const d80 = scheduledDateForPct(a.version, a.original_value_cents, 80);
  if (pc === "1u_principal_or_second" && (!d80 || d80.due_date <= task.as_of)) return false;
  const req = a.request!;
  if (
    r.path === "current_value" &&
    ltvBps(req.evaluation_upb_cents, a.original_value_cents) <= originalValueThresholdBps(pc)
  )
    return false;
  const age = seasoningMonths(l.consummation, r.received_on);
  if (
    r.path === "current_value" &&
    !r.valuation &&
    currentValueThresholdBps(pc, age, r.improvements_accepted) === null
  )
    return false;
  if (
    r.path === "original_value" &&
    r.valuation &&
    r.valuation.value_cents < a.original_value_cents
  )
    return false;
  if (req.current.fnma !== req.current.hpa) return false;
  if ((r.valuation?.delivered_on ?? null) !== r.evidence_satisfied_on) return false;
  if (r.valuation && r.valuation.delivered_on > task.as_of) return false;
  const excluded = new Set(r.disaster_excluded);
  const atReceipt = paymentHistory(a.installments, r.received_on, excluded, age);
  const h = req.decision.history;
  if (atReceipt.late30_12m !== h.late30_12m || atReceipt.late60_24m !== h.late60_24m) return false;
  if (r.balance.postings.some((p) => p.posted_on <= r.received_on || p.posted_on > task.as_of))
    return false;
  return true;
}

export function drawPmiTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: PmiTask; attempts: number } {
  const id = pmiTaskId(split, suiteSeed, index);
  const ATTEMPTS = 40;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawPmiCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (pmiInScope(task) && pmiFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no task fair to grade in ${ATTEMPTS} draws`);
}

export const generatePmiTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawPmiTask(split, suiteSeed, index).task;

export function generatePmiSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): PmiTask[] {
  return Array.from({ length: n }, (_, i) => generatePmiTask(split, suiteSeed, i));
}

export const PMI_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ────────────────────────────────────────── */

/**
 * §10's worked loan: sales price $400,000, appraisal $410,000 (original value
 * $400,000.00), $380,000 at 6.500% for 360 months, consummated 2024-03-15,
 * first payment 2024-05-01, P&I $2,401.86, a one-unit principal residence.
 */
const WORKED: PmiLoan = {
  state: "TX",
  consummation: plainDate("2024-03-15"),
  is_refinance: false,
  sales_price_cents: 40_000_000n,
  appraised_value_cents: 41_000_000n,
  units: 1,
  occupancy_at_origination: "principal",
  original_principal_cents: 38_000_000n,
  note_rate_pct: "6.500",
  first_payment_due: plainDate("2024-05-01"),
  io_months: 0,
  amortizing_term_months: 360,
};

/** Installments of `amount` from `from` through `through`, each paid on its due date unless `paid` says another day (null: never). */
function specLedger(
  from: string,
  through: string,
  paid: Record<string, string | null> = {},
  amount: Cents = 240_186n,
): Ledger {
  const dues = duesBetween(plainDate(from), plainDate(through));
  const receipts = dues
    .filter((d) => paid[d] !== null)
    .map((d) => ({ received_on: plainDate(paid[d] ?? d), amount_cents: amount }))
    .sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  return {
    from: dues[0]!,
    installments: dues.map((due_date) => ({ due_date, amount_cents: amount })),
    receipts,
  };
}

const MONTHLY: Mi = {
  plan: "monthly",
  premium_cents: 19_000n,
  coverage_start: plainDate("2024-03-15"),
};
/** 10.5's annual premium, $2,280.00, renewing on the 15 March anniversary. */
const ANNUAL: Mi = {
  plan: "annual",
  premium_cents: 228_000n,
  coverage_start: plainDate("2024-03-15"),
};

const request = (
  o: Partial<CancellationRequestFacts> & { upb: Cents; received: string },
): CancellationRequestFacts => {
  const { upb, received, ...rest } = o;
  return {
    received_on: plainDate(received),
    path: "original_value",
    improvements_accepted: false,
    avm_cents: 45_500_000n,
    valuation: null,
    evidence_satisfied_on: null,
    disaster_excluded: [],
    balance: {
      upb_on_receipt_cents: upb,
      postings: [],
      deferred_principal_cents: 0n,
      forborne_principal_cents: 0n,
    },
    ...rest,
  };
};

/**
 * §10's worked examples, each as the task it is: 10.2's scenarios A, B and C,
 * its ARM, Flex Modification and lender-paid examples; 10.3's interest-only,
 * two-unit (T2, and T3 both ways), pre-1999 and 15-year loans; 10.1's
 * requests (T1, T2, T4 and its disaster exclusion, T5 before and after the
 * borrower's BPO, T6, T9, the current-value BPOs of $500,000 and $490,000,
 * and T12 on the day the valuation expires and the day after); and 10.5's
 * monthly premium on a request effective the 13th.
 */
export function pmiSpecTasks(): PmiTask[] {
  const sweep = (
    as_of: string,
    ledger: Ledger,
    o: Partial<Omit<PmiTask, "as_of" | "ledger">> = {},
  ): Omit<PmiTask, "id" | "split" | "suite_seed" | "index"> => ({
    as_of: plainDate(as_of),
    loan: WORKED,
    rate_changes: [],
    modification: null,
    mi: MONTHLY,
    ledger,
    request: null,
    ...o,
  });
  const twoUnit: PmiLoan = {
    ...WORKED,
    units: 2,
    consummation: plainDate("2021-02-12"),
    first_payment_due: plainDate("2021-04-01"),
  };
  const asked = (
    as_of: string,
    req: CancellationRequestFacts,
    o: Partial<Omit<PmiTask, "as_of" | "request">> = {},
  ) =>
    sweep(as_of, specLedger("2027-06-01", as_of, { "2029-06-01": "2029-06-14" }), {
      request: req,
      ...o,
    });
  const t1 = request({ received: "2029-07-10", upb: 31_995_095n });
  const cases: Omit<PmiTask, "id" | "split" | "suite_seed" | "index">[] = [
    // 10.2 scenario A: June paid 06-12, current on 2035-07-01.
    sweep("2035-07-01", specLedger("2035-01-01", "2035-07-01", { "2035-06-01": "2035-06-12" }), {
      mi: ANNUAL,
    }),
    // Scenario B: June paid 07-08, July 07-20; and 10.5's annual estimate from 2035-03-15 to 08-01.
    sweep(
      "2035-07-25",
      specLedger("2035-01-01", "2035-07-01", {
        "2035-06-01": "2035-07-08",
        "2035-07-01": "2035-07-20",
      }),
      { mi: ANNUAL },
    ),
    // Scenario C: June paid 07-08, July 08-03.
    sweep(
      "2035-08-05",
      specLedger("2035-01-01", "2035-08-01", {
        "2035-06-01": "2035-07-08",
        "2035-07-01": "2035-08-03",
      }),
    ),
    // The ARM: 5.50%, reset at payment 61 to 7.50%.
    sweep("2035-09-01", specLedger("2035-03-01", "2035-09-01", {}, 259_645n), {
      loan: { ...WORKED, note_rate_pct: "5.500" },
      rate_changes: [{ payment_number: 61, new_rate_pct: "7.500" }],
    }),
    // The Flex Modification: $320,000 at 6.50% over 480 from 2029-02-01, $50,000 forborne.
    sweep("2047-03-01", specLedger("2046-09-01", "2047-03-01", {}, 187_346n), {
      modification: {
        first_modified_due: plainDate("2029-02-01"),
        ib_upb_cents: 32_000_000n,
        rate_pct: "6.500",
        term_months: 480,
        forborne_principal_cents: 5_000_000n,
      },
    }),
    // Lender-paid, the same terms.
    sweep("2035-07-01", specLedger("2035-01-01", "2035-07-01"), {
      mi: { ...MONTHLY, plan: "lender_paid" },
    }),
    // 10.3 interest-only 10/20.
    sweep("2039-05-01", specLedger("2038-11-01", "2039-05-01", {}, 283_318n), {
      loan: { ...WORKED, io_months: 120, amortizing_term_months: 240 },
    }),
    // 10.3-T2: the two-unit loan, current at its midpoint.
    sweep("2036-04-01", specLedger("2035-10-01", "2036-04-01"), { loan: twoUnit }),
    // 10.3-T3: February paid 03-05 and March 03-28; then March paid 04-09 instead.
    sweep(
      "2036-04-01",
      specLedger("2035-10-01", "2036-04-01", {
        "2036-02-01": "2036-03-05",
        "2036-03-01": "2036-03-28",
      }),
      { loan: twoUnit },
    ),
    sweep(
      "2036-04-12",
      specLedger("2035-10-01", "2036-04-01", {
        "2036-02-01": "2036-03-05",
        "2036-03-01": "2036-04-09",
      }),
      { loan: twoUnit },
    ),
    // 10.3 pre-1999: consummated 1998-11-15, first payment 1999-01-01.
    sweep("2014-01-01", specLedger("2013-07-01", "2014-01-01"), {
      loan: {
        ...WORKED,
        consummation: plainDate("1998-11-15"),
        first_payment_due: plainDate("1999-01-01"),
      },
    }),
    // 10.3-T6: a 15-year loan.
    sweep("2028-04-01", specLedger("2027-10-01", "2028-04-01", {}, 331_021n), {
      loan: { ...WORKED, amortizing_term_months: 180 },
    }),
    // 10.1-T2: the 2027-07-10 request at $335,548.68, after the $30,000 curtailment.
    sweep("2027-07-13", specLedger("2025-06-01", "2027-07-13"), {
      request: request({ received: "2027-07-10", upb: 33_554_868n, avm_cents: null }),
    }),
    // 10.1-T1: the 2029-07-10 request at $319,950.95 with the $455,000 AVM.
    asked("2029-07-15", t1),
    // 10.1-T4: October 2028 paid 11-05, 35 days late; then the same late attributed to a disaster.
    sweep(
      "2029-07-15",
      specLedger("2027-06-01", "2029-07-15", {
        "2028-10-01": "2028-11-05",
        "2028-11-01": "2028-11-05",
        "2029-06-01": "2029-06-14",
      }),
      { request: t1 },
    ),
    sweep(
      "2029-07-15",
      specLedger("2027-06-01", "2029-07-15", {
        "2028-10-01": "2028-11-05",
        "2028-11-01": "2028-11-05",
        "2029-06-01": "2029-06-14",
      }),
      { request: { ...t1, disaster_excluded: [plainDate("2028-10-01")] } },
    ),
    // 10.1-T5: the AVM at $395,000; then the borrower's BPO at $412,000, delivered 07-30.
    asked("2029-07-12", { ...t1, avm_cents: 39_500_000n }),
    asked("2029-07-31", {
      ...t1,
      avm_cents: 39_500_000n,
      valuation: { value_cents: 41_200_000n, delivered_on: plainDate("2029-07-30") },
      evidence_satisfied_on: plainDate("2029-07-30"),
    }),
    // 10.1-T6: a two-unit principal residence at 72%.
    asked("2029-07-15", request({ received: "2029-07-10", upb: 28_800_000n }), { loan: twoUnit }),
    // 10.1-T9: a curtailment posted 07-15, after the request, to 79.90%.
    asked(
      "2029-07-20",
      request({
        received: "2029-07-10",
        upb: 32_010_000n,
        balance: {
          upb_on_receipt_cents: 32_010_000n,
          postings: [{ posted_on: plainDate("2029-07-15"), upb_after_cents: 31_960_000n }],
          deferred_principal_cents: 0n,
          forborne_principal_cents: 0n,
        },
      }),
    ),
    // 10.1 current value: requested 2026-08-20, the BPO delivered 09-03 at $500,000, then at $490,000.
    ...[50_000_000n, 49_000_000n].map((value) =>
      sweep("2026-09-05", specLedger("2024-07-01", "2026-09-05"), {
        request: request({
          received: "2026-08-20",
          upb: 37_052_240n,
          path: "current_value",
          avm_cents: null,
          valuation: { value_cents: value, delivered_on: plainDate("2026-09-03") },
          evidence_satisfied_on: plainDate("2026-09-03"),
        }),
      }),
    ),
    // 10.1-T12: the same $500,000 BPO, decided 2027-01-01 and 2027-01-02.
    ...["2027-01-01", "2027-01-02"].map((on) =>
      sweep(on, specLedger("2024-12-01", on), {
        request: request({
          received: "2026-08-20",
          upb: 37_052_240n,
          path: "current_value",
          avm_cents: null,
          valuation: { value_cents: 50_000_000n, delivered_on: plainDate("2026-09-03") },
          evidence_satisfied_on: plainDate("2026-09-03"),
        }),
      }),
    ),
    // 10.5's monthly example: $190.00 a month, effective on the 13th.
    asked("2029-07-15", { ...t1, received_on: plainDate("2029-07-13") }),
  ];
  return cases.map((c, index) => ({
    id: `${PMI_ENVIRONMENT_NAME}/${PMI_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c,
  }));
}
