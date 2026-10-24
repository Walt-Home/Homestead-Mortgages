/**
 * The complaint log: the servicing app's complaint-handling system (spec 4.5,
 * "Complaint handling / UDAAP": the blueprint's "Data/artifacts | Complaint
 * log" and "Systems | Case mgmt"; its `v_complaint_log`), kept beside the
 * contact center's own records. It is read off the contact log, never stored:
 * every complaint an agent logged on a call opens a case, and nothing else does.
 *
 * What a case holds is spec 4.5's handling for a complaint received on a call:
 *
 *   - received on the call's day, by telephone (an oral complaint is a
 *     complaint, 4.5 "Inputs and triggers");
 *   - acknowledged on the call itself: `SM_COMPLAINT_ACK_1BD` is satisfied by
 *     an acknowledgment "any channel; written for written complaints", and the
 *     agent acknowledges it on the call (the writer's `complaint_ack` turn);
 *   - answered in writing within 15 calendar days (`SM_COMPLAINT_RESOLVE_15`,
 *     "aligned to CFPB 15 days"), by the response letter the spec names,
 *     `NTC_COMPLAINT_RESPONSE`.
 *
 * The day the response goes is drawn from a stream keyed by the call, three to
 * eleven days after it and moved to a servicer business day, so it is never
 * past the fifteenth day: a design choice, until a partner's complaint data
 * says how long its team takes. The category is the call's reason in the
 * CFPB's vocabulary (`COMPLAINT_CATEGORY`), or the payment process for a
 * collection call, which has none.
 */

import {
  addDays,
  rollForward,
  servicer as servicerCalendar,
  type PlainDate,
} from "@hm/kernel/calendar";
import { rngFor } from "../rng.js";
import { COMPLAINT_CATEGORY } from "./derive.js";
import type { ContactMode, LoanContacts } from "./types.js";

/** `SM_COMPLAINT_RESOLVE_15`: the written response is due within 15 calendar days of receipt. */
export const COMPLAINT_RESPONSE_DAYS = 15;
/** The days after the call the response goes, before the calendar moves it to a business day. */
const RESPONSE_AFTER: readonly [number, number] = [3, 11];

export interface ComplaintRecord {
  /** The case's id: the call's, with `-C`. */
  readonly id: string;
  readonly contact_id: string;
  readonly loan_id: string;
  readonly received_on: PlainDate;
  readonly channel: ContactMode;
  /** The CFPB's mortgage category the complaint is filed under. */
  readonly category: string;
  /** The acknowledgment, given on the call. */
  readonly acknowledged_on: PlainDate;
  /** The fifteenth calendar day after receipt. */
  readonly respond_by: PlainDate;
  /** The day the written response was mailed. */
  readonly responded_on: PlainDate;
  readonly response: "NTC_COMPLAINT_RESPONSE";
}

/** Every complaint logged on a loan's calls, oldest first, as the complaint system holds it. */
export function complaintLog(loan: LoanContacts, centerKey: string): ComplaintRecord[] {
  return loan.contacts
    .filter((c) => c.complaint_logged)
    .map((c) => {
      const r = rngFor(`${centerKey}/${loan.loan_id}/complaint/${c.id}`);
      const responded = rollForward(
        addDays(c.on, r.int(RESPONSE_AFTER[0], RESPONSE_AFTER[1])),
        servicerCalendar,
      );
      return {
        id: `${c.id}-C`,
        contact_id: c.id,
        loan_id: loan.loan_id,
        received_on: c.on,
        channel: c.mode,
        category: c.reason ? COMPLAINT_CATEGORY[c.reason][0] : "payment_process",
        acknowledged_on: c.on,
        respond_by: addDays(c.on, COMPLAINT_RESPONSE_DAYS),
        responded_on: responded,
        response: "NTC_COMPLAINT_RESPONSE" as const,
      };
    });
}
