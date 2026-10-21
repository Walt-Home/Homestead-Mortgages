/**
 * A lossmit-retention task: one delinquent Fannie Mae loan's complete
 * loss-mitigation application, evaluated on the day it became complete
 * under Fannie Mae's workout hierarchy (Servicing Guide F-2-10), the
 * servicing app's spec §12.2 with its §12.4 forbearance, §12.5 repayment
 * plan and §12.6 payment deferral.
 *
 * The model gets what the evaluator has that day: the loan's payment, its
 * oldest unpaid installment and unpaid late charges; the borrower's hardship,
 * the funds they have to reinstate and the most they say they can pay a
 * month; the forbearance so far and any forbearance asked for; the loan's
 * workout history; the deferral's advances and escrow shortage; whether the
 * Flex Modification evaluation found the loan eligible; and the dates Reg X
 * runs from. It must work the arrears, walk the hierarchy to the option
 * offered, set that option's terms, and give the decision and acceptance
 * windows.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { ConflictingArrangement } from "./ported/deferral.js";

export const LOSSMIT_ENVIRONMENT_NAME = "lossmit-retention";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const LOSSMIT_ENVIRONMENT_VERSION = "1.0.0";

export type Hardship = "temporary_unresolved" | "resolved" | "permanent";

export interface LossmitTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The day the application became complete, and the day it is evaluated. */
  readonly evaluation_date: PlainDate;
  /** The day the decision notice is provided: mailed, or delivered electronically. */
  readonly notice_provided_on: PlainDate;
  /** The foreclosure sale scheduled when the application became complete, or null. */
  readonly scheduled_sale_on: PlainDate | null;
  /** The property's state, two letters. */
  readonly state: string;
  readonly loan: {
    readonly origination_date: PlainDate;
    readonly maturity_date: PlainDate;
    /** The monthly principal and interest. */
    readonly pi_cents: Cents;
    /** The monthly escrow for taxes and insurance; P&I + escrow is the full contractual payment. */
    readonly escrow_cents: Cents;
    /** One late charge, as the note sets it. */
    readonly late_charge_cents: Cents;
    /** The oldest unpaid installment; installments fall due on the 1st of each month. */
    readonly next_due_date: PlainDate;
    /** Late charges assessed and still unpaid. */
    readonly unpaid_late_charges: number;
  };
  readonly borrower: {
    readonly hardship: Hardship;
    /** What the borrower has to reinstate the loan with. */
    readonly funds_available_cents: Cents;
    /** The most the borrower says they can pay a month. */
    readonly capacity_cents: Cents;
  };
  readonly forbearance: {
    /** Months forborne so far, counted from the start of the initial forbearance plan; 0 for none. */
    readonly forborne_months: number;
    /** The months of forbearance asked for, 1 to 3, or null when none is asked for. */
    readonly requested_months: number | null;
  };
  readonly history: {
    /** Months of P&I deferred by earlier payment deferrals, disaster deferrals left out. */
    readonly cumulative_deferred_months: number;
    /** The effective date of the last payment deferral, not a disaster deferral, or null. */
    readonly last_deferral_effective: PlainDate | null;
    /** The effective date of the last disaster payment deferral, or null. */
    readonly last_disaster_deferral_effective: PlainDate | null;
    /** The last failed non-disaster modification trial, or null. */
    readonly last_failed_trial_on: PlainDate | null;
    /** The effective date of the last non-disaster modification, or null. */
    readonly last_modification_effective: PlainDate | null;
    readonly active_arrangements: readonly ConflictingArrangement[];
  };
  readonly deferral: {
    /** Escrow advances paid to third parties because of the delinquency, before the effective date. */
    readonly escrow_advances_cents: Cents;
    /** Servicing advances paid to third parties and not retained, before the effective date. */
    readonly servicing_advances_cents: Cents;
    /** The shortage the pre-offer escrow analysis found. */
    readonly escrow_shortage_cents: Cents;
    /** Whether the partner's written equal-treatment policy elects a processing month for this case. */
    readonly processing_month_elected: boolean;
  };
  /** What the Flex Modification evaluation found; the flexmod-terms environment grades that. */
  readonly flexmod_eligible: boolean;
}

export function lossmitPayload(task: LossmitTask): Record<string, unknown> {
  return plain({
    evaluation_date: task.evaluation_date,
    notice_provided_on: task.notice_provided_on,
    scheduled_sale_on: task.scheduled_sale_on,
    state: task.state,
    loan: task.loan,
    borrower: task.borrower,
    forbearance: task.forbearance,
    history: task.history,
    deferral: task.deferral,
    flexmod_eligible: task.flexmod_eligible,
  }) as Record<string, unknown>;
}

export function renderLossmitTask(task: LossmitTask): string {
  return [
    `Evaluate this borrower's complete loss-mitigation application on ${task.evaluation_date}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(lossmitPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_evaluation.",
  ].join("\n");
}
