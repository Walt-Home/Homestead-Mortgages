/**
 * Synthetic escrow accounts, seeded: no borrower's data, ever.
 *
 * Each task is drawn from its own stream keyed by its id, so a task is a
 * function of (split, suite seed, index). An account is a handful of lines
 * the way a servicer's are — county taxes in two installments, a school or
 * city tax, hazard insurance, sometimes flood, sometimes borrower-paid
 * mortgage insurance with a termination date — each with the bills the
 * payee has issued or last year's figures, and a ledger with what is still
 * scheduled before the new year. The traps are the rules' own: a discount
 * date that moves a disbursement, CPI that applies to taxes and not to
 * insurance, an MI line that stops mid-year, a stale prior-year estimate, a
 * posting outside the window, a statement sent too late for the first month.
 *
 * Then the account is aimed at one of the decision's edges: a surplus of
 * exactly fifty dollars or one cent under, a shortage of exactly one month's
 * payment or one cent under, a borrower thirty days late or thirty-one, a
 * deficiency, a workout. Only the ledger's balance is set to reach it, after
 * the engine has projected the year; what the account then concludes is the
 * engine's alone.
 */

import type { Cents } from "@hm/kernel/money";
import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  plainDate,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import type { Split } from "../refi/task.js";
import { project, projectLines, type EscrowLineInput } from "./ported/analysis.js";
import {
  ESCROW_ENVIRONMENT_NAME,
  ESCROW_ENVIRONMENT_VERSION,
  type EscrowTask,
  type LedgerItem,
} from "./task.js";

export const escrowTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${ESCROW_ENVIRONMENT_NAME}/${ESCROW_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const FIRST_YEAR_START = plainDate("2026-01-01");
const dollars = (r: Rng, lo: number, hi: number): Cents => BigInt(r.int(lo * 100, hi * 100));
const roundTo = (c: Cents, step: Cents): Cents => (c / step) * step;
/** A day of the month no month lacks, so a date moved by months keeps its day. */
const day = (r: Rng) => r.int(1, 28);
const inMonth = (r: Rng, start: PlainDate, offset: number): PlainDate => {
  const { y, m } = parts(addMonths(start, offset));
  return ymd(y, m, day(r));
};

type Basis = EscrowLineInput["estimate_basis"];

interface Draft {
  readonly line_type: string;
  readonly frequency: EscrowLineInput["frequency"];
  readonly annual: Cents;
  /** Months from year_start, one per installment, for the disbursements. */
  readonly months: readonly number[];
  readonly basis: Basis;
}

/** A line written as its payee and the servicer's records would have it. */
function line(r: Rng, d: Draft, yearStart: PlainDate, asOf: PlainDate): EscrowLineInput {
  const n = d.months.length;
  const base = {
    line_type: d.line_type,
    frequency: d.frequency,
    estimate_basis: d.basis,
  };
  if (d.basis === "known_bill") {
    const per = d.annual / BigInt(n);
    const bills = d.months.map((mo, k) => {
      const due = inMonth(r, yearStart, mo);
      const amount = k === n - 1 ? d.annual - per * BigInt(n - 1) : per;
      // Pay dates stay inside the year: a penalty date at most to the 28th of the year's last month.
      const lastDay = addDays(addMonths(yearStart, 12), -4);
      const penalty = r.chance(0.6) ? addDays(due, r.int(0, 40)) : null;
      const penalty_on = penalty && penalty < lastDay ? penalty : null;
      const discount = r.chance(0.3)
        ? { by: addDays(due, -r.int(5, 30)), amount_cents: (amount * 2n) / 100n }
        : null;
      const available_on = r.chance(0.35) ? addDays(due, -r.int(10, 50)) : null;
      return {
        amount_cents: amount,
        due_on: due,
        ...(penalty_on ? { penalty_on } : {}),
        ...(discount ? { discount } : {}),
        ...(available_on ? { available_on } : {}),
      };
    });
    // Discount and availability dates can fall before the year: keep only bills whose pay date is in it.
    const inYear = bills.every((b) => {
      let on = b.penalty_on ?? b.due_on;
      if (b.discount && b.discount.by < on) on = b.discount.by;
      if (b.available_on && on < b.available_on) on = b.available_on;
      return on >= yearStart;
    });
    return {
      ...base,
      estimate_basis: inYear ? "known_bill" : "prior_year",
      prior_year_annual_cents: roundTo((d.annual * BigInt(r.int(92, 99))) / 100n, 100n),
      prior_disbursed_on: d.months.map((mo) => inMonth(r, yearStart, mo - 12)),
      ...(inYear ? { known_bills: bills } : {}),
    };
  }
  const prior = d.annual;
  const confirmed = r.chance(0.2)
    ? addDays(addMonths(asOf, -24), r.chance(0.5) ? -r.int(1, 200) : r.int(0, 60))
    : null;
  return {
    ...base,
    prior_year_annual_cents: prior,
    prior_disbursed_on: d.months.map((mo) => inMonth(r, yearStart, mo - 12)),
    ...(confirmed ? { prior_year_confirmed_on: confirmed } : {}),
    ...(d.basis === "comparable"
      ? { comparable_annual_cents: roundTo(dollarsNear(r, prior), 100n) }
      : {}),
    ...(d.basis === "contract" ? { contract_annual_cents: prior } : {}),
  };
}
const dollarsNear = (r: Rng, c: Cents): Cents => (c * BigInt(r.int(85, 120))) / 100n;

function drawLines(r: Rng, yearStart: PlainDate, asOf: PlainDate): EscrowLineInput[] {
  const out: EscrowLineInput[] = [];
  // County taxes, twice a year.
  const first = r.int(0, 5);
  out.push(
    line(
      r,
      {
        line_type: "tax_county",
        frequency: "semiannual",
        annual: roundTo(dollars(r, 1_200, 9_000), 2n),
        months: [first, first + 6],
        basis: r.weighted<Basis>([
          ["known_bill", 40],
          ["prior_year_cpi", 45],
          ["prior_year", 15],
        ]),
      },
      yearStart,
      asOf,
    ),
  );
  // A school or city tax, once a year; new construction has only a comparable.
  if (r.chance(0.7)) {
    out.push(
      line(
        r,
        {
          line_type: r.pick(["tax_school", "tax_city"]),
          frequency: "annual",
          annual: dollars(r, 300, 3_500),
          months: [r.int(0, 11)],
          basis: r.weighted<Basis>([
            ["known_bill", 35],
            ["prior_year_cpi", 40],
            ["comparable", 10],
            ["prior_year", 15],
          ]),
        },
        yearStart,
        asOf,
      ),
    );
  }
  // Hazard insurance: insurers quote renewals, so CPI does not apply even when asked for.
  out.push(
    line(
      r,
      {
        line_type: "hazard",
        frequency: "annual",
        annual: dollars(r, 700, 4_200),
        months: [r.int(0, 11)],
        basis: r.weighted<Basis>([
          ["prior_year", 45],
          ["prior_year_cpi", 25],
          ["known_bill", 30],
        ]),
      },
      yearStart,
      asOf,
    ),
  );
  if (r.chance(0.25)) {
    out.push(
      line(
        r,
        {
          line_type: "flood",
          frequency: "annual",
          annual: dollars(r, 400, 3_000),
          months: [r.int(0, 11)],
          basis: r.chance(0.5) ? "known_bill" : "prior_year",
        },
        yearStart,
        asOf,
      ),
    );
  }
  // Borrower-paid MI, monthly, ending on its termination date — or with none on file.
  if (r.chance(0.3)) {
    const annual = roundTo(dollars(r, 480, 2_400), 12n);
    const mi = line(
      r,
      {
        line_type: "mi_borrower_paid",
        frequency: "monthly",
        annual,
        months: Array.from({ length: 12 }, (_, k) => k),
        basis: "contract",
      },
      yearStart,
      asOf,
    );
    const ends = r.weighted<() => PlainDate | null>([
      [() => null, 25],
      [() => addMonths(yearStart, r.int(1, 11)), 40],
      [() => addMonths(yearStart, r.int(12, 60)), 35],
    ])();
    out.push({ ...mi, terminates_on: ends });
  }
  return out;
}

type Aim =
  | "balanced"
  | "refund"
  | "refund_at_50"
  | "credit"
  | "credit_under_50"
  | "big_refund"
  | "short_under_month"
  | "short_at_month"
  | "short"
  | "deficiency";

/** One task from a stream. */
export function drawEscrowTask(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): EscrowTask {
  const year_start = addMonths(FIRST_YEAR_START, r.int(0, 47));
  const as_of = addDays(year_start, -r.int(30, 75));
  const statement_sent_on = addDays(as_of, r.int(1, 14));
  const cpi_change_pct = (r.int(10, 60) / 10).toFixed(1);
  const lines = drawLines(r, year_start, as_of);

  const cushion = {
    policy_months: 2,
    instrument_months: r.weighted<number | null>([
      [null, 70],
      [1, 20],
      [2, 10],
    ]),
    state_max_months: r.weighted<number | null>([
      [null, 85],
      [1.5, 7],
      [1, 5],
      [0, 3],
    ]),
  };
  const regx_days_delinquent = r.weighted<number>([
    [0, 72],
    [30, 7],
    [31, 7],
    [r.pick([45, 60, 90, 120]), 14],
  ]);
  const workout = r.chance(0.07);
  const borrower_election_months = workout && r.chance(0.5) ? r.pick([6, 12, 24, 36]) : null;
  const instrument_shortage_max_months = r.chance(0.15) ? r.pick([6, 12]) : null;

  // The engine's own year, to aim the ledger at an edge of the decision.
  const projected = projectLines(lines, year_start, { cpi_change_pct, as_of });
  const p = project(projected.items, year_start, cushion);
  const target = p.target_at_start_cents;
  const base = p.base_payment_cents;
  const aim = r.weighted<Aim>([
    ["balanced", 4],
    ["refund", 12],
    ["refund_at_50", 6],
    ["big_refund", 4],
    ["credit", 10],
    ["credit_under_50", 6],
    ["short_under_month", 10],
    ["short_at_month", 8],
    ["short", 26],
    ["deficiency", 14],
  ]);
  const projectedActual: Cents = {
    balanced: target,
    refund: target + dollars(r, 50, 900),
    refund_at_50: target + 5_000n,
    big_refund: target + dollars(r, 2_500, 4_000) + 1n,
    credit: target + BigInt(r.int(1, 4_998)),
    credit_under_50: target + 4_999n,
    short_under_month: target - (base > 1n ? base - 1n : 0n),
    short_at_month: target - base,
    short: target - dollars(r, 50, 2_000) - base,
    deficiency: -dollars(r, 20, 1_500),
  }[aim];

  // The ledger: the escrow share of each payment still due before the new year, and what is still to be paid out.
  const current_escrow_payment_cents = roundTo(
    (base *
      BigInt(
        r.weighted<number>([
          [r.int(92, 108), 70],
          [r.int(60, 80), 15],
          [r.int(126, 150), 15],
        ]),
      )) /
      100n,
    1n,
  );
  const deposits: LedgerItem[] = [];
  for (let due = addMonths(year_start, -2); due < year_start; due = addMonths(due, 1)) {
    if (due > as_of)
      deposits.push({
        on: due,
        amount_cents: current_escrow_payment_cents,
        description: "scheduled payment, escrow share",
      });
  }
  const disbursements: LedgerItem[] = [];
  if (r.chance(0.35)) {
    const on = addDays(as_of, r.int(1, Math.max(1, daysBetween(as_of, year_start) - 1)));
    if (on < year_start)
      disbursements.push({
        on,
        amount_cents: dollars(r, 150, 1_800),
        description: r.pick(["hazard renewal", "supplemental tax bill", "flood renewal"]),
      });
  }
  // Postings outside the window, which the projected actual must leave out.
  if (r.chance(0.3))
    deposits.unshift({
      on: addDays(as_of, -r.int(0, 12)),
      amount_cents: current_escrow_payment_cents,
      description: "payment received, escrow share (posted)",
    });
  if (r.chance(0.3))
    disbursements.push({
      on: addDays(year_start, r.int(0, 20)),
      amount_cents: dollars(r, 200, 1_500),
      description: r.pick(["county tax, first installment", "hazard renewal"]),
    });

  const counted = (xs: LedgerItem[]) =>
    xs.filter((x) => x.on > as_of && x.on < year_start).reduce((s, x) => s + x.amount_cents, 0n);
  const balance_cents = projectedActual - counted(deposits) + counted(disbursements);

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    as_of,
    year_start,
    statement_sent_on,
    lines,
    cpi_change_pct,
    cushion,
    ledger: { balance_cents, deposits, disbursements },
    regx_days_delinquent,
    workout,
    borrower_election_months,
    instrument_shortage_max_months,
    current_escrow_payment_cents,
  };
}

export function generateEscrowTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): EscrowTask {
  const id = escrowTaskId(split, suiteSeed, index);
  return drawEscrowTask(rngFor(id), id, split, suiteSeed, index);
}

export function generateEscrowSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): EscrowTask[] {
  return Array.from({ length: n }, (_, i) => generateEscrowTask(split, suiteSeed, i));
}

export const ESCROW_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked example, as tasks ────────────────────────────────── */

const d = plainDate;
/** §3.2's annual analysis: run 2027-05-16 for July 2027 – June 2028, three tax bills, $1,660.00 a year. */
const SPEC_LINES: EscrowLineInput[] = [
  {
    line_type: "tax_county",
    frequency: "semiannual",
    estimate_basis: "known_bill",
    prior_year_annual_cents: 120_000n,
    prior_disbursed_on: [d("2026-07-15"), d("2026-12-15")],
    known_bills: [
      { amount_cents: 52_000n, due_on: d("2027-07-15") },
      { amount_cents: 76_000n, due_on: d("2027-12-15") },
    ],
  },
  {
    line_type: "tax_school",
    frequency: "annual",
    estimate_basis: "known_bill",
    prior_year_annual_cents: 36_000n,
    prior_disbursed_on: [d("2026-09-15")],
    known_bills: [{ amount_cents: 38_000n, due_on: d("2027-09-15") }],
  },
];

/** The example (shortage $406.68, payment $172.22) and its three variants, by the June deposit landing on $700.00 and the others. */
export const ESCROW_SPEC_CASES: readonly { name: string; balance_cents: Cents }[] = [
  { name: "3.2 annual analysis: shortage $406.68, payment $172.22", balance_cents: 57_000n },
  { name: "3.2 variant: projected actual $1,250.00, refund $143.32", balance_cents: 112_000n },
  {
    name: "3.2 variant: projected actual $1,133.36, credit $2.22 a month",
    balance_cents: 100_336n,
  },
  {
    name: "3.2 variant: projected actual −$150.00, deficiency and shortage",
    balance_cents: -28_000n,
  },
];

export const escrowSpecTasks = (): EscrowTask[] =>
  ESCROW_SPEC_CASES.map((c, index) => ({
    id: `${ESCROW_ENVIRONMENT_NAME}/${ESCROW_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    as_of: d("2027-05-16"),
    year_start: d("2027-07-01"),
    statement_sent_on: d("2027-05-20"),
    lines: SPEC_LINES,
    cpi_change_pct: "3.0",
    cushion: { policy_months: 2, instrument_months: null, state_max_months: null },
    ledger: {
      balance_cents: c.balance_cents,
      deposits: [
        {
          on: d("2027-06-01"),
          amount_cents: 13_000n,
          description: "scheduled payment, escrow share",
        },
      ],
      disbursements: [],
    },
    regx_days_delinquent: 0,
    workout: false,
    borrower_election_months: null,
    instrument_shortage_max_months: null,
    current_escrow_payment_cents: 13_000n,
  }));
