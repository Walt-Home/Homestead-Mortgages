/**
 * The transfer package and the defects planted through it: a package reads
 * back through the servicing app's decoder (ported) exactly as written; a
 * twin's package differs from its clean one only in the planted cells; the
 * gate's own rules pass every package, planted or not; the history behind
 * D-42 boards the loan non-escrowed and stops its escrow from that day; two
 * defects on one loan split their symptoms between them; each of the first
 * ten is rooted at its own value, its twin differs where the root reaches and
 * its package labels the root and every cell it reached; the servicer's
 * collection calls follow the D2-2-02 plan; and the demo loan tells the
 * plan's story, date by date, as the engines decide it.
 */

import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { applyFifo } from "../pmi/ported/delinquency.js";
import { toJsonLine } from "../record.js";
import { decodeTransferBatch, parseCsv } from "../boarding/ported/tape-codec.js";
import { gateFailures } from "../boarding/generator.js";
import {
  CAP_COLUMN,
  CORRESPONDENCE_FILE,
  DEFECTS,
  LAYOUT_FILES,
  PACKAGE_FILES,
  TAPE_HEADER,
  defaultCalibration,
  demoLoan,
  DEMO_TRANSFER_DATE,
  generate,
  monthEndRow,
  writeTransferPackage,
  type LoanLife,
} from "../life/index.js";

const cal = defaultCalibration();
const demo = demoLoan(cal);
const canon = (v: unknown) => toJsonLine(v);

/** A three-loan book transferred on one date: a capped note, a loan with no escrow, an ARM. */
const T = "2028-06-01" as PlainDate;
const scenario = {
  loans: 3,
  cohort_months: 1,
  outreach: true,
  pins: {
    0: { escrowed: true, late_charge_cap_cents: 1_500, arm: null },
    1: { escrowed: false },
    2: { escrowed: true, arm: "5/6" as const },
  },
  events: [0, 1, 2].map((loan) => ({ kind: "transfer_in" as const, loan, on: T })),
};
const book = generate("package", scenario, {
  calibration: cal,
  defects: [
    { id: "D-42", loans: [0] },
    { id: "D-03", loans: [0] },
  ],
});
const cleanPkg = writeTransferPackage(book.clean.loans.map((life) => ({ life })));
const plantedPkg = writeTransferPackage(
  book.defective!.loans.map((life, i) => ({ life, defects: i === 0 ? ["D-03", "D-42"] : [] })),
);

describe("the transfer package", () => {
  it("holds the sample's twelve files and the correspondence it lacks, every one as the manifest hashes it", () => {
    expect(Object.keys(cleanPkg.files)).toEqual([...PACKAGE_FILES]);
    expect(LAYOUT_FILES.length).toBe(12);
    for (const f of PACKAGE_FILES) {
      const m = cleanPkg.manifest.files[f]!;
      expect(m.row_count).toBe(cleanPkg.files[f].split("\n").filter((l) => l).length - 1);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The tape carries the layout's columns and four after them: the cap, the MI's value and date, the flood zone.
    expect(Object.keys(parseCsv(cleanPkg.files["boarding_tape.final.csv"])[0]!)).toEqual([
      ...TAPE_HEADER,
    ]);
    expect(TAPE_HEADER.slice(-4)).toEqual([CAP_COLUMN, ...TAPE_HEADER.slice(-3)]);
    expect(TAPE_HEADER.slice(-3)).toEqual([
      "mi_original_value",
      "mi_termination_date",
      "flood_zone",
    ]);
    expect(cleanPkg.manifest.designed_outcomes).toEqual({
      hard: {},
      warnings: {},
      defects: {},
      clean: cleanPkg.loans.map((l) => l.transferor_loan_number),
    });
  });

  it("reads back through the servicing app's decoder as exactly the loans it encodes", () => {
    const decoded = decodeTransferBatch(cleanPkg.files);
    expect(decoded.loans.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(canon(decoded.loans[i])).toBe(canon(cleanPkg.loans[i]));
  });

  it("carries the life-of-loan payment history, and the history says where the tape's next due date is", () => {
    for (const [i, s] of cleanPkg.loans.entries()) {
      const life = book.clean.loans[i]!;
      expect(s.installments[0]!.due_date).toBe(life.draw.first_due);
      for (let k = 1; k < s.installments.length; k++)
        expect(s.installments[k]!.due_date).toBe(addMonths(s.installments[k - 1]!.due_date, 1));
      const applied = applyFifo(s.installments, s.payments).installments;
      const unpaid = applied.find((x) => x.satisfied_on === null)!;
      expect(unpaid.due_date).toBe(s.next_due_date);
      expect(unpaid.amount_cents).toBe(s.pi_cents! + s.escrow_payment_cents);
    }
  });

  it("writes the prior servicer's statements with the late fee its system charges, from the cashiering engine", () => {
    const rows = parseCsv(cleanPkg.files[CORRESPONDENCE_FILE]);
    for (const [i, s] of cleanPkg.loans.entries()) {
      const d = book.clean.loans[i]!.draw;
      const statements = rows.filter(
        (r) =>
          r["transferor_loan_number"] === s.transferor_loan_number &&
          r["kind"] === "periodic_statement",
      );
      expect(statements.length).toBeGreaterThan(10);
      for (const r of statements) {
        const pi = BigInt(Math.round(Number(r["pi"]) * 100));
        const fee = BigInt(Math.round(Number(r["late_fee"]) * 100));
        expect(fee).toBe(lateChargeAmount(pi, d.late_charge.pct, d.late_charge.cap_cents));
        expect(r["sent_on"]! < T).toBe(true);
      }
      expect(
        rows.some(
          (r) =>
            r["transferor_loan_number"] === s.transferor_loan_number &&
            r["kind"] === "transfer_notice",
        ),
      ).toBe(true);
    }
    // Every row is the prior servicer's.
    expect(rows.every((r) => r["sent_on"]! < T)).toBe(true);
  });

  it("differs, planted, from the clean package only in the planted cells", () => {
    for (const f of PACKAGE_FILES)
      if (f !== "boarding_tape.final.csv") expect(plantedPkg.files[f]).toBe(cleanPkg.files[f]);
    const a = parseCsv(cleanPkg.files["boarding_tape.final.csv"]);
    const b = parseCsv(plantedPkg.files["boarding_tape.final.csv"]);
    const diffs = a.flatMap((row, i) =>
      Object.keys(row)
        .filter((k) => row[k] !== b[i]![k])
        .map((k) => [row["transferor_loan_number"], k, row[k], b[i]![k]]),
    );
    const n = a[0]!["transferor_loan_number"];
    expect(diffs).toEqual([
      [n, "escrowed", "Y", "Yes"],
      [n, CAP_COLUMN, "15.00", ""],
    ]);
    expect(
      plantedPkg.manifest.labels.map((l) => [
        l.loan,
        l.defect_id,
        l.field,
        l.true_value,
        l.planted_value,
        l.handling,
      ]),
    ).toEqual([
      [n, "D-03", CAP_COLUMN, "15.00", "", "query"],
      [n, "D-42", "escrowed", "Y", "Yes", "correct"],
    ]);
    expect(plantedPkg.manifest.designed_outcomes.defects).toEqual({ [n!]: ["D-03", "D-42"] });
  });

  it("passes the servicing app's gate, planted or clean: it sees neither defect", () => {
    for (const pkg of [cleanPkg, plantedPkg, ...Object.values(demo.packages)])
      for (const [loan, failed] of gateFailures(pkg)) expect([loan, failed]).toEqual([loan, []]);
    // The decoder reads Yes as N, and no cap from any package.
    const planted = decodeTransferBatch(plantedPkg.files).loans[0]!;
    expect(planted.escrowed).toBe(false);
    expect(decodeTransferBatch(cleanPkg.files).loans[0]!.escrowed).toBe(true);
    expect("late_charge_max_cents" in planted || "late_charge_max" in planted).toBe(false);
  });

  it("refuses a loan that was not transferred on the package's date, and a defect the note cannot carry", () => {
    const own = generate("own", { loans: 1, random: false }, { calibration: cal }).clean.loans[0]!;
    expect(() => writeTransferPackage([{ life: own }])).toThrow(/was never transferred/);
    expect(() => writeTransferPackage([{ life: book.clean.loans[1]!, defects: ["D-42"] }])).toThrow(
      /D-42 cannot be planted/,
    );
  });
});

describe("the defect registry", () => {
  it("holds the first ten, each with its place in a package and what the gate does with it", () => {
    expect(Object.keys(DEFECTS)).toEqual([
      "D-42",
      "D-35",
      "D-03",
      "D-01",
      "D-12",
      "D-37",
      "D-18",
      "D-24",
      "D-25",
      "D-15",
    ]);
    for (const d of Object.values(DEFECTS)) {
      expect(d.package?.file).toBe(
        d.id === "D-24" || d.id === "D-25" ? "payment_history.csv" : "boarding_tape.final.csv",
      );
      expect(d.package?.gate).toMatch(/^Nothing\./);
      expect(d.package?.cell === null).toBe(d.id === "D-24" || d.id === "D-25");
    }
    expect(
      Object.values(DEFECTS).map((d) => [d.id, d.package!.handling, d.requires_transfer]),
    ).toEqual([
      ["D-42", "correct", true],
      ["D-35", "correct", true],
      ["D-03", "query", false],
      ["D-01", "query", true],
      ["D-12", "correct", true],
      ["D-37", "correct", true],
      ["D-18", "query", true],
      ["D-24", "hold", true],
      ["D-25", "query", true],
      ["D-15", "correct", true],
    ]);
    expect(DEFECTS["D-42"]!.produces).toBe("D-31");
    expect(DEFECTS["D-42"]!.requires_transfer).toBe(true);
    expect(() =>
      generate(
        "never",
        { loans: 1, pins: { 0: { escrowed: true } } },
        {
          calibration: cal,
          defects: [{ id: "D-42", loans: [0] }],
        },
      ),
    ).toThrow(/enters through a transfer package/);
  });

  it("boards D-42's twin non-escrowed: from the transfer no escrow is billed, paid or analyzed", () => {
    const c = demo.clean;
    const t = demo.twins["D-42"];
    const on = t.transfer_in_on!;
    expect(t.boarded.terms.escrowed).toBe(false);
    expect(c.boarded.terms.escrowed).toBe(true);
    expect(t.installments.filter((i) => i.due >= on).every((i) => i.escrow === 0n)).toBe(true);
    expect(t.disbursements.filter((x) => x.on >= on && x.kind === "bill")).toEqual([]);
    expect(t.analyses.filter((a) => a.as_of >= on)).toEqual([]);
    expect(c.analyses.filter((a) => a.as_of >= on).length).toBeGreaterThan(5);
    // A partner's tape shows what the servicer's system holds: escrowed under the prior servicer, not once ours.
    expect([
      monthEndRow(t, "2027-11")!.escrow.escrowed,
      monthEndRow(t, "2028-01")!.escrow.escrowed,
    ]).toEqual([true, false]);
    expect(monthEndRow(c, "2028-01")!.escrow.escrowed).toBe(true);
    // The prior servicer's months are the same in both.
    const before = (l: LoanLife) => canon(l.receipts.filter((r) => r.on < on));
    expect(before(t)).toBe(before(c));
    expect(canon(t.at_transfer)).toBe(canon(c.at_transfer));
    // Every label is on or after the transfer; the root is loan_terms.escrowed.
    const labels = demo.labels["D-42"];
    expect(labels.filter((l) => l.on < on)).toEqual([]);
    expect(
      labels
        .filter((l) => l.root_cause)
        .map((l) => [l.file_or_table, l.field, l.true_value, l.planted_value]),
    ).toEqual([["loan_terms", "escrowed", "true", "false"]]);
    expect(new Set(labels.map((l) => l.file_or_table))).toEqual(
      new Set([
        "loan_terms",
        "payments",
        "disbursements",
        "escrow_analyses",
        "contacts",
        "borrower_events",
        "loan_installments",
        "month_ends",
        "metro2",
        "payoffs",
        "tape",
      ]),
    );
  });

  it("splits two defects' symptoms on one loan between them", () => {
    const both = demo.labels.defective;
    const alone = (id: "D-42" | "D-03") =>
      new Set(
        demo.labels[id]
          .filter((l) => !l.root_cause)
          .map((l) => `${l.file_or_table}|${l.row}|${l.field}`),
      );
    expect(both.filter((l) => l.root_cause).map((l) => l.defect_id)).toEqual(["D-03", "D-42"]);
    for (const l of both.filter((x) => !x.root_cause)) {
      const at = `${l.file_or_table}|${l.row}|${l.field}`;
      if (l.defect_id === "D-03" || l.defect_id === "D-42")
        expect(alone(l.defect_id).has(at)).toBe(true);
      else {
        expect(l.defect_id).toBe("D-03+D-42");
        expect(alone("D-03").has(at) || alone("D-42").has(at)).toBe(false);
      }
    }
    // The capped March charge is D-03's alone: $50.00 in the clean history, 5 % of the P&I in the twin.
    const fee = both.find((l) => l.file_or_table === "fees" && l.field === "amount_cents")!;
    expect([fee.defect_id, fee.true_value, fee.planted_value]).toEqual([
      "D-03",
      "5000",
      String(lateChargeAmount(demo.clean.draw.initial_pi_cents, "5", null)),
    ]);
  });
});

/**
 * A ten-loan book transferred on one date, each loan drawn with what one of the ten needs: an escrow account, a
 * repayment plan in force at the transfer, a capped note, a 5/6 ARM, a servicemember called to duty, a bankruptcy, MI,
 * a closing after the first of its month, an escrow account to misapply, a flood line. Each defect is planted on its
 * own loan, alone, so each twin is that defect's.
 */
const TEN_T = "2028-06-01" as PlainDate;
const TEN = [
  "D-42",
  "D-35",
  "D-03",
  "D-01",
  "D-12",
  "D-37",
  "D-18",
  "D-24",
  "D-25",
  "D-15",
] as const;
const ten = {
  loans: 10,
  cohort_months: 1,
  outreach: true,
  pins: {
    0: { escrowed: true },
    1: { escrowed: true, arm: null },
    2: { late_charge_cap_cents: 1_500, arm: null },
    3: { arm: "5/6" as const },
    4: { arm: null, note_rate_pct: "7.000" },
    5: { escrowed: true, fragility: 6, lateness: 4 },
    6: {
      mi: true,
      ltv_pct: 90,
      escrowed: true,
      arm: null,
      persona: "autopay" as const,
      fragility: 0.1,
    },
    7: { escrowed: true },
    8: { escrowed: true, arm: null },
    9: { escrowed: true, flood: true },
  },
  random: { payoff: false },
  events: [
    ...Array.from({ length: 10 }, (_, loan) => ({ kind: "transfer_in" as const, loan, on: TEN_T })),
    { kind: "missed_payment" as const, loan: 1, on: "2028-04-01" },
    { kind: "repayment_plan" as const, loan: 1, on: "2028-04-20", months: 6 },
    { kind: "active_duty" as const, loan: 4, on: "2027-09-10" },
    { kind: "bankruptcy" as const, loan: 5, on: "2027-12-05" },
  ],
};
const twinsOf = Object.fromEntries(
  TEN.map((id, k) => [
    id,
    generate("ten", ten, { calibration: cal, defects: [{ id, loans: [k] }] }),
  ]),
) as Record<(typeof TEN)[number], ReturnType<typeof generate>>;
const pair = (id: (typeof TEN)[number]) => {
  const k = TEN.indexOf(id);
  const r = twinsOf[id];
  return { c: r.clean.loans[k]!, t: r.defective!.loans[k]!, labels: r.labels };
};

describe("the first ten's twins", () => {
  it("roots each at its own value and dates every symptom on or after it, the prior servicer's months untouched but by D-25", () => {
    for (const id of TEN) {
      const { c, t, labels } = pair(id);
      const roots = labels.filter((l) => l.root_cause);
      expect([id, roots.map((l) => l.defect_id)]).toEqual([id, [id]]);
      const root = roots[0]!;
      // A label is dated by its row. A row older than the root is one the prior servicer wrote that the root changed
      // later: a charge it suspended, which the clean history waives at the plan's end and D-35's twin never does,
      // and the installment D-24's phantom row opens again at the boarding.
      for (const l of labels.filter((x) => x.on < root.on))
        expect([id, `${l.file_or_table} ${l.field}`]).toEqual([
          id,
          expect.stringMatching(
            /^(fees state|loan_installments (satisfied_on|credited_as_of|status))$/,
          ),
        ]);
      if (id === "D-25") expect(root.on < TEN_T).toBe(true);
      else {
        expect([id, root.on]).toEqual([id, TEN_T]);
        expect(canon(t.at_transfer)).toBe(canon(c.at_transfer));
        expect(canon(t.receipts.filter((r) => r.on < TEN_T))).toBe(
          canon(c.receipts.filter((r) => r.on < TEN_T)),
        );
      }
      expect([id, t.invariants.ok, c.invariants.ok]).toEqual([id, true, true]);
    }
  });

  it("D-35: a plan the servicer does not know of has its charges assessed, nothing waived, no plan reported", () => {
    const { c, t, labels } = pair("D-35");
    expect(c.at_transfer!.plan).toBeDefined();
    expect(t.boarded.terms.lossmit_carried).toBe(false);
    const after = (l: LoanLife) => l.months.filter((m) => m.as_of >= TEN_T);
    expect(after(c).some((m) => m.plan_active)).toBe(true);
    expect(after(t).some((m) => m.plan_active)).toBe(false);
    // Clean: the plan's charges accrue suspended and are waived or released at its end; twin: assessed from boarding.
    const assessedAfter = (l: LoanLife) =>
      l.fees.filter((f) => f.assessed_on >= TEN_T && f.state !== "accrued_suspended").length;
    expect(assessedAfter(t)).toBeGreaterThan(0);
    expect(labels.some((l) => l.file_or_table === "fees")).toBe(true);
    expect(
      labels.some((l) => l.file_or_table === "tape" && l.field === "status.repayment_plan"),
    ).toBe(true);
  });

  it("D-12: the servicemember's twin is billed the note's rate and P&I from boarding, with late charges again", () => {
    const { c, t, labels } = pair("D-12");
    expect(c.scra).toMatchObject({ called_on: "2027-09-10", first_due: "2027-10-01" });
    const after = (l: LoanLife) => l.installments.filter((i) => i.due > TEN_T);
    expect(after(c).every((i) => i.pi === c.scra!.capped_pi)).toBe(true);
    expect(after(t).every((i) => i.pi === t.draw.initial_pi_cents)).toBe(true);
    expect(c.months.filter((m) => m.as_of > TEN_T).every((m) => m.rate_pct === "6.000")).toBe(true);
    expect(t.months.filter((m) => m.as_of > TEN_T).every((m) => m.rate_pct === "7.000")).toBe(true);
    expect(labels.some((l) => l.file_or_table === "payments" && l.field === "installments")).toBe(
      true,
    );
  });

  it("D-37: the bankruptcy's twin reports no case and calls a borrower in bankruptcy once it is ours", () => {
    const { c, t } = pair("D-37");
    expect(c.bankruptcy).toEqual({ chapter: "13", filed_on: "2027-12-05" });
    const reported = (l: LoanLife) =>
      l.months
        .filter((m) => m.as_of >= TEN_T)
        .map((m) => monthEndRow(l, m.month)!.bankruptcy.bk_status);
    expect(reported(c).every(Boolean)).toBe(true);
    expect(reported(t).some(Boolean)).toBe(false);
    // Before the transfer the prior servicer knew of it: the months are the same.
    expect(monthEndRow(t, "2028-03")!.bankruptcy).toEqual(monthEndRow(c, "2028-03")!.bankruptcy);
    const calls = (l: LoanLife) =>
      l.contacts.filter((x) => x.direction === "outbound" && x.on >= "2027-12-05");
    expect(calls(c)).toEqual([]);
    expect(calls(t).every((x) => x.on >= TEN_T)).toBe(true);
    expect(calls(t).length).toBeGreaterThan(0);
  });

  it("D-18: the insurance's twin ends later than the date the original value gives", () => {
    const { c, t } = pair("D-18");
    const end = (l: LoanLife) => l.pmi.find((p) => p.status === "terminated")?.effective_on ?? null;
    expect(end(c)).not.toBeNull();
    expect(t.boarded.terms.mi_termination_date! > c.boarded.terms.mi_termination_date!).toBe(true);
    expect(end(t) === null || end(t)! > end(c)!).toBe(true);
  });

  it("D-24: the phantom row's twin boards an installment behind, and the next payment pays the one before its own", () => {
    const { c, t, labels } = pair("D-24");
    expect(t.boarded.terms.phantom_installment).toBe(addMonths(c.draw.first_due, -2));
    // The last installment the borrower paid the prior servicer is open again from the boarding: paid after it.
    const lastPaid = c
      .at_transfer!.installments.filter((i) => i.satisfied_on !== null && i.satisfied_on < TEN_T)
      .at(-1)!;
    const paidOn = (l: LoanLife) =>
      l.installments.find((i) => i.due === lastPaid.due)!.satisfied_on!;
    expect(paidOn(c) < TEN_T).toBe(true);
    expect(paidOn(t) >= TEN_T).toBe(true);
    // The next payment goes to it, so every receipt after the boarding pays the installment before its own.
    expect(labels.some((l) => l.file_or_table === "payments" && l.field === "installments")).toBe(
      true,
    );
    // The prior servicer's calls are what they were.
    const before = (l: LoanLife) => l.contacts.filter((x) => x.on < TEN_T);
    expect(canon(before(t))).toBe(canon(before(c)));
  });

  it("D-25: the misapplied payment's principal stays on the balance and sits in escrow from the day it is posted", () => {
    const { c, t, labels } = pair("D-25");
    const due = t.history_plant!.misapplied;
    const r = (l: LoanLife) => l.receipts.find((x) => x.installments.some((i) => i.due === due))!;
    expect(r(t).installments[0]!.principal).toBe(0n);
    expect(r(t).installments[0]!.escrow).toBe(
      r(c).installments[0]!.escrow + r(c).installments[0]!.principal,
    );
    expect(t.at_transfer!.upb).toBeGreaterThan(c.at_transfer!.upb);
    const root = labels.find((l) => l.root_cause)!;
    expect([root.file_or_table, root.field, root.row, root.planted_value]).toEqual([
      "payment_allocations",
      "principal",
      r(c).id,
      "0",
    ]);
    // The package writes it from the twin's books: the root in the history, the balance it left on the tape.
    const pkg = writeTransferPackage([{ life: t, clean: c, defects: ["D-25"] }]);
    const labelled = pkg.manifest.labels.map(
      (l) => `${l.root_cause ? "root" : "symptom"} ${l.file_or_table} ${l.field}`,
    );
    expect(labelled[0]).toBe("root payment_history.csv principal");
    expect(labelled).toContain("symptom boarding_tape.final.csv upb");
    expect(() => writeTransferPackage([{ life: t, defects: ["D-25"] }])).toThrow(
      /clean twin's history/,
    );
  });

  it("D-01, D-15: what the generator does not compute leaves the twin's history as it was but for the root", () => {
    for (const id of ["D-15"] as const) {
      const { labels } = pair(id);
      expect(labels.filter((l) => !l.root_cause)).toEqual([]);
    }
    const { t, labels } = pair("D-01");
    expect(t.boarded.terms.arm!.initial_cap_pct).toBe(t.draw.arm!.periodic_cap_pct);
    // A difference, where the first change binds on the wrong cap, is in the rate change and what follows it.
    const first = t.draw.arm!.first_change;
    for (const l of labels.filter((x) => !x.root_cause))
      expect(l.on >= addMonths(first, -2)).toBe(true);
  });

  it("writes each into a package the gate passes, labelling the root and every cell it reached", () => {
    for (const id of TEN) {
      const { c, t } = pair(id);
      const pkg = writeTransferPackage([{ life: t, clean: c, defects: [id] }]);
      const roots = pkg.manifest.labels.filter((l) => l.root_cause);
      expect([id, roots.length, roots[0]!.defect_id]).toEqual([id, 1, id]);
      expect(pkg.manifest.designed_outcomes.defects).toEqual({ [roots[0]!.loan]: [id] });
      for (const [loan, failed] of gateFailures(pkg))
        expect([id, loan, failed]).toEqual([id, loan, []]);
    }
  });
});

describe("the servicer's collection calls", () => {
  it("follow the D2-2-02 plan: day 17, then every 7 days, ceased by a promise, closed by the cure", () => {
    const res = generate(
      "calls",
      {
        loans: 1,
        cohort_months: 1,
        random: false,
        outreach: true,
        pins: { 0: { persona: "autopay" } },
        events: [
          { kind: "missed_payment", loan: 0, month: 6 },
          { kind: "missed_payment", loan: 0, month: 7 },
          { kind: "missed_payment", loan: 0, month: 20 },
          { kind: "promise_to_pay", loan: 0, month: 20, day: 25, pay_in_days: 12 },
        ],
      },
      { calibration: cal },
    ).clean.loans[0]!;
    const calls = res.contacts.filter((c) => c.direction === "outbound");
    const due6 = addMonths(res.draw.first_due, 6);
    const first = calls.filter((c) => c.on > due6 && c.on < addMonths(due6, 3));
    expect(first[0]!.on).toBe(addDays(due6, 17));
    for (let k = 1; k < first.length; k++) {
      const gap = daysBetween(first[k - 1]!.on, first[k]!.on);
      expect(gap >= 7 && gap <= 10).toBe(true);
    }
    // The cure closes it: no call after the cure that paid both missed installments.
    const cure = res.receipts.find((r) => r.on > due6 && r.mode === "cure")!;
    expect(first.every((c) => c.on <= cure.on)).toBe(true);
    // Month 20: the attempt on day 17, then the promise on day 24 ceases it until it is kept.
    const due20 = addMonths(res.draw.first_due, 20);
    const later = calls.filter((c) => c.on > due20 && c.on < addMonths(due20, 2));
    expect(later.map((c) => c.on)).toEqual([addDays(due20, 17)]);
    // Off, a history has the borrower's own calls only.
    const off = generate(
      "calls",
      { loans: 1, random: false, events: [{ kind: "missed_payment", loan: 0, month: 6 }] },
      { calibration: cal },
    );
    expect(off.clean.loans[0]!.contacts.every((c) => c.direction === "inbound")).toBe(true);
  });
});

describe("the demo loan", () => {
  const c = demo.clean;
  it("is a 30-year fixed Fannie Mae loan at 90 % with borrower-paid MI and escrow, another servicer's for two years", () => {
    expect([
      c.draw.arm,
      c.draw.ltv_pct,
      c.draw.term_months,
      c.draw.escrowed,
      c.draw.mi?.borrower_paid,
    ]).toEqual([null, 90, 360, true, true]);
    expect(c.draw.first_due).toBe("2026-03-01");
    expect(c.transfer_in_on).toBe(DEMO_TRANSFER_DATE);
    expect(c.months.filter((m) => m.servicer === "prior").length).toBe(21);
    expect(c.invariants).toEqual({ ok: true, notes: [] });
  });

  it("year 3: March missed, a late charge on day 16, a call on day 17, a promise on day 22, caught up on 5 April", () => {
    expect(c.behavior.find((b) => b.kind === "missed")?.due).toBe("2028-03-01");
    const fee = c.fees.find((f) => f.due === "2028-03-01")!;
    expect([
      fee.assessed_on,
      fee.amount,
      daysBetween("2028-03-01" as PlainDate, fee.assessed_on),
    ]).toEqual(["2028-03-17", 5_000n, 16]);
    const calls = c.contacts.filter((x) => x.direction === "outbound" && x.on.startsWith("2028-0"));
    expect(calls.map((x) => x.on)).toEqual(["2028-03-18"]);
    expect(c.contacts.find((x) => x.reason === "promise_to_pay")?.on).toBe("2028-03-23");
    const kept = c.receipts.find((r) => r.mode === "promise")!;
    expect([kept.on, kept.late_charge]).toEqual(["2028-04-05", 5_000n]);
    expect(c.months.find((m) => m.month === "2028-04")!.days_delinquent).toBe(0);
  });

  it("year 4: a reassessment and a renewal raise the escrow, the analysis is flagged, bill pay sends the old amount to suspense", () => {
    const a = c.analyses.find((x) => x.effective === "2030-03-01")!;
    expect(a.decision).toBe("shortage");
    expect(a.anomalies.length).toBeGreaterThan(0);
    expect(a.new_payment).toBeGreaterThan(a.old_payment);
    const stale = c.receipts.find((r) => r.mode === "stale_bill_pay")!;
    expect(stale.on).toBe("2030-02-26");
    expect(stale.outcome).toBe("unapplied");
    expect(stale.to_suspense).toBe(stale.amount);
    // No late charge: cashiering counts the suspense toward the P&I basis (latecharges.ts:58-66), and the old amount covers it.
    const run = c.late_charge_runs.find((r) => r.due === "2030-03-01")!;
    expect([run.outcome, run.reason]).toEqual(["not_assessed", "paid within grace"]);
    // Late all the same: the calls on days 17 and 24, and the April payment catches up.
    const calls = c.contacts.filter((x) => x.direction === "outbound" && x.on.startsWith("2030-"));
    expect(calls.map((x) => x.on)).toEqual(["2030-03-18", "2030-03-25"]);
    const cure = c.receipts.find((r) => r.on > stale.on)!;
    expect([cure.on, cure.mode]).toEqual(["2030-03-29", "cure"]);
    expect(c.months.find((m) => m.month === "2030-03")!.suspense).toBe(0n);
  });

  it("years 5 to 10: the MI ends at its 78 % date, and the loan is paid off", () => {
    expect(c.pmi.map((p) => [p.trigger, p.status])).toEqual([["2035-03-01", "terminated"]]);
    expect(c.payoff?.on).toBe("2035-09-14");
    expect(c.months.at(-1)!.status).toBe("paid_off");
  });

  it("transfers with a Yes in its escrow cell and no cap on its tape, and the twins' packages say so", () => {
    const rows = (p: keyof typeof demo.packages) =>
      parseCsv(demo.packages[p].files["boarding_tape.final.csv"])[0]!;
    expect([rows("clean")["escrowed"], rows("clean")[CAP_COLUMN]]).toEqual(["Y", "50.00"]);
    expect([rows("D-42")["escrowed"], rows("D-42")[CAP_COLUMN]]).toEqual(["Yes", "50.00"]);
    expect([rows("D-03")["escrowed"], rows("D-03")[CAP_COLUMN]]).toEqual(["Y", ""]);
    expect([rows("defective")["escrowed"], rows("defective")[CAP_COLUMN]]).toEqual(["Yes", ""]);
    // The prior servicer's statements quote the capped fee.
    const last = parseCsv(demo.packages.defective.files[CORRESPONDENCE_FILE])
      .filter((r) => r["kind"] === "periodic_statement")
      .at(-1)!;
    expect([last["pi"], last["late_fee"]]).toEqual(["2275.44", "50.00"]);
  });
});
