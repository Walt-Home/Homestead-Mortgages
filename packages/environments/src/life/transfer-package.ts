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
 * What the sample does not carry:
 *   - the life-of-loan payment history. The sample carries 24 months; this
 *     carries every installment from the first, one row each with the day it
 *     was paid in full and the amount that paid it, read off the cashiering
 *     ledger (a receipt that paid two installments shows on both rows; a
 *     curtailment is no row). F-1-11 asks for "transaction and payment
 *     histories for the life of the mortgage loans" (spec 1-1 :32). After the
 *     layout's five columns each row carries how the prior servicer split the
 *     payment that paid it (`principal`, `interest`, `escrow`), as its
 *     transaction history does; the decoder reads the history's columns by
 *     name and ignores the rest;
 *   - a thirteenth file, `correspondence_file.csv`: the prior servicer's
 *     periodic statements, late-charge notices, escrow analysis statements,
 *     ARM change notices, calls and its notice of the transfer, and the
 *     documents of record it holds: the lender's mortgage-insurance
 *     disclosure, the life-of-loan flood determination, a repayment plan it
 *     agreed, the court's notice of a petition and its own notice of a
 *     servicemember's rate cap. The spec names the file among the inbound
 *     files (spec 1-1 :59), the servicing app's tape kinds include it
 *     (`TapeKind`, service.ts:22), and the decoder reads its twelve files by
 *     name and ignores any other, so it travels without changing what boards;
 *   - four tape columns the layout has no place for, after its own: the
 *     note's dollar cap on a late charge (`late_charge_max`; LAYOUT.md:65-66),
 *     the mortgage insurance's original value and automatic-termination date
 *     (`mi_original_value`, `mi_termination_date`) and the property's flood
 *     zone (`flood_zone`). The decoder never reads them, so a loan boarded
 *     from any tape, this one's included, boards none of the four.
 *
 * Defects are planted through the generator's twins. A defect that enters at
 * boarding leaves the prior servicer's months as they were, so its package is
 * the clean one but for what it plants: a tape cell (`DefectDefinition.package.cell`),
 * or a row of the payment history the loan never had (D-24). A defect in the
 * prior servicer's own books (D-25) is written from the twin's history, so its
 * package differs from the clean one wherever the books do. Either way the
 * writer labels what differs between the package and the clean twin's, cell by
 * cell: the planted cell is the root (`root_cause: true`), every other cell it
 * reached a symptom, and so is each cell a reviewer's checks flag because of
 * it (`package.flags`). A loan with no defect is a clean twin, the negative a
 * reviewer must pass.
 *
 * The manifest is shaped like the sample's (`manifest.json`): the batch, each
 * file's SHA-256, row count and size, and `designed_outcomes`. The sample's
 * designed outcomes are the gate's hard failures and warnings, each one a
 * defect a rule sees; a written package plants none, so both are empty, and
 * `defects` lists what is planted for the gate not to see. `labels` holds
 * each planted root and its symptoms in the generator's label shape.
 */

import { createHash } from "node:crypto";
import { addDays, addMonths, daysBetween, parts, type PlainDate } from "@hm/kernel/calendar";
import { cents, formatCents, ratePercent, type Cents } from "@hm/kernel/money";
import {
  encodeTransferBatch,
  parseCsv,
  toCsv,
  FINAL_TAPE_HEADER,
  PAYMENT_HISTORY_HEADER,
  type FairLendingRow,
  type ImageRow,
  type TransferBatchData,
  type TransferBatchFiles,
} from "../boarding/ported/tape-codec.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { buildSchedule, midpoint, scheduledDateForPct } from "../pmi/ported/schedule.js";
import type { FnmaPosition, MersRecord, StagedLoan } from "../pmi/ported/types.js";
import { rngFor } from "../rng.js";
import { defectById, type DefectLabel, type Handling } from "./defects.js";
import { floodZoneOf, type EscrowLine } from "./draw.js";
import { historyRows, miTerminationDate, type LoanLife } from "./simulate.js";

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

/** The tape's columns after the layout's own: the note's dollar cap on a late charge, the MI's original value and termination date, and the flood zone. */
export const CAP_COLUMN = "late_charge_max";
export const MI_VALUE_COLUMN = "mi_original_value";
export const MI_DATE_COLUMN = "mi_termination_date";
export const FLOOD_COLUMN = "flood_zone";
export const TAPE_EXTENSION = [CAP_COLUMN, MI_VALUE_COLUMN, MI_DATE_COLUMN, FLOOD_COLUMN] as const;
export const TAPE_HEADER: readonly string[] = [...FINAL_TAPE_HEADER, ...TAPE_EXTENSION];

/** The payment history's columns after the layout's own: how the prior servicer split the payment that paid each row. */
export const HISTORY_SPLIT = ["principal", "interest", "escrow"] as const;
export const HISTORY_HEADER: readonly string[] = [...PAYMENT_HISTORY_HEADER, ...HISTORY_SPLIT];

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
  "mi_disclosure",
  "flood_determination",
  "repayment_plan",
  "bankruptcy_notice",
  "scra_notice",
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

/** One loan in a package, and the defects planted in it (none for a clean twin). */
export interface PackageLoan {
  /** The loan's history: the twin's, when a defect is planted. */
  readonly life: LoanLife;
  readonly defects?: readonly string[];
  /**
   * The clean twin's history, which the labels are read against. A defect that enters at boarding leaves the prior
   * servicer's months as they were, so it may be left out; one in the prior servicer's own books (D-25) needs it.
   */
  readonly clean?: LoanLife;
}

/** A planted root or one of its symptoms, in the generator's label shape, with what a reviewer should do about it. */
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
  const history = historyRows(t);
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
  // A servicemember's capped loan: the tape carries the note's rate and P&I, and the cap is its flag and reason
  // (as the sample's SCRA loan does, demo-batch.ts:178); the history bills the capped payment.
  const scra = life.scra && life.scra.called_on < T ? life.scra : null;
  const bk = life.bankruptcy && life.bankruptcy.filed_on < T ? life.bankruptcy : null;
  return {
    transferor_loan_number: d.prior_servicer_loan_number,
    fnma_loan_number: d.fnma_loan_number,
    // The drawn MIN carries its Mod-10 check digit (draw.ts, `mersMin`), so HF-008 reads it as drawn.
    min: d.min,
    mers_eligible: true,
    remittance_type: "A/A",
    upb_cents: t.upb,
    next_due_date: t.next_due,
    note_rate_pct: scra ? d.note_rate_pct : t.rate_pct,
    pi_cents: scra ? d.initial_pi_cents : t.pi,
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
    bankruptcy: bk
      ? {
          active: true,
          chapter: bk.chapter,
          case_number: caseNumber(life),
          filed_on: bk.filed_on,
        }
      : { active: false },
    foreclosure: { active: false },
    lossmit: t.plan
      ? { in_process: true, application_status: "repayment_plan", received_on: t.plan.started_on }
      : { in_process: false },
    scra: scra
      ? {
          active: true,
          rate_cap_reason:
            scra.capped_pi === null
              ? `Active duty orders dated ${scra.called_on}; the note's rate is within the 6% cap`
              : `Active duty orders dated ${scra.called_on}; 6% cap applied ${scra.first_due}`,
        }
      : { active: false },
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
    installments: [...history.installments],
    payments: [...history.payments],
  };
}

/** The bankruptcy's case number: the filing year's two digits and five drawn from the loan's own stream. */
function caseNumber(life: LoanLife): string {
  const r = rngFor(`${life.loan_id}/package/bankruptcy`);
  return `${String(parts(life.bankruptcy!.filed_on).y).slice(2)}-${r.int(10000, 99999)}`;
}

/** The payment history, the layout's columns and the split of the payment that paid each row; with a phantom row first when one is planted (D-24). */
function paymentHistory(life: LoanLife, phantom: PlainDate | null): Record<string, string>[] {
  const t = life.at_transfer!;
  const split = new Map<PlainDate, { principal: Cents; interest: Cents; escrow: Cents }>();
  for (const r of life.receipts)
    if (r.credited_as_of < t.on) for (const x of r.installments) split.set(x.due, x);
  const rows = historyRows(t).rows.map((i) => {
    const s = i.paid_on ? split.get(i.due) : undefined;
    return {
      transferor_loan_number: life.draw.prior_servicer_loan_number,
      due_date: i.due,
      scheduled_amount: money(i.pi + i.escrow),
      received_on: i.paid_on ?? "",
      received_amount: i.paid_on ? money(i.pi + i.escrow) : "",
      principal: s ? money(s.principal) : "",
      interest: s ? money(s.interest) : "",
      escrow: s ? money(s.escrow) : "",
    };
  });
  if (phantom === null) return rows;
  return [
    {
      ...rows[0]!,
      due_date: phantom,
      received_on: "",
      received_amount: "",
      principal: "",
      interest: "",
      escrow: "",
    },
    ...rows,
  ];
}

type CorrespondenceRow = Record<(typeof CORRESPONDENCE_HEADER)[number], string>;

/** What the prior servicer sent and heard before the transfer date, and the documents of record it holds. */
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
  // The documents of record the prior servicer holds. The life-of-loan flood determination from the closing (the
  // Standard Flood Hazard Determination Form; 42 U.S.C. 4104b): `detail` is its FEMA zone.
  out.push(
    row({
      sent_on: d.note_date,
      kind: "flood_determination",
      direction: "inbound",
      detail: floodZoneOf(d),
    }),
  );
  // The lender's mortgage-insurance disclosure at consummation (12 U.S.C. 4903(a)(1)): the original value, the date
  // the borrower may ask to cancel (80 %) and the date the insurance ends on its own (78 %), from the initial
  // amortization schedule; the midpoint is the final termination (4902(c)).
  if (d.mi) {
    const s = buildSchedule({
      upb_cents: d.orig_upb_cents,
      annual_rate: ratePercent(d.note_rate_pct),
      term_months: d.term_months,
      first_due: d.first_due,
    });
    const at78 = miTerminationDate(d);
    const at80 = scheduledDateForPct(s, d.value_cents, 80)?.due_date ?? "";
    const mid = midpoint(d.first_due, d.term_months).midpoint_termination_date;
    out.push(
      row({
        sent_on: d.note_date,
        kind: "mi_disclosure",
        due_date: at78 ?? "",
        amount: money(d.value_cents),
        detail: `original value ${money(d.value_cents)}; cancellation may be requested from ${at80}; terminates automatically ${at78}; final termination ${mid}`,
      }),
    );
  }
  const t = life.at_transfer!;
  if (t.plan) {
    out.push(
      row({
        sent_on: t.plan.started_on,
        kind: "repayment_plan",
        amount: money(t.plan.arrears),
        detail: `repayment plan agreed: ${t.plan.months} monthly payments of the installment plus ${money(t.plan.share)} toward ${money(t.plan.arrears)} past due, from ${t.plan.started_on}; ${t.plan.paid} made`,
      }),
    );
  }
  if (life.bankruptcy && life.bankruptcy.filed_on < T) {
    const bk = life.bankruptcy;
    const noticed = addDays(bk.filed_on, 7);
    out.push(
      row({
        sent_on: noticed < T ? noticed : addDays(T, -1),
        kind: "bankruptcy_notice",
        direction: "inbound",
        detail: `notice of a Chapter ${bk.chapter} petition filed ${bk.filed_on}, case ${caseNumber(life)}`,
      }),
    );
  }
  if (life.scra && life.scra.called_on < T) {
    const s = life.scra;
    const sent = addDays(s.called_on, 10);
    out.push(
      row({
        sent_on: sent < T ? sent : addDays(T, -1),
        kind: "scra_notice",
        due_date: s.first_due,
        pi: s.capped_pi === null ? "" : money(s.capped_pi),
        amount: s.capped_pi === null ? "" : money(s.capped_pi),
        detail:
          s.capped_pi === null
            ? `active-duty orders dated ${s.called_on}: no late charge from the ${s.first_due} installment; the note's rate is not above 6%`
            : `active-duty orders dated ${s.called_on}: interest capped at 6% and no late charge from the ${s.first_due} installment; P&I ${money(s.capped_pi)}`,
      }),
    );
  }
  return out.sort((a, b) =>
    a.sent_on !== b.sent_on
      ? a.sent_on < b.sent_on
        ? -1
        : 1
      : CORRESPONDENCE_KINDS.indexOf(a.kind as (typeof CORRESPONDENCE_KINDS)[number]) -
        CORRESPONDENCE_KINDS.indexOf(b.kind as (typeof CORRESPONDENCE_KINDS)[number]),
  );
}

/** The tape's extension cells for one loan, as its note and its documents of record give them. */
function extensionCells(life: LoanLife): Record<(typeof TAPE_EXTENSION)[number], string> {
  const d = life.draw;
  const mi = life.at_transfer!.mi_active;
  return {
    [CAP_COLUMN]: money(d.late_charge.cap_cents),
    [MI_VALUE_COLUMN]: mi ? money(d.value_cents) : "",
    [MI_DATE_COLUMN]: mi ? (miTerminationDate(d) ?? "") : "",
    [FLOOD_COLUMN]: floodZoneOf(d),
  };
}

interface Written {
  readonly files: Record<PackageFile, string>;
  readonly staged: StagedLoan[];
}

/** Write the package's files for loans and the defects planted in each (none, for the clean twins' package). */
function writeFiles(
  loans: readonly { readonly life: LoanLife; readonly defects: readonly string[] }[],
  b: TransferBatch,
): Written {
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
      age: String(
        (daysBetween(l.life.draw.parties[0]!.date_of_birth, b.transfer_date) / 365.25) | 0,
      ),
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

  // The tape again, with the extension columns after the layout's own, and each planted cell in place of the true one.
  const tape = parseCsv(encoded["boarding_tape.final.csv"]).map((row, k) => {
    const l = loans[k]!;
    const d = l.life.draw;
    const out: Record<string, string> = { ...row, ...extensionCells(l.life) };
    for (const id of l.defects) {
      const def = defectById(id);
      const p = def.package;
      if (!p) throw new RangeError(`${id} has no place in a transfer package`);
      if (!def.eligible(d)) throw new RangeError(`${id} cannot be planted on ${l.life.loan_id}`);
      if (!p.cell) continue;
      if (p.file !== "boarding_tape.final.csv")
        throw new RangeError(`${id} sits in ${p.file}, which this writer does not plant a cell in`);
      if (out[p.field] !== p.cell.trueCell(d))
        throw new RangeError(
          `${id}: ${p.field} on ${row["transferor_loan_number"]} is ${JSON.stringify(out[p.field])}, not the true ${JSON.stringify(p.cell.trueCell(d))}`,
        );
      out[p.field] = p.cell.plantedCell(d);
    }
    return out;
  });
  // The history: a phantom row first on a loan D-24 is planted on, read off the twin's boarding.
  const history = loans.flatMap((l) => {
    const phantom = l.defects.includes("D-24") ? l.life.boarded.terms.phantom_installment : null;
    if (l.defects.includes("D-24") && phantom === null)
      throw new RangeError(`D-24 on ${l.life.loan_id}: the history given is not its twin's`);
    if (l.defects.includes("D-25") && !l.life.history_plant)
      throw new RangeError(`D-25 on ${l.life.loan_id}: the history given is not its twin's`);
    return paymentHistory(l.life, phantom);
  });
  const files: Record<PackageFile, string> = {
    ...encoded,
    "boarding_tape.final.csv": toCsv(TAPE_HEADER, tape),
    "payment_history.csv": toCsv(HISTORY_HEADER, history),
    [CORRESPONDENCE_FILE]: toCsv(
      CORRESPONDENCE_HEADER,
      loans.flatMap((l) => correspondence(l.life, b)),
    ),
  };
  const ordered = Object.fromEntries(PACKAGE_FILES.map((f) => [f, files[f]])) as Record<
    PackageFile,
    string
  >;
  return { files: ordered, staged };
}

/* ── rows and cells ──────────────────────────────────────────────────────── */

type CsvRow = Record<string, string>;

/** A row's key within its loan's rows of a file: the loan for a file of one row per loan, the row's own key otherwise. */
export const ROW_KEY: Readonly<Partial<Record<PackageFile, (r: CsvRow) => string>>> = {
  "payment_history.csv": (r) => r["due_date"]!,
  "escrow_history.csv": (r) => r["line_type"]!,
  "images_manifest.csv": (r) => r["document_type"]!,
  [CORRESPONDENCE_FILE]: (r) => `${r["sent_on"]} ${r["kind"]}`,
};

/** A loan's rows of a file, each with its key (a second row under one key is `key#1`). */
export function packageRows(
  files: Readonly<Record<PackageFile, string>>,
  file: PackageFile,
  loan: string,
): { readonly key: string; readonly row: CsvRow }[] {
  const tape = parseCsv(files["boarding_tape.final.csv"]).find(
    (r) => r["transferor_loan_number"] === loan,
  );
  const match =
    file === "fnma_position.csv"
      ? (r: CsvRow) => r["fnma_loan_number"] === tape?.["fnma_loan_number"]
      : file === "mers_lookup.csv"
        ? (r: CsvRow) => r["min"] === tape?.["min"]
        : (r: CsvRow) => r["transferor_loan_number"] === loan;
  const keyOf = ROW_KEY[file] ?? (() => loan);
  const seen = new Map<string, number>();
  return parseCsv(files[file])
    .filter(match)
    .map((row) => {
      const k = keyOf(row);
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return { key: n === 0 ? k : `${k}#${n}`, row };
    });
}

interface Cell {
  readonly file: PackageFile;
  readonly row: string;
  readonly field: string;
  readonly clean: string | null;
  readonly planted: string | null;
}

/** Every cell of `loan`'s rows that differs between two packages; a row only one has is one cell, its key's column. */
function cellDifferences(
  clean: Readonly<Record<PackageFile, string>>,
  planted: Readonly<Record<PackageFile, string>>,
  loan: string,
): Cell[] {
  const out: Cell[] = [];
  for (const file of PACKAGE_FILES) {
    if (clean[file] === planted[file]) continue;
    const a = new Map(packageRows(clean, file, loan).map((x) => [x.key, x.row]));
    const b = new Map(packageRows(planted, file, loan).map((x) => [x.key, x.row]));
    const keyColumn = file === "payment_history.csv" ? "due_date" : "*";
    for (const key of [...new Set([...a.keys(), ...b.keys()])]) {
      const ra = a.get(key);
      const rb = b.get(key);
      if (!ra || !rb) {
        out.push({
          file,
          row: key,
          field: keyColumn,
          clean: ra ? (ra[keyColumn] ?? key) : null,
          planted: rb ? (rb[keyColumn] ?? key) : null,
        });
        continue;
      }
      for (const field of Object.keys(rb))
        if (ra[field] !== rb[field])
          out.push({ file, row: key, field, clean: ra[field] ?? null, planted: rb[field] ?? null });
    }
  }
  return out;
}

/**
 * The package for a batch of loans the generator boarded by transfer on one
 * date, each with the defects planted in it.
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
  const planted = loans.map((l) => ({
    life: l.life,
    defects: [...new Set(l.defects ?? [])].sort(),
  }));
  const written = writeFiles(planted, b);
  if (planted.every((l) => l.defects.length === 0))
    return {
      batch: b,
      files: written.files,
      loans: written.staged,
      manifest: packageManifest(b, written.files, []),
    };

  // The clean twins' package, which every label is read against.
  const cleanWritten = writeFiles(
    loans.map((l, k) => {
      const early = planted[k]!.defects.filter((id) => defectById(id).priorHistory);
      if (early.length && !l.clean)
        throw new RangeError(
          `${early.join(", ")} on ${l.life.loan_id} changes the prior servicer's books: the package needs the clean twin's history to label it`,
        );
      return { life: l.clean ?? l.life, defects: [] };
    }),
    b,
  );
  if (toCsvKeys(cleanWritten.files) !== toCsvKeys(written.files))
    throw new RangeError("the clean twin's package holds other loans");

  const labels: PackageLabel[] = [];
  planted.forEach((l, k) => {
    if (l.defects.length === 0) return;
    const n = written.staged[k]!.transferor_loan_number;
    const defs = l.defects.map(defectById);
    const label = (
      def: (typeof defs)[number],
      c: Pick<Cell, "file" | "row" | "field" | "clean" | "planted">,
      root: boolean,
      id = def.id,
    ): PackageLabel => {
      const p = def.package!;
      return {
        loan: n,
        defect_id: id,
        file_or_table: c.file,
        field: c.field,
        row: c.row,
        on: b.transfer_date,
        true_value: c.clean,
        planted_value: c.planted,
        expected_handling: root
          ? def.handling
          : `A symptom of ${def.id}: ${def.symptomHandling(c.file, c.field, c.row)}`,
        root_cause: root,
        produces: def.produces,
        handling: p.handling,
        also_accepted: p.also_accepted,
        why: root
          ? p.why
          : `This cell follows from ${def.id}'s root, ${p.file} ${p.field}: ${p.why}`,
        evidence: p.evidence,
        gate: p.gate,
      };
    };
    // The roots: each defect's own cell.
    const roots = defs.map((def) => {
      const p = def.package!;
      return {
        def,
        file: p.file as PackageFile,
        row: p.cell ? n : p.row!(l.life),
        field: p.field,
      };
    });
    const isRoot = (c: Cell) =>
      roots.find((r) => r.file === c.file && r.row === c.row && r.field === c.field);
    const diffs = cellDifferences(cleanWritten.files, written.files, n);
    for (const r of roots)
      if (!diffs.some((c) => isRoot(c)?.def === r.def))
        throw new RangeError(
          `${r.def.id} on ${n}: its root ${r.file} ${r.field} ${r.row} is the clean twin's`,
        );
    for (const c of diffs) {
      const root = isRoot(c);
      if (root) {
        labels.push(label(root.def, c, true));
        continue;
      }
      if (defs.length === 1) labels.push(label(defs[0]!, c, false));
      else labels.push(label(defs[0]!, c, false, defs.map((x) => x.id).join("+")));
    }
    // The cells a reviewer's checks flag because of a root, though each holds what it should.
    const tapeRow = parseCsv(written.files["boarding_tape.final.csv"]).find(
      (r) => r["transferor_loan_number"] === n,
    )!;
    for (const def of defs)
      for (const field of def.package!.flags)
        if (
          !labels.some(
            (x) =>
              x.file_or_table === "boarding_tape.final.csv" && x.field === field && x.loan === n,
          )
        )
          labels.push(
            label(
              def,
              {
                file: "boarding_tape.final.csv",
                row: n,
                field,
                clean: tapeRow[field] ?? "",
                planted: tapeRow[field] ?? "",
              },
              false,
            ),
          );
  });
  // Roots first, by loan and defect, then each loan's symptoms.
  labels.sort((x, y) =>
    x.root_cause !== y.root_cause
      ? x.root_cause
        ? -1
        : 1
      : x.loan !== y.loan
        ? x.loan < y.loan
          ? -1
          : 1
        : x.defect_id < y.defect_id
          ? -1
          : x.defect_id > y.defect_id
            ? 1
            : 0,
  );
  return {
    batch: b,
    files: written.files,
    loans: cleanWritten.staged,
    manifest: packageManifest(b, written.files, labels),
  };
}

/** The loans a package's tape holds, in its order. */
const toCsvKeys = (files: Readonly<Record<PackageFile, string>>) =>
  parseCsv(files["boarding_tape.final.csv"])
    .map((r) => r["transferor_loan_number"])
    .join(",");

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
  for (const l of labels) if (l.root_cause) (designed[l.loan] ??= []).push(l.defect_id);
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
