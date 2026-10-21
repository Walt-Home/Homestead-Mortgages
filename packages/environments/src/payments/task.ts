/**
 * A payments-posting task: one loan's month of payments posted the way the
 * servicing app's cashiering posts them (spec §2.1 receipt and allocation,
 * §2.2 partials and the $50 rule, §2.4 curtailments, §2.7 late charges).
 *
 * The model gets the loan's cash state at the start of the month — its
 * balance and last paid installment, the installments projected, suspense,
 * fees due, the late-charge terms, any hold, trial or overlay — and the
 * month's receipts in the order they arrived. It must run each day's
 * late-charge assessment and post each receipt through the waterfall, and
 * say where every dollar went and where the loan stands at the month's end.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { LoanCashState } from "./ported/types.js";

export const PAYMENTS_ENVIRONMENT_NAME = "payments-posting";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const PAYMENTS_ENVIRONMENT_VERSION = "1.0.0";

export interface Receipt {
  readonly payment_id: string;
  readonly amount_cents: Cents;
  /** Received and credited the same day in v1. */
  readonly received_on: PlainDate;
  readonly designation: "unspecified" | "curtailment";
  readonly curtailment_cents?: Cents;
  readonly instruction_text?: string;
}

export interface PaymentsTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The days posted, both included: the late-charge run and the receipts of each. */
  readonly window: { readonly from: PlainDate; readonly through: PlainDate };
  readonly loan: LoanCashState;
  readonly receipts: readonly Receipt[];
}

export function paymentsPayload(task: PaymentsTask): Record<string, unknown> {
  return plain({ window: task.window, loan: task.loan, receipts: task.receipts }) as Record<
    string,
    unknown
  >;
}

export function renderPaymentsTask(task: PaymentsTask): string {
  return [
    `Post this loan's payments from ${task.window.from} through ${task.window.through}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(paymentsPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_posting.",
  ].join("\n");
}
