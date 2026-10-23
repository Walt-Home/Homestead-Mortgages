/**
 * A scenario: the book's shape and the dated events its borrowers obey.
 *
 * An event names its loan by book index and its date either absolutely
 * (`on`, a calendar date) or by `month`, counted from the loan's first
 * payment (month 0 is the month the first payment is due) with an optional
 * `day`. Each loan's events are resolved against its own dates once it is
 * drawn, and an event outside the loan's decade is refused, by name, rather
 * than dropped.
 *
 * Random behavior is on by default and draws from the calibration: payment
 * timing, partials, curtailments, misses and cures, contacts, disasters and
 * payoffs (transfers out only when asked for). A scripted event overrides it
 * for its own payment. With `random: false` a borrower pays every payment in
 * full on their habitual day, and one who is behind pays everything owed at
 * the next payment.
 */

import { addDays, addMonths, endOfMonth, plainDate, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { LoanPins } from "./draw.js";

/** When an event happens: a date, or a month counted from the first payment. */
export type When = { readonly on: string } | { readonly month: number; readonly day?: number };

export type ScenarioEvent = When &
  (
    | {
        /** Servicing moves to us on this date; every month before it is the prior servicer's, generated in full. */
        readonly kind: "transfer_in";
        readonly loan: number;
        /** The first payments after the transfer the borrower still sends to the prior servicer, forwarded to us. */
        readonly misdirected_payments?: number;
      }
    | { readonly kind: "transfer_out"; readonly loan: number }
    | {
        /** The payment for the installment due in this month is never sent. */
        readonly kind: "missed_payment";
        readonly loan: number;
      }
    | {
        /** A promise, made on the event's date, to pay on `pay_on` (or `pay_in_days` later). */
        readonly kind: "promise_to_pay";
        readonly loan: number;
        readonly pay_on?: string;
        readonly pay_in_days?: number;
        /** Default true. A broken promise sends nothing on its date. */
        readonly kept?: boolean;
        /** Default: everything owed on the day. */
        readonly amount_cents?: Cents | number;
      }
    | {
        /** A repayment plan from this date: the arrears spread over `months` payments beside the regular one. */
        readonly kind: "repayment_plan";
        readonly loan: number;
        readonly months: number;
      }
    | {
        /** Every tax bill due on or after the date changes by `pct` percent. */
        readonly kind: "tax_reassessment";
        readonly loan: number;
        readonly pct: number;
      }
    | {
        /** The first hazard renewal on or after the date, and every one after it, changes by `pct` percent. */
        readonly kind: "insurance_increase";
        readonly loan: number;
        readonly pct: number;
      }
    | {
        /** At the first payment change on or after the date, the borrower's bill pay sends the old amount once. */
        readonly kind: "bill_pay_stale";
        readonly loan: number;
      }
    | {
        /** The loan is paid off on this date. */
        readonly kind: "payoff";
        readonly loan: number;
        readonly by_refinance?: boolean;
      }
  );

export interface RandomToggles {
  /** Timing, partials, curtailments and the $50 shortfalls. */
  readonly payments: boolean;
  /** Misses from current, cures and repeat misses. */
  readonly delinquency: boolean;
  readonly payoff: boolean;
  readonly contacts: boolean;
  readonly disasters: boolean;
  /** Year-over-year noise on bills and the analyst's inputs; off, every line grows at the calibration's rate. */
  readonly growth: boolean;
  readonly transfers_out: boolean;
}

export const RANDOM_ON: RandomToggles = {
  payments: true,
  delinquency: true,
  payoff: true,
  contacts: true,
  disasters: true,
  growth: true,
  transfers_out: false,
};
export const RANDOM_OFF: RandomToggles = {
  payments: false,
  delinquency: false,
  payoff: false,
  contacts: false,
  disasters: false,
  growth: false,
  transfers_out: false,
};

export interface Scenario {
  readonly name?: string;
  /** Loans in the book (default 1). */
  readonly loans?: number;
  /** The first payment of the first cohort, a first of the month no earlier than 2026-03-01 (the default). */
  readonly start?: string;
  /** First payments spread over this many months from `start` (default 12). */
  readonly cohort_months?: number;
  /** Months per loan from its first payment (default 120, the decade). */
  readonly months?: number;
  /** "origination" (default): every loan is ours from its first payment. "book": each reaches us by transfer at an age drawn from book.loan_age_distribution. */
  readonly boarding?: "origination" | "book";
  readonly random?: boolean | Partial<RandomToggles>;
  readonly events?: readonly ScenarioEvent[];
  /** Terms pinned per loan, by book index. */
  readonly pins?: Readonly<Record<number, LoanPins>>;
}

export interface NormalScenario {
  readonly name: string;
  readonly loans: number;
  readonly start: PlainDate;
  readonly cohort_months: number;
  readonly months: number;
  readonly boarding: "origination" | "book";
  readonly random: RandomToggles;
  readonly events: readonly ScenarioEvent[];
  readonly pins: Readonly<Record<number, LoanPins>>;
}

export const EARLIEST_START = "2026-03-01" as PlainDate;

export function normalizeScenario(s: Scenario): NormalScenario {
  const start = plainDate(s.start ?? EARLIEST_START);
  if (!start.endsWith("-01"))
    throw new RangeError(`scenario start ${start} is not the first of a month`);
  if (start < EARLIEST_START)
    throw new RangeError(
      `scenario start ${start} is before ${EARLIEST_START}: dates run forward from 2026`,
    );
  const loans = s.loans ?? 1;
  const months = s.months ?? 120;
  const cohort = s.cohort_months ?? 12;
  if (!Number.isInteger(loans) || loans < 1)
    throw new RangeError(`loans must be a positive integer, not ${loans}`);
  if (!Number.isInteger(months) || months < 1 || months > 360)
    throw new RangeError(`months must be 1 to 360, not ${months}`);
  if (!Number.isInteger(cohort) || cohort < 1)
    throw new RangeError(`cohort_months must be a positive integer, not ${cohort}`);
  const random =
    s.random === undefined || s.random === true
      ? RANDOM_ON
      : s.random === false
        ? RANDOM_OFF
        : { ...RANDOM_ON, ...s.random };
  for (const e of s.events ?? []) {
    if (!Number.isInteger(e.loan) || e.loan < 0 || e.loan >= loans)
      throw new RangeError(`${e.kind}: loan ${e.loan} is not in a book of ${loans}`);
    if (e.kind === "repayment_plan" && (!Number.isInteger(e.months) || e.months < 1))
      throw new RangeError(`repayment_plan on loan ${e.loan}: months must be a positive integer`);
    if ((e.kind === "tax_reassessment" || e.kind === "insurance_increase") && !(e.pct > -100))
      throw new RangeError(`${e.kind} on loan ${e.loan}: pct must be above -100`);
  }
  return {
    name: s.name ?? "unnamed",
    loans,
    start,
    cohort_months: cohort,
    months,
    boarding: s.boarding ?? "origination",
    random,
    events: s.events ?? [],
    pins: s.pins ?? {},
  };
}

/** An event's date for a loan whose first payment is `firstDue`. */
export function resolveWhen(w: When, firstDue: PlainDate): PlainDate {
  if ("on" in w) return plainDate(w.on);
  const m = addMonths(firstDue, w.month);
  return w.day ? addDays(m, w.day - 1) : m;
}

/** One loan's events, resolved and checked against its window. */
export interface LoanScript {
  readonly transfer_in: { readonly on: PlainDate; readonly misdirected: number } | null;
  readonly transfer_out: PlainDate | null;
  readonly missed: ReadonlySet<PlainDate>;
  readonly promises: readonly {
    readonly made_on: PlainDate;
    readonly pay_on: PlainDate;
    readonly kept: boolean;
    readonly amount: Cents | null;
  }[];
  readonly plans: readonly { readonly on: PlainDate; readonly months: number }[];
  readonly tax: readonly { readonly on: PlainDate; readonly pct: number }[];
  readonly insurance: readonly { readonly on: PlainDate; readonly pct: number }[];
  readonly bill_pay_stale: readonly PlainDate[];
  readonly payoff: { readonly on: PlainDate; readonly by_refinance: boolean } | null;
}

export function scriptFor(
  sc: NormalScenario,
  loan: number,
  dates: { readonly note_date: PlainDate; readonly first_due: PlainDate },
): LoanScript {
  const last = endOfMonth(addMonths(dates.first_due, sc.months - 1));
  const inWindow = (kind: string, d: PlainDate, from: PlainDate = dates.note_date): PlainDate => {
    if (d < from || d > last)
      throw new RangeError(`${kind} on loan ${loan}: ${d} is outside ${from}..${last}`);
    return d;
  };
  const evs = sc.events.filter((e) => e.loan === loan);
  const one = <K extends ScenarioEvent["kind"]>(k: K) => {
    const xs = evs.filter((e) => e.kind === k);
    if (xs.length > 1)
      throw new RangeError(`loan ${loan} has ${xs.length} ${k} events; one is the most`);
    return xs[0] as Extract<ScenarioEvent, { kind: K }> | undefined;
  };
  const tin = one("transfer_in");
  const tout = one("transfer_out");
  const pay = one("payoff");
  const missed = new Set<PlainDate>();
  for (const e of evs)
    if (e.kind === "missed_payment") {
      const d = resolveWhen(e, dates.first_due);
      const due = plainDate(`${d.slice(0, 7)}-01`);
      missed.add(inWindow("missed_payment", due, dates.first_due));
    }
  const tinOn = tin
    ? inWindow("transfer_in", resolveWhen(tin, dates.first_due), addDays(dates.first_due, 1))
    : null;
  const toutOn = tout
    ? inWindow("transfer_out", resolveWhen(tout, dates.first_due), dates.first_due)
    : null;
  if (tinOn && toutOn && toutOn <= tinOn)
    throw new RangeError(
      `loan ${loan} is transferred out on ${toutOn}, before it reaches us on ${tinOn}`,
    );
  return {
    transfer_in: tin && tinOn ? { on: tinOn, misdirected: tin.misdirected_payments ?? 0 } : null,
    transfer_out: toutOn,
    missed,
    promises: evs.flatMap((e) => {
      if (e.kind !== "promise_to_pay") return [];
      const made = inWindow("promise_to_pay", resolveWhen(e, dates.first_due), dates.first_due);
      const payOn = e.pay_on ? plainDate(e.pay_on) : addDays(made, e.pay_in_days ?? 10);
      if (payOn < made)
        throw new RangeError(
          `promise_to_pay on loan ${loan}: pays ${payOn}, before it was made ${made}`,
        );
      return [
        {
          made_on: made,
          pay_on: inWindow("promise_to_pay", payOn, made),
          kept: e.kept ?? true,
          amount: e.amount_cents !== undefined ? BigInt(e.amount_cents) : null,
        },
      ];
    }),
    plans: evs.flatMap((e) =>
      e.kind === "repayment_plan"
        ? [
            {
              on: inWindow("repayment_plan", resolveWhen(e, dates.first_due), dates.first_due),
              months: e.months,
            },
          ]
        : [],
    ),
    tax: evs.flatMap((e) =>
      e.kind === "tax_reassessment"
        ? [{ on: inWindow("tax_reassessment", resolveWhen(e, dates.first_due)), pct: e.pct }]
        : [],
    ),
    insurance: evs.flatMap((e) =>
      e.kind === "insurance_increase"
        ? [{ on: inWindow("insurance_increase", resolveWhen(e, dates.first_due)), pct: e.pct }]
        : [],
    ),
    bill_pay_stale: evs.flatMap((e) =>
      e.kind === "bill_pay_stale"
        ? [inWindow("bill_pay_stale", resolveWhen(e, dates.first_due))]
        : [],
    ),
    payoff: pay
      ? {
          on: inWindow("payoff", resolveWhen(pay, dates.first_due), dates.first_due),
          by_refinance: pay.by_refinance ?? false,
        }
      : null,
  };
}
