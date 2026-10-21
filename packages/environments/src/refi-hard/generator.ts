/**
 * Hard cases: refi-tape's rules, tools and grader, with every task placed
 * on an edge.
 *
 * refi-tape draws loans the way a book is, and almost every draw lands far
 * from any threshold, so a model that follows the rules a little loosely
 * still passes. Every miss either model made landed where one slip changes
 * the answer — insurance arithmetic, a percent, a rounding — so here each
 * task is put on one of the rules' edges, on one side of it or the other:
 *
 *   rate_floor        a rate reduction of exactly 25 bps, or 12.5
 *   cash_cap          cash back on the rounded amount within $5 of its cap,
 *                     at or under it (the amount is rounded) or over (it is not)
 *   ltv_limit         a loan-to-value exactly at a limit (9700 primary, 9000 second
 *                     home, 7500 investment, 9000 on a low-confidence value, the
 *                     8000 line above which the quote's insurance is charged), or one over
 *   value_confidence  a loan-to-value over 9000 on a value dated exactly 12 months
 *                     back, or a day earlier, when its confidence turns low
 *   value_stale       a value dated exactly 24 months back, or a day earlier
 *   ma_window         a Massachusetts loan consummated exactly 60 months before the
 *                     candidate, or a day later, inside the window
 *   gates             a decline exactly 90 days back or 89; a first offer exactly
 *                     12 months back or a day inside
 *   month_end         disbursement on the last day of a month (29 February among
 *                     them), or on the first
 *   paid_ahead        a next due date after disbursement, so no payoff days, or before
 *   pmi_unit          a PMI rate of 5 or just under (a percent), or just over (basis points)
 *
 * The edge is the task's index modulo ten and the side alternates with it,
 * swapping every ten, so any twenty consecutive tasks hold each edge once on
 * each side and any ten hold every edge. Each task is otherwise a refi-tape draw
 * made clean — active, current, unsuppressed, a recent value, a quote a
 * point under the note rate — so that the edge decides, and it is kept only
 * if it does: its answer must differ from the answer on the other side of
 * the edge, and where the edge moves figures rather than the verdict, it
 * must be a candidate, whose figures are graded. A draw that fails either
 * test, or that the tape's own variety knocks off the edge, is redrawn under
 * the next key. What the task concludes is still the engine's alone.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  parts,
  plainDate,
  startOfMonth,
  type PlainDate,
} from "@hm/kernel/calendar";
import {
  DEFAULT_PROGRAM,
  NO_GATE_FACTS,
  buildCandidate,
  cashBackCap,
  defaultSchedule,
  exclusionOf,
  levelPaymentPct,
  ltvOf,
  monthsBetween,
  payoffEstimate,
  prepaidInterest,
  scheduledUpb,
  universeLoanOf,
  type Occupancy,
  type UniverseLoan,
} from "@hm/refi-review";
import { toJsonLine } from "../record.js";
import { rngFor, type Rng } from "../rng.js";
import { drawRefiTask } from "../refi/generator.js";
import type { RefiTask, Split } from "../refi/task.js";
import { expectedTapeAnswer } from "../refi-tape/grader.js";
import { tapeOf } from "../refi-tape/generator.js";
import type { RefiTapeTask } from "../refi-tape/task.js";

export const HARD_ENVIRONMENT_NAME = "refi-hard";
/**
 * Bump on any change to the generator, or to anything refi-tape's version
 * covers: the rules, tools and grader are refi-tape's.
 *
 * 1.1.0 (20 Oct 2026): with refi-tape 1.1.0, a PMI rate may have three digits.
 */
export const HARD_ENVIRONMENT_VERSION = "1.1.0";

export const EDGES = [
  "rate_floor",
  "cash_cap",
  "ltv_limit",
  "value_confidence",
  "value_stale",
  "ma_window",
  "gates",
  "month_end",
  "paid_ahead",
  "pmi_unit",
] as const;
export type Edge = (typeof EDGES)[number];

/** A refi-tape task, and where it sits: neither is shown to a model, the payload is refi-tape's. */
export interface HardTask extends RefiTapeTask {
  readonly edge: Edge;
  readonly side: string;
}

export const hardTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${HARD_ENVIRONMENT_NAME}/${HARD_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const edgeOf = (index: number): Edge => EDGES[index % EDGES.length] as Edge;
/** Which of an edge's two sides: alternating across the ten edges, and swapped every ten tasks. */
export const sideOf = (index: number): 0 | 1 =>
  ((index + Math.floor(index / EDGES.length)) % 2) as 0 | 1;

/* ── reading and writing a tape ─────────────────────────────────────────── */

type Facts = Record<string, string | number | boolean | null | undefined>;

export const rowOf = (t: RefiTapeTask): UniverseLoan | null => {
  const read = universeLoanOf(t.loan_record, t.tape, t.review_date);
  return "row" in read ? read.row : null;
};

const money = (c: bigint, text: boolean): number | string => (text ? c.toString() : Number(c));
const thousandths = (pct: string): number => Math.round(Number(pct) * 1000);
const pctOf = (t: number): string => (t / 1000).toFixed(3);
const ceilThousand = (c: bigint): bigint => ((c + 99_999n) / 100_000n) * 100_000n;
const withFacts = (t: RefiTapeTask, f: (facts: Facts) => void): RefiTapeTask => {
  const facts: Facts = { ...t.tape.facts };
  f(facts);
  return { ...t, tape: { ...t.tape, facts } };
};
const withQuote = (t: RefiTapeTask, q: { note_rate_pct?: string; mi_monthly_cents?: bigint }) => ({
  ...t,
  quote: { source: "synthetic rate sheet", note_rate_pct: "0.000", ...t.quote, ...q },
});

const OCCUPANCY_WORDS: Record<Occupancy, readonly string[]> = {
  primary: ["Owner Occupied", "Primary Residence", "primary"],
  second_home: ["Second Home", "second home"],
  investment: ["Investment Property", "Investor"],
};

/** The occupancy where the tape already says it: our record, or else the tape's facts. */
const withOccupancy = (t: RefiTapeTask, word: string): RefiTapeTask =>
  t.loan_record.occupancy !== null
    ? { ...t, loan_record: { ...t.loan_record, occupancy: word } }
    : withFacts(t, (f) => {
        f["occupancy"] = word;
      });

/** How a value is written: as an FMV or a BPO, maybe with an older one of the other kind beside it. */
interface ValueStyle {
  readonly bpo: boolean;
  readonly text: boolean;
  readonly older: { readonly factor: bigint; readonly days: number } | null;
}
const valueStyle = (r: Rng): ValueStyle => ({
  bpo: r.chance(0.4),
  text: r.chance(0.5),
  older: r.chance(0.35) ? { factor: BigInt(r.int(88, 112)), days: r.int(1, 400) } : null,
});

/** The tape's valuations replaced by one dated value, which governs; any second is older. */
function withValue(t: RefiTapeTask, value: bigint, asOf: PlainDate, s: ValueStyle): RefiTapeTask {
  return withFacts(t, (f) => {
    for (const k of ["fmv_cents", "fmv_date", "bpo_value_cents", "bpo_date"]) delete f[k];
    const [k, d, k2, d2] = s.bpo
      ? ["bpo_value_cents", "bpo_date", "fmv_cents", "fmv_date"]
      : ["fmv_cents", "fmv_date", "bpo_value_cents", "bpo_date"];
    f[k] = money(value, s.text);
    f[d] = asOf;
    if (s.older) {
      f[k2] = money((value * s.older.factor) / 100n, s.text);
      f[d2] = addDays(asOf, -s.older.days);
    }
  });
}

/** A whole-dollar value that puts `amount` at exactly `target` loan-to-value, or null. */
function valueFor(amount: bigint, target: number): bigint | null {
  const mid = (amount * 10_000n + BigInt(target) / 2n) / BigInt(target);
  const dollars = (mid + 50n) / 100n;
  for (let i = 0; i <= 40; i++) {
    for (const v of [dollars + BigInt(i), dollars - BigInt(i)]) {
      if (v > 0n && ltvOf(amount, v * 100n).x10000 === target) return v * 100n;
    }
  }
  return null;
}

/** The loan's dates moved so its review falls on `review`: its age, balance and payment are unchanged. */
function redated(base: RefiTask, review: PlainDate): RefiTask {
  const o = parts(base.review_date);
  const n = parts(review);
  const shift = (n.y - o.y) * 12 + (n.m - o.m);
  const days = daysBetween(base.review_date, review);
  const b = base.loan;
  return {
    ...base,
    review_date: review,
    loan: {
      ...b,
      note_date: addMonths(b.note_date, shift),
      consummation_date: addMonths(b.consummation_date, shift),
      first_payment_date: addMonths(b.first_payment_date, shift),
      next_due_date: addMonths(startOfMonth(review), 1),
      value_estimate: { ...b.value_estimate, as_of: addDays(b.value_estimate.as_of, days) },
      arm_first_adjustment_date: b.arm_first_adjustment_date
        ? addMonths(b.arm_first_adjustment_date, shift)
        : null,
    },
  };
}

/**
 * refi-review's draw made clean, so that only the edge decides: active and
 * current, nothing suppressed, a value under a year old, and a quote a
 * point under the note rate.
 */
function cleaned(base: RefiTask): RefiTask {
  const b = base.loan;
  const age = Math.abs(daysBetween(b.value_estimate.as_of, base.review_date)) % 330;
  return {
    ...base,
    loan: {
      ...b,
      status: "active",
      bankruptcy_active: false,
      foreclosure_referred: false,
      lossmit_plan_active: false,
      deceased_or_sii_pending: false,
      transfer_out_pending: false,
      regx_days_delinquent: 0,
      refi_do_not_solicit: false,
      value_estimate: {
        ...b.value_estimate,
        source:
          b.value_estimate.source === "partner_appraisal" ? "partner_fmv" : b.value_estimate.source,
        as_of: addDays(base.review_date, -age),
        confidence: "medium",
      },
    },
    quote: {
      note_rate_pct: (Math.round(Math.max(2, Number(b.note_rate_pct) - 1) * 8) / 8).toFixed(3),
      source: "synthetic rate sheet",
      ...(base.quote?.mi_monthly_cents !== undefined
        ? { mi_monthly_cents: base.quote.mi_monthly_cents }
        : {}),
    },
    gate_facts: NO_GATE_FACTS,
    exceptions: [],
  };
}

/* ── the edges ──────────────────────────────────────────────────────────── */

interface Setup {
  /** The cleaned draw, before it is written as a tape. */
  readonly base: RefiTask;
  /** A loan written as a tape, with the same tape variety every time it is called. */
  readonly write: (base: RefiTask) => RefiTapeTask;
  /** The edge's own draws, all made before either side is built. */
  readonly r: Rng;
}

interface Placed {
  readonly sides: readonly [string, string];
  /** The task on one side, or null when the tape will not sit there. */
  readonly build: (side: string) => RefiTapeTask | null;
  /** True where the edge moves the offer's figures rather than the verdict: then it must be a candidate. */
  readonly figures: boolean;
}

const EDGE_BUILDERS: Record<Edge, (s: Setup) => Placed | null> = {
  rate_floor(s) {
    const t = s.write(s.base);
    const row = rowOf(t);
    if (!row) return null;
    const note = thousandths(row.note_rate_pct);
    return {
      sides: ["25 bps", "12.5 bps"],
      figures: false,
      build: (side) =>
        withQuote(t, { note_rate_pct: pctOf(note - (side === "25 bps" ? 250 : 125)) }),
    };
  },

  cash_cap(s) {
    const t0 = s.write(s.base);
    const row = rowOf(t0);
    if (!row) return null;
    const text = s.r.chance(0.5);
    const off = BigInt(s.r.int(0, 500));
    const where = s.r.next();
    const disb = defaultSchedule(t0.review_date).disbursement_date;
    const prepaid = (a: bigint) =>
      prepaidInterest(a, row.note_rate_pct, disb).prepaid_interest_cents;
    const payoff = (upb: bigint) => payoffEstimate({ ...row, upb_cents: upb }, disb).payoff_cents;
    const p0 = payoff(row.upb_cents);
    const L = ceilThousand(p0 + prepaid(p0) + cashBackCap(p0));
    return {
      sides: ["at or under the cap", "over the cap"],
      figures: true,
      build(side) {
        const under = side === "at or under the cap";
        // The payoff that puts the rounded amount's cash back `off` cents from its cap.
        const want = L - prepaid(L) - cashBackCap(L) + (under ? off : -(off + 1n));
        let upb = want - (p0 - row.upb_cents);
        for (let i = 0; i < 4; i++) upb += want - payoff(upb);
        const p = payoff(upb);
        const over = L - p - prepaid(L) - cashBackCap(L);
        if (under ? over > 0n : over <= 0n) return null;
        // An escrow deposit (twice the monthly T&I) that makes the raw amount round up to L.
        const hi = L - p - prepaid(p);
        const lo = hi - 99_999n;
        const tiLo = lo <= 2n ? 1n : (lo + 1n) / 2n;
        const tiHi = hi / 2n;
        if (tiHi < tiLo) return null;
        const ti = tiLo + BigInt(Math.floor(where * Number(tiHi - tiLo + 1n)));
        const t = withFacts(t0, (f) => {
          f["ti_cents"] = money(ti, text);
          if (f["upb_cents"] !== undefined) f["upb_cents"] = money(upb, text);
        });
        const placed: RefiTapeTask = {
          ...t,
          tape: {
            ...t.tape,
            principal_balance_cents: upb,
            scheduled_payment_cents: row.pi_cents + ti,
          },
        };
        const after = rowOf(placed);
        if (!after) return null;
        const c = buildCandidate(after, { as_of: placed.review_date }).candidate;
        if (c.rounded_to_thousand !== under || (under && c.loan_amount_cents !== L)) return null;
        return placed;
      },
    };
  },

  ltv_limit(s) {
    const [limit, occupancy, low, quoteMi] = s.r.pick([
      [9700, "primary", false, false],
      [9000, "second_home", false, false],
      [7500, "investment", false, false],
      [9000, "primary", true, false],
      [8000, "primary", false, true],
    ] as const);
    const style = valueStyle(s.r);
    const word = s.r.pick(OCCUPANCY_WORDS[occupancy]);
    const days = low ? s.r.int(380, 700) : s.r.int(5, 330);
    const t0 = withOccupancy(s.write(s.base), word);
    const row = rowOf(t0);
    if (!row) return null;
    const amount = buildCandidate(row, { as_of: t0.review_date }).candidate.loan_amount_cents;
    return {
      sides: ["at the limit", "one over"],
      figures: false,
      build(side) {
        const value = valueFor(amount, side === "at the limit" ? limit : limit + 1);
        if (value === null) return null;
        const t = withValue(t0, value, addDays(t0.review_date, -days), style);
        return quoteMi ? withQuote(t, { mi_monthly_cents: (amount * 55n) / 120_000n }) : t;
      },
    };
  },

  value_confidence(s) {
    const style = valueStyle(s.r);
    const target = s.r.int(9001, 9700);
    const t0 = withOccupancy(s.write(s.base), s.r.pick(OCCUPANCY_WORDS.primary));
    const row = rowOf(t0);
    if (!row) return null;
    const amount = buildCandidate(row, { as_of: t0.review_date }).candidate.loan_amount_cents;
    const value = valueFor(amount, target);
    if (value === null) return null;
    const line = addMonths(t0.review_date, -12);
    return {
      sides: ["12 months to the day", "a day over 12 months"],
      figures: false,
      build: (side) =>
        withValue(t0, value, side === "12 months to the day" ? line : addDays(line, -1), style),
    };
  },

  value_stale(s) {
    const style = valueStyle(s.r);
    const t0 = s.write(s.base);
    const row = rowOf(t0);
    if (!row) return null;
    const line = addMonths(t0.review_date, -24);
    return {
      sides: ["24 months to the day", "a day over 24 months"],
      figures: false,
      build: (side) =>
        withValue(
          t0,
          row.value_estimate.value_cents,
          side === "24 months to the day" ? line : addDays(line, -1),
          style,
        ),
    };
  },

  ma_window(s) {
    // A quote above the note rate whose new payment is no lower: inside the
    // window the state's rule then fails, and outside it does not apply.
    const review = s.base.review_date;
    const line = addMonths(defaultSchedule(review).consummation_date, -60);
    const extraEighths = s.r.int(0, 2);
    const b = s.base.loan;
    const onNote = (note: PlainDate): RefiTapeTask => {
      const first = addMonths(startOfMonth(note), 2);
      const next = addMonths(startOfMonth(review), 1);
      const age = monthsBetween(first, next);
      return s.write({
        ...s.base,
        loan: {
          ...b,
          property_state: "MA",
          product_code: "FRM30",
          amortization: "fixed",
          arm_first_adjustment_date: null,
          note_date: note,
          consummation_date: note,
          first_payment_date: first,
          original_term_months: 360,
          pi_cents: levelPaymentPct(b.original_upb_cents, b.note_rate_pct, 360),
          payments_made: age,
          remaining_term_months: 360 - age,
          next_due_date: next,
          upb_cents: scheduledUpb(b.original_upb_cents, b.note_rate_pct, 360, age),
          mi_status: "none",
          mi_monthly_cents: 0n,
        },
      });
    };
    const t60 = onNote(line);
    const row = rowOf(t60);
    if (!row) return null;
    const amount = buildCandidate(row, { as_of: review }).candidate.loan_amount_cents;
    let q = thousandths(row.note_rate_pct);
    while (levelPaymentPct(amount, pctOf(q), 360) < row.pi_cents && q < 20_000) q += 125;
    const quote = { note_rate_pct: pctOf(q + 125 * extraEighths) };
    return {
      sides: ["60 months to the day", "a day short of 60 months"],
      figures: false,
      build: (side) =>
        withQuote(side === "60 months to the day" ? t60 : onNote(addDays(line, 1)), quote),
    };
  },

  gates(s) {
    const t = s.write(s.base);
    const review = t.review_date;
    if (s.r.chance(0.5)) {
      return {
        sides: ["declined 90 days ago", "declined 89 days ago"],
        figures: false,
        build: (side) => ({
          ...t,
          gate_facts: {
            declined_on: addDays(review, side === "declined 90 days ago" ? -90 : -89),
            offered_at: [],
          },
        }),
      };
    }
    const year = addMonths(review, -12);
    const recent = addDays(review, -s.r.int(20, 200));
    return {
      sides: ["first offer 12 months ago to the day", "first offer a day inside 12 months"],
      figures: false,
      build: (side) => ({
        ...t,
        gate_facts: {
          declined_on: null,
          offered_at: [
            side === "first offer 12 months ago to the day" ? year : addDays(year, 1),
            recent,
          ],
        },
      }),
    };
  },

  month_end(s) {
    const anchor = addMonths(plainDate("2025-03-01"), s.r.int(0, 40));
    const leap = s.r.chance(0.25);
    const at = (side: string): PlainDate =>
      side === "first day of a month"
        ? anchor
        : leap
          ? plainDate("2028-02-29")
          : endOfMonth(anchor);
    return {
      sides: ["last day of a month", "first day of a month"],
      figures: true,
      build(side) {
        const disbursement = at(side);
        const t = s.write(redated(s.base, addDays(disbursement, -42)));
        return defaultSchedule(t.review_date).disbursement_date === disbursement ? t : null;
      },
    };
  },

  paid_ahead(s) {
    const t0 = s.write(s.base);
    const row = rowOf(t0);
    if (!row) return null;
    const b = s.base.loan;
    const disb = defaultSchedule(t0.review_date).disbursement_date;
    const ahead = addMonths(startOfMonth(disb), 1);
    const text = s.r.chance(0.5);
    return {
      sides: ["paid ahead of disbursement", "due before disbursement"],
      figures: true,
      build(side) {
        if (side === "due before disbursement") return row.next_due_date < disb ? t0 : null;
        const paid = monthsBetween(b.first_payment_date, ahead);
        if (paid >= b.original_term_months) return null;
        const upb = scheduledUpb(
          b.original_upb_cents,
          b.note_rate_pct,
          b.original_term_months,
          paid,
        );
        const t = withFacts(t0, (f) => {
          if (f["next_due_date"] !== undefined) f["next_due_date"] = ahead;
          if (f["upb_cents"] !== undefined) f["upb_cents"] = money(upb, text);
        });
        return {
          ...t,
          tape: {
            ...t.tape,
            principal_balance_cents: upb,
            next_payment_due_on:
              t.tape.next_payment_due_on !== null || t0.tape.facts["next_due_date"] === undefined
                ? ahead
                : null,
          },
        };
      },
    };
  },

  pmi_unit(s) {
    const t0 = s.write(s.base);
    const flag = s.r.pick(["Y", "y", "Yes", "true", "1"] as const);
    const percent = s.r.pick(["5", 5, "5.0", "5.000", "4.875"] as const);
    const bps = s.r.pick(["5.001", "5.125", "5.5", "6", 6] as const);
    return {
      sides: ["5 or under, a percent", "over 5, basis points"],
      figures: true,
      build: (side) =>
        withFacts(t0, (f) => {
          f["pmi_flag"] = flag;
          f["pmi_rate_pct"] = side === "5 or under, a percent" ? percent : bps;
        }),
    };
  },
};

/** What the edge measures, read back off the tape: a task is kept only if it is where its side says. */
function sits(edge: Edge, side: string, t: RefiTapeTask, row: UniverseLoan): boolean {
  const review = t.review_date;
  const schedule = defaultSchedule(review);
  switch (edge) {
    case "value_confidence":
      return (row.value_estimate.confidence === "medium") === (side === "12 months to the day");
    case "value_stale":
      return (
        row.value_estimate.as_of ===
        (side === "24 months to the day"
          ? addMonths(review, -24)
          : addDays(addMonths(review, -24), -1))
      );
    case "ma_window":
      return (
        row.property_state === "MA" &&
        monthsBetween(row.consummation_date, schedule.consummation_date) ===
          (side === "60 months to the day" ? 60 : 59)
      );
    case "paid_ahead":
      return (
        row.next_due_date > schedule.disbursement_date === (side === "paid ahead of disbursement")
      );
    case "pmi_unit":
      return row.mi_status === "bpmi_active" && row.mi_monthly_cents > 0n;
    default:
      return true;
  }
}

const clean = (row: UniverseLoan, review: PlainDate): boolean =>
  exclusionOf(row, NO_GATE_FACTS, review, DEFAULT_PROGRAM) === null;

const ATTEMPTS = 60;

/** One task, rebuilt from its coordinates alone. */
export function generateHardTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): HardTask {
  const id = hardTaskId(split, suiteSeed, index);
  const edge = edgeOf(index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const key = attempt === 0 ? id : `${id}#${attempt}`;
    const base = cleaned(drawRefiTask(rngFor(key), id, split, suiteSeed, index));
    const placed = EDGE_BUILDERS[edge]({
      base,
      write: (b) => tapeOf(b, rngFor(`${key}/tape`)),
      r: rngFor(`${key}/edge`),
    });
    if (!placed) continue;
    const side = placed.sides[sideOf(index)];
    const task = placed.build(side);
    const row = task && rowOf(task);
    if (!task || !row || !clean(row, task.review_date) || !sits(edge, side, task, row)) continue;
    const answer = expectedTapeAnswer(task);
    if (placed.figures && answer.verdict !== "candidate") continue;
    const other = placed.build(placed.sides[0] === side ? placed.sides[1] : placed.sides[0]);
    if (!other || toJsonLine(expectedTapeAnswer(other)) === toJsonLine(answer)) continue;
    return { ...task, id, split, suite_seed: suiteSeed, index, edge, side };
  }
  throw new Error(`${id}: no ${edge} task in ${ATTEMPTS} draws`);
}

export function generateHardSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): HardTask[] {
  return Array.from({ length: n }, (_, i) => generateHardTask(split, suiteSeed, i));
}

/** The held-out suite for refi-hard: twenty tasks on each edge. */
export const HARD_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };
