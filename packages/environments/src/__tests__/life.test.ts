/**
 * The life generator: a book is a function of its seed; each history keeps
 * the ledger's invariants; the ARM engines agree on every change; every month
 * furnishes a valid Metro 2 record; a borrower who is behind pays to cure and
 * catches up; the scenario's events happen; the D-03 twin differs from the
 * clean history only downstream of its planted value; an observer is shown
 * every receipt and analysis without moving a draw; and a thousand
 * loan-decades run in under fifteen seconds.
 */

import { describe, expect, it } from "vitest";
import { addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { monthlyInterest, ratePercent } from "@hm/kernel/money";
import { isValidMin } from "../boarding/ported/min.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import type { LoanCashState } from "../payments/ported/types.js";
import { toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import {
  CALIBRATION_KEYS,
  DEFAULT_CALIBRATION,
  allocateAtRates,
  bookTape,
  calibrationCheck,
  defaultCalibration,
  generate,
  loadCalibration,
  mersMin,
  monthEndRow,
  type LifeMoment,
  type LoanLife,
} from "../life/index.js";

const cal = defaultCalibration();
const book = generate(7, { loans: 200 }, { calibration: cal }).clean;
const full = (l: LoanLife) => l.payoff === null && l.transfer_out_on === null;

describe("life generator", () => {
  it("is a function of its seed, and a loan does not depend on the loans beside it", () => {
    const a = generate(7, { loans: 30 }, { calibration: cal }).clean;
    const b = generate(7, { loans: 30 }, { calibration: cal }).clean;
    expect(toJsonLine(a)).toBe(toJsonLine(b));
    for (const i of [0, 12, 29]) expect(toJsonLine(a.loans[i])).toBe(toJsonLine(book.loans[i]));
    const c = generate(8, { loans: 30 }, { calibration: cal }).clean;
    expect(toJsonLine(c.loans[0])).not.toBe(toJsonLine(a.loans[0]));
  });

  it("keeps the ledger's invariants", () => {
    const broken: string[] = [];
    for (const l of book.loans) {
      if (!l.invariants.ok) broken.push(`${l.loan_id}: ${l.invariants.notes.join("; ")}`);
      const pi = new Map(l.installments.map((i) => [i.due, i.pi]));
      for (const r of l.receipts)
        for (const x of r.installments)
          if (x.interest + x.principal !== pi.get(x.due))
            broken.push(`${r.id}: ${x.due} interest + principal is not its P&I`);
      const lc = l.receipts.reduce((s, r) => s + r.late_charge, 0n);
      const collected = l.fees.reduce((s, f) => s + f.collected, 0n);
      if (lc !== collected)
        broken.push(`${l.loan_id}: late charges applied ${lc}, fees collected ${collected}`);
      for (let k = 0; k < l.months.length; k++) {
        const m = l.months[k]!;
        if (m.suspense < 0n || m.late_charges_due < 0n)
          broken.push(`${l.loan_id} ${m.month}: a negative balance`);
        if (k > 0 && m.upb > l.months[k - 1]!.upb)
          broken.push(`${l.loan_id} ${m.month}: the balance rose`);
      }
      for (const f of l.fees)
        if (f.collected > f.amount) broken.push(`${f.id}: collected more than assessed`);
    }
    expect(broken).toEqual([]);
  });

  it("charges each installment interest at its own rate, across a rate change", () => {
    const arms = generate(
      11,
      {
        loans: 40,
        pins: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [i, { arm: i % 3 === 0 ? "7/6" : "5/6" } as const]),
        ),
      },
      { calibration: cal },
    ).clean;
    let checked = 0;
    let spanning = 0;
    const wrong: string[] = [];
    for (const l of arms.loans)
      for (const r of l.receipts) {
        if (new Set(r.installments.map((x) => x.rate_pct)).size > 1) spanning++;
        // The balance before the receipt: installments are applied first, the curtailment last.
        let upb =
          r.upb_after + r.curtailment + r.installments.reduce((s, x) => s + x.principal, 0n);
        for (const x of r.installments) {
          const expected = monthlyInterest(upb, ratePercent(x.rate_pct));
          if (x.interest !== expected)
            wrong.push(`${r.id} ${x.due}: ${x.interest} at ${x.rate_pct} is not ${expected}`);
          upb -= x.principal;
          checked++;
        }
      }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(2000);
    expect(spanning).toBeGreaterThan(0);
  });

  it("splits a payment at a rate change when suspense alone pays the earlier installment", () => {
    // Suspense holds the September installment and $50 more; the payment is October's, at the new rate.
    const due = (d: string, pi: bigint) => ({
      due_date: d as PlainDate,
      pi_cents: pi,
      escrow_cents: 20_000n,
      status: "due" as const,
    });
    const s: LoanCashState = {
      loan_id: "LN-split",
      instrument_date: "2026-01-15" as PlainDate,
      lien: "first",
      escrowed: true,
      note_rate_pct: "6.000",
      remittance_type: "A/A",
      upb_cents: 30_000_000n,
      lpi_date: "2031-08-01" as PlainDate,
      installments: [due("2031-09-01", 180_000n), due("2031-10-01", 175_000n)],
      late_charges_due_cents: 9_000n,
      nsf_fees_due_cents: 0n,
      other_fees_due_cents: 0n,
      suspense_unapplied_cents: 205_000n,
      holds: [],
      trial_active: false,
      plan_active: false,
      partial_count_12m: 0,
      opted_out_of_50_rule: false,
      late_charge_pct: "5",
      late_charge_grace_days: 15,
      late_charge_cap_cents: null,
      late_charge_basis: "pi",
      fees: [],
      overlays: [],
      transfer_shield_until: null,
    };
    const plans = allocateAtRates(
      s,
      {
        payment_id: "P",
        amount_cents: 195_000n,
        received_on: "2031-09-10" as PlainDate,
        credited_as_of: "2031-09-10" as PlainDate,
        designation: "unspecified",
      },
      (d) => (d < "2031-10-01" ? "6.000" : "5.500"),
    );
    const sept = monthlyInterest(30_000_000n, ratePercent("6.000"));
    const oct = monthlyInterest(30_000_000n - (180_000n - sept), ratePercent("5.500"));
    expect(plans.map((p) => p.installments.map((x) => [x.due_date, x.interest_cents]))).toEqual([
      [["2031-09-01", sept]],
      [["2031-10-01", oct]],
    ]);
    // The $50 beyond September waits in suspense for October and pays a fee only after it, as one call would.
    const last = plans.at(-1)!;
    expect(plans.reduce((t, p) => t + p.late_charge_cents, 0n)).toBe(5_000n);
    expect([last.next.late_charges_due_cents, last.next.suspense_unapplied_cents]).toEqual([
      4_000n,
      0n,
    ]);
  });

  it("runs both ARM engines on every change, and they agree", () => {
    const arms = generate(
      12,
      {
        loans: 60,
        pins: Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [
            i,
            { arm: (["5/6", "7/6", "10/6"] as const)[i % 3]! },
          ]),
        ),
      },
      { calibration: cal },
    ).clean;
    const changes = arms.loans.flatMap((l) => l.arm_changes.map((a) => ({ l, a })));
    expect(changes.length).toBeGreaterThan(150);
    expect(changes.filter(({ a }) => !a.engine_b_agrees)).toEqual([]);
    for (const { l, a } of changes) {
      const life = Number(l.draw.note_rate_pct) + Number(l.draw.arm!.lifetime_cap_pct);
      expect(Number(a.new_rate_pct)).toBeLessThanOrEqual(life);
      expect(Number(a.new_rate_pct)).toBeGreaterThanOrEqual(Number(l.draw.arm!.margin_pct));
      // The new P&I is what every installment from the first new payment carries.
      for (const i of l.installments)
        if (
          i.due >= a.first_new_payment &&
          !l.arm_changes.some(
            (b) => b.first_new_payment > a.first_new_payment && i.due >= b.first_new_payment,
          )
        )
          expect(i.pi).toBe(a.new_pi);
    }
  });

  it("furnishes a valid Metro 2 record every month, the closing one included", () => {
    const missing: string[] = [];
    for (const l of book.loans) {
      if (full(l) && l.months.length !== 120)
        missing.push(`${l.loan_id}: ${l.months.length} months`);
      for (const m of l.months)
        if (m.metro2.record === null || m.metro2.errors.length)
          missing.push(`${l.loan_id} ${m.month}: ${m.metro2.errors.join(",")}`);
      if (l.payoff) expect(l.months.at(-1)!.metro2.record!["account_status"]).toBe("13");
    }
    expect(missing).toEqual([]);
    expect(book.loans.some((l) => l.payoff)).toBe(true);
  });

  it("draws every MIN with the check digit the boarding gate holds it to", () => {
    // HF-008 refuses a MIN that fails isValidMin (apps/servicing/src/domain/boarding/rules.ts:103); the port in
    // boarding/ported/min.ts is that file byte for byte (boarding.test.ts). The gate's Luhn, restated here apart
    // from both: double every second digit from the right of the seventeen, and the check digit tops the sum to ten.
    const luhn = (payload: string) => {
      let sum = 0;
      for (let k = 0; k < payload.length; k++) {
        let x = Number(payload[payload.length - 1 - k]);
        if (k % 2 === 0) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
        sum += x;
      }
      return (10 - (sum % 10)) % 10;
    };
    const r = rngFor("life-test/min");
    for (let k = 0; k < 20_000; k++) {
      const seq = [0, 1].map(() => String(r.int(0, 99_999)).padStart(5, "0")).join("");
      const min = mersMin(seq);
      expect(min).toMatch(/^1000001\d{11}$/);
      expect(Number(min[17])).toBe(luhn(min.slice(0, 17)));
      expect(isValidMin(min)).toBe(true);
      // Every other last digit fails the gate.
      const wrong = min.slice(0, 17) + String((Number(min[17]) + 1 + (k % 9)) % 10);
      expect(isValidMin(wrong)).toBe(false);
    }
    const bad = book.loans.filter((l) => !isValidMin(l.draw.min)).map((l) => l.draw.min);
    expect(bad).toEqual([]);
    for (const l of book.loans)
      for (const m of l.months) expect(m.metro2.errors).not.toContain("MIN_CHECK_DIGIT");
  });

  it("gives every month-end of a loan still being paid a next due date, paid ahead too", () => {
    const bad: string[] = [];
    let live = 0;
    let ahead = 0;
    for (const l of book.loans)
      for (const m of l.months) {
        if (m.status !== "current" && m.status !== "delinquent") {
          if (m.next_due !== null)
            bad.push(`${l.loan_id} ${m.month}: closed, next due ${m.next_due}`);
          continue;
        }
        live++;
        if (m.next_due === null || m.lpi === null) {
          bad.push(`${l.loan_id} ${m.month}: no next due date`);
          continue;
        }
        // The oldest open installment, or, when the borrower paid next month's early, the one after interest's.
        if (m.lpi >= m.as_of) {
          ahead++;
          if (m.next_due !== addMonths(m.lpi, 1))
            bad.push(`${l.loan_id} ${m.month}: paid to ${m.lpi}, next due ${m.next_due}`);
        }
        const [n, mat] = [m.next_due, l.draw.maturity].map((x) => x.split("-").map(Number));
        const left = (mat![0]! - n![0]!) * 12 + mat![1]! - n![1]! + 1;
        if (m.remaining_term_months !== left)
          bad.push(`${l.loan_id} ${m.month}: ${m.remaining_term_months} months left, not ${left}`);
        // The tape row has carried the same next due date and remaining term since life 1.1.0.
        const row = monthEndRow(l, m.month)!;
        if (
          row.status.next_due_date !== m.next_due ||
          row.terms.remaining_term_months !== m.remaining_term_months
        )
          bad.push(`${l.loan_id} ${m.month}: the tape row says otherwise`);
      }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(ahead).toBeGreaterThan(live / 20);
  });

  it("schedules every year's escrow analysis, the tenth included", () => {
    const escrowed = book.loans.filter((l) => l.draw.escrowed && full(l));
    expect(escrowed.length).toBeGreaterThan(50);
    for (const l of escrowed)
      expect(l.analyses.map((a) => a.year)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // The projected balance, from the history: the balance at the run date, plus each deposit due before the year
    // that was not yet paid then (an early payer's may be), less the bills still to pay.
    const wrong: string[] = [];
    let early = 0;
    for (const l of escrowed) {
      const stop = l.pmi.find((p) => p.status === "terminated");
      for (const a of l.analyses) {
        let pa = a.balance;
        for (const i of l.installments) {
          if (i.due <= a.as_of || i.due < addMonths(a.year_start, -3) || i.due >= a.year_start)
            continue;
          if (i.satisfied_on !== null && i.satisfied_on <= a.as_of) early++;
          else pa += i.escrow;
        }
        for (const line of l.lines)
          for (const b of line.bills)
            if (
              b.on > a.as_of &&
              b.on < a.year_start &&
              !(line.basis === "mi" && stop && stop.on <= a.as_of && b.on >= stop.effective_on!)
            )
              pa -= b.amount;
        if (pa !== a.projected_actual)
          wrong.push(`${l.loan_id} year ${a.year}: ${a.projected_actual} is not ${pa}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(early).toBeGreaterThan(0);
  });

  it("measures the month a loan closes on the day it closed", () => {
    const res = generate(
      "close",
      {
        loans: 2,
        cohort_months: 1,
        random: false,
        events: [
          // Paid off nine days into the grace period, the month's installment unpaid.
          { kind: "missed_payment", loan: 0, month: 20 },
          { kind: "payoff", loan: 0, month: 20, day: 10 },
          // Paid off a month and nine days behind.
          { kind: "missed_payment", loan: 1, month: 19 },
          { kind: "missed_payment", loan: 1, month: 20 },
          { kind: "payoff", loan: 1, month: 20, day: 10 },
        ],
      },
      { calibration: cal },
    ).clean;
    const [a, b] = [res.loans[0]!, res.loans[1]!];
    const last = (l: LoanLife) => l.months.at(-1)!;
    const fields = (l: LoanLife) => [
      last(l).status,
      last(l).days_delinquent,
      last(l).mba_status,
      last(l).amount_past_due,
      last(l).metro2.record!["account_status"],
      last(l).metro2.record!["payment_rating"],
    ];
    expect(fields(a)).toEqual(["paid_off", 9, "current", 0n, "13", "0"]);
    const behind = daysBetween(addMonths(b.draw.first_due, 19), b.payoff!.on);
    expect(fields(b)).toEqual(["paid_off", behind, "30", 0n, "13", "1"]);
    const [ra, rb] = [a, b].map((l) => monthEndRow(l, last(l).month)!);
    expect([ra!.pay_string.at(-1), rb!.pay_string.at(-1)]).toEqual(["0", "3"]);
    expect([ra!.contact.contact_expected, rb!.contact.contact_expected]).toEqual([false, false]);
  });

  it("has a borrower who is behind pay to cure, and a cured borrower catch up", () => {
    // Scripted: a missed payment, then the next payment pays everything owed.
    const s = generate(
      "cure",
      {
        loans: 1,
        random: false,
        pins: { 0: { late_charge_cap_cents: null } },
        events: [{ kind: "missed_payment", loan: 0, month: 6 }],
      },
      { calibration: cal },
    ).clean.loans[0]!;
    const missedDue = addMonths(s.draw.first_due, 6);
    const cure = s.receipts.find((r) => r.mode === "cure")!;
    expect(cure.installments.map((x) => x.due)).toEqual([missedDue, addMonths(missedDue, 1)]);
    const fee = s.fees.find((f) => f.due === missedDue)!;
    expect(cure.amount).toBe(
      cure.installments.reduce((t, x) => t + x.interest + x.principal + x.escrow, 0n) + fee.amount,
    );
    expect(fee.state).toBe("collected");
    const after = s.months.find((m) => m.month === cure.on.slice(0, 7))!;
    expect([after.days_delinquent, after.suspense, after.late_charges_due]).toEqual([0, 0n, 0n]);
    expect(s.months.filter((m) => m.days_delinquent >= 30).length).toBeLessThanOrEqual(1);

    // Random: every cure leaves nothing due on or before its date unpaid, and a borrower who stays behind pays the oldest installment, which applies.
    const unpaid: string[] = [];
    let cures = 0;
    for (const l of book.loans)
      for (const r of l.receipts) {
        if (r.mode === "cure") {
          cures++;
          for (const i of l.installments)
            if (i.due <= r.on && (i.satisfied_on === null || i.satisfied_on > r.on))
              unpaid.push(`${r.id}: ${i.due}`);
        }
        if ((r.mode === "oldest" || r.mode === "cure") && r.installments.length === 0)
          unpaid.push(`${r.id}: ${r.mode} applied nothing`);
        // A whole payment never lands in suspense: an installment a cure already paid is not paid again.
        if (["regular", "cure", "oldest", "curtail"].includes(r.mode) && r.outcome === "unapplied")
          unpaid.push(`${r.id}: ${r.mode} went to suspense`);
      }
    expect(cures).toBeGreaterThan(20);
    expect(unpaid).toEqual([]);
    expect(book.loans.some((l) => l.behavior.some((b) => b.kind === "already_paid"))).toBe(true);
  });

  it("obeys the scenario's events", () => {
    const res = generate(
      "script",
      {
        loans: 2,
        cohort_months: 1,
        random: false,
        pins: { 0: { escrowed: true, arm: null }, 1: { escrowed: true, arm: null } },
        events: [
          { kind: "transfer_in", loan: 0, month: 18, misdirected_payments: 1 },
          { kind: "missed_payment", loan: 0, month: 18 },
          { kind: "missed_payment", loan: 0, month: 30 },
          { kind: "promise_to_pay", loan: 0, month: 30, day: 20, pay_in_days: 15 },
          { kind: "missed_payment", loan: 0, month: 40 },
          { kind: "missed_payment", loan: 0, month: 41 },
          { kind: "repayment_plan", loan: 0, month: 41, day: 20, months: 3 },
          { kind: "tax_reassessment", loan: 1, month: 30, pct: 40 },
          { kind: "insurance_increase", loan: 1, month: 30, pct: 30 },
          { kind: "bill_pay_stale", loan: 1, month: 30 },
          { kind: "payoff", loan: 1, month: 80, day: 12, by_refinance: true },
        ],
      },
      { calibration: cal },
    ).clean;
    const [a, b] = [res.loans[0]!, res.loans[1]!];

    // The transfer: everything before it is the prior servicer's, marked so; the shield keeps the first payment from being late.
    const t = a.transfer_in_on!;
    expect(t).toBe(addMonths(a.draw.first_due, 18));
    for (const r of [
      ...a.receipts,
      ...a.disbursements,
      ...a.analyses.map((x) => ({ ...x, on: x.as_of })),
    ])
      expect(r.servicer).toBe(r.on < t ? "prior" : "us");
    expect(a.months.filter((m) => m.servicer === "prior").length).toBe(18);
    expect(a.months.filter((m) => m.metro2.furnished_by === "prior").length).toBe(18);
    const shielded = a.late_charge_runs.find((r) => r.due === t)!;
    expect(shielded.reason).toContain("transfer_window_60");
    expect(
      a.receipts.some((r) => r.channel === "transferor_forward" && r.credited_as_of < r.on),
    ).toBe(true);

    // The promise is made and kept, and pays everything owed.
    expect(a.behavior.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["promise_made", "promise_kept", "plan_started", "plan_completed"]),
    );
    const promise = a.receipts.find((r) => r.mode === "promise")!;
    expect(a.months.find((m) => m.month === promise.on.slice(0, 7))!.days_delinquent).toBe(0);
    // The plan spreads the arrears and ends caught up with nothing left in suspense.
    const plan = a.receipts.filter((r) => r.mode === "plan");
    expect(plan.length).toBe(3);
    const end = a.months.find((m) => m.month === plan.at(-1)!.on.slice(0, 7))!;
    expect([end.days_delinquent, end.suspense]).toEqual([0, 0n]);

    // The reassessment and the premium increase reach the bills and the analysis after them.
    const at = addMonths(b.draw.first_due, 30);
    const tax = b.lines.find((l) => l.line_type === "tax_county")!.bills;
    const before = tax.filter((x) => x.on < at).at(-1)!;
    const after = tax.find((x) => x.on >= at)!;
    expect(Number(after.amount) / Number(before.amount)).toBeGreaterThan(1.35);
    const hazard = b.lines.find((l) => l.line_type === "hazard")!.bills;
    expect(
      Number(hazard.find((x) => x.on >= at)!.amount) /
        Number(hazard.filter((x) => x.on < at).at(-1)!.amount),
    ).toBeGreaterThan(1.25);
    const next = b.analyses.find((x) => x.as_of > after.on)!;
    expect(next.decision).toBe("shortage");
    // Bill pay sends the old amount once after the payment changes, and the borrower is current again by the next month.
    const stale = b.receipts.find((r) => r.mode === "stale_bill_pay")!;
    const prev = b.receipts.filter((r) => r.on < stale.on && r.mode === "regular").at(-1)!;
    expect(stale.amount).toBe(prev.amount);
    const nextMonth = b.months.find(
      (m) => m.month === addMonths(`${stale.on.slice(0, 7)}-01` as PlainDate, 1).slice(0, 7),
    )!;
    expect(nextMonth.days_delinquent).toBe(0);
    // The payoff closes the history: the quote's funds, the escrow refunded, a final status 13.
    expect(b.payoff!.by_refinance).toBe(true);
    expect(b.months.at(-1)!.month).toBe(b.payoff!.on.slice(0, 7));
    expect(b.months.at(-1)!.metro2.record!["special_comment"]).toBe("AS");
    expect(b.disbursements.at(-1)!.kind).toBe("payoff_refund");
    expect(b.disbursements.at(-1)!.balance_after).toBe(0n);
  });

  it("plants D-03, and its twin differs from the clean history only downstream of it", () => {
    // No random payoff: a loan paid off before its transfer or its misses would plant a cap nothing reads.
    const scenario = {
      loans: 4,
      cohort_months: 1,
      random: { delinquency: false, payoff: false },
      pins: {
        1: { late_charge_cap_cents: 1_500, arm: null },
        2: { late_charge_cap_cents: 1_500, arm: null },
      },
      events: [
        { kind: "missed_payment" as const, loan: 1, month: 9 },
        { kind: "missed_payment" as const, loan: 1, month: 33 },
        { kind: "missed_payment" as const, loan: 1, month: 34 },
        { kind: "transfer_in" as const, loan: 2, month: 24 },
        { kind: "missed_payment" as const, loan: 2, month: 12 },
        { kind: "missed_payment" as const, loan: 2, month: 40 },
      ],
    };
    const clean = generate("twin", scenario, { calibration: cal });
    const res = generate("twin", scenario, {
      calibration: cal,
      defects: [{ id: "D-03", loans: [1, 2] }],
    });
    // The clean history is the same whether or not a defect was asked for.
    expect(toJsonLine(res.clean)).toBe(toJsonLine(clean.clean));
    const twin = res.defective!;
    // Loans without the defect are the same loans.
    for (const i of [0, 3]) expect(toJsonLine(twin.loans[i])).toBe(toJsonLine(res.clean.loans[i]));

    expect(res.planted.map((p) => [p.index, p.defect_id])).toEqual([
      [1, "D-03"],
      [2, "D-03"],
    ]);
    const roots = res.labels.filter((x) => x.root_cause);
    expect(roots.map((x) => [x.file_or_table, x.field, x.true_value, x.planted_value])).toEqual([
      ["loan_terms", "late_charge_max_cents", "1500", null],
      ["loan_terms", "late_charge_max_cents", "1500", null],
    ]);
    // Loan 2 was boarded at its transfer: the prior servicer had the cap right, so nothing before the transfer differs.
    expect(roots[1]!.on).toBe(twin.loans[2]!.transfer_in_on);
    for (const p of res.planted) {
      const labels = res.labels.filter((x) => x.loan === p.loan && !x.root_cause);
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.filter((x) => x.on < p.on)).toEqual([]);
      // Nothing differs before the first installment charged since boarding, the first value the missing cap reaches.
      const c = res.clean.loans[p.index]!;
      const reached = c.fees
        .filter((f) => f.assessed_on >= p.on)
        .map((f) => f.due)
        .sort()[0]!;
      expect(reached > p.on).toBe(true);
      // But the tape's cap: a partner's tape shows the terms the servicer's system holds from the boarding on.
      const held = (x: (typeof labels)[number]) =>
        x.file_or_table === "tape" && x.field === "terms.late_charge_max_cents";
      expect(labels.filter((x) => x.on < reached && !held(x))).toEqual([]);
      expect(
        labels.filter(held).every((x) => x.true_value === "1500" && x.planted_value === null),
      ).toBe(true);
      for (const x of labels) expect(x.defect_id).toBe("D-03");
      // Each charge differs exactly as the cap says: capped in the clean history, the full percent in the twin.
      const fees = labels.filter((x) => x.file_or_table === "fees" && x.field === "amount_cents");
      expect(fees.length).toBeGreaterThan(0);
      for (const f of fees) {
        const fee = c.fees.find((y) => y.id === f.row)!;
        const pi = c.installments.find((i) => i.due === fee.due)!.pi;
        expect(f.true_value).toBe(String(lateChargeAmount(pi, c.draw.late_charge.pct, 1_500n)));
        expect(f.planted_value).toBe(String(lateChargeAmount(pi, c.draw.late_charge.pct, null)));
      }
    }
    // The prior servicer's charge on loan 2 (before the transfer) is the same in both.
    const priorFee = res.clean.loans[2]!.fees.find(
      (f) => f.assessed_on < twin.loans[2]!.transfer_in_on!,
    )!;
    expect(twin.loans[2]!.fees.find((f) => f.id === priorFee.id)).toEqual(priorFee);
    // A loan the defect cannot apply to is refused by name.
    expect(() =>
      generate("twin", scenario, { calibration: cal, defects: [{ id: "D-03", loans: [0] }] }),
    ).toThrow(/D-03 cannot be planted on loan 0/);
  });

  it("hands an observer each receipt it posts and each analysis, and changes no draw", () => {
    const scenario = {
      loans: 4,
      random: { payoff: false },
      pins: { 1: { late_charge_cap_cents: 1_500, arm: null, escrowed: true } },
      events: [
        { kind: "missed_payment" as const, loan: 1, month: 9 },
        { kind: "missed_payment" as const, loan: 1, month: 33 },
      ],
    };
    const opts = { calibration: cal, defects: [{ id: "D-03", loans: [1] }] };
    const seen = { clean: new Map<number, LifeMoment[]>(), twin: new Map<number, LifeMoment[]>() };
    const watched = generate("observed", scenario, {
      ...opts,
      observe: (loan, history, m) =>
        seen[history].set(loan, [...(seen[history].get(loan) ?? []), m]),
    });
    const unwatched = generate("observed", scenario, opts);
    expect(toJsonLine(watched.clean)).toBe(toJsonLine(unwatched.clean));
    expect(toJsonLine(watched.defective)).toBe(toJsonLine(unwatched.defective));
    // One moment for every receipt the waterfall posts and every analysis, in order, in each history.
    const moments = (history: "clean" | "twin", i: number, l: LoanLife) => {
      const ms = seen[history].get(i) ?? [];
      expect(ms.flatMap((m) => (m.kind === "receipt" ? [m.receipt_id] : []))).toEqual(
        l.receipts.filter((r) => r.mode !== "payoff").map((r) => r.id),
      );
      expect(ms.flatMap((m) => (m.kind === "analysis" ? [m.year] : []))).toEqual(
        l.analyses.map((a) => a.year),
      );
    };
    unwatched.clean.loans.forEach((l, i) => moments("clean", i, l));
    expect(seen.clean.get(1)!.length).toBeGreaterThan(100);
    expect([...seen.twin.keys()]).toEqual([1]);
    moments("twin", 1, unwatched.defective!.loans[1]!);
    // A receipt's moment is the state it was posted against: the installments it paid are open in it.
    for (const m of seen.clean.get(1)!) {
      if (m.kind !== "receipt") continue;
      const row = unwatched.clean.loans[1]!.receipts.find((r) => r.id === m.receipt_id)!;
      for (const x of row.installments)
        expect(m.state.installments.find((i) => i.due_date === x.due)?.status).toBe("due");
    }
  });

  it("projects a month-end onto a partner tape's fields", () => {
    const month = "2031-06";
    const rows = bookTape(book, month);
    expect(rows.length).toBe(
      book.loans.filter((l) => l.months.some((m) => m.month === month)).length,
    );
    for (const r of rows) {
      const l = book.loans.find((x) => x.loan_id === r.loan_id)!;
      const m = l.months.find((x) => x.month === month)!;
      expect(r.pay_string).toMatch(/^[0369X]{12}$/);
      expect(r.cash_flow.length).toBe(12);
      const received = l.receipts
        .filter((x) => x.on.slice(0, 7) === month)
        .reduce((s, x) => s + x.amount, 0n);
      expect(r.cash_flow[11]).toBe(received);
      expect([
        r.balance.upb_cents,
        r.escrow.escrow_balance_cents,
        r.status.delinquency_days,
      ]).toEqual([m.upb, m.escrow_balance, m.days_delinquent]);
      expect(r.pay_string.at(-1)).toBe(
        { current: "0", "30": "3", "60": "6", "90": "9", "120+": "9" }[m.mba_status],
      );
      expect(r.pmi.pmi_flag).toBe(m.mi_active);
      if (!l.draw.mi) expect(r.pmi.pmi_flag).toBe(false);
      expect(r.foreclosure.fc_status).toBe(false);
      expect(r.bankruptcy.bk_status).toBe(false);
    }
    const prior = generate(
      "prior",
      { loans: 1, random: false, events: [{ kind: "transfer_in", loan: 0, month: 12 }] },
      { calibration: cal },
    ).clean.loans[0]!;
    const before = monthEndRow(prior, prior.months[3]!.month)!;
    expect([before.servicer, before.servicer_loan_number]).toEqual([
      "prior",
      prior.draw.prior_servicer_loan_number,
    ]);
    expect(monthEndRow(prior, "2099-01")).toBeNull();
  });

  it("reads a calibration file key by key, and every default is a design choice", () => {
    for (const k of CALIBRATION_KEYS) {
      expect(DEFAULT_CALIBRATION.rates[k]?.kind).toBe("design_choice");
      expect(DEFAULT_CALIBRATION.rates[k]?.source).toBe("none");
    }
    const none = loadCalibration({ path: "/nonexistent/calibration.json" });
    expect(none.path).toBeNull();
    expect(Object.values(none.entries).every((e) => e.used === "default")).toBe(true);
    const entry = (value: unknown, unit: string) => ({
      value,
      unit,
      kind: "public" as const,
      source: "https://example.org",
      fetched: "2026-10-01",
      terms: "public",
      note: "",
    });
    const read = loadCalibration({
      file: {
        version: "2026-10-23",
        rates: {
          "delinquency.cure_from_30": entry(45, "percent per month"),
          "transfer.annual_rate": entry(0.004, "share per month"),
          "book.ltv_distribution": entry(
            [
              { lo: 0.6, hi: 0.8, share: 3 },
              { lo: 0.8, hi: 0.95, share: 1 },
            ],
            "ratio",
          ),
          "book.note_rate_distribution": entry(
            { "<3": 10, "3 to 5": 30, "7+": 5 },
            "percent of loans",
          ),
          "payment.day_of_month": entry(
            { "1-5": 50, "6-10": 30, "11-31": 21 },
            "percent of payments",
          ),
          "refi.pmms_30y_series": entry(
            [
              ["2025-09-04", 6.5],
              ["2025-10-02", 6.3],
            ],
            "percent",
          ),
          "escrow.tax_annual_median": entry("about four thousand", "USD"),
          "not.a.key": entry(1, ""),
        },
      },
    });
    expect(read.rates.delinquency.cure_from_30).toBeCloseTo(0.45);
    expect(read.rates.transfer.annual_rate).toBeCloseTo(1 - Math.pow(0.996, 12));
    expect(read.rates.book.ltv.map((b) => [b.lo, b.hi, b.weight])).toEqual([
      [60, 80, 0.75],
      [80, 95, 0.25],
    ]);
    // Each open bin is as wide as the closed bin beside it.
    expect(read.rates.book.note_rate.map((b) => [b.lo, b.hi])).toEqual([
      [1, 3],
      [3, 5],
      [7, 9],
    ]);
    expect(read.rates.refi.pmms_30y.map((x) => x.rate)).toEqual([6.5, 6.3]);
    // Days 2 to 5 hold a fifth of their bin's half each, days 6 to 10 a fifth of 30, days 11 to 16 a 21st of 21.
    const days = read.rates.payment.day_of_month;
    expect([days[0]! / days[4]!, days[4]! / days[9]!]).toEqual([
      expect.closeTo(10 / 6, 9),
      expect.closeTo(6 / 1, 9),
    ]);
    expect(read.entries["delinquency.cure_from_30"]).toMatchObject({
      used: "file",
      kind: "public",
    });
    expect(read.entries["escrow.tax_annual_median"].used).toBe("default");
    expect(read.warnings.join("\n")).toMatch(/not\.a\.key/);
    expect(read.warnings.join("\n")).toMatch(/escrow\.tax_annual_median: value/);
    expect(read.warnings.join("\n")).toMatch(/payment\.partial_share: missing/);
  });

  it("comes out near the calibration's checks under the defaults", () => {
    const rows = new Map(calibrationCheck(book, cal).map((r) => [r.key, r]));
    const near = (key: Parameters<typeof rows.get>[0], lo: number, hi: number) => {
      const r = rows.get(key)!;
      expect(r.realized / r.target, `${key}: ${r.realized} against ${r.target}`).toBeGreaterThan(
        lo,
      );
      expect(r.realized / r.target, `${key}: ${r.realized} against ${r.target}`).toBeLessThan(hi);
    };
    near("delinquency.conventional_30plus_share", 0.4, 2.5);
    near("payment.missed_month_share", 0.5, 2);
    near("escrow.share_of_loans", 0.85, 1.2);
    near("contacts.per_loan_year", 0.7, 1.4);
  });

  it("runs on the calibration on disk, whatever it holds", () => {
    const disk = loadCalibration();
    const b = generate("disk", { loans: 40 }, { calibration: disk }).clean;
    expect(b.calibration.warnings).toEqual(disk.warnings);
    for (const l of b.loans) {
      expect(l.invariants.notes.filter((x) => !x.startsWith("paid to zero"))).toEqual([]);
      for (const m of l.months) expect(m.metro2.errors).toEqual([]);
    }
  });

  it("runs a thousand loan-decades in under fifteen seconds", () => {
    const t0 = performance.now();
    const big = generate(
      "speed",
      { loans: 1000, random: { payoff: false } },
      { calibration: cal },
    ).clean;
    const seconds = (performance.now() - t0) / 1000;
    expect(big.loans.reduce((s, l) => s + l.months.length, 0)).toBe(120_000);
    expect(seconds).toBeLessThan(15);
  });
});
