/**
 * Synthetic tapes, seeded: a refi-review loan written out as a servicer
 * would send it.
 *
 * Each task starts from the loan refi-review would draw under the same
 * coordinates, then writes it as a loan record and a tape observation with
 * the variety a real book has: a date in the record, in the tape's facts, or
 * nowhere; a tape a few weeks older than the review; two valuations of
 * different ages; a PMI rate as a percent or in basis points; a pay string
 * that says late when the dates do not. What the loan then is, and what the
 * review concludes, is never decided here — only by the tape reader and the
 * engine at grading time. A few tapes are left unable to describe their loan
 * at all, because a real book has those too.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  plainDate,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { scheduledUpb, type Observation, type ObservedLoan } from "@hm/refi-review";
import { rngFor, type Rng } from "../rng.js";
import { drawRefiTask } from "../refi/generator.js";
import type { RefiTask, Split } from "../refi/task.js";
import { TAPE_ENVIRONMENT_NAME, TAPE_ENVIRONMENT_VERSION, type RefiTapeTask } from "./task.js";

type Facts = Record<string, string | number | boolean | null>;

export const tapeTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${TAPE_ENVIRONMENT_NAME}/${TAPE_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const firstOfMonth = (d: PlainDate): PlainDate => {
  const { y, m } = parts(d);
  return ymd(y, m, 1);
};
/** Money as a tape carries it: an integer, or the same digits as text. */
const money = (r: Rng, c: bigint): number | string => (r.chance(0.5) ? Number(c) : c.toString());
const yes = (r: Rng) => r.pick(["Y", "y", "Yes", "true", "1"] as const);
const no = (r: Rng) => r.pick(["N", "n", "No", "false", "0"] as const);

/**
 * A refi-review task written out as a record and a tape, drawing the tape's
 * variety from `r`. Exported so a variant can prepare the loan first and
 * still have it written the way every other tape is.
 */
export function tapeOf(base: RefiTask, r: Rng): RefiTapeTask {
  const { id, split, suite_seed: suiteSeed, index } = base;
  const b = base.loan;
  const review = base.review_date;
  const term = b.original_term_months;
  const first = b.first_payment_date;
  const maturity = addMonths(first, term - 1);

  // The tape is a few weeks older than the review, and a late loan's next
  // due date is behind the tape's own date.
  const tapeAsOf = addDays(review, -r.int(0, 45));
  let nextDue =
    b.regx_days_delinquent > 0
      ? firstOfMonth(addDays(tapeAsOf, -b.regx_days_delinquent))
      : addMonths(firstOfMonth(tapeAsOf), 1);
  if (nextDue < first) nextDue = first;
  if (nextDue > maturity) nextDue = maturity;
  const paid = Math.max(0, daysBetween(first, nextDue) > 0 ? monthsFrom(first, nextDue) : 0);
  const upb = scheduledUpb(b.original_upb_cents, b.note_rate_pct, term, paid);

  const facts: Facts = {};
  const where = <T>(choices: readonly (readonly [T, number])[]) => r.weighted(choices);

  // Dates: in the record, in the facts, or nowhere.
  const firstAt = where([
    ["record", 92],
    ["facts", 6],
    ["none", 2],
  ] as const);
  if (firstAt === "facts") facts["first_payment_date"] = first;
  const originatedAt = where([
    ["record", 85],
    ["facts", 10],
    ["none", 5],
  ] as const);
  if (originatedAt === "facts") facts["origination_date"] = b.note_date;
  const maturityAt = where([
    ["facts", 45],
    ["record", 40],
    ["none", 15],
  ] as const);
  if (maturityAt === "facts") facts["maturity_date"] = maturity;
  if (r.chance(0.4)) facts["original_term_months"] = r.chance(0.5) ? term : String(term);
  const nextDueAt = where([
    ["tape", 80],
    ["facts", 12],
    ["none", 8],
  ] as const);
  if (nextDueAt === "facts") facts["next_due_date"] = nextDue;

  // The rate: in the facts, on the tape, or only as whole basis points on the record.
  const rateAt = where([
    ["facts", 75],
    ["tape", 15],
    ["bps", 10],
  ] as const);
  if (rateAt === "facts")
    facts["note_rate_pct"] = r.chance(0.6) ? b.note_rate_pct : Number(b.note_rate_pct);

  // Balances and the payment.
  const noUpb = r.chance(0.015);
  if (!noUpb && r.chance(0.25)) facts["upb_cents"] = money(r, upb);
  if (r.chance(0.5)) facts["original_upb_cents"] = money(r, b.original_upb_cents);
  if (r.chance(0.7)) facts["pi_cents"] = money(r, b.pi_cents);
  if (b.escrow_monthly_cents > 0n) facts["ti_cents"] = money(r, b.escrow_monthly_cents);
  else if (r.chance(0.3)) facts["ti_cents"] = 0;

  // Delinquency: the dates, and sometimes a pay string or status that says late anyway.
  const lateBySaying = b.regx_days_delinquent === 0 && r.chance(0.05);
  const history = "0".repeat(11);
  facts["pay_string"] =
    b.regx_days_delinquent > 0
      ? history + r.pick(["3", "6", "9"])
      : lateBySaying && r.chance(0.5)
        ? history + r.pick(["3", "F", "f"])
        : history + "0";
  facts["mba_delinquency_status"] =
    lateBySaying && facts["pay_string"] === history + "0"
      ? r.pick(["30", "Late", "delinquent 30"])
      : b.regx_days_delinquent > 0
        ? String(b.regx_days_delinquent)
        : r.pick(["Current", "0"]);
  const delinquencyDays =
    b.regx_days_delinquent > 0
      ? r.chance(0.5)
        ? Math.max(0, daysBetween(nextDue, tapeAsOf))
        : null
      : r.chance(0.03)
        ? 30
        : r.chance(0.6)
          ? 0
          : null;

  // Valuations: the one the loan was drawn with, sometimes a second of a different age, and the appraisal.
  const v = b.value_estimate;
  const noValue = r.chance(0.015);
  if (!noValue) {
    const dated = (key: string, date: PlainDate) => {
      if (r.chance(0.9)) facts[key] = date;
    };
    if (v.source === "partner_fmv" || v.source === "partner_bpo") {
      const [valueKey, dateKey] =
        v.source === "partner_fmv" ? ["fmv_cents", "fmv_date"] : ["bpo_value_cents", "bpo_date"];
      facts[valueKey] = money(r, v.value_cents);
      dated(dateKey, v.as_of);
      if (r.chance(0.3)) {
        const [k2, d2] =
          v.source === "partner_fmv" ? ["bpo_value_cents", "bpo_date"] : ["fmv_cents", "fmv_date"];
        facts[k2] = money(r, (v.value_cents * BigInt(r.int(88, 112))) / 100n);
        dated(d2, addDays(v.as_of, r.int(-400, 120)));
      }
    }
    const appraised = (b.original_upb_cents * 1000n) / BigInt(r.int(600, 950));
    facts["appraised_value_cents"] = money(
      r,
      v.source === "partner_appraisal" ? v.value_cents : appraised,
    );
    if (originatedAt !== "facts" && r.chance(0.5)) facts["origination_date"] = b.note_date;
  }

  // Mortgage insurance: a flag, and a rate as a percent or in basis points.
  if (b.mi_status === "bpmi_active") {
    facts["pmi_flag"] = yes(r);
    const pct = r.int(5, 22) * 0.05;
    facts["pmi_rate_pct"] = r.weighted<string | number>([
      [pct.toFixed(2), 50],
      [Number(pct.toFixed(2)), 25],
      [String(Math.round(pct * 100)), 25],
    ]);
  } else {
    if (r.chance(0.7)) facts["pmi_flag"] = no(r);
    if (r.chance(0.1)) facts["pmi_rate_pct"] = "0.50";
  }

  // The flags, each as the tape might say it.
  if (b.bankruptcy_active) {
    if (r.chance(0.5)) facts["bk_status"] = yes(r);
    else {
      facts["bk_filed_date"] = addDays(tapeAsOf, -r.int(30, 700));
      facts["bk_discharged"] = no(r);
    }
  } else {
    if (r.chance(0.5)) facts["bk_status"] = no(r);
    if (r.chance(0.07)) {
      facts["bk_filed_date"] = addDays(tapeAsOf, -r.int(400, 2000));
      if (r.chance(0.55)) facts["bk_discharged"] = yes(r);
      else facts["bk_dismissed_date"] = addDays(tapeAsOf, -r.int(30, 380));
    }
  }
  if (b.foreclosure_referred) {
    if (r.chance(0.5)) facts["fc_status"] = yes(r);
    else facts["fc_referral_date"] = addDays(tapeAsOf, -r.int(10, 300));
  } else if (r.chance(0.5)) facts["fc_status"] = no(r);
  facts["modification_flag"] = b.lossmit_plan_active ? yes(r) : no(r);
  facts["servicing_status"] = b.transfer_out_pending
    ? r.pick(["Transfer pending", "Service Released", "service_released", "SOLD"])
    : r.pick(["Active", "Current", "Servicing"]);
  if (b.amortization === "arm") facts["arm_fixed_period_months"] = r.pick([60, 84, 120]);

  // Occupancy and state: on the record, or only in the facts.
  const occupancyWords = {
    primary: ["Owner Occupied", "Primary Residence", "primary"],
    second_home: ["Second Home", "second home"],
    investment: ["Investment Property", "Investor"],
  } as const;
  const occupancyWord = r.pick(occupancyWords[b.occupancy]);
  const occupancyOnRecord = r.chance(0.85);
  if (!occupancyOnRecord) facts["occupancy"] = occupancyWord;
  const stateOnRecord = r.chance(0.9);
  if (!stateOnRecord) facts["property_state"] = b.property_state;

  const loan_record: ObservedLoan = {
    loan_id: b.loan_id,
    state:
      b.status === "active"
        ? r.chance(0.95)
          ? "monitoring_only"
          : "active"
        : r.pick(["paid_off", "charged_off", "inactive"]),
    rate_type: b.amortization,
    note_rate_bps: Math.round(Number(b.note_rate_pct) * 100),
    term_months: term,
    original_principal_cents: b.original_upb_cents,
    originated_on: originatedAt === "record" ? b.note_date : null,
    first_payment_on: firstAt === "record" ? first : null,
    maturity_on: maturityAt === "record" ? maturity : null,
    occupancy: occupancyOnRecord ? occupancyWord : null,
    property_state: stateOnRecord ? b.property_state : null,
  };
  const tape: Observation = {
    as_of: tapeAsOf,
    status: b.regx_days_delinquent > 0 ? "delinquent" : "current",
    principal_balance_cents: noUpb ? 0n : upb,
    escrow_balance_cents: b.escrowed ? b.escrow_monthly_cents * BigInt(r.int(2, 8)) : null,
    scheduled_payment_cents: b.pi_cents + b.escrow_monthly_cents,
    current_rate_pct: rateAt === "tape" ? b.note_rate_pct : null,
    next_payment_due_on: nextDueAt === "tape" ? nextDue : null,
    delinquency_days: delinquencyDays,
    facts,
  };

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    review_date: review,
    loan_record,
    tape,
    quote: base.quote,
    gate_facts: base.gate_facts,
    exceptions: base.exceptions,
  };
}

/** Whole payments from the first payment to the next due date. */
function monthsFrom(first: PlainDate, nextDue: PlainDate): number {
  const a = parts(first);
  const b = parts(nextDue);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

export function generateTapeTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): RefiTapeTask {
  const id = tapeTaskId(split, suiteSeed, index);
  return tapeOf(drawRefiTask(rngFor(id), id, split, suiteSeed, index), rngFor(`${id}/tape`));
}

export function generateTapeSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): RefiTapeTask[] {
  return Array.from({ length: n }, (_, i) => generateTapeTask(split, suiteSeed, i));
}

/** The held-out suite for refi-tape, fixed like refi-review's. */
export const TAPE_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/** The servicing spec's worked example 1, as a record and a clean tape: the tape reader must give back example 1's row. */
export const tapeSpecTasks = (): RefiTapeTask[] => [
  {
    id: `${TAPE_ENVIRONMENT_NAME}/${TAPE_ENVIRONMENT_VERSION}/spec/0/0`,
    split: "spec",
    suite_seed: 0,
    index: 0,
    review_date: plainDate("2026-10-01"),
    loan_record: {
      loan_id: "example-1",
      state: "monitoring_only",
      rate_type: "fixed",
      note_rate_bps: 700,
      term_months: 360,
      original_principal_cents: 56_500_000n,
      originated_on: "2024-09-18",
      first_payment_on: "2024-11-01",
      maturity_on: null,
      occupancy: "Owner Occupied",
      property_state: "AZ",
    },
    tape: {
      as_of: "2026-10-01",
      status: "current",
      principal_balance_cents: 55_310_641n,
      escrow_balance_cents: 450_000n,
      scheduled_payment_cents: 525_896n,
      current_rate_pct: "7.000",
      next_payment_due_on: "2026-11-01",
      delinquency_days: 0,
      facts: {
        pi_cents: 375_896,
        ti_cents: 150_000,
        fmv_cents: 80_000_000,
        fmv_date: "2026-08-31",
        pmi_flag: "N",
        pay_string: "000000000000",
        mba_delinquency_status: "Current",
        servicing_status: "Active",
      },
    },
    quote: { note_rate_pct: "6.125", source: "spec" },
    gate_facts: { declined_on: null, offered_at: [] },
    exceptions: [],
  },
];
