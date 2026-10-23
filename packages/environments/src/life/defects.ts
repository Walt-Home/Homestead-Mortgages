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
 * one more `DefectDefinition`. This wave holds D-03 and D-42, ranked 4th and
 * 3rd of the first ten in docs/synthetic-data-defects.md.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import { formatCents, type Cents } from "@hm/kernel/money";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { toJsonLine } from "../record.js";
import type { LoanDraw } from "./draw.js";
import type { BoardedTerms, LoanLife } from "./simulate.js";

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
  /** Whether it can only enter through a transfer (a cell in the prior servicer's package). */
  readonly requires_transfer: boolean;
  readonly package: PackageDefect | null;
  /** Where the root cause lives. */
  readonly table: string;
  readonly field: string;
  /** Whether the defect can be planted on this loan at all. */
  eligible(d: LoanDraw): boolean;
  /** What boarding writes instead of the note's terms. */
  boarded(note: BoardedTerms): BoardedTerms;
  trueValue(d: LoanDraw): string | null;
  plantedValue(d: LoanDraw): string | null;
  /** What a servicer should do about the root cause. */
  readonly handling: string;
  /** What a servicer should do about a symptom in this table and field. */
  symptomHandling(table: string, field: string): string;
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

export const DEFECTS: Readonly<Record<string, DefectDefinition>> = { "D-03": D03, "D-42": D42 };

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
    key: (r) => String(r["id"]),
    date: (r) => r["on"] as PlainDate,
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
