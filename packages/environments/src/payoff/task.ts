/**
 * A payoff-statement task: one Fannie Mae loan's payoff, from the written
 * request to the money owed Fannie Mae, the way the servicing app computes
 * it (its spec §16.1 payoff statement, §7.6's Regulation Z 1026.36(c)(3)
 * clock, §16.2 payoff proceeds, §5.2 rule 6 payoff interest by remittance
 * type).
 *
 * The model gets the written request (when it arrived, the property's state,
 * the statement date and the good-through date it names), the loan's
 * balances and terms on the statement date, its next scheduled installment,
 * the funds that then arrived, and the loan's Fannie Mae terms. It must
 * issue the statement (its deadline, how long it is good, the payoff
 * interest, every component, the total, the per diem, the figure if the
 * next installment posts), reconcile the funds against the exact figure on
 * the payoff date, and split what is owed to Fannie Mae.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { Accrual } from "./ported/quote.js";
import type { RemittanceType } from "./ported/types.js";

export const PAYOFF_ENVIRONMENT_NAME = "payoff-statement";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const PAYOFF_ENVIRONMENT_VERSION = "1.0.0";

export interface PayoffLoan {
  /** Interest-bearing principal only. */
  readonly upb_cents: Cents;
  readonly rate_pct: string;
  readonly accrual_method: Accrual;
  /** The due date of the last paid installment (paid-through + 1 day): interest accrues from it. */
  readonly lpi_due: PlainDate;
  readonly nib_deferred_cents: Cents;
  readonly nib_forborne_cents: Cents;
  readonly late_charges_cents: Cents;
  readonly fees_cents: Cents;
  readonly corporate_advances_cents: Cents;
  readonly escrow_advance_cents: Cents;
  readonly recording_fee_cents: Cents;
  readonly mi_premium_cents: Cents;
  /** Positive amounts the payoff is reduced by. */
  readonly buydown_credit_cents: Cents;
  readonly suspense_credit_cents: Cents;
  /** Refunded separately after the payoff; never netted. */
  readonly escrow_balance_cents: Cents;
}

export interface PayoffTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly request: {
    /** The day the written request arrived: the deadlines run from it. */
    readonly received_on: PlainDate;
    /** The property's state, two letters. */
    readonly state: string;
    /** The statement date. */
    readonly issued_on: PlainDate;
    /** The payoff date the request names; the statement is good through it. */
    readonly good_through: PlainDate;
  };
  readonly loan: PayoffLoan;
  /** The loan's next scheduled installment, or null when the statement has none to consider. */
  readonly next_installment: {
    readonly due_on: PlainDate;
    readonly principal_cents: Cents;
    readonly autodraft: boolean;
  } | null;
  /** Paid by the borrower directly, by wire, credited the day it arrived. */
  readonly funds: {
    readonly received_on: PlainDate;
    readonly amount_cents: Cents;
    /** The due date of the installment after the last paid one: what the non-business-day rule tests. */
    readonly installment_due_on: PlainDate;
  };
  /** The loan's Fannie Mae terms, at 100 % participation. */
  readonly investor: {
    readonly remittance_type: RemittanceType;
    readonly ptr_pct: string;
    readonly mbs_pool: boolean;
    /** The day the payoff is reported to Fannie Mae. */
    readonly reported_on: PlainDate;
  };
}

export function payoffPayload(task: PayoffTask): Record<string, unknown> {
  return plain({
    request: task.request,
    loan: task.loan,
    next_installment: task.next_installment,
    funds: task.funds,
    investor: task.investor,
  }) as Record<string, unknown>;
}

export function renderPayoffTask(task: PayoffTask): string {
  return [
    `Issue the payoff statement for this loan's written request of ${task.request.received_on}, reconcile the funds that arrived on ${task.funds.received_on}, and split what is owed to Fannie Mae.`,
    "",
    PAYLOAD_START,
    JSON.stringify(payoffPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_payoff.",
  ].join("\n");
}
