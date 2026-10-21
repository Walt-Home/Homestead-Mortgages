/**
 * A flexmod-terms task: one delinquent Fannie Mae loan evaluated for a Flex
 * Modification (Servicing Guide F-1-27, D2-3.2-06), the servicing app's
 * §12.8.
 *
 * The model gets what the loss-mitigation analyst has on the evaluation
 * date: the loan's balances and arrears, its rate and remaining term, the
 * property's current value, the pre-modification payment, the Modification
 * Interest Rate table, the loan's history of modifications and failed
 * trials, and what the trial-plan notice will carry. It must decide whether
 * the loan is denied before the waterfall, run the waterfall's five steps,
 * decide eligibility, and for an offer set the trial plan and the
 * modification's dates.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const FLEX_ENVIRONMENT_NAME = "flexmod-terms";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const FLEX_ENVIRONMENT_VERSION = "1.1.0";

export interface FlexTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly evaluation_on: PlainDate;
  readonly loan: {
    readonly ib_upb_cents: Cents;
    readonly accrued_interest_cents: Cents;
    readonly escrow_advances_cents: Cents;
    readonly servicing_advances_cents: Cents;
    readonly prior_nib_cents: Cents;
    readonly buydown_funds_cents: Cents;
    readonly value_cents: Cents;
    readonly contract_rate_pct: string;
    readonly is_arm_not_final: boolean;
    readonly remaining_term_months: number;
    readonly pre_mod_pi_cents: Cents;
    readonly delinquent_31_plus: boolean;
  };
  readonly mir_table: readonly { readonly effective: PlainDate; readonly rate_pct: string }[];
  readonly prior_modifications: number;
  readonly last_trial_failed_on: PlainDate | null;
  readonly trial: {
    readonly notice_sent_on: PlainDate;
    readonly ti_monthly_cents: Cents;
    readonly escrow_shortage_cents: Cents;
  };
}

export function flexPayload(task: FlexTask): Record<string, unknown> {
  return plain({
    evaluation_on: task.evaluation_on,
    loan: task.loan,
    mir_table: task.mir_table,
    prior_modifications: task.prior_modifications,
    last_trial_failed_on: task.last_trial_failed_on,
    trial: task.trial,
  }) as Record<string, unknown>;
}

export function renderFlexTask(task: FlexTask): string {
  return [
    `Evaluate this loan for a Fannie Mae Flex Modification on ${task.evaluation_on}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(flexPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_evaluation.",
  ].join("\n");
}
