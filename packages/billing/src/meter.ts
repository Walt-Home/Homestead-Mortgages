/**
 * The tape meter: what a servicer's book consumed in a month.
 *
 * A servicer's loans reach us on a tape and are watched from the day the
 * tape is loaded (`docs/decisions.md`, "The book is tracked from the day it
 * is loaded"). The price sheet says what a watched loan on a partner's book
 * consumes — the self-improving mortgage row, per $100,000 of unpaid
 * principal balance per loan-month, and offer touches, flat — and nothing
 * else until the loan boards, which a servicer's own book never does here.
 * So the month's statement is one balance-driven line plus a count of
 * touches, and this is the arithmetic, pure, over the rows the tape wrote.
 *
 * The decisions, each taken 29 September 2026 with Joe:
 *
 *   - **The balance is the interest-bearing UPB the newest tape on or
 *     before the month's end reported.** The tape carries a total that
 *     includes deferred principal too; we store and bill the interest-bearing
 *     figure, which is what the servicer's own fee is earned on.
 *   - **A loan-month is pro-rated by calendar day, from the load day.** The
 *     sheet says "from the day it is loaded", so a loan loaded on the 23rd
 *     is eight thirtieths of a September. It stops the day a tape reports
 *     the loan paid off, transferred, charged off or matured: that day and
 *     after are not billed.
 *   - **No delinquency charge.** Section D is priced on top of the cycle,
 *     and the cycle is not running on a monitored book.
 *   - **A touch is an offer sent to the homeowner**, not the claim
 *     invitation the desk mails. Offers are a card and no mail today, so the
 *     count the caller passes is zero and the line shows it.
 *
 * Tokens are cents, and the arithmetic is integer: a loan's tokens for the
 * month are `balance × rate × days ÷ ($100,000 × days in month)`, rounded
 * half-up once, per loan. The totals are sums of those, so a statement
 * agrees with its own lines to the token.
 */

import {
  addDays,
  compare,
  daysInMonth,
  endOfMonth,
  max,
  min,
  parts,
  startOfMonth,
  toEpochDays,
  type PlainDate,
} from "@hm/kernel/calendar";
import { Decimal, divRound } from "@hm/kernel/money";
import { centsOfTokens, PRICE_SHEET, priceRow, type PriceRow } from "./price-sheet.js";

/** What a tape may say a loan's standing is, in the feed contract's words. */
export type ObservedStatus =
  "current" | "delinquent" | "paid_off" | "charged_off" | "matured" | "transferred";

/** The standings after which a loan is no longer watched, and no longer billed. */
export const ENDED_STATUSES: ReadonlySet<ObservedStatus> = new Set([
  "paid_off",
  "charged_off",
  "matured",
  "transferred",
]);

export interface MeteredObservation {
  readonly asOf: PlainDate;
  readonly status: ObservedStatus;
  readonly principalBalanceCents: bigint;
}

export interface MeteredLoan {
  readonly loanId: string;
  /** The servicer's own number for the loan. */
  readonly number: string;
  /** The day the loan was loaded onto the book: the first day it is watched. */
  readonly watchedFrom: PlainDate;
  /** What each tape said, in any order; the meter sorts by as-of. */
  readonly observations: readonly MeteredObservation[];
  /** Offer touches in the month: e-mail, text or voice sent to the homeowner. */
  readonly touches: number;
}

/** Why a loan on the book consumed nothing this month. */
export type NotBilled = "not_yet_loaded" | "ended" | "no_balance";

export interface LoanCharge {
  readonly loanId: string;
  readonly number: string;
  readonly watchedFrom: PlainDate;
  /** The day a tape reported the loan ended, when one did on or before the month's end. */
  readonly endedOn: PlainDate | null;
  /** Calendar days of the month the loan was watched and counted. */
  readonly days: number;
  /** The observation the balance was read from; null when none stood. */
  readonly basis: MeteredObservation | null;
  readonly tokens: bigint;
  readonly touches: number;
  readonly touchTokens: bigint;
  readonly notBilled: NotBilled | null;
}

export type LineQuantity =
  | {
      readonly kind: "loan_months";
      /** Loan-days over days in the month, to two places. */
      readonly loanMonths: string;
      readonly loanDays: number;
      readonly loans: number;
      /** The balances the tokens were computed on, summed. */
      readonly balanceCents: bigint;
    }
  | { readonly kind: "events"; readonly count: number };

export interface StatementLine {
  readonly code: string;
  readonly action: string;
  readonly fires: string;
  readonly basis: PriceRow["basis"];
  /** The sheet's tokens: per $100,000 per loan-month, or per event. */
  readonly tokensEach: number;
  readonly quantity: LineQuantity;
  readonly tokens: bigint;
  readonly cents: bigint;
}

export interface Statement {
  readonly sheet: { readonly version: string; readonly date: string };
  /** "YYYY-MM". */
  readonly month: string;
  readonly from: PlainDate;
  readonly to: PlainDate;
  /** The last day counted: the month's end, or today for a month still running. */
  readonly through: PlainDate;
  readonly daysInMonth: number;
  readonly loansOnBook: number;
  readonly loansBilled: number;
  readonly loanDays: number;
  readonly loanMonths: string;
  readonly balanceCents: bigint;
  readonly tokens: bigint;
  readonly cents: bigint;
  readonly lines: readonly StatementLine[];
  /** The loans that consumed something, by number; the rest are counted and not listed. */
  readonly loans: readonly LoanCharge[];
}

export interface MeterOptions {
  /**
   * The last day counted. The month's end by default; a live read of the
   * month still running passes today, so the figure is what has been
   * consumed and not what would be.
   */
  readonly through?: PlainDate;
}

const RATE_ROW = "A.self_improving_mortgage";
const TOUCH_ROW = "A.offer_touch";

/** "YYYY-MM" for any day of the month. */
export function monthKey(day: PlainDate): string {
  const { y, m } = parts(day);
  return `${y}-${String(m).padStart(2, "0")}`;
}

const byAsOf = (a: MeteredObservation, b: MeteredObservation) => compare(a.asOf, b.asOf);

/**
 * Tokens for one loan-month fraction: balance × tokens per $100K × days,
 * over $100K × days in the month, rounded half-up once.
 */
export function tokensForBalance(
  balanceCents: bigint,
  tokensPer100k: number,
  days: number,
  daysInTheMonth: number,
): bigint {
  if (days <= 0 || balanceCents <= 0n) return 0n;
  return divRound(
    balanceCents * BigInt(tokensPer100k) * BigInt(days),
    PRICE_SHEET.balanceUnitCents * BigInt(daysInTheMonth),
    "HALF_UP",
  );
}

function chargeLoan(
  loan: MeteredLoan,
  from: PlainDate,
  to: PlainDate,
  through: PlainDate,
  daysInTheMonth: number,
  rate: PriceRow,
  touch: PriceRow,
): LoanCharge {
  const observations = [...loan.observations].sort(byAsOf);
  const ended = observations.find((o) => ENDED_STATUSES.has(o.status) && compare(o.asOf, to) <= 0);
  const endedOn = ended?.asOf ?? null;
  // The newest balance that stood before the loan ended, on or before the month's end.
  const basis =
    observations
      .filter((o) => compare(o.asOf, to) <= 0 && (endedOn === null || compare(o.asOf, endedOn) < 0))
      .at(-1) ?? null;

  const touchTokens = BigInt(loan.touches) * BigInt(touch.tokens);
  const first = max(loan.watchedFrom, from);
  // The last day counted: the month's end or today, and never the day the
  // loan was reported ended nor any day after it.
  const lastCandidate = min(to, through);
  const last = endedOn === null ? lastCandidate : min(lastCandidate, addDays(endedOn, -1));
  const days = Math.max(0, toEpochDays(last) - toEpochDays(first) + 1);

  const tokens =
    basis === null
      ? 0n
      : tokensForBalance(basis.principalBalanceCents, rate.tokens, days, daysInTheMonth);

  let notBilled: NotBilled | null = null;
  if (tokens === 0n && touchTokens === 0n) {
    if (compare(loan.watchedFrom, through) > 0) notBilled = "not_yet_loaded";
    else if (endedOn !== null && days === 0) notBilled = "ended";
    else notBilled = "no_balance";
  }
  return {
    loanId: loan.loanId,
    number: loan.number,
    watchedFrom: loan.watchedFrom,
    endedOn,
    days: basis === null ? 0 : days,
    basis,
    tokens,
    touches: loan.touches,
    touchTokens,
    notBilled,
  };
}

/**
 * The month's statement for a book. `month` is any day of the month; the
 * loans are the book as the tape left it, each with the day it was loaded
 * and every observation the tapes wrote.
 */
export function meterMonth(
  loans: readonly MeteredLoan[],
  month: PlainDate,
  opts: MeterOptions = {},
): Statement {
  const from = startOfMonth(month);
  const to = endOfMonth(month);
  const through = opts.through ? min(max(opts.through, addDays(from, -1)), to) : to;
  const { y, m } = parts(from);
  const days = daysInMonth(y, m);
  const rate = priceRow(RATE_ROW);
  const touch = priceRow(TOUCH_ROW);

  const charges = loans
    .map((l) => chargeLoan(l, from, to, through, days, rate, touch))
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  const billed = charges.filter((c) => c.notBilled === null);

  const loanDays = billed.reduce((n, c) => n + c.days, 0);
  const balanceCents = billed.reduce(
    (n, c) => n + (c.days > 0 ? (c.basis?.principalBalanceCents ?? 0n) : 0n),
    0n,
  );
  const rateTokens = billed.reduce((n, c) => n + c.tokens, 0n);
  const touches = billed.reduce((n, c) => n + c.touches, 0);
  const touchTokens = billed.reduce((n, c) => n + c.touchTokens, 0n);

  const lines: StatementLine[] = [
    {
      code: rate.code,
      action: rate.action,
      fires: rate.fires,
      basis: rate.basis,
      tokensEach: rate.tokens,
      quantity: {
        kind: "loan_months",
        loanMonths: Decimal.ratio(BigInt(loanDays), BigInt(days)).toFixed(2),
        loanDays,
        loans: billed.filter((c) => c.days > 0).length,
        balanceCents,
      },
      tokens: rateTokens,
      cents: centsOfTokens(rateTokens),
    },
    {
      code: touch.code,
      action: touch.action,
      fires: touch.fires,
      basis: touch.basis,
      tokensEach: touch.tokens,
      quantity: { kind: "events", count: touches },
      tokens: touchTokens,
      cents: centsOfTokens(touchTokens),
    },
  ];
  const tokens = lines.reduce((n, l) => n + l.tokens, 0n);

  return {
    sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
    month: monthKey(from),
    from,
    to,
    through,
    daysInMonth: days,
    loansOnBook: loans.length,
    loansBilled: billed.length,
    loanDays,
    loanMonths: Decimal.ratio(BigInt(loanDays), BigInt(days)).toFixed(2),
    balanceCents,
    tokens,
    cents: centsOfTokens(tokens),
    lines,
    loans: billed,
  };
}

/* ── the statement on the wire: every bigint a decimal string ───────────── */

export interface LoanChargeWire {
  readonly loanId: string;
  readonly number: string;
  readonly watchedFrom: string;
  readonly endedOn: string | null;
  readonly days: number;
  readonly basis: {
    readonly asOf: string;
    readonly status: ObservedStatus;
    readonly principalBalanceCents: string;
  } | null;
  readonly tokens: string;
  readonly touches: number;
  readonly touchTokens: string;
}

export type LineQuantityWire =
  | {
      readonly kind: "loan_months";
      readonly loanMonths: string;
      readonly loanDays: number;
      readonly loans: number;
      readonly balanceCents: string;
    }
  | { readonly kind: "events"; readonly count: number };

export interface StatementLineWire {
  readonly code: string;
  readonly action: string;
  readonly fires: string;
  readonly basis: PriceRow["basis"];
  readonly tokensEach: number;
  readonly quantity: LineQuantityWire;
  readonly tokens: string;
  readonly cents: string;
}

export interface StatementWire {
  readonly sheet: { readonly version: string; readonly date: string };
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly through: string;
  readonly daysInMonth: number;
  readonly loansOnBook: number;
  readonly loansBilled: number;
  readonly loanDays: number;
  readonly loanMonths: string;
  readonly balanceCents: string;
  readonly tokens: string;
  readonly cents: string;
  readonly lines: readonly StatementLineWire[];
  readonly loans: readonly LoanChargeWire[];
}

/** The statement with every bigint spelled as a decimal string, for JSON. */
export function statementWire(s: Statement): StatementWire {
  return {
    sheet: s.sheet,
    month: s.month,
    from: s.from,
    to: s.to,
    through: s.through,
    daysInMonth: s.daysInMonth,
    loansOnBook: s.loansOnBook,
    loansBilled: s.loansBilled,
    loanDays: s.loanDays,
    loanMonths: s.loanMonths,
    balanceCents: s.balanceCents.toString(),
    tokens: s.tokens.toString(),
    cents: s.cents.toString(),
    lines: s.lines.map((l) => ({
      code: l.code,
      action: l.action,
      fires: l.fires,
      basis: l.basis,
      tokensEach: l.tokensEach,
      quantity:
        l.quantity.kind === "loan_months"
          ? { ...l.quantity, balanceCents: l.quantity.balanceCents.toString() }
          : l.quantity,
      tokens: l.tokens.toString(),
      cents: l.cents.toString(),
    })),
    loans: s.loans.map((c) => ({
      loanId: c.loanId,
      number: c.number,
      watchedFrom: c.watchedFrom,
      endedOn: c.endedOn,
      days: c.days,
      basis: c.basis
        ? {
            asOf: c.basis.asOf,
            status: c.basis.status,
            principalBalanceCents: c.basis.principalBalanceCents.toString(),
          }
        : null,
      tokens: c.tokens.toString(),
      touches: c.touches,
      touchTokens: c.touchTokens.toString(),
    })),
  };
}

/* ── the sheet's terms, for a page that says how a charge is computed ──── */

export interface MeterTerms {
  readonly sheet: { readonly version: string; readonly date: string };
  /** The self-improving mortgage row: tokens per $100,000 of UPB per loan-month. */
  readonly tokensPer100kPerLoanMonth: number;
  /** The offer-touch row: tokens per touch, flat. */
  readonly touchTokens: number;
  /** Cents per token, as a decimal string. */
  readonly tokenCents: string;
  /** The balance unit the rate is quoted on, in cents: $100,000. */
  readonly balanceUnitCents: string;
}

/** The two rows the tape meter bills, and the sheet's one exchange rate, as a page states them. */
export function meterTerms(): MeterTerms {
  return {
    sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
    tokensPer100kPerLoanMonth: priceRow(RATE_ROW).tokens,
    touchTokens: priceRow(TOUCH_ROW).tokens,
    tokenCents: PRICE_SHEET.tokenCents.toString(),
    balanceUnitCents: PRICE_SHEET.balanceUnitCents.toString(),
  };
}

/* ── the run rate: MRR and ARR, as estimates ────────────────────────────── */

/**
 * What the book would consume in a whole month at the balances the newest
 * tapes report, and that twelve times over. An estimate twice: a balance
 * amortizes, so a real year runs lower than twelve of this month, and a
 * tape may add loans or report them ended. Offer touches are not in it;
 * they are events, not a rate. Each loan is rounded as the meter rounds
 * it, so a full month's statement at these balances would agree.
 */
export interface RunRate {
  readonly asOf: PlainDate;
  /** Loans in the rate: loaded by `asOf`, not reported ended, with a balance. */
  readonly loans: number;
  readonly loansOnBook: number;
  readonly balanceCents: bigint;
  readonly monthlyTokens: bigint;
  readonly monthlyCents: bigint;
  readonly annualTokens: bigint;
  readonly annualCents: bigint;
}

export function runRate(loans: readonly MeteredLoan[], asOf: PlainDate): RunRate {
  const rate = priceRow(RATE_ROW);
  let counted = 0;
  let balanceCents = 0n;
  let monthlyTokens = 0n;
  for (const loan of loans) {
    if (compare(loan.watchedFrom, asOf) > 0) continue;
    const observations = loan.observations.filter((o) => compare(o.asOf, asOf) <= 0).sort(byAsOf);
    // Ended as the meter reads it: any tape on or before the day said so.
    if (observations.some((o) => ENDED_STATUSES.has(o.status))) continue;
    const newest = observations.at(-1);
    if (!newest || newest.principalBalanceCents <= 0n) continue;
    counted += 1;
    balanceCents += newest.principalBalanceCents;
    // A whole month: the fraction is one.
    monthlyTokens += tokensForBalance(newest.principalBalanceCents, rate.tokens, 1, 1);
  }
  const annualTokens = monthlyTokens * 12n;
  return {
    asOf,
    loans: counted,
    loansOnBook: loans.length,
    balanceCents,
    monthlyTokens,
    monthlyCents: centsOfTokens(monthlyTokens),
    annualTokens,
    annualCents: centsOfTokens(annualTokens),
  };
}

export interface RunRateWire {
  readonly asOf: string;
  readonly loans: number;
  readonly loansOnBook: number;
  readonly balanceCents: string;
  readonly monthlyTokens: string;
  readonly monthlyCents: string;
  readonly annualTokens: string;
  readonly annualCents: string;
}

export function runRateWire(r: RunRate): RunRateWire {
  return {
    asOf: r.asOf,
    loans: r.loans,
    loansOnBook: r.loansOnBook,
    balanceCents: r.balanceCents.toString(),
    monthlyTokens: r.monthlyTokens.toString(),
    monthlyCents: r.monthlyCents.toString(),
    annualTokens: r.annualTokens.toString(),
    annualCents: r.annualCents.toString(),
  };
}
