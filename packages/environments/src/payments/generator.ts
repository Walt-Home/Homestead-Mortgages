/**
 * Synthetic loans and their months of receipts, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is a
 * monthly note with a balance, a rate, a P&I and an escrow payment, its
 * installments projected from four months before the window (more for a
 * loan further behind) to three after, paid through some month: current,
 * paid ahead, or one to five behind, with the late charges those months
 * earned. The window is four to six weeks, stretched to 8 to 14 days past
 * the first late-charge run where the edge needs that run inside it, or, for
 * some prepayments, the days between two runs: 26 to 63 days, and almost
 * always one or two runs. Then the month is aimed, in turn by index, at one
 * edge of the cashiering:
 *   - on_time: the payment on or before the grace end, which may have rolled
 *     past a weekend or holiday, or the day after it, when the run comes first;
 *   - fifty_rule: a payment short by $50 or less, or by $50.01, on a loan the
 *     rule reaches and on one it does not (unescrowed, before March 1999, a
 *     second lien, three partials already, opted out);
 *   - suspense: an earlier partial in suspense that a new receipt completes,
 *     and a balance in suspense the late-charge test counts;
 *   - catch_up: a delinquent loan paid some or all of its arrears at once,
 *     and once they are all paid, the rest to late charges and then suspense;
 *   - curtailment: designated principal on a current loan, less than a
 *     payment (applied apart from the installments), and on a delinquent one
 *     (it cures first);
 *   - reserved: a payment carrying an amount of additional principal, which
 *     never prepays a future installment;
 *   - prepay: two or three installments in one receipt, ahead of their dates,
 *     sometimes in a window between two runs, so no run at all;
 *   - instruction: a principal instruction in words, a refused instruction to
 *     pay a second lien, and both at once;
 *   - hold: a bankruptcy (with its suspended charges), a foreclosure referred
 *     past 120 days delinquent, a dispute or a fraud hold;
 *   - overlay: forbearance (with and without a default), an active bankruptcy,
 *     a foreclosure referral, and the transfer shield over a payment the old
 *     servicer was sent and forwarded late (spec example L);
 *   - terms: a PITI basis, a cap below the charge, a rate other than 5%, a
 *     grace other than 15 days.
 * A receipt the engine parks in suspense with arrears still open (a partial,
 * or anything under a hold) arrives after the window's last run for an
 * installment with another unpaid before it, so suspense is counted toward
 * one installment's late charge at a time.
 *
 * What v1 leaves out is in docs/environments.md: a payoff, fees other than
 * late charges, non-interest-bearing principal, items credited on another
 * day than they arrive, and trials, whose receipts the spec applies once the
 * amount held reaches a payment, which allocation alone never does (and the
 * servicing app's trial operation has no caller outside its tests: see
 * docs/servicing-engine-defects.md, cashiering-14). `paymentsInScope`
 * runs on the engine's own postings and keeps a month only when the engine
 * does nothing in it that its spec calls wrong. A month is then kept only
 * once the reference, working through the tools, lands exactly where the
 * engine does; the tests hold both to zero misses on unfiltered draws.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  plainDate,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  expectedPayments,
  gradePaymentsAgainst,
  parsePaymentsSubmission,
  postMonth,
} from "./grader.js";
import {
  assessLateCharge,
  basisCents,
  graceEndFor,
  recordFee,
  type AssessmentResult,
} from "./ported/latecharges.js";
import type { HoldType, InstallmentProjection, LoanCashState, Overlay } from "./ported/types.js";
import { paymentsSteps } from "./reference.js";
import {
  PAYMENTS_ENVIRONMENT_NAME,
  PAYMENTS_ENVIRONMENT_VERSION,
  paymentsPayload,
  type PaymentsTask,
  type Receipt,
} from "./task.js";
import { executePaymentsTool } from "./tools.js";

export const paymentsTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${PAYMENTS_ENVIRONMENT_NAME}/${PAYMENTS_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const PAYMENT_EDGES = [
  "on_time",
  "fifty_rule",
  "suspense",
  "catch_up",
  "curtailment",
  "reserved",
  "prepay",
  "instruction",
  "hold",
  "overlay",
  "terms",
] as const;
export type PaymentEdge = (typeof PAYMENT_EDGES)[number];
export const paymentEdgeOf = (index: number): PaymentEdge =>
  PAYMENT_EDGES[index % PAYMENT_EDGES.length]!;

const FIRST_WINDOW = plainDate("2026-01-03");
const cents = (r: Rng, loDollars: number, hiDollars: number): Cents =>
  BigInt(r.int(loDollars, hiDollars)) * 100n + BigInt(r.int(0, 99));
const eighths = (r: Rng, lo: number, hi: number) => (r.int(lo * 8, hi * 8) / 8).toFixed(3);

/** What the generator knows of the loan while it aims: its terms, its projection, its grace ends. */
interface Shape {
  readonly loan: LoanCashState;
  /** P = P&I + escrow, per due date. */
  readonly P: (due: PlainDate) => Cents;
  /** The first installment due on or after the window opens. */
  readonly d0: PlainDate;
  /** The day after an installment's grace end: the day its run comes. */
  readonly runDay: (due: PlainDate) => PlainDate;
}

interface Terms {
  behind: number;
  ahead: number;
  escrowed: boolean;
  instrument_date: PlainDate;
  lien: "first" | "second";
  partial_count_12m: number;
  opted_out_of_50_rule: boolean;
  suspense: Cents;
  /** Suspense of at least the P&I but short of the payment: what the late-charge test counts. */
  shield?: boolean;
  holds: HoldType[];
  plan_active: boolean;
  overlays: Overlay[];
  transfer_shield_until: PlainDate | null;
  late_charge_pct?: string;
  late_charge_grace_days?: number;
  late_charge_cap_cents?: Cents | null;
  late_charge_basis?: "pi" | "piti";
}

const fiftyRuleReaches = (t: Terms) =>
  t.escrowed &&
  t.instrument_date >= "1999-03-01" &&
  t.lien === "first" &&
  t.partial_count_12m < 3 &&
  !t.opted_out_of_50_rule;

function shapeOf(r: Rng, window: { from: PlainDate; through: PlainDate }, t: Terms): Shape {
  const dueDay = r.chance(0.85) ? 1 : 15;
  const { y, m } = parts(window.from);
  let d0 = ymd(y, m, dueDay);
  if (d0 < window.from) d0 = addMonths(d0, 1);
  const note_rate_pct = r.chance(0.85)
    ? eighths(r, 2.5, 8)
    : (r.int(2_500, 8_000) / 1000).toFixed(3);
  const upb_cents = cents(r, 60_000, 850_000);
  const pi_cents = levelPayment(upb_cents, ratePercent(note_rate_pct), r.int(180, 340));
  const escrow_cents = t.escrowed ? cents(r, 150, 1_400) : 0n;
  const P = pi_cents + escrow_cents;
  // Suspense is what is short of a payment, and on a loan the $50 rule reaches, short by more than
  // $50: a partial within $50 would have been applied. A hold is what lets it grow past a payment,
  // and what a hold has parked before the window is less than the P&I: more would be counted
  // toward an installment the window's receipts may not reach (cashiering-4).
  const ceiling = fiftyRuleReaches(t) ? P - 5_001n : P - 1n;
  let suspense = t.suspense;
  if (t.shield && ceiling >= pi_cents)
    suspense = pi_cents + BigInt(r.int(0, Number(ceiling - pi_cents)));
  else if (!t.holds.length && suspense > ceiling) suspense = ceiling / 3n;
  else if (t.holds.length && suspense >= pi_cents) suspense = pi_cents / 3n;

  // From four months before the window's first due date (more, for a loan further behind) to three
  // after; paid through d0 − behind − 1, or ahead through d0 + ahead − 1 when paid ahead.
  const installments: InstallmentProjection[] = [];
  for (let k = -Math.max(4, t.behind); k <= 3; k++) {
    const due_date = addMonths(d0, k);
    const status: InstallmentProjection["status"] =
      k < -t.behind ? "satisfied" : k < 0 ? "due" : k < t.ahead ? "prepaid" : "due";
    installments.push({ due_date, pi_cents, escrow_cents, status });
  }
  const lpi_date = addMonths(d0, t.ahead > 0 ? t.ahead - 1 : -t.behind - 1);

  const late_charge_pct = t.late_charge_pct;
  const terms = {
    ...(late_charge_pct !== undefined ? { late_charge_pct } : {}),
    ...(t.late_charge_grace_days !== undefined
      ? { late_charge_grace_days: t.late_charge_grace_days }
      : {}),
    ...(t.late_charge_cap_cents !== undefined
      ? { late_charge_cap_cents: t.late_charge_cap_cents }
      : {}),
    ...(t.late_charge_basis !== undefined ? { late_charge_basis: t.late_charge_basis } : {}),
  };
  const base: LoanCashState = {
    loan_id: `LN-${r.int(100_000, 999_999)}`,
    instrument_date: t.instrument_date,
    lien: t.lien,
    escrowed: t.escrowed,
    note_rate_pct,
    remittance_type: "A/A",
    upb_cents,
    lpi_date,
    installments,
    late_charges_due_cents: 0n,
    nsf_fees_due_cents: 0n,
    other_fees_due_cents: 0n,
    suspense_unapplied_cents: suspense,
    holds: t.holds,
    trial_active: false,
    plan_active: t.plan_active,
    partial_count_12m: t.partial_count_12m,
    opted_out_of_50_rule: t.opted_out_of_50_rule,
    ...terms,
    overlays: t.overlays,
    transfer_shield_until: t.transfer_shield_until,
  };
  const runDay = (due: PlainDate) => addDays(graceEndFor(base, due), 1);

  // The late charges the open months already earned: each open installment whose run came before
  // the window, run by the engine itself and recorded as its run would have recorded it, with the
  // suspense counted as 2.7 rule 1 counts it: only what is attributable to the installment.
  const loan: LoanCashState = { ...base, fees: [] };
  for (const i of installments) {
    if (i.status !== "due" || runDay(i.due_date) >= window.from) continue;
    const run = assessLateCharge({
      state: loan,
      installment_due_date: i.due_date,
      run_on: runDay(i.due_date),
      unposted_receipts_on_or_before_grace: 0,
      received_toward_basis_cents: suspenseAttributable(loan, i.due_date),
    });
    if (run.outcome === "assessed" || run.outcome === "accrued_suspended")
      recordFee(loan, { ...run.fee, id: `LC-${i.due_date}` });
  }
  return { loan, P: () => P, d0, runDay };
}

const plainTerms = (r: Rng): Terms => ({
  behind: 0,
  ahead: 0,
  escrowed: r.chance(0.85),
  instrument_date: addDays(plainDate("2001-01-01"), r.int(0, 8_500)),
  lien: "first",
  partial_count_12m: r.weighted<number>([
    [0, 70],
    [1, 15],
    [2, 10],
    [3, 5],
  ]),
  opted_out_of_50_rule: false,
  suspense: 0n,
  holds: [],
  plan_active: false,
  overlays: [],
  transfer_shield_until: null,
});

/** A receipt; dates outside the window are pulled inside it. */
function receiptsIn(
  window: { from: PlainDate; through: PlainDate },
  items: readonly Omit<Receipt, "payment_id">[],
): Receipt[] {
  const clamp = (d: PlainDate) =>
    d < window.from ? window.from : d > window.through ? window.through : d;
  return items
    .map((x) => ({ ...x, received_on: clamp(x.received_on) }))
    .map((x, k) => ({ ...x, k }))
    .sort((a, b) =>
      a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : a.k - b.k,
    )
    .map(({ k: _k, ...x }, n) => ({ ...x, payment_id: `PMT-${n + 1}` }));
}

const REFUSED_TEXTS = [
  "Apply this to my HELOC",
  "please put the extra toward my 2nd mortgage",
  "For the second lien",
  "Pay the junior loan with this",
  "apply extra to principal on my subordinate mortgage",
];
const PRINCIPAL_TEXTS = [
  "Apply the extra to principal",
  "principal only on the rest",
  "Please curtail the balance with the remainder",
  "EXTRA TO PRINCIPAL",
];
const OTHER_TEXTS = ["Thank you!", "May payment", "Account LN ending 4411"];

type OverlayAim =
  | "forbearance"
  | "forbearance_defaulted"
  | "bankruptcy_active"
  | "foreclosure_referred"
  | "transfer_shield";

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawPaymentsCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): PaymentsTask {
  const edge = paymentEdgeOf(index);
  const from = addDays(FIRST_WINDOW, r.int(0, 640));
  let window = { from, through: addDays(from, r.int(27, 44)) };
  const t = plainTerms(r);
  const items: Omit<Receipt, "payment_id">[] = [];
  const pay = (
    amount_cents: Cents,
    received_on: PlainDate,
    extra: Partial<Pick<Receipt, "designation" | "curtailment_cents" | "instruction_text">> = {},
  ) => items.push({ amount_cents, received_on, designation: "unspecified", ...extra });
  let hold: HoldType | null = null;
  let aim: OverlayAim | null = null;

  // The terms first: they decide the shape.
  switch (edge) {
    case "on_time":
      t.ahead = r.chance(0.2) ? 1 : 0;
      break;
    case "fifty_rule": {
      t.escrowed = true;
      t.behind = r.chance(0.3) ? 1 : 0;
      const spoil = r.weighted<string>([
        ["none", 50],
        ["unescrowed", 10],
        ["pre_1999", 10],
        ["second_lien", 8],
        ["three_partials", 12],
        ["opted_out", 10],
      ]);
      if (spoil === "unescrowed") t.escrowed = false;
      if (spoil === "pre_1999")
        t.instrument_date = r.chance(0.5)
          ? plainDate("1999-02-28")
          : addDays(plainDate("1992-01-01"), r.int(0, 2_500));
      if (spoil === "none" && r.chance(0.2)) t.instrument_date = plainDate("1999-03-01");
      if (spoil === "second_lien") t.lien = "second";
      if (spoil === "three_partials") t.partial_count_12m = 3;
      else if (t.partial_count_12m === 3) t.partial_count_12m = 2;
      if (spoil === "opted_out") t.opted_out_of_50_rule = true;
      break;
    }
    case "suspense":
      t.behind = r.chance(0.4) ? 1 : 0;
      if (r.chance(0.6)) {
        t.suspense = cents(r, 100, 1_800);
        t.shield = t.escrowed && r.chance(0.4);
      }
      break;
    case "catch_up":
      t.behind = r.int(2, 3);
      break;
    case "curtailment":
      t.behind = r.weighted<number>([
        [0, 50],
        [1, 25],
        [2, 25],
      ]);
      t.ahead = t.behind === 0 && r.chance(0.3) ? 1 : 0;
      break;
    case "reserved":
      t.behind = r.chance(0.25) ? 1 : 0;
      break;
    case "prepay":
      t.ahead = r.chance(0.3) ? 1 : 0;
      break;
    case "instruction":
      t.behind = r.weighted<number>([
        [0, 50],
        [1, 30],
        [2, 20],
      ]);
      break;
    case "hold":
      // A foreclosure is referred only past 120 days delinquent (Reg X §1024.41(f)).
      hold = r.weighted<HoldType>([
        ["bankruptcy", 40],
        ["foreclosure_post_referral", 25],
        ["noe_dispute", 20],
        ["fraud", 15],
      ]);
      t.holds = [hold];
      t.behind = hold === "foreclosure_post_referral" ? 5 : r.int(0, hold === "bankruptcy" ? 3 : 2);
      if (r.chance(0.3)) t.suspense = cents(r, 50, 1_500);
      break;
    case "overlay":
      aim = r.weighted<OverlayAim>([
        ["forbearance", 30],
        ["forbearance_defaulted", 15],
        ["bankruptcy_active", 25],
        ["foreclosure_referred", 15],
        ["transfer_shield", 15],
      ]);
      t.behind =
        aim === "foreclosure_referred"
          ? 5
          : aim === "transfer_shield"
            ? 0
            : r.int(0, aim === "bankruptcy_active" ? 3 : 2);
      break;
    case "terms":
      t.behind = r.int(0, 2);
      t.late_charge_basis = r.chance(0.5) ? "piti" : "pi";
      t.late_charge_pct = r.pick(["4", "6", "3", "2.5", "5", "4.5"]);
      if (r.chance(0.4)) t.late_charge_grace_days = r.pick([10, 15, 16]);
      if (r.chance(0.4)) t.late_charge_cap_cents = BigInt(r.int(15, 120)) * 100n;
      break;
  }

  // Overlays and holds are dated against the projection, so the shape is drawn twice from one
  // stream: once to find the dates, once with what they decide.
  const shapeKey = `${id}:shape:${r.int(0, 2 ** 30)}`;
  const draft = shapeOf(rngFor(shapeKey), window, t);
  // Sometimes a prepayment's window falls between two runs, so a month with no late-charge run at
  // all turns up. It opens the day after the run for the installment before d0, so d0 stays d0.
  if (edge === "prepay" && r.chance(0.12))
    window = {
      from: addDays(draft.runDay(addMonths(draft.d0, -1)), 1),
      through: addDays(draft.runDay(draft.d0), -1),
    };
  // No installment whose run falls in the window may be due before a suppression begins: the
  // engine keys a suppression on the due date, and a run after a filing or referral for an
  // installment due before it would be a new charge the spec forbids.
  const firstRunInWindow = draft.loan.installments
    .filter((i) => i.status === "due" && draft.runDay(i.due_date) >= window.from)
    .map((i) => i.due_date)
    .sort()[0];
  const suppressedFrom = (from: PlainDate) =>
    firstRunInWindow && firstRunInWindow < from ? firstRunInWindow : from;
  if (hold === "bankruptcy" || aim === "bankruptcy_active") {
    t.overlays = [
      {
        kind: "bankruptcy_active",
        from: suppressedFrom(addMonths(draft.d0, -r.int(0, 3))),
        to: null,
      },
    ];
    if (aim === "bankruptcy_active" && r.chance(0.5)) t.holds = ["bankruptcy"];
  }
  if (hold === "foreclosure_post_referral" || aim === "foreclosure_referred") {
    t.overlays = [{ kind: "foreclosure_referred", from: suppressedFrom(window.from), to: null }];
    if (aim === "foreclosure_referred" && r.chance(0.5)) t.holds = ["foreclosure_post_referral"];
  }
  if (aim === "forbearance" || aim === "forbearance_defaulted") {
    const start = addMonths(draft.d0, -r.int(0, 2));
    const end = r.chance(0.5) ? null : addMonths(start, r.int(2, 5));
    const until = end ?? addDays(window.through, 30);
    t.overlays = [
      {
        kind: "forbearance_active",
        from: start,
        to: end,
        ...(aim === "forbearance_defaulted"
          ? { defaulted_on: addDays(start, r.int(1, daysBetween(start, until) - 1)) }
          : {}),
      },
    ];
    t.plan_active = end === null || end >= window.through;
  }
  if (aim === "transfer_shield")
    // A transfer dated on or before the first due date in the window; the 60 days run from it.
    t.transfer_shield_until = addDays(draft.d0, r.int(10, 45));

  const shape = shapeOf(rngFor(shapeKey), window, t);
  const { loan, d0, runDay } = shape;
  const P = shape.P(d0);
  const graceEnd = addDays(runDay(d0), -1);
  const firstOpen = loan.installments.find((i) => i.status === "due")!.due_date;
  const dueBy = (on: PlainDate) =>
    loan.installments.filter((i) => i.status === "due" && i.due_date <= on).length;
  // An overlay or a note's terms only show at a run, so the window holds the first one due.
  if (
    (edge === "overlay" ||
      edge === "terms" ||
      edge === "on_time" ||
      edge === "suspense" ||
      edge === "fifty_rule") &&
    window.through < addDays(runDay(d0), 8)
  )
    window = { from: window.from, through: addDays(runDay(d0), r.int(8, 14)) };

  // The last run in the window for an installment with another unpaid one before it. Suspense held
  // across that run would be counted toward both, where 2.7 rule 1 counts it toward the older one
  // (cashiering-4), so a receipt the engine will park in suspense arrives on or after it.
  const behindAnother = loan.installments
    .filter((i) => i.status === "due" && i.due_date > firstOpen)
    .map((i) => runDay(i.due_date))
    .filter((d) => d >= window.from && d <= window.through)
    .sort()
    .at(-1);
  const parkedOn = (on: PlainDate): PlainDate =>
    behindAnother && on < behindAnother
      ? addDays(behindAnother, r.int(0, daysBetween(behindAnother, window.through)))
      : on;

  // Then the receipts.
  switch (edge) {
    case "on_time": {
      const on = r.weighted<PlainDate>([
        [addDays(d0, -r.int(1, 8)), 20],
        [d0, 10],
        [addDays(d0, r.int(1, 10)), 20],
        [graceEnd, 25],
        [runDay(d0), 25],
      ]);
      pay(P, on);
      if (r.chance(0.3)) pay(cents(r, 5, 80), addDays(on, r.int(0, 10)));
      break;
    }
    case "fifty_rule": {
      const short = r.weighted<Cents>([
        [BigInt(r.int(1, 4_999)), 50],
        [5_000n, 25],
        [5_001n, 15],
        [BigInt(r.int(5_002, 20_000)), 10],
      ]);
      const owed = shape.P(firstOpen);
      // On or after the due date: the rule applied ahead of it is reported as prepaid, and the
      // spec says applied_with_50_rule.
      let on =
        firstOpen >= window.from
          ? addDays(firstOpen, r.int(0, 12))
          : addDays(window.from, r.int(0, 20));
      // A partial the rule does not reach is parked in suspense.
      if (!fiftyRuleReaches(t) || short > 5_000n) on = parkedOn(on);
      pay(owed - short, on);
      if (r.chance(0.3)) pay(short, addDays(on, r.int(3, 20)));
      break;
    }
    case "suspense": {
      const owed = shape.P(firstOpen);
      const pi = loan.installments[0]!.pi_cents;
      const held = loan.suspense_unapplied_cents;
      if (held === 0n) {
        // Two partials that make a payment between them; the first is too short for the $50 rule.
        // A first of the P&I or more is counted toward the late-charge test while it waits.
        const first = owed / BigInt(r.int(2, 4)) - BigInt(r.int(0, 999));
        let firstOn = addDays(window.from, r.int(0, 10));
        let secondOn = addDays(window.from, r.int(10, 30));
        if (first >= pi) {
          firstOn = parkedOn(firstOn);
          if (secondOn < firstOn) secondOn = firstOn;
        }
        pay(first, firstOn);
        pay(owed - first, secondOn);
      } else {
        const rest = owed - held;
        const short = rest - BigInt(r.int(6_000, 30_000));
        // Exactly what completes it, or a partial still too short: anything over would go from the
        // accumulated suspense to a late charge the run may have just assessed. A balance the
        // late-charge test counts is completed before any run behind another unpaid installment;
        // a partial that brings it to the P&I waits until after one.
        if (held >= pi && behindAnother)
          pay(
            rest,
            addDays(
              window.from,
              r.int(0, Math.max(0, daysBetween(window.from, behindAnother) - 1)),
            ),
          );
        else if (r.chance(0.65) || short <= 0n) pay(rest, addDays(window.from, r.int(0, 30)));
        else pay(short, parkedOn(addDays(window.from, r.int(0, 30))));
      }
      break;
    }
    case "catch_up": {
      const on = addDays(window.from, r.int(0, 35));
      const due = Math.max(1, dueBy(on));
      const months = r.chance(0.5) ? due : r.int(1, due);
      // Late charges take only what is left once every installment due is paid.
      const extra =
        months < due
          ? 0n
          : r.weighted<Cents>([
              [0n, 25],
              [cents(r, 1, 150), 35],
              [loan.late_charges_due_cents, 20],
              [loan.late_charges_due_cents + cents(r, 1, 200), 20],
            ]);
      pay(P * BigInt(months) + extra, on);
      if (extra === 0n && r.chance(0.3)) pay(P, addDays(on, r.int(3, 20)));
      break;
    }
    case "curtailment": {
      const when = addDays(window.from, r.int(0, 35));
      const extra = cents(r, 100, 8_000);
      if (t.behind === 0) {
        // Submitted separately: designated principal alone, with or without an amount named, and
        // less than a payment. One that could carry the next installment is, by spec 2.4 rule 2,
        // the installment first when it was sent with it; the engine curtails it whole
        // (cashiering-9).
        const alone = extra < P ? extra : 10_000n + (extra % (P - 10_000n));
        pay(alone, when, {
          designation: "curtailment",
          ...(r.chance(0.3) ? { curtailment_cents: alone - BigInt(r.int(1, 5_000)) } : {}),
        });
        if (r.chance(0.5)) pay(P, addDays(d0, r.int(-5, 10)));
      } else {
        // The arrears and less than a payment over: it cures first, then curtails or waits.
        const over = extra < P ? extra : extra % P;
        pay(P * BigInt(t.behind) + over, when, { designation: "curtailment" });
      }
      break;
    }
    case "reserved": {
      const extra = cents(r, 50, 5_000);
      const months = r.weighted<number>([
        [1, 70],
        [2, 30],
      ]);
      pay(P * BigInt(months) + extra, addDays(d0, r.int(-10, 12)), { curtailment_cents: extra });
      break;
    }
    case "prepay": {
      const months = t.ahead ? 2 : r.int(2, 3);
      pay(P * BigInt(months) + (r.chance(0.3) ? cents(r, 1, 120) : 0n), addDays(d0, r.int(-12, 3)));
      break;
    }
    case "instruction": {
      const kind = r.weighted<string>([
        ["principal", 40],
        ["refused", 35],
        ["other", 25],
      ]);
      const instruction_text =
        kind === "principal"
          ? r.pick(PRINCIPAL_TEXTS)
          : kind === "refused"
            ? r.pick(REFUSED_TEXTS)
            : r.pick(OTHER_TEXTS);
      const on = addDays(window.from, r.int(0, 35));
      pay(P * BigInt(Math.max(1, dueBy(on))) + (cents(r, 20, 3_000) % P), on, {
        instruction_text,
      });
      break;
    }
    case "hold": {
      // Every receipt is held in suspense.
      pay(P, parkedOn(addDays(window.from, r.int(0, 20))));
      if (r.chance(0.5)) pay(cents(r, 100, 3_000), parkedOn(addDays(window.from, r.int(5, 40))));
      break;
    }
    case "overlay": {
      if (aim === "transfer_shield") {
        // Example L: paid to the old servicer on time, forwarded, and received after the grace end.
        pay(P, r.chance(0.8) ? addDays(runDay(d0), r.int(0, 8)) : addDays(d0, r.int(-3, 10)));
      } else if (r.chance(0.5)) {
        // A forbearance plan's payments are not partials: a full payment, or none. One held under
        // a hold, or a partial, is parked in suspense.
        const amount =
          aim === "bankruptcy_active" || aim === "foreclosure_referred"
            ? r.chance(0.5)
              ? P
              : P / 2n
            : P;
        const on = addDays(window.from, r.int(0, 35));
        pay(amount, t.holds.length > 0 || amount < P ? parkedOn(on) : on);
      }
      break;
    }
    case "terms": {
      const on = r.pick([graceEnd, runDay(d0), addDays(window.from, r.int(0, 35))]);
      if (r.chance(0.7)) pay(P * BigInt(r.int(1, Math.max(1, t.behind))), on);
      break;
    }
  }

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    window,
    loan,
    receipts: receiptsIn(window, items),
  };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function paymentsFairToGrade(task: PaymentsTask): boolean {
  const payload = JSON.parse(JSON.stringify(paymentsPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(paymentsSteps, payload, executePaymentsTool);
  } catch {
    return false;
  }
  const parsed = parsePaymentsSubmission(byRules);
  return parsed.ok && gradePaymentsAgainst(expectedPayments(task), parsed.answer).pass;
}

/**
 * Suspense attributable to an unpaid installment (2.7 rule 1, decision
 * 2.7-Q1): what is left of the balance once the bases of the unpaid
 * installments due before it have taken theirs, no more than its own basis.
 */
export function suspenseAttributable(state: LoanCashState, due: PlainDate): Cents {
  const inst = state.installments.find((i) => i.due_date === due);
  if (!inst) throw new RangeError(`no installment ${due}`);
  const basis = basisCents(state, inst);
  const earlier = state.installments
    .filter((i) => i.status === "due" && i.due_date < due)
    .reduce((sum, i) => sum + basisCents(state, i), 0n);
  const left = state.suspense_unapplied_cents - earlier;
  return left <= 0n ? 0n : left > basis ? basis : left;
}

/**
 * A run the engine excuses by counting suspense an earlier unpaid
 * installment also has a claim on (cashiering-4). The engine counts the whole
 * balance toward every unpaid installment's test; 2.7 rule 1 counts what is
 * attributable to the installment, and one balance is not attributable to
 * two. Attributed oldest first, the installment gets the least any
 * attribution gives it, so a decision that changes under that one is a
 * decision some reading of the spec would not make. Both are the engine's
 * own `assessLateCharge`, once as it ran and once handed that amount.
 */
export function suspenseCountedTwice(
  due: PlainDate,
  result: AssessmentResult,
  state: LoanCashState,
): boolean {
  if (result.outcome !== "not_assessed" || !result.reason.startsWith("paid within grace"))
    return false;
  if (state.installments.find((i) => i.due_date === due)?.status !== "due") return false;
  const attributed = assessLateCharge({
    state,
    installment_due_date: due,
    run_on: addDays(graceEndFor(state, due), 1),
    unposted_receipts_on_or_before_grace: 0,
    received_toward_basis_cents: suspenseAttributable(state, due),
  });
  // The engine ran as `result` says: not assessed. Handed less, it decides again.
  return attributed.outcome !== "not_assessed";
}

/**
 * A receipt the engine curtails as one sent apart from the installments
 * (designated principal, on a loan with nothing due by its date) that could
 * have carried the next installment, or that pools suspense held from before.
 * Spec 2.4 rule 2 applies funds sent with a scheduled payment to the payment
 * first, and 2.2 rule 4 keeps earlier suspense unapplied without an
 * instruction; the engine curtails all of it (cashiering-9).
 */
export function separateCurtailmentHolding(rc: Receipt, before: LoanCashState): boolean {
  if (rc.designation !== "curtailment" || before.holds.length > 0 || before.trial_active)
    return false;
  const open = before.installments
    .filter((i) => i.status === "due")
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const next = open[0];
  if (!next || open.some((i) => i.due_date <= rc.received_on)) return false;
  return (
    rc.amount_cents >= next.pi_cents + next.escrow_cents || before.suspense_unapplied_cents > 0n
  );
}

/**
 * v1's guard, run on the engine's own postings: a month is kept only when the
 * engine does nothing its spec calls wrong in it, and nothing depends on where
 * the generator stopped projecting.
 *   - the balance stays positive and the $50 rule never books negative escrow;
 *   - late charges are paid only once every installment due is paid (2.1 rule
 *     5), and never from suspense accumulated without an instruction (2.2 rule 4);
 *   - the $50 rule is never applied ahead of a due date, where the engine
 *     reports prepaid and the spec applied_with_50_rule (2.2 rule 2);
 *   - a payment during a forbearance plan is never held as a partial (2.2);
 *   - no charge is assessed under a bankruptcy or a foreclosure hold (2.7 rule 3);
 *   - the transfer shield spares only an installment the old servicer was paid
 *     for, which the forwarded receipt then satisfies (2.7 example L);
 *   - one suspense balance never excuses two installments: a run is kept only
 *     when it decides the same with the balance attributed oldest first (2.7
 *     rule 1; cashiering-4);
 *   - designated principal on a current loan, which the engine curtails whole,
 *     is less than the next payment and pools no earlier suspense (2.4 rule
 *     2; 2.2 rule 4; cashiering-9);
 *   - every receipt meets an open installment, and one is still open at the end.
 */
export function paymentsInScope(task: PaymentsTask): boolean {
  let ok = true;
  const shielded = new Set<string>();
  const forbearing = (d: PlainDate) =>
    (task.loan.overlays ?? []).some(
      (o) =>
        o.kind === "forbearance_active" &&
        o.from <= d &&
        (o.to == null || o.to >= d) &&
        (!o.defaulted_on || d < o.defaulted_on),
    );
  const want = postMonth(task, {
    run(due, result, state) {
      if (
        result.outcome === "assessed" &&
        state.holds.some((h) => h === "bankruptcy" || h === "foreclosure_post_referral")
      )
        ok = false;
      if (result.outcome === "not_assessed" && result.reason.startsWith("transfer_window_60"))
        shielded.add(due);
      if (suspenseCountedTwice(due, result, state)) ok = false;
    },
    receipt(rc, plan, before) {
      if (!before.installments.some((i) => i.status === "due")) ok = false;
      if (separateCurtailmentHolding(rc, before)) ok = false;
      if (
        plan.late_charge_cents > 0n &&
        (plan.suspense_used_cents > 0n ||
          plan.next.installments.some((i) => i.status === "due" && i.due_date <= rc.received_on))
      )
        ok = false;
      for (const i of plan.installments) {
        if (i.escrow_cents < 0n) ok = false;
        if (i.fifty_rule_shortfall_cents !== undefined && i.kind === "prepaid") ok = false;
      }
      if (plan.partial_hold && forbearing(rc.received_on)) ok = false;
    },
  });
  if (BigInt(want.final.upb_cents) <= 0n) return false;
  if (!want.final.installments.some((i) => i.status === "due")) return false;
  for (const due of shielded)
    if (want.final.installments.find((i) => i.due_date === due)?.status === "due") return false;
  return ok;
}

const ATTEMPTS = 40;

export function drawPaymentsTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: PaymentsTask; attempts: number } {
  const id = paymentsTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawPaymentsCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (paymentsInScope(task) && paymentsFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no month fair to grade in ${ATTEMPTS} draws`);
}

export const generatePaymentsTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawPaymentsTask(split, suiteSeed, index).task;

export function generatePaymentsSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): PaymentsTask[] {
  return Array.from({ length: n }, (_, i) => generatePaymentsTask(split, suiteSeed, i));
}

export const PAYMENTS_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/** The spec's fixture loan L-1: 6.500%, P&I $1,580.17, escrow $612.40, due the 1st, instrument 07/2021. */
const l1 = (lpi: string, over: Partial<LoanCashState> = {}): LoanCashState => ({
  loan_id: "L-1",
  instrument_date: plainDate("2021-07-15"),
  lien: "first",
  escrowed: true,
  note_rate_pct: "6.500",
  remittance_type: "A/A",
  upb_cents: 24_977_400n,
  lpi_date: plainDate(lpi),
  installments: [
    "2026-08-01",
    "2026-09-01",
    "2026-10-01",
    "2026-11-01",
    "2026-12-01",
    "2027-01-01",
  ].map((d) => ({
    due_date: plainDate(d),
    pi_cents: 158_017n,
    escrow_cents: 61_240n,
    status: d <= lpi ? ("satisfied" as const) : ("due" as const),
  })),
  late_charges_due_cents: 0n,
  nsf_fees_due_cents: 0n,
  other_fees_due_cents: 0n,
  suspense_unapplied_cents: 0n,
  holds: [],
  trial_active: false,
  plan_active: false,
  partial_count_12m: 0,
  opted_out_of_50_rule: false,
  late_charge_pct: "5",
  late_charge_grace_days: 15,
  fees: [],
  overlays: [],
  ...over,
});

/**
 * Spec §2's worked examples on L-1: A (a full payment), K then M (paid after
 * the grace end, then October on time), D (the $50 rule), F (a curtailment
 * with the payment, then October's smaller interest), G ("principal only" on
 * a delinquent loan), L (the transfer shield, credited on receipt in v1) and
 * N (a forbearance defaulted in November). Example C is not here: the spec
 * assesses its late charge, and the engine counts the $2,000.00 held in
 * suspense toward the installment and does not.
 */
export function paymentsSpecTasks(): PaymentsTask[] {
  const sept = { from: plainDate("2026-09-01"), through: plainDate("2026-09-30") };
  const septOct = { from: plainDate("2026-09-01"), through: plainDate("2026-10-31") };
  const rc = (
    payment_id: string,
    amount: bigint,
    on: string,
    extra: Partial<Pick<Receipt, "designation" | "curtailment_cents" | "instruction_text">> = {},
  ): Receipt => ({
    payment_id,
    amount_cents: amount,
    received_on: plainDate(on),
    designation: "unspecified",
    ...extra,
  });
  const cases: Omit<PaymentsTask, "id" | "split" | "suite_seed" | "index">[] = [
    { window: sept, loan: l1("2026-08-01"), receipts: [rc("A", 219_257n, "2026-09-03")] },
    {
      window: septOct,
      loan: l1("2026-08-01"),
      receipts: [rc("K", 219_257n, "2026-09-20"), rc("M", 219_257n, "2026-10-01")],
    },
    {
      window: sept,
      loan: l1("2026-08-01", { partial_count_12m: 1 }),
      receipts: [rc("D", 215_000n, "2026-09-08")],
    },
    {
      window: septOct,
      loan: l1("2026-08-01"),
      receipts: [
        rc("F", 319_257n, "2026-09-03", { curtailment_cents: 100_000n }),
        rc("F-oct", 219_257n, "2026-10-01"),
      ],
    },
    {
      window: septOct,
      loan: l1("2026-08-01"),
      receipts: [rc("G", 300_000n, "2026-10-20", { instruction_text: "principal only" })],
    },
    {
      window: sept,
      loan: l1("2026-08-01", { transfer_shield_until: plainDate("2026-10-30") }),
      receipts: [rc("L", 219_257n, "2026-09-22")],
    },
    {
      window: { from: plainDate("2026-10-01"), through: plainDate("2026-12-31") },
      loan: l1("2026-09-01", {
        upb_cents: 24_954_677n,
        overlays: [
          {
            kind: "forbearance_active",
            from: plainDate("2026-10-01"),
            to: plainDate("2026-12-31"),
            defaulted_on: plainDate("2026-11-20"),
          },
        ],
      }),
      receipts: [],
    },
  ];
  return cases.map((c, index) => ({
    id: `${PAYMENTS_ENVIRONMENT_NAME}/${PAYMENTS_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c,
  }));
}
