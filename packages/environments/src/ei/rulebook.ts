/**
 * The rules a model is given, and graded against.
 *
 * This is the servicing app's early-intervention windows engine (spec §11.1
 * live contact and §11.2 written notice) folded over a loan's history as
 * those sections' state machines run it, with the rules outside the engine
 * beside it: §4.3's assignment under §1024.40, §11.1's D2-2-02 outbound
 * cadence and its Reg F call cap. The grader is the ported engine and those
 * rules, so a sentence here that disagrees with it is a task nobody can
 * pass; the reference policy follows these words through the tools alone
 * and is held to the grader on every generated task. Where the engine, or
 * the servicing app around it, departs from its spec, v1 does not draw the
 * loan (docs/environments.md). Change this text and the environment's
 * version changes with it.
 */

export const EI_RULEBOOK = `# Early-intervention clocks

You say where every early-intervention clock on one mortgage loan stands at the end of as_of: Regulation X's live-contact and written-notice duties (12 CFR 1024.39), each notice's 180-day cycle, the bankruptcy notice, the assigned-contact deadline (12 CFR 1024.40), Fannie Mae's outbound contact cadence (Servicing Guide D2-2-02) and, where the servicer is a debt collector, Regulation F's call cap (12 CFR 1006.14). Follow these rules exactly. Use the tools for every date; never count days in your head.

Conventions:
- Dates are YYYY-MM-DD. "X + n" is date_add with days n, and "X − n" with days −n. Comparing two dates is reading.
- Installments fall due on the 1st of each month. For a due date D, D + 1 is the 2nd of D's month and D + 17 the 18th: reading, not a tool call.
- Everything in the task happened on or before as_of, and as_of is drawn at its end. A deadline passes at the end of its own day: on the deadline day the duty is still due, and it is missed only on a later day.
- An installment is unpaid on day t when its credited_as_of is null or after t. Payments go to the oldest installment first, so credited dates never go backwards. No installment is credited on the day after it fell due.
- A live contact is a contact whose outcome is conversation, outbound or inbound, with either borrower. A voicemail, a no_answer, a busy_or_failed call and anything written is not one.
- No day carries two of these: an installment credited, a live contact, a notice, the petition, the discharge, the cease. No notice, petition or discharge falls on the 2nd of a month.
- "A cease" is the fdcpa_cease_on date. It is given only when loan.debt_collector is true.

## Step 1. The counter

regx_days_delinquent: take E, the earliest due date on or before as_of of an installment unpaid on as_of; it is days_between(E, as_of). It is 0 when there is no such installment (an installment due on as_of itself counts 0 days).

## Step 2. The windows

A window opens for each installment whose due date D is before as_of and which was unpaid on D + 1 (credited_as_of null or after D). It opens on D + 1, before anything else that day. List one per such installment, oldest first. Each window has two legs:
- the live-contact leg, due live_due = D + 36;
- the written-notice leg, due notice_due = D + 45.
Neither deadline ever moves off a weekend or holiday.

### How each leg opens

When loan.principal_residence is false, both legs are not_applicable, and never change. Otherwise, "before" meaning on a day before D + 1:
- a discharge before: both legs exempt_discharge;
- else a petition before: the live leg is exempt_bk; the notice leg is exempt_bk_cease when a cease was received before the petition, and bk_modified_required otherwise;
- else the live leg is exempt_fdcpa_cease when a cease was received before, and open otherwise; the notice leg is satisfied_by_prior_180 when the most recent notice provided before D + 1 has a cycle_end (Step 3) on or after notice_due, and open otherwise.

### Day by day, from D + 1 through as_of

Each day, first: every leg still open whose deadline is before today becomes breached. Then that day's event, if any, changes the legs of every window opened so far:
- Installment D credited on day t: its own window's live leg, if still open, becomes cancelled_paid, and its notice leg, if still open, cancelled_paid. (A leg is still open on day t only if t is on or before its deadline: credited later, the payment changes nothing, and the duty stood.)
- A live contact on day t: every live leg still open becomes satisfied_live. A window that opens after the contact is not touched by it.
- The petition on day t: every live leg still open becomes exempt_bk; every notice leg still open becomes exempt_bk_cease when a cease was received before, and bk_modified_required otherwise.
- A cease on day t: every live leg still open becomes exempt_fdcpa_cease. Notice legs do not change.
- The discharge changes no leg; it decides how later windows open.
- A notice provided on day t is, in this order:
  (a) the notice for every notice leg that is breached (it becomes sent, and notice_late is true) or bk_modified_required (sent, notice_late false);
  (b) the notice for the oldest window whose notice leg is still open (sent, notice_late false);
  (c) and every other notice leg still open becomes satisfied_by_prior_180: it is inside the cycle this notice starts.
A leg that is cancelled_paid, satisfied_live, satisfied_by_prior_180, sent, not_applicable or exempt never changes again; a breached live leg never changes again, and a breached notice leg changes only by (a).

live_late is true when the live leg is breached and a live contact came after its live_due: the duty was met late. It is false otherwise. notice_late is true only when a notice leg was sent by (a) from breached.

## Step 3. The notice cycles

Each notice starts a cycle: cycle_end = provided_on + 180, or provided_on + 190 when its variant is fdcpa. For each notice, oldest first:
- superseded when the next notice was provided before this one's cycle_end;
- else running when as_of is before cycle_end;
- else it was reviewed on cycle_end, with that day's counter: E = the earliest due date on or before cycle_end of an installment unpaid on cycle_end, and days = days_between(E, cycle_end), 0 when there is no E.
  - days 45 or more: repeat_required, next_required_by = cycle_end. repeat is sent when the next notice was provided on cycle_end and late when it was provided after; with no next notice, breached when as_of is after cycle_end, and open when as_of is cycle_end.
  - days under 45, with an E: not_required, next_required_by = E + 45 (for an fdcpa notice, the later of E + 45 and cycle_end), repeat null. The duty has moved to window E's own notice leg.
  - no E: not_required, next_required_by null, repeat null.
next_required_by and repeat are null for a superseded or running cycle. Regulation X tests an fdcpa notice's delinquency 180 days after it and sets the deadline at 190; every loan here gives the same answer on either day.

## Step 4. The bankruptcy notice (bk_notice)

null when there is no bankruptcy or loan.principal_residence is false. Otherwise one notice is owed for the case:
- exempt, with due null, when a cease was received before the petition;
- else, when the borrower was delinquent on petition_on (an installment due before petition_on was unpaid on petition_on): due = petition_on + 45;
- else due = D + 45 for the first window that opened after petition_on (and before any discharge): the first due date missed during the case. With no such window yet: not_yet_required, with due null.
status, when there is a due: the first notice of variant bk provided on or after petition_on; sent when it was provided on or before due, late when after; with none, breached when as_of is after due, and open otherwise.

## Step 5. The delinquencies (episodes)

A delinquency starts on D + 1 for a window D when no installment older than D was unpaid on D (on D itself the borrower was current: its own installment was only just due). That D + 1 is its day_1. It ends on the first later day t, on or before as_of, on which no installment due before t is unpaid on t; ended_on = t. A borrower who pays each installment on the next due date ends one delinquency on that due date and starts the next the day after. List every delinquency, oldest first, with ended_on null for one still running on as_of. For each, D is the due date the day before its day_1.

### continuity (12 CFR 1024.40)

- When loan.principal_residence is false: assign_by null, basis null, status not_required.
- Otherwise: when the first notice provided during the delinquency (on or after day_1, and before ended_on) came before D + 45, assign_by is that notice's provided_on and basis ei_notice; otherwise assign_by = D + 45 and basis day_45.
- status: not_due when the delinquency ended on or before assign_by. Otherwise take the first of assignments on or after day_1 (and before ended_on): met when it is on or before assign_by, late when after; with none, breached when as_of is after assign_by, and open otherwise. A bankruptcy or a cease changes none of this.

### outbound (Fannie Mae D2-2-02, every loan)

- The cadence opens on D + 17. A petition, or a cease, suspends it for good: a delinquency whose day_1 is after either has no cadence (outbound null).
- close is the earliest of ended_on, petition_on and the cease, among those that fall on or after day_1; there is none while the delinquency runs on unsuspended.
- outbound is null when as_of is before D + 17, or close is on or before D + 17.
- Otherwise start_due = next_business_day(D + 36). The attempts are the outbound contacts of every channel but letter (a busy_or_failed call, a voicemail, an sms and an email are all attempts) on or after D + 17 and before close, in order. Walk them with a deadline X, starting at start_due: an attempt after X records X as missed; after each attempt, X becomes next_business_day(attempt + 7). (next_business_day never moves a date earlier, so a next attempt on or before attempt + 7 meets X without the call.)
- At the end of the walk: when the delinquency closed, X is missed too when close is after X, and next_due is null. When it runs on, X is missed when as_of is after X, and next_due is X.
- missed lists every missed deadline, in date order; [] when none was missed.

## Step 6. Reg F's call cap (regf)

null when loan.debt_collector is false. A counted call is an outbound ai_voice or human_voice contact whose outcome is not busy_or_failed and that was not callback_requested. Count each person apart: a co-borrower's calls never count toward the borrower's, nor the borrower's toward the co-borrower's.
- counted_last_7: for each person, the counted calls dated after as_of − 7 (the seven days ending on as_of).
- over_cap: every counted call that is more than the 7th counted call to its person in the seven days ending on its own day (the calls dated after its day − 7, those listed before it and itself), with its on and person, in date order; [] when there is none.

## Submitting

Call submit_clocks once with:
- regx_days_delinquent;
- windows: for each window, due_date, live_due, live, live_late, notice_due, notice and notice_late;
- cycles: for each notice, provided_on, cycle_end, outcome, next_required_by and repeat; [] when there is no notice;
- bk_notice: due and status, or null;
- episodes: for each delinquency, day_1, ended_on, continuity (assign_by, basis, status) and outbound (start_due, missed, next_due) or null;
- regf: counted_last_7 (borrower, co_borrower) and over_cap, or null.
A section given where it is not called for is graded wrong, the same as one left out. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
