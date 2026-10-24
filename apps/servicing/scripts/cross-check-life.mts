/**
 * Cross-check the life generator (packages/environments/src/life) against the
 * servicing app's own code, loan by loan and month by month.
 *
 *   npx tsx apps/servicing/scripts/cross-check-life.mts run --db hm_xcheck_a1 --seed 1 --loans 8 --months 24 \
 *       --boarding origination --out a1.json
 *   npx tsx apps/servicing/scripts/cross-check-life.mts report --out report.json a1.json a2.json …
 *   npx tsx apps/servicing/scripts/cross-check-life.mts loan a1.json <loan id> [from] [to]
 *
 * `run` draws a book from the generator, then for each loan:
 *   - boards it in the servicing app through the transfer route (`boardTransferBatch`, the route harness-35-5's
 *     `boardTapeLoan` takes), on the day it reaches us: its note date when it is ours from the first payment, or the
 *     generator's transfer date, with the tape cut from the generator's month-end before it;
 *   - adds what boarding never writes and the comparison needs, each named in the output's `workarounds`: the P&I and
 *     T&I custodial accounts (boarding-4), a borrower party (boarding-2, so a Metro 2 record can be built), the note's
 *     dollar late-charge cap (the tape has no column for it: docs/synthetic-data-defects.md D-03), and each escrow
 *     analysis's new escrow payment on the schedule's due rows (the analysis cycle has no runner, cycles.ts:285);
 *   - replays the borrower's receipts on their dates through the cash-rows port (the fact 2.1 rule 1 records);
 *   - steps the per-loan cycles each day at noon Eastern, the instant the demo clock's day step uses: the cashiering
 *     unit (35.5 rule 6), the delinquency counters, and on the 1st the monthly Metro 2 unit, inside a
 *     `cycles.run_unit`-shaped command, the path the speed measurement of 22 October 2026 stepped;
 *   - and compares, per loan per month: installments (status, satisfied and credited dates), the interest,
 *     principal and escrow split of each receipt, late charges assessed and owed, suspense, the balance, and the
 *     Metro 2 Base segment the servicing app builds from its own rows (`metro2RecordsFromTypedRows`).
 *
 * Nothing in the vendored tree is edited; its code is imported by path. Every database it touches is a scratch copy
 * named hm_xcheck_<short>, cloned from a template migrated with `node scripts/run.mjs db-setup`
 * (SERVICING_DATABASE_URL=…/hm_xcheck_tpl). `report` regenerates each run's book, reads its database back and
 * triages every disagreement; `loan` prints one loan from both sides. See docs/cross-check.md.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import pg from "pg";

import { connect } from "../src/infra/db/client.ts";
import { loadOverriddenRegistry } from "../src/domain/timer-overrides.ts";
import { FixedClock } from "../src/kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../src/kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../src/kernel/calendar/zoned.ts";
import { Runtime } from "../src/runtime/app.ts";
import { registerReprojectionReactor } from "../src/domain/operations-runtime/installments.ts";
import { boardTransferBatch, DEFAULT_LICENSED_STATES } from "../src/runtime/transfers.ts";
import { encodeTransferBatch, type TransferBatchData } from "../src/domain/boarding/tape-codec.ts";
import type { StagedLoan } from "../src/domain/boarding/types.ts";
import { PARTNER_ORG, TRANSFEROR_ORG } from "../src/domain/boarding/fixtures.ts";
import { isValidMin, makeMin } from "../src/domain/boarding/min.ts";
import {
  runCashieringUnit,
  etDate,
  loanCashStateFromRows,
} from "../src/domain/operations-runtime/cashiering-cycle.ts";
import { delinquencyDailySweep } from "../src/runtime/delinquency.ts";
import {
  metro2MonthlyRunner,
  metro2RecordsFromTypedRows,
} from "../src/domain/operations-runtime/runners.ts";
import { periodEndOf } from "../src/domain/operations-runtime/cycles.ts";
import {
  linkBorrowerParty,
  seedCustodial,
  writePayment,
  PARTNER_SERVICER_NUMBER,
  TRANSFEROR_SERVICER_NUMBER,
} from "../src/domain/operations-runtime/harness-35-5.ts";
import { renderBase } from "../src/domain/credit-reporting/metro2.ts";
import { PgEntityRepository } from "../src/infra/db/entities.ts";
import { EntityStore } from "../src/app/tools.ts";

import { generate, LIFE_VERSION } from "../../../packages/environments/src/life/index.ts";
import type {
  LoanLife,
  ReceiptRow,
  AnalysisRow,
  MonthEnd,
  ScenarioEvent,
} from "../../../packages/environments/src/life/index.ts";

type Cents = bigint;
type Row = Record<string, unknown>;
const BASE_URL = "postgresql://homestead_mortgages:homestead_mortgages@localhost:5433";
const SCRATCH = /^hm_xcheck_[a-z0-9_]+$/;

// ---------------------------------------------------------------- arguments
const [mode = "", ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), rest[++i] ?? "");
  else positional.push(a);
}
const loadavg = (): number[] => os.loadavg().map((x) => Math.round(x * 100) / 100);
const jsonOut = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
const endOfMonth = (d: PlainDate): PlainDate => addDays(addMonths(D(`${d.slice(0, 7)}-01`), 1), -1);
const monthsBetween = (a: PlainDate, b: PlainDate): number =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 +
  (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
const noonET = (d: PlainDate): string => toIso(zonedEpochMs(d, "12:00", "America/New_York"));
const c = (v: unknown): Cents =>
  typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v));

// ================================================================= run
interface Track {
  readonly life: LoanLife;
  readonly index: number;
  /** The day the loan reaches the servicing app, and the last day compared (a month-end). */
  readonly board: PlainDate;
  /** Moved back to the last month read when a run reaches its deadline. */
  end: PlainDate;
  readonly transfer: boolean;
  loanId: string | null;
  partner: string | null;
  boardError: string | null;
  readonly payIds: Map<string, string>;
  readonly receipts: Map<PlainDate, ReceiptRow[]>;
  readonly analysisDays: Set<PlainDate>;
  readonly ledgerEscrow: Map<PlainDate, Cents>;
  readonly months: Map<string, ServicingMonth>;
  readonly unitErrors: { date: PlainDate; error_class: string | null; error: string | null }[];
  escrowSyncs: number;
  minRepaired: boolean;
}
interface ServicingMonth {
  readonly upb: Cents;
  readonly suspense: Cents;
  readonly late_charges_due_state: Cents;
  readonly late_charges_ledger: Cents;
  readonly metro2: Record<string, string> | null;
  readonly metro2_errors: readonly string[];
  readonly metro2_omitted: string | null;
}

async function run(): Promise<void> {
  const DB = args.get("db") ?? "";
  const TEMPLATE = args.get("template") ?? "hm_xcheck_tpl";
  if (!SCRATCH.test(DB) || !SCRATCH.test(TEMPLATE) || DB === TEMPLATE)
    throw new Error(
      "--db and --template must be distinct scratch databases named hm_xcheck_<short>",
    );
  const SEED = args.get("seed") ?? "1";
  const NLOANS = Number(args.get("loans") ?? "1");
  const WINDOW = Number(args.get("months") ?? "12");
  const BOARDING = (args.get("boarding") ?? "origination") as "origination" | "book";
  const START = args.get("start") ?? "2026-03-01";
  const COHORT = Number(args.get("cohort") ?? "12");
  const OUT = args.get("out") ?? `${DB}.json`;
  const LABEL = args.get("label") ?? DB;
  const SKIP_DELINQUENCY = args.get("delinquency") === "off";
  const DEADLINE_S = Number(args.get("deadline") ?? "0");
  const EVENTS = args.get("events") !== "off";
  let stoppedAt: PlainDate | null = null;

  // A fresh scratch database cloned from the migrated template.
  const admin = new pg.Client({ connectionString: `${BASE_URL}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB} TEMPLATE ${TEMPLATE}`);
  await admin.end();

  const tGen = performance.now();
  const { life, months } = drawBook({
    seed: SEED,
    loans: NLOANS,
    window: WINDOW,
    boarding: BOARDING,
    start: START,
    cohort: COHORT,
    events: EVENTS,
  });
  const genMs = performance.now() - tGen;

  const tracks: Track[] = [];
  const skipped: { index: number; loan: string; reason: string }[] = [];
  for (const [index, l] of life.clean.loans.entries()) {
    const windowEnd = endOfMonth(addMonths(l.draw.first_due, months - 1));
    const transfer = l.transfer_in_on !== null;
    const board = l.transfer_in_on ?? l.draw.note_date;
    if (board > addMonths(windowEnd, -1)) {
      skipped.push({ index, loan: l.loan_id, reason: `reaches us ${board}, after its window` });
      continue;
    }
    const end0 = endOfMonth(addMonths(transfer ? board : l.draw.first_due, WINDOW - 1));
    const end = end0 < windowEnd ? end0 : windowEnd;
    if (!l.invariants.ok)
      skipped.push({
        index,
        loan: l.loan_id,
        reason: `generator invariants: ${l.invariants.notes.join("; ")}`,
      });
    const receipts = new Map<PlainDate, ReceiptRow[]>();
    for (const r of l.receipts)
      if (r.servicer === "us" && r.on >= board && r.on <= end && r.mode !== "payoff")
        receipts.set(r.on, [...(receipts.get(r.on) ?? []), r]);
    tracks.push({
      life: l,
      index,
      board,
      end,
      transfer,
      loanId: null,
      partner: null,
      boardError: null,
      payIds: new Map(),
      receipts,
      analysisDays: new Set(
        l.analyses.filter((a) => a.as_of > board && a.as_of <= end).map((a) => a.as_of),
      ),
      ledgerEscrow: new Map(l.installments.map((i) => [i.due, i.escrow])),
      months: new Map(),
      unitErrors: [],
      escrowSyncs: 0,
      minRepaired: false,
    });
  }

  // ---------------------------------------------------------------- the runtime, as lifecycle.test.ts and main.ts build it
  const url = `${BASE_URL}/${DB}`;
  const db = connect(url);
  const clock = new FixedClock(`${tracks[0]?.board ?? START}T14:00:00.000Z`);
  const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, environment: "nonprod" });
  registerReprojectionReactor(rt);
  const CREDIT = { kind: "agent", id: "credit-reporting" } as const;
  const q = <T extends Row>(sql: string, p: unknown[] = []): Promise<T[]> => db.query<T>(sql, p);

  // ---------------------------------------------------------------- boarding
  const lateCapApplied: string[] = [];
  async function boardOne(t: Track): Promise<void> {
    const l = t.life;
    const d = l.draw;
    const prev = t.transfer
      ? l.months.find((m) => m.month === addMonths(t.board, -1).slice(0, 7))
      : undefined;
    if (t.transfer && !prev)
      throw new Error(`${l.loan_id}: no month-end before the transfer ${t.board}`);
    // A month-end with nothing open (the next installment paid ahead) has no next due; the tape's is the one after the LPI.
    const nextDue = prev
      ? (prev.next_due ?? (prev.lpi ? addMonths(D(prev.lpi), 1) : t.board))
      : d.first_due;
    const upb = prev ? prev.upb : d.orig_upb_cents;
    const escrowPayment = d.escrowed ? (escrowAt(t, t.board, nextDue) ?? 0n) : 0n;
    const escrowBalance = prev ? prev.escrow_balance : escrowInitial(l);
    const pi = prev ? prev.pi : d.initial_pi_cents;
    // The prior servicer's last twelve installments and what was received for them (hashed and counted at boarding).
    const histInst = l.installments.filter(
      (i) => i.due < nextDue && i.due >= addMonths(nextDue, -12),
    );
    const histPay = l.receipts.filter((r) => r.on < t.board && r.on >= addMonths(nextDue, -13));
    const lines = l.lines.map((x) => {
      const nextBill = x.bills.find((b) => b.on >= t.board);
      const year = x.bills.filter((b) => b.on >= t.board && b.on < addMonths(t.board, 12));
      return {
        line_type: LINE_TYPES[x.line_type] ?? x.line_type,
        annual_amount_cents: year.reduce((s, b) => s + b.amount, 0n),
        ...(nextBill ? { next_due_date: D(nextBill.on) } : {}),
      };
    });
    const hazardNext =
      l.lines.find((x) => x.basis === "hazard")?.bills.find((b) => b.on >= t.board)?.on ?? null;
    const lastAnalysis = l.analyses.filter((a) => a.as_of < t.board).at(-1)?.as_of ?? null;
    const p0 = d.parties[0]!;
    const n = `${l.loan_id}`;
    // Boarding refuses a MIN that fails Mod-10 (HF-008). Life 1.0.0 drew the check digit at random; since life 1.2.0 the
    // generator computes it (draw.ts, `mersMin`), and this repairs nothing.
    const min = isValidMin(d.min) ? d.min : makeMin(d.min.slice(0, 7), d.min.slice(7, 17));
    if (min !== d.min) t.minRepaired = true;
    const loan: StagedLoan = {
      transferor_loan_number: n,
      fnma_loan_number: d.fnma_loan_number,
      min,
      mers_eligible: true,
      remittance_type: "A/A",
      upb_cents: upb,
      next_due_date: D(nextDue),
      note_rate_pct: Number(d.note_rate_pct).toFixed(3),
      pi_cents: pi,
      escrow_payment_cents: escrowPayment,
      maturity_date: D(d.maturity),
      original_term_months: d.term_months,
      original_upb_cents: d.orig_upb_cents,
      instrument_date: D(d.note_date),
      origination_date: D(d.note_date),
      first_payment_date: D(d.first_due),
      interest_method: "30_360",
      amortization: "fixed",
      escrowed: d.escrowed,
      escrow_balance_cents: d.escrowed ? escrowBalance : 0n,
      escrow_lines: d.escrowed ? lines : [],
      escrow_sign_consistent: true,
      last_escrow_analysis_date: lastAnalysis ? D(lastAnalysis) : null,
      late_charge_pct: Number(d.late_charge.pct).toFixed(3),
      late_charge_grace_days: d.late_charge.grace_days,
      deferred_principal_cents: 0n,
      forborne_principal_cents: 0n,
      nib_separated: true,
      bankruptcy: { active: false },
      foreclosure: { active: false },
      lossmit: { in_process: false },
      scra: { active: false },
      borrower: {
        legal_name: `${p0.given_name} ${p0.surname}`,
        tin: "000-12-3456",
        phone: "+16025550100",
        email: `${n.toLowerCase()}@example.test`,
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
      hazard_policy_expires: hazardNext ? D(hazardNext) : addDays(t.board, 300),
      mi: { flag: false },
      flood_determination_life_of_loan: true,
      sii: { present: false, complete: true },
      unapplied_cents: prev ? prev.suspense : 0n,
      fair_lending_present: true,
      acp_enrolled: false,
      fees_advances_cents: 0n,
      fees_itemized: true,
      corporate_advances_cents: 0n,
      late_charges_due_cents: prev ? prev.late_charges_due : 0n,
      mers_investor_is_fnma: true,
      installments: histInst.map((i) => ({ due_date: D(i.due), amount_cents: i.pi + i.escrow })),
      payments: histPay.map((r) => ({ received_on: D(r.on), amount_cents: r.amount })),
    };
    const data: TransferBatchData = {
      loans: [loan],
      fnma: [
        {
          fnma_loan_number: d.fnma_loan_number,
          on_approved_list: true,
          remittance_type: "A/A",
          upb_cents: upb,
        },
      ],
      trialBalance: [
        { transferor_loan_number: n, fnma_loan_number: d.fnma_loan_number, upb_cents: upb },
      ],
      mers: [
        { min, status: "Active", servicer_org_id: TRANSFEROR_ORG, investor_org_id: "1000001" },
      ],
      images: [
        {
          transferor_loan_number: n,
          document_type: "note",
          filename: `${n}_note.pdf`,
          sha256: "a".repeat(64),
        },
      ],
      fairLending: [
        {
          transferor_loan_number: n,
          ethnicity: "Not provided",
          race: "Not provided",
          sex: "Not provided",
          age: "40",
          preferred_language: "en",
        },
      ],
    };
    clock.set(`${t.board}T14:00:00.000Z`);
    const summary = await boardTransferBatch(
      rt,
      {
        batch_id: `XC-${l.loan_id}`,
        transfer_date: D(t.board),
        transferor_name: "Fixture Transferor LLC",
        transferor_servicer_number: TRANSFEROR_SERVICER_NUMBER,
        partner_servicer_number: PARTNER_SERVICER_NUMBER,
        transferor_mers_org_id: TRANSFEROR_ORG,
        partner_mers_org_id: PARTNER_ORG,
        // The generator's sixteen states; the shop's default license list leaves out MI, VA and MA (HF-020).
        licensed_states: [...DEFAULT_LICENSED_STATES, "MI", "VA", "MA"],
      },
      encodeTransferBatch(data),
      { kind: "system", id: "cross-check-life" },
      { synthetic: true },
    );
    const id = summary.loan_ids[n];
    if (summary.status !== "boarded" || !id)
      throw new Error(
        `did not board: ${JSON.stringify(summary.hard_by_loan[n] ?? summary.hard_by_loan)}`,
      );
    t.loanId = id;
    t.partner = (
      await q<{ p: string }>(`SELECT partner_party_id::text AS p FROM loans WHERE id = $1`, [id])
    )[0]!.p;
    // boarding-4: the P&I and T&I custodial accounts a transfer board never opens (only `clearing`).
    await seedCustodial(db, t.partner);
    // boarding-2: the borrower party the Metro 2 builder reads (`borrowers.party_id`).
    await linkBorrowerParty(db, id, `${n.toLowerCase()}@example.test`);
    // D-03: the tape has no column for the note's dollar late-charge cap, so `loan_terms.late_charge_max_cents` stays null.
    if (d.late_charge.cap_cents !== null) {
      await q(`UPDATE loan_terms SET late_charge_max_cents = $2 WHERE loan_id = $1`, [
        id,
        d.late_charge.cap_cents,
      ]);
      lateCapApplied.push(l.loan_id);
    }
    await syncEscrow(t, t.board);
  }

  /** The escrow payment the generator charges for `due`, as it stood on day `on` (null: not yet scheduled then). */
  function escrowAt(t: Track, on: PlainDate, due: PlainDate): Cents | null {
    const l = t.life;
    if (!l.draw.escrowed) return 0n;
    const known = l.analyses.filter((a) => a.as_of <= on && a.effective <= due);
    const k = known.at(-1);
    if (!k)
      return due < addMonths(l.draw.first_due, 24)
        ? (t.ledgerEscrow.get(l.draw.first_due) ?? null)
        : null;
    return analysisEscrow(t, k, l.analyses.find((a) => a.as_of > on) ?? null, due);
  }
  function analysisEscrow(
    t: Track,
    k: AnalysisRow,
    next: AnalysisRow | null,
    due: PlainDate,
  ): Cents | null {
    const off = monthsBetween(k.effective, due);
    if (off === 0) return k.first_month_payment;
    if (off <= 10) return k.new_payment;
    if (off === 11)
      return next && due >= next.effective
        ? k.new_payment
        : (t.ledgerEscrow.get(due) ?? k.new_payment);
    if (off < 24) return k.base_payment;
    return null;
  }
  /** Write the generator's escrow payment onto every due row whose figure the latest analysis known on `on` set. */
  async function syncEscrow(t: Track, on: PlainDate): Promise<void> {
    if (!t.loanId || !t.life.draw.escrowed) return;
    const rows = await q<{ due: string; e: string }>(
      `SELECT due_date::text AS due, escrow_cents::text AS e FROM loan_installments WHERE loan_id = $1 AND status = 'due' AND due_date <= $2::date ORDER BY due_date`,
      [t.loanId, addMonths(on, 26)],
    );
    const dues: string[] = [];
    const amts: string[] = [];
    for (const r of rows) {
      const want = escrowAt(t, on, D(r.due));
      if (want !== null && want !== c(r.e)) {
        dues.push(r.due);
        amts.push(want.toString());
      }
    }
    if (!dues.length) return;
    await q(
      `UPDATE loan_installments i SET escrow_cents = u.amt FROM unnest($2::date[], $3::bigint[]) AS u(due, amt) WHERE i.loan_id = $1 AND i.due_date = u.due AND i.status = 'due'`,
      [t.loanId, dues, amts],
    );
    t.escrowSyncs += dues.length;
  }

  // ---------------------------------------------------------------- the per-loan cycles
  const metro2Runs: Record<string, unknown>[] = [];
  async function metro2Unit(periodKey: string, nowIso: string): Promise<Record<string, unknown>> {
    const jobId = randomUUID();
    const runId = randomUUID();
    const periodEnd = periodEndOf({ period_grammar: "month" }, periodKey);
    const unit = {
      job_id: jobId,
      run_id: runId,
      cycle_code: "metro2_monthly",
      period_key: periodKey,
      period_end: periodEnd,
      unit_id: periodKey,
      loan_id: null,
      application_id: null,
      as_of_date: periodEnd,
      input: { period_end: periodEnd, period_key: periodKey },
      actor: CREDIT,
      attempt: 1,
    };
    const def = {
      name: "cycles.run_unit",
      process: "35.3",
      agent: "credit-reporting",
      kind: "act",
      ruleSetVersion: "cycles.v1",
      humanRoles: ["ops_analyst"],
      decision: () => null,
      handler: async (_i: unknown, ctx: { actor: unknown }, toolRt: unknown) =>
        (
          metro2MonthlyRunner.runner as unknown as {
            run: (a: unknown, b: unknown, u: unknown) => Promise<unknown>;
          }
        ).run(toolRt, ctx, {
          ...unit,
          actor: ctx.actor,
        }),
    };
    clock.set(nowIso);
    const r = await rt.executeDef(
      def as never,
      {
        loanId: "",
        actor: CREDIT,
        input: {
          job_id: jobId,
          run_id: runId,
          cycle_code: "metro2_monthly",
          period_key: periodKey,
          unit_id: periodKey,
        },
        run: {
          runId: jobId,
          modelVersion: "deterministic",
          promptVersion: "35.3-v1",
          confidence: 1,
        },
      } as never,
    );
    const o = r.output as Row;
    const omitted = (o.omitted as { loan_id: string; reason: string }[]) ?? [];
    const reasons: Record<string, number> = {};
    for (const x of omitted) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
    return {
      period: periodKey,
      outcome: o.outcome,
      record_count: o.record_count,
      exceptions: o.exceptions,
      omitted: reasons,
    };
  }

  /** The month-end of `asOf` as the servicing app's own rows give it, read on the 1st after the day's units. */
  async function monthEnd(active: Track[], asOf: PlainDate): Promise<void> {
    const typed = await metro2RecordsFromTypedRows(rt, asOf);
    const snaps = new Map(typed.records.map((r) => [r.snapshot.loan_id, r.snapshot]));
    const omitted = new Map(typed.omitted.map((o) => [o.loan_id, o.reason]));
    for (const t of active) {
      const id = t.loanId!;
      const facts = await loanCashStateFromRows(db, id, asOf);
      const snap = snaps.get(id);
      t.months.set(asOf.slice(0, 7), {
        upb: facts.state.upb_cents,
        suspense: facts.state.suspense_unapplied_cents,
        late_charges_due_state: facts.state.late_charges_due_cents,
        // `balancesOf` negates every loan account but principal; the late-charge receivable is a debit, so its owed figure is the negation.
        late_charges_ledger: -facts.balances.late_charges,
        metro2: snap ? renderBase(snap) : null,
        metro2_errors: snap ? validateErrors(snap) : [],
        metro2_omitted: omitted.get(id) ?? null,
      });
    }
  }

  // ---------------------------------------------------------------- the day loop
  const first = tracks.map((t) => t.board).sort()[0];
  const last = tracks
    .map((t) => t.end)
    .sort()
    .at(-1);
  if (!first || !last) throw new Error("no loan to step");
  const result: Record<string, unknown> = {
    label: LABEL,
    db: DB,
    life_version: LIFE_VERSION,
    seed: SEED,
    boarding: BOARDING,
    loans_requested: NLOANS,
    window_months: WINDOW,
    start: START,
    cohort_months: COHORT,
    generator_ms: Math.round(genMs),
    events: EVENTS ? "by index modulo 8 (scriptedEvents)" : "none",
    node: process.version,
    host_cpus: os.cpus().length,
    started_at: new Date().toISOString(),
    loadavg_start: loadavg(),
  };
  const loadSamples: {
    date: string;
    wall_s: number;
    live: number;
    loan_days: number;
    loadavg: number[];
  }[] = [];
  const wall0 = performance.now();
  let loanDays = 0;
  let cashMs = 0;
  let delqMs = 0;
  let m2Ms = 0;
  let actMs = 0;
  let boardMs = 0;
  for (let day = D(first); day <= addDays(D(last), 1); day = addDays(day, 1)) {
    // 1. boarding, at 14:00Z on the day (harness-35-5's boardTapeLoan)
    for (const t of tracks)
      if (t.board === day && !t.loanId && !t.boardError) {
        const tb = performance.now();
        try {
          await boardOne(t);
        } catch (e) {
          t.boardError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        }
        boardMs += performance.now() - tb;
      }
    const live = tracks.filter((t) => t.loanId && t.board <= day && day <= addDays(t.end, 1));
    if (!live.length) continue;
    // 2. noon Eastern: the cashiering unit per loan, then the delinquency counters
    const at = noonET(day);
    clock.set(at);
    let t0 = performance.now();
    for (const t of live) {
      const o = await runCashieringUnit(rt, {
        loan_id: t.loanId!,
        as_of_date: etDate(at),
        as_of_instant: at,
      });
      if (o.outcome === "failed")
        t.unitErrors.push({
          date: day,
          error_class: o.error_class,
          error: (o.error ?? "").slice(0, 300),
        });
      loanDays++;
    }
    cashMs += performance.now() - t0;
    if (!SKIP_DELINQUENCY) {
      t0 = performance.now();
      await delinquencyDailySweep(
        rt,
        at,
        live.map((t) => t.loanId!),
      );
      delqMs += performance.now() - t0;
    }
    // 3. on the 1st: the month that ended, read back, and the monthly Metro 2 unit
    if (day.endsWith("-01")) {
      t0 = performance.now();
      const asOf = addDays(day, -1);
      const closing = live.filter((t) => t.board <= asOf && asOf <= t.end);
      if (closing.length) await monthEnd(closing, asOf);
      metro2Runs.push(await metro2Unit(asOf.slice(0, 7), at));
      m2Ms += performance.now() - t0;
      loadSamples.push({
        date: day,
        wall_s: Math.round(performance.now() - wall0) / 1000,
        live: live.length,
        loan_days: loanDays,
        loadavg: loadavg(),
      });
      // A run past its deadline stops here, with every loan compared through the month just read.
      if (DEADLINE_S > 0 && performance.now() - wall0 > DEADLINE_S * 1000) {
        for (const t of tracks) if (t.end > asOf) t.end = asOf;
        stoppedAt = asOf;
        break;
      }
    }
    // 4. the borrower's receipts and the analyst's new escrow payments, at 17:00:30Z
    t0 = performance.now();
    clock.set(`${day}T17:00:30.000Z`);
    for (const t of live) {
      if (day > t.end) continue;
      for (const r of t.receipts.get(day) ?? []) {
        const id = await writePayment(rt, t.loanId!, {
          amount_cents: r.amount,
          received_on: D(r.on),
          credited_as_of: D(r.credited_as_of),
          channel: "lockbox",
          designation: "unspecified",
          status: "received",
          idempotency_key: `xcheck:${r.id}`,
          ...(r.mode === "curtail" ? { curtailment_cents: r.curtailment } : {}),
        });
        t.payIds.set(r.id, id);
      }
      if (t.analysisDays.has(day)) await syncEscrow(t, day);
    }
    actMs += performance.now() - t0;
  }
  const wall = performance.now() - wall0;

  // ---------------------------------------------------------------- read back and compare
  const loans: Record<string, unknown>[] = [];
  for (const t of tracks) {
    // Not reached: never boarded, or boarded on the day the run stopped, so its window ends before it begins.
    if (!t.loanId || t.end < t.board) {
      loans.push({
        loan: t.life.loan_id,
        index: t.index,
        loan_id: t.loanId,
        board: t.board,
        end: t.end,
        transfer: t.transfer,
        board_error: t.boardError,
        not_reached: !t.boardError,
      });
      continue;
    }
    loans.push(await compareLoan(db, t));
  }
  result.stepping = {
    wall_s: Math.round(wall) / 1000,
    loan_days: loanDays,
    per_loan_day_s: loanDays ? Math.round((wall / loanDays) * 1000) / 1e6 : null,
    board_s: Math.round(boardMs) / 1000,
    cash_s: Math.round(cashMs) / 1000,
    delinquency_s: Math.round(delqMs) / 1000,
    month_end_s: Math.round(m2Ms) / 1000,
    acts_s: Math.round(actMs) / 1000,
  };
  result.load_samples = loadSamples;
  result.deadline_s = DEADLINE_S || null;
  result.stopped_at = stoppedAt;
  result.loadavg_end = loadavg();
  result.finished_at = new Date().toISOString();
  result.skipped = skipped;
  result.workarounds = {
    "boarding-4":
      "P&I and T&I custodial accounts added after boarding (seedCustodial); a transfer board opens only clearing",
    "boarding-2":
      "a borrower party linked after boarding (linkBorrowerParty), so the Metro 2 builder finds a consumer",
    "D-03": `the note's dollar late-charge cap written onto loan_terms after boarding on ${lateCapApplied.length} loan(s); the tape has no column for it`,
    "escrow analysis":
      "no runner (cycles.ts:285): each analysis's new escrow payment written onto the due rows on its date",
    "HF-020":
      "MI, VA and MA passed on the batch's licensed_states; the shop's default license list leaves them out",
    "HF-008": `the MIN's check digit repaired before boarding on ${tracks.filter((t) => t.minRepaired).length} loan(s); life 1.0.0 drew it at random, and life 1.2.0 computes it`,
  };
  result.metro2_runs = metro2Runs;
  result.loans = loans;
  writeFileSync(OUT, jsonOut(result));
  const st = result.stepping as Record<string, unknown>;
  console.log(
    `${LABEL}: ${tracks.length} loans, ${loanDays} loan-days, wall ${st.wall_s}s (${st.per_loan_day_s}s/loan-day) | load ${JSON.stringify(result.loadavg_start)} -> ${JSON.stringify(result.loadavg_end)}`,
  );
  await db.end();
}

interface BookParams {
  readonly seed: string;
  readonly loans: number;
  readonly window: number;
  readonly boarding: "origination" | "book";
  readonly start: string;
  readonly cohort: number;
  readonly events: boolean;
}
/**
 * The generator's book: fixed-rate loans (arm-15: a boarded ARM gets no change schedule), no payoff and no transfer
 * out (neither posts through the cycles stepped here), everything else at the calibration's rates. Two passes: the
 * first finds the month each loan reaches us (a script changes no draw), the second scripts the events that exercise
 * late charges, suspense and delinquency, at months counted from that one. The same parameters give the same book.
 */
function drawBook(p: BookParams): { life: ReturnType<typeof generate>; months: number } {
  const months = p.boarding === "origination" ? p.window : 120;
  const pins = Object.fromEntries(Array.from({ length: p.loans }, (_, i) => [i, { arm: null }]));
  const scenario = {
    name: `cross-check/${p.boarding}`,
    loans: p.loans,
    start: p.start,
    cohort_months: p.cohort,
    months,
    boarding: p.boarding,
    random: { payoff: false, transfers_out: false },
    pins,
  };
  const firstPass = generate(p.seed, scenario);
  const events = p.events
    ? firstPass.clean.loans.flatMap((l, i) => scriptedEvents(l, i, months, p.window))
    : [];
  return { life: generate(p.seed, { ...scenario, events }), months };
}

/**
 * The events each loan is scripted with, by its index modulo eight, at months counted from its first month with us:
 * none (the calibration's own behavior only); a missed payment; two in a row; a miss cured by a kept promise; a miss
 * with a broken promise; two misses and a four-month repayment plan; a tax reassessment with bill pay sending the old
 * amount once; an insurance increase and a later miss. Each lands inside the loan's compared window or is left out.
 */
function scriptedEvents(l: LoanLife, i: number, months: number, window: number): ScenarioEvent[] {
  const base = l.transfer_in_on ? monthsBetween(l.draw.first_due, l.transfer_in_on) : 0;
  const ok = (off: number) => off < window - 1 && base + off < months - 1;
  const miss = (off: number): ScenarioEvent[] =>
    ok(off) ? [{ kind: "missed_payment", loan: i, month: base + off }] : [];
  switch (i % 8) {
    case 1:
      return miss(2);
    case 2:
      return [...miss(3), ...miss(4)];
    case 3:
      return ok(5)
        ? [
            ...miss(4),
            {
              kind: "promise_to_pay",
              loan: i,
              month: base + 4,
              day: 22,
              pay_in_days: 7,
              kept: true,
            },
          ]
        : [];
    case 4:
      return ok(4)
        ? [
            ...miss(3),
            {
              kind: "promise_to_pay",
              loan: i,
              month: base + 3,
              day: 20,
              pay_in_days: 10,
              kept: false,
            },
          ]
        : [];
    case 5:
      return ok(9)
        ? [
            ...miss(2),
            ...miss(3),
            { kind: "repayment_plan", loan: i, month: base + 4, day: 6, months: 4 },
          ]
        : [];
    case 6:
      return ok(7) && l.draw.escrowed
        ? [
            { kind: "tax_reassessment", loan: i, month: base + 2, pct: 30 },
            { kind: "bill_pay_stale", loan: i, month: base + 2 },
          ]
        : [];
    case 7:
      return ok(8)
        ? [{ kind: "insurance_increase", loan: i, month: base + 1, pct: 40 }, ...miss(7)]
        : [];
    default:
      return [];
  }
}

const LINE_TYPES: Record<string, string> = {
  tax_county: "county_tax",
  tax_school: "school_tax",
  hazard: "hazard",
  flood: "flood",
  mi_borrower_paid: "mortgage_insurance",
};

/** The opening escrow deposit: the first month-end's balance less what came in and went out by then. */
function escrowInitial(l: LoanLife): Cents {
  const m0 = l.months[0];
  if (!m0) return 0n;
  let bal = m0.escrow_balance;
  for (const r of l.receipts) if (r.on <= m0.as_of) for (const i of r.installments) bal -= i.escrow;
  for (const x of l.disbursements) if (x.on <= m0.as_of) bal += x.amount;
  return bal;
}

function validateErrors(s: { k3: { min: string | null } }): string[] {
  return s.k3.min === null ? ["K3_MIN_MISSING"] : [];
}

// ================================================================= compare
interface Field {
  readonly field: string;
  readonly month: string;
  readonly key: string;
  readonly gen: unknown;
  readonly svc: unknown;
  readonly agree: boolean;
}

async function compareLoan(
  db: { query: <T extends Row>(sql: string, p?: unknown[]) => Promise<T[]> },
  t: Track,
): Promise<Record<string, unknown>> {
  const l = t.life;
  const id = t.loanId!;
  const fields: Field[] = [];
  const add = (field: string, month: string, key: string, gen: unknown, svc: unknown) =>
    fields.push({ field, month, key, gen, svc, agree: same(gen, svc) });
  const store = new EntityStore();
  store.seed(await new PgEntityRepository(db as never).load({ loanId: id }));
  const payments = new Map(
    store.list("payments", (x) => x.loan_id === id).map((r) => [r.id, r.data]),
  );
  const applied = await db.query<{ p: Row }>(
    `SELECT payload AS p FROM loan_events WHERE loan_id = $1 AND type = 'payment.applied' ORDER BY sequence`,
    [id],
  );
  const appliedBy = new Map<string, Row[]>();
  for (const a of applied)
    appliedBy.set(String(a.p.payment_id), [...(appliedBy.get(String(a.p.payment_id)) ?? []), a.p]);
  const rows = await db.query<Row>(
    `SELECT due_date::text AS due, status::text AS status, satisfied_on::text AS satisfied_on, credited_as_of::text AS credited_as_of, pi_cents::text AS pi, escrow_cents::text AS escrow FROM loan_installments WHERE loan_id = $1 ORDER BY due_date`,
    [id],
  );
  const rowBy = new Map(rows.map((r) => [String(r.due), r]));
  const fees = store
    .list("fees", (x) => x.loan_id === id && x.fee_type === "late_charge")
    .map((r) => r.data);

  // Receipts: the split of each one the generator posted for us inside the window.
  const inWindow = [...t.receipts.values()].flat().filter((r) => r.on <= t.end);
  for (const r of inWindow) {
    const m = r.on.slice(0, 7);
    const pid = t.payIds.get(r.id);
    const p = pid ? payments.get(pid) : undefined;
    const alloc = (p?.allocation ?? {}) as Row;
    const svcInst = (pid ? (appliedBy.get(pid) ?? []) : []).map((a) => ({
      due: String(a.due_date),
      interest: c(a.interest_cents),
      principal: c(a.principal_cents),
      escrow: c(a.escrow_cents),
      kind: String(a.kind),
    }));
    const genInst = r.installments.map((i) => ({
      due: i.due,
      interest: i.interest,
      principal: i.principal,
      escrow: i.escrow,
      kind: i.kind,
    }));
    const posted = p?.status === "posted";
    add(
      "receipt.posted",
      m,
      r.id,
      r.installments.length > 0 || r.curtailment > 0n || r.late_charge > 0n,
      posted,
    );
    add("receipt.outcome", m, r.id, r.outcome, p?.allocation_outcome ?? p?.status ?? null);
    add(
      "receipt.installments",
      m,
      r.id,
      genInst.map((i) => i.due).join(","),
      svcInst.map((i) => i.due).join(","),
    );
    add(
      "receipt.interest",
      m,
      r.id,
      sum(genInst.map((i) => i.interest)),
      posted ? c(alloc.interest_cents) : 0n,
    );
    add(
      "receipt.principal",
      m,
      r.id,
      sum(genInst.map((i) => i.principal)),
      posted ? c(alloc.principal_cents) : 0n,
    );
    add(
      "receipt.escrow",
      m,
      r.id,
      sum(genInst.map((i) => i.escrow)),
      posted ? c(alloc.escrow_cents) : 0n,
    );
    add("receipt.split_by_installment", m, r.id, genInst, svcInst);
    add("receipt.late_charge", m, r.id, r.late_charge, posted ? c(alloc.late_charge_cents) : 0n);
    add("receipt.curtailment", m, r.id, r.curtailment, posted ? c(alloc.curtailment_cents) : 0n);
    add(
      "receipt.to_suspense",
      m,
      r.id,
      r.to_suspense,
      posted ? c(alloc.to_suspense_cents) : p ? c(p.amount_cents) : null,
    );
  }

  // Installments due inside the window: status and dates as they stood on its last day.
  const prev = t.transfer
    ? l.months.find((x) => x.month === addMonths(t.board, -1).slice(0, 7))
    : undefined;
  const firstDue = prev
    ? (prev.next_due ?? (prev.lpi ? addMonths(D(prev.lpi), 1) : t.board))
    : l.draw.first_due;
  for (const gi of l.installments) {
    if (gi.due < firstDue || gi.due > t.end) continue;
    const m = gi.due.slice(0, 7);
    const paid = gi.satisfied_on !== null && gi.satisfied_on <= t.end;
    const sr = rowBy.get(gi.due);
    const sPaid = sr ? sr.status !== "due" && String(sr.satisfied_on ?? "") <= t.end : false;
    add("installment.amount", m, gi.due, gi.pi + gi.escrow, sr ? c(sr.pi) + c(sr.escrow) : null);
    add(
      "installment.status",
      m,
      gi.due,
      paid ? gi.status : "due",
      sr ? (sPaid ? sr.status : "due") : null,
    );
    add(
      "installment.satisfied_on",
      m,
      gi.due,
      paid ? gi.satisfied_on : null,
      sPaid ? sr!.satisfied_on : null,
    );
    add(
      "installment.credited_as_of",
      m,
      gi.due,
      paid ? gi.credited_as_of : null,
      sPaid ? sr!.credited_as_of : null,
    );
  }

  // Late charges: assessed for each installment whose run fell inside the window.
  const runs = l.late_charge_runs.filter(
    (x) => x.servicer === "us" && x.on > t.board && x.on <= t.end,
  );
  const runDues = new Set(runs.map((x) => x.due));
  for (const f of fees) {
    const due = String(f.installment_due_date ?? "");
    if (String(f.assessed_on) <= t.end && !runDues.has(due as PlainDate))
      runDues.add(due as PlainDate);
  }
  for (const due of [...runDues].sort()) {
    const g =
      runs.find((x) => x.due === due && x.amount !== null) ?? runs.find((x) => x.due === due);
    const s = fees.find(
      (f) => String(f.installment_due_date) === due && String(f.assessed_on) <= t.end,
    );
    add("late_charge.assessed", due.slice(0, 7), due, g?.amount ?? 0n, s ? c(s.amount_cents) : 0n);
    add(
      "late_charge.assessed_on",
      due.slice(0, 7),
      due,
      g?.amount ? g.on : null,
      s ? String(s.assessed_on) : null,
    );
  }

  // Month-ends.
  for (const gm of l.months) {
    if (gm.as_of < t.board || gm.as_of > t.end) continue;
    const sm = t.months.get(gm.month);
    if (!sm) {
      add("month.read", gm.month, gm.month, true, false);
      continue;
    }
    add("month.upb", gm.month, gm.month, gm.upb, sm.upb);
    add("month.suspense", gm.month, gm.month, gm.suspense, sm.suspense);
    add(
      "month.late_charges_owed",
      gm.month,
      gm.month,
      gm.late_charges_due,
      sm.late_charges_due_state,
    );
    add(
      "month.late_charges_ledger",
      gm.month,
      gm.month,
      gm.late_charges_due,
      sm.late_charges_ledger,
    );
    metro2Fields(add, gm, sm);
  }

  return {
    loan: l.loan_id,
    index: t.index,
    loan_id: id,
    board: t.board,
    end: t.end,
    transfer: t.transfer,
    escrowed: l.draw.escrowed,
    late_charge: { pct: l.draw.late_charge.pct, cap_cents: l.draw.late_charge.cap_cents },
    state: l.draw.property.state,
    persona: l.draw.persona,
    pattern: t.index % 8,
    receipts: inWindow.length,
    escrow_rows_synced: t.escrowSyncs,
    min_repaired: t.minRepaired,
    unit_errors: t.unitErrors,
    fields,
  };
}

const METRO2_FIELDS = [
  "account_status",
  "payment_history_profile",
  "amount_past_due",
  "current_balance",
  "scheduled_monthly_payment",
  "actual_payment_amount",
  "date_of_first_delinquency",
  "date_of_last_payment",
  "terms_duration",
  "interest_type_indicator",
  "special_comment",
] as const;
function metro2Fields(
  add: (field: string, month: string, key: string, gen: unknown, svc: unknown) => void,
  gm: MonthEnd,
  sm: ServicingMonth,
): void {
  const g = gm.metro2.record;
  const s = sm.metro2;
  if (!s) {
    add(
      "metro2.built",
      gm.month,
      gm.month,
      g !== null,
      `omitted: ${sm.metro2_omitted ?? "unknown"}`,
    );
    return;
  }
  add("metro2.min_present", gm.month, gm.month, true, sm.metro2_errors.length === 0);
  if (!g) {
    add("metro2.account_status", gm.month, gm.month, gm.metro2.account_status, s.account_status);
    return;
  }
  for (const f of METRO2_FIELDS) add(`metro2.${f}`, gm.month, gm.month, g[f] ?? null, s[f] ?? null);
}

function same(a: unknown, b: unknown): boolean {
  return jsonOut(a) === jsonOut(b);
}
function sum(xs: readonly Cents[]): Cents {
  return xs.reduce((s, x) => s + x, 0n);
}

// ================================================================= report
/**
 * Every disagreement class the triage knows: a defect already in docs/servicing-engine-defects.md (`known`), one that
 * is not (`new`), a generator bug, or the harness's own doing. A field that matches no class is `unclassified` and is
 * read by hand.
 */
const CLASSES: Record<
  string,
  { kind: "known" | "new" | "generator" | "harness" | "unclassified"; ref: string; what: string }
> = {
  "metro2-1": {
    kind: "known",
    ref: "metro2-1",
    what: "the monthly unit builds every loan with no MIN, so validation leaves it out (K3_MIN_MISSING)",
  },
  "metro2-prior": {
    kind: "new",
    ref: "domain/operations-runtime/runners.ts:144; credit-reporting/metro2.ts:65, :105",
    what: "the typed-row builder passes `prior: null` every month: the payment history profile is the boarding hand-off (24 × B) forever, and the date of first delinquency restarts at each month's oldest unpaid installment",
  },
  "metro2-held": {
    kind: "new",
    ref: "domain/operations-runtime/runners.ts:137-139",
    what: "the actual payment amount and the date of last payment count only `posted` payments, so a receipt held in suspense was never received as far as the bureaus are told",
  },
  "escrow-terms": {
    kind: "harness",
    ref: "runners.ts:141 reads loan_terms.escrow_payment_cents",
    what: "the harness writes each analysis onto the due rows only; the Metro 2 builder reads the boarded terms, so its scheduled payment keeps the boarded escrow",
  },
  "cashiering-19": {
    kind: "known",
    ref: "cashiering-19",
    what: "a paid late charge stays `assessed` on its fee row, so the cash state reads it due and a later receipt pays it again",
  },
  "cashiering-11": {
    kind: "known",
    ref: "cashiering-11",
    what: "the runtime's derived cash state never sets the 60-day transfer shield, so a charge the generator's shield spares is assessed",
  },
  "boarding-6": {
    kind: "known",
    ref: "boarding-6",
    what: "the tape's late charges are booked on the ledger with no fee row, so the cash state never sees them and no receipt pays them",
  },
  "cashiering-18": {
    kind: "known",
    ref: "cashiering-18",
    what: "the cycle's cash state hard-codes `overlays: []` (cashiering-cycle.ts:154), so a repayment plan's suspended accrual never reaches it and its charges are assessed and collected",
  },
  "cashiering-10": {
    kind: "known",
    ref: "cashiering-10",
    what: "the runtime hard-codes `partial_count_12m` to 0, so a fourth $50-rule shortfall in twelve months is applied",
  },
  "transfer-history": {
    kind: "new",
    ref: "domain/boarding/service.ts:166, :367-371; domain/operations-runtime/runners.ts:137-139",
    what: "boarding reads the tape's payment history only to seed delinquency and writes no payment record, so until the servicing app posts a receipt of its own the bureaus are told the borrower never paid",
  },
  "escrow-sync": {
    kind: "harness",
    ref: "syncEscrow",
    what: "the installment's amount on the servicing app's row is not the generator's",
  },
  unclassified: { kind: "unclassified", ref: "", what: "read by hand" },
};
type Cls = string;
/** A class, or several joined with "+" when a field follows from more than one root: the worst kind among them. */
function classOf(name: string): { kind: string; ref: string; what: string } {
  const parts = name.split("+").map((p) => CLASSES[p] ?? CLASSES.unclassified!);
  if (parts.length === 1) return parts[0]!;
  const order = ["unclassified", "generator", "new", "harness", "known"];
  const kind = order.find((k) => parts.some((p) => p.kind === k)) ?? "unclassified";
  return {
    kind,
    ref: name.split("+").join(", "),
    what: `follows from ${name.split("+").join(" and ")} together`,
  };
}

/** The date a field speaks for: a receipt's day, an installment's due date, a charge's run, or a month's last day. */
function fieldDate(f: Field, life: LoanLife): PlainDate {
  if (f.field.startsWith("receipt."))
    return life.receipts.find((r) => r.id === f.key)?.on ?? endOfMonth(D(`${f.month}-01`));
  if (f.field.startsWith("installment.")) return D(f.key);
  // A charge speaks for its run day: the generator's run, or the day after a grace end that fell on a closed day.
  if (f.field.startsWith("late_charge.")) {
    const run = life.late_charge_runs.filter((x) => x.due === f.key).at(-1)?.on;
    const due16 = addDays(D(f.key), 16);
    return run && run > due16 ? run : due16;
  }
  return endOfMonth(D(`${f.month}-01`));
}

interface SvcLoan {
  readonly payments: Row[];
  readonly fees: Row[];
}
/** One loan's disagreements, each with its class and whether it is a root (the first place a class shows) or follows one. */
function triageLoan(
  l: Row,
  life: LoanLife,
  svc: SvcLoan,
): { f: Field; cls: Cls; root: boolean; date: PlainDate; reached: boolean }[] {
  const fields = l.fields as Field[];
  const board = D(String(l.board));
  const transfer = l.transfer === true;
  const roots: { cls: Cls; date: PlainDate }[] = [];
  const byKey = new Map(fields.map((f) => [`${f.field}|${f.month}|${f.key}`, f]));
  const other = (field: string, f: Field) => byKey.get(`${field}|${f.month}|${f.month}`);

  // cashiering-19: the first receipt that takes more late charges than the servicing app ever assessed.
  const posted = svc.payments
    .filter((p) => p.status === "posted")
    .sort((a, b) => String(a.received_on).localeCompare(String(b.received_on)));
  let collected = 0n;
  for (const p of posted) {
    collected += c((p.allocation as Row | undefined)?.late_charge_cents);
    const assessed = sum(
      svc.fees
        .filter((x) => String(x.assessed_on) <= addDays(D(String(p.received_on)), 1))
        .map((x) => c(x.amount_cents)),
    );
    if (collected > assessed) {
      roots.push({ cls: "cashiering-19", date: D(String(p.received_on)) });
      break;
    }
  }
  // cashiering-11: a charge the generator's shield spared and the servicing app assessed. Life 1.0.0 shielded every
  // installment due in the window; since life 1.2.0 the generator shields only a payment the prior servicer received
  // on time, which these books never send, so the class is empty unless a scenario forwards one.
  for (const r of life.late_charge_runs)
    if (
      r.reason?.includes("transfer_window_60") &&
      svc.fees.some((x) => x.installment_due_date === r.due)
    )
      roots.push({ cls: "cashiering-11", date: r.on });
  // boarding-6: late charges owed on the tape.
  const prev = transfer
    ? life.months.find((m) => m.month === addMonths(board, -1).slice(0, 7))
    : undefined;
  if (prev && prev.late_charges_due > 0n) roots.push({ cls: "boarding-6", date: board });
  // cashiering-18: a charge the generator accrued suspended under a repayment plan.
  for (const r of life.late_charge_runs)
    if (r.outcome === "accrued_suspended" && r.on >= board)
      roots.push({ cls: "cashiering-18", date: r.on });
  // cashiering-10: a $50-rule shortfall the servicing app applied past the limit.
  for (const f of fields)
    if (
      !f.agree &&
      f.field === "receipt.outcome" &&
      f.svc === "applied_with_50_rule" &&
      f.gen !== "applied_with_50_rule"
    ) {
      const r = life.receipts.find((x) => x.id === f.key);
      if (r?.mode === "short_50") roots.push({ cls: "cashiering-10", date: r.on });
    }
  // the harness: an installment billed at another amount.
  for (const f of fields)
    if (!f.agree && f.field === "installment.amount")
      roots.push({ cls: "escrow-sync", date: D(f.key) });
  roots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const heldIn = (month: string) =>
    svc.payments.filter(
      (p) => p.status !== "posted" && String(p.received_on).slice(0, 7) === month,
    );
  const out: { f: Field; cls: Cls; root: boolean; date: PlainDate; reached: boolean }[] = [];
  const seen = new Set<Cls>();
  for (const f of fields) {
    const date = fieldDate(f, life);
    // Whether any root had been reached by the field's date: the agreement rate away from every defect reads these.
    const reached = roots.some((r) => r.date <= date);
    if (f.agree) {
      out.push({ f, cls: "", root: false, date, reached });
      continue;
    }
    let cls: Cls | null = null;
    if (f.field === "metro2.min_present") cls = "metro2-1";
    else if (f.field === "metro2.payment_history_profile" && /^B{24}$/.test(String(f.svc)))
      cls = "metro2-prior";
    else if (
      f.field === "metro2.date_of_first_delinquency" &&
      other("metro2.account_status", f)?.agree
    )
      cls = "metro2-prior";
    else if (f.field === "metro2.scheduled_monthly_payment" && life.draw.escrowed)
      cls = "escrow-terms";
    else if (f.field === "metro2.actual_payment_amount" && heldIn(f.month).length) {
      // Base-segment money is whole dollars, truncated: the held receipts account for the gap to within a dollar.
      const held = Number(sum(heldIn(f.month).map((p) => c(p.amount_cents)))) / 100;
      if (Math.abs(Number(f.gen) - Number(f.svc) - held) <= 1) cls = "metro2-held";
    } else if (f.field === "metro2.date_of_last_payment") {
      const g = String(f.gen);
      const genIso = `${g.slice(4, 8)}-${g.slice(0, 2)}-${g.slice(2, 4)}`;
      if (svc.payments.some((p) => p.status !== "posted" && String(p.received_on) === genIso))
        cls = "metro2-held";
      else if (transfer && genIso < board) cls = "transfer-history";
    } else if (
      f.field === "month.late_charges_owed" &&
      other("month.late_charges_ledger", f)?.agree
    ) {
      cls =
        c(f.svc) > c(f.gen)
          ? "cashiering-19"
          : transfer && prev && prev.late_charges_due > 0n
            ? "boarding-6"
            : null;
    }
    // Otherwise it follows from every root already reached, named together when there is more than one.
    const active = [...new Set(roots.filter((r) => r.date <= date).map((r) => r.cls))];
    const name = cls ?? (active.length ? active.join("+") : "unclassified");
    out.push({ f, cls: name, root: !seen.has(name), date, reached });
    seen.add(name);
  }
  return out;
}

/** A run file's database, refused unless it is a scratch one: `report` and `loan` read only what `run` wrote. */
function scratchDb(r: Row): string {
  const db = String(r.db);
  if (!SCRATCH.test(db))
    throw new Error(`run ${String(r.label)} names ${db}, not a hm_xcheck_<short> database`);
  return db;
}

/** A run's book is drawn again from its seed, so it reads back only under the life version that drew it. */
function sameLife(r: Row): void {
  if (r.life_version !== LIFE_VERSION)
    throw new Error(
      `run ${String(r.label)} was drawn under life ${String(r.life_version)}; this generator is ${LIFE_VERSION}`,
    );
}

async function report(): Promise<void> {
  const OUT = args.get("out") ?? "cross-check-report.json";
  const runs = positional.map((p) => JSON.parse(readFileSync(p, "utf8")) as Row);
  for (const r of runs) {
    scratchDb(r);
    sameLife(r);
  }
  const per = new Map<
    string,
    {
      n: number;
      agree: number;
      clear_n: number;
      clear_agree: number;
      explained: Map<string, number>;
    }
  >();
  const classes = new Map<
    string,
    { fields: number; loans: Set<string>; months: Set<string>; examples: unknown[] }
  >();
  const unclassified: unknown[] = [];
  const totals = {
    runs: runs.length,
    loans: 0,
    loan_months: 0,
    loan_days: 0,
    receipts: 0,
    board_errors: 0,
    not_reached: 0,
    min_repaired: 0,
    wall_s: 0,
  };
  const gen = { loans: 0, min_fails_mod10: 0, active_month_ends: 0, next_due_null: 0 };
  const modes = new Map<string, number>();
  const charges = { generator: 0, servicing: 0 };
  for (const r of runs) {
    const { life } = drawBook({
      seed: String(r.seed),
      loans: Number(r.loans_requested),
      window: Number(r.window_months),
      boarding: r.boarding as "origination" | "book",
      start: String(r.start),
      cohort: Number(r.cohort_months),
      events: r.events !== "none",
    });
    const lives = new Map(life.clean.loans.map((x) => [x.loan_id, x]));
    // Two generator findings the harness had to work around, counted over the whole book (both none since life 1.2.0).
    for (const x of life.clean.loans) {
      gen.loans++;
      if (!isValidMin(x.draw.min)) gen.min_fails_mod10++;
      for (const m of x.months)
        if (m.status !== "paid_off" && m.status !== "transferred") {
          gen.active_month_ends++;
          if (m.next_due === null) gen.next_due_null++;
        }
    }
    const client = new pg.Client({ connectionString: `${BASE_URL}/${scratchDb(r)}` });
    await client.connect();
    totals.loan_days += Number((r.stepping as Row).loan_days);
    totals.wall_s = Math.max(totals.wall_s, Number((r.stepping as Row).wall_s));
    for (const l of (r.loans as Row[]) ?? []) {
      if (l.board_error) totals.board_errors++;
      // A loan boarded on the day its run stopped has no field (run files written before `run` said so name it here).
      if (l.not_reached || (Array.isArray(l.fields) && !l.fields.length)) totals.not_reached++;
      if (!Array.isArray(l.fields) || !l.fields.length) continue;
      totals.loans++;
      if (l.min_repaired) totals.min_repaired++;
      totals.receipts += Number(l.receipts);
      const fields = l.fields as Field[];
      totals.loan_months += new Set(
        fields.filter((f) => f.field === "month.upb").map((f) => f.month),
      ).size;
      const rows = (kind: string) =>
        client
          .query<{ d: Row }>(
            `SELECT data AS d FROM entity_current WHERE kind = $1 AND loan_id = $2`,
            [kind, String(l.loan_id)],
          )
          .then((x) => x.rows.map((y) => y.d));
      const svc: SvcLoan = {
        payments: await rows("payments"),
        fees: (await rows("fees")).filter((x) => x.fee_type === "late_charge"),
      };
      const lifeL = lives.get(String(l.loan));
      if (!lifeL)
        throw new Error(
          `run ${String(r.label)}: loan ${String(l.loan)} is not in the regenerated book`,
        );
      // What the compared receipts exercised, by the generator's mode, and how many charges either side assessed.
      const compared = new Set(
        fields.filter((f) => f.field === "receipt.posted").map((f) => f.key),
      );
      for (const x of lifeL.receipts)
        if (compared.has(x.id)) modes.set(x.mode, (modes.get(x.mode) ?? 0) + 1);
      for (const f of fields)
        if (f.field === "late_charge.assessed") {
          if (c(f.gen) > 0n) charges.generator++;
          if (c(f.svc) > 0n) charges.servicing++;
        }
      const triaged = triageLoan(l, lifeL, svc);
      for (const t of triaged) {
        const x = per.get(t.f.field) ?? {
          n: 0,
          agree: 0,
          clear_n: 0,
          clear_agree: 0,
          explained: new Map<string, number>(),
        };
        x.n++;
        if (t.f.agree) x.agree++;
        if (!t.reached) {
          x.clear_n++;
          if (t.f.agree) x.clear_agree++;
        }
        per.set(t.f.field, x);
        if (t.f.agree) continue;
        x.explained.set(t.cls, (x.explained.get(t.cls) ?? 0) + 1);
        const k = classes.get(t.cls) ?? {
          fields: 0,
          loans: new Set<string>(),
          months: new Set<string>(),
          examples: [],
        };
        k.fields++;
        k.loans.add(String(l.loan));
        k.months.add(`${String(l.loan)}|${t.f.month}`);
        if (t.root && k.examples.length < 4)
          k.examples.push({
            run: r.label,
            loan: l.loan,
            date: t.date,
            field: t.f.field,
            key: t.f.key,
            gen: t.f.gen,
            svc: t.f.svc,
          });
        classes.set(t.cls, k);
        if (t.cls === "unclassified")
          unclassified.push({ run: r.label, loan: l.loan, date: t.date, ...t.f });
      }
    }
    await client.end();
  }
  const table = [...per].map(([field, x]) => ({
    field,
    compared: x.n,
    agree: x.agree,
    rate: Math.round((x.agree / x.n) * 10000) / 10000,
    // Fields no root had reached by their date: what the two sides say where no defect stands between them.
    clear_compared: x.clear_n,
    clear_agree: x.clear_agree,
    disagreements: Object.fromEntries(x.explained),
  }));
  const classTable = [...classes]
    .map(([cls, k]) => ({
      class: cls,
      ...classOf(cls),
      fields: k.fields,
      loans: k.loans.size,
      // Distinct loan-months the class shows in (a month-end can carry several of its fields).
      loan_months: k.months.size,
      examples: k.examples,
      loan_ids: [...k.loans].sort(),
    }))
    .sort((a, b) => b.fields - a.fields);
  writeFileSync(
    OUT,
    jsonOut({
      totals,
      receipt_modes: Object.fromEntries(modes),
      charges_assessed: charges,
      generator: gen,
      fields: table,
      classes: classTable,
      unclassified,
    }),
  );
  console.log(JSON.stringify(totals));
  console.log(
    JSON.stringify(gen),
    JSON.stringify(Object.fromEntries(modes)),
    JSON.stringify(charges),
  );
  for (const row of table)
    console.log(
      `${row.field.padEnd(36)} ${String(row.agree).padStart(7)} / ${String(row.compared).padEnd(7)} ${(row.rate * 100).toFixed(2).padStart(6)}%  clear ${row.clear_agree}/${row.clear_compared}  ${JSON.stringify(row.disagreements)}`,
    );
  for (const k of classTable)
    console.log(
      `${k.class.padEnd(16)} ${k.kind.padEnd(12)} fields ${String(k.fields).padStart(6)} loans ${String(k.loans).padStart(4)} loan-months ${String(k.loan_months).padStart(5)}`,
    );
}

// ================================================================= one loan, both sides, for reading a disagreement by hand
async function loan(): Promise<void> {
  const r = JSON.parse(readFileSync(positional[0] ?? "", "utf8")) as Row;
  sameLife(r);
  const id = positional[1] ?? "";
  const from = positional[2] ?? "0000";
  const to = positional[3] ?? "9999";
  const { life } = drawBook({
    seed: String(r.seed),
    loans: Number(r.loans_requested),
    window: Number(r.window_months),
    boarding: r.boarding as "origination" | "book",
    start: String(r.start),
    cohort: Number(r.cohort_months),
    events: r.events !== "none",
  });
  const l = life.clean.loans.find((x) => x.loan_id === id);
  const entry = ((r.loans as Row[]) ?? []).find((x) => x.loan === id);
  if (!l || !entry) throw new Error(`no loan ${id} in ${String(r.label)}`);
  const j = (x: unknown) =>
    JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const inRange = (d: string) => d >= from && d <= to;
  console.log(
    "draw",
    j({
      first_due: l.draw.first_due,
      pi: l.draw.initial_pi_cents,
      late_charge: l.draw.late_charge,
      persona: l.draw.persona,
      transfer_in_on: l.transfer_in_on,
      board: entry.board,
      end: entry.end,
    }),
  );
  for (const x of l.behavior) if (inRange(x.on)) console.log("gen behavior", j(x));
  for (const x of l.receipts)
    if (inRange(x.on))
      console.log(
        "gen receipt",
        j({
          id: x.id,
          on: x.on,
          amount: x.amount,
          mode: x.mode,
          outcome: x.outcome,
          installments: x.installments.map((i) => i.due),
          late_charge: x.late_charge,
          to_suspense: x.to_suspense,
          suspense_used: x.suspense_used,
        }),
      );
  for (const x of l.late_charge_runs) if (inRange(x.on)) console.log("gen run", j(x));
  for (const x of l.fees) if (inRange(x.assessed_on)) console.log("gen fee", j(x));
  for (const x of l.months)
    if (inRange(x.as_of))
      console.log(
        "gen month",
        j({
          month: x.month,
          upb: x.upb,
          suspense: x.suspense,
          late_charges_due: x.late_charges_due,
          next_due: x.next_due,
          status: x.metro2.account_status,
          php: x.metro2.record?.payment_history_profile ?? null,
          dofd: x.metro2.record?.date_of_first_delinquency ?? null,
        }),
      );
  const client = new pg.Client({ connectionString: `${BASE_URL}/${scratchDb(r)}` });
  await client.connect();
  for (const kind of ["payments", "fees"]) {
    const rows = await client.query<{ d: Row }>(
      `SELECT data AS d FROM entity_current WHERE kind = $1 AND loan_id = $2`,
      [kind, String(entry.loan_id)],
    );
    for (const { d } of rows.rows.sort((a, b) =>
      String(a.d.received_on ?? a.d.assessed_on).localeCompare(
        String(b.d.received_on ?? b.d.assessed_on),
      ),
    ))
      if (inRange(String(d.received_on ?? d.assessed_on)))
        console.log(
          `svc ${kind}`,
          j(
            kind === "payments"
              ? {
                  key: d.idempotency_key,
                  on: d.received_on,
                  amount: d.amount_cents,
                  status: d.status,
                  outcome: d.allocation_outcome,
                  installments: d.installments,
                  allocation: d.allocation,
                }
              : {
                  due: d.installment_due_date,
                  amount: d.amount_cents,
                  state: d.state,
                  assessed_on: d.assessed_on,
                  collected: d.collected_cents,
                },
          ),
        );
  }
  await client.end();
}

// ================================================================= main
if (mode === "run") await run();
else if (mode === "report") await report();
else if (mode === "loan") await loan();
else {
  console.error(
    "usage: cross-check-life.mts run --db hm_xcheck_<short> … | report --out <file> <run.json>… | loan <run.json> <loan> [from] [to]",
  );
  process.exit(2);
}
