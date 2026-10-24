# Cross-checking the life generator against the servicing app

The life generator (`packages/environments/src/life`, docs/environments.md,
"The life generator") writes loan histories over the environments' ports of
the servicing app's engines. This page checks those histories against the
servicing app's own code: each generated loan is boarded in the servicing
app, its borrower's receipts are replayed on their dates, the servicing app's
per-loan cycles run every day, and the two records are compared month by
month. It is phase 2 of the plan "Building the Gym on synthetic servicing
data" (its sections 3 and 8). The servicing app is a second implementation
here, not an authority: each disagreement is triaged as a generator bug, a
defect in the servicing app, or the harness's own doing.

Run on 23 October 2026, against life 1.0.0 and the servicing app at the commit
`apps/servicing/VENDORED_FROM` names. Every figure on this page is that run's.
Life 1.1.0, the calibration reader merged the same day, draws every book
differently, so the same seeds now draw other books; the two-hour batch has not
been rerun on it, and `report` and `loan` refuse a run drawn under another life
version than the generator's.

## At a glance

- **178 loans, 3,503 loan-months, 3,240 receipts, 111,334 loan-days** (about
  305 loan-years, drawn under life 1.0.0) stepped through the servicing app's
  own cycles, in eight processes over two hours.
- **Wherever no defect stood between them, the two agree on every figure of
  money, to the cent.** On the fields no defect had reached by their date,
  every receipt's split (2,431 of 2,431), every installment (2,619 of 2,619),
  every late charge assessed, and every month-end balance, suspense and
  late-charge ledger figure (2,603 of 2,603) agree. So do the Metro 2 account
  status, amount past due and current balance.
- **Every one of the 14,764 disagreeing fields is triaged.** 9,583 fall to
  five defects already logged in docs/servicing-engine-defects.md
  (cashiering-19, cashiering-18, cashiering-11, boarding-6 and metro2-1),
  3,594 to three that are not, and 1,587 to the harness. Two more logged
  defects, boarding-4 and boarding-2, were worked around before the first
  unit ran. One logged defect is on both sides: on a transfer the generator
  uses the engine's own transfer shield, which cashiering-11 says spares too
  much, while the runtime never sets it at all.
- **Three defects in the servicing app's runtime that are not logged, all in
  credit reporting.** Its monthly Metro 2 builder never carries the prior
  month, so the payment history profile never fills, and the date of first
  delinquency moves later each time a borrower who stays behind pays an
  installment. It counts only posted payments, so a receipt held in suspense
  is reported as no payment. And a transferred loan's history from the prior
  servicer never reaches it, so a first month with no receipt of the
  servicing app's own reports no date of last payment.
- **Two generator bugs, neither in a figure an environment grades.** The MIN's
  check digit is drawn at random, so 188 of 216 generated MINs fail Mod-10;
  and 2,311 of 16,704 active month-ends (13.8 %) have no next due date,
  because the borrower paid the next installment early and the generator
  creates the one after it only the next month. The tape's half of the second
  is fixed on main since this run (below).
- **The path is a check, not a generator.** About 0.4 seconds per loan-day per
  process on a loaded machine, rising as the database's records grow: a
  thousand loan-decades would take two days. The generator writes them in
  3.5 seconds.

## What was compared

From the day a loan reaches the servicing app to the end of its window (24
months, or the month its process reached its deadline):

| Field                                                                | Generator                                      | Servicing app                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `receipt.posted`, `.outcome`                                         | the receipt row's outcome                      | the payment record's status and `allocation_outcome` (2.1's posting)   |
| `receipt.installments`                                               | the installments the receipt satisfied         | the `payment.applied` events                                           |
| `receipt.interest`, `.principal`, `.escrow`, `.split_by_installment` | each installment's split                       | the payment's allocation and each `payment.applied`                    |
| `receipt.late_charge`, `.curtailment`, `.to_suspense`                | the receipt row                                | the payment's allocation                                               |
| `installment.amount`, `.status`, `.satisfied_on`, `.credited_as_of`  | the installment ledger, as of the window's end | `loan_installments`                                                    |
| `late_charge.assessed`, `.assessed_on`                               | the late-charge runs                           | the `fees` records                                                     |
| `month.upb`, `month.suspense`                                        | the month-end                                  | `loanCashStateFromRows`, read on the 1st after the day's units         |
| `month.late_charges_owed`                                            | the month-end                                  | the cash state's figure, from the fee rows, which cashiering acts on   |
| `month.late_charges_ledger`                                          | the month-end                                  | the loan's `late_charges` ledger balance                               |
| `metro2.*`, eleven Base-segment fields                               | the month-end's rendered record                | `metro2RecordsFromTypedRows`, the monthly unit's own builder, rendered |
| `metro2.min_present`                                                 | always                                         | whether the record the unit builds carries the MIN                     |

The eleven Metro 2 fields are the account status, the payment history
profile, the amount past due, the current balance, the scheduled monthly
payment, the actual payment amount, the date of first delinquency, the date
of last payment, the terms duration, the interest type and the special
comment. A receipt or an installment is compared once; a month-end field once
a month.

Not compared: the escrow balance and its disbursements; the escrow analyses
themselves (the servicing app has no runner for them, so the harness copies
their outcome, below); mortgage insurance; contacts; the early-intervention
clocks the delinquency counters keep; and anything before a loan reaches the
servicing app.

## How it runs

`apps/servicing/scripts/cross-check-life.mts` is the harness. It refuses any
database not named `hm_xcheck_<short>`.

```bash
# once: a migrated template; each run clones it
SERVICING_DATABASE_URL=postgresql://homestead_mortgages:homestead_mortgages@localhost:5433/hm_xcheck_tpl \
  node apps/servicing/scripts/run.mjs db-setup
npx tsx apps/servicing/scripts/cross-check-life.mts run --db hm_xcheck_o1 --seed 101 --loans 24 \
  --months 24 --boarding origination --deadline 6600 --out o1.json
npx tsx apps/servicing/scripts/cross-check-life.mts report --out report.json o1.json …
npx tsx apps/servicing/scripts/cross-check-life.mts loan o1.json <loan id> [from] [to]   # one loan, both sides
```

**The book.** `generate` draws each process's book, in one of two shapes:

- **origination**: every loan is ours from its first payment. It is boarded
  on its note date through the transfer route, with the note's balance, its
  first payment as the next due date, and no prior history.
- **book**: each loan reaches us by transfer at an age drawn from the
  calibration's `book.loan_age_distribution`. The tape is cut from the
  generator's month-end before the transfer: the balance, the next due date,
  the P&I and escrow payment, suspense, the late charges owed, the escrow
  balance, and the prior servicer's last twelve installments and receipts.

Every loan is fixed-rate: a boarded ARM gets no change schedule (arm-15), so
every adjustment would disagree by construction. Payoffs and transfers out
are off, since neither is a cycle the harness steps. Everything else draws
from the calibration, and each loan is also scripted by its index modulo
eight: nothing; a missed payment; two in a row; a miss cured by a kept
promise; a miss with a broken promise; two misses and a four-month repayment
plan; a tax reassessment with bill pay sending the old amount once; an
insurance increase and a later miss. The 3,240 receipts compared were 2,752
regular, 142 cures, 78 paying the oldest installment only, 80 with a
curtailment, 69 under a plan, 30 partials and 29 remainders, 23 short by $50
or less, 20 kept promises and 17 stale bill-pay amounts. The generator
assessed 549 late charges and the servicing app 755.

**Boarding.** Through `boardTransferBatch`, the route `POST
/v1/transfers/batches` and harness-35-5's `boardTapeLoan` take, one batch per
loan, at 14:00Z on the day it reaches us. What boarding leaves out, the
harness adds after it, and each run's output names each one under
`workarounds`:

- the P&I and T&I custodial accounts. A transfer board opens only the
  clearing account, so no payment could post (boarding-4);
- a borrower party. A transfer board writes none, so the Metro 2 builder
  would find no consumer (boarding-2);
- the note's dollar late-charge cap, on 27 loans, written onto `loan_terms`.
  The tape has no column for it (docs/synthetic-data-defects.md, D-03);
- each escrow analysis's new escrow payment, written onto the schedule's due
  rows on the analysis's date. The analysis cycle has no runner
  (`domain/operations-runtime/cycles.ts:285`). This is the "escrow column
  only" change the schedule's reprojection rule describes, and every
  installment's amount then agreed (3,500 of 3,500);
- MI, VA and MA, which the shop's default license list leaves out (HF-020),
  passed on the batch;
- a MIN whose check digit passes Mod-10 (HF-008), where the generator's does
  not (below).

**Stepping.** Every day at noon Eastern, the instant the demo clock's day step
uses, each loan's cashiering unit runs (35.5 rule 6: post what was received,
then the late-charge run), then the delinquency counters. On the 1st the
harness reads the month that ended from the servicing app's rows and runs the
monthly Metro 2 unit inside a `cycles.run_unit`-shaped command. At 17:00:30Z
the day's receipts are written through the cash-rows port, so a receipt on
day D posts in day D+1's unit, before D+1's late-charge run. That is the
generator's order, where the late-charge run comes before the day's receipts.
This path is the one a speed measurement of 22 October 2026 used, and it
reproduced the 397-day runtime simulation's record of its scripted loan
exactly. Nothing else runs: no planner, executor, timer sweep, ops steward or
shop-wide pass.

## Scale and speed

**Measured first.** A loan-year on this path, before the main batch:

| Run                            | Loans | Loan-days | Wall  | Seconds per loan-day | Load average (1 min) |
| ------------------------------ | ----- | --------- | ----- | -------------------- | -------------------- |
| one loan, five months          | 1     | 150       | 14 s  | 0.091                | 28 to 26             |
| origination, a year            | 4     | 1,219     | 205 s | 0.168                | 24 to 25             |
| book, a year (beside the last) | 4     | 1,221     | 243 s | 0.199                | 24 to 41             |
| origination, a year, scripted  | 8     | 3,281     | 497 s | 0.151                | 19 to 69             |
| book, a year, scripted         | 8     | 2,717     | 499 s | 0.184                | 19 to 69             |

**The main batch.** Eight processes, each on its own database: four
origination books of 24 loans and four transfer books of 30, each loan for up
to 24 months, each process stopping at the first month-end after 6,600
seconds. The origination books are o1 to o4, seeds 101 to 104; the transfer
books are b1 to b4, seeds 201 to 204; each reruns from its seed with the
commands above under life 1.0.0, and draws another book under a later
version. The transfer books boarded 83 of their 120 loans before their
deadlines, one of them on the day its process stopped, so 82 were compared; 37
were never reached, and none was refused at boarding.

| Process  | Loans compared | Loan-days | Wall             | Cashiering | Delinquency counters | Month-ends and Metro 2 |
| -------- | -------------- | --------- | ---------------- | ---------- | -------------------- | ---------------------- |
| o1 to o4 | 96             | 60,985    | 7,316 to 7,366 s | 63 to 89 % | 7 to 34 %            | 1.1 to 1.4 %           |
| b1 to b4 | 82             | 50,349    | 7,210 to 7,286 s | 60 to 85 % | 11 to 37 %           | 1.5 to 1.9 %           |

The walls include about 31 minutes in which the machine was suspended (the
load log has no sample from 17:30:43Z to 18:01:47Z). Without it, a process
stepped a loan-day in 0.36 to 0.44 seconds. The machine was shared: the
one-minute load average, sampled every minute, ran from 13 to 164, with a
median of 36, on ten cores. Cost per loan-day rose as the records grew: in
the origination books, with 22 to 24 loans live, it went from 0.16 to 0.23
seconds in the loans' first months to 0.43 to 0.53 a year later, though the
load moved too. The records that matter are the database's, not only the
loan's: each cashiering unit finds its own decision by a subject that
`agent_decisions` has no index on
(`domain/operations-runtime/cashiering-cycle.ts:301`; the table's one index
is on the loan, `db/migrations/0001_baseline.sql:385`), so it reads every
decision of every loan in the database.

At about 20 loan-days a second across eight processes, a thousand
loan-decades (3.65 million loan-days) would take two days of wall clock, and
longer as the loans age. The path checks the generator; it cannot replace it.

## Agreement per field

"Clear" counts only the fields no defect had reached by their date: before
the first assessment the generator's transfer shield spared, before the first
receipt that took a late charge the servicing app had already been paid,
before a plan's suspended charge, and never on a transfer that carried late
charges.

| Field                              | Agree         | Rate   | Clear         |
| ---------------------------------- | ------------- | ------ | ------------- |
| `receipt.posted`                   | 3,237 / 3,240 | 99.9 % | 2,431 / 2,431 |
| `receipt.outcome`                  | 3,212 / 3,240 | 99.1 % | 2,431 / 2,431 |
| `receipt.installments`             | 3,018 / 3,240 | 93.2 % | 2,431 / 2,431 |
| `receipt.interest`                 | 3,012 / 3,240 | 93.0 % | 2,431 / 2,431 |
| `receipt.principal`                | 3,012 / 3,240 | 93.0 % | 2,431 / 2,431 |
| `receipt.escrow`                   | 3,202 / 3,240 | 98.8 % | 2,431 / 2,431 |
| `receipt.split_by_installment`     | 3,012 / 3,240 | 93.0 % | 2,431 / 2,431 |
| `receipt.late_charge`              | 3,053 / 3,240 | 94.2 % | 2,431 / 2,431 |
| `receipt.curtailment`              | 3,234 / 3,240 | 99.8 % | 2,431 / 2,431 |
| `receipt.to_suspense`              | 3,089 / 3,240 | 95.3 % | 2,431 / 2,431 |
| `installment.amount`               | 3,500 / 3,500 | 100 %  | 2,619 / 2,619 |
| `installment.status`               | 3,468 / 3,500 | 99.1 % | 2,619 / 2,619 |
| `installment.satisfied_on`         | 3,282 / 3,500 | 93.8 % | 2,619 / 2,619 |
| `installment.credited_as_of`       | 3,282 / 3,500 | 93.8 % | 2,619 / 2,619 |
| `late_charge.assessed`             | 3,291 / 3,503 | 94.0 % | 2,603 / 2,603 |
| `late_charge.assessed_on`          | 3,291 / 3,503 | 94.0 % | 2,603 / 2,603 |
| `month.upb`                        | 3,275 / 3,503 | 93.5 % | 2,603 / 2,603 |
| `month.suspense`                   | 3,352 / 3,503 | 95.7 % | 2,603 / 2,603 |
| `month.late_charges_owed`          | 1,230 / 3,503 | 35.1 % | 1,225 / 2,603 |
| `month.late_charges_ledger`        | 2,952 / 3,503 | 84.3 % | 2,603 / 2,603 |
| `metro2.min_present`               | 0 / 3,503     | 0 %    | 0 / 2,603     |
| `metro2.account_status`            | 3,385 / 3,503 | 96.6 % | 2,603 / 2,603 |
| `metro2.payment_history_profile`   | 96 / 3,503    | 2.7 %  | 96 / 2,603    |
| `metro2.amount_past_due`           | 3,301 / 3,503 | 94.2 % | 2,603 / 2,603 |
| `metro2.current_balance`           | 3,275 / 3,503 | 93.5 % | 2,603 / 2,603 |
| `metro2.scheduled_monthly_payment` | 1,916 / 3,503 | 54.7 % | 1,494 / 2,603 |
| `metro2.actual_payment_amount`     | 3,457 / 3,503 | 98.7 % | 2,576 / 2,603 |
| `metro2.date_of_first_delinquency` | 3,276 / 3,503 | 93.5 % | 2,563 / 2,603 |
| `metro2.date_of_last_payment`      | 3,471 / 3,503 | 99.1 % | 2,585 / 2,603 |
| `metro2.terms_duration`            | 3,503 / 3,503 | 100 %  | 2,603 / 2,603 |
| `metro2.interest_type_indicator`   | 3,503 / 3,503 | 100 %  | 2,603 / 2,603 |
| `metro2.special_comment`           | 3,503 / 3,503 | 100 %  | 2,603 / 2,603 |

The cash state's late charges owed disagrees even on clear fields, because
cashiering-19 is a field-level class: the figure goes wrong at the first
charge paid, before any receipt pays it again. The payment history profile
agrees only in the first month-end of each of the 96 loans boarded at
origination, which have no history yet.

Of the 178 loans, 133 agree on every receipt, installment, late charge,
month-end balance, suspense and ledger figure, and Metro 2 status, amount
past due and current balance from boarding to the end of their window: 89 of
the 96 boarded at origination and 44 of the 82 boarded by transfer. Of the
loans scripted with a repayment plan, 7 of 26 do.

## Disagreement classes

Each disagreement is classed by `report`. A field is put in a class of its
own when its signature names it (a missing MIN, a profile of 24 B's, a
cash-state figure the ledger contradicts). Otherwise it follows from the
roots its loan had reached by its date, and is named by all of them: a
late charge assessed where the generator's shield spared one (cashiering-11),
a transfer that carried late charges (boarding-6), a plan's suspended charge
(cashiering-18), and the first receipt that took more late charges than the
servicing app had ever assessed (cashiering-19). A loan's later receipts,
installments, balances and Metro 2 status follow from its first root, so they
are counted under it rather than as findings of their own. Every class below
was read by hand, on at least one loan with `loan` or, for the harness's, in
the code.

| Class                                               | Triage      | Fields | Loans | Example                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment history and DOFD without a prior month      | new (below) | 3,516  | 178   | o1 LN-6e9cb854-00000, January 2027: the generator's profile `0BBB…`, the servicing app's 24 B's                                                                                                                                                                                    |
| metro2-1                                            | logged      | 3,503  | 178   | every month-end: the record the unit builds has no MIN, and validation leaves the loan out (K3_MIN_MISSING); the unit sent files with no records in every month                                                                                                                    |
| cashiering-19, alone                                | logged      | 1,555  | 117   | o1 LN-6e9cb854-00001, August 2026: the charge was paid, the ledger reads 0, the fee row still reads `assessed`, and the cash state reads $59.26 due                                                                                                                                |
| cashiering-18 with cashiering-19                    | logged      | 1,949  | 9     | o1 LN-6e9cb854-00005: on 1 June 2027 a plan payment took $116.10 of charges where the generator took $77.40 (May's charge was suspended under the plan); on 1 July it took $135.44 more, for charges already paid; August's installment went unpaid and the loan read 30 days late |
| scheduled monthly payment                           | harness     | 1,587  | 138   | o1 LN-6e9cb854-00000, November 2027: $3,838 against $3,811, the boarded escrow                                                                                                                                                                                                     |
| boarding-6, alone or with cashiering-11, -18 or -19 | logged      | 1,967  | 32    | b1 LN-4ee506e5-00000: the tape owed one $95.30 charge; on 1 November 2030 the generator's receipt paid five charges ($476.50) and the servicing app's four ($381.20), the rest to suspense                                                                                         |
| cashiering-11, alone or with -18 or -19             | logged      | 552    | 8     | b1 LN-4ee506e5-00026, boarded 1 December 2028: January's installment was missed inside the 60-day window; the generator's shield spared the charge, the servicing app assessed $219.56, and it stayed a receivable the generator never had                                         |
| cashiering-18, alone                                | logged      | 57     | 9     | o3 LN-709cbb7a-00021, 1 September 2026: a plan payment took $302.04 of charges where the generator took $201.36                                                                                                                                                                    |
| Held receipt not reported                           | new (below) | 74     | 39    | o1 LN-6e9cb854-00013, September 2027: $2,937 received against $649 reported                                                                                                                                                                                                        |
| Transfer history not reported                       | new (below) | 4      | 4     | b1 LN-4ee506e5-00022, December 2027: last paid 26 November to the prior servicer, reported as never                                                                                                                                                                                |

All 14,764 disagreeing fields are classed; none is left unclassified. Five
first read as unclassified: four were two cashiering-11 charges whose grace
ended on a weekend, so the run fell after the date the triage first gave them
(it now dates a charge by its run), and one was the first transfer-history
case, which became its own class.

**What the logged defects cost here.**

- **cashiering-19** reaches more loans than any other defect in money: 131
  of 178 carry a late charge that was paid and still reads due. On the loans
  where a receipt then paid it again, the borrower's money went to the charge
  instead of the installment, the next installment went unpaid, another
  charge was assessed, and the loan read delinquent to the bureaus while the
  generator's read current.
- **cashiering-18** is logged for forbearance and bankruptcy. A repayment
  plan is a third case of the same lines: the cycle's cash state hard-codes
  `overlays: []` and `plan_active: false`
  (`domain/operations-runtime/cashiering-cycle.ts:153-154`), so the plan's
  `repayment_plan_pending_waiver` overlay can never reach 2.7. The harness
  records no plan in the servicing app; it could not reach the cycle if it
  did.
- **cashiering-11** has two halves, and the two sides here each take one.
  The engine shields every installment due inside the 60 days after a
  transfer, paid or not (`latecharges.ts:83`), and the generator sets that
  shield on every transfer (`simulate.ts:1486` in life 1.0.0). The
  runtime's cash state never sets it, so the servicing app charges every
  installment in the window that is paid after grace. The spec shields only
  a payment the prior servicer received on time. In the example the
  borrower paid no one for January, so by the spec the servicing app's
  $219.56 is due and the generator's zero is the engine's error. Neither
  side is right on a forwarded payment the old servicer received on time,
  which the generator draws only when a scenario asks for one.
- **boarding-6**: 32 of the 82 transfers compared carried late charges. The
  cash state never sees them, so the servicing app never collects them, and
  the money the borrower sends for them goes to suspense or to the next
  installment.
- **metro2-1**: all 344 monthly units sent files with no records. The
  comparison reads the records the unit built before validation left them
  out.
- **boarding-4 and boarding-2** were worked around before the first unit
  ran, so they show in no field. Without the first, no receipt would have
  posted.

## New defects

None is filed in docs/servicing-engine-defects.md; each is described here
with where it is.

**The Metro 2 builder never carries the prior month.**
`metro2RecordsFromTypedRows` builds each loan's state with `prior: null`
(`apps/servicing/src/domain/operations-runtime/runners.ts:144`; its comment at
`:123` calls it the boarding hand-off "until 8.1's prior-cycle snapshot lands
as a typed row"). `carryPhp` returns 24 B's for a null prior
(`domain/credit-reporting/metro2.ts:65`), so every loan's payment history
profile is empty in every month: 3,407 of 3,503 month-ends disagree, and the
96 that agree are the first month-ends of loans with no history yet.
`deriveDofd` keeps an earlier date of first delinquency only from the prior
snapshot (`metro2.ts:105`), so with none the date restarts at the oldest
unpaid installment each month. A
borrower who pays one installment a month while staying behind is re-aged
every month: b1 LN-4ee506e5-00025 fell behind on 1 December 2028 and stayed
behind into July 2029, rising from 30 to 120 days; the generator reported
1 December 2028 throughout, and the servicing app moved the date to
1 January, then 1 March, then 1 April 2029. The engine's own rule is that the
date is "never moved later while the same delinquency continues"
(`metro2.ts:98-99`), and 8.1-T14 blocks such a move without evidence. 109
month-ends disagree this way with the account status agreeing. Impact: high
once metro2-1 is fixed, because a re-aged date of first delinquency moves
when the delinquency leaves a consumer's credit report.

**A receipt held in suspense is reported as no payment.** The builder sums
the month's payments and finds the last payment date over
`status === "posted"` records only (`runners.ts:137-139`). A partial or plan
payment the servicing app holds in suspense was received but is not posted, so
the month's actual payment amount leaves it out and the date of last payment
skips it: 74 fields in 48 month-ends on 39 loans. o1 LN-6e9cb854-00005 sent
a $599.86 plan payment on 10 May 2027, held in suspense; May was reported
with an actual payment of $0 and a last payment in February. Impact: medium;
Metro 2 asks for the amount received in the period, and a borrower paying
what they can is reported as paying nothing.

**A transfer's payment history never reaches the bureau record.** Boarding
reads the tape's payment history only to seed the delinquency it inherits, by
FIFO (`domain/boarding/service.ts:166`, `:367-371`), and writes no payment
record from it, and the builder reads only the servicing app's own posted
payments (`runners.ts:137-139`). Until the servicing app posts a
receipt of its own, a transferred loan's date of last payment is zero-filled:
4 loans, each in its first month with the servicing app, whose last payment
had gone to the prior servicer. Impact: low; it lasts until the first receipt
posts, but every transferred loan whose first month brings none meets it.

## Generator bugs

Neither touches a figure an environment grades; both were worked around in
the harness, and neither is fixed here. Both still stand in life 1.1.0, but
for the tape row's half of the second (below). Paths are under
`packages/environments/src/life/`, and the lines are life 1.0.0's, the
version this run drew from.

- **The MIN's check digit is random.** `draw.ts:361` writes `"1000001"` and
  eleven random digits, so the eighteenth digit is the Mod-10 check digit only
  by chance: 188 of the 216 MINs drawn fail it. The servicing app's boarding
  gate refuses such a loan (HF-008,
  `apps/servicing/src/domain/boarding/rules.ts:103`), and the harness repairs
  the digit before boarding. The generator's own Metro 2 validation checks
  only that a MIN is present, so its records carry a MIN no MERS lookup would
  accept.
- **A month-end paid ahead has no next due date.** The generator creates each
  installment one month ahead (`simulate.ts:1808`), and a month-end's next due
  date is the oldest open one (`simulate.ts:1697`, `:1776`). When the borrower
  has already paid next month's installment, none is open, and the month-end,
  and so the tape row (`projection.ts:249`), has no next due date: 2,311 of
  16,704 active month-ends. A tape row for an active loan always carries one.
  Main fixed the tape row the same day, in life 1.1.0 (e0aa1f4): the
  projection takes the installment after the one interest is paid to. The
  month-end's own `next_due` is still null there.

The generator also inherits the engine half of cashiering-11 (above): it
shields every installment due in the 60 days after a transfer, paid or not.
That is a logged engine defect, not a generator bug, but the generator walks
into it on every transfer rather than steering around it.

## Harness errors

- **The scheduled monthly payment** (1,587 fields) is the harness's: it
  writes each escrow analysis onto the due rows, and the Metro 2 builder reads
  the terms (`runners.ts:141`), which the harness leaves at the boarded
  figure. The servicing app's own path would move them: an escrow change
  arrives as `loan_terms.versioned`, and the reprojection reactor writes a new
  `loan_terms` version from it (`domain/operations-runtime/installments.ts:298`).
  The harness writes rows instead of raising that event because the
  generator's first month after an analysis can differ from the rest
  (`first_month_payment`), which one terms version cannot carry. Every
  installment's amount agrees.
- **Found and fixed before the main batch.** The first transfer tapes were
  cut from the null next due date above, so a loan whose next installment
  was paid ahead boarded a month behind, and every installment after read as
  paid a month late; the tape now takes the month after the last paid
  installment. The late-charge ledger was read with the sign `balancesOf`
  gives every loan account, so a receivable read negative. Three unlicensed
  states and the MIN check digit refused loans at boarding.
- **Found and fixed in the triage.** A late charge was dated by its due date
  rather than its run, which left four fields unclassified.

## What it means for trusting the generator

- **The money is right wherever the servicing app's own code is.** Away
  from the defects, the generator and the servicing app's cycles agree on
  every receipt's split, every installment, every late charge and every
  month-end balance, over 305 loan-years with misses, cures, partials,
  curtailments, plans, promises and $50 shortfalls. The generator calls the
  same engines through ports held byte-equal to them, and this is the first
  check that its carried state (the borrower, suspense, the fee ledger, the
  schedule, the $50-rule count, the order within a day) matches what the
  servicing app derives from its own rows.
- **Where the two disagree, it is almost always the servicing app's
  runtime.** Every money disagreement traces to cashiering-11, -18 or -19 or
  to boarding-6, and the Metro 2 ones to metro2-1 and the three new defects.
  On cashiering-18, cashiering-19 and boarding-6 the generator does what the
  engine does when it is handed what the runtime drops: the plan's overlay,
  the charge's collection, the tape's charges. On cashiering-11 it does what
  the engine does, which is the
  other half of the same defect: a transferred loan's first two months are
  wrong on both sides, in opposite directions, until the generator shields
  only payments the prior servicer received on time. The servicing app's
  runtime cannot serve as a reference for late charges after one is paid, for
  a transfer's first two months, for a plan, or for anything it reports to a
  bureau.
- **The generator's data has bugs where nothing grades it.** The MIN and the
  next due date are fields a tape writer and a boarding environment will
  read, and the check found both on its first run. The tape writer and the
  transfer package should be checked the same way before they are trusted.
- **What this check does not cover.** ARMs (arm-15 makes the comparison
  meaningless), payoffs, transfers out, mortgage insurance, escrow
  disbursements and analyses, contacts and the early-intervention clocks; a
  loan's months before it reaches the servicing app; and windows longer than
  two years. The escrow analyses are the generator's own composition of the
  engine and are checked by escrow-history and escrow-analysis, not here.
