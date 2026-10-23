/**
 * Defects planted in a loan's history, and the labels that say where.
 *
 * A defect is planted where docs/synthetic-data-defects.md says it enters.
 * Both in the registry so far enter at boarding, so the twin runs the same
 * loan from the same draws with one value boarded wrong and everything after
 * it computed by the engines as they would compute it on that value. Its
 * labels are of two kinds. The root cause is the planted value itself
 * (`root_cause: true`). Every other difference between the twin and the
 * clean history is a symptom (`root_cause: false`): found by comparing the
 * two, table by table and field by field, so a label exists for every row
 * the defect reached and for no other.
 *
 * A defect that reaches boarding through a transfer package says where in
 * the package it sits (`package`): the file, the column, the cell the clean
 * package carries and the one the twin's carries instead, and what a
 * reviewer should do about it. The transfer-package writer
 * (`transfer-package.ts`) plants that cell; the boarding-triage environment
 * grades a reviewer against it.
 *
 * `DEFECTS` is the registry, and each later wave extends it: a new defect is
 * one more `DefectDefinition`. It holds D-03 and D-42, ranked 4th and 3rd of
 * the first ten in docs/synthetic-data-defects.md, which enter at boarding,
 * and four errors made in the history after it by someone the servicer
 * depends on (`history`):
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
 */

import { addDays, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { formatCents, type Cents } from "@hm/kernel/money";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { toJsonLine } from "../record.js";
import type { Rng } from "../rng.js";
import type { LoanDraw } from "./draw.js";
import type { BoardedTerms, HistoryError, LoanLife } from "./simulate.js";

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

/** Where a defect sits in a transfer package, and what a reviewer should do about it. */
export interface PackageDefect {
  /** The package file and column the planted cell sits in. */
  readonly file: string;
  readonly field: string;
  /** The cell the clean package carries, and the one the twin's package carries instead. */
  trueCell(d: LoanDraw): string;
  plantedCell(d: LoanDraw): string;
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
  readonly id: string;
  readonly title: string;
  /** Another defect in docs/synthetic-data-defects.md this one produces once boarded (D-42 boards D-31). */
  readonly produces: string | null;
  /** Whether it can only enter through a transfer (a cell in the prior servicer's package, or a bill still addressed to the prior servicer). */
  readonly requires_transfer: boolean;
  readonly package: PackageDefect | null;
  /** Where the root cause lives. */
  readonly table: string;
  readonly field: string;
  /** Whether the defect can be planted on this loan at all. */
  eligible(d: LoanDraw): boolean;
  /** What boarding writes instead of the note's terms. A history error boards the note as it is. */
  boarded(note: BoardedTerms): BoardedTerms;
  /** The root cause's values, for a defect that enters at boarding; a history error's are its placements'. */
  trueValue(d: LoanDraw): string | null;
  plantedValue(d: LoanDraw): string | null;
  /**
   * For an error made in the history after boarding (a vendor's or a
   * system's), where it can be made and what it changes; null for a defect
   * that enters at boarding.
   */
  readonly history: HistoryErrorPlan | null;
  /** What a servicer should do about the root cause. */
  readonly handling: string;
  /** What a servicer should do about a symptom in this table and field. */
  symptomHandling(table: string, field: string): string;
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
    file: "boarding_tape.final.csv",
    field: "late_charge_max",
    trueCell: (d) => dollars(d.late_charge.cap_cents),
    plantedCell: () => "",
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
    file: "boarding_tape.final.csv",
    field: "escrowed",
    trueCell: () => "Y",
    plantedCell: () => "Yes",
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
  symptomHandling: (table, field) => {
    if (table === "disbursements" && field === "amount")
      return "The bill was paid at the vendor's figure, ten times the county's: the county is owed nothing more, and the excess comes back to escrow.";
    if (table === "disbursements" && field === "*")
      return "The county's return of the overpayment: book it to escrow.";
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
  symptomHandling: (table, field) => {
    if (table === "disbursements" && field === "on")
      return "The renewal was paid when the prior servicer sent the bill on, after it was due: confirm coverage stayed in force.";
    if (table === "disbursements" || table === "month_ends")
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
 * D-25, a system's form of it: a payment keyed to a loan number a keystroke
 * from the borrower's, and posted to the loan that has that number. The
 * borrower's loan never receives it, so the installment it paid is open and
 * runs late, and the other loan is paid ahead. Nothing in the history moves it
 * back: the catalog's reversal weeks later is a correction cashiering has no
 * engine for. Both loans carry a root cause.
 */
export const D25: DefectDefinition = {
  id: "D-25",
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
    if (table === "month_ends" || table === "metro2")
      return "Reported late, or paid ahead, because the payment sat on the wrong loan: correct it and furnish the correction.";
    return "Downstream of the payment posted to the wrong loan: corrects when it is moved.";
  },
};

/** The bill lines a history error names. */
type HistoryBillLine = Extract<HistoryError, { kind: "bill_amount" }>["line"];

export const DEFECTS: Readonly<Record<string, DefectDefinition>> = {
  "D-03": D03,
  "D-42": D42,
  "V-01": V01,
  "V-02": V02,
  "D-28": D28,
  "D-25": D25,
};

export function defectById(id: string): DefectDefinition {
  const def = DEFECTS[id];
  if (!def)
    throw new RangeError(`no defect ${id}; this wave plants ${Object.keys(DEFECTS).join(", ")}`);
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
    key: (r) => String(r["id"]),
    date: (r) => r["on"] as PlainDate,
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
];

/** The servicing app's column where the history's own name differs from it. */
const FIELD_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  fees: { amount: "amount_cents", collected: "collected_cents" },
};

/** Cents as the tape writes money: dollars with two decimals, no symbol or grouping; blank for none. */
export function dollars(c: Cents | null): string {
  return c === null ? "" : formatCents(c, { symbol: false, grouping: false });
}

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
    expected_handling: def.symptomHandling(x.file_or_table, x.field),
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
      const label = (
        field: string,
        tv: string | null,
        pv: string | null,
        on: PlainDate,
      ): Difference => ({
        file_or_table: t.name,
        field,
        row: k,
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

/** The root-cause label for `def` planted on `life`'s loan. */
export function rootLabel(life: LoanLife, def: DefectDefinition): DefectLabel {
  return {
    loan: life.loan_id,
    defect_id: def.id,
    file_or_table: def.table,
    field: def.field,
    row: life.loan_id,
    on: life.boarded.on,
    true_value: def.trueValue(life.draw),
    planted_value: def.plantedValue(life.draw),
    expected_handling: def.handling,
    root_cause: true,
  };
}
