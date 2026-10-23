/**
 * Catch-up receipts, each drawn from a ten-year loan history the life
 * generator wrote: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). Its stream draws a
 * scenario for one loan: a life seed, a note whose dollar cap on a late
 * charge binds below its percent (or none), a missed installment, and
 * sometimes a transfer in before it or an earlier miss. The loan is run for
 * its decade (`generate`), and where the arm calls for it the defective twin
 * is run beside it with D-03 planted: the note's cap never boarded, so every
 * charge since boarding is the full percent. The moment is the first
 * catch-up after the missed installment: the borrower who is behind pays
 * everything owed (the generator's `cure`), or only the oldest installment
 * (`oldest`), still behind. The task is the loan as the system shows it the
 * day that receipt arrives, read off the history at that moment
 * (`LifeMoment`), and the last twelve months of its history.
 *
 * The arm cycles by index through six, so any six tasks hold each:
 *   - breached: the twin, a catch-up meeting a charge above the cap, and none
 *     collected above it before (a loan boarded by transfer shortly before);
 *   - breached_refund: the twin, a catch-up after charges already collected
 *     above the cap;
 *   - breached_behind: the twin, the oldest installment only;
 *   - within_capped: the clean history, the cap boarded, a catch-up meeting a
 *     charge the cap holds down;
 *   - within_uncapped: the clean history of a note with no cap that binds;
 *   - within_behind: the clean history, the oldest installment only.
 * A draw that does not land on its arm is drawn again under the next key.
 *
 * The receipts stay on the pay-in-full route, where every installment the
 * money reaches is paid whole, and off the partial-payment paths that carry
 * logged engine defects (docs/servicing-engine-defects.md): no receipt
 * pools suspense (cashiering-4's balance and cashiering-7's accumulation),
 * none is short of the oldest installment (the $50 rule, cashiering-10, and
 * the partial hold), none leaves money for late charges while an installment
 * due is unpaid (cashiering-7), and no loan carries a hold, a trial or a
 * plan (cashiering-13). The history before the moment is held to the same:
 * no receipt in it paid late charges ahead of the arrears or out of
 * accumulated suspense, and no late-charge run in it excused an installment
 * on suspense another unpaid installment also had a claim on. A moment is
 * then kept only once the reference, working through the tools, lands
 * exactly where the engine does.
 *
 * The histories draw from the calibration's typed defaults
 * (`defaultCalibration`), as the life generator's own tests do, so a change
 * to calibration.json does not move a pinned suite, and a browser draws the
 * same task the command line does.
 */

import { addDays, addMonths, plainDate, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  defaultCalibration,
  generate,
  type Calibration,
  type LifeMoment,
  type LoanLife,
  type ScenarioEvent,
} from "../life/index.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import type { LoanCashState } from "../payments/ported/types.js";
import {
  capBreached,
  expectedCatchup,
  gradeCatchupAgainst,
  heldToNote,
  parseCatchupSubmission,
  postCatchup,
} from "./grader.js";
import { catchupSteps } from "./reference.js";
import {
  CATCHUP_ENVIRONMENT_NAME,
  CATCHUP_ENVIRONMENT_VERSION,
  catchupPayload,
  type CatchupTask,
  type Installment,
  type LateChargeRow,
} from "./task.js";
import { executeCatchupTool } from "./tools.js";

export const catchupTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${CATCHUP_ENVIRONMENT_NAME}/${CATCHUP_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const CATCHUP_ARMS = [
  "breached",
  "breached_refund",
  "breached_behind",
  "within_capped",
  "within_uncapped",
  "within_behind",
] as const;
export type CatchupArm = (typeof CATCHUP_ARMS)[number];
export const catchupArmOf = (index: number): CatchupArm =>
  CATCHUP_ARMS[index % CATCHUP_ARMS.length]!;

/** The note caps a scenario pins: the life generator's own (draw.ts NOTE_CAPS_CENTS). */
const CAPS: readonly number[] = [1_500, 2_500, 3_500, 5_000];

let calibration: Calibration | null = null;
const cal = (): Calibration => (calibration ??= defaultCalibration());

/** The history the task is read from, the moment in it, and the clean history beside a twin. */
export interface CatchupDraw {
  readonly task: CatchupTask;
  readonly life: LoanLife;
  readonly clean: LoanLife;
  readonly moment: Extract<LifeMoment, { kind: "receipt" }>;
}

const sortByDue = <T extends { due_date: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

/**
 * The history before the moment, held to what the spec allows: no receipt
 * paid late charges while an installment due by its date stayed unpaid, or
 * out of suspense held from before (cashiering-7); no late-charge run excused
 * an installment on suspense while an earlier installment was unpaid too
 * (cashiering-4).
 */
export function historyInScope(life: LoanLife, before: number): boolean {
  const ledger = new Map(life.installments.map((i) => [i.due, i]));
  /** Not yet posted by the end of `on`. */
  const unpaidOn = (due: PlainDate, on: PlainDate) => {
    const i = ledger.get(due);
    return i !== undefined && (i.satisfied_on === null || i.satisfied_on > on);
  };
  /** Not credited by `on`, the test a run makes (`receivedTowardBasis`, latecharges.ts:62). */
  const uncreditedBy = (due: PlainDate, on: PlainDate) => {
    const i = ledger.get(due);
    const credited = i?.credited_as_of ?? i?.satisfied_on ?? null;
    return i !== undefined && (credited === null || credited > on);
  };
  const receipts = life.receipts.slice(0, before);
  const last = receipts.at(-1)?.on ?? null;
  for (const r of receipts) {
    if (r.late_charge === 0n) continue;
    if (r.suspense_used > 0n) return false;
    if (life.installments.some((i) => i.due <= r.on && unpaidOn(i.due, r.on))) return false;
  }
  for (const run of life.late_charge_runs) {
    if (last === null || run.on > last) break;
    if (run.outcome !== "not_assessed" || !run.reason?.startsWith("paid within grace")) continue;
    // A run is the day after the grace end; an installment not credited by then was excused on suspense.
    if (!uncreditedBy(run.due, addDays(run.on, -1))) continue;
    if (life.installments.some((i) => i.due < run.due && unpaidOn(i.due, run.on))) return false;
  }
  return true;
}

/** The task, read off the history at the moment the receipt was about to be posted. */
function taskAt(
  coords: Pick<CatchupTask, "id" | "split" | "suite_seed" | "index">,
  life: LoanLife,
  moment: Extract<LifeMoment, { kind: "receipt" }>,
  rate: string,
): CatchupTask {
  const d = life.draw;
  const s: LoanCashState = moment.state;
  const piOf = new Map(life.installments.map((i) => [i.due, i.pi]));
  const at = life.receipts.findIndex((r) => r.id === moment.receipt_id);
  const since = addMonths(moment.on, -12);
  const charges: LateChargeRow[] = (s.fees ?? [])
    .filter((f) => f.fee_type === "late_charge")
    .map((f) => ({
      installment_due_date: f.installment_due_date!,
      assessed_on: f.assessed_on,
      amount_cents: f.amount_cents,
      collected_cents: f.collected_cents,
      state: f.state as LateChargeRow["state"],
      installment_pi_cents: piOf.get(f.installment_due_date!)!,
    }))
    .sort((a, b) => (a.installment_due_date < b.installment_due_date ? -1 : 1));
  const installments: Installment[] = sortByDue(s.installments).map((i) => ({
    due_date: i.due_date,
    pi_cents: i.pi_cents,
    escrow_cents: i.escrow_cents,
    status: i.status as Installment["status"],
    satisfied_on: i.satisfied_on ?? null,
  }));
  return {
    ...coords,
    receipt: { payment_id: moment.receipt_id, amount_cents: moment.amount, received_on: moment.on },
    loan_number: d.servicer_loan_number,
    borrowers: d.parties.map((p) => `${p.given_name} ${p.surname}`),
    property_state: d.property.state,
    note: {
      note_date: d.note_date,
      first_payment_due: d.first_due,
      maturity: d.maturity,
      original_balance_cents: d.orig_upb_cents,
      late_charge: {
        pct: d.late_charge.pct,
        grace_days: d.late_charge.grace_days,
        cap_cents: d.late_charge.cap_cents,
        basis: "pi",
      },
    },
    servicing: {
      boarded_on: life.boarded.on,
      transfer_in_on: life.transfer_in_on,
      late_charge: {
        pct: life.boarded.terms.late_charge_pct,
        grace_days: life.boarded.terms.late_charge_grace_days,
        cap_cents: life.boarded.terms.late_charge_cap_cents,
        basis: "pi",
      },
    },
    loan: {
      instrument_date: s.instrument_date,
      lien: "first",
      escrowed: s.escrowed,
      note_rate_pct: rate,
      upb_cents: s.upb_cents,
      lpi_date: s.lpi_date,
      suspense_cents: s.suspense_unapplied_cents,
      late_charges_due_cents: s.late_charges_due_cents,
      partial_count_12m: s.partial_count_12m,
      installments,
    },
    late_charges: charges,
    history: {
      receipts: life.receipts
        .slice(0, at)
        .filter((r) => r.on >= since)
        .map((r) => ({
          payment_id: r.id,
          received_on: r.on,
          amount_cents: r.amount,
          outcome: r.outcome,
          installments_paid: r.installments.map((x) => x.due),
          late_charge_cents: r.late_charge,
          curtailment_cents: r.curtailment,
          to_suspense_cents: r.to_suspense,
        })),
      month_ends: life.months
        .filter((m) => m.as_of < moment.on)
        .slice(-12)
        .map((m) => ({
          month: m.month,
          upb_cents: m.upb,
          next_due: m.next_due,
          days_delinquent: m.days_delinquent,
          late_charges_due_cents: m.late_charges_due,
          suspense_cents: m.suspense,
        })),
    },
  };
}

/** The moment's own guards: a whole-installment catch-up on a loan the engine posts without a logged defect. */
function momentInScope(moment: Extract<LifeMoment, { kind: "receipt" }>, life: LoanLife): boolean {
  const s = moment.state;
  if (moment.credited_as_of !== moment.on) return false;
  if (s.holds.length > 0 || s.trial_active || s.plan_active) return false;
  if ((s.overlays ?? []).length > 0) return false;
  if (s.suspense_unapplied_cents !== 0n) return false;
  if (s.nsf_fees_due_cents !== 0n || s.other_fees_due_cents !== 0n) return false;
  const fees = (s.fees ?? []).filter((f) => f.fee_type === "late_charge");
  if (fees.some((f) => f.state !== "assessed" && f.state !== "collected")) return false;
  // The system's balance is its open charges, as `recordFee` and the posting keep it.
  const open = fees
    .filter((f) => f.state === "assessed")
    .reduce((t, f) => t + f.amount_cents - f.collected_cents, 0n);
  if (open !== s.late_charges_due_cents) return false;
  const row = life.receipts.find((r) => r.id === moment.receipt_id);
  if (!row || row.channel !== "borrower" || row.servicer !== "us") return false;
  return true;
}

/** Whether the task's posting is on the pay-in-full route the rulebook covers. */
export function catchupInScope(task: CatchupTask): boolean {
  const { plan } = postCatchup(task);
  if (task.loan.suspense_cents !== 0n) return false;
  if (plan.installments.length === 0) return false;
  if (plan.installments.some((i) => i.fifty_rule_shortfall_cents !== undefined)) return false;
  if (plan.outcome !== "applied" && plan.outcome !== "prepaid") return false;
  const stillDue = plan.next.installments.some(
    (i) => i.status === "due" && i.due_date <= task.receipt.received_on,
  );
  if (plan.late_charge_cents > 0n && stillDue) return false;
  return plan.next.upb_cents > 0n;
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function catchupFairToGrade(task: CatchupTask): boolean {
  const payload = JSON.parse(JSON.stringify(catchupPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(catchupSteps, payload, executeCatchupTool);
  } catch {
    return false;
  }
  const parsed = parseCatchupSubmission(byRules);
  return parsed.ok && gradeCatchupAgainst(expectedCatchup(task), parsed.answer).pass;
}

/** Whether a task lands where its arm aims. */
export function onArm(arm: CatchupArm, task: CatchupTask): boolean {
  const a = expectedCatchup(task);
  const held = heldToNote(task);
  const breached = capBreached(task);
  if (held.late_charges_due === 0n) return false;
  const { pct } = task.note.late_charge;
  const binds = held.charges.some(
    (x) => lateChargeAmount(x.installment_pi_cents, pct, null) > x.allowed,
  );
  switch (arm) {
    case "breached":
      return (
        breached &&
        a.current_after_posting &&
        a.refund_due_cents === "0" &&
        a.to_suspense_cents !== "0"
      );
    case "breached_refund":
      return breached && a.current_after_posting && a.refund_due_cents !== "0";
    case "breached_behind":
      return breached && !a.current_after_posting;
    case "within_capped":
      return !breached && a.current_after_posting && binds;
    case "within_uncapped":
      return !breached && a.current_after_posting && !binds;
    case "within_behind":
      return !breached && !a.current_after_posting;
  }
}

/** One candidate under one key: the scenario, its decade, and the moment, or null when the draw has none. */
export function drawCatchupCandidate(
  r: Rng,
  id: string,
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): CatchupDraw | null {
  const arm = catchupArmOf(index);
  const twin = arm.startsWith("breached");
  const behind = arm.endsWith("behind");
  const lifeSeed = r.int(0, 0x7fffffff);
  // The breached arm meets its first charge above the cap soon after a transfer boarded the loan without it.
  const transfer = arm === "breached" || r.chance(0.3);
  const transferMonth = r.int(12, 84);
  const missMonth = transfer
    ? transferMonth + r.int(3, 10)
    : r.int(arm === "breached_refund" ? 30 : 6, 100);
  const earlier = arm === "breached_refund" ? missMonth - r.int(6, 24) : null;
  const cap: number | null =
    arm === "within_uncapped" ? (r.chance(0.7) ? null : 5_000) : r.pick(CAPS);
  const events: ScenarioEvent[] = [{ kind: "missed_payment", loan: 0, month: missMonth }];
  if (transfer) events.push({ kind: "transfer_in", loan: 0, month: transferMonth });
  if (earlier !== null) events.push({ kind: "missed_payment", loan: 0, month: earlier });

  const moments = new Map<string, Extract<LifeMoment, { kind: "receipt" }>>();
  let life: LoanLife;
  let clean: LoanLife;
  try {
    const res = generate(
      lifeSeed,
      {
        name: id,
        loans: 1,
        random: { payoff: false },
        pins: { 0: { late_charge_cap_cents: cap } },
        events,
      },
      {
        calibration: cal(),
        ...(twin ? { defects: [{ id: "D-03", loans: [0] }] } : {}),
        observe: (_loan, history, m) => {
          if (m.kind === "receipt" && history === (twin ? "twin" : "clean"))
            moments.set(m.receipt_id, m);
        },
      },
    );
    clean = res.clean.loans[0]!;
    life = twin ? res.defective!.loans[0]! : clean;
  } catch (e) {
    // A note whose cap does not bind cannot carry D-03; draw again.
    if (e instanceof RangeError) return null;
    throw e;
  }

  const missedDue = addMonths(life.draw.first_due, missMonth);
  const at = life.receipts.findIndex(
    (x) => x.on > missedDue && x.mode === (behind ? "oldest" : "cure") && x.servicer === "us",
  );
  if (at < 0) return null;
  const row = life.receipts[at]!;
  const moment = moments.get(row.id);
  if (!moment || !momentInScope(moment, life) || !historyInScope(life, at)) return null;
  // One rate for every installment the receipt pays: a payment across an ARM change is posted in two.
  const rates = new Set(row.installments.map((x) => x.rate_pct));
  if (rates.size !== 1 || row.installments.length === 0) return null;
  const task = taskAt({ id, split, suite_seed: suiteSeed, index }, life, moment, [...rates][0]!);
  return { task, life, clean, moment };
}

const ATTEMPTS = 40;

export function drawCatchupTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: CatchupTask; attempts: number } {
  const id = catchupTaskId(split, suiteSeed, index);
  const arm = catchupArmOf(index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const drawn = drawCatchupCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (!drawn) continue;
    const { task } = drawn;
    if (onArm(arm, task) && catchupInScope(task) && catchupFairToGrade(task))
      return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no ${arm} catch-up in ${ATTEMPTS} draws`);
}

export const generateCatchupTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawCatchupTask(split, suiteSeed, index).task;

export function generateCatchupSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): CatchupTask[] {
  return Array.from({ length: n }, (_, i) => generateCatchupTask(split, suiteSeed, i));
}

export const CATCHUP_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples, as tasks ───────────────────────────────── */

const day = plainDate;
/** The spec's fixture loan L-1 (§2.1 example A): $250,000 at 6.500 %, P&I $1,580.17, escrow $612.40, instrument 07/2021. */
const L1_PI = 158_017n;
const L1_ESCROW = 61_240n;
const l1Installments = (paidThrough: string, through: string): Installment[] => {
  const out: Installment[] = [];
  for (let d = day("2026-08-01"); d <= through; d = addMonths(d, 1))
    out.push({
      due_date: d,
      pi_cents: L1_PI,
      escrow_cents: L1_ESCROW,
      status: d <= paidThrough ? "satisfied" : "due",
      satisfied_on: d <= paidThrough ? addDays(d, 2) : null,
    });
  return out;
};

interface SpecCase {
  readonly name: string;
  readonly cap: Cents | null;
  readonly boarded_cap: Cents | null;
  readonly on: string;
  readonly amount: Cents;
  readonly lpi: string;
  readonly upb: Cents;
  readonly through: string;
  readonly charges: readonly Omit<LateChargeRow, "installment_pi_cents">[];
}

const K_CHARGE: Omit<LateChargeRow, "installment_pi_cents"> = {
  installment_due_date: day("2026-09-01"),
  assessed_on: day("2026-09-17"),
  amount_cents: 7_901n,
  collected_cents: 0n,
  state: "assessed",
};

/**
 * Spec §2.7's worked example K on §2.1's fixture L-1: September's installment
 * unpaid at its grace end, 7,901¢ assessed on 2026-09-17. Then the catch-up:
 * on the note as boarded; above a $50.00 cap the system never boarded (D-03);
 * on the same note with its cap boarded; after K's charge was collected in
 * full above that cap and November was missed; and September's installment
 * alone, which leaves the loan behind.
 */
export const CATCHUP_SPEC_CASES: readonly SpecCase[] = [
  {
    name: "Example K, then caught up on 2026-10-05",
    cap: null,
    boarded_cap: null,
    on: "2026-10-05",
    amount: 2n * (L1_PI + L1_ESCROW) + 7_901n,
    lpi: "2026-08-01",
    upb: 24_977_400n,
    through: "2026-11-01",
    charges: [K_CHARGE],
  },
  {
    name: "Example K above a $50.00 cap the system never boarded (D-03)",
    cap: 5_000n,
    boarded_cap: null,
    on: "2026-10-05",
    amount: 2n * (L1_PI + L1_ESCROW) + 7_901n,
    lpi: "2026-08-01",
    upb: 24_977_400n,
    through: "2026-11-01",
    charges: [K_CHARGE],
  },
  {
    name: "Example K on the same note, its $50.00 cap boarded",
    cap: 5_000n,
    boarded_cap: 5_000n,
    on: "2026-10-05",
    amount: 2n * (L1_PI + L1_ESCROW) + 5_000n,
    lpi: "2026-08-01",
    upb: 24_977_400n,
    through: "2026-11-01",
    charges: [{ ...K_CHARGE, amount_cents: 5_000n }],
  },
  {
    name: "K's $79.01 collected above the $50.00 cap, then November missed",
    cap: 5_000n,
    boarded_cap: null,
    on: "2026-12-03",
    amount: 2n * (L1_PI + L1_ESCROW) + 7_901n,
    lpi: "2026-10-01",
    upb: 24_931_831n,
    through: "2027-01-01",
    charges: [
      { ...K_CHARGE, collected_cents: 7_901n, state: "collected" },
      {
        installment_due_date: day("2026-11-01"),
        assessed_on: day("2026-11-17"),
        amount_cents: 7_901n,
        collected_cents: 0n,
        state: "assessed",
      },
    ],
  },
  {
    name: "Example K, September's installment alone",
    cap: null,
    boarded_cap: null,
    on: "2026-10-05",
    amount: L1_PI + L1_ESCROW,
    lpi: "2026-08-01",
    upb: 24_977_400n,
    through: "2026-11-01",
    charges: [K_CHARGE],
  },
];

export function catchupSpecTasks(): CatchupTask[] {
  const terms = (cap: Cents | null) => ({
    pct: "5",
    grace_days: 15,
    cap_cents: cap,
    basis: "pi" as const,
  });
  return CATCHUP_SPEC_CASES.map((c, index) => ({
    id: `${CATCHUP_ENVIRONMENT_NAME}/${CATCHUP_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    receipt: { payment_id: `L-1-${c.on}`, amount_cents: c.amount, received_on: day(c.on) },
    loan_number: "L-1",
    borrowers: ["Fixture Borrower"],
    property_state: "OH",
    note: {
      note_date: day("2021-07-15"),
      first_payment_due: day("2021-09-01"),
      maturity: day("2051-08-01"),
      original_balance_cents: 25_000_000n,
      late_charge: terms(c.cap),
    },
    servicing: {
      boarded_on: day("2021-07-15"),
      transfer_in_on: null,
      late_charge: terms(c.boarded_cap),
    },
    loan: {
      instrument_date: day("2021-07-15"),
      lien: "first",
      escrowed: true,
      note_rate_pct: "6.500",
      upb_cents: c.upb,
      lpi_date: day(c.lpi),
      suspense_cents: 0n,
      late_charges_due_cents: c.charges.reduce(
        (t, f) => t + f.amount_cents - f.collected_cents,
        0n,
      ),
      partial_count_12m: 0,
      installments: l1Installments(c.lpi, c.through),
    },
    late_charges: c.charges.map((f) => ({ ...f, installment_pi_cents: L1_PI })),
    history: { receipts: [], month_ends: [] },
  }));
}
