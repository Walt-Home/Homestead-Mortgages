/**
 * Defects planted in a loan's history, and the labels that say where.
 *
 * A defect is planted where docs/synthetic-data-defects.md says it enters:
 * this wave's one, D-03, enters at boarding, so the twin runs the same loan
 * from the same draws with one value boarded wrong and everything after it
 * computed by the engines as they would compute it on that value. Its labels
 * are of two kinds. The root cause is the planted value itself
 * (`root_cause: true`). Every other difference between the twin and the
 * clean history is a symptom (`root_cause: false`): found by comparing the
 * two, table by table and field by field, so a label exists for every row
 * the defect reached and for no other.
 *
 * The transfer package and the other 46 defects come later; a new defect is
 * one more `DefectDefinition`.
 */

import type { PlainDate } from "@hm/kernel/calendar";
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

export interface DefectDefinition {
  readonly id: string;
  readonly title: string;
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
      return "The furnished record moved because the payment application did: correct it and furnish the correction (8.1).";
    return "Downstream of the uncapped late charges: corrects when they are recomputed.";
  },
};

export const DEFECTS: Readonly<Record<string, DefectDefinition>> = { "D-03": D03 };

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

/** Every difference between the clean loan and its twin, as symptom labels of `def`. */
export function symptomLabels(
  clean: LoanLife,
  twin: LoanLife,
  def: DefectDefinition,
): DefectLabel[] {
  const out: DefectLabel[] = [];
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
      ): DefectLabel => ({
        loan: clean.loan_id,
        defect_id: def.id,
        file_or_table: t.name,
        field,
        row: k,
        on,
        true_value: tv,
        planted_value: pv,
        expected_handling: def.symptomHandling(t.name, field),
        root_cause: false,
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
