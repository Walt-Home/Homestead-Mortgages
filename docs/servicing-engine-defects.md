# Defects in the servicing app's engines

These are defects in the servicing app's own engines, found while building the
environments in `packages/environments` that grade with them, and each was
reproduced again on 21 October 2026 against the commit
`apps/servicing/VENDORED_FROM` names (`293261b`, committed 17 September 2026).
One more, boarding-1, was found and reproduced on 22 October 2026 while
cataloguing defects for synthetic data (docs/synthetic-data-defects.md).
Eight more are in the runtime that wires the engines together rather than in
an engine: cashiering-18, arm-15, payoff-19, statements-1, boarding-2,
metro2-1, ei-1 and ei-2. They came from running the servicing app's runtime
for 397 simulated days on a scratch database on 22 October 2026, and each was
reproduced in isolation the same day, with none of that run's own choices, and
upheld by two independent checks.
The environments keep all but one out of grading. pmi-9 is graded, because
the spec states the engine's reading as its own rule. Four more
(cashiering-4, cashiering-9, flexmod-1, flexmod-2) were graded at the
engine's reading until payments-posting 1.1.0 and flexmod-terms 1.2.0 kept
them out; docs/decisions.md, "Five departures the environments graded,
decided", says why each went the way it did.

## The list

| ID            | Area       | Defect                                                                                               | Breaks                                 | Impact | Where                                                                                           |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| cashiering-1  | cashiering | A curtailment, or the last installment, takes the balance below zero                                 | §2.4 payoff gate; 2.4-T10              | 🔴     | `domain/cashiering/allocation.ts:176` (gate only at :131-132)                                   |
| arm-1         | arm        | An adjustment can run before its index date and is then locked on the stale print                    | §7.2 rule 1; C-2.2-01                  | 🔴     | `domain/notices/ops-7-2.ts:328-333`                                                             |
| pmi-1         | pmi        | The HPA scheduled-80% cancellation path is never tested                                              | §10.1 R3; 12 U.S.C. 4901(2)(A)(i)      | 🔴     | `domain/pmi/cancellation.ts:147-149`; `app/tools/section10.ts:48`                               |
| pmi-5         | pmi        | A request under 24 months is sent for a paid valuation before seasoning is checked                   | §10.1 R7; F-1-02                       | 🔴     | `domain/pmi/cancellation.ts:144`                                                                |
| pmi-6         | pmi        | A paid valuation below original value asks for another, and no denial can issue                      | §10.1 R6; §10.6                        | 🔴     | `domain/pmi/cancellation.ts:154-155`                                                            |
| cashiering-18 | cashiering | Forbearance and bankruptcy never reach the cashiering cycle, so their late charges are assessed      | §2.7 rule 3(ii), (iv); §14.1 rule 4    | 🔴     | `domain/operations-runtime/cashiering-cycle.ts:112`, `:153-154`                                 |
| arm-15        | arm        | A boarded ARM never gets its change schedule, so no adjustment or (c) notice can run                 | §7.2 inputs; Reg Z 1026.20(c)(2)       | 🔴     | `runtime/transfers.ts:141-150`, `:194-197`; `domain/notices/ops-7-2.ts:167-170`                 |
| payoff-19     | payoff     | The borrower's own payoff quotes use ten times the rate, no late charges and a calendar LPI          | §16.1 rules 1, 6, 11; 1026.36(c)(3)    | 🔴     | `runtime/borrower/flows/9-servicing-requests.ts:94`, `:188-198`                                 |
| statements-1  | statements | No statement cycle is ever opened for a boarded loan, so no periodic statement is sent               | §7.1 events and rule 1; 1026.41(a)(2)  | 🔴     | `domain/notices/ops-7-1.ts:74`; `domain/operations-runtime/cycles.ts:223-230`                   |
| boarding-2    | boarding   | A transfer-boarded borrower never gets a party, so no statement, 1098 or bureau record reaches them  | 1026.41(a); §7.1 rule 11; C-4.1-01     | 🔴     | `runtime/transfers.ts:190`; read at `runtime/servicing-parties.ts:16-22`                        |
| cashiering-2  | cashiering | The $50 rule can book negative escrow                                                                | §2.2 rule 2                            | 🟡     | `domain/cashiering/allocation.ts:114`                                                           |
| cashiering-3  | cashiering | Named extra principal is credited to escrow, or parked, when the rest is short of a payment          | §2.4 rules 1-2; §2.5 example I         | 🟡     | `domain/cashiering/allocation.ts:137-158`                                                       |
| cashiering-4  | cashiering | One suspense balance shields several installments from late charges                                  | §2.7 rule 1; 2.7-Q1                    | 🟡     | `domain/cashiering/latecharges.ts:65-66`                                                        |
| cashiering-5  | cashiering | A payoff designation, or the curtailment gate, drops the funds from the cash state                   | §2.1 rules 5 and 8; C-1.1-01           | 🟡     | `domain/cashiering/allocation.ts:91`, `:102-105`                                                |
| cashiering-6  | cashiering | Fee, escrow, trial and reinstatement designations are not read                                       | §2.1 rule 6; §2.7 rule 4               | 🟡     | `domain/cashiering/allocation.ts:148-165`                                                       |
| cashiering-7  | cashiering | Late charges are paid before the arrears                                                             | §2.1 rule 5; §2.2 rule 4               | 🟡     | `domain/cashiering/allocation.ts:194-200`                                                       |
| cashiering-8  | cashiering | Designated principal prepays future installments                                                     | §2.4 rules 2-3; §2.5 example I         | 🟡     | `domain/cashiering/allocation.ts:137-143`                                                       |
| cashiering-9  | cashiering | A curtailment-designated payment on a current loan is curtailed whole, and the installment goes late | §2.4 rule 2; F-1-09                    | 🟡     | `domain/cashiering/allocation.ts:131`                                                           |
| cashiering-11 | cashiering | The transfer shield spares any installment due in its window, paid or not                            | §2.7 rule 3(i); Reg X 1024.33(c)(1)    | 🟡     | `domain/cashiering/latecharges.ts:83`                                                           |
| cashiering-12 | cashiering | A forbearance plan payment is held as a partial, with the hold notice                                | §2.1 rule 5; §2.2 edge cases           | 🟡     | `domain/cashiering/allocation.ts:148-164`                                                       |
| cashiering-13 | cashiering | A hold or a trial without its overlay does not stop a late charge                                    | §2.7 rule 3(iv) and (vii); §2.6 rule 3 | 🟡     | `domain/cashiering/latecharges.ts:82-91`                                                        |
| cashiering-14 | cashiering | Trial payments are never applied on the posting path                                                 | §2.6 rule 2; C-1.1-02                  | 🟡     | `domain/cashiering/allocation.ts:99`                                                            |
| cashiering-15 | cashiering | An expired forbearance overlay hides a later active one                                              | §2.7 rule 3(ii)                        | 🟡     | `domain/cashiering/latecharges.ts:84-85`                                                        |
| arm-2         | arm        | The LAR 83 deadline runs from the run date, not the index date                                       | §7.2 LAR 83 timer (BD5)                | 🟡     | `domain/notices/ops-7-2.ts:344`                                                                 |
| arm-3         | arm        | A (c) notice over 31 days late is held, and the adjustment never takes effect                        | §7.2 decision 5; Reg Z 1026.20(c)(2)   | 🟡     | `domain/notices/ops-7-2.ts:451-453`                                                             |
| arm-4         | arm        | A late notice on a rate decrease defers the lower payment                                            | §7.2 decision 5; C-2.1-01              | 🟡     | `domain/notices/ops-7-2.ts:452`, `:483`                                                         |
| arm-7         | arm        | A due day after the change day counts a payment twice, more at each change                           | §7.2 rule 3                            | 🟡     | `domain/notices/ops-7-2.ts:315`                                                                 |
| arm-10        | arm        | The send check passes a Reg Z notice before the index date                                           | §7.2 sendable window                   | 🟡     | `domain/notices/arm.ts:76-80`                                                                   |
| arm-13        | arm        | The note's floor and payment cap are dropped                                                         | §7.2 data model                        | 🟡     | `domain/notices/ops-7-2.ts:145-146`, `:341-342`                                                 |
| payoff-1      | payoff     | Full months of interest are rounded one by one                                                       | §16.1 rule 3; §16.2 rule 4             | 🟡     | `domain/payoff/quote.ts:17`; `domain/investor/remittance.ts:60`                                 |
| payoff-2      | payoff     | The month walk drifts for due days 29 to 31                                                          | §16.1 rule 2                           | 🟡     | `domain/payoff/ops-16-1.ts:42`; `domain/payoff/quote.ts:15`; `domain/investor/remittance.ts:57` |
| payoff-3      | payoff     | A rate segment re-runs the 30/360 walk inside itself                                                 | §16.1 rule 4                           | 🟡     | `domain/payoff/ops-16-1.ts:77-84`; `domain/payoff/quote.ts:80`                                  |
| payoff-5      | payoff     | The "if it posts" figure on a loan behind drops the arrears' interest                                | §16.1 rule 7                           | 🟡     | `domain/payoff/ops-16-1.ts:60`; `domain/payoff/quote.ts:77`                                     |
| payoff-6      | payoff     | A late payment within tolerance is recorded short, with no paid-in-full date                         | §16.2 rule 2                           | 🟡     | `domain/payoff/ops-16-1.ts:162-170`                                                             |
| payoff-11     | payoff     | The S/A half month is rounded twice                                                                  | §5.2 rule 2; §16.2 rule 4              | 🟡     | `domain/investor/remittance.ts:52-53`                                                           |
| payoff-14     | payoff     | A daily-simple loan's Fannie Mae share collects 30/360 interest                                      | §16.1 rule 2; §16.2 rule 4             | 🟡     | `domain/payoff/remit.ts:19`; `domain/payoff/ops-16-2.ts:169-185`                                |
| payoff-15     | payoff     | The S/S BD1/BD2 exception never checks the payoff month                                              | §16.2 rule 4; F-1-20                   | 🟡     | `domain/payoff/ops-16-2.ts:157-161`                                                             |
| flexmod-2     | flexmod    | An ARM's modified rate is not capped at its lifetime cap or final step                               | §12.8 step 2; F-1-27                   | 🟡     | `domain/lossmit/flexmod.ts:27`                                                                  |
| flexmod-3     | flexmod    | Most eligibility criteria are unchecked, and a disaster Flex Mod is denied for prior modifications   | §12.8 eligibility; D2-3.2-06           | 🟡     | `domain/lossmit/ops-12-8.ts:152-155`                                                            |
| flexmod-7     | flexmod    | The conversion re-run is never fed, and does not lock the rate                                       | §12.8 rule 4                           | 🟡     | `domain/lossmit/ops-12-8.ts:320-324`                                                            |
| escrow-1      | escrow     | A multi-year premium is disbursed in full every year                                                 | §3.2 R1; Reg X 1024.17(c)(9)           | 🟡     | `domain/escrow/analysis.ts:161-164`                                                             |
| escrow-2      | escrow     | A biweekly projection drops a disbursement on the year's last day                                    | §3.2 R2; 3.2-T16                       | 🟡     | `domain/escrow/analysis.ts:15-18`, `:36-39`                                                     |
| pmi-2         | pmi        | An odd-term midpoint terminates a month late                                                         | §10.3-Q1; 12 U.S.C. 4902(c)            | 🟡     | `domain/pmi/schedule.ts:86-89`                                                                  |
| pmi-3         | pmi        | The denial's renewal date disagrees with the history test                                            | §10.1 R5; §10.6                        | 🟡     | `domain/pmi/denial.ts:33`                                                                       |
| pmi-7         | pmi        | Value-check options for two to four units are wrong                                                  | §10.1 R6; F-1-02                       | 🟡     | `domain/pmi/cancellation.ts:154`; `app/tools/section10.ts:150`                                  |
| pmi-10        | pmi        | The decision due date ignores the valuation's delivery                                               | §10.1 timers; B-8.1-04                 | 🟡     | `domain/pmi/cancellation.ts:124-127`                                                            |
| pmi-11        | pmi        | The midpoint moves with an ARM reset                                                                 | §10.3                                  | 🟡     | `app/tools/section10.ts:236`, `:272`                                                            |
| pmi-14        | pmi        | The midpoint termination is skipped for loans outside the 78% rule                                   | §10.3; B-8.1-04                        | 🟡     | `app/tools/section10.ts:251`                                                                    |
| boarding-1    | boarding   | A yes-or-no tape cell other than "Y" boards as No, so a loan written "Yes" boards with no escrow     | §1.1 integrations (row-level rejects)  | 🟡     | `domain/boarding/tape-codec.ts:49`; HF-007 at `domain/boarding/rules.ts:94-98`                  |
| metro2-1      | metro2     | The monthly cycle never reads the loan's MIN, so every loan is left out of every bureau file         | §8.1 rules 6 and 9; C-4.1-01           | 🟡     | `domain/operations-runtime/runners.ts:143` (query at :127)                                      |
| ei-1          | ei         | A paid installment does not cancel its Reg X early-intervention clocks, which breach                 | §11.1 rule 1; §11.2; 11.1-T3           | 🟡     | `infra/db/unit-of-work.ts:118-119`; `domain/early-intervention/timers.ts:276`                   |
| ei-2          | ei         | A late payment cancels a breached window, and one contact satisfies every later window               | §11.1, §11.2 state machines; 11.1-T4   | 🟡     | `runtime/delinquency.ts:68-69`, `:87-88`, `:91-92`                                              |
| cashiering-10 | cashiering | A $50-rule payment before its due date is labeled prepaid, and its counter row is skipped            | §2.2 rule 2                            | 🟢     | `domain/cashiering/allocation.ts:203`                                                           |
| cashiering-16 | cashiering | A dispute overlay ignores its start date                                                             | §2.7 rule 3(viii)                      | 🟢     | `domain/cashiering/latecharges.ts:90`                                                           |
| cashiering-17 | cashiering | Instruction text is matched by keyword                                                               | §2.1 rule 6                            | 🟢     | `domain/cashiering/allocation.ts:81`, `:170`                                                    |
| arm-5         | arm        | A two-month adjuster gets the 25-day notice                                                          | Reg Z 1026.20(c)(2)                    | 🟢     | `domain/notices/ops-7-2.ts:192`                                                                 |
| arm-6         | arm        | The error correction books a $0 credit and cannot tell a rate-only error                             | §7.2 rule 8; C-2.2-03                  | 🟢     | `domain/notices/arm.ts:88-92`                                                                   |
| arm-8         | arm        | Rates are compared as text                                                                           | §7.2 rule 6                            | 🟢     | `domain/notices/ops-7-2.ts:436`, `:482`                                                         |
| arm-11        | arm        | The two ARM engines round a negative rate differently                                                | §7.2 rules 2 and 7                     | 🟢     | `domain/notices/arm-verify.ts:40`                                                               |
| arm-12        | arm        | The (d) estimate admits a print 16 business days old                                                 | §7.3 rule 3                            | 🟢     | `domain/notices/ops.ts:184-188`                                                                 |
| arm-14        | arm        | The next change date drifts for change days 29 to 31                                                 | §7.2 input 1                           | 🟢     | `domain/notices/ops-7-2.ts:461`, `:486`                                                         |
| payoff-4      | payoff     | The §7.6 notice carries a second payoff calculator                                                   | §16.1 rules 1-3                        | 🟢     | `domain/notices/payoff-statement.ts:31-37`                                                      |
| payoff-7      | payoff     | An overage up to $1.00 is kept by one layer and refunded by the other                                | §16.2 rule 2                           | 🟢     | `domain/payoff/remit.ts:13-14`                                                                  |
| payoff-8      | payoff     | A short payoff's demand is dated five business days out, not one                                     | §16.2 rule 5                           | 🟢     | `domain/payoff/ops-16-1.ts:168`                                                                 |
| payoff-9      | payoff     | `reconcile()` skips the non-business-day rule                                                        | §16.1 rule 5; F-1-09                   | 🟢     | `domain/payoff/quote.ts:31-34`                                                                  |
| payoff-10     | payoff     | The portable share ignores participation                                                             | §16.2 rule 4                           | 🟢     | `domain/payoff/remit.ts:18`, `:26`                                                              |
| payoff-12     | payoff     | The portable share has no S/A deficit                                                                | §16.2 rule 4                           | 🟢     | `domain/payoff/remit.ts:25`                                                                     |
| payoff-13     | payoff     | The portable share's servicing fee is 0 for S/A and S/S                                              | §16.2 rule 4                           | 🟢     | `domain/payoff/remit.ts:26`                                                                     |
| payoff-16     | payoff     | The A/A removal clock ignores the 17:00 rule on BD2                                                  | §16.2; IRM                             | 🟢     | `domain/payoff/remit.ts:31`                                                                     |
| payoff-17     | payoff     | Lien release deadlines disagree with the §16.3 matrix in eight states                                | §16.3 matrix                           | 🟢     | `domain/payoff/release.ts:15`                                                                   |
| payoff-18     | payoff     | Late-release penalties are wrong in ten states                                                       | §16.3 penalties                        | 🟢     | `domain/payoff/release.ts:18-24`                                                                |
| flexmod-1     | flexmod    | A remaining term above 480 months is kept                                                            | §12.8 step 4; F-1-27                   | 🟢     | `domain/lossmit/flexmod.ts:37`                                                                  |
| flexmod-4     | flexmod    | The failed-trial bar is 365 days, not 12 months                                                      | §12.8 eligibility; D2-3.2-06           | 🟢     | `domain/lossmit/ops-12-8.ts:153`                                                                |
| flexmod-5     | flexmod    | Step 5 solves at a rate rounded to three decimals                                                    | §12.8 step 5(a)                        | 🟢     | `domain/lossmit/flexmod.ts:40`                                                                  |
| flexmod-6     | flexmod    | The MIR lookup has no consistent winner on a tied date                                               | §12.8 rule 1                           | 🟢     | `domain/lossmit/ops.ts:641`                                                                     |
| flexmod-8     | flexmod    | The capitalization date has three answers                                                            | §2.6 rule 5; §12.8                     | 🟢     | `domain/lossmit/flexmod.ts:57`                                                                  |
| escrow-3      | escrow     | A dollar cushion in the instrument overrides the policy and state months                             | §3.4 rule 1                            | 🟢     | `domain/escrow/analysis.ts:25`                                                                  |
| pmi-4         | pmi        | The 78% current test misses an installment due after the 1st                                         | §10.2 R3; B-8.1-04                     | 🟢     | `domain/pmi/termination.ts:15-19`                                                               |
| pmi-8         | pmi        | The HPA decision-date currency test is computed and discarded                                        | §10.1 R1 and R4                        | 🟢     | `domain/pmi/cancellation.ts:49-53`, `:150`                                                      |
| pmi-9         | pmi        | A floored LTV grants a balance up to $39.99 over 80%                                                 | 12 U.S.C. 4901(2)                      | 🟢     | `domain/pmi/cancellation.ts:21`                                                                 |
| pmi-12        | pmi        | New York's appraisal sets the federal thresholds                                                     | §10.1 R2; 12 U.S.C. 4901(12)           | 🟢     | `domain/pmi/cancellation.ts:15`                                                                 |
| pmi-13        | pmi        | An ARM reset inside an interest-only period amortizes at once                                        | §10.2 R2                               | 🟢     | `domain/pmi/schedule.ts:69-74`                                                                  |

🔴 high (10) · 🟡 medium (42) · 🟢 low (30). ei is Reg X early intervention.
Section numbers are the servicing app's spec; paths are under
`apps/servicing/src/`; amounts ending in c are cents. docs/decisions.md tells
the longer story of most of these, in the entry for the environment that found
each. Fixture L-1 is §2.1 worked example A (6.500%, P&I 158,017c, escrow
61,240c, payment 219,257c, installments monthly from 2026-09-01). Plan 4927 is
§7.2's worked example (5.750%, margin 2.750, $400,000, change 2026-11-01,
index date 2026-09-17).

## High

### cashiering-1. A curtailment, or the last installment, takes the balance below zero 🔴

- **Spec says.** §2.4's payoff gate (SM_CURTAILMENT_PAYOFF_ROUTE_GATE,
  2.4-T10) sends a curtailment at or above the balance plus deferred principal
  to payoff, with a payoff statement. The balance never goes below zero.
- **Engine does.** The gate runs only for a receipt designated `curtailment`
  on a current loan with an installment projected. A `curtailment_cents`
  amount, principal in words, a delinquent loan or no projected installment
  all curtail past zero. `applyInstallment` never caps principal at the
  balance, so a loan's last scheduled installment overshoots too. In the
  runtime, an autodraft's extra principal arrives as `curtailment_cents`
  (`domain/operations-runtime/ach.ts:214`) and never meets the gate.
- **Reproduction.** L-1 with UPB 100,000c and 09-01 due, 719,257c on 09-03
  with `curtailment_cents` 500,000: UPB -557,475c. The 219,257c installment
  alone leaves -57,475c.
- **Smallest fix.** Cap each installment's principal at the balance. Move the
  gate from :132 to the remainder step before :176, so every curtailment meets
  it, and park the routed funds (cashiering-5).
- **Kept out by.** payments-posting. `paymentsInScope` rejects a month whose
  final balance is not above zero, and the generator draws curtailments of
  $100 to $8,000 and no non-interest-bearing principal.

### arm-1. An adjustment can run before its index date and is then locked on the stale print 🔴

- **Spec says.** §7.2 rule 1 and its state machine: the index is the latest
  print on or before the index date (the change date less the look-back), and
  the adjustment waits until then. C-2.2-01: an undercharge cannot be
  collected.
- **Engine does.** `calculateAdjustment` never checks that it runs on or after
  the index date, and once an adjustment is verified it refuses to
  recalculate. The early rate reaches the (c) notice, the LAR 83 event and the
  payment-change event, and the early run satisfies the index-capture timer.
- **Reproduction.** Plan 4927 calculated on 2026-08-01 on the 07-31 print
  (2.10000) and verified: 4.875% and
  $2,142.18. The spec gives 6.375% and $2,476.44 on the 09-17 print, and
  recalculation then throws. The 7.2-T5 test itself calculates on 08-01.
- **Smallest fix.** In `calculateAdjustment` (ops-7-2.ts:328), refuse to
  calculate before `row.index_date`.
- **Kept out by.** arm-adjustment. The task has no calculation date, the
  grader takes the print from the index date, and `armInScope` rejects a
  notice proposed before the index date.

### pmi-1. The HPA scheduled-80% cancellation path is never tested 🔴

- **Spec says.** §10.1 R3, B-8.1-04 and 12 U.S.C. 4901(2)(A)(i): on a one-unit
  principal residence or second home the borrower may cancel once the initial
  schedule reaches 80% of original value, whatever the actual balance.
- **Engine does.** Tests only the evaluation balance's LTV.
  `cancellationRequest` (section10.ts:48) never reads `scheduled_upb_cents`,
  and nothing in `domain/pmi/` or the tools calls `scheduledUpb` on a request.
  A borrower carrying deferred or forborne principal is denied.
- **Reproduction.**
  $380,000 at 6.50%, 360 months from 2024-05-01, original value $400,000.
  Request 2034-09-10, after the scheduled 80% date; scheduled UPB 31,882,886c
  (7970 bps); $15,000 deferred, so the evaluation UPB is 33,382,886c:
  ineligible, LTV_ABOVE_THRESHOLD, 8345 bps.
- **Smallest fix.** Carry `scheduled_upb_cents` on `CancellationRequest`, fill
  it from the active schedule in section10.ts, and at cancellation.ts:147-149
  pass the LTV test when the scheduled balance plus forborne principal is at
  or under 80% of original value.
- **Kept out by.** pmi-termination keeps out a request after the scheduled 80%
  date on a one-unit principal residence or second home.

### pmi-5. A request under 24 months is sent for a paid valuation before seasoning is checked 🔴

- **Spec says.** §10.1 R7 and B-8.1-04: the current-value path needs 24
  months' seasoning, absent accepted improvements. F-1-02: the valuation is at
  the borrower's expense.
- **Engine does.** Returns `value_check_needed` (cancellation.ts:144) before
  the seasoning test (:148). The borrower pays $190 to $750 for a valuation
  that cannot help, then is denied on seasoning.
- **Reproduction.** Consummation 2024-03-15, request 2025-02-20 (11 months),
  no valuation: `value_check_needed`, VALUATION_REQUIRED. After a $500,000
  BPO: ineligible, SEASONING_INSUFFICIENT.
- **Smallest fix.** Move the null-threshold test ahead of the null-valuation
  return at cancellation.ts:144.
- **Kept out by.** pmi-termination keeps out a current-value request with no
  threshold and no valuation.

### pmi-6. A paid valuation below original value asks for another, and no denial can issue 🔴

- **Spec says.** §10.1 R6, §10.6 (VALUE_DECLINED_BELOW_ORIGINAL) and B-8.1-04:
  a delivered valuation below original value is a denial within 30 days,
  carrying its result.
- **Engine does.** Returns `value_check_needed` again, and the tool offers the
  same paid products a second time. `composeDenial` refuses an evaluation in
  that state, so the 4904(b) denial clock breaches and the case can only
  expire on the 60-day fee wait.
- **Reproduction.** Original-value path, UPB
  $319,950.95 (7998 bps), AVM $395,000, then a borrower-paid BPO of
  $398,000 against an original value of $400,000: `value_check_needed`,
  VALUE_DECLINED_OR_UNKNOWN.
- **Smallest fix.** At cancellation.ts:154-155, return ineligible with
  VALUE_DECLINED_BELOW_ORIGINAL when a delivered borrower-paid valuation is
  below original value.
- **Kept out by.** pmi-termination keeps out any delivered valuation below
  original value, and since 1.1.0 its rulebook no longer states the engine's
  reading of one.

### cashiering-18. Forbearance and bankruptcy never reach the cashiering cycle, so their late charges are assessed 🔴

- **Spec says.** §2.7 rule 3(ii) and D2-3.2-01: no late charge accrues or is
  collected during a forbearance plan, and §12.4 rule 3 refuses the assessment
  while the plan is active. §2.7 rule 3(iv), 2.7-T8 and §14.1 rule 4: after a
  petition, charges accrue suspended as a memo, with no collection and no
  statement billing (Rule 3002.1(c)). §14.1 rule 1 applies the gates the
  moment a notice is received (E-2.1-03). §14.1 names the wiring:
  `payment_holds{bankruptcy}` and 2.7's `bankruptcy_active` overlay. §35.5
  rule 6 skips the assessment under a `payment_holds` row.
- **Engine does.** The runtime's cash state carries no overlays and no plan
  flag. `loanCashStateFromRows` hard-codes `overlays: []` and `plan_active`
  false (domain/operations-runtime/cashiering-cycle.ts:153-154), so 2.7's
  overlay tests (app/tools/section02.ts:205-209) and its OVERLAYS guardrail
  (:252) never fire. The unit's one suppression is an open `payment_holds` row
  (cashiering-cycle.ts:112, :258), and nothing writes that table: no code
  inserts into it, and no projector maps onto it
  (domain/operations-runtime/projectors/index.ts:14 covers sections 2, 16 and
  21). 17.3's freeze writes an entity-store record of the same name instead
  (app/tools/section17-3.ts:145). What 12.4 and 14.1 do write, cashiering
  never reads. 12.4's term op writes `workout_plans` with
  `late_charges_suppressed` true (app/tools/section12-4.ts:64), and
  `fees.suppress` writes `fee_suppressions` (:163). 14.1's ingest and verify
  write `stay_gates` with `late_charges_blocked` true
  (app/tools/section14-1.ts:75, :84; domain/bankruptcy/ops-14-1.ts:40). 2.7's
  own hand-offs, `forbearanceOpened` and `bankruptcyFiled`
  (domain/cashiering/ops-2-7.ts:127, :212), have no caller outside tests. So
  every installment on a loan in forbearance or bankruptcy is assessed at its
  grace end and booked as a receivable, and a later payment's remainder pays
  it. This also corrects cashiering-13's note, which assumed the runtime skips
  a loan with an open hold: it would, but nothing writes one.
- **Reproduction.** A scratch database with the app's migrations, and four
  copies of L-1 boarded through the transfer path on 2026-08-20. Loan F: 12.4
  `workout_plan.*` offer and term (2026-09-01 to 11-30, payments suspended),
  then `fees.suppress` from 09-01. Loan B: 14.1 `bk.case.read/write`
  ingest_notice on 08-25 and verify (Chapter 13, petition 08-24, stay in
  effect). Units ran on 09-01, 09-17, 10-01 and 10-17, with no payments. F and
  B were each assessed 7,901c on 09-17 and on 10-17: state `assessed`, no
  suppression, 15,802c in `late_charges`, the same as an untouched control
  loan. Their derived state reads `holds` [] and `overlays` []. A 454,316c
  payment on 10-20 sent 15,802c to `late_charges` on both loans. With a
  `payment_holds{bankruptcy}` row inserted by hand, the unit recorded
  `skipped_hold` and assessed nothing. 2.7's `dailyRun` on the same state with
  the overlay added: forbearance `not_assessed`, bankruptcy
  `accrued_suspended`. Two independent checks re-ran it by other paths, the
  whole-book daily run every day from 08-21 to 10-20 and 12.4's
  initial-activation path, with a bankruptcy loan whose notice was ingested
  but not yet verified, and got the same charges. Found by the 397-day runtime
  simulation on 22 October 2026, where the forbearance loan and the bankruptcy
  loan each carried 13 charges, and reproduced the same day.
- **Smallest fix.** In `loanCashStateFromRows`, build `overlays` from the
  loan's records already in the store (cashiering-cycle.ts:99-100).
  `forbearance_active` comes from each active 12.4 `workout_plans` row
  (term_start to current_term_end, `defaulted_on` from a failed plan).
  `bankruptcy_active` comes from `stay_gates` with `late_charges_blocked`,
  starting at the petition date, or at the notice date before verification.
  2.7 then decides as its own tests say.
- **Kept out by.** No environment runs the 35.5 cashiering cycle.
  payments-posting gives 2.7 its overlays directly
  (packages/environments/src/payments/ported/latecharges.ts:148).

### arm-15. A boarded ARM never gets its change schedule, so no adjustment or (c) notice can run 🔴

- **Spec says.** §7.2's first input: "`loan.boarded` with `loan_terms.product
= ARM` → build `arm_schedule` (all change dates to maturity) and schedule
  timers for the next change", with the prerequisite "Boarded ARM terms per
  loan (1.1)". Reg Z 1026.20(c)(2) requires the notice 60 to 120 days before
  the first payment at the adjusted level. C-2.1-01 has the servicer enforce
  each ARM by its note and use its own funds for any shortage from an untimely
  adjustment.
- **Engine does.** The 7.2 tools read the terms from the entity store's
  `loan_terms` record for the loan (domain/notices/ops-7-2.ts:167-170) and the
  schedule from its `arm_schedule` records (:208-211). Only `boardArmTerms`
  writes them (:226-233), and only the spec tests call it
  (domain/notices/7-2.spec.test.ts:61; 7-3.spec.test.ts:56;
  domain/borrower/32-9.spec.test.ts:454). Neither boarding path calls it. The
  transfer seed (runtime/transfers.ts:141-150) and `1.1 boardLoan` on the bus
  (app/tools/section01.ts:108-114) write only the `loan_terms` table row and
  the §35.5 hook, and that row's INSERT drops the tape's
  `arm_next_change_date` (transfers.ts:194-197), which HF-006 required to
  board (domain/boarding/rules.ts:87-92). So `arm.schedule.row_created` is
  never appended, and none of the (c) clocks it triggers arm
  (domain/notices/timers-7-2.ts:12-20), nor SM_ARM_INDEX_CAPTURE_T45. The
  `arm_schedule` table the `arm_changes` cycle selects from stays empty
  (domain/operations-runtime/cycles.ts:248, :294), so that cycle files an
  empty receipt rather than its "no runner" escalation. `computeArmAdjustment`
  on the loan (app/tools/section07.ts:17, :31) throws "no loan_terms for
  <id>". Both writers of a new rate, `makeEffective` (ops-7-2.ts:478-486) and
  the C-2.2-01 correction (:615-616), need the same record, so the loan
  accrues at its boarding rate past every change date, and nothing breaches to
  say so. The 7.3 boarding handler `openInitialFileCheck`
  (domain/notices/ops-7-3.ts:115) is never called either. From reading the
  code, not running it: the 30.2 hand-off writes the same incomplete row
  (runtime/origination.ts:194-199).
- **Reproduction.** On a fresh database with the app's migrations, the demo
  batch was boarded through `boardTransferBatch` at its transfer date,
  2026-09-01: 94 boarded, 11 of them ARMs. For all 11,
  `loan_terms.arm_next_change_date` is null where the tape had a date
  (2027-05-01 to 2029-12-01). There are 0 entity `loan_terms` or
  `arm_schedule` records, 0 `arm_schedule` rows, 0 `arm.schedule.*` events and
  0 ARM clocks. 7.2 `computeArmAdjustment`, run as `disclosures` on TR-0000024
  at its tape change date of 2029-02-01, throws "no loan_terms for <id>".
  Control: the same loan's tape terms passed to `boardArmTerms` in memory,
  with a 6-month period assumed because the tape has none, give 42 rows and
  arm SM_ARM_INDEX_CAPTURE_T45, the 120-day gate and the 60-day deadline; with
  a 3.64883 print on the index date, `calculateAdjustment` gives 4.125% →
  6.125% and P&I 119,612c → 142,158c. On the demo book, TR-0000067's first
  change is 2027-05-01, so its (c) notice is due by 2027-04-02. Two
  independent checks reproduced it on both boarding paths. Found by the
  397-day runtime simulation on 22 October 2026 and reproduced the same day.
- **Smallest fix.** In the boarding transaction on both paths, for each
  boarded ARM, call `boardArmTerms` and `openInitialFileCheck` and persist the
  entity versions and events with the batch, building the terms from the
  staged loan and taking the tape's next change date as the first change.
  Write `arm_next_change_date` in the `loan_terms` INSERT, and write
  `arm_schedule` rows to the table the cycle reads. The tape has no
  change-frequency column (domain/boarding/tape-codec.ts:74-81) and
  `parseArmTerms` requires one (ops-7-2.ts:144), so the tape gains that column
  and HF-006 checks it. That arms the clocks, which then breach visibly; for
  an adjustment to take effect, `arm_changes` also needs its runner
  (cycles.ts:294), because nothing in the runtime calls `openNoticeWindow`,
  `sendAdjustmentNotice` or `makeEffective`.
- **Kept out by.** arm-adjustment gives each task its boarded terms directly
  (packages/environments/src/arm/task.ts:6-10) and never boards a loan. No
  environment boards a transfer.

### payoff-19. The borrower's own payoff quotes misread the record: ten times the rate, no late charges, a calendar LPI 🔴

- **Spec says.** §16.1 rule 1: interest runs from the day after the LPI
  installment's paid-through date, at the loan's rate. Rule 6: the total
  includes unpaid late charges assessed under 2.7. Rule 11: the voice or chat
  agent gives "the same computed figure". A portal request counts as a written
  request (§16.1 Integrations). Reg Z 1026.36(c)(3) requires "an accurate
  statement of the total outstanding balance". §35.8: "The engine's inputs are
  the record's, not the caller's."
- **Engine does.** `computePayoffQuote` takes its inputs from the caller by
  design (app/tools/section16-1.ts:73). The callers that read the record get
  them right: the 35.8 work screen's `derivePayoffQuote`
  (domain/operations-runtime/derivers-35-8.ts:106-119) takes the rate, the LPI
  and the late charges from `loanCashState`, and the 35.10 close-out
  (app/tools/section35-10.ts:236) takes the rate and LPI from it (:99) and the
  late charges from the ledger
  (domain/operations-runtime/closeout-35-10/derive.ts:62). The borrower's own
  paths do not.
  - **The typed request and the spoken quote.** Both go through the 32.9
    flow's `payoffInputs`
    (runtime/borrower/flows/9-servicing-requests.ts:193-198), used at :346-353
    and :409-416. Its `bpsToPct` divides `note_rate_bps` by 1,000 (:94, used
    at :111). Every writer stores the rate × 10,000
    (db/migrations/0001_baseline.sql:147; runtime/transfers.ts:196;
    runtime/origination.ts:198), and every other reader divides by 10,000
    (cashiering-cycle.ts:153). It passes no late charges or fees.
  - **The LPI.** It comes from `paidThrough` (:188-192): the first payment
    date advanced by the payments posted here, then rolled forward to last
    month. On a boarded loan, the loan's installments never move it.
  - **The agent's payoff card.** The 32.16 card
    (app/tools/section32-16.ts:244-252) reads the rate correctly, but takes
    the same LPI and no late charges.
  - **Why the tests pass.** The journey fixture stores its 7% loan as 7000
    (runtime/borrower/fixtures/journey.ts:565), the only writer on the ÷ 1,000
    scale. 32.9-T10 checks the quote's type, not its figure
    (domain/borrower/32-9.spec.test.ts:180).
- **Reproduction.** The demo batch was boarded in-process, and the app's daily
  cashiering unit was run from 11/01 to 11/17 on SM-TR-0000001: $334,084.09 at
  3.750%, installments unpaid from 09/01, LPI 08/01. The unit assessed a
  $191.16 late charge. Quotes on 11/20, good through 12/05:

  | Path                | Rate    | LPI   | Late charge | Total       | Against the work screen |
  | ------------------- | ------- | ----- | ----------- | ----------- | ----------------------- |
  | 35.8 work screen    | 3.750%  | 08/01 | $191.16     | $338,618.59 | —                       |
  | Typed request       | 37.500% | 10/01 | none        | $356,337.30 | $17,718.71 high         |
  | Spoken quote        | 37.500% | 10/01 | none        | $356,337.30 | $17,718.71 high         |
  | Agent's payoff card | 3.750%  | 10/01 | none        | $336,309.41 | $2,309.18 low           |

  The voice agent says the $356,337.30 figure aloud, with a $343.24 per diem.
  The card's $2,309.18 is two months' interest plus the late charge and the
  work screen's $30.00 recording fee. `paidThrough` gives LPI 10/01 whether 0
  or 3 payments have posted since boarding, so once the November payment has
  posted the borrower is charged a month too much. Two independent checks
  reproduced it, one through `flows.message` (the call the borrower API makes)
  and one on a current loan with payments posted, where the extra month of
  interest is real too. The simulation's own quotes (4.000% on a 4.875% loan,
  no late charge) came from its driver's inputs to the tool, not from this
  path.

- **Smallest fix.** Build both borrower paths' inputs from `loanCashState`, as
  `derivePayoffQuote` does: rate ÷ 10,000, LPI from `state.lpi_date`, late
  charges from `state.late_charges_due_cents`. Drop the ÷ 1,000 `bpsToPct` and
  `paidThrough`'s roll forward. Set journey.ts:565 to 70000, and have 32.9-T10
  check the figure.
- **Kept out by.** payoff-statement ports only the §16.1 calculator and draws
  its own inputs; nothing in packages/environments runs the borrower flows.

### statements-1. No statement cycle is ever opened for a boarded loan, so no periodic statement is sent 🔴

- **Spec says.** §7.1: "`statement.cycle.opened` — emitted by the cycle
  scheduler for each loan at 00:05 … on the day after `courtesy_period_end`
  for the previous cycle …; also on `loan.boarded` for the first cycle"
  (7-1-periodic-statement.md:57; rule 1 at :99). §35.3 plans its `statements`
  cycle from that event (35-3-cycles-jobs-and-receipts.md:45, :77). The 41(b)
  timer `REGZ_1026_41B_STATEMENT_PROMPT_4` also arms on it
  (spec/registry/timers.json:4249). Reg Z 1026.41(a)(2) requires a periodic
  statement for each billing cycle, and no exemption in 1026.41(e) applies to
  this book. §35.3's own current-state note records the gap ("Statements and
  1098s have runners but no scheduler", 35-3-cycles-jobs-and-receipts.md:27);
  the cycle was added, but not the opener §7.1 requires.
- **Engine does.** Only two things in the runtime emit the event.
  `StatementCycleService.openCycle` (domain/notices/ops-7-1.ts:74-81) is
  called only by tests (domain/notices/7-1.spec.test.ts:36;
  domain/operations-runtime/35-3.spec.test.ts:141). 30.2's
  `openFirstStatementCycle` (domain/orig-boarding/ops-30-2.ts:657-661, called
  at :846) opens only the first cycle of a loan the app originated. Transfer
  boarding (runtime/transfers.ts) opens no cycle, and nothing opens a second
  cycle for any loan. The `statements` cycle's period keys and selector read
  only that event (domain/operations-runtime/cycles.ts:133-137, :223-230), so
  no run is planned and `statementsRunner` (runners.ts:86-93, registered at
  :248) never runs. The 41(b) clock never arms either, so a loan paid on time
  raises no alarm at all; only an unpaid loan's payment-reminder clock
  (FNMA_D2_2_03_PAYMENT_REMINDER_20) breaches.
- **Reproduction.** A fresh database with the app's migrations and the demo
  transfer batch boarded (94 loans). The demo clock then walked 75 days from
  10 September 2026, with every cycle active and the planner and borrower
  flows wired as `main.ts` wires them: 75 `cashiering_daily` receipts and 94
  installments due on each of 1 October and 1 November, and zero
  `statement.cycle.opened` events, zero `statements` runs, zero statement
  notices and zero 41(b) timers. As a control, one hand call to `openCycle`
  for SM-TR-0000001 armed `REGZ_1026_41B_STATEMENT_PROMPT_4` and
  `SM_STATEMENT_GENERATE_T1`, and on the statement date the cycle planned a
  run and executed its unit. That unit then held the statement for two other
  reasons, not part of this entry: a transfer-boarded borrower has no
  `party_id`, so it has "no recipients" (boarding-2), and the runtime always renders the standard
  template (runtime/servicing.ts:174-175), so a loan more than 45 days
  delinquent is held for its missing (d)(8) box. Two independent checks
  reproduced it, one walking 41 days across two cycles' opening dates with the
  runtime wired as `main.ts` does. In the 397-day runtime simulation the
  `statements` cycle was active, never paused and never ran. Found on 22
  October 2026 and reproduced the same day.
- **Smallest fix.** Add a daily per-loan opener. The `cashiering_daily` unit
  already visits every loan each day and has its installments and grace
  period; on the day after an installment's courtesy period ends, it should
  call `openCycle` with that due date, once per (loan, cycle_due_date).
  Transfer boarding should also open the first cycle on `loan.boarded`, as
  §7.1 says.
- **Kept out by.** No environment produces a periodic statement.

### boarding-2. A transfer-boarded borrower never gets a party, so no statement, Form 1098 or Metro 2 record reaches them 🔴

- **Spec says.** Reg Z 1026.41(a) and §7.1: a periodic statement every
  billing cycle, on paper unless the consumer agreed to e-delivery. The
  small-servicer exemption is closed, so "statements are required on every
  loan"; rule 12 sends to "the borrower of record". §7.1 rule 11 and IRC
  6050H: a Form 1098 to the payer of record by January 31. §8.1 and
  C-4.1-01: "the status of each mortgage loan to each of the four major
  credit repositories" every month. Rule 5 takes the Base segment from "the
  first obligor on the note (`loan_borrowers.position=1`)". The Notice
  Registry addresses parties (§7.1 `notices.recipient_party_ids`,
  `tax_forms_1098.payer_party_id`; §7.4 rule 4, consent per party). §1.1 has
  boarding keep the tape's phone and e-mail (W-001) and write its consents
  with `provenance='transferor'`. §32.14 rule 8 and S6 have a servicing-book
  borrower sign in by "the number on file", with SSN4 and DOB for L2. §34.5
  rule 9(c) shows a boarded borrower without a party as "not yet an
  account", and §34.5 (line 23) and §33.1 (line 14) say the transfer book
  creates no party; both speak of accounts only. §8.1 reads the consumer
  from `borrowers` and `loan_borrowers`, and `parties` only for successors
  (8-1-furnish-tradeline-metro-2.md:57). Nothing makes a statement, a 1098
  or a tradeline wait for a party.
- **Engine does.** `insertBoardingRows` writes the borrower with name, TIN
  last four, language and SCRA flag only: no `party_id`, no date of birth,
  no contact (runtime/transfers.ts:190). The codec decodes the tape's e-mail
  and phone (domain/boarding/tape-codec.ts:252), and the tape has no DOB
  field (domain/boarding/types.ts:60). No consents are written, though
  §1.1 has boarding store the tape's with `provenance='transferor'`. Every
  servicing output finds the borrower through `borrowers.party_id`
  (runtime/servicing-parties.ts:16-22):
  - The statement renders with no recipients, is held "no recipients"
    (notices/service.ts:116), and the unit throws (runtime/servicing.ts:175).
  - The 1098 throws "no borrower party on the loan"
    (runtime/servicing.ts:219).
  - The Metro 2 builder drops the loan as `no_consumer`
    (domain/operations-runtime/runners.ts:132-133) before 8.1 sees it, so
    8.1's `NO_CONSUMER_SEGMENT` exception and its routing never fire
    (domain/credit-reporting/metro2.ts:270).
  - 12.2's denial notice reads the same parties
    (domain/operations-runtime/derivers-35-8.ts:211, :222).

  Nothing can link a party later:
  - The code door links only `application_borrowers`
    (infra/db/borrower-parties.ts:78-83), and boarding left no contact for
    it to find.
  - `party.linkLoan` matches on `b.date_of_birth`
    (app/tools/section32-2.ts:321), which a transfer-boarded row never has.
  - `account.provision` and the partner-book load cover monitored loans only
    (app/tools/section33-1.ts:304; runtime/partner-book.ts:302-304).
  - `linkBorrower` (infra/db/borrower-parties.ts:123) has no caller.

  Originated loans escape, because `servicingParties` also reads
  `application_borrowers.party_id`.

- **Reproduction.** A scratch database, with the demo batch boarded through
  the transfer path.
  - **What boarding wrote.** 94 boarded borrowers, all 94 with no party and
    no DOB; no borrower parties and no consents. Of the 100 tape rows, 74
    carry an e-mail and 98 a phone.
  - **Sign-in, loan A (SM-TR-0000001).** The code door, given the tape's own
    e-mail, made a new party and linked nothing. `party.linkLoan` with the
    tape's SSN last four and the loan's last four (or the ZIP) refused
    `LINK_LOAN_MISMATCH`.
  - **Control, loan B.** Linked to a party through the app's own repository.
  - **Statements.** Both cycles were opened by hand (statements-1) for the
    10-01 due date, and the demo clock walked from 09-10 to 09-21. B's
    statement was mailed 09-17 and both of its clocks were satisfied. A's
    job failed "statement held: no recipients", SM_STATEMENT_GENERATE_T1
    breached 09-17 and REGZ_1026_41B_STATEMENT_PROMPT_4 breached 09-20.
  - **1098, tax year 2026.** B was furnished on paper; A was refused "no
    borrower party on the loan".
  - **Metro 2.** As of 09-30, with `loans.min` supplied (metro2-1): one
    record (B), 93 loans omitted as `no_consumer`, no 8.1 exceptions. The
    cycle validated with one record per bureau.
  - **Positive control.** With a DOB put on A's row, the same
    `party.linkLoan` call linked A at L2, and A came back as recipient and
    consumer.

  Two independent checks reproduced it by other paths: one boarded through
  the bus command `1.1 boardLoan` and ran the real `metro2_monthly` job
  through 35.3's planner, where the 93 party-less loans appear nowhere, not
  even in 8.1's own omitted count; the other started from the app's seed
  entry. One also found 91 tape rows carrying E-SIGN evidence and 83 TCPA
  evidence, and 0 consent rows written. The 397-day simulation database
  shows the same: 92 of 94 boarded borrowers
  with no party, no `statement.sent`, and 0 records in every Metro 2 cycle.
  Found and reproduced on 22 October 2026.

- **Smallest fix.** In `insertBoardingRows`, give each boarded borrower a
  `parties{borrower}` row, as 33.1 rule 3 and
  runtime/partner-book.ts:297-302 do. Use the tape's name and its
  normalized e-mail and phone as `contact`, and link to an existing party
  only on e-mail and name. Insert the borrower with `party_id` set, and
  write the tape's consents on that party with `provenance='transferor'`,
  `verified=false`. Separately, have `metro2RecordsFromTypedRows` pass a
  loan with no consumers to 8.1, so `NO_CONSUMER_SEGMENT` routes it as an
  exception instead of dropping it.
- **Kept out by.** No environment boards a transfer or runs the runtime's
  cycles. metro2-furnishing hands 8.1's engine consumers of its own
  (packages/environments/src/metro2/generator.ts:214).

## Medium

### cashiering-2. The $50 rule can book negative escrow 🟡

- **Spec says.** §2.2 rule 2 applies a payment short by $50 or less in full,
  with the escrow share reduced by the shortfall, on the premise that the P&I
  was received in full.
- **Engine does.** Subtracts the whole shortfall from the escrow share with no
  floor. A shortfall larger than the escrow share books negative escrow and
  moves T&I custodial cash into P&I.
- **Reproduction.** One installment, P&I 158,017c, escrow 3,000c; 157,017c on
  09-08: `applied_with_50_rule`, escrow -1,000c.
- **Smallest fix.** At allocation.ts:152, add
  `shortfall > 0n && shortfall <= inst.escrow_cents` to `eligible`. The `> 0n`
  half also closes cashiering-3.
- **Kept out by.** payments-posting. `paymentsInScope` rejects any installment
  applied with escrow below zero.

### cashiering-3. Named extra principal is credited to escrow, or parked, when the rest is short of a payment 🟡

- **Spec says.** §2.4 rules 1-2 and §2.5 example I: an amount designated as
  principal is a curtailment, applied after the installment it comes with and
  never used to prepay. §2.2's $50 rule is for a positive shortfall.
- **Engine does.** On a current loan with an `unspecified` receipt, when the
  amount less `curtailment_cents` is short of the next installment, the
  $50 rule runs on the whole pool. The named amount is credited to escrow, `partial_count_12m` rises, the receipt is labeled `prepaid`, and nothing is curtailed. Where the $50
  rule is unavailable, the whole receipt is parked as a partial with the hold
  notice. An autodraft with extra principal that settles before its due date
  reaches this.
- **Reproduction.** L-1 current, 250,000c with `curtailment_cents` 100,000 on
  09-20: October prepaid, escrow 91,983c (30,743c over), curtailment 0,
  partial count 0 to 1. Designated `curtailment`, the same receipt curtails
  100,000c.
- **Smallest fix.** Treat `curtailment_cents > 0` as designation `curtailment`
  at the top of `allocate`, as `CashieringService.receive` already does for
  its own event (service.ts:86). Or, in the partial branch
  (allocation.ts:148-165), compute the shortfall on the unreserved pool, run
  the $50 rule only for a positive shortfall, and park only the unreserved
  part.
- **Kept out by.** payments-posting. Its reserved-principal edge always sends
  one or two full payments plus the named amount. `paymentsInScope` alone
  would not catch it, because the engine omits `fifty_rule_shortfall_cents`
  when the shortfall is not positive.

### cashiering-4. One suspense balance shields several installments from late charges 🟡

- **Spec says.** §2.7 rule 1 and decision 2.7-Q1 count suspense attributable
  to an installment toward its grace-end test, and one balance cannot be
  attributable to two installments. (§2.2 example C assesses
  $79.01 with $2,000.00 held, which contradicts 2.7-Q1. That is a spec
  question, not this defect.)
- **Engine does.** Counts the whole suspense balance, capped at the basis,
  toward every unpaid installment's test. Funds parked under a hold, or held
  as a remainder below a payment, count the same way.
- **Reproduction.** L-1 with 158,017c in suspense and 09-01 and 10-01 unpaid:
  both are `not_assessed`, "paid within grace", at 09-17 and 10-17. 10-01
  should be assessed 7,901c.
- **Smallest fix.** In `receivedTowardBasis` (latecharges.ts:65-66), attribute
  suspense oldest first: credit an installment with what remains after the
  bases of earlier unpaid installments, capped at its own basis.
- **Kept out by.** payments-posting, since 1.1.0. `paymentsInScope` runs
  the engine's own `assessLateCharge` a second time, handed the suspense
  attributed oldest first, and rejects a run whose decision changes. The
  generator brings any receipt the engine parks in suspense after the
  window's last run for an installment with another unpaid before it.
  1.0.0 graded the engine's reading. What stays graded is 2.7-Q1's default,
  which the engine documents as its decision: suspense covering the basis
  counts toward one installment's test. So example C, with one installment
  open, is not assessed, and a test holds that.

### cashiering-5. A payoff designation, or the curtailment gate, drops the funds from the cash state 🟡

- **Spec says.** §2.1 rules 5 and 8 and C-1.1-01: every receipt is posted and
  each portion accounted for, and a payoff goes to §16.2. The §2.4 gate routes
  funds; it does not discard them.
- **Engine does.** Returns the held template: the amount is reported as
  `to_suspense_cents`, but the loan's suspense does not rise. When the gate
  fires on a loan already holding suspense, the accumulation row has been
  pushed and suspense zeroed, so that suspense disappears too while
  `suspense_used_cents` reports 0. The ledger keeps the cash, but the cash
  state that every later allocation reads does not, and nothing consumes
  `payment.payoff_routed`.
- **Reproduction.** L-1, 300,000c designated `payoff`: `payoff_routed`,
  `to_suspense` 300,000c, suspense after 0. The next 219,257c receipt pools
  none of it.
- **Smallest fix.** At allocation.ts:91 and :132, park the receipt in the cash
  state as the hold branch at :95 does, and move the accumulation row
  (:102-105) below the gate. In `app/tools/section2-1.ts`, send
  `payoff_routed` to §16.2 instead of the partial branch.
- **Kept out by.** payments-posting never draws a payoff designation or a
  payoff-size curtailment.

### cashiering-6. Fee, escrow, trial and reinstatement designations are not read 🟡

- **Spec says.** §2.1 rule 6: explicit instructions override the default
  order. §2.7 rule 4: late charges are collected from funds designated for
  fees. §2.2: an `escrow_only` payment is not a partial; it takes §3.6's
  lump-sum path.
- **Engine does.** Reads only `payoff`, `curtailment` and `biweekly_half`.
  `fees_only`, `escrow_only`, `trial` and `reinstatement` post as unspecified,
  so a fee or escrow-shortage payment short of a full payment is parked as a
  partial with the hold notice. The borrower app's fee payment (designation
  `mi_valuation_fee`) reaches this today.
- **Reproduction.** L-1 current with 7,901c of late charges due; 7,901c
  `fees_only` on 09-20: `unapplied`, `partial_hold` true, the fee still due.
- **Smallest fix.** After the suspense pooling at allocation.ts:105, add a
  branch: `fees_only` pays late charges, then NSF, then other fees, and parks
  any excess; `escrow_only` credits escrow. Set `partial_hold` only for
  `unspecified` and `contractual`.
- **Kept out by.** payments-posting draws only `unspecified` and `curtailment`
  receipts, and no fee but late charges.

### cashiering-7. Late charges are paid before the arrears 🟡

- **Spec says.** §2.1 rule 5's first clause: late charges receive funds only
  once every installment due is satisfied. §2.2 rule 4: accumulated suspense
  stays unapplied without an instruction. (Rule 5's remainder clause reads the
  engine's way, and the uniform instrument permits it; the spec should pick
  one.)
- **Engine does.** Sends any remainder below a full payment to late charges,
  NSF and other fees with no check that the installments due are paid, and
  folds accumulated suspense into that pool with no instruction.
- **Reproduction.** L-1 with 09-01 and 10-01 due and a 7,901c late charge due;
  300,000c on 10-20 applies 09-01, pays the fee and holds 72,842c while 10-01
  is still due. Expected: no fee paid, 80,743c held.
- **Smallest fix.** At allocation.ts:194, take the fee branch only when no
  installment is still due, and only from the receipt's own funds unless the
  borrower instructed otherwise.
- **Kept out by.** payments-posting. `paymentsInScope` rejects a receipt that
  pays late charges while an installment due is open, or that spends
  accumulated suspense.

### cashiering-8. Designated principal prepays future installments 🟡

- **Spec says.** §2.4 rule 3: on a delinquent loan, curtailment funds cure the
  arrears and then go to principal. §2.4 rule 2: on a current loan, received
  separately, they curtail at once.
- **Engine does.** Reserves only an explicit `curtailment_cents`. A receipt
  designated `curtailment` on a delinquent loan, or principal in words on any
  loan, runs the installment loop: it cures, prepays every future installment
  the pool covers, and curtails what is left.
- **Reproduction.** L-1 with 09-01 and 10-01 due, 700,000c "principal only" on
  10-20: both cured, 11-01 prepaid, curtailment 42,229c. The spec cures both
  and curtails 261,486c.
- **Smallest fix.** In the loop (allocation.ts:138-143), when the receipt
  carries a principal designation or instruction, stop at the first
  installment due after the receipt date, as a reserved amount does.
- **Kept out by.** payments-posting's curtailment and instruction edges keep
  the extra below one payment once the arrears are paid. No `paymentsInScope`
  clause covers it; one training draw reaches it by another branch, and no
  held-out task does.

### cashiering-9. A curtailment-designated payment on a current loan is curtailed whole, and the installment goes late 🟡

- **Spec says.** §2.4 rule 2 and F-1-09: funds received together go to the
  scheduled installment first, then to the curtailment. Only a curtailment
  received separately applies first.
- **Engine does.** Treats any `curtailment` receipt on a loan with nothing due
  by its date as separate, whatever its size. The whole receipt, prior
  suspense included, is curtailed, and the next installment is left unpaid.
- **Reproduction.** L-1 with 09-01 next due, 319,257c designated `curtailment`
  on 08-28 (§2.5 example F six days early): curtailment 319,257c, 09-01 still
  due, assessed 7,901c at the 09-17 run.
- **Smallest fix.** At allocation.ts:131, take the separate branch only when
  the receipt holds no full payment beyond the named amount; otherwise run the
  loop first and curtail the rest. Leave prior suspense out of a separate
  curtailment.
- **Kept out by.** payments-posting, since 1.1.0. `paymentsInScope` rejects
  a separate curtailment (designated principal on a current loan) that
  reaches the next installment's payment or pools earlier suspense. The
  generator draws one below a payment, which no reading of 2.4 rule 2 takes
  for an installment, so it is curtailed at once and still graded. 1.0.0
  graded the engine's reading.

### cashiering-11. The transfer shield spares any installment due in its window, paid or not 🟡

- **Spec says.** §2.7 rule 3(i) and example L: the 60-day transfer shield (Reg
  X 1024.33(c)(1)) protects a payment the old servicer received on time.
- **Engine does.** Returns `not_assessed` for every installment due on or
  before `transfer_shield_until`, with no payment to the old servicer and no
  start date. The runtime's derived cash state never sets the shield, which
  fails the other way.
- **Reproduction.** L-1 with `transfer_shield_until` 2026-10-30 and nothing
  received from anyone: 09-01 and 10-01 are `not_assessed`. Each should be
  7,901c.
- **Smallest fix.** At latecharges.ts:83, drop the bare date test and shield
  only through a `transfer_window_60` overlay naming the installment, written
  when the old servicer reports a payment received before the due date. Update
  `section2.test.ts:279` and 2.7-T4, which assert the current reading.
- **Kept out by.** payments-posting. `paymentsInScope` keeps a shielded
  installment only when the forwarded receipt then satisfies it, as in example
  L.

### cashiering-12. A forbearance plan payment is held as a partial, with the hold notice 🟡

- **Spec says.** §2.1 rule 5 and §2.2's edge cases: a reduced plan payment is
  not a partial. Below a full payment it is held without the 30-day return
  clock.
- **Engine does.** `allocate` never reads `plan_active` or the forbearance
  overlay, so a short receipt under a plan is an ordinary partial with
  `partial_hold` true and the partial-hold notice. The runtime hard-codes
  `plan_active` false (`domain/operations-runtime/cashiering-cycle.ts:153`).
- **Reproduction.** L-1, forbearance overlay 09-01 to 12-31, 79,009c on 09-05:
  `unapplied`, `partial_hold` true. The same with `plan_active` true.
- **Smallest fix.** In the partial branch (allocation.ts:160-164), when
  `plan_active` is true or a forbearance overlay covers the receipt date, park
  with `partial_hold` false. Have `loanCashStateFromRows` set `plan_active`
  from the open §12.4 or §12.5 case.
- **Kept out by.** payments-posting. `paymentsInScope` rejects a partial hold
  during an active forbearance.

### cashiering-13. A hold or a trial without its overlay does not stop a late charge 🟡

- **Spec says.** §2.7 rule 3(iv): bankruptcy charges accrue suspended. Rule
  3(vii) and 2.7-Q4: no new charges after a foreclosure referral. §2.6 rule 3:
  trial charges accrue suspended, pending waiver.
- **Engine does.** Reads only the overlays. A bankruptcy or foreclosure hold
  in `state.holds`, or `trial_active`, without the matching overlay leaves the
  charge assessed. The runtime would skip the run for a loan with an open hold,
  but nothing writes one (cashiering-18), and it carries no trial flag or
  overlays, so trial, forbearance, bankruptcy, SCRA and dispute loans are
  assessed at every grace end.
- **Reproduction.** L-1 with 09-01 unpaid, run 09-17, `holds` [bankruptcy] and
  no overlay: assessed 7,901c. With `trial_active` true: assessed 7,901c.
- **Smallest fix.** In `assessLateCharge` (latecharges.ts:82-91), when no
  overlay of the matching kind is present, read hold `bankruptcy` as
  `bankruptcy_active`, hold `foreclosure_post_referral` as
  `foreclosure_referred`, and `trial_active` as `trial_pending_waiver`.
- **Kept out by.** payments-posting pairs every bankruptcy or foreclosure hold
  with its overlay and draws no trial. `paymentsInScope` rejects an assessed
  charge under either hold.

### cashiering-14. Trial payments are never applied on the posting path 🟡

- **Spec says.** §2.6 rule 2, 2.6-T8 and example J: trial receipts are held
  until they reach the contractual payment, and then the oldest unpaid
  installment is applied (C-1.1-02).
- **Engine does.** `allocate` holds every receipt on a trial loan as
  `held_trial` and applies nothing. `trialReceipt`, the §2.6 operation that
  applies an installment, is called only from tests. The runtime hard-codes
  `trial_active` false, so trial payments post as ordinary receipts and short
  ones open §2.2 partial items. docs/decisions.md and docs/environments.md say
  the servicing app posts trial receipts through its trial path; no runtime
  caller does.
- **Reproduction.** Example J's three receipts of 195,900c through
  `CashieringService.post`: nothing applied, 587,700c held. The spec applies
  07-01 and 08-01 and holds 149,186c.
- **Smallest fix.** In the trial overlay (allocation.ts:99), after parking the
  receipt, apply one installment when the amount held reaches the oldest
  installment's payment, as `trialReceipt` does. Set `trial_active` in
  `loanCashStateFromRows` from the open trial case.
- **Kept out by.** payments-posting never draws a trial.

### cashiering-15. An expired forbearance overlay hides a later active one 🟡

- **Spec says.** §2.7 rule 3(ii) and D2-3.2-01: no late charge accrues during
  an active plan.
- **Engine does.** Takes the first forbearance overlay that started on or
  before the due date, and only then tests its end and default. An expired
  plan listed first hides a later active one, and `openSuppression` appends a
  new plan after the old, so that is the usual order.
- **Reproduction.** L-1, overlays [forbearance 01-01 to 03-31, forbearance
  09-01 to 12-31], run 10-17 for 10-01: assessed 7,901c. In the other order,
  `not_assessed`.
- **Smallest fix.** At latecharges.ts:84, move the end and default tests into
  the `find` predicate.
- **Kept out by.** payments-posting draws at most one overlay per loan.

### arm-2. The LAR 83 deadline runs from the run date, not the index date 🟡

- **Spec says.** §7.2's LAR 83 timer (FNMA_IRM_LAR83_RATE_CHANGE_BD5): due 8
  p.m. ET on the fifth Fannie Mae business day after the scheduled calculation
  date, which is the change date less the look-back.
- **Engine does.** Anchors the deadline, and the timer (`timers-7-2.ts:22`),
  on `calculation_date`, which is the day the calculation ran. Each business
  day of delay moves the deadline a business day later, with no breach
  recorded.
- **Reproduction.** Plan 4927 calculated on 2026-09-21: due 2026-09-28. The
  spec gives 2026-09-24.
- **Smallest fix.** At ops-7-2.ts:344, set `calculation_date` to
  `row.index_date`, and keep the run date in a field of its own.
- **Kept out by.** arm-adjustment grades no LAR 83 report.

### arm-3. A (c) notice over 31 days late is held, and the adjustment never takes effect 🟡

- **Spec says.** §7.2 decision 5 defers the payment change when the (c) notice
  is late. The engine's own docstring (ops-7-2.ts:427) and Reg Z 1026.20(c)(2)
  require 60 days' notice before the first payment at the new level.
- **Engine does.** Defers exactly one cycle, however late. Past 31 days late
  the deferred payment is under 60 days out, the template's timing rule holds
  the notice, and `makeEffective` refuses with no notice sent. The rate never
  changes and the next change is never armed.
- **Reproduction.** Plan 4927, (c) deadline 2026-10-02. Sent 11-02: payment
  deferred to 2027-01-01, 60 days, sent. Sent 11-05: deferred to 2027-01-01,
  57 days, held; `makeEffective` on 2027-03-01 refuses.
- **Smallest fix.** At ops-7-2.ts:453, step `payment_effective_due` with
  `nextDueAfter` until it is at least 60 days after the send date (25 for the
  25-day kinds).
- **Kept out by.** arm-adjustment grades no late-notice deferral.

### arm-4. A late notice on a rate decrease defers the lower payment 🟡

- **Spec says.** §7.2 decision 5 and C-2.1-01: the deferral protects the
  borrower. Nothing keeps a borrower on the higher payment after a decrease.
- **Engine does.** Defers the payment change on any late Reg Z notice, a
  decrease included, and books new less prior P&I as
  `servicer_shortage_cents`, which is negative. The notice states the higher
  payment while the activated loan terms carry the lower one.
- **Reproduction.** Plan 4927 with a 1.50000 print: 4.250%, P&I 201,011c
  against 233,429c. Sent 10-10, eight days late: payment change deferred to
  2027-01-01, `servicer_shortage_cents` -32,418.
- **Smallest fix.** At ops-7-2.ts:452, defer only an increase:
  `regz && late && adj.new_pi_cents > adj.prior_pi_cents`.
- **Kept out by.** arm-adjustment grades no late-notice deferral.

### arm-7. A due day after the change day counts a payment twice, more at each change 🟡

- **Spec says.** §7.2 rule 3: the new payment amortizes the balance expected
  at the change date over the months from the first new payment to maturity.
- **Engine does.** `expectedUpbAt` counts months by year and month, so with a
  due day after the change day it counts the first new payment as made.
  `makeEffective` re-bases on that balance, so each change adds one more, and
  the loan reaches maturity owing a balloon.
- **Reproduction.** Plan 4927 with first payment 2021-12-15: 60 payments
  counted, UPB $371,048.86, P&I $2,473.09. Rule 3 gives 59,
  $371,602.55 and $2,476.78. At a level index the borrower still owes
  $114,515.16 after the 360th payment.
- **Smallest fix.** In `expectedUpbAt` (ops-7-2.ts:315), count the due dates
  from `schedule_basis.from_due_date` on or before the change date instead of
  `monthsBetween + 1`.
- **Kept out by.** arm-adjustment. Every schedule date falls on the 1st, and
  `armInScope` rejects otherwise.

### arm-10. The send check passes a Reg Z notice before the index date 🟡

- **Spec says.** §7.2: the sendable window opens at the index date, because
  the rate is not known before it. `noticeWindow` computes `sendable_from` for
  this.
- **Engine does.** `sendCheck` tests only `not_before` (the first new payment
  less 120 days) and the deadline; `sendable_from` is never checked. With
  arm-1, this sends a stale rate in a federal notice.
- **Reproduction.** Plan 4927 calculated and verified on 09-01 on an 08-31
  print of 4.50000: the (c) notice goes out 09-02, fifteen days before the
  index date, `late` false, reading 7.250%.
- **Smallest fix.** In `sendAdjustmentNotice` (ops-7-2.ts:448), refuse a send
  before `w.sendable_from`, or have `sendCheck` test it.
- **Kept out by.** arm-adjustment. `armInScope` rejects a notice proposed
  before the index date unless it is a Reg Z notice before its window opens,
  which engine and spec both block.

### arm-13. The note's floor and payment cap are dropped 🟡

- **Spec says.** §7.2's data model carries `rounding_rule` (including
  `up_eighth` and `none`), `floor_rate_bps` and `payment_cap_pct`.
- **Engine does.** `parseArmTerms` refuses the two rounding rules, which is
  safe. It drops the floor and the payment cap, so the floor is always the
  margin (arm.ts:30, arm-verify.ts:64) and no payment cap applies. The
  runtime's `loan_terms.arm_floor_bps` is never read.
- **Reproduction.** Plan 4927 with a 4.000% floor and a 0.50000 print: 3.750%.
  With a 7.5% payment cap and a 5.10000 print: P&I
  $2,802.64, where the cap allows $2,509.36.
- **Smallest fix.** Carry the floor and the payment cap in `ArmTerms` and
  `RateInputs`, take max(margin, floor) in both engines, and cap the new P&I
  in `calculateAdjustment`. Until then, refuse such loans at boarding.
- **Kept out by.** arm-adjustment draws only nearest-eighth notes, no floor
  above the margin, and no payment-cap plans.

### payoff-1. Full months of interest are rounded one by one 🟡

- **Spec says.** §16.1 rule 3 and §16.2 rule 4: each interest block (the full
  months, the partial days) is rounded once.
- **Engine does.** `quote.ts` and `remittance.ts` `payoffInterest` multiply a
  rounded month by the number of months. The runtime statement
  (`interestF109`) rounds once, but Fannie Mae's A/A interest and the
  collected interest behind the servicing fee do not, so LAR 60 and the fee
  come out 1 or 2 cents off, in either direction.
- **Reproduction.** UPB
  $248,310.55 at 6.500%, LPI 08/01, good through 10/15: `quote()` gives full months of $2,690.04;
  rounded once, $2,690.03.
- **Smallest fix.** In `quote.ts` (line 17) and `remittance.ts`
  `payoffInterest` (line 60), round UPB x rate x months / 1200 once.
- **Kept out by.** payoff-statement. `payoffInScope` never lets a day count
  reach two full months.

### payoff-2. The month walk drifts for due days 29 to 31 🟡

- **Spec says.** §16.1 rule 2: count whole calendar months from the accrual
  start, then the days left.
- **Engine does.** Steps `addMonths` from the clamped cursor, so after a short
  month the cursor sits on the 28th or the 30th and extra days are counted.
  The runtime statement (`interestF109`), Fannie Mae's A/A interest and
  repurchase interest share the walk.
- **Reproduction.**
  $200,000 at 6%, LPI 01/31, payoff 03/31: 2 months and 3 days, $2,098.63. The
  spec gives 2 months, $2,000.00.
- **Smallest fix.** Count from the anchor,
  `while (addMonths(start, months + 1) <= payoffOn) months++`, in `quote.ts`,
  `interestF109` and `payoffInterest`.
- **Kept out by.** payoff-statement draws loans due on the 1st.

### payoff-3. A rate segment re-runs the 30/360 walk inside itself 🟡

- **Spec says.** §16.1 rule 4: each segment uses its own rate on the same
  balance, so a split at an unchanged rate changes nothing.
- **Engine does.** `segmentedInterest` and `rateSegments` re-run the month
  walk inside each segment. A cut on any day but the 1st turns a 30/360 month
  into actual days, high or low by month. A mid-month SCRA cap meets this on
  the runtime's statement.
- **Reproduction.** $200,000 at 6%, 09/01 to 10/10: $1,295.89 unsplit,
  $1,282.19 split at 09/15 at the same rate.
- **Smallest fix.** Walk the months once over the whole window, then price
  each full month by the days each rate was in force and each partial day at
  its own rate.
- **Kept out by.** payoff-statement draws no rate segments or ARM changes.

### payoff-5. The "if it posts" figure on a loan behind drops the arrears' interest 🟡

- **Spec says.** §16.1 rule 7: the statement prints the figure if the
  scheduled installment posts beside the figure if it does not. Posting one
  installment leaves the earlier arrears owing.
- **Engine does.** Sets the posted figure's LPI to that installment's due date
  whatever the loan's LPI, so a month's interest disappears for each month
  behind. This is the figure the runtime prints (`alternativeFigures16`).
- **Reproduction.** $200,000 at 6%, LPI 08/01, installment 11/01 with $199.10
  of principal: if it posts,
  $200,260.72. Applied to the oldest unpaid installment, it is $202,258.73.
- **Smallest fix.** In `alternativeFigures16` and `quote.ts`
  `alternativeFigures`, advance the loan's own LPI by one installment instead
  of setting it to `installment_due`.
- **Kept out by.** payoff-statement prints the alternative only for the
  installment after the last paid one.

### payoff-6. A late payment within tolerance is recorded short, with no paid-in-full date 🟡

- **Spec says.** §16.2 rule 2: the variance is the amount less the exact
  figure at the payoff date, and a variance within
  $50 is paid in full. (16.1-T2's five per diems, $221.10, conflict with
  this.)
- **Engine does.** After the good-through, `fundsReceived` compares a payment
  with the statement plus per diems. Anything short of that takes the shortage
  branch, which sets `paid_in_full_on` null and emits `payoff.funds.short`,
  even when it labels the receipt `paid_in_full_tolerance_expense`. No
  paid-in-full event follows, and shortage timers arm against a borrower who
  owes nothing.
- **Reproduction.** UPB $248,310.55 at 6.500%, statement $250,390.82 good
  through 10/15, per diem $44.22. The statement amount on 10/16:
  `payoff.funds.short` 4,422c, `paid_in_full_on` null. §16.2's
  `disposeVariance` on the same receipt: paid in full on 10/16.
- **Smallest fix.** In `fundsReceived`, test a late payment against the exact
  figure as §16.2 does, and take the paid-in-full branch when it is within
  tolerance.
- **Kept out by.** payoff-statement grades through `quote.ts` and `remit.ts`,
  and its rulebook grades a shortage as the exact recomputation (16.1-T2 at
  $221.09).

### payoff-11. The S/A half month is rounded twice 🟡

- **Spec says.** §5.2 rule 2 and §16.2 rule 4: S/A payoff interest is UPB x
  PTR / 24.
- **Engine does.** Rounds a month's interest, halves it, and rounds again.
  About one S/A payoff in four is a cent high, never low, in LAR 60 and the
  S/A deficit.
- **Reproduction.** UPB $200,001.20 at a 6.000% PTR: 50,001c. Rounded once:
  50,000c.
- **Smallest fix.** In `payoffInterest` (remittance.ts:53), compute UPB x PTR
  / 2400 with one rounding for S/A.
- **Kept out by.** payoff-statement draws S/A balances only where the two
  roundings agree.

### payoff-14. A daily-simple loan's Fannie Mae share collects 30/360 interest 🟡

- **Spec says.** §16.1 rule 2: a daily-simple loan accrues daily on a 365-day
  year. §16.2 rule 4: the servicing fee is the interest actually collected
  less the interest due.
- **Engine does.** `fnmaShare` and the runtime's `fnmaPayoffShare` compute
  collected interest with no accrual method, so a daily-simple loan is walked
  30/360 and the fee withdrawn from custodial P&I is not what was collected.
- **Reproduction.** §16.2's worked loan (UPB $199,500, 6.250%, PTR 6.000%, LPI
  09/01, payoff 10/16) as daily simple: statement interest 153,724c, the
  share's collected 155,147c, fee 6,205c where it is 4,782c.
- **Smallest fix.** Pass the quote's accrual method into `fnmaShare` and
  `fnmaPayoffShare`, or take collected interest from the accrued-interest
  bucket applied.
- **Kept out by.** payoff-statement pays a daily-simple loan off in its last
  paid installment's month, where the two agree.

### payoff-15. The S/S BD1/BD2 exception never checks the payoff month 🟡

- **Spec says.** §16.2 rule 4 (F-1-20): an S/S loan in an MBS pool owes
  nothing for the payoff month only when the payoff was processed on BD1 and
  reported by BD2 of that month.
- **Engine does.** Tests only that `processed_on` is BD1 of its own month.
  `postPayoff` passes today as `processed_on`, so a month-end payoff posted
  the next business day reports no interest for the payoff month.
- **Reproduction.** §16.2's worked loan, S/S in an MBS pool, closing agent
  settles Friday 10/30, processed Monday 11/02: interest 0, exception true.
  The spec owes the full October month, 99,750c.
- **Smallest fix.** In `ssBd1Bd2Exception` (ops-16-2.ts:157-161), take the
  payoff date and require `processed_on` to be BD1 of the payoff date's month.
- **Kept out by.** payoff-statement processes the payoff on the payoff date
  and has the borrower pay directly.

### flexmod-2. An ARM's modified rate is not capped at its lifetime cap or final step 🟡

- **Spec says.** §12.8 step 2 (F-1-27): an ARM or step-rate loan not on its
  final rate takes the greater of the contract rate and the Modification
  Interest Rate, capped at the lifetime cap or final step.
- **Engine does.** Takes the greater of the two with no cap, and the
  waterfall's inputs carry none. Step 3 cannot recover it, because a rate at
  the MIR is not reduced.
- **Reproduction.** Step-rate loan, IB UPB
  $180,000, contract 3.000%, final step 4.250%, MIR 6.625%, 300 months, pre-modification P&I $853.58:
  6.625%, P&I $772.70 against a $682.86 target. Capped at 4.250%, the target
  is met.
- **Smallest fix.** Add an optional rate cap to `WaterfallInputs`
  (flexmod.ts:7), and at line 27 take the lesser of max(contract, MIR) and the
  cap.
- **Kept out by.** flexmod-terms, since 1.2.0. The task carries the loan's
  lifetime cap or final step (`rate_cap_pct`), and the rulebook caps step 2's
  rate at it. `flexInScope` rejects an ARM whose step-2 rate is above its cap.
  The generator draws the cap at or above that rate, a quarter of the time on
  it. 1.1.0 carried no cap and graded the uncapped rate.

### flexmod-3. Most eligibility criteria are unchecked, and a disaster Flex Mod is denied for prior modifications 🟡

- **Spec says.** §12.8 eligibility (D2-3.2-06): originated at least 12 months
  before; at least 60 days delinquent, or under 60 and in imminent default; no
  prior Flex Mod that went 60 days delinquent in its first 12 months. The
  disaster variant ignores prior modifications and needs 3 months delinquent.
- **Engine does.** `evaluate()` runs two prechecks (a failed trial within 365
  days, three prior modifications) and the waterfall. Imminent default and
  disaster decide nothing about eligibility, and the three-modification denial
  applies to a disaster Flex Mod too.
- **Reproduction.** §12.8's worked example at 45 days delinquent with
  `imminent_default` false: `tpp_offer`; the spec says ineligible. With
  `disaster` true and three prior modifications: denied,
  FNMA_D23206_THREE_PRIOR_MODS; the spec offers P&I $1,264.13.
- **Smallest fix.** In `evaluate()` (ops-12-8.ts:140-155), take the
  origination date, days delinquent and prior Flex Mod performance, check them
  before the waterfall, and skip the three-modification denial when
  `disaster`.
- **Kept out by.** flexmod-terms carries none of those inputs and grades only
  the two prechecks the service runs.

### flexmod-7. The conversion re-run is never fed, and does not lock the rate 🟡

- **Spec says.** §12.8 rule 4: the waterfall is re-run on the capitalization
  date with interest accrued through the trial and the rate locked, and Form
  3179 takes its figures from that run.
- **Engine does.** `bookConversion` re-runs only if given inputs, and nothing
  builds them (§2.6's `completeTrial` computes the capitalization, which §12.8
  never reads). Given inputs, the rate is not locked, the run follows Form
  3179 rather than preceding it, and `new_pi_cents` and the maturity date stay
  at the evaluation's figures.
- **Reproduction.** Value
  $560,000 with conversion inputs: the ledger books IB UPB $252,061.73 while
  the recorded P&I stays $1,471.87, where that balance needs $1,475.71. An ARM
  signed at 6.625% re-runs at the MIR then in force, 6.750%.
- **Smallest fix.** In `bookConversion` (ops-12-8.ts:320-324), lock the rate
  (`contract_rate_pct` and `mir_pct` set to the evaluation's rate,
  `is_arm_not_final` false), write `new_pi_cents` and the maturity date from
  the same re-run, and run it before `sendForm3179`.
- **Kept out by.** flexmod-terms grades the evaluation run only.

### escrow-1. A multi-year premium is disbursed in full every year 🟡

- **Spec says.** §3.2 R1 and Reg X 1024.17(c)(9): a multi-year premium accrues
  over 12 x cycle_years months and is disbursed in the year it falls due, and
  the statement explains why the low point is not reached in the other years.
- **Engine does.** The line projection maps the last payment's anniversary
  into every computation year (analysis.ts:162), so the whole premium is
  disbursed every year while a third is collected, and
  `multi_year_low_point_flag` is never set. No runtime path feeds it a
  multi-year line yet, but `escrow_lines` stores them.
- **Reproduction.** A triennial
  $2,700.00 flood premium last paid 2026-03-01 beside a $1,500.00 annual
  hazard premium: the whole
  $2,700.00 is disbursed on 2027-03-01, 2028-03-01 and 2029-03-01, with a $2,800.00
  target each year. Across the cycle the targets are $1,000.00, $1,900.00 and
  $2,800.00.
- **Smallest fix.** For `cycle_years > 1`, step the last payment forward by 12
  x cycle_years months and let `project()`'s multi-year branch (:48) take its
  share and set the flag. `project()` must also carry the accumulated share
  across years (§3.4 rule 6), or the date fix alone holds too little.
- **Kept out by.** escrow-analysis, escrow-history and escrow-policy draw only
  monthly, semiannual and annual lines.

### escrow-2. A biweekly projection drops a disbursement on the year's last day 🟡

- **Spec says.** §3.2 R2 and 3.2-T16: a biweekly loan has 26 periods, and the
  annual total is the sum of the projection year's disbursements.
- **Engine does.** Counts biweekly periods over a 364-day year
  (analysis.ts:37) while the line projection maps disbursements into a
  12-month year (:153). An item on the year's last day (the last two, in a
  year with 29 February) falls in no period and leaves the annual total, the
  base payment and the low point. The origination biweekly election (§30.3)
  reaches it.
- **Reproduction.** Year from 2027-07-01; hazard
  $1,950.00 on 2028-06-30, HOA $360.00 on 2028-06-29, tax
  $2,600.00 on 2027-12-10: annual $2,600.00, base
  $100.00 a period. The spec gives $4,910.00 and $188.85.
- **Smallest fix.** In `project()` (analysis.ts:37), end the biweekly year at
  `addMonths(yearStart, 12)`, and clamp `periodIndex` (:17) to the 26th
  period.
- **Kept out by.** escrow-analysis draws monthly notes only.

### pmi-2. An odd-term midpoint terminates a month late 🟡

- **Spec says.** 12 U.S.C. 4902(c) and §10.3-Q1: final termination is the
  first of the month after the midpoint. §10.3 R1's parenthetical reads the
  engine's way and needs the same correction.
- **Engine does.** For an odd term takes the first of the month after start
  plus floor(term/2) months plus 15 days, then the first of the month after
  that. §24.6 seeds the same late date at origination.
- **Reproduction.** `midpoint(2024-05-01, 181)`: termination 2031-12-01. The
  midpoint is 2031-10-16, so termination is 2031-11-01.
- **Smallest fix.** At schedule.ts:87, set the midpoint to start plus
  floor(term/2) months plus 15 days without `firstOfFollowingMonth`, and
  update 10-3.spec.test.ts:80.
- **Kept out by.** pmi-termination keeps out odd terms.

### pmi-3. The denial's renewal date disagrees with the history test 🟡

- **Spec says.** §10.1 R5 windows payment history by due date. §10.6's worked
  example dates the renewal from the paid date, as the engine does, and the
  statute can be read either way; the spec should settle it.
- **Engine does.** The denial notice gives the paid date plus 12 months and a
  day, while the test it reports on windows by due date. A 30-to-59-day late
  gets a date later than needed by the days late. A 60-day late is named only
  by its 30-day reason, and the notice gives a date about ten months too
  early.
- **Reproduction.** Due 2028-10-01, paid 2028-11-05: the notice says
  2029-11-06, and the test passes from 2029-10-02. Paid 2028-12-05 instead:
  the notice says 2029-12-06, and the test fails until 2030-10-02.
- **Smallest fix.** Derive the date from the test's own windows
  (ops-10-6.ts:154, denial.ts:33): the due date plus 24 months and a day for a
  60-day late, plus 12 months and a day otherwise, the latest of all. Or
  search for the first date the test passes.
- **Kept out by.** pmi-termination does not port `denial.ts` or grade the
  denial notice.

### pmi-7. Value-check options for two to four units are wrong 🟡

- **Spec says.** §10.1 R6 and F-1-02: a two-to-four-unit property needs an
  interior and exterior appraisal ($750). The BPO ($190) and the restricted
  appraisal ($450) are one-unit products.
- **Engine does.** Maps every property class but `2_4u_principal` to one unit,
  so a two-to-four-unit investment property is offered only the one-unit
  products. A two-unit principal residence is offered all three.
- **Reproduction.** Three-unit investment property at 6975 bps, no AVM:
  options [bpo 19,000c, restricted_appraisal 45,000c].
- **Smallest fix.** Carry `units` on the request and pass it at
  cancellation.ts:154 and section10.ts:150. In `valueCheck` (:80), offer only
  the $750 appraisal when units exceed one.
- **Kept out by.** pmi-termination does not grade the value-check options.

### pmi-10. The decision due date ignores the valuation's delivery 🟡

- **Spec says.** §10.1's timer table, its current-value worked example and
  B-8.1-04: the 30 days run from the later of the request and the valuation's
  delivery. (R9's text, and §10.6's example, which takes the earlier date,
  need correcting.)
- **Engine does.** `decisionDue` anchors on `evidence_satisfied_on` and never
  reads `valuation_delivered_on`. With the fee date as the evidence date,
  `decision_due` and `mi_denials.due_on` are ten days early, and an on-time
  denial is stamped late. The live clocks re-anchor correctly.
- **Reproduction.** Received 2026-08-20, fee paid 2026-08-24, BPO delivered
  2026-09-03: `decision_due` 2026-09-23. The spec gives 2026-10-03.
- **Smallest fix.** Anchor on the latest of the request, the evidence and the
  delivery, in `evaluateCancellation` (cancellation.ts:131) and
  `composeDenial` (ops-10-6.ts:118).
- **Kept out by.** pmi-termination keeps out an evidence date other than the
  valuation's delivery.

### pmi-11. The midpoint moves with an ARM reset 🟡

- **Spec says.** §10.3: the midpoint runs from the original first due date and
  full term, or a modification's; a rate change never moves it.
- **Engine does.** The MI tools compute
  `midpoint(v.rows[0].due_date, v.rows.length)` on the version in effect, so
  an ARM reset moves the midpoint and arms a second midpoint clock beside the
  first.
- **Reproduction.** 5/6 ARM, $380,000 at 5.50%, 360 months from 2024-05-01,
  reset at payment 61 to 7.50%: midpoint termination 2041-11-01. The spec
  gives 2039-05-01.
- **Smallest fix.** At section10.ts:236 and :272, take the midpoint from the
  governing first due date and full term (`mi_policies.amortization_start` and
  its term), and use the new version's rows only for a modification.
- **Kept out by.** pmi-termination's grader takes the midpoint from the
  governing first due date and full term.

### pmi-14. The midpoint termination is skipped for loans outside the 78% rule 🟡

- **Spec says.** §10.3 and B-8.1-04: every loan's MI ends at the midpoint.
  Whether the 78% rule reaches a loan decides only whether the 78% date can
  come first (§10.3 R4).
- **Engine does.** Given applicability, the `pmi.terminate` tool passes the
  78% rule's reach as the midpoint sweep's `applies` flag too, so a
  two-to-four-unit, investment or pre-1999 loan returns
  `not_applicable_midpoint_only` at its own midpoint. The midpoint clock still
  breaches to an officer.
- **Reproduction.** Two-unit principal residence, first due 2021-04-01,
  current at 2036-04-01, kind `automatic_midpoint`:
  `not_applicable_midpoint_only`. Without applicability: terminated.
- **Smallest fix.** At section10.ts:251, force `applies` to true when the kind
  is `automatic_midpoint`.
- **Kept out by.** pmi-termination runs the sweep at every trigger, whatever
  the 78% rule.

### boarding-1. A yes-or-no tape cell other than "Y" boards as No 🟡

- **Spec says.** §1.1 takes a fallback CSV "with agreed layout", where a
  boolean is Y or N, and says rejects produce a message "listing row-level
  failures".
- **Engine does.** `rYn` reads blank as unknown, "Y" as yes and everything
  else as no (tape-codec.ts:49). A transferor that writes "Yes", "y", "1" or
  "TRUE" is read as No without a warning. For `escrowed` the loan then boards
  as non-escrowed with its escrow lines still attached, and HF-007 passes,
  because it checks only the reverse: escrowed with no lines (rules.ts:94-98).
  The same reading turns off `bk_active`, `fc_active` and `lm_in_process`.
  The bankruptcy and foreclosure details are dropped with their flags
  (tape-codec.ts:248-249). The loss-mitigation details are kept (:250); only
  the case-opening is lost, because with the flag off no case opens and no
  (k) clock is armed (domain/transfers/ops-1-7.ts:101). Later processes catch
  some of it. The PACER scrub before a foreclosure referral finds the
  bankruptcy (app/tools/section13.ts:485-503). The §1.7 carryover
  verification works from the loss-mitigation file rather than the flag, so
  it should find the loss mitigation. On a loan wrongly boarded
  non-escrowed, insurance tracking catches a hazard lapse
  (domain/insurance/ops-9-1.ts:157-162), while unpaid taxes surface only
  through the tax service's delinquency report (§3.7).
- **Reproduction.** The demo batch with TR-0000001's `escrowed` cell changed
  from "Y" to "Yes": decoded `escrowed=false`, 3 escrow lines, no rule
  failure, boarded. With `bk_active`=y the loan boards with no failure and no
  bankruptcy details; with `lm_in_process`=1 it boards with
  `in_process=false` and the file's application status kept. Found on 22
  October 2026 while cataloguing defects for synthetic data, and reproduced
  the same day.
- **Smallest fix.** In `rYn`, accept only "Y", "N" and blank, and reject the
  row for anything else; and have HF-007 also fail a non-escrowed loan that
  carries escrow lines.
- **Kept out by.** No environment boards a transfer.
  docs/synthetic-data-defects.md plants it on purpose (D-42), with D-31, D-35
  and D-37 built on it.

### metro2-1. The monthly Metro 2 cycle never reads the loan's MIN, so every loan is left out of every bureau file 🟡

- **Spec says.** §8.1 rule 6 and the K3 layout: every loan carries a K3
  segment, and its Mortgage Identification Number is the 18-digit MERS MIN
  (8-1-furnish-tradeline-metro-2.md:81, :116). Rule 9 makes "K3 missing" a
  hard error (:140). 8.1-T1 expects "K3 with MIN" on a current loan (:201),
  and 8.1-T12 fixes a MIN reject "from `loans`" (:212). C-4.1-01 (:28)
  requires the status of each mortgage loan at each of the four repositories
  every month.
- **Engine does.** The runtime's `metro2_monthly` unit builds each loan's
  state in `metro2RecordsFromTypedRows`. Its query does not select `l.min`
  (domain/operations-runtime/runners.ts:127), and the state is written with
  `min: null` (:143), though `loans.min` holds the MIN from boarding
  (db/migrations/0001_baseline.sql:109; runtime/transfers.ts:185).
  `buildSnapshot` copies the null into `k3.min`
  (domain/credit-reporting/metro2.ts:221), and `validateSnapshot` raises
  K3_MIN_MISSING (:267). `buildCycle` then leaves the record out as a hard
  error (domain/credit-reporting/ops.ts:170-171). Every loan that reaches the
  validator is left out, every month. A dropped record never reaches the
  anomaly deltas (ops.ts:171-172), so the cycle validates and sends four empty
  files (runners.ts:158-161). Those empty files satisfy
  SM_METRO2_TRANSMIT_ALL4_BD3 and SM_METRO2_TRANSMIT_HARD_CD10, and no timer
  arms on `credit.cycle.exception`, so nothing escalates. 35.3-T16 runs the
  unit with no loan (domain/operations-runtime/35-3.spec.test.ts:894-935), so
  the suite never sees this. From reading the code, not running it: the same
  state hard-codes `interest_type: "F"` (runners.ts:142), so once the MIN is
  passed every ARM would be reported as fixed-rate.
- **Reproduction.** A scratch database migrated with db/migrate.sh. One loan,
  boarded the way 35.3's fixture boards one (35-3.spec.test.ts:80-87), with
  one borrower party and `loans.min` 100045600000000010 (check digit valid).
  `metro2RecordsFromTypedRows` at 2026-10-31 gives `k3.min` null and
  `validateSnapshot` ["K3_MIN_MISSING"]; with `k3.min` set from `loans.min` it
  gives []. Running the 2026-10 unit through the executor gives
  `credit.cycle.snapshot_completed` with record_count 0 and one exception,
  K3_MIN_MISSING, sends four `metro2.file.transmitted` with record_count 0
  plus the `all_bureaus` event, writes no `metro2.loan.furnished`, and leaves
  both transmit timers `satisfied`. Two independent checks reproduced it, one
  boarding the loan by a different path. In the 397-day runtime simulation, 13
  monthly cycles sent 52 bureau files, all with 0 records; SM-TR-0000001 was
  left out with K3_MIN_MISSING in 12 of them, while `loans.min` held its MIN.
  Found on 22 October 2026 and reproduced the same day.
- **Smallest fix.** Select `l.min` in the query at runners.ts:127 and pass it
  at :143 (`min: l["min"] ?? null`), and take `interest_type` from the loan's
  amortization.
- **Kept out by.** Nothing needs to. metro2-furnishing ports metro2.ts and
  types.ts, not the runtime's typed-row builder, and its generator supplies
  the MIN.

### ei-1. A paid installment does not cancel its Reg X early-intervention clocks 🟡

- **Spec says.** Under §11.1 rule 1 and comment 39(a)-1, installment D paid
  with `credited_as_of` on or before day 36 cancels the window's live-contact
  duty. Under §11.2 and 1024.39(b)(1) ("so long as the borrower remains
  delinquent"), an installment paid by day 45 owes no notice. Both timer
  tables and the registry say each clock is "cancelled by installment paid ≤
  due" (11-1-live-contact.md:86, :107;
  11-2-written-early-intervention-notice.md:57, :78;
  spec/registry/timers.json:6478, :6665). 11.1-T3 says a rolling-30 borrower
  never breaches REGX_1024_39A_LIVE_CONTACT_36.
- **Engine does.** The kernel engine cancels a timer only by id
  (kernel/timers/engine.ts:223-227). The rows that map
  `payment.applied{installment_due_date, credited_as_of}` to a window's clocks
  are `EARLY_INTERVENTION_CANCELLATIONS`
  (domain/early-intervention/timers.ts:205-219). They are applied by
  `attachEarlyInterventionTimerCancellations` (:276), which is to be wired
  "wherever the loan's TimerEngine is built (the unit of work)" (:274). The
  runtime never wires it: `PgUnitOfWork.run` builds and restores the engine
  and attaches nothing (infra/db/unit-of-work.ts:118-119). The one caller is
  the §11 spec harness (domain/early-intervention/spec-harness.ts:40), so
  11.1-T3's clock assertions pass and the hosted runtime never cancels.
  - The payment's own path works. `payment.applied` names the window
    (app/tools/section2-1.ts:87), the cashiering unit satisfies the
    installment (domain/operations-runtime/cashiering-cycle.ts:300), and the
    window row reads `cancelled_paid` (runtime/delinquency.ts:87-88).
  - The clocks stay armed anyway. The breach pass breaches them and opens a
    sev-1 `officer` escalation for each
    (domain/operations-runtime/breach.ts:89-99, :113). A later live contact
    marks them `satisfied_late` (kernel/timers/engine.ts:168-172).
  - Neither code has a breach-action row, so the breach only escalates
    (domain/operations-runtime/default-35-9/sweep.ts:49-52), and the runtime
    calls and mails no one.
  - The same unwired reader carries the bankruptcy-petition, FDCPA-cease and
    discharge rows (timers.ts:209-218). Those were not reproduced.
- **Reproduction.** 35.5's AZ tape (owner-occupied, P&I 189,620c, escrow
  41,230c, next due 2026-10-01) boarded on 2026-10-01 on a scratch database.
  On 10-02 the counter job opens the 10-01 window and arms three clocks: the
  live-contact clock (due 11-06), its day-28 warning (10-29) and the notice
  clock (11-15). 230,850c is received on 10-15 (day 14) and posted by the
  hosted cashiering unit: `payment.applied{installment_due_date 2026-10-01,
credited_as_of 2026-10-15}` and the installment `satisfied`, with no
  `timer.cancelled`. The 11-07 sweep breaches the live-contact clock and its
  warning, and the 11-16 sweep breaches the notice clock: two sev-1 `officer`
  escalations while `regx_ei_windows` reads `cancelled_paid` on both legs.
  Posting with `payments.read/write{op=post}` breaches the same three clocks.
  The same two events through spec-harness.ts cancel all three
  (`paid_before_36`, `paid_before_45`). Two independent checks reproduced it,
  one with the full hosted sweep and the payment made on day 30, and one that
  attached the reader to each restored engine in its own process: all three
  clocks then cancelled. In the 397-day runtime simulation, SM-TR-0000001's
  notice clock breached for 14 windows, 12 of them paid by day 33, and its
  live-contact clock for six windows paid on day 2 or day 32; an inbound call
  marked three more, paid on day 2, `satisfied_late`. Found on 22 October 2026
  and reproduced the same day.
- **Smallest fix.** In `PgUnitOfWork.run`, call
  `attachEarlyInterventionTimerCancellations(timers, memEvents)` once the
  engine is built at unit-of-work.ts:118, as spec-harness.ts:40 does.
- **Kept out by.** No environment grades an early-intervention clock.

### ei-2. A late payment cancels a breached window, and one contact satisfies every later window 🟡

- **Spec says.** In 11.1's state machine, a live leg becomes `cancelled_paid`
  only when its installment is paid on or before `live_due_at`, and
  `satisfied_live` only through a live contact dated within (due_date,
  live_due_at]. A leg still open past its deadline becomes `breached` and is
  never deleted (11.1 rule 1: "if paid after `live_due_at`, the window's
  obligation stood"). 11.2 says the same of the notice leg. 11.2-T2: when the
  installment is paid the day after day 45, "the notice must already have been
  provided". 11.1-T4: a contact on Feb 5 satisfies the Jan 1 and Feb 1
  windows, and the Mar 1 window "remains open until Apr 6".
- **Engine does.** Only the counter job's `projectWindows` writes
  `regx_ei_windows` (runtime/delinquency.ts:76-95), and it is not that state
  machine.
  - It is told which installments are unpaid, but not when one was paid (:66,
    :134). So any paid installment sets both open legs to `cancelled_paid`,
    whatever the date (:87-88).
  - It has no `breached` status (:68-69), though migration 0055 and 11.1's
    state machine allow one, and it never moves a leg that is past its
    deadline.
  - contact.log emits `regx.ei_window.live.satisfied` with `due_dates: null`
    for every live contact (app/tools/section11.ts:333). That event satisfies
    every open window on the loan with no date test, on every later run
    (delinquency.ts:91-92). This includes windows whose live deadline had
    already passed and windows that open after the call. The domain's own
    `applyContact` has the date test
    (domain/early-intervention/windows.ts:96-98), but it is not called, and
    neither are `installmentPaid` (:81-84) and `sweep` (:102-105).
  - The contact is never linked, and `cancelled_at` comes from the database's
    `now()`, not the runtime clock (delinquency.ts:93).
  - It runs only while the loan has an installment due before today (:103-108,
    :144-147), so a loan that cures keeps its open legs.

  The timers work from the events, so the timers and the table disagree.
  35.9's daily universe selects loans from the table
  (domain/operations-runtime/cycles.ts:263), as does its case timeline
  (default-35-9/timeline.ts:60), so contact work is steered to a current
  borrower and away from one three payments behind.

- **Reproduction.** Two AZ tape loans, boarded through the transfer route with
  next due 2026-10-01; the counter job run by hand, payments posted by the
  cashiering unit, nothing paused or written by SQL. Loan A pays 10-01 on
  11-22, day 52, after both deadlines (11-06 and 11-15): both legs read
  `cancelled_paid`, where the domain's `sweep` and `installmentPaid` give
  `breached` and `breached`. Loan B logs one inbound live call through
  contact.log on 11-24. On 11-25, window 10-01 (live due 11-06) and window
  11-01 both read `satisfied_live`; window 12-01 opens `satisfied_live` on
  12-02, and so does 2027-01-01 on 01-02, while their REGX_1024_39A timers
  stay armed. B pays 10-01 on 12-03, day 63, and the notice leg reads
  `cancelled_paid` though no notice was ever sent. On 2027-01-26, A is current
  with windows 12-01 and 01-01 still open and is in 35.9's universe; B is
  three installments behind and is not. Two independent checks reproduced all
  of it on their own databases, with different dates and a control loan. In
  the 397-day runtime simulation, SM-TR-0000001's September and October 2026
  windows read `cancelled_paid` though they were paid on day 82 and day 63,
  and every live leg from October 2026 read `satisfied_live` with no contact
  linked. Found on 22 October 2026 and reproduced the same day.
- **Smallest fix.** Feed `projectWindows` each installment's `credited_as_of`.
  Fold with windows.ts's own `installmentPaid`, `applyContact` (given the
  event's `on` and contact id) and `sweep`. Add `breached` at :68-69, run the
  fold for every loan with an open leg, not only a delinquent one, and take
  `cancelled_at` from the clock.
- **Kept out by.** No environment grades early intervention.

## Low

- **cashiering-10.** A $50-rule payment received before its due date is
  relabeled `prepaid` (allocation.ts:203), so the posting service skips the
  counter row that is C-1.1-02's evidence. The runtime path never writes that
  row at all and hard-codes `partial_count_12m` to 0, so the limit of three in
  twelve months is not enforced there. Fix: skip the relabel when the outcome
  is `applied_with_50_rule`. Kept out by `paymentsInScope`.
- **cashiering-16.** A `noe_dispute` overlay ignores its start date
  (latecharges.ts:90), so a backdated re-run suppresses a charge from before
  the dispute existed. Fix: add `o.from <= i.run_on`. Kept out:
  payments-posting draws no dispute overlay.
- **cashiering-17.** Any instruction containing "second", "2nd",
  "subordinate", "junior" or "heloc" is refused and cancels a principal
  instruction beside it, and any mention of "principal" or "curtail" curtails
  (allocation.ts:81, :170). Only `CashieringService` reads the text, and it
  runs in tests only. Fix: take intent from structured fields. Kept out:
  payments-posting draws instruction text from fixed menus.
- **arm-5.** A two-month adjuster is classed as adjusting every 60 days or
  more often (ops-7-2.ts:192), though 10 of 12 gaps in its first year exceed
  60 days, so a (c) notice 25 to 59 days out passes as on time. Fix: treat
  only monthly adjusters as frequent. Kept out by `armInScope`.
- **arm-6.** `correction()` books a zero net as a $0 credit and takes no input
  for an error's scope, so a rate-only overcharge on a current loan becomes a
  cash refund where §7.2 rule 8 says credit (arm.ts:88-92). Fix: return no
  treatment on a zero net, and take the scope. Kept out: arm-adjustment grades
  no error correction.
- **arm-8.** Rates are compared as text (ops-7-2.ts:436, :482): a loan boarded
  at "5.75" whose new rate is 5.750 gets a notice reading "5.750% to 5.750%",
  and `makeEffective` refuses without it. Fix: compare numerically. Kept out:
  every rate drawn has three decimals.
- **arm-11.** The two ARM engines round a negative rate to the eighth
  differently (arm.ts:19 floors, arm-verify.ts:40 truncates): -0.100 gives
  -0.125 and 0.000. Boarding refuses negative prints and margins, and the
  dual-calculation gate holds a disagreement. Fix: floor negatives in
  `roundToEighth8`. Kept out by `armInScope`.
- **arm-12.** The §7.3 estimate's freshness gate counts business days in
  (print, disclosure] (ops.ts:186), so on a weekend or holiday disclosure date
  a print 16 business days old renders while `initialNoticeIndexHold` reports
  a hold beside it. Fix: count in [print, disclosure). Kept out:
  arm-adjustment grades the (d) notice's status and window, not its estimate.
- **arm-14.** The next change date is chained by month (ops-7-2.ts:461, :486),
  so after a 2027-02-28 change the notice names 2027-08-28 where the schedule
  says 2027-08-31. Fix: take it from the next schedule row. Kept out: every
  schedule date drawn is on the 1st.
- **payoff-4.** The §7.6 notice's `payoff()` is a second calculator,
  actual/365 on every day with paid-ahead interest clamped to 0: §16.1's
  example A comes to $250,372.39 there and $250,390.82 in §16.1
  (payoff-statement.ts:31-37). Only its tests call it. Fix: delete it or call
  §16.1's. Kept out: payoff-statement does not use it.
- **payoff-7.** `remit.variance` keeps an overage of $0.01 to $1.00 as
  tolerance expense (remit.ts:13-14, which §16.2's `disposeVariance` uses),
  while `fundsReceived` refunds it. An expense account cannot absorb money the
  borrower overpaid. Fix: refund any overage in `remit.ts`. Kept out:
  payoff-statement draws no such overage.
- **payoff-8.** `fundsReceived` dates a short payoff's demand five business
  days out (ops-16-1.ts:168), where §16.2 rule 5 and the other layers say one.
  No timer reads the field. Fix: one business day, with the five carried as
  the cure date from the demand. Kept out: payoff-statement grades no demand
  date.
- **payoff-9.** `reconcile()` recomputes at the received date and never
  applies §16.1 rule 5's next-business-day rule (quote.ts:31-34). Only tests
  call it. Fix: take an optional due date and recompute at the deemed date.
  Kept out: the grader applies the rule before calling the engine.
- **payoff-10.** `remit.fnmaShare` takes Fannie Mae's participation and
  ignores it (remit.ts:18, :26). The runtime's `fnmaPayoffShare` applies it,
  but books the other participant's half of the interest as servicing fee:
  80,676c at 50% against 6,205c at 100% (ops-16-2.ts:183). Fix: apply
  participation in `fnmaShare`, and compare like with like in
  `fnmaPayoffShare`. Kept out: participation stays at 100%.
- **payoff-12.** The portable `remit.fnmaShare` has no S/A deficit
  (remit.ts:25); only the runtime's `saInterestDeficit` computes §16.2's
  $6.83. Fix: return it from `fnmaShare`. Kept out: the S/A deficit is not
  graded.
- **payoff-13.** The portable `remit.fnmaShare` books a servicing fee of 0 for
  S/A and S/S (remit.ts:26), while the runtime books 6,205c on §16.2's worked
  loan for both. Fix: compute it as `fnmaPayoffShare` does, or drop the field.
  Kept out: the fee is graded for A/A only.
- **payoff-16.** `aaRemittanceClock` always puts the A/A LAR 60 at 20:00 ET
  (remit.ts:31), where the IRM says 17:00 when the next business day is BD2.
  The runtime's `lar60DueMs` is right, and only tests call this one. Fix: use
  `larDeadlineMs`. Kept out: payoff-statement has no Eastern-time clocks.
- **payoff-17.** `releaseDeadline` disagrees with the §16.3 matrix in TX, IL,
  VA, MI, AZ, NC, MN and CO (release.ts:15). The runtime uses the matrix, and
  only tests call this one. Fix: read `releaseRule` from ops-16-3.ts. Kept
  out: lien release is not in payoff-statement.
- **payoff-18.** `penaltyExposure` (release.ts:18-24) puts New York a tier low
  from 31 days late, returns
  $0 in CA, IL, VA, GA, MA, AZ, NC and MN, and gives Ohio $1,150 at 10 days
  late where the statute gives $250. The runtime uses `penaltyExposureReport`,
  and payoff.test.ts pins the New York tier. Fix: delegate to
  `penaltyExposureReport` and correct the test. Kept out: lien release is not
  in payoff-statement.
- **flexmod-1.** A remaining term above 480 months is kept (flexmod.ts:37), so
  §12.8's worked example at 500 months keeps 500 and runs past F-1-27's 480.
  An amortizing Fannie Mae loan never has more than 480 months left, so only
  bad input reaches it. Fix: cap the term at 480 before step 4 and recompute
  the P&I. Kept out since flexmod-terms 1.2.0: `flexInScope` rejects a
  remaining term above 480. 1.1.0 drew 470 to 500 months on about 5% of
  loans, a term its own loan could not have, and graded 10 held-out tasks
  above 480. 1.2.0 draws more than 360 months only on a loan modified to 480
  months 12 to 40 payments back, with the modification's balance and P&I.
- **flexmod-4.** The failed-trial bar counts 365 days, not 12 months
  (ops-12-8.ts:153, :122), so across 29 February a failure 365 days back is
  eligible though inside 12 months; the service's own `onTrialFailed` uses 12
  months. Fix: compare with `addMonths(failed, 12)`. Kept out: no evaluation
  window drawn crosses 29 February.
- **flexmod-5.** Step 5 solves at the rate rounded to three decimals
  (flexmod.ts:40) while every P&I uses the full rate, so a 6.4375% rate lands
  the P&I at $1,264.05 against a $1,264.13 target. Fix: pass the full rate to
  `solveUpb`. Kept out: every rate drawn has three decimals.
- **flexmod-6.** The MIR lookup's sort never returns 0 (ops.ts:641), so among
  rows on one date the last listed wins and a duplicate is never refused; on
  an ARM the choice moves the rate 12.5 basis points. Fix: a consistent
  comparator, and a refusal when one date has two rates. Kept out:
  flexmod-terms never draws two rows on a date.
- **flexmod-8.** The capitalization date has three answers: `trialSchedule`
  gives the last trial due date (flexmod.ts:57), `offerTpp` the effective date
  less a month (the spec's, and the ledger's), and §2.6 cashiering the day
  before the effective date (ops-2-6.ts:111, :119). An MBS re-date leaves the
  trial record stale (ops-12-8.ts:297). Fix: the effective date less a month
  everywhere. Kept out: flexmod-terms grades the offer-time dates.
- **escrow-3.** A cushion the instrument states in dollars is capped only at a
  sixth of the year (analysis.ts:25) and never compared with the policy or
  state months, so a lowered policy is ignored:
  $700.00 where §3.4 rule 1 gives $400.00, or $0.00 under the hardship
  override. The §18.1 QC re-derivation and origination's `cushionParameter`
  copy the shortcut. Fix: treat the dollar figure as one more candidate and
  take the least. Kept out: escrow-analysis states cushions in months only.
- **pmi-4.** The 78% sweep's current test checks only installments due by the
  1st of the preceding month (termination.ts:15-19), so a loan due on the 15th
  that missed that month's payment is current and its MI ends while 30 days
  late. Fix: test through the end of the preceding month. Kept out:
  pmi-termination draws due days on the 1st only.
- **pmi-8.** The HPA test that the borrower is current on the decision date is
  computed and discarded (cancellation.ts:53, :150). §10.1 R1's Fannie Mae
  path grants on the request-month test alone, so the grant is the spec's;
  what is lost is the record of which path granted. Fix: record both flags and
  the granting path on the evaluation. Kept out: pmi-termination keeps out a
  borrower current before the request and not at the decision.
- **pmi-9.** The LTV is floored to the basis point (cancellation.ts:21), as
  §10.1 R3 says, so a balance up to $39.99 over 80% is granted while the
  scheduled path and the denial copy test 80% to the cent. Fix: test the
  actual path in cents and keep basis points for display. Not kept out, on
  purpose: R3 states the floor, the test ("the threshold test is ltv_bps ≤
  8000") and why ("so a borrower is never denied by a rounding artifact"),
  so the figure is the spec's, not one it calls wrong. pmi-termination grades
  the band, and its rulebook's Step 7 states the same floor and test. The
  fix is the spec's to make first.
- **pmi-12.** `originalValue` returns the appraisal alone for every New York
  loan (cancellation.ts:15), which moves the federal 78% and 80% dates up to
  eleven months early; §10.1 R2 keeps the appraisal for New York's own 75%
  stop. Nothing in the runtime calls it yet. Fix: drop the New York branch and
  give §6503(d) its own value. Kept out: pmi-termination draws no New York
  loans.
- **pmi-13.** `armResetVersion` builds the reset schedule with no
  interest-only prefix (schedule.ts:69-74), so a reset inside an interest-only
  period amortizes at once and moves the 78% date about eleven months early; a
  reset after the 78% row reports the reset row as the 78% date. Fannie Mae
  has bought no interest-only loans since 2014. Fix: pass the interest-only
  months left, and keep the prior date once the prior version has crossed it.
  Kept out: pmi-termination keeps out a rate change inside an interest-only
  period or after the 78% row.

83 defects were recorded and one was dropped: arm-9 (Fannie Mae's notice in
place of a suppressed Reg Z notice is never marked late) did not reproduce,
because the template holds every such notice inside 25 days of the change
date, so none is sent late; what it leaves is an adjustment that never takes
effect, the same failure as arm-3.
