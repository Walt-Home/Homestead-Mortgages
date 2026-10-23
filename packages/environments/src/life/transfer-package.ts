/**
 * The transfer package: what the prior servicer hands over for a loan the
 * life generator boards by transfer, written in the servicing app's sample
 * layout (`apps/servicing/fixtures/transfer-batch-demo/LAYOUT.md`).
 *
 * The twelve files are the sample's: the final boarding tape as of the close
 * of business before the transfer date, the payment history, the escrow
 * history and analysis, the loss-mitigation and bankruptcy-or-foreclosure
 * files, consents, the images manifest, the trial balance, the Fannie Mae
 * position, the MERS lookup and the fair-lending file. Every one is encoded
 * by the servicing app's own codec (`encodeTransferBatch`, ported in
 * `../boarding/ported/tape-codec.ts`), so a package reads back through the
 * decoder the servicing app boards with exactly as the sample does. The
 * vendored sample is never edited; this writes packages of its own.
 *
 * Two things the sample does not carry:
 *   - the life-of-loan payment history. The sample carries 24 months; this
 *     carries every installment from the first, one row each with the day it
 *     was paid in full and the amount that paid it, read off the cashiering
 *     ledger (a receipt that paid two installments shows on both rows; a
 *     curtailment is no row). F-1-11 asks for "transaction and payment
 *     histories for the life of the mortgage loans" (spec 1-1 :32);
 *   - a thirteenth file, `correspondence_file.csv`: the prior servicer's
 *     periodic statements, late-charge notices, escrow analysis statements,
 *     ARM change notices, calls and its notice of the transfer. The spec
 *     names it among the inbound files (spec 1-1 :59), the servicing app's
 *     tape kinds include it (`TapeKind`, service.ts:22), and the decoder reads
 *     its twelve files by name and ignores any other, so it travels without
 *     changing what boards.
 * And one column the sample's tape has no place for, `late_charge_max`, the
 * note's dollar cap on a late charge, after the layout's own columns. The
 * layout has no cap column (LAYOUT.md:65-66), so the decoder never reads it:
 * a loan boarded from any tape, this one's included, boards with no cap.
 *
 * Defects are planted through the generator's twins. The prior servicer's
 * months are the same in a clean history and its twin, so their packages are
 * the same file for file but for the cell each planted defect names
 * (`DefectDefinition.package`), and the manifest labels it. A loan with no
 * defect is a clean twin, the negative a reviewer must pass.
 *
 * The manifest is shaped like the sample's (`manifest.json`): the batch, each
 * file's SHA-256, row count and size, and `designed_outcomes`. The sample's
 * designed outcomes are the gate's hard failures and warnings, each one a
 * defect a rule sees; a written package plants none, so both are empty, and
 * `defects` lists what is planted for the gate not to see. `labels` holds
 * each planted cell in the generator's label shape.
 */

import { createHash } from "node:crypto";
import { addDays, addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import { cents, formatCents, type Cents } from "@hm/kernel/money";
import { makeMin } from "../boarding/ported/min.js";
import {
  encodeTransferBatch,
  parseCsv,
  toCsv,
  FINAL_TAPE_HEADER,
  type FairLendingRow,
  type ImageRow,
  type TransferBatchData,
  type TransferBatchFiles,
} from "../boarding/ported/tape-codec.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import type { FnmaPosition, MersRecord, StagedLoan } from "../pmi/ported/types.js";
import { rngFor } from "../rng.js";
import { defectById, type DefectLabel, type Handling } from "./defects.js";
import type { EscrowLine } from "./draw.js";
import type { LoanLife } from "./simulate.js";

/** The twelve files of the sample's layout, and the correspondence file it lacks. */
export const LAYOUT_FILES = [
  "boarding_tape.final.csv",
  "payment_history.csv",
  "escrow_history.csv",
  "escrow_analysis.csv",
  "lossmit_file.csv",
  "fc_bk_file.csv",
  "consents_file.csv",
  "images_manifest.csv",
  "trial_balance.csv",
  "fnma_position.csv",
  "mers_lookup.csv",
  "fair_lending.csv",
] as const satisfies readonly (keyof TransferBatchFiles)[];
export const CORRESPONDENCE_FILE = "correspondence_file.csv";
export const PACKAGE_FILES = [...LAYOUT_FILES, CORRESPONDENCE_FILE] as const;
export type PackageFile = (typeof PACKAGE_FILES)[number];

/** The extension column after the layout's own: the note's dollar cap on a late charge. */
export const CAP_COLUMN = "late_charge_max";
export const TAPE_HEADER: readonly string[] = [...FINAL_TAPE_HEADER, CAP_COLUMN];

export const CORRESPONDENCE_HEADER = [
  "transferor_loan_number",
  "sent_on",
  "direction",
  "channel",
  "kind",
  "due_date",
  "pi",
  "escrow",
  "amount",
  "late_fee",
  "late_fee_after",
  "detail",
] as const;

/** What each correspondence row is. */
export const CORRESPONDENCE_KINDS = [
  "periodic_statement",
  "late_charge_assessed",
  "escrow_analysis",
  "arm_change_notice",
  "transfer_notice",
  "collection_call",
  "borrower_call",
] as const;

/** The transfer: who hands the loans over, to whom, and when. */
export interface TransferBatch {
  readonly batch_id: string;
  readonly transfer_date: PlainDate;
  readonly transferor_name: string;
  readonly transferor_servicer_number: string;
  readonly transferor_mers_org_id: string;
  readonly partner_servicer_number: string;
  readonly partner_mers_org_id: string;
}

/** The batch every package is written for unless told otherwise; the partner's numbers are the sample's. */
export const PACKAGE_DEFAULTS: Omit<TransferBatch, "batch_id" | "transfer_date"> = {
  transferor_name: "Synthetic Prior Servicer LLC",
  transferor_servicer_number: "555000111",
  transferor_mers_org_id: "1000789",
  partner_servicer_number: "987654321",
  partner_mers_org_id: "1000123",
};

/** One loan in a package, and the defects planted in its cells (none for a clean twin). */
export interface PackageLoan {
  readonly life: LoanLife;
  readonly defects?: readonly string[];
}

/** A planted cell, in the generator's label shape, with what a reviewer should do about it. */
export interface PackageLabel extends DefectLabel {
  /** Another defect the planted cell produces once boarded (D-42 boards D-31), or null. */
  readonly produces: string | null;
  readonly handling: Handling;
  readonly also_accepted: readonly Handling[];
  readonly why: string;
  readonly evidence: string;
  /** What the servicing app's decoder and gate do with the planted cell. */
  readonly gate: string;
}

export interface PackageManifest {
  readonly batch: TransferBatch & {
    readonly loan_count: number;
    readonly upb_total: string;
    readonly escrow_total: string;
  };
  readonly generated_by: string;
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly row_count: number; readonly bytes: number }>
  >;
  readonly designed_outcomes: {
    readonly hard: Readonly<Record<string, readonly string[]>>;
    readonly warnings: Readonly<Record<string, readonly string[]>>;
    /** The defects planted for the gate not to see, by transferor loan number. */
    readonly defects: Readonly<Record<string, readonly string[]>>;
    /** The clean twins: loans with nothing planted. */
    readonly clean: readonly string[];
  };
  readonly labels: readonly PackageLabel[];
}

export interface TransferPackage {
  readonly batch: TransferBatch;
  readonly files: Readonly<Record<PackageFile, string>>;
  /** The staged loans the tape encodes, before any cell is planted: the package as the note says it should be. */
  readonly loans: readonly StagedLoan[];
  readonly manifest: PackageManifest;
}

const money = (c: Cents | null): string =>
  c === null ? "" : formatCents(c, { symbol: false, grouping: false });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rowsOf = (csv: string) => csv.split("\n").filter((l) => l.length).length - 1;

/** The layout names one tax line type; a second taxing authority's line is written under it too. */
const LINE_TYPE: Readonly<Record<EscrowLine["line_type"], string>> = {
  tax_county: "county_tax",
  tax_school: "county_tax",
  hazard: "hazard",
  flood: "flood",
  mi_borrower_paid: "mi",
};

/** The prior servicer's view of one loan at the close of business before `transfer`. */
function stagedLoan(life: LoanLife, batch: TransferBatch): StagedLoan {
  const d = life.draw;
  const t = life.at_transfer;
  const T = batch.transfer_date;
  if (!t || life.transfer_in_on !== T)
    throw new RangeError(
      `${life.loan_id} is not transferred on ${T}: a package holds loans the generator boards by transfer on its date`,
    );
  const asOf = addDays(T, -1);
  const r = rngFor(`${life.loan_id}/package`);
  const b1 = d.parties[0]!;
  const year = addMonths(T, 12);
  const lines = d.escrowed
    ? life.lines.flatMap((l) => {
        const next = l.bills.filter((x) => x.on >= T && x.on < year);
        if (l.basis === "mi" && !t.mi_active) return [];
        if (next.length === 0) return [];
        return [
          {
            line_type: LINE_TYPE[l.line_type],
            annual_amount_cents: next.reduce((s, x) => s + x.amount, 0n),
            next_due_date: next[0]!.on,
          },
        ];
      })
    : [];
  const hazardRenewal = d.escrowed
    ? (life.lines.find((l) => l.basis === "hazard")?.bills.find((x) => x.on >= T)?.on ?? null)
    : null;
  const analyses = life.analyses.filter((a) => a.as_of < T);
  // The installments due by the transfer, or by the oldest unpaid when the borrower is ahead.
  const through = t.next_due > T ? t.next_due : T;
  const rows = t.installments.filter((i) => i.due <= through);
  const paidOn = (i: (typeof rows)[number]) => {
    const on = i.credited_as_of ?? i.satisfied_on;
    return (i.status === "satisfied" || i.status === "prepaid") && on !== null && on <= asOf
      ? on
      : null;
  };
  const nextChange = d.arm
    ? (() => {
        let c = d.arm.first_change;
        while (c < T) c = addMonths(c, d.arm.period_months);
        return c;
      })()
    : null;
  const bps = (pct: string) => Math.round(Number(pct) * 100);
  const tin = `000-${String(r.int(10, 99))}-${String(r.int(1000, 9999))}`;
  const phone = `+1${r.int(201, 989)}555${String(r.int(1000, 9999))}`;
  return {
    transferor_loan_number: d.prior_servicer_loan_number,
    fnma_loan_number: d.fnma_loan_number,
    min: makeMin(d.min.slice(0, 7), d.min.slice(7, 17)),
    mers_eligible: true,
    remittance_type: "A/A",
    upb_cents: t.upb,
    next_due_date: t.next_due,
    note_rate_pct: t.rate_pct,
    pi_cents: t.pi,
    escrow_payment_cents: d.escrowed ? t.escrow_payment : 0n,
    maturity_date: d.maturity,
    original_term_months: d.term_months,
    original_upb_cents: d.orig_upb_cents,
    instrument_date: d.note_date,
    origination_date: d.note_date,
    first_payment_date: d.first_due,
    interest_method: "30_360",
    amortization: d.arm ? "arm" : "fixed",
    ...(d.arm
      ? {
          arm: {
            index: "SOFR_30D_AVG",
            margin_bps: bps(d.arm.margin_pct),
            initial_cap_bps: bps(d.arm.initial_cap_pct),
            periodic_cap_bps: bps(d.arm.periodic_cap_pct),
            lifetime_cap_bps: bps(d.arm.lifetime_cap_pct),
            lookback_days: d.arm.lookback_days,
            next_change_date: nextChange,
          },
        }
      : {}),
    escrowed: d.escrowed,
    escrow_balance_cents: d.escrowed ? t.escrow_balance : 0n,
    escrow_lines: lines,
    escrow_sign_consistent: true,
    // The last annual analysis, or the initial escrow account statement at closing (12 CFR 1024.17(g)).
    last_escrow_analysis_date: d.escrowed ? (analyses.at(-1)?.as_of ?? d.note_date) : null,
    late_charge_pct: d.late_charge.pct,
    late_charge_grace_days: d.late_charge.grace_days,
    deferred_principal_cents: 0n,
    forborne_principal_cents: 0n,
    nib_separated: true,
    bankruptcy: { active: false },
    foreclosure: { active: false },
    lossmit: { in_process: false },
    scra: { active: false },
    borrower: {
      legal_name: `${b1.given_name} ${b1.surname}`,
      tin,
      phone,
      email: `${b1.given_name}.${b1.surname}.${d.index}@example.test`.toLowerCase(),
      preferred_language: "en",
    },
    property: {
      address_line1: d.property.street,
      city: d.property.city,
      state: d.property.state,
      postal_code: d.property.zip,
      occupancy: "owner_occupied",
    },
    custody: { custodian: "Bank Custodian NA", certification_status: "certified" },
    consents: { esign_evidence: true, tcpa_voice_evidence: true },
    tax_parcel_verified: true,
    hazard_policy_expires: hazardRenewal,
    mi: t.mi_active
      ? { flag: true, certificate_number: `MI-${r.int(100000, 999999)}` }
      : { flag: false },
    flood_determination_life_of_loan: true,
    sii: { present: false, complete: true },
    unapplied_cents: t.suspense,
    fair_lending_present: true,
    acp_enrolled: false,
    fees_advances_cents: 0n,
    fees_itemized: true,
    corporate_advances_cents: 0n,
    late_charges_due_cents: t.late_charges_due,
    mers_investor_is_fnma: true,
    installments: rows.map((i) => ({ due_date: i.due, amount_cents: i.pi + i.escrow })),
    payments: rows.flatMap((i) => {
      const on = paidOn(i);
      return on ? [{ received_on: on, amount_cents: i.pi + i.escrow }] : [];
    }),
  };
}

type CorrespondenceRow = Record<(typeof CORRESPONDENCE_HEADER)[number], string>;

/** What the prior servicer sent and heard, before the transfer date. */
function correspondence(life: LoanLife, batch: TransferBatch): CorrespondenceRow[] {
  const d = life.draw;
  const T = batch.transfer_date;
  const n = d.prior_servicer_loan_number;
  const row = (r: Partial<CorrespondenceRow> & Pick<CorrespondenceRow, "sent_on" | "kind">) => ({
    transferor_loan_number: n,
    direction: "outbound",
    channel: "mail",
    due_date: "",
    pi: "",
    escrow: "",
    amount: "",
    late_fee: "",
    late_fee_after: "",
    detail: "",
    ...r,
  });
  const out: CorrespondenceRow[] = [];
  // Each periodic statement (12 CFR 1026.41(d)): the payment due, and the late fee and the date it is imposed,
  // as the prior servicer's system computed it from the note's terms. Sent after the last one's grace period.
  // The ledger is the one at the transfer, so a statement shows what the prior servicer's books did then.
  const ledger = life.at_transfer!.installments;
  for (const i of ledger) {
    const sent = i.due === d.first_due ? addDays(i.due, -14) : addDays(addMonths(i.due, -1), 17);
    if (sent >= T) continue;
    const run = life.late_charge_runs.find((x) => x.due === i.due);
    const pastDue = ledger
      .filter((x) => {
        const on = x.credited_as_of ?? x.satisfied_on;
        return x.due < i.due && (on === null || on > sent);
      })
      .reduce((s, x) => s + x.pi + x.escrow, 0n);
    out.push(
      row({
        sent_on: sent,
        kind: "periodic_statement",
        due_date: i.due,
        pi: money(i.pi),
        escrow: money(i.escrow),
        amount: money(i.pi + i.escrow),
        late_fee: money(lateChargeAmount(i.pi, d.late_charge.pct, d.late_charge.cap_cents)),
        late_fee_after: run ? addDays(run.on, -1) : addDays(i.due, d.late_charge.grace_days),
        detail: `past due ${money(pastDue)}`,
      }),
    );
  }
  for (const f of life.fees)
    if (f.assessed_on < T && f.servicer === "prior")
      out.push(
        row({
          sent_on: f.assessed_on,
          kind: "late_charge_assessed",
          due_date: f.due,
          amount: money(f.amount),
          detail: `late charge on the ${f.due} installment`,
        }),
      );
  for (const a of life.analyses)
    if (a.sent_on < T && a.servicer === "prior")
      out.push(
        row({
          sent_on: a.sent_on,
          kind: "escrow_analysis",
          due_date: a.effective,
          escrow: money(a.new_payment),
          amount: money(a.new_payment),
          detail:
            a.decision === "shortage"
              ? `shortage ${money(a.shortage)}, deficiency ${money(a.deficiency)}`
              : a.surplus !== null
                ? `${a.decision}, surplus ${money(a.surplus)}`
                : a.decision,
        }),
      );
  for (const c of life.arm_changes)
    if (c.notice_sent_on < T && c.servicer === "prior")
      out.push(
        row({
          sent_on: c.notice_sent_on,
          kind: "arm_change_notice",
          due_date: c.first_new_payment,
          pi: money(c.new_pi),
          amount: money(c.new_pi),
          detail: `rate ${c.prior_rate_pct} to ${c.new_rate_pct} on ${c.change}`,
        }),
      );
  for (const c of life.contacts)
    if (c.on < T && c.servicer === "prior")
      out.push(
        c.direction === "outbound"
          ? row({
              sent_on: c.on,
              kind: "collection_call",
              channel: "phone",
              detail: c.outcome ?? "",
            })
          : row({
              sent_on: c.on,
              kind: "borrower_call",
              direction: "inbound",
              channel: "phone",
              detail: c.reason,
            }),
      );
  // The notice of transfer (12 CFR 1024.33(b)), at least 15 days before its effective date.
  out.push(
    row({
      sent_on: addDays(T, -15),
      kind: "transfer_notice",
      due_date: T,
      detail: `servicing transfers to Supermortgage (${batch.partner_servicer_number}) on ${T}; the prior servicer accepts payments through ${addDays(T, -1)}`,
    }),
  );
  return out.sort((a, b) =>
    a.sent_on !== b.sent_on
      ? a.sent_on < b.sent_on
        ? -1
        : 1
      : CORRESPONDENCE_KINDS.indexOf(a.kind as (typeof CORRESPONDENCE_KINDS)[number]) -
        CORRESPONDENCE_KINDS.indexOf(b.kind as (typeof CORRESPONDENCE_KINDS)[number]),
  );
}

/**
 * The package for a batch of loans the generator boarded by transfer on one
 * date, each with the defects planted in its cells.
 */
export function writeTransferPackage(
  loans: readonly PackageLoan[],
  batch: Partial<TransferBatch> & { readonly transfer_date?: PlainDate } = {},
): TransferPackage {
  if (loans.length === 0) throw new RangeError("a package needs at least one loan");
  const T = batch.transfer_date ?? loans[0]!.life.transfer_in_on;
  if (!T) throw new RangeError(`${loans[0]!.life.loan_id} was never transferred`);
  const b: TransferBatch = {
    ...PACKAGE_DEFAULTS,
    batch_id: `B-LIFE-${T.slice(0, 7)}`,
    ...batch,
    transfer_date: T,
  };
  const staged = loans.map((l) => stagedLoan(l.life, b));
  const numbers = new Set(staged.map((s) => s.transferor_loan_number));
  if (numbers.size !== staged.length) throw new RangeError("a loan appears twice in the package");
  const fnma: FnmaPosition[] = staged.map((s) => ({
    fnma_loan_number: s.fnma_loan_number!,
    on_approved_list: true,
    remittance_type: "A/A",
    upb_cents: s.upb_cents!,
  }));
  const mers: MersRecord[] = staged.map((s) => ({
    min: s.min!,
    status: "Active",
    servicer_org_id: b.transferor_mers_org_id,
    investor_org_id: "1000001",
  }));
  const images: ImageRow[] = staged.flatMap((s) =>
    ["note", "mortgage", "title_policy"].map((doc) => {
      const filename = `${s.transferor_loan_number}_${doc}.pdf`;
      return {
        transferor_loan_number: s.transferor_loan_number,
        document_type: doc,
        filename,
        sha256: sha(`${b.batch_id}:${filename}`),
      };
    }),
  );
  const fairLending: FairLendingRow[] = loans.map((l, k) => {
    const r = rngFor(`${l.life.loan_id}/package/fair-lending`);
    return {
      transferor_loan_number: staged[k]!.transferor_loan_number,
      ethnicity: r.pick(["Not Hispanic or Latino", "Hispanic or Latino", "Not provided"]),
      race: r.pick(["White", "Black or African American", "Asian", "Not provided"]),
      sex: r.pick(["Female", "Male", "Not provided"]),
      age: String((daysBetween(l.life.draw.parties[0]!.date_of_birth, T) / 365.25) | 0),
      preferred_language: "en",
    };
  });
  const data: TransferBatchData = {
    loans: staged,
    fnma,
    trialBalance: staged.map((s) => ({
      transferor_loan_number: s.transferor_loan_number,
      fnma_loan_number: s.fnma_loan_number,
      upb_cents: s.upb_cents!,
    })),
    mers,
    images,
    fairLending,
  };
  const coborrowers = new Map<string, string>();
  loans.forEach((l, k) => {
    const b2 = l.life.draw.parties[1];
    if (b2) coborrowers.set(staged[k]!.transferor_loan_number, `${b2.given_name} ${b2.surname}`);
  });
  const encoded = encodeTransferBatch(data, coborrowers);

  // The tape again, with the cap column after the layout's own, and each planted cell in place of the true one.
  const labels: PackageLabel[] = [];
  const tape = parseCsv(encoded["boarding_tape.final.csv"]).map((row, k) => {
    const l = loans[k]!;
    const d = l.life.draw;
    const out: Record<string, string> = { ...row, [CAP_COLUMN]: money(d.late_charge.cap_cents) };
    for (const id of [...new Set(l.defects ?? [])].sort()) {
      const def = defectById(id);
      const p = def.package;
      if (!p) throw new RangeError(`${id} has no place in a transfer package`);
      if (!def.eligible(d)) throw new RangeError(`${id} cannot be planted on ${l.life.loan_id}`);
      if (p.file !== "boarding_tape.final.csv")
        throw new RangeError(`${id} sits in ${p.file}, which this writer does not plant`);
      if (out[p.field] !== p.trueCell(d))
        throw new RangeError(
          `${id}: ${p.field} on ${row["transferor_loan_number"]} is ${JSON.stringify(out[p.field])}, not the true ${JSON.stringify(p.trueCell(d))}`,
        );
      out[p.field] = p.plantedCell(d);
      const n = row["transferor_loan_number"]!;
      labels.push({
        loan: n,
        defect_id: id,
        file_or_table: p.file,
        field: p.field,
        row: n,
        on: b.transfer_date,
        true_value: p.trueCell(d),
        planted_value: p.plantedCell(d),
        expected_handling: def.handling,
        root_cause: true,
        produces: def.produces,
        handling: p.handling,
        also_accepted: p.also_accepted,
        why: p.why,
        evidence: p.evidence,
        gate: p.gate,
      });
    }
    return out;
  });
  const files: Record<PackageFile, string> = {
    ...encoded,
    "boarding_tape.final.csv": toCsv(TAPE_HEADER, tape),
    [CORRESPONDENCE_FILE]: toCsv(
      CORRESPONDENCE_HEADER,
      loans.flatMap((l) => correspondence(l.life, b)),
    ),
  };
  const ordered = Object.fromEntries(PACKAGE_FILES.map((f) => [f, files[f]])) as Record<
    PackageFile,
    string
  >;
  return { batch: b, files: ordered, loans: staged, manifest: packageManifest(b, ordered, labels) };
}

/** A package's manifest, shaped like the sample's: the batch, each file's hash, size and rows, and the labels. */
export function packageManifest(
  batch: TransferBatch,
  files: Readonly<Record<PackageFile, string>>,
  labels: readonly PackageLabel[],
): PackageManifest {
  const tape = parseCsv(files["boarding_tape.final.csv"]);
  const sum = (col: string) =>
    tape.reduce((s, r) => s + (r[col] ? cents(r[col]) : 0n), 0n).toString();
  const designed: Record<string, string[]> = {};
  for (const l of labels) (designed[l.loan] ??= []).push(l.defect_id);
  return {
    batch: {
      ...batch,
      loan_count: tape.length,
      upb_total: sum("upb"),
      escrow_total: sum("escrow_balance"),
    },
    generated_by:
      "packages/environments src/life/transfer-package.ts, over the life generator's histories",
    files: Object.fromEntries(
      PACKAGE_FILES.map((f) => [
        f,
        {
          sha256: sha(files[f]),
          row_count: rowsOf(files[f]),
          bytes: new TextEncoder().encode(files[f]).length,
        },
      ]),
    ),
    designed_outcomes: {
      hard: {},
      warnings: {},
      defects: designed,
      clean: tape.map((r) => r["transferor_loan_number"]!).filter((n) => !designed[n]),
    },
    labels,
  };
}
