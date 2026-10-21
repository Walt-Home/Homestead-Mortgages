/**
 * An arm-adjustment task: one adjustable-rate loan on one change date,
 * adjusted the way the servicing app's ARM engine adjusts it (its spec §7.2,
 * Regulation Z §1026.20(c); and §7.3, §1026.20(d), on the first change).
 *
 * The model gets what the servicer has boarded and recorded on the day the
 * change is worked: the note's ARM terms (index, margin, look-back, change
 * dates, caps, rounding, interest-only period), the loan's current rate and
 * payment and the schedule basis the last change left, the index as
 * published around the index date, and the date the notice would be sent.
 * It must find the index, set the new rate and payment, and say which
 * notice goes, when its window is, and whether the proposed send date is
 * inside it; on the first change, also the initial notice's duty and
 * window. Not given: the index date, the first new payment's due date, the
 * remaining term, the expected balance, or any window.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const ARM_ENVIRONMENT_NAME = "arm-adjustment";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const ARM_ENVIRONMENT_VERSION = "1.0.0";

export type IndexType = "SOFR_30D_AVG" | "TERM_SOFR_12M_PLUS_SPREAD" | "CMT_1Y" | "COFI";
export type RoundingRule = "nearest_eighth_half_down" | "nearest_eighth_half_up";

/** The boarded terms and current state, in the servicing app's `loan_terms` names (ops-7-2.ts:113-129). */
export interface ArmLoan {
  readonly loan_id: string;
  readonly fnma_arm_plan: string | null;
  readonly index_type: IndexType;
  readonly margin_pct: string;
  readonly lookback_days: number;
  readonly first_change_date: PlainDate;
  readonly adjustment_period_months: number;
  readonly initial_cap_pct: string;
  readonly periodic_cap_pct: string;
  readonly lifetime_cap_pct: string;
  readonly initial_note_rate_pct: string;
  readonly rounding_rule: RoundingRule;
  readonly original_upb_cents: Cents;
  readonly first_payment_due: PlainDate;
  readonly term_months: number;
  readonly consummation_date: PlainDate;
  /** The §1026.20(d) disclosure at consummation was an estimate. */
  readonly initial_disclosure_estimate: boolean;
  readonly interest_only_until: PlainDate | null;
  readonly escrow_cents: Cents;
  readonly fdcpa_cease_on_file: boolean;
  readonly fdcpa_debt_collector: boolean;
  readonly current_rate_pct: string;
  readonly current_pi_cents: Cents;
  /** The expected-balance basis: what the last change left (makeEffective, ops-7-2.ts:484), or the note on the first. */
  readonly schedule_basis: {
    readonly upb_cents: Cents;
    readonly rate_pct: string;
    readonly pi_cents: Cents;
    readonly from_due_date: PlainDate;
  };
}

export interface IndexPrint {
  readonly effective_date: PlainDate;
  readonly value: string;
}

export interface ArmTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly change_date: PlainDate;
  readonly loan: ArmLoan;
  /** The index as published, oldest first, running past the index date. */
  readonly index_series: readonly IndexPrint[];
  /** The day the notice would be sent (or put in the mail). */
  readonly proposed_send_on: PlainDate;
}

export function armPayload(task: ArmTask): Record<string, unknown> {
  return plain({
    change_date: task.change_date,
    loan: task.loan,
    index_series: task.index_series,
    proposed_send_on: task.proposed_send_on,
  }) as Record<string, unknown>;
}

export function renderArmTask(task: ArmTask): string {
  return [
    `Work this loan's interest-rate change on ${task.change_date}, and check the notice proposed for ${task.proposed_send_on}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(armPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_adjustment.",
  ].join("\n");
}
