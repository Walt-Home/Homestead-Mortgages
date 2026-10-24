/**
 * Defects planted in a loan's history, and the labels that say where.
 *
 * A defect is planted where docs/synthetic-data-defects.md says it enters.
 * Most in the registry enter at boarding: the twin runs the same loan from the
 * same draws with one value boarded wrong, and everything after it is computed
 * by the engines as they would compute it on that value. One enters earlier,
 * in the prior servicer's own books (D-25, a misapplied payment), and its twin
 * differs from the day of the misapplication. Either way the labels are of two
 * kinds. The root cause is the planted value itself (`root_cause: true`).
 * Every other difference between the twin and the clean history is a symptom
 * (`root_cause: false`): found by comparing the two, table by table and field
 * by field, the month-end tape among them, so a label exists for every row the
 * defect reached and for no other.
 *
 * A defect that reaches boarding through a transfer package says where in the
 * package it sits (`package`): the file and column of its root, the cell the
 * clean package carries and the one the twin's carries instead (or, for a root
 * in the payment history, how the row is found), the cells a reviewer's checks
 * flag because of it, and what a reviewer should do about it. The
 * transfer-package writer (`transfer-package.ts`) plants it and labels the
 * root and every package cell it reached; the boarding-triage environment
 * grades a reviewer against those labels.
 *
 * `DEFECTS` is the registry, and each wave extends it: a new defect is one
 * more `DefectDefinition`. It holds the first ten of docs/synthetic-data-defects.md:
 * D-42 (which boards D-31), D-35, D-03, D-01, D-12, D-37, D-18, D-24, D-25
 * and D-15. And it holds four errors made in the history after boarding by
 * someone the servicer depends on (`history`):
 *
 *   V-01  a vendor's: a tax bill the tax service reported wrong, paid as reported;
 *   V-02  a vendor's: a hazard renewal billed to the prior servicer, paid late;
 *   D-28  a system's: a borrower's payment drafted twice;
 *   D-25  a system's: a payment keyed to a neighboring loan number and posted there.
 *
 * A history error is made on one event the clean history had (a bill, a
 * receipt), read off it, so the twin is the clean history until that event
 * and the engines' from there. Its root cause is the record the error wrote
 * (the vendor's bill, the carrier's mortgagee clause, the second draft, the
 * payment on the wrong loan), and D-25's reaches two loans, each with a root.
 * Staff errors that need the contacts layer (a promise not tracked, a
 * complaint not logged) are not here.
 *
 * The catalog gives D-25 two forms, a split that puts a payment's principal
 * into escrow and a receipt posted to the wrong loan, and the registry plants
 * them apart: the split, which the prior servicer makes before the transfer,
 * is `D-25`; the wrong loan, which a system makes on our books, is
 * `D-25/wrong-loan`. A definition's `id` is the catalog's, which its labels
 * and its draws carry; `form` is the key the registry holds it under where
 * that is not the id (`defectKey`).
 */

import { addDays, addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { formatCents, type Cents } from "@hm/kernel/money";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { toJsonLine } from "../record.js";
import type { Rng } from "../rng.js";
import { floodZoneOf, type LoanDraw } from "./draw.js";
import { monthEndRow } from "./projection.js";
import {
  miTerminationDate,
  type BoardedTerms,
  type HistoryError,
  type HistoryPlant,
  type LoanLife,
  type ReceiptRow,
} from "./simulate.js";

export interface DefectLabel {
  /** The loan's id. */
  readonly loan: string;
  readonly defect_id: string;
  /** The servicing app's table the value lives in (`loan_terms`, `fees`, `payments`, …), as docs/subservicer-data.md names them. */
  readonly file_or_table: string;
  readonly field: string;
  /** Which row: a fee's id, a receipt's id, a month. */
  readonly row: string;
  /** The row's date. */
  readonly on: PlainDate;
  readonly true_value: string | null;
  readonly planted_value: string | null;
  readonly expected_handling: string;
  /** True only for the planted value; every downstream difference is false. */
  readonly root_cause: boolean;
}

/** What a reviewer does about a defect in a transfer package. */
export type Handling = "board_as_is" | "correct" | "hold" | "query";
export const HANDLINGS: readonly Handling[] = ["board_as_is", "correct", "hold", "query"];

const TAPE = "boarding_tape.final.csv";
const HISTORY = "payment_history.csv";

/** Where a defect sits in a transfer package, and what a reviewer should do about it. */
export interface PackageDefect {
  /** The package file and column the root sits in. */
  readonly file: string;
  readonly field: string;
  /**
   * A root in a tape cell: the cell the clean package carries, and the one the twin's package carries instead.
   * Null for a root in the payment history, which the twin's own history writes (`row`).
   */
  readonly cell: {
    trueCell(d: LoanDraw): string;
    plantedCell(d: LoanDraw): string;
  } | null;
  /** A root in the payment history: the due date of its row, read off the twin's history. */
  row?(twin: LoanLife): PlainDate;
  /**
   * Tape cells a reviewer's checks flag because of the root, though each holds what it should: D-24's next due
   * date, which its phantom row moves the history away from, and D-12's P&I, which the capped payments do.
   */
  readonly flags: readonly string[];
  /** What a reviewer should do; and the other handlings that are right too. */
  readonly handling: Handling;
  readonly also_accepted: readonly Handling[];
  /** Why that handling, and what in the package gives the defect away. */
  readonly why: string;
  readonly evidence: string;
  /** What the servicing app's decoder and gate do with the planted package. */
  readonly gate: string;
}

export interface DefectDefinition {
  /** The catalog's id (docs/synthetic-data-defects.md), which every label of it carries. */
  readonly id: string;
  /** The key the registry holds it under, where the catalog's id has two forms planted apart (D-25's); the id when absent. */
  readonly form?: string;
  readonly title: string;
  /** Another defect in docs/synthetic-data-defects.md this one produces once boarded (D-42 boards D-31). */
  readonly produces: string | null;
  /**
   * Whether it can only enter through a transfer (a cell in the prior servicer's package, or its books, or a bill
   * still addressed to the prior servicer).
   */
  readonly requires_transfer: boolean;
  readonly package: PackageDefect | null;
  /** Where the root cause lives. */
  readonly table: string;
  readonly field: string;
  /** Whether the defect can be planted on this loan at all. */
  eligible(d: LoanDraw): boolean;
  /** Whether the clean history carries what the defect needs (a plan in force at the transfer, a receipt to misapply); every loan when absent. */
  applies?(clean: LoanLife): boolean;
  /** How many of the calibration rate's units the loan has (D-25's rate is per receipt); one when absent. */
  units?(clean: LoanLife): number;
  /** What boarding writes instead of what the note and the loan call for. A history error boards the note as it is. */
  boarded(note: BoardedTerms, d: LoanDraw): BoardedTerms;
  /** A change to the prior servicer's own history, read off the clean one (D-25); none for a defect that enters at boarding. */
  priorHistory?(clean: LoanLife): HistoryPlant;
  /** The root cause's values, for a defect that enters at boarding or before it; a history error's are its placements'. */
  trueValue(d: LoanDraw, clean: LoanLife): string | null;
  plantedValue(d: LoanDraw, clean: LoanLife): string | null;
  /** The root's row and date when it is not the loan at boarding (D-25's: the misapplied receipt). */
  rootRow?(clean: LoanLife): { readonly row: string; readonly on: PlainDate };
  /**
   * For an error made in the history after boarding (a vendor's or a
   * system's), where it can be made and what it changes; null for a defect
   * that enters at boarding or before it.
   */
  readonly history: HistoryErrorPlan | null;
  /** What a servicer should do about the root cause. */
  readonly handling: string;
  /** What a servicer should do about a symptom in this table and field, on this row (as the comparison names it). */
  symptomHandling(table: string, field: string, row: string): string;
}

/** One loan's share of a history error: what its twin is handed, and the root cause it carries. */
export interface HistoryPlacement {
  /** The loan, by book index. */
  readonly index: number;
  readonly error: HistoryError;
  readonly root: Difference;
}

/**
 * Where a history error can be made, and what it changes. The events are
 * read off the clean history, which is the twin's until the error, so the
 * twin is handed exactly the event the clean history had.
 */
export interface HistoryErrorPlan {
  /** Whether the error moves money from one loan to another, which then carries it too (D-25). */
  readonly partnered: boolean;
  /** The events on a loan the error can be made on, oldest first, each keyed by its row so a draw for it is its own. */
  candidates(life: LoanLife): readonly { readonly key: string; readonly on: PlainDate }[];
  /**
   * The error made on one of them: each loan it reaches, with what that
   * loan's twin is handed and the root cause it carries. `partner` is the
   * loan a partnered error lands on, or null to take the next loan in the
   * book on our books that day. Null when it cannot be made there.
   */
  make(args: {
    readonly loans: readonly LoanLife[];
    readonly index: number;
    readonly key: string;
    readonly partner: number | null;
    readonly r: Rng;
  }): readonly HistoryPlacement[] | null;
}

/* ── shared readings ─────────────────────────────────────────────────────── */

/** Cents as the tape writes money: dollars with two decimals, no symbol or grouping; blank for none. */
export function dollars(c: Cents | null): string {
  return c === null ? "" : formatCents(c, { symbol: false, grouping: false });
}

const bps = (pct: string) => String(Math.round(Number(pct) * 100));
const yes = () => "Y";
const no = () => "N";

/** A fee or a run downstream of a charge the servicer should not have assessed. */
const feeSymptom = (why: string) => (table: string, field: string) => {
  if (table === "fees" && field === "amount_cents") return `${why}: reverse the charge.`;
  if (table === "fees") return `${why}: reverse the charge and refund what was collected.`;
  if (table === "late_charge_runs") return `${why}: the run should not have assessed it.`;
  if (table === "payments")
    return "The charges took money this payment owed elsewhere: re-apply it as the clean history does.";
  if (table === "metro2")
    return "The furnished record moved because the payments did: correct it and furnish the correction.";
  if (table === "tape" || table === "month_ends")
    return "What the servicer reports moved with it: corrects when the root is corrected.";
  return "Downstream of the root: corrects when it is corrected.";
};

/** The D-25 receipts the prior servicer could have misapplied: regular payments of one installment, due 3 to 12 months before the transfer. */
function misapplicable(clean: LoanLife): ReceiptRow[] {
  const T = clean.transfer_in_on;
  if (!T || !clean.draw.escrowed) return [];
  const from = addMonths(T, -12);
  const to = addMonths(T, -3);
  return clean.receipts.filter(
    (r) =>
      r.servicer === "prior" &&
      r.mode === "regular" &&
      r.outcome === "applied" &&
      r.installments.length === 1 &&
      r.installments[0]!.principal > 0n &&
      r.installments[0]!.due >= from &&
      r.installments[0]!.due <= to,
  );
}
/** The one D-25 misapplies: the latest. */
const misapplied = (clean: LoanLife): ReceiptRow => {
  const c = misapplicable(clean);
  if (c.length === 0) throw new RangeError(`${clean.loan_id}: no receipt D-25 can misapply`);
  return c[c.length - 1]!;
};

/** The original value D-18's wrong termination date is computed from: 95 % of the true one. */
const wrongValue = (d: LoanDraw): Cents => (d.value_cents * 95n) / 100n;
const plantedMiDate = (d: LoanDraw) => miTerminationDate(d, wrongValue(d));

/* ── the registry ────────────────────────────────────────────────────────── */

/**
 * D-03: the note's late-fee cap is never boarded, so the state maximum is
 * charged. The tape has no cap column (`AS/fixtures/transfer-batch-demo/LAYOUT.md:65-66`),
 * so `loan_terms.late_charge_max_cents` (`AS/db/migrations/0001_baseline.sql:155`)
 * stays null and the late-charge engine charges the full percent
 * (`lateChargeAmount`, `AS/src/domain/cashiering/latecharges.ts:40-43`, the
 * cap passed at `:87`). It needs a note whose dollar cap binds below the
 * percent of its P&I.
 */
export const D03: DefectDefinition = {
  id: "D-03",
  title: "The note's late-fee cap is never boarded, so the state maximum is charged",
  produces: null,
  requires_transfer: false,
  package: {
    file: TAPE,
    field: "late_charge_max",
    cell: { trueCell: (d) => dollars(d.late_charge.cap_cents), plantedCell: () => "" },
    flags: [],
    handling: "query",
    also_accepted: [],
    why:
      "A late-charge term is a money field, which the servicing app lets no one but the prior servicer correct " +
      "(BoardingService.MONEY_FIELDS, apps/servicing/src/domain/boarding/service.ts:247-248), and the package " +
      "conflicts with itself on it: ask the prior servicer for the note's late-charge paragraph.",
    evidence:
      "The prior servicer's periodic statements (correspondence_file.csv) quote a late fee below late_charge_pct of " +
      "the P&I they bill, the fee the note's dollar cap allows, and the tape's cap cell is blank.",
    gate:
      "Nothing. The decoder reads no cap column (tape-codec.ts:222-264), so loan_terms.late_charge_max_cents is " +
      "null for every loan boarded from a tape, and HF-015 checks only the percent and the grace days " +
      "(rules.ts:144-145).",
  },
  table: "loan_terms",
  field: "late_charge_max_cents",
  eligible: (d) =>
    d.late_charge.cap_cents !== null &&
    lateChargeAmount(d.initial_pi_cents, d.late_charge.pct, null) > d.late_charge.cap_cents,
  boarded: (t) => ({ ...t, late_charge_cap_cents: null }),
  trueValue: (d) => (d.late_charge.cap_cents === null ? null : String(d.late_charge.cap_cents)),
  plantedValue: () => null,
  history: null,
  handling:
    "Board the note's dollar cap. Recompute every late charge assessed since boarding with the cap " +
    "(lateChargeAmount(basis, pct, cap), latecharges.ts:40-43), refund what was collected above it, and " +
    "reduce what is still owed to the capped amount.",
  symptomHandling: (table, field) => {
    if (table === "fees" && field === "amount_cents")
      return "The charge is above the note's cap: reduce it to the capped amount.";
    if (table === "fees")
      return "Collected above the note's cap: refund the excess to the borrower.";
    if (table === "late_charge_runs")
      return "The run assessed above the note's cap: the capped amount is what the note allows.";
    if (table === "payments")
      return "Late charges took more of this payment than the note allows: re-apply the excess as the capped history would have (to suspense or the next installment).";
    if (table === "metro2")
      return "The furnished record moved because the payment application did: correct it and furnish the correction.";
    return "Downstream of the uncapped late charges: corrects when they are recomputed.";
  },
};

/**
 * D-42: a free-text yes on the escrow column, read as No, so an escrowed loan
 * boards non-escrowed (D-31). The tape's booleans are Y or N
 * (`AS/fixtures/transfer-batch-demo/LAYOUT.md`), and the decoder reads
 * anything but a literal "Y" as false (`rYn`, `AS/src/domain/boarding/tape-codec.ts:49`),
 * so `escrowed` = "Yes" decodes to false (`:243`) and `loan_terms.escrowed`
 * is written false. HF-007 catches only the reverse, a flag on with no lines
 * (`rules.ts:96`). From boarding the loan's installments carry no escrow and
 * no bill is paid from its account (`simulate.ts`, `escrowOffFrom`).
 */
export const D42: DefectDefinition = {
  id: "D-42",
  title: "A free-text yes on the escrow column is read as No, so the loan boards non-escrowed",
  produces: "D-31",
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "escrowed",
    cell: { trueCell: yes, plantedCell: () => "Yes" },
    flags: [],
    handling: "correct",
    also_accepted: [],
    why:
      "The flag is a code, not a money field, and every other file settles it: the escrow history lists the lines, " +
      "the escrow analysis has the account, and the tape carries an escrow payment and balance. Write Y and record " +
      "the correction (applyCorrection, service.ts:256).",
    evidence:
      "The cell holds Yes, which is not one of the column's codes (Y or N); the escrow history, the escrow " +
      "analysis and the escrow payment all say the loan is escrowed.",
    gate:
      "Nothing. The decoder reads Yes as N (tape-codec.ts:49, :243), the loan stages non-escrowed, HF-007 has no " +
      "flag to hold the lines to (rules.ts:96), and loan.boarded carries escrowed=false (service.ts:359).",
  },
  table: "loan_terms",
  field: "escrowed",
  eligible: (d) => d.escrowed && d.line_specs.length > 0,
  boarded: (t) => ({ ...t, escrowed: false }),
  trueValue: () => "true",
  plantedValue: () => "false",
  history: null,
  handling:
    "Board the loan escrowed (loan_terms.escrowed = true), as the note and the prior servicer's escrow file say. " +
    "Pay every tax and insurance bill that fell due since boarding from the escrow account, advancing what it " +
    "lacks, bill the escrow payment from the next statement, and run an escrow analysis to set it (12 CFR 1024.17).",
  symptomHandling: (table, field) => {
    if (table === "disbursements")
      return "A bill the escrow account should have paid was not paid: pay it, with any penalty the late payment cost.";
    if (table === "escrow_analyses")
      return "The annual escrow analysis was never run: run it as of the corrected boarding.";
    if (table === "loan_installments" && field === "escrow")
      return "The installment was billed without escrow: rebill the escrow from the corrected boarding.";
    if (table === "payments")
      return "The payment was applied without its escrow share: re-apply it as the escrowed loan would have.";
    if (table === "metro2")
      return "The furnished record moved because the payment did: correct it and furnish the correction.";
    return "Downstream of boarding the loan non-escrowed: corrects when it is boarded escrowed.";
  },
};

/**
 * D-35: loss mitigation in process is not flagged. The prior servicer's
 * borrower is paying a repayment plan at the transfer, and the package keeps
 * the plan's row in `lossmit_file.csv` while the tape's `lm_in_process` is N.
 * The decoder keeps the details (`AS/src/domain/boarding/tape-codec.ts:250`),
 * but the flag alone decides whether a case opens
 * (`inflightBoardingFacts`, `AS/src/domain/transfers/ops-1-7.ts:101`), and
 * HF-011 reads the details only when the flag is on (`rules.ts:124`). From
 * boarding the servicer knows no plan: the charges on the plan's installments
 * are assessed rather than suspended (2.7 rule 3(v)), nothing is waived when
 * the borrower completes it, and the bureaus and the tape are told of no plan.
 * The borrower keeps paying the plan, as the borrower was told.
 */
export const D35: DefectDefinition = {
  id: "D-35",
  title: "A repayment plan in force is not flagged, so it boards as no loss mitigation",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "lm_in_process",
    cell: { trueCell: yes, plantedCell: no },
    flags: [],
    handling: "correct",
    also_accepted: [],
    why:
      "The flag is a code, not a money field, and the loss-mitigation file settles it: the prior servicer delivered " +
      "the loan's row in lossmit_file.csv, and its correspondence holds the plan it agreed. Write Y and record the " +
      "correction (applyCorrection, service.ts:256); HF-011 then has the status and received date it needs " +
      "(rules.ts:122-127).",
    evidence:
      "lossmit_file.csv has a row for the loan with its application status and received date, and the " +
      "correspondence file holds the repayment plan the prior servicer agreed; the tape's lm_in_process is N.",
    gate:
      "Nothing. HF-011 reads the details only when the flag is Y (rules.ts:124); the decoder keeps them " +
      "(tape-codec.ts:250), but the flag alone decides whether a case opens (inflightBoardingFacts, " +
      "apps/servicing/src/domain/transfers/ops-1-7.ts:101), so loan.boarded carries lossmit_in_process=false and no " +
      "§1024.41(k) clock arms.",
  },
  table: "lossmit_applications",
  field: "in_process",
  eligible: () => true,
  applies: (c) => c.at_transfer?.plan !== undefined,
  boarded: (t) => ({ ...t, lossmit_carried: false }),
  trueValue: () => "true",
  plantedValue: () => "false",
  history: null,
  handling:
    "Board the plan as the prior servicer had it: lm_in_process Y, and the case opened from the loss-mitigation " +
    "file (1.7). Suspend every late charge on an installment the plan covers and waive them when it completes " +
    "(D2-3.2-02), reverse every charge assessed since boarding, and report the plan to the bureaus.",
  symptomHandling: (table, field) => {
    if (table === "metro2")
      return "The bureaus were told of no plan: furnish the plan's months as a repayment plan (special comment), and the correction.";
    if (table === "tape" || table === "month_ends")
      return "The servicer reported no plan in force: report the plan the borrower is paying.";
    return feeSymptom("A charge on an installment the plan covers, which the plan suspends")(
      table,
      field,
    );
  },
};

/**
 * D-01: ARM terms present but wrong. The tape's initial cap holds the
 * periodic cap's value, so the first rate change after boarding is capped at
 * 1 % where the note's plan allows 2 % (a 5/6) or 5 % (a 7/6 or 10/6). HF-006
 * checks only that the ARM fields are present (`rules.ts:87-93`). Every rate
 * change after boarding reads the boarded caps (`simulate.ts`, `onArm`); one
 * that falls in the history is where its symptoms land.
 */
export const D01: DefectDefinition = {
  id: "D-01",
  title: "An ARM's first-change cap is boarded as its periodic cap",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "arm_initial_cap_bps",
    cell: {
      trueCell: (d) => bps(d.arm!.initial_cap_pct),
      plantedCell: (d) => bps(d.arm!.periodic_cap_pct),
    },
    flags: [],
    handling: "query",
    also_accepted: [],
    why:
      "A cap on the rate is a term of the note, which only the prior servicer may correct, and the tape contradicts " +
      "the loan's own plan on it: ask the prior servicer for the note's ARM rider before the first change.",
    evidence:
      "The tape's first change date makes the loan a 5/6, 7/6 or 10/6, and that plan's first-change cap (200 basis " +
      "points on a 5/6, 500 on a 7/6 or 10/6) is not the tape's arm_initial_cap_bps, which holds the periodic cap.",
    gate: "Nothing. HF-006 checks only that the ARM fields are present (rules.ts:87-93).",
  },
  table: "loan_terms",
  field: "arm_initial_cap_pct",
  eligible: (d) => d.arm !== null && d.arm.initial_cap_pct !== d.arm.periodic_cap_pct,
  boarded: (t) => ({
    ...t,
    arm: t.arm ? { ...t.arm, initial_cap_pct: t.arm.periodic_cap_pct } : null,
  }),
  trueValue: (d) => d.arm!.initial_cap_pct,
  plantedValue: (d) => d.arm!.periodic_cap_pct,
  history: null,
  handling:
    "Board the note's first-change cap. Recompute the first rate change on the note's terms (computeArmAdjustment " +
    "and its verifier), re-bill from it, refund any interest charged above the note's rate, and send the corrected " +
    "change notice (12 CFR 1026.20(c)).",
  symptomHandling: (table) =>
    table === "arm_adjustments"
      ? "The change was capped on the wrong cap: recompute it on the note's."
      : "Downstream of the rate change: corrects when the change is recomputed.",
};

/**
 * D-12: a servicemember is not flagged. The borrower was called to active
 * duty after the loan was made, and the prior servicer capped the interest at
 * 6 % from the next installment (50 U.S.C. 3937) and charged no late fee
 * (2.7 rule 3(iii)). The package keeps the cap's reason in
 * `scra_rate_cap_reason` and its notice in the correspondence, while the tape's
 * `scra_active` is N, so HF-012, which reads the reason only when the flag is
 * on (`rules.ts:128-133`), passes. From boarding the servicer bills the tape's
 * terms, the note's rate and P&I, and charges late fees again.
 */
export const D12: DefectDefinition = {
  id: "D-12",
  title: "A servicemember whose interest is capped is not flagged",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "scra_active",
    cell: { trueCell: yes, plantedCell: no },
    flags: ["pi_payment"],
    handling: "correct",
    also_accepted: [],
    why:
      "The flag is a code, not a money field, and the package settles it: the prior servicer's own cap reason is on " +
      "the tape, its notice of the cap is in the correspondence, and the history bills the capped payment. Write Y " +
      "and record the correction (applyCorrection, service.ts:256); HF-012 then has the reason it needs.",
    evidence:
      "scra_rate_cap_reason gives the 6 % cap on active-duty orders and the correspondence holds the prior " +
      "servicer's notice of it; the payment history bills the capped payment, not pi_payment plus escrow; the " +
      "tape's scra_active is N.",
    gate:
      "Nothing. HF-012 reads the reason only when the flag is Y (rules.ts:128-133). loan.boarded carries " +
      "scra_active=false and arms the military-status check of every borrower (SM_DMDC_VERIFY_BOARDING_0, " +
      "apps/servicing/src/domain/foreclosure/timers.ts:132), which nothing in the runtime runs.",
  },
  table: "scra_cases",
  field: "active",
  eligible: (d) => d.arm === null && Number(d.note_rate_pct) > 6,
  applies: (c) =>
    c.scra !== undefined &&
    c.scra.capped_pi !== null &&
    c.transfer_in_on !== null &&
    c.scra.first_due < c.transfer_in_on,
  boarded: (t) => ({ ...t, scra_carried: false }),
  trueValue: () => "true",
  plantedValue: () => "false",
  history: null,
  handling:
    "Board the protection: scra_active Y, and the 6 % cap from the first installment after the call to duty. Bill " +
    "the capped payment, refund the interest above 6 % charged since boarding, and waive every late charge " +
    "assessed since the call (C-1.1-02, D2-3.4-01).",
  symptomHandling: (table, field) => {
    if (table === "loan_installments" && field === "pi")
      return "Billed at the note's rate above the 6 % cap: rebill at the capped payment.";
    if (table === "payments")
      return "Interest above 6 % was taken from this payment: refund it, and re-apply the payment at the capped rate.";
    return feeSymptom(
      "A late charge on a servicemember's installment, which the cap's period waives",
    )(table, field);
  },
};

/**
 * D-37: bankruptcy details present but the flag is off. The borrower filed a
 * petition before the transfer; the package keeps the case in `fc_bk_file.csv`
 * while the tape's `bk_active` is N, so the decoder drops the details
 * (`AS/src/domain/boarding/tape-codec.ts:248`) and HF-009, which needs the
 * flag, passes (`rules.ts:110-115`). Boarding queries no court record. From
 * boarding the servicer knows no case: a charge on a post-petition installment
 * is assessed rather than suspended (2.7 rule 3(iv)), the borrower is called
 * when behind, and the tape reports no bankruptcy.
 */
export const D37: DefectDefinition = {
  id: "D-37",
  title: "An open bankruptcy is in the package but its flag is off",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "bk_active",
    cell: { trueCell: yes, plantedCell: no },
    flags: [],
    handling: "correct",
    also_accepted: [],
    why:
      "The flag is a code, not a money field, and the package settles it: fc_bk_file.csv holds the case's chapter, " +
      "number and filing date, and the correspondence the court's notice. Write Y and record the correction " +
      "(applyCorrection, service.ts:256); HF-009 then has what it needs, and the stay is honored from boarding.",
    evidence:
      "fc_bk_file.csv has the loan's bankruptcy case (chapter, case number, filing date) and the correspondence " +
      "holds the notice of the petition; the tape's bk_active is N.",
    gate:
      "Nothing. HF-009 reads the case only when the flag is Y (rules.ts:110-115), and the decoder drops the " +
      "details with the flag (tape-codec.ts:248). Boarding queries no court record; the PACER scrub before a " +
      "foreclosure referral is the first check that would find it (apps/servicing/src/app/tools/section13.ts:485-503).",
  },
  table: "bankruptcy_cases",
  field: "active",
  eligible: () => true,
  applies: (c) =>
    c.bankruptcy !== undefined &&
    c.transfer_in_on !== null &&
    c.bankruptcy.filed_on < c.transfer_in_on,
  boarded: (t) => ({ ...t, bankruptcy_carried: false }),
  trueValue: () => "true",
  plantedValue: () => "false",
  history: null,
  handling:
    "Board the case: bk_active Y with its chapter, number and filing date, and honor the stay. Stop collection: no " +
    "call, and no charge on a post-petition installment but one that accrues suspended (2.7 rule 3(iv)); reverse " +
    "every charge assessed and refund what was collected since boarding, and report the case.",
  symptomHandling: (table, field) => {
    if (table === "contacts")
      return "A collection call to a borrower in bankruptcy: stop calling, and review the call for a stay violation.";
    if (table === "tape" || table === "month_ends")
      return "The servicer reported no bankruptcy: report the open case.";
    return feeSymptom("A charge on a post-petition installment, which the stay suspends")(
      table,
      field,
    );
  },
};

/**
 * D-18: the mortgage insurance's termination date is wrong. The package's
 * tape carries the HPA original value and automatic-termination date after the
 * layout's own columns (the layout has none for either), and the termination
 * date is computed from a value 5 % below the original, so it falls later than
 * the date the lender's disclosure gives. W-006 checks only the certificate
 * (`rules.ts:168`). From boarding the MI sweep reads the boarded date, so the
 * insurance runs past the date the law ends it (12 U.S.C. 4902(b)), the
 * premium with it.
 */
export const D18: DefectDefinition = {
  id: "D-18",
  title: "The mortgage insurance's termination date is computed from the wrong value",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "mi_termination_date",
    cell: {
      trueCell: (d) => miTerminationDate(d) ?? "",
      plantedCell: (d) => plantedMiDate(d) ?? "",
    },
    flags: [],
    handling: "query",
    also_accepted: [],
    why:
      "The termination date is a term of the mortgage insurance, which decides when the borrower stops paying a " +
      "premium, and the package contradicts itself on it: ask the prior servicer for its MI record and the value " +
      "it computed the date from before relying on the date.",
    evidence:
      "The lender's disclosure at consummation (correspondence_file.csv, mi_disclosure) gives the original value " +
      "the tape's mi_original_value gives, and an automatic-termination date that is not the tape's " +
      "mi_termination_date.",
    gate:
      "Nothing. W-006 checks only the certificate number (rules.ts:168); the decoder reads no MI value or date (the " +
      "layout has a column for neither), and loan.boarded carries no MI record (pmi-15).",
  },
  table: "mi_schedules",
  field: "termination_date",
  eligible: (d) =>
    d.mi !== null &&
    d.arm === null &&
    plantedMiDate(d) !== null &&
    plantedMiDate(d) !== miTerminationDate(d),
  applies: (c) => c.at_transfer?.mi_active === true,
  boarded: (t, d) => ({ ...t, mi_termination_date: plantedMiDate(d) }),
  trueValue: (d) => miTerminationDate(d),
  plantedValue: (d) => plantedMiDate(d),
  history: null,
  handling:
    "Board the date the initial amortization schedule gives on the original value (12 U.S.C. 4902(b)). End the " +
    "insurance on it if the borrower is current, stop the premium, and refund every premium collected after it " +
    "(4902(f)).",
  symptomHandling: (table) =>
    table === "mi_events"
      ? "The sweep ran on the wrong date: the insurance ends on the date the original value gives."
      : table === "disbursements" || table === "escrow_analyses"
        ? "A premium after the insurance should have ended: refund it."
        : "Downstream of the insurance running past its date: corrects when it is ended on the right one.",
};

/**
 * D-24: a history row dated before the loan was made. The package's payment
 * history begins with a row for an installment due on the first of the month
 * the note was signed, before `origination_date` and two months before the
 * first payment, unpaid. W-014 tests only for gaps of more than 62 days
 * (`rules.ts:179-182`), and two months is not one. Boarding applies the history
 * oldest first (`AS/src/domain/boarding/service.ts:272`): the row takes the
 * first receipt, every later receipt pays the row before its own, and the last
 * installment the borrower paid is open again, so the loan boards an
 * installment behind (`:345-347`), with a delinquency window seeded for it
 * (`:368-371`). From boarding the borrower's every payment pays the
 * installment before its own.
 */
export const D24: DefectDefinition = {
  id: "D-24",
  title:
    "A payment-history row dated before the loan was made boards the loan an installment behind",
  produces: null,
  requires_transfer: true,
  package: {
    file: HISTORY,
    field: "due_date",
    cell: null,
    row: (twin) => twin.boarded.terms.phantom_installment!,
    flags: ["next_due_date"],
    handling: "hold",
    also_accepted: [],
    why:
      "Boarding derives the loan's delinquency from the payment history, oldest first (service.ts:272, :345-347), " +
      "and this history would board the loan an installment behind it is not: hold the loan until the prior " +
      "servicer delivers the history without the row.",
    evidence:
      "The history's first row is due before first_payment_date, on the first of the month the note was signed, " +
      "before origination_date; with it the history's oldest unpaid row is not the tape's next_due_date.",
    gate:
      "Nothing. W-014 tests only for gaps of more than 62 days (rules.ts:179-182), and the row is two months before " +
      "the first payment. Boarding applies the history oldest first: the row takes the first receipt, and the loan " +
      "boards an installment behind (regx_days_delinquent above zero, a delinquency window seeded for the " +
      "installment, service.ts:345-371).",
  },
  table: "loan_installments",
  field: "due_date",
  eligible: (d) => d.note_date > addMonths(d.first_due, -2),
  applies: (c) =>
    c.at_transfer !== null &&
    c.at_transfer.installments.some((i) => i.status === "satisfied" || i.status === "prepaid"),
  boarded: (t, d) => ({ ...t, phantom_installment: addMonths(d.first_due, -2) }),
  trueValue: () => null,
  plantedValue: (d) => addMonths(d.first_due, -2),
  history: null,
  handling:
    "Hold the loan and ask the prior servicer for the history without the row; board from the corrected one. On a " +
    "loan already boarded, apply every receipt to its own installment again, reverse the late charges the shift " +
    "caused, refund the interest it charged twice, and furnish the correction.",
  symptomHandling: (table, field) => {
    if (table === "loan_installments")
      return "Open, or paid by the wrong receipt, because the phantom row took a receipt: apply the receipts to their own installments.";
    if (table === "contacts") return "A collection call on a loan that was not behind: stop it.";
    if (table === "metro2")
      return "Reported delinquent because of the phantom row: furnish the correction.";
    return feeSymptom("A charge on a loan behind only because of the phantom row")(table, field);
  },
};

/**
 * D-25: a misapplied payment. The prior servicer posted one regular receipt,
 * three to twelve months before the transfer, with its principal to escrow:
 * the installment is paid, the balance keeps the principal and the escrow
 * account holds it. Every later split, analysis and month-end is computed on
 * the wrong balance, and the tape, the trial balance and Fannie Mae's position
 * all carry it, so HF-003 finds them in agreement (`rules.ts:56-68`). The
 * package's history shows it in the row's split: principal 0.00, escrow more
 * than the statement for that installment billed.
 */
export const D25: DefectDefinition = {
  id: "D-25",
  title: "A payment the prior servicer posted with its principal to escrow",
  produces: null,
  requires_transfer: true,
  package: {
    file: HISTORY,
    field: "principal",
    cell: null,
    row: (twin) => twin.history_plant!.misapplied,
    flags: [],
    handling: "query",
    also_accepted: [],
    why:
      "The balance and the payment's split are money, which only the prior servicer may correct " +
      "(BoardingService.MONEY_FIELDS, service.ts:247-248): ask it to reverse the misapplication and correct the " +
      "balance before relying on it. The loan's delinquency does not move, so it boards and the balance waits.",
    evidence:
      "On the row, principal is 0.00 and escrow is more than the periodic statement for that due date billed, by " +
      "the principal the statement's P&I owed; the tape's balance carries it, and so do the trial balance and " +
      "Fannie Mae's position.",
    gate:
      "Nothing. HF-003 compares the tape's balance with the trial balance and Fannie Mae's position (rules.ts:56-68), " +
      "which the same books feed, so all three carry the misapplied principal; the decoder reads no split (the " +
      "layout's history is a date and an amount).",
  },
  table: "payment_allocations",
  field: "principal",
  eligible: (d) => d.escrowed && d.line_specs.length > 0,
  applies: (c) => misapplicable(c).length > 0,
  units: (c) => misapplicable(c).length,
  boarded: (t) => t,
  priorHistory: (c) => ({ misapplied: misapplied(c).installments[0]!.due }),
  trueValue: (_d, c) => String(misapplied(c).installments[0]!.principal),
  plantedValue: () => "0",
  rootRow: (c) => ({ row: misapplied(c).id, on: misapplied(c).on }),
  history: null,
  handling:
    "Ask the prior servicer to reverse the misapplication: apply the principal, take it out of escrow, and correct " +
    "the balance on the tape, the trial balance and the investor's position. Recompute every later split, analysis " +
    "and payoff on the corrected balance, and refund the interest charged on the principal left unapplied.",
  symptomHandling: (table, field) => {
    if (table === "payments")
      return "Split on a balance that kept the misapplied principal: recompute it on the corrected balance.";
    if (table === "escrow_analyses" || table === "disbursements")
      return "The escrow held principal it should not have: correct the analysis on the corrected balance.";
    if (table === "metro2")
      return "The furnished balance carried the misapplied principal: furnish the correction.";
    void field;
    return "Downstream of the misapplied principal: corrects when it is applied.";
  },
};

/**
 * D-15: the flood zone is wrong. The package's tape carries the zone of the
 * loan's life-of-loan flood determination after the layout's own columns (the
 * layout has none for it): X, outside a special flood hazard area, where the
 * determination says AE and the escrow pays a flood policy. W-007 reads only
 * the life-of-loan flag (`rules.ts:169`), and boarding queries no flood
 * vendor. The generator models no flood-insurance tracking, so its twin's
 * history is the clean one: the harm (no tracking of required coverage, no
 * force-placement on a lapse) is outside what it computes, and the root is its
 * only label.
 */
export const D15: DefectDefinition = {
  id: "D-15",
  title: "A property in a special flood hazard area boards in zone X",
  produces: null,
  requires_transfer: true,
  package: {
    file: TAPE,
    field: "flood_zone",
    cell: { trueCell: (d) => floodZoneOf(d), plantedCell: () => "X" },
    flags: [],
    handling: "correct",
    also_accepted: [],
    why:
      "The zone is a code, not a money field, and the package settles it: the life-of-loan determination on file " +
      "gives the zone, and the escrow pays the flood policy the zone requires. Write the determination's zone and " +
      "record the correction (applyCorrection, service.ts:256).",
    evidence:
      "The flood determination in the correspondence file (flood_determination) gives zone AE, a special flood " +
      "hazard area, and the escrow history carries a flood line; the tape's flood_zone is X.",
    gate:
      "Nothing. W-007 reads only the life-of-loan flag (rules.ts:169); the decoder reads no zone (the layout has no " +
      "column for it) and boarding queries no flood vendor.",
  },
  table: "flood_determinations",
  field: "zone",
  eligible: (d) => floodZoneOf(d) === "AE",
  boarded: (t) => ({ ...t, flood_zone: "X" }),
  trueValue: (d) => floodZoneOf(d),
  plantedValue: () => "X",
  history: null,
  handling:
    "Board the determination's zone, AE. Track the flood policy as required coverage from boarding: notify the " +
    "borrower and force-place if it lapses (12 CFR 1024.37; 42 U.S.C. 4012a(e)).",
  symptomHandling: () => "Downstream of the wrong zone: corrects when the zone is boarded.",
};

/* ── the history errors ──────────────────────────────────────────────────── */

const TAX_LINES: ReadonlySet<string> = new Set(["tax_county", "tax_school"]);
const FOREVER = "9999-12-31";

/** Whether the loan is on our books and still being paid on `on`. */
export function onOurBooks(life: LoanLife, on: PlainDate): boolean {
  return (
    (life.transfer_in_on === null || life.transfer_in_on <= on) &&
    (life.payoff?.on ?? FOREVER) > on &&
    (life.transfer_out_on ?? FOREVER) > on &&
    life.months.some((m) => m.month === on.slice(0, 7) && m.servicer === "us")
  );
}

/** A borrower's own payment on our books, posted as billed: the receipts a system error can be made on. */
const drafts = (life: LoanLife) =>
  life.receipts.filter(
    (x) => x.servicer === "us" && x.mode === "regular" && x.channel === "borrower",
  );

/** A receipt's row as the comparison keys the payments table (`TABLES`): its day and kind, and which of that day's. */
function paymentRow(life: LoanLife, x: { readonly on: PlainDate; readonly mode: string }): string {
  const k = life.receipts.indexOf(x as LoanLife["receipts"][number]);
  const before = (k < 0 ? life.receipts : life.receipts.slice(0, k)).filter(
    (y) => y.on === x.on && y.mode === x.mode,
  ).length;
  return before === 0 ? `${x.on}:${x.mode}` : `${x.on}:${x.mode}#${before}`;
}

/**
 * Two loan numbers a keystroke apart: the same length, and one digit
 * different or two neighbors swapped. A book draws its numbers at random from
 * a hundred million, so no two are, unless a scenario pins one
 * (`LoanPins.servicer_loan_number`).
 */
export function keystrokeApart(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const at = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
  if (at.length === 1) return true;
  return (
    at.length === 2 && at[1] === at[0]! + 1 && a[at[0]!] === b[at[1]!] && a[at[1]!] === b[at[0]!]
  );
}

/** Whether a disbursements row, as the comparison names it, is a refund out of the account (an analysis's, or the payoff's). */
const isRefundRow = (row: string) => row.startsWith("refund@") || row.startsWith("payoff_refund@");

/** A vendor's figure that is the bill with its decimal point one place off: the design choice V-01 plants. */
const DECIMAL_SHIFT = 10n;
/** The days before a payee returns an overpayment, and before a prior servicer sends a bill on: design choices. */
const RETURNED_AFTER_DAYS: readonly [number, number] = [45, 120];
const SENT_ON_AFTER_DAYS: readonly [number, number] = [30, 75];

const v01Handling =
  "Ask the tax service for the bill of record: the county billed a tenth of what was paid. Book the county's " +
  "return of the overpayment to escrow when it comes, and run the escrow account again on the right amount: the " +
  "balance, any analysis run in between and the payment it set (12 CFR 1024.17).";

/**
 * V-01: the tax service reports a bill ten times what the county billed (its
 * decimal point one place off), and the servicer pays it from escrow as
 * reported. The county returns the excess 45 to 120 days later. Until then
 * the escrow account is short by it, and an analysis that runs in between
 * finds a shortage the borrower is billed for. The bill itself, which the
 * analyst projects from, is the county's.
 */
export const V01: DefectDefinition = {
  id: "V-01",
  title: "A tax bill the tax service reported wrong, paid from escrow as reported",
  produces: null,
  requires_transfer: false,
  package: null,
  table: "escrow_bills",
  field: "amount_cents",
  eligible: (d) => d.escrowed && d.line_specs.some((l) => l.basis === "tax"),
  boarded: (t) => t,
  trueValue: () => null,
  plantedValue: () => null,
  history: {
    partnered: false,
    candidates: (life) =>
      life.disbursements
        .filter((x) => x.kind === "bill" && TAX_LINES.has(x.line) && x.servicer === "us")
        .map((x) => ({ key: x.id, on: x.on })),
    make: ({ loans, index, key, r }) => {
      const x = loans[index]!.disbursements.find((y) => y.id === key);
      if (!x) return null;
      const paid = x.amount * DECIMAL_SHIFT;
      return [
        {
          index,
          error: {
            kind: "bill_amount",
            line: x.line as HistoryBillLine,
            due: x.on,
            paid,
            returned_on: addDays(x.on, r.int(...RETURNED_AFTER_DAYS)),
          },
          root: {
            file_or_table: "escrow_bills",
            field: "amount_cents",
            row: `${x.line}@${x.on}`,
            on: x.on,
            true_value: String(x.amount),
            planted_value: String(paid),
          },
        },
      ];
    },
  },
  handling: v01Handling,
  symptomHandling: (table, field, row) => {
    if (table === "disbursements" && isRefundRow(row))
      return "A refund from the escrow account that the drained balance moved: redo it from the account on the right balance.";
    if (table === "disbursements" && row.startsWith("returned@"))
      return "The county's return of the overpayment: book it to escrow.";
    if (table === "disbursements" && field === "amount")
      return "The bill was paid at the vendor's figure, ten times the county's: the county is owed nothing more, and the excess comes back to escrow.";
    if (table === "disbursements")
      return "The escrow balance is short by the overpayment until the county returns it.";
    if (table === "escrow_analyses")
      return "The analysis ran on a balance the overpayment drained: run it again on the right balance, and refund or re-spread the difference.";
    if (table === "loan_installments")
      return "Billed at the escrow payment the drained analysis set: rebill from the corrected analysis.";
    if (table === "payments")
      return "The payment was applied at the escrow payment the drained analysis set: re-apply it as the corrected one would.";
    if (table === "metro2")
      return "The furnished record moved because the payment did: correct it and furnish the correction.";
    return "Downstream of the vendor's wrong tax amount: corrects when the bill is paid at the county's figure.";
  },
};

/**
 * V-02: the first hazard renewal after a transfer is billed to the prior
 * servicer, the mortgagee the carrier still has on the policy, and reaches
 * the servicer 30 to 75 days late, when the prior servicer sends it on. It is
 * paid then. Until then the escrow account holds the premium, and an analysis
 * that runs in between finds it there. Whether the policy lapsed in the gap is
 * the carrier's, and is not modeled.
 */
export const V02: DefectDefinition = {
  id: "V-02",
  title: "A hazard renewal billed to the prior servicer, and paid late when it is sent on",
  produces: null,
  requires_transfer: true,
  package: null,
  table: "insurance_policies",
  field: "mortgagee_clause",
  eligible: (d) => d.escrowed && d.line_specs.some((l) => l.basis === "hazard"),
  boarded: (t) => t,
  trueValue: () => null,
  plantedValue: () => null,
  history: {
    partnered: false,
    candidates: (life) => {
      const t = life.transfer_in_on;
      if (t === null) return [];
      const first = life.disbursements.find(
        (x) => x.kind === "bill" && x.line === "hazard" && x.servicer === "us" && x.on >= t,
      );
      return first && daysBetween(t, first.on) <= 366 ? [{ key: first.id, on: first.on }] : [];
    },
    make: ({ loans, index, key, r }) => {
      const x = loans[index]!.disbursements.find((y) => y.id === key);
      if (!x) return null;
      return [
        {
          index,
          error: {
            kind: "bill_late",
            line: "hazard",
            due: x.on,
            paid_on: addDays(x.on, r.int(...SENT_ON_AFTER_DAYS)),
          },
          root: {
            file_or_table: "insurance_policies",
            field: "mortgagee_clause",
            row: `hazard@${x.on}`,
            on: x.on,
            true_value: "servicer",
            planted_value: "prior_servicer",
          },
        },
      ];
    },
  },
  handling:
    "Have the carrier move the mortgagee clause and the billing to the servicer the notice of transfer names, " +
    "confirm the policy did not lapse, and pay the renewal from escrow by its due date: a lapse or a charge the late " +
    "payment caused is the servicer's to make good.",
  symptomHandling: (table, field, row) => {
    if (table === "disbursements" && isRefundRow(row))
      return "A refund from the escrow account that the unpaid premium moved: redo it with the renewal paid.";
    if (table === "disbursements" && field === "on")
      return "The renewal was paid when the prior servicer sent the bill on, after it was due: confirm coverage stayed in force.";
    if (table === "disbursements" || table === "month_ends" || table === "tape")
      return "The escrow account held the premium while the renewal went unpaid.";
    if (table === "escrow_analyses")
      return "The analysis counted a premium that was due and not yet paid as money in the account: run it again with the renewal paid.";
    if (table === "loan_installments" || table === "payments")
      return "Billed or applied at the escrow payment that analysis set: rebill from the corrected one.";
    if (table === "metro2")
      return "The furnished record moved because the payment did: correct it and furnish the correction.";
    return "Downstream of the renewal billed to the prior servicer: corrects when it is paid on time.";
  },
};

/**
 * D-28, a system's form of it: a borrower's payment drafted twice, the same
 * amount on the same day, and the second posted by the waterfall as any
 * payment is: to the next installment, paid ahead. Nothing in the history
 * returns it.
 */
export const D28: DefectDefinition = {
  id: "D-28",
  title: "A borrower's payment drafted twice",
  produces: null,
  requires_transfer: false,
  package: null,
  table: "payments",
  field: "*",
  eligible: () => true,
  boarded: (t) => t,
  trueValue: () => null,
  plantedValue: () => null,
  history: {
    partnered: false,
    candidates: (life) => drafts(life).map((x) => ({ key: x.id, on: x.on })),
    make: ({ loans, index, key }) => {
      const x = loans[index]!.receipts.find((y) => y.id === key);
      if (!x) return null;
      const id = `${x.id}-DUP`;
      return [
        {
          index,
          error: { kind: "receipt_twice", receipt: x.id },
          root: {
            file_or_table: "payments",
            field: "*",
            row: paymentRow(loans[index]!, { on: x.on, mode: "duplicate" }),
            on: x.on,
            true_value: null,
            planted_value: toJsonLine({ id, on: x.on, amount: x.amount, duplicate_of: x.id }),
          },
        },
      ];
    },
  },
  handling:
    "Return the second draft to the borrower at once: they authorized one. Reverse its posting, so the installment " +
    "it paid ahead is due again as the borrower expects, and correct what it moved.",
  symptomHandling: (table) => {
    if (table === "loan_installments")
      return "Paid ahead by the second draft: due again once it is returned.";
    if (table === "payments")
      return "Applied around the second draft: re-apply as if it had never been taken.";
    if (table === "borrower_events")
      return "The borrower's own payment found its installment already paid by the second draft.";
    if (table === "metro2")
      return "The furnished record moved because the second draft did: correct it and furnish the correction.";
    return "Downstream of the second draft: corrects when it is returned.";
  },
};

/**
 * D-25, a system's form of it, registered as `D-25/wrong-loan` beside the
 * prior servicer's split: a payment keyed to a loan number a keystroke
 * from the borrower's, and posted to the loan that has that number. The
 * borrower's loan never receives it, so the installment it paid is open and
 * runs late. The other loan's borrower, who knows nothing of it, pays as
 * billed, so that loan is paid ahead. Nothing in the history moves it back:
 * the catalog's reversal weeks later is a correction cashiering has no engine
 * for. Both loans carry a root cause.
 */
export const D25_WRONG_LOAN: DefectDefinition = {
  id: "D-25",
  form: "D-25/wrong-loan",
  title: "A payment posted to a neighboring loan number",
  produces: null,
  requires_transfer: false,
  package: null,
  table: "payments",
  field: "*",
  eligible: () => true,
  boarded: (t) => t,
  trueValue: () => null,
  plantedValue: () => null,
  history: {
    partnered: true,
    candidates: (life) => drafts(life).map((x) => ({ key: x.id, on: x.on })),
    make: ({ loans, index, key, partner }) => {
      const a = loans[index]!;
      const x = a.receipts.find((y) => y.id === key);
      if (!x) return null;
      const number = a.draw.servicer_loan_number;
      const lands = (j: number) =>
        j !== index &&
        keystrokeApart(number, loans[j]!.draw.servicer_loan_number) &&
        onOurBooks(loans[j]!, x.on);
      const j =
        partner !== null
          ? lands(partner)
            ? partner
            : null
          : (loans.map((_, k) => (index + 1 + k) % loans.length).find(lands) ?? null);
      if (j === null) return null;
      const b = loans[j]!;
      const id = `${x.id}-MIS`;
      return [
        {
          index,
          error: { kind: "receipt_elsewhere", receipt: x.id, to: b.loan_id },
          root: {
            file_or_table: "payments",
            field: "*",
            row: paymentRow(a, x),
            on: x.on,
            true_value: toJsonLine({ id: x.id, on: x.on, amount: x.amount, loan: number }),
            planted_value: null,
          },
        },
        {
          index: j,
          error: { kind: "receipt_from", id, on: x.on, amount: x.amount, from: a.loan_id },
          root: {
            file_or_table: "payments",
            field: "*",
            row: paymentRow(b, { on: x.on, mode: "misposted" }),
            on: x.on,
            true_value: null,
            planted_value: toJsonLine({ id, on: x.on, amount: x.amount, keyed_from: number }),
          },
        },
      ];
    },
  },
  handling:
    "Move the payment to the loan it was for, as of the day it was received: reverse it on the loan it was posted " +
    "to, and whatever it paid there; post it to the borrower who sent it, with no late charge for the days it was " +
    "missing; and correct what both loans furnished to the credit bureaus.",
  symptomHandling: (table) => {
    if (table === "fees" || table === "late_charge_runs")
      return "A late charge on a payment that was made and posted elsewhere: waive it.";
    if (table === "loan_installments")
      return "Open, or paid ahead, because the payment sat on the wrong loan: as of the day it was received, the installment it was for is paid.";
    if (table === "payments")
      return "Applied around the payment on the wrong loan: re-apply once it is moved.";
    if (table === "month_ends" || table === "tape" || table === "metro2")
      return "Reported late, or paid ahead, because the payment sat on the wrong loan: correct it and furnish the correction.";
    return "Downstream of the payment posted to the wrong loan: corrects when it is moved.";
  },
};

/** The bill lines a history error names. */
type HistoryBillLine = Extract<HistoryError, { kind: "bill_amount" }>["line"];

/** The key the registry holds a definition under: its form where it has one, its id otherwise. */
export const defectKey = (def: Pick<DefectDefinition, "id" | "form">): string => def.form ?? def.id;

/**
 * The registry: the first ten in the order docs/synthetic-data-defects.md ranks them, then the errors made in the
 * history after boarding.
 */
export const DEFECTS: Readonly<Record<string, DefectDefinition>> = Object.fromEntries(
  [D42, D35, D03, D01, D12, D37, D18, D24, D25, D15, V01, V02, D28, D25_WRONG_LOAN].map((def) => [
    defectKey(def),
    def,
  ]),
);

export function defectById(id: string): DefectDefinition {
  const def = DEFECTS[id];
  if (!def)
    throw new RangeError(`no defect ${id}; the registry plants ${Object.keys(DEFECTS).join(", ")}`);
  return def;
}

/* ── the comparison ──────────────────────────────────────────────────────── */

type Row = Readonly<Record<string, unknown>>;
interface Table {
  readonly name: string;
  readonly rows: (l: LoanLife) => readonly Row[];
  readonly key: (r: Row) => string;
  readonly date: (r: Row) => PlainDate;
  /** Fields that are not compared: a number the history assigns in order, which says nothing about the row. */
  readonly ignore?: readonly string[];
  /**
   * The row as a label names it, when its key is not a name a reader would
   * know it by: read off the clean history's row where there is one, and the
   * twin's where there is not. `key` is the row's key, with its occurrence.
   */
  readonly rowName?: (r: Row, key: string) => string;
}

/** A value as a label carries it: scalars as they print, rows and lists as JSON, nothing as null. */
const s = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : typeof v === "string"
      ? v
      : typeof v === "bigint" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : toJsonLine(v);
const asRows = (xs: readonly object[]): readonly Row[] => xs as unknown as readonly Row[];
const occurrence = (rows: readonly Row[], keyOf: (r: Row) => string) => {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = keyOf(r);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? k : `${k}#${n}`;
  });
};

/** The servicing app's table names for the history's rows (docs/subservicer-data.md, the domain tables). */
export const TABLES: readonly Table[] = [
  {
    name: "payments",
    rows: (l) => asRows(l.receipts),
    // By the day and the kind of payment, not the id: a receipt is numbered as it posts, so a payment one history
    // never sends (a draft taken twice leaves the next one nothing to pay) would renumber every receipt after it.
    key: (r) => `${String(r["on"])}:${String(r["mode"])}`,
    date: (r) => r["on"] as PlainDate,
    ignore: ["id"],
  },
  {
    name: "fees",
    rows: (l) => asRows(l.fees),
    key: (r) => String(r["id"]),
    date: (r) => r["assessed_on"] as PlainDate,
  },
  {
    name: "late_charge_runs",
    rows: (l) => asRows(l.late_charge_runs),
    key: (r) => String(r["due"]),
    date: (r) => r["on"] as PlainDate,
  },
  {
    name: "disbursements",
    rows: (l) => asRows(l.disbursements),
    // Not by the id, which is numbered as the row is written: a refund one history makes and the other does not
    // (an analysis that found a surplus in one and a shortage in the other) would renumber every row after it. A bill
    // is its line's next, which a bill paid late or at the wrong amount still is, and is named by the day it was
    // paid in the clean history, its due date; any other row is named by its kind and its day.
    key: (r) =>
      r["kind"] === "bill" ? String(r["line"]) : `${String(r["kind"])}@${String(r["on"])}`,
    rowName: (r, key) => (r["kind"] === "bill" ? `${String(r["line"])}@${String(r["on"])}` : key),
    date: (r) => r["on"] as PlainDate,
    ignore: ["id"],
  },
  {
    name: "escrow_analyses",
    rows: (l) => asRows(l.analyses),
    key: (r) => String(r["year"]),
    date: (r) => r["as_of"] as PlainDate,
  },
  {
    name: "arm_adjustments",
    rows: (l) => asRows(l.arm_changes),
    key: (r) => String(r["change"]),
    date: (r) => r["notice_sent_on"] as PlainDate,
  },
  {
    name: "mi_events",
    rows: (l) => asRows(l.pmi),
    key: (r) => `${String(r["trigger"])}@${String(r["on"])}`,
    date: (r) => r["on"] as PlainDate,
  },
  {
    name: "contacts",
    rows: (l) => asRows(l.contacts),
    key: (r) => `${String(r["on"])}:${String(r["reason"])}`,
    date: (r) => r["on"] as PlainDate,
  },
  {
    name: "borrower_events",
    rows: (l) => asRows(l.behavior),
    key: (r) => `${String(r["on"])}:${String(r["kind"])}`,
    date: (r) => r["on"] as PlainDate,
  },
  {
    name: "loan_installments",
    rows: (l) => asRows(l.installments),
    key: (r) => String(r["due"]),
    date: (r) => r["due"] as PlainDate,
  },
  {
    name: "month_ends",
    rows: (l) => l.months.map(({ metro2: _m, ...rest }) => rest) as readonly Row[],
    key: (r) => String(r["month"]),
    date: (r) => r["as_of"] as PlainDate,
  },
  {
    name: "metro2",
    rows: (l) =>
      l.months.map((m) => ({
        month: m.month,
        as_of: m.as_of,
        furnished_by: m.metro2.furnished_by,
        errors: m.metro2.errors,
        ...(m.metro2.record ?? {}),
      })) as readonly Row[],
    key: (r) => String(r["month"]),
    date: (r) => r["as_of"] as PlainDate,
  },
  {
    name: "payoffs",
    rows: (l) => (l.payoff ? [l.payoff as unknown as Row] : []),
    key: () => "payoff",
    date: (r) => r["on"] as PlainDate,
  },
  {
    // The partner's month-end tape, as the projection gives it (projection.ts): what the servicer reports.
    name: "tape",
    rows: (l) => l.months.map((m) => flatRow(monthEndRow(l, m.month)!)),
    key: (r) => String(r["as_of_date"]),
    date: (r) => r["as_of_date"] as PlainDate,
  },
];

/** A tape row's groups flattened to one level, each field under its group's name ("terms.pi_cents"). */
function flatRow(row: object): Row {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row))
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      for (const [k2, v2] of Object.entries(v as object)) out[`${k}.${k2}`] = v2;
    else out[k] = v;
  return out;
}

/** The servicing app's column where the history's own name differs from it. */
const FIELD_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  fees: { amount: "amount_cents", collected: "collected_cents" },
};

/** One field that differs between a clean history and its twin. */
export type Difference = Pick<
  DefectLabel,
  "file_or_table" | "field" | "row" | "on" | "true_value" | "planted_value"
>;

/** Every difference between the clean loan and its twin, as symptom labels of `def`. */
export function symptomLabels(
  clean: LoanLife,
  twin: LoanLife,
  def: DefectDefinition,
): DefectLabel[] {
  return differences(clean, twin).map((x) => ({
    loan: clean.loan_id,
    defect_id: def.id,
    ...x,
    expected_handling: def.symptomHandling(x.file_or_table, x.field, x.row),
    root_cause: false,
  }));
}

/** Every difference between the clean loan and its twin, table by table and field by field. */
export function differences(clean: LoanLife, twin: LoanLife): Difference[] {
  const out: Difference[] = [];
  for (const t of TABLES) {
    const a = t.rows(clean);
    const b = t.rows(twin);
    const ka = occurrence(a, t.key);
    const kb = occurrence(b, t.key);
    const A = new Map(ka.map((k, i) => [k, a[i]!]));
    const B = new Map(kb.map((k, i) => [k, b[i]!]));
    const keys = [...new Set([...ka, ...kb])];
    for (const k of keys) {
      const ra = A.get(k);
      const rb = B.get(k);
      const row = t.rowName ? t.rowName((ra ?? rb)!, k) : k;
      const label = (
        field: string,
        tv: string | null,
        pv: string | null,
        on: PlainDate,
      ): Difference => ({
        file_or_table: t.name,
        field,
        row,
        on,
        true_value: tv,
        planted_value: pv,
      });
      if (!ra || !rb) {
        out.push(label("*", ra ? s(ra) : null, rb ? s(rb) : null, t.date((ra ?? rb)!)));
        continue;
      }
      for (const f of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (t.ignore?.includes(f)) continue;
        const va = s(ra[f]);
        const vb = s(rb[f]);
        if (va !== vb) out.push(label(FIELD_NAMES[t.name]?.[f] ?? f, va, vb, t.date(rb)));
      }
    }
  }
  return out;
}

/** The root-cause label for `def` planted on `life`'s loan (the twin), read against its clean history. */
export function rootLabel(life: LoanLife, def: DefectDefinition, clean: LoanLife): DefectLabel {
  const at = def.rootRow?.(clean) ?? { row: life.loan_id, on: life.boarded.on };
  return {
    loan: life.loan_id,
    defect_id: def.id,
    file_or_table: def.table,
    field: def.field,
    row: at.row,
    on: at.on,
    true_value: def.trueValue(life.draw, clean),
    planted_value: def.plantedValue(life.draw, clean),
    expected_handling: def.handling,
    root_cause: true,
  };
}
