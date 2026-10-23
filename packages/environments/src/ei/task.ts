/**
 * An ei-clocks task: one loan's delinquency picture on one day, as the
 * servicer's early-intervention desk has it, under Regulation X §1024.39
 * (the servicing app's spec §11.1 live contact and §11.2 written notice),
 * §1024.40 (§4.3 continuity of contact), Fannie Mae D2-2-02 (§11.1's
 * outbound cadence) and Regulation F §1006.14 (§11.1's call cap).
 *
 * The model gets the installments with the day each was credited, every
 * contact with the borrowers and its outcome, the written early-intervention
 * notices provided, the days personnel were assigned, any bankruptcy and
 * any written FDCPA cease, and whether the servicer is a debt collector for
 * the loan. It must say where every clock stands: each window's live-contact
 * and notice legs, each notice's 180-day cycle, the bankruptcy notice, each
 * delinquency's assigned-contact deadline and outbound cadence, and the
 * Reg F call count.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { Variant } from "./ported/windows.js";

export const EI_ENVIRONMENT_NAME = "ei-clocks";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const EI_ENVIRONMENT_VERSION = "1.0.0";

export type Person = "borrower" | "co_borrower";
export type Channel = "ai_voice" | "human_voice" | "sms" | "email" | "letter" | "phone";
export type Outcome = "no_answer" | "voicemail" | "busy_or_failed" | "conversation" | "sent";

export interface Contact {
  readonly on: PlainDate;
  /** Outbound: the servicer reached out. Inbound: the borrower called in. */
  readonly direction: "outbound" | "inbound";
  /** Calls are ai_voice or human_voice outbound and phone inbound; sms, email and letter are written. */
  readonly channel: Channel;
  readonly person: Person;
  /** A call: no_answer, voicemail, busy_or_failed (never connected) or conversation. Written: sent. */
  readonly outcome: Outcome;
  /** An outbound call the person asked the servicer to make, within the seven days before it. */
  readonly callback_requested: boolean;
}

export interface EiTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The day the picture is drawn, at its end: nothing after it has happened. */
  readonly as_of: PlainDate;
  readonly loan: {
    /** Secured by the borrower's principal residence (Regulation X's early-intervention rules reach no other). */
    readonly principal_residence: boolean;
    /** The servicer is a debt collector under the FDCPA for this loan. */
    readonly debt_collector: boolean;
  };
  /**
   * Monthly installments due on the 1st, oldest first, through the last due
   * on or before `as_of`. Every installment due before the first was paid on
   * time. `credited_as_of` is the day it was paid in full (payments go to the
   * oldest installment first), or null when it is still unpaid.
   */
  readonly installments: readonly {
    readonly due_date: PlainDate;
    readonly credited_as_of: PlainDate | null;
  }[];
  /** Every contact with a borrower and every attempt at one, in the order they happened. */
  readonly contacts: readonly Contact[];
  /** The written early-intervention notices provided (mailed or delivered), oldest first, and the variant each was. */
  readonly notices: readonly { readonly provided_on: PlainDate; readonly variant: Variant }[];
  /** The days personnel were assigned to the borrower under §1024.40, oldest first. */
  readonly assignments: readonly PlainDate[];
  /** A borrower's bankruptcy case, or null: the petition, and the discharge when there was one. */
  readonly bankruptcy: {
    readonly petition_on: PlainDate;
    readonly discharged_on: PlainDate | null;
  } | null;
  /** The day a written FDCPA §805(c) cease-communication notice was received, or null. */
  readonly fdcpa_cease_on: PlainDate | null;
}

export function eiPayload(task: EiTask): Record<string, unknown> {
  return plain({
    as_of: task.as_of,
    loan: task.loan,
    installments: task.installments,
    contacts: task.contacts,
    notices: task.notices,
    assignments: task.assignments,
    bankruptcy: task.bankruptcy,
    fdcpa_cease_on: task.fdcpa_cease_on,
  }) as Record<string, unknown>;
}

export function renderEiTask(task: EiTask): string {
  return [
    `Say where every early-intervention clock on this loan stands at the end of ${task.as_of}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(eiPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every date, and finish by calling submit_clocks.",
  ].join("\n");
}
