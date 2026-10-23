/**
 * The demo loan: the plan's first demo, as a scenario over the generator.
 *
 * A 30-year fixed Fannie Mae loan at 90 % loan-to-value with borrower-paid
 * mortgage insurance and escrow, paid by the borrower's bank bill pay a few
 * days before each due date. The first payment is due 1 March 2026; a loan
 * year runs from March. Its story, by loan year:
 *
 *   - years 1 and 2: another servicer's. The loan reaches us by transfer on
 *     16 December 2027, and the prior servicer's months are generated in full;
 *   - the transfer: the package carries the escrow flag as "Yes", which the
 *     servicing app's decoder reads as No (D-42, so the loan boards
 *     non-escrowed, D-31), and leaves out the note's $50 cap on a late charge
 *     (D-03). The clean twin carries both right;
 *   - year 3: March's payment is missed. The late charge is assessed on day 16
 *     (17 March), the servicer's collection calls begin on day 17 and would
 *     come every 7 days, a promise on day 22 (23 March) to pay by 5 April
 *     ceases them, and the borrower catches up on 5 April;
 *   - year 4: the county reassesses the house and the insurer raises the
 *     premium at the January renewal, so the analysis for the year from March
 *     2030 finds a shortage and is flagged; the payment rises from 1 March,
 *     bill pay sends the old amount one more month (on 26 February, for
 *     March), and the short payment goes to suspense. The plan has a late
 *     charge here too; the cashiering engine charges none, because it counts
 *     funds held in suspense toward the installment's P&I (decision 2.7-Q1,
 *     `receivedTowardBasis`, latecharges.ts:58-66), and the old amount covers
 *     the P&I. The installment is late all the same: the collection calls come
 *     on days 17 and 24, and the April payment on 29 March catches up;
 *   - years 5 to 9: ordinary;
 *   - year 10: the mortgage insurance ends on its own schedule on 1 March
 *     2035, at the 78 % date, and the loan is paid off in September.
 *
 * The 60-day transfer shield is why the transfer is in December: the
 * cashiering engine shields every installment due within 60 days of the
 * transfer date (`assessLateCharge`, latecharges.ts:83), so a transfer on 1
 * January 2028 would have left March's charge unassessed.
 *
 * `demoLoan()` runs the clean history and three twins (D-42 alone, D-03
 * alone, and both, the demo's defective loan) and writes each one's transfer
 * package. Every figure is the engines'; the scenario only dates the events.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import { loadCalibration, type Calibration } from "./calibration.js";
import type { DefectLabel } from "./defects.js";
import { generate } from "./generate.js";
import type { Scenario } from "./scenario.js";
import type { LoanLife } from "./simulate.js";
import { writeTransferPackage, type TransferPackage } from "./transfer-package.js";

export const DEMO_SEED = "demo-1";
export const DEMO_TRANSFER_DATE = "2027-12-16" as PlainDate;
/** The demo's defective twin carries both. */
export const DEMO_DEFECTS = ["D-03", "D-42"] as const;

export const DEMO_SCENARIO: Scenario = {
  name: "the first demo: transferred with a Yes escrow cell and no late-fee cap",
  loans: 1,
  start: "2026-03-01",
  cohort_months: 1,
  months: 120,
  random: false,
  outreach: true,
  pins: {
    0: {
      arm: null,
      ltv_pct: 90,
      mi: true,
      escrowed: true,
      orig_upb_cents: 36_000_000,
      note_rate_pct: "6.500",
      late_charge_cap_cents: 5_000,
      state: "OH",
      persona: "early",
      lateness: 1,
      fragility: 1,
    },
  },
  events: [
    { kind: "transfer_in", loan: 0, on: DEMO_TRANSFER_DATE },
    // Year 3.
    { kind: "missed_payment", loan: 0, on: "2028-03-01" },
    { kind: "promise_to_pay", loan: 0, on: "2028-03-23", pay_on: "2028-04-05" },
    // Year 4.
    { kind: "tax_reassessment", loan: 0, on: "2029-03-01", pct: 35 },
    { kind: "insurance_increase", loan: 0, on: "2029-03-01", pct: 30 },
    { kind: "bill_pay_stale", loan: 0, on: "2030-02-01" },
    // Year 10.
    { kind: "payoff", loan: 0, on: "2035-09-14" },
  ],
};

export interface DemoLoan {
  readonly clean: LoanLife;
  /** The twins, by what is planted: each defect alone, and both (the demo's defective loan). */
  readonly twins: {
    readonly "D-42": LoanLife;
    readonly "D-03": LoanLife;
    readonly defective: LoanLife;
  };
  /** The history's labels for each twin: the boarded values and every difference they made. */
  readonly labels: {
    readonly "D-42": readonly DefectLabel[];
    readonly "D-03": readonly DefectLabel[];
    readonly defective: readonly DefectLabel[];
  };
  /** Each one's transfer package. */
  readonly packages: {
    readonly clean: TransferPackage;
    readonly "D-42": TransferPackage;
    readonly "D-03": TransferPackage;
    readonly defective: TransferPackage;
  };
}

export function demoLoan(calibration: Calibration = loadCalibration()): DemoLoan {
  const run = (ids: readonly string[]) =>
    generate(DEMO_SEED, DEMO_SCENARIO, {
      calibration,
      defects: ids.map((id) => ({ id, loans: [0] })),
    });
  const d42 = run(["D-42"]);
  const d03 = run(["D-03"]);
  const both = run(DEMO_DEFECTS);
  const clean = both.clean.loans[0]!;
  const twin = (r: typeof both) => r.defective!.loans[0]!;
  const pkg = (life: LoanLife, defects: readonly string[]) =>
    writeTransferPackage([{ life, defects }], { batch_id: "B-LIFE-DEMO" });
  return {
    clean,
    twins: { "D-42": twin(d42), "D-03": twin(d03), defective: twin(both) },
    labels: { "D-42": d42.labels, "D-03": d03.labels, defective: both.labels },
    packages: {
      clean: pkg(clean, []),
      "D-42": pkg(twin(d42), ["D-42"]),
      "D-03": pkg(twin(d03), ["D-03"]),
      defective: pkg(twin(both), DEMO_DEFECTS),
    },
  };
}
