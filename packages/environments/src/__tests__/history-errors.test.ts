/**
 * Vendor and system errors made in a loan's history after boarding, planted
 * as labeled twins: a tax bill the tax service reported wrong (V-01), a
 * hazard renewal billed to the prior servicer (V-02), a payment drafted twice
 * (D-28) and a payment posted to a neighboring loan number (D-25, both loans;
 * the registry's `D-25/wrong-loan`, beside the prior servicer's split, `D-25`).
 * Each twin is the clean history until the event the error is made on and the
 * engines' after it; its root cause is the record the error wrote, labeled
 * apart from every symptom downstream of it.
 */

import { describe, expect, it } from "vitest";
import { addDays, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { toJsonLine } from "../record.js";
import {
  DEFECTS,
  defaultCalibration,
  generate,
  keystrokeApart,
  monthEndRow,
  onOurBooks,
  type DefectLabel,
  type LoanLife,
  type Scenario,
} from "../life/index.js";

const cal = defaultCalibration();

/**
 * Five loans: two escrowed without MI, one of them transferred to us in its
 * sixth month (V-01, V-02); a payer and the loan a keystroke away that its
 * payment lands on, which has no escrow (D-25); and a borrower who pays in the
 * month an installment is due, whose second draft pays the next one (D-28).
 */
const base: Scenario = {
  loans: 5,
  cohort_months: 1,
  months: 48,
  random: { payoff: false },
  pins: {
    0: { escrowed: true, mi: false },
    1: { escrowed: true, mi: false },
    2: { escrowed: true },
    3: { escrowed: false },
    4: { persona: "autopay" },
  },
  events: [{ kind: "transfer_in", loan: 1, month: 6 }],
};
const first = generate("history-errors", base, { calibration: cal }).clean;
/** Loan 3's number a keystroke from loan 2's: where a payment keyed wrong lands. */
const neighbor = (() => {
  const a = first.loans[2]!.draw.servicer_loan_number;
  return a.slice(0, -1) + String((Number(a.at(-1)) + 1) % 10);
})();
const scenario: Scenario = {
  ...base,
  pins: { ...base.pins, 3: { ...base.pins![3], servicer_loan_number: neighbor } },
};
/** Each error's key in the registry: D-25 is planted in its wrong-loan form, and its labels name D-25. */
const KEY: Readonly<Record<string, string>> = {
  "V-01": "V-01",
  "V-02": "V-02",
  "D-28": "D-28",
  "D-25": "D-25/wrong-loan",
};
const def = (id: string) => DEFECTS[KEY[id]!]!;
const requests = [
  { id: "V-01", loans: [0], at: "2027-06" },
  { id: "V-02", loans: [1] },
  { id: "D-28", loans: [4], at: "2027-03" },
  { id: "D-25/wrong-loan", loans: [2], at: "2028-02", with: [3] },
];
const clean = generate("history-errors", scenario, { calibration: cal });
const res = generate("history-errors", scenario, { calibration: cal, defects: requests });
const twin = res.defective!;
const roots = (id: string) => res.labels.filter((l) => l.defect_id === id && l.root_cause);
const symptoms = (id: string, loan: string) =>
  res.labels.filter((l) => l.defect_id === id && !l.root_cause && l.loan === loan);
const L = (i: number) => res.clean.loans[i]!;
const T = (i: number) => twin.loans[i]!;

describe("history errors", () => {
  it("leave the clean history as it was, and plant each on the event asked for", () => {
    expect(toJsonLine(res.clean)).toBe(toJsonLine(clean.clean));
    // A pinned loan number moves nothing but itself.
    for (const i of [0, 1, 2, 4]) expect(toJsonLine(L(i))).toBe(toJsonLine(first.loans[i]));
    expect(L(3).draw.servicer_loan_number).toBe(neighbor);
    expect(toJsonLine({ ...L(3).draw, servicer_loan_number: "" })).toBe(
      toJsonLine({ ...first.loans[3]!.draw, servicer_loan_number: "" }),
    );
    expect(res.planted.map((p) => [p.index, p.defect_id])).toEqual([
      [0, "V-01"],
      [1, "V-02"],
      [2, "D-25"],
      [3, "D-25"],
      [4, "D-28"],
    ]);
    for (const p of res.planted) {
      expect(p.on >= "2026-03-01").toBe(true);
      const r = requests.find((x) => x.id === KEY[p.defect_id])!;
      if (r.at) expect(p.on >= `${r.at}-01`).toBe(true);
    }
    for (const l of twin.loans) expect([l.loan_id, l.invariants.ok]).toEqual([l.loan_id, true]);
  });

  it("labels each root apart from its symptoms, and nothing before the error", () => {
    for (const id of ["V-01", "V-02", "D-28", "D-25"]) {
      const rs = roots(id);
      expect(rs.length).toBe(id === "D-25" ? 2 : 1);
      for (const r of rs) {
        expect(r.expected_handling).toBe(def(id).handling);
        const ss = symptoms(id, r.loan);
        expect(ss.length, id).toBeGreaterThan(0);
        // The twin is the clean history until the error: nothing differs before it.
        expect(ss.filter((s) => s.on < r.on)).toEqual([]);
        // The root is the root once: the comparison does not find it again as a symptom.
        for (const s of ss)
          expect(`${s.file_or_table}|${s.row}|${s.field}`).not.toBe(
            `${r.file_or_table}|${r.row}|${r.field}`,
          );
        for (const s of ss)
          expect(s.expected_handling).toBe(
            def(id).symptomHandling(s.file_or_table, s.field, s.row),
          );
      }
    }
    // Every label is one of the four's: no loan carries a second defect's, and no pair's.
    expect(new Set(res.labels.map((l) => l.defect_id))).toEqual(
      new Set(["V-01", "V-02", "D-28", "D-25"]),
    );
  });

  it("pays V-01's tax bill at the vendor's figure, ten times the county's, until the county returns the excess", () => {
    const [r] = roots("V-01") as [DefectLabel];
    expect([r.file_or_table, r.field]).toEqual(["escrow_bills", "amount_cents"]);
    expect(BigInt(r.planted_value!)).toBe(BigInt(r.true_value!) * 10n);
    const [line, due] = r.row.split("@") as [string, PlainDate];
    const paid = T(0).disbursements.find(
      (x) => x.line === line && x.on === due && x.kind === "bill",
    )!;
    const billed = L(0).disbursements.find((x) => x.id === paid.id)!;
    expect([billed.on, String(billed.amount), String(paid.amount)]).toEqual([
      due,
      r.true_value,
      r.planted_value,
    ]);
    const returned = T(0).disbursements.find((x) => x.id === `${paid.id}-RET`)!;
    expect(returned.kind).toBe("returned");
    expect(returned.amount).toBe(-(paid.amount - billed.amount));
    expect(daysBetween(due, returned.on)).toBeGreaterThanOrEqual(45);
    expect(daysBetween(due, returned.on)).toBeLessThanOrEqual(120);
    // Between the two the account is short by the excess; the symptoms name the payment and the returned row.
    const ss = symptoms("V-01", L(0).loan_id);
    expect(
      ss.find((s) => s.file_or_table === "disbursements" && s.field === "amount"),
    ).toMatchObject({
      // The bill is named as its root is: its line and the day it was due.
      row: r.row,
      true_value: r.true_value,
      planted_value: r.planted_value,
    });
    expect(
      ss.find((s) => s.file_or_table === "disbursements" && s.row === `returned@${returned.on}`),
    ).toMatchObject({ field: "*", true_value: null });
    for (const m of L(0).months.filter((x) => x.as_of >= due && x.as_of < returned.on)) {
      const t = T(0).months.find((y) => y.month === m.month)!;
      expect(m.escrow_balance - t.escrow_balance, m.month).toBe(paid.amount - billed.amount);
    }
  });

  it("pays V-02's renewal late, when the prior servicer sends it on, and holds the premium in escrow meanwhile", () => {
    const [r] = roots("V-02") as [DefectLabel];
    expect([r.file_or_table, r.field, r.true_value, r.planted_value]).toEqual([
      "insurance_policies",
      "mortgagee_clause",
      "servicer",
      "prior_servicer",
    ]);
    const due = r.on;
    // The first renewal after the transfer.
    expect(due >= L(1).transfer_in_on!).toBe(true);
    expect(
      L(1).disbursements.filter(
        (x) => x.line === "hazard" && x.on >= L(1).transfer_in_on! && x.on < due,
      ),
    ).toEqual([]);
    const c = L(1).disbursements.find((x) => x.line === "hazard" && x.on === due)!;
    const t = T(1).disbursements.find((x) => x.id === c.id)!;
    expect([t.amount, t.line, t.kind]).toEqual([c.amount, "hazard", "bill"]);
    expect(daysBetween(due, t.on)).toBeGreaterThanOrEqual(30);
    expect(daysBetween(due, t.on)).toBeLessThanOrEqual(75);
    expect(symptoms("V-02", L(1).loan_id).find((s) => s.field === "on")).toMatchObject({
      file_or_table: "disbursements",
      row: `hazard@${due}`,
      true_value: due,
      planted_value: t.on,
    });
    for (const m of L(1).months.filter((x) => x.as_of >= due && x.as_of < t.on)) {
      const x = T(1).months.find((y) => y.month === m.month)!;
      expect(x.escrow_balance - m.escrow_balance, m.month).toBe(c.amount);
    }
  });

  it("drafts D-28's payment twice, which pays the next installment ahead", () => {
    const [r] = roots("D-28") as [DefectLabel];
    const planted = JSON.parse(r.planted_value!) as {
      id: string;
      on: string;
      amount: string;
      duplicate_of: string;
    };
    expect([r.file_or_table, r.field, r.row, r.true_value]).toEqual([
      "payments",
      "*",
      `${r.on}:duplicate`,
      null,
    ]);
    const original = L(4).receipts.find((x) => x.id === planted.duplicate_of)!;
    expect([original.on, String(original.amount), original.mode]).toEqual([
      r.on,
      planted.amount,
      "regular",
    ]);
    const dup = T(4).receipts.find((x) => x.id === planted.id)!;
    expect([dup.on, dup.amount, dup.mode]).toEqual([original.on, original.amount, "duplicate"]);
    // The second draft paid the next installment, and the borrower's own payment for it found it paid.
    expect(dup.installments.map((x) => x.kind)).toContain("prepaid");
    const next = dup.installments[0]!.due;
    expect(T(4).behavior.some((b) => b.kind === "already_paid" && b.due === next)).toBe(true);
    expect(L(4).behavior.some((b) => b.kind === "already_paid" && b.due === next)).toBe(false);
  });

  it("posts D-25's payment to the loan a keystroke away: open on one, paid ahead on the other", () => {
    const rs = roots("D-25");
    const payer = rs.find((x) => x.loan === L(2).loan_id)!;
    const lands = rs.find((x) => x.loan === L(3).loan_id)!;
    const sent = JSON.parse(payer.true_value!) as {
      id: string;
      on: PlainDate;
      amount: string;
      loan: string;
    };
    expect([payer.planted_value, lands.true_value]).toEqual([null, null]);
    expect(JSON.parse(lands.planted_value!)).toEqual({
      id: `${sent.id}-MIS`,
      on: sent.on,
      amount: sent.amount,
      keyed_from: L(2).draw.servicer_loan_number,
    });
    expect(keystrokeApart(sent.loan, L(3).draw.servicer_loan_number)).toBe(true);
    expect(T(2).receipts.find((x) => x.id === sent.id)).toBeUndefined();
    const mis = T(3).receipts.find((x) => x.id === `${sent.id}-MIS`)!;
    expect([mis.on, String(mis.amount), mis.mode, mis.channel]).toEqual([
      sent.on,
      sent.amount,
      "misposted",
      "misposted",
    ]);
    // At the month-end the payer's installment is still open, and the tape says so; the other loan got the money.
    const month = sent.on.slice(0, 7);
    const c2 = monthEndRow(L(2), month)!;
    const t2 = monthEndRow(T(2), month)!;
    expect(t2.status.next_due_date! < c2.status.next_due_date!).toBe(true);
    expect(t2.cash_flow[11]! + BigInt(sent.amount)).toBe(c2.cash_flow[11]!);
    const c3 = monthEndRow(L(3), month)!;
    const t3 = monthEndRow(T(3), month)!;
    expect(t3.cash_flow[11]! - c3.cash_flow[11]!).toBe(BigInt(sent.amount));
    // A late charge follows on the payer's loan, which the clean history never charged.
    expect(symptoms("D-25", L(2).loan_id).some((s) => s.file_or_table === "late_charge_runs")).toBe(
      true,
    );
  });

  it("refuses an error it cannot make, by name", () => {
    const at = (id: string, extra: object) =>
      generate("history-errors", scenario, { calibration: cal, defects: [{ id, ...extra }] });
    expect(() => at("V-02", { loans: [0] })).toThrow(
      /V-02 cannot be planted on loan 0: .*never was/,
    );
    expect(() => at("V-01", { loans: [3], at: "2027-01" })).toThrow(
      /V-01 cannot be planted on loan 3/,
    );
    expect(() => at("D-28", { loans: [0], at: "2040-01" })).toThrow(
      /nothing it can be made on from 2040-01/,
    );
    expect(() => at("D-25/wrong-loan", { loans: [0], with: [1] })).toThrow(
      /no loan it can land on/,
    );
    // The registry's D-25 is the prior servicer's split, which enters through a transfer package.
    expect(() => at("D-25", { loans: [2] })).toThrow(
      /D-25 cannot be planted on loan 2: it enters through a transfer package/,
    );
    expect(() => at("V-01", { loans: [0], with: [1] })).toThrow(/moves money between loans/);
    expect(() => at("D-03", { loans: [0], at: "2027-01" })).toThrow(/enters at boarding/);
  });

  it("draws an error at a rate per event, from streams of its own, and lands D-25 only where a number is mistyped", () => {
    const drawn = (id: string, rate: number) =>
      generate("history-errors", scenario, { calibration: cal, defects: [{ id, rate }] });
    const a = drawn("D-28", 0.05);
    const b = drawn("D-28", 0.05);
    expect(toJsonLine(a.labels)).toBe(toJsonLine(b.labels));
    expect(toJsonLine(a.clean)).toBe(toJsonLine(clean.clean));
    const receipts = clean.clean.loans.reduce(
      (s, l) => s + l.receipts.filter((x) => x.servicer === "us" && x.mode === "regular").length,
      0,
    );
    expect(a.planted.length).toBeGreaterThan(0);
    expect(a.planted.length).toBeLessThan(receipts / 8);
    // Every receipt drawn: only loans 2 and 3 have a neighbor to land on, and each lands on the other.
    const d25 = drawn("D-25/wrong-loan", 1);
    expect(new Set(d25.planted.map((p) => p.index))).toEqual(new Set([2, 3]));
    // Every tax bill on our books, ten times over.
    const v01 = drawn("V-01", 1);
    const bills = (l: LoanLife) =>
      l.disbursements.filter(
        (x) => x.kind === "bill" && x.line.startsWith("tax") && x.servicer === "us",
      ).length;
    expect(v01.planted.length).toBe(clean.clean.loans.reduce((s, l) => s + bills(l), 0));
  });

  it("names a disbursement by its line and due date, so a refund in one history moves no other row", () => {
    // Every tax bill ten times over: the analyses that follow refund in one history and not the other, which once
    // renumbered every later bill and labeled each with another bill's day, line and amount.
    const v01 = generate("history-errors", scenario, {
      calibration: cal,
      defects: [{ id: "V-01", rate: 1 }],
    });
    const paid = v01.labels.filter((l) => l.file_or_table === "disbursements" && !l.root_cause);
    const refunds = paid.filter((l) => /^(refund|payoff_refund)@/.test(l.row));
    expect(refunds.length).toBeGreaterThan(0);
    for (const l of refunds)
      expect(l.expected_handling).toBe(
        DEFECTS["V-01"]!.symptomHandling(l.file_or_table, l.field, l.row),
      );
    // A bill's day, line and kind never differ; its amount differs only on a bill paid at the vendor's figure.
    expect(paid.filter((l) => ["on", "line", "kind"].includes(l.field))).toEqual([]);
    const roots = new Set(v01.labels.filter((l) => l.root_cause).map((l) => `${l.loan}|${l.row}`));
    for (const l of paid.filter(
      (x) => x.field === "amount" && !/^(refund|payoff_refund)@/.test(x.row),
    )) {
      expect(roots.has(`${l.loan}|${l.row}`), l.row).toBe(true);
      expect(BigInt(l.planted_value!)).toBe(BigInt(l.true_value!) * 10n);
    }
    // The same holds for the errors that move payments rather than bills.
    for (const id of ["D-28", "D-25/wrong-loan"]) {
      const res = generate("history-errors", scenario, {
        calibration: cal,
        defects: [{ id, rate: id === "D-25/wrong-loan" ? 1 : 0.2 }],
      });
      const moved = res.labels.filter(
        (l) => l.file_or_table === "disbursements" && ["on", "line", "kind"].includes(l.field),
      );
      expect(moved, id).toEqual([]);
    }
  });

  it("knows a keystroke from a different number, and a loan on our books from one that is not", () => {
    expect(keystrokeApart("7012345678", "7012345679")).toBe(true);
    expect(keystrokeApart("7012345678", "7012345687")).toBe(true);
    expect(keystrokeApart("7012345678", "7012345699")).toBe(false);
    expect(keystrokeApart("7012345678", "7012345678")).toBe(false);
    expect(keystrokeApart("7012345678", "701234567")).toBe(false);
    const transferred = L(1);
    expect(onOurBooks(transferred, addDays(transferred.transfer_in_on!, -1))).toBe(false);
    expect(onOurBooks(transferred, transferred.transfer_in_on!)).toBe(true);
  });
});
