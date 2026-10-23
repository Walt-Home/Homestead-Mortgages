# Defects in the servicing app's engines

These are defects in the servicing app's own engines, found while building the
environments in `packages/environments` that grade with them, and each was
reproduced again on 21 October 2026 against the commit
`apps/servicing/VENDORED_FROM` names (`293261b`, committed 17 September 2026).
One more, boarding-1, was found and reproduced on 22 October 2026 while
cataloguing defects for synthetic data (docs/synthetic-data-defects.md).
Twenty-two more are in the runtime that wires the engines together rather than
in an engine: cashiering-18, cashiering-19, cashiering-20, arm-15, payoff-19,
pmi-15, statements-1, boarding-2, boarding-3, boarding-4, boarding-5,
boarding-6, scra-1, metro2-1, ei-1, ei-2, ei-3, http-1, transfers-1,
lossmit-1, lossmit-2 and lossmit-3. They came from running the servicing app's
runtime for 397 simulated days on a scratch database on 22 October 2026, and
from reproducing what that run found; each was reproduced in isolation the
same day, with none of that run's own choices, and upheld by two independent
checks.
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
| cashiering-19 | cashiering | A paid late charge stays `assessed` on its fee row, so each later remainder pays it again            | §2.7 states, rules 6, 8; §2.1 rule 5   | 🔴     | `app/tools/section2-1.ts:77`; `domain/operations-runtime/cashiering-cycle.ts:144-145`           |
| pmi-15        | pmi        | A boarded MI loan gets no policy, schedule or HPA clock, and `mi_changes` finds nothing to do        | §10.2, §10.3; 12 U.S.C. 4902(b), (c)   | 🔴     | `domain/boarding/service.ts:357-366`; `domain/operations-runtime/cycles.ts:250`                 |
| cashiering-20 | cashiering | A waived or reversed late charge stays on the ledger, and a refinance's payoff collects it           | §2.7 rules 5, 6; §35.10 rule 3         | 🔴     | `app/tools/section02.ts:259`, `:273`                                                            |
| boarding-4    | boarding   | A transfer-boarded loan gets no P&I or T&I custodial account, so no payment on it ever posts         | §35.1-T10; §6.1 outputs; §2.1 timers   | 🔴     | `runtime/transfers.ts:114`; `app/tools/section01.ts:86`                                         |
| scra-1        | scra       | 13.8's SCRA waiver moves the ledger, not the fee row, so the waived charge is billed and collected   | §13.8 rule 8; §2.7 rule 5; D2-3.4-01   | 🔴     | `app/tools/section13.ts:655`; read at `domain/operations-runtime/cashiering-cycle.ts:144-145`   |
| lossmit-3     | lossmit    | A plan's foreclosure hold is never written, so a borrower performing under forbearance is referred   | §12.4-T9; E-3.2-01; 1024.41(c)(2)(iii) | 🔴     | `app/tools/section12.ts:189-192`; `domain/lossmit/ops.ts:211`                                   |
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
| boarding-3    | boarding   | A transfer tape's co-borrower is dropped without a trace, so a joint loan boards with one borrower   | §1.1 mapping rule; §8.1 rule 5         | 🟡     | `domain/boarding/tape-codec.ts:99`, `:252`; `runtime/transfers.ts:190-191`                      |
| http-1        | http       | A payoff's buckets and a ledger line's amounts cannot cross the HTTP tool routes                     | §16.2 agent design; §35.1; §2.1        | 🟡     | `runtime/server.ts:140-150`; `app/tools/section16-2.ts:253`; `app/tools.ts:189-193`             |
| lossmit-1     | lossmit    | A forbearance plan is never ended at its term end, so it reads active, and "Paused", for good        | §35.9 rule 2(c); §12.4; D2-3.2-01      | 🟡     | `domain/operations-runtime/default-35-9/daily.ts:45`, `:58`                                     |
| boarding-5    | boarding   | A boarded transfer batch never cuts over, so the hello-notice clock never arms or escalates          | §1.3 timers, 1.3-T2; 1024.33(b)(3)(i)  | 🟡     | `runtime/transfers.ts:128`, `:179`; `app/tools/section01.ts:144-147`                            |
| boarding-6    | boarding   | A tape's late charges are on the ledger with no fee row, so statements and quotes omit them          | §2.7 transfer-in; §2.1 rule 5          | 🟡     | `domain/boarding/service.ts:390`; `domain/operations-runtime/cashiering-cycle.ts:144-145`       |
| ei-3          | ei         | A written notice does not cover the next windows, so each later 45-day clock arms and breaches       | §11.2 rule 4; 11.2-T3; 1024.39(b)(1)   | 🟡     | `domain/early-intervention/ops-11-1.ts:315`; `runtime/delinquency.ts:125`                       |
| transfers-1   | transfers  | The goodbye notice's address check reads parties no code writes, so no goodbye run is released       | §17.2 recipients; 1024.33(b)(3)(i)     | 🟡     | `app/tools/section17-2.ts:109-110`; `domain/transfers/ops-17-2.ts:142-145`                      |
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
| lossmit-2     | lossmit    | The case fold listens for plan and hold events by names nothing emits, so they never reach a case    | §35.9 rules 1, 9                       | 🟢     | `domain/operations-runtime/default-35-9.ts:77-78`, `:184`                                       |

🔴 high (16) · 🟡 medium (49) · 🟢 low (31). ei is Reg X early intervention.
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

- **Spec says.** §7.2's first input: "`loan.boarded` with
  `loan_terms.product = ARM` → build `arm_schedule` (all change dates to
  maturity) and schedule timers for the next change", with the prerequisite
  "Boarded ARM terms per loan (1.1)". Reg Z 1026.20(c)(2) requires the notice
  60 to 120 days before the first payment at the adjusted level. C-2.1-01 has
  the servicer enforce each ARM by its note and use its own funds for any
  shortage from an untimely adjustment.
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
  `party_id`, so it has "no recipients" (boarding-2), and the runtime always
  renders the standard template (runtime/servicing.ts:174-175), so a loan more
  than 45 days delinquent is held for its missing (d)(8) box. Two independent
  checks reproduced it, one walking 41 days across two cycles' opening dates
  with the runtime wired as `main.ts` does. In the 397-day runtime simulation
  the `statements` cycle was active, never paused and never ran. Found on 22
  October 2026 and reproduced the same day.
- **Smallest fix.** Add a daily per-loan opener. The `cashiering_daily` unit
  already visits every loan each day and has its installments and grace
  period; on the day after an installment's courtesy period ends, it should
  call `openCycle` with that due date, once per (loan, cycle_due_date).
  Transfer boarding should also open the first cycle on `loan.boarded`, as
  §7.1 says.
- **Kept out by.** No environment produces a periodic statement.

### boarding-2. A transfer-boarded borrower never gets a party, so no statement, Form 1098 or Metro 2 record reaches them 🔴

- **Spec says.** Reg Z 1026.41(a) and §7.1: a periodic statement every billing
  cycle, on paper unless the consumer agreed to e-delivery. The small-servicer
  exemption is closed, so "statements are required on every loan"; rule 12
  sends to "the borrower of record". §7.1 rule 11 and IRC 6050H: a Form 1098
  to the payer of record by January 31. §8.1 and C-4.1-01: "the status of each
  mortgage loan to each of the four major credit repositories" every month.
  Rule 5 takes the Base segment from "the first obligor on the note
  (`loan_borrowers.position=1`)". The Notice Registry addresses parties (§7.1
  `notices.recipient_party_ids`, `tax_forms_1098.payer_party_id`; §7.4 rule 4,
  consent per party). §1.1 has boarding keep the tape's phone and e-mail
  (W-001) and write its consents with `provenance='transferor'`. §32.14 rule 8
  and S6 have a servicing-book borrower sign in by "the number on file", with
  SSN4 and DOB for L2. §34.5 rule 9(c) shows a boarded borrower without a
  party as "not yet an account", and §34.5 (line 23) and §33.1 (line 14) say
  the transfer book creates no party; both speak of accounts only. §8.1 reads
  the consumer from `borrowers` and `loan_borrowers`, and `parties` only for
  successors (8-1-furnish-tradeline-metro-2.md:57). Nothing makes a statement,
  a 1098 or a tradeline wait for a party.
- **Engine does.** `insertBoardingRows` writes the borrower with name, TIN
  last four, language and SCRA flag only: no `party_id`, no date of birth, no
  contact (runtime/transfers.ts:190). The codec decodes the tape's e-mail and
  phone (domain/boarding/tape-codec.ts:252), and the tape has no DOB field
  (domain/boarding/types.ts:60). No consents are written, though §1.1 has
  boarding store the tape's with `provenance='transferor'`. Every servicing
  output finds the borrower through `borrowers.party_id`
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
    (infra/db/borrower-parties.ts:78-83), and boarding left no contact for it
    to find.
  - `party.linkLoan` matches on `b.date_of_birth`
    (app/tools/section32-2.ts:321), which a transfer-boarded row never has.
  - `account.provision` and the partner-book load cover monitored loans only
    (app/tools/section33-1.ts:304; runtime/partner-book.ts:302-304).
  - `linkBorrower` (infra/db/borrower-parties.ts:123) has no caller.

  Originated loans escape, because `servicingParties` also reads
  `application_borrowers.party_id`.

- **Reproduction.** A scratch database, with the demo batch boarded through
  the transfer path.
  - **What boarding wrote.** 94 boarded borrowers, all 94 with no party and no
    DOB; no borrower parties and no consents. Of the 100 tape rows, 74 carry
    an e-mail and 98 a phone.
  - **Sign-in, loan A (SM-TR-0000001).** The code door, given the tape's own
    e-mail, made a new party and linked nothing. `party.linkLoan` with the
    tape's SSN last four and the loan's last four (or the ZIP) refused
    `LINK_LOAN_MISMATCH`.
  - **Control, loan B.** Linked to a party through the app's own repository.
  - **Statements.** Both cycles were opened by hand (statements-1) for the
    10-01 due date, and the demo clock walked from 09-10 to 09-21. B's
    statement was mailed 09-17 and both of its clocks were satisfied. A's job
    failed "statement held: no recipients", SM_STATEMENT_GENERATE_T1 breached
    09-17 and REGZ_1026_41B_STATEMENT_PROMPT_4 breached 09-20.
  - **1098, tax year 2026.** B was furnished on paper; A was refused "no
    borrower party on the loan".
  - **Metro 2.** As of 09-30, with `loans.min` supplied (metro2-1): one record
    (B), 93 loans omitted as `no_consumer`, no 8.1 exceptions. The cycle
    validated with one record per bureau.
  - **Positive control.** With a DOB put on A's row, the same `party.linkLoan`
    call linked A at L2, and A came back as recipient and consumer.

  Two independent checks reproduced it by other paths: one boarded through the
  bus command `1.1 boardLoan` and ran the real `metro2_monthly` job through
  35.3's planner, where the 93 party-less loans appear nowhere, not even in
  8.1's own omitted count; the other started from the app's seed entry. One
  also found 91 tape rows carrying E-SIGN evidence and 83 TCPA evidence, and 0
  consent rows written. The 397-day simulation database shows the same: 92 of
  94 boarded borrowers with no party, no `statement.sent`, and 0 records in
  every Metro 2 cycle. Found and reproduced on 22 October 2026.

- **Smallest fix.** In `insertBoardingRows`, give each boarded borrower a
  `parties{borrower}` row, as 33.1 rule 3 and runtime/partner-book.ts:297-302
  do. Use the tape's name and its normalized e-mail and phone as `contact`,
  and link to an existing party only on e-mail and name. Insert the borrower
  with `party_id` set, and write the tape's consents on that party with
  `provenance='transferor'`, `verified=false`. Separately, have
  `metro2RecordsFromTypedRows` pass a loan with no consumers to 8.1, so
  `NO_CONSUMER_SEGMENT` routes it as an exception instead of dropping it.
- **Kept out by.** No environment boards a transfer or runs the runtime's
  cycles. metro2-furnishing hands 8.1's engine consumers of its own
  (packages/environments/src/metro2/generator.ts:214).

### cashiering-19. A paid late charge stays `assessed` on its fee row, so each later remainder pays it again 🔴

- **Spec says.** §2.7's state machine: an `assessed` charge becomes
  `collected` when funds are allocated to it, and §2.7 names the hand-off,
  `fee.collect` (funds allocated to `late_charges` by 2.1). The `fees` row
  carries `collected_cents` and the state. §2.1 rule 5: a remainder goes to
  late charges only while one is outstanding, and otherwise stays in
  `suspense_unapplied`. §2.7 rule 6 and 2.7-T12: a charge reversed for a
  re-dated payment refunds what was collected. Rule 8, 2.7-T13 and A2-3-04:
  the period's Σ `collected_cents` is reported to Fannie Mae, and
  `fee.collected{late_charge}` arms FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY.
  §16.1 rule 6 and Reg Z 1026.36(c)(3): the payoff includes unpaid late
  charges, accurately. Reg Z 1026.41(d)(1): the statement's amount due. Reg X
  1024.35(b)(5): a fee with no reasonable basis is an error.
- **Engine does.** The runtime's posting run, `postReceivedPayment`
  (app/tools/section2-1.ts:40-101), credits the remainder to the loan's
  `late_charges` account (:77) and writes it on the payment row (:86) and
  `payment.posted` (:88). It never touches the fee row. 2.7's
  `LateChargeOps.collect` (domain/cashiering/ops-2-7.ts:227-241), which sets
  `collected_cents` and the state and emits `fee.collected`, has no caller
  outside 2-7.spec.test.ts (:222, :276, :354, :357, :385). The cash state is
  then rebuilt from the fee rows, not the ledger: `late_charges_due_cents` is
  Σ amount − collected over `assessed` rows
  (domain/operations-runtime/cashiering-cycle.ts:144-145, :153), and
  `collected_on` is not read at all. So a paid charge is due again at the next
  derivation, and every reader of the state or the row sees it: the next
  payment's remainder (domain/cashiering/allocation.ts:195), the 35.8 work
  screen's payoff quote (domain/operations-runtime/derivers-35-8.ts:117), the
  periodic statement's amount due (runtime/servicing.ts:105, :120), the
  re-date refund, which is the row's `collected_cents`
  (domain/cashiering/latecharges.ts:135), a waiver, which treats the paid
  charge as open (:106-113), 13.8's SCRA waiver
  (app/tools/section13.ts:610-611), 35.12's own figures
  (domain/operations-runtime/posture-35-12/ports.ts:56) and 5.1's collected
  figure (latecharges.ts:170-172). Only 35.10's close-out, which reads the
  ledger (domain/operations-runtime/closeout-35-10/derive.ts:62), sees it
  paid.
- **Reproduction.** A scratch database with the app's migrations. L-1 boarded
  through the transfer path on 2026-08-20, no workout and no bankruptcy, with
  the daily unit run every day. Payments were written through the cash-rows
  port and posted by the unit, and the P&I and T&I custodial accounts came
  from the app's own 35.5 harness. The unit assessed 7,901c on 09-17. A
  227,158c payment on 09-25 paid the installment and sent 7,901c to
  `late_charges`, which then stood at 0. The fee row, as the entity record and
  in the typed `fees` table, still read `assessed` with `collected_cents` 0.
  There was no `fee.collected` and no A2-3-04 timer, and the derived state
  read 7,901c due. On 09-28 the work screen's payoff quote carried the 7,901c,
  a total of 25,162,565c against 25,154,664c without it. The statement for
  10-01 asked 227,158c and listed the same 7,901c as paid since the last
  statement. A 224,257c payment on 10-01, 5,000c over the installment with no
  instruction, sent the 5,000c to `late_charges` instead of suspense. A
  227,158c payment on 11-01, the statement's figure, sent 7,901c again. That
  is 20,802c taken for one 7,901c charge: the receivable stood at −12,901c,
  and the row still read `assessed`. On a second loan, a 4.1 re-date of the
  09-01 installment to 09-10, after the 09-25 payment, gave `refund_cents` 0.
  An `error_correction` waiver on the first loan recorded 7,901c waived and
  refunded nothing. First seen beside cashiering-18's reproduction, after the
  397-day runtime simulation of 22 October 2026, and reproduced on an ordinary
  loan the same day. Two independent checks reproduced it by other paths,
  figure for figure.
- **Smallest fix.** In `postReceivedPayment`, after the allocation set
  (section2-1.ts:77), apply `plan.late_charge_cents` to the open late charges
  oldest first through `LateChargeOps.collect` (`from: "remainder"`), and
  write each fee row back with its state, `collected_cents` and
  `collected_on`. The reversal (:115-148) undoes it, and
  `loanCashStateFromRows` reads `collected_on` (cashiering-cycle.ts:144).
  payoff-19's fix, which takes late charges from the same state, depends on
  this one.
- **Kept out by.** No environment runs the 35.5 cycle. payments-posting
  carries `late_charges_due_cents` from receipt to receipt in its own state
  (packages/environments/src/payments/reference.ts:71, :272) and never
  rebuilds it from fee rows.

### pmi-15. A boarded MI loan gets no policy, schedule or HPA clock, and `mi_changes` finds nothing to do 🔴

- **Spec says.** §10.1 and §10.2 consume `loan.boarded`. The schedule is built
  from the boarded terms, and `mi.schedule.updated` arms
  `HPA_4902B_AUTO_TERMINATE_0` (§10.2) and `HPA_4902C_MIDPOINT_TERMINATE_0`
  (§10.3). Each one breaches to an officer at sev-1 (12 U.S.C. 4902(b) and
  (c)). A boarded MI loan with no original value arms
  `SM_MI_ORIGINAL_VALUE_MISSING_60`, and one with no last disclosure gets its
  first annual disclosure within 60 days (10.4-T8). A daily cycle with no
  eligible unit files a receipt of zeros as "the day's evidence that the cycle
  looked" (§35.3 edge case 7), so the empty receipt is right only if the
  selector can see the loans.
- **Engine does.** Transfer boarding reads `mi.flag` only for warning W-006
  (boarding/rules.ts:168). `loan.boarded` carries no MI block
  (boarding/service.ts:357-366). Nothing on the hosted runtime writes an MI
  policy or schedule:
  - The 10.4 `loan.boarded` hook (pmi/ops-10-4.ts:308) is attached only in the
    spec harness (pmi/spec-harness.ts:88).
  - Nothing calls the 10.2 boarding check, the `pmi.schedule.rebuild` tool
    with op `board` (app/tools/section10.ts:234; section10-2.ts:99).
  - `seedMiSchedule` (orig-boarding/ops-30-4.ts:437) has no caller outside
    tests, and only appends `mi.schedule.updated` (:437-446), though its
    comment says it seeds `mi_schedules`.

  So no HPA clock arms (pmi/timers.ts:35, :42), and neither do the 10.4 clocks
  (pmi/timers-10-4.ts:20, :24). The `mi_changes` selector reads the typed
  `mi_schedules` table (operations-runtime/cycles.ts:250). No code writes that
  table. Every 10.x tool uses the JSON kind (section10.ts:239;
  section10-2.ts:49, :73; section10-3.ts:33), and that kind has no projector
  map (operations-runtime/projectors/index.ts:14). So the cycle plans zero
  units every day, and its receipt of zeros says it looked. Its missing runner
  (cycles.ts:275, :295) is never reached (operations-runtime/service.ts:621),
  so unlike `escrow_analysis_annual` and `lar_daily`, which die
  `runner_missing` on the same sweep, it never shows as a gap. From reading
  the code, not running it: the selector also drops the schedule's
  "unhandled", so once a row exists, a passed 80% date would select the loan
  every day.

- **Reproduction.** A fresh `db-setup` and `seed-demo`, with nothing else
  written. The tape's eight MI loans board `active`, and seven escrow a
  premium (SM-TR-0000004: 506,600c a year). The database holds 0
  `mi_policies`, `mi_schedules` or `mi_*` entity rows, 0 HPA or `SM_MI_*`
  timers and 0 `mi.*` events. SM-TR-0000025 (180 months from 2020-01-01) has a
  midpoint termination date of 2027-07-01. The selector returns 0 units on
  2027-07-02, 2031-05-01 and 2045-01-01.
  `cycles.plan{as_of: 2027-07-02, cycle_codes: [mi_changes]}` opens and
  completes a run with a receipt of zeros and appends
  `mi.schedule.run_completed`. It creates 0 jobs and 0 escalations, and the
  registry's `overdue_since` stays null. As a control, `pmi.schedule.rebuild`
  called by hand arms both HPA clocks (midpoint 2027-07-01), but the selector
  still returns 0 units. With a typed row inserted by hand, the next day's
  unit dies `runner_missing` with a sev-3 escalation to `ops_analyst`. The
  397-day simulation shows the same: 105 `mi_changes` runs, 0 units, all
  completed. Two independent checks reproduced it through the hosted
  `Runtime.sweep`, one with the 10.2 boarding op as the control: once a policy
  was boarded by hand, its HPA clocks breached to an officer, so the silence
  comes from boarding.
- **Smallest fix.** On `loan.boarded` with `mi.flag`, run the 10.2 boarding
  check. Carry the original value on the tape, or open
  `SM_MI_ORIGINAL_VALUE_MISSING_60` when it is absent. Give the `mi_schedules`
  kind a projector map, or point the selector at what `pmi.schedule.rebuild`
  writes, and add "unhandled" to the selector.
- **Kept out by.** No environment boards a loan or runs the cycle planner;
  pmi-termination builds its schedule from the task's terms.

### cashiering-20. A waived or reversed late charge stays on the ledger, and a refinance's payoff collects it 🔴

- **Spec says.** §2.7 rule 5: waived charges are `fee.waived` events "and
  reduce `late_charges` (Dr `late_charge_income`-contra / Cr `late_charges`)".
  Rule 6: when a payment is re-dated on time, "an assessed charge becomes
  `reversed` (Dr `late_charge_income` / Cr `late_charges`, or refund if
  collected — `fee.reversed`)", and 2.7-T12 refunds what was collected. 2.7's
  note (c) says the fee ledger is "the `fees` table plus `late_charges` ledger
  account". §35.10 rule 3: the refinance close takes "late charges and fees
  from the ledger". §16.1 rule 6 and Reg Z 1026.36(c)(3): the payoff states
  what is owed, accurately. Reg X 1024.35(b)(5): a fee the servicer lacks a
  reasonable basis to impose is an error.
- **Engine does.** The cashiering unit books each assessment, Dr loan
  `late_charges` / Cr `late_charge_income`
  (domain/operations-runtime/cashiering-cycle.ts:272). Nothing books it back.
  - 2.7's `fees.waive` (app/tools/section02.ts:253-266) and `fees.reverse`
    (:267-275) write the fee row (:259, :273) and post no ledger lines, on the
    engine path or the record path (:255, :270).
  - Their engines move only the in-memory state: `waiveLateCharge` and
    `reverseOnRedate` (domain/cashiering/latecharges.ts:106-113, :131-138),
    `CashieringOps.waive` (domain/cashiering/ops.ts:370) and
    `LateChargeOps.redate` (domain/cashiering/ops-2-7.ts:243).
  - `fee.reversed` names a posting that was never made,
    `ledger: "Dr late_charge_income / Cr late_charges"` (ops-2-7.ts:252), and
    `fee.refund.due` (:253) has no consumer.
  - 2.6's conversion waiver posts nothing either (app/tools/section2-6.ts:51,
    :54); 2.6's agent does hold a generic `ledger.apply_via_cashiering`
    (section02.ts:112, :170) it could post the set with by hand, but rule 5
    puts the posting on the waiver itself, though its header says the
    receivable moves with the state (:6-8).

  The tools that do post the reversal set are 4.1's `fee.reverse` and
  `late_charge.waive` (app/tools/section04.ts:344-355), and they need a case
  of one of four kinds, an NoE, a complaint, an information request or an SII,
  that has been opened (:113, :190-192). A courtesy waiver, a lockbox date
  error, a transferor's forwarded payment and a trial conversion have none.
  2.7's tool list has no `ledger.post`, and 2.1's refuses an agent outside the
  payment commands (section02.ts:28, :98).

  So the row reads `waived` or `reversed` while the ledger still holds the
  receivable and the income, and the readers split:
  - The fee rows feed the cash state (cashiering-cycle.ts:145), the 35.8
    payoff quote (domain/operations-runtime/derivers-35-8.ts:117) and the
    statement (runtime/servicing.ts:105). All three show nothing due.
  - The ledger feeds 35.10's quote
    (domain/operations-runtime/closeout-35-10/derive.ts:62,
    app/tools/section35-10.ts:236), its payoff bucket (:408) and the console's
    loan page (console/pg-store.ts:59). All three still carry the charge.

- **Reproduction.** A scratch database with the app's migrations. Five copies
  of L-1 were boarded through the transfer path on 2026-08-20, with the daily
  unit run every day. Each was assessed 7,901c on 09-17, booked Dr
  `late_charges` / Cr `late_charge_income`.
  - Loan R: a 219,257c payment on 09-20 paid the installment, with 0c to late
    charges. On 09-21, 2.7 `fees.reverse` re-dated the 09-01 installment to
    09-10. The row read `reversed` with refund 0c, and `fee.reversed` claimed
    the Dr/Cr. The ledger was unchanged: `late_charges` Dr 7,901c and
    `late_charge_income` Cr 7,901c.
  - Loan W: a courtesy waiver through `fees.waive` on 09-18. The row read
    `waived` 7,901c and LC-WAIVER-CONFIRM-v1 was queued. The ledger was
    unchanged.
  - The record path (`error_correction`) and 2.6's `trial_conversion` waiver
    did the same.

  Each loan's derived state then read 0c due, and its console page listed
  `late_charges` 7,901c. Quotes run on 09-28, good through 10-15:
  - The 35.8 quote: R 25,154,664c and W 25,312,861c, with 0c late charges.
  - 35.10's record facts carried 7,901c, and 16.1 on them gave 25,162,565c and
    25,320,762c. The second is the untouched control's figure.

  The statement for 10-01 asked W 438,514c with 0c late charges, against the
  control's 446,415c. (W, paid off on 10-15 on buckets the script built from
  the 35.8 quote, went `paid_off` with `late_charges` still Dr 7,901c, but
  other accounts were left over too, so that run does not isolate this
  defect.)

  End to end through 35.10: two copies of the harness's AZ-1 loan were boarded
  on 2026-09-20 and assessed 9,481c on 10-17. One was waived on 10-18 as a
  courtesy. Each was refinanced by this platform (serviced_same_servicer) as
  35.10-T1/T2 set it up, consummating 11-09, and only `Runtime.sweep` quoted
  and settled them. The waived loan's quote carried 9,481c in late charges,
  28,472,060c in all, the same as the control's. Its settlement on 11-13
  recorded `fees_collected {late_charges: 9481}` and paid the loan off, while
  its fee row still read `waived` 9,481c. Two independent checks reproduced it
  on their own databases, one sending the waiver and the reversal over the
  hosted `/v1` route and running every job through month-end. The 397-day
  simulation waived and reversed nothing (150 fee rows, all `assessed`), so it
  could not show this.

- **Smallest fix.**
  - In `fees.waive` and `fees.reverse` (section02.ts:259, :273) and 2.6's
    waiver (section2-6.ts:51, :54), post in the same command what rules 5 and
    6 name: the open amount, Cr loan `late_charges` / Dr `late_charge_income`.
    `feeReversalSet` (domain/servicing-requests/cases.ts:106) does it with a
    2.7 rule_ref. On the record path, take the amount from the fee row, not
    the caller.
  - For a collected charge, which cashiering-19's fix makes reachable, book
    the refund and give `fee.refund.due` a consumer.
  - Have 4.1's `fee.reverse` and `late_charge.waive` write the fee row too, so
    that one act moves both.
- **Kept out by.** No environment waives or reverses a charge, or keeps a
  ledger. payments-posting ports `waiveLateCharge` and `reverseOnRedate`
  (packages/environments/src/payments/ported/latecharges.ts:106, :131) but
  calls neither. Not cashiering-19: there a paid charge's row is stale and the
  ledger is right. Here an unpaid charge's ledger is stale and the row is
  right.

### boarding-4. A transfer-boarded loan gets no P&I or T&I custodial account, so no payment on it ever posts 🔴

- **Spec says.** §35.1 rule 10: `1.1 boardLoan` on the bus writes the same set
  the transfer route writes, and `custodial_accounts` is part of that set
  (35-1-persistence-seam-and-the-typed-record.md:89). 35.1-T10 spells out what
  the set holds: "`custodial_accounts` (P&I and T&I, found-or-inserted)"
  (:136). §6.1 and §6.2 put the accounts in that table, `account_kind` ∈ {pi,
  ti, clearing, …} with a status
  (6-1-establish-p-i-custodial-account-form-1013.md:65, outputs at :110;
  6-2-establish-t-i-custodial-account-form-1014.md:55, :92). §1.6 needs
  Supermortgage's P&I and T&I accounts "before cutover"
  (1-6-escrow-suspense-upb-reconciliation.md:38), because Fannie Mae's A2-1-07
  makes the subservicer establish custodial accounts for every loan it
  subservices (01-boarding-servicing-transfer-in/README.md:9; Servicing Guide
  A4-1). §35.5 rule 5 reads the posting accounts from that table by
  `partner_party_id`
  (35-5-the-installment-schedule-and-the-daily-cashiering-cycle.md:89).
  §35.3's selectors read typed rows and never `entity_records`
  (35-3-cycles-jobs-and-receipts.md:71). §2.1 holds the posting to one
  business day as an internal SLA
  (`REGZ_1026_36C1_CREDIT_AS_OF_RECEIPT_POST_1BD`; the legal test, Reg Z
  1026.36(c)(1), is crediting as of receipt) and the deposit to a custodial
  account to 24 hours (`FNMA_C1101_DEPOSIT_CUSTODIAL_24H`, C-1.1-01)
  (2-1-accept-post-periodic-payment-p-i-escrow.md:103-104). The spec is not
  wholly consistent: rule 10 says the bus writes "exactly the set" the route
  writes, and the route writes `clearing`; T10 is the explicit one, and the
  app's own comment agrees with it (runtime/lifecycle.test.ts:67).
- **Engine does.** Both boarding writers find or insert one account for the
  servicer party, and it is `clearing`: runtime/transfers.ts:114 on the seed
  route and app/tools/section01.ts:86 on the bus, through `custodialAccount`
  (runtime/transfers.ts:216-221). 35.1-T10's own test checks only that
  (domain/operations-runtime/35-1.spec.test.ts:536). The app's comments
  contradict each other on this: "only `clearing` is created by a transfer
  board" (domain/operations-runtime/harness-35-5.ts:118) against "1.1 seeds
  them for a transfer" (runtime/lifecycle.test.ts:67). The officer's path,
  §6.1's tools, writes `custodial_accounts` only as JSONB entity versions
  (app/tools/section6-1.ts:73, :81, :137). Their ids look like `ARR:PI:AA`,
  they name no partner party, and no projector maps that kind to the table
  (domain/operations-runtime/projectors/index.ts:14 registers sections 2, 16
  and 21 only). The table's only other writers are origination's
  `ti_prepurchase` and `origination_funding_clearing` rows
  (runtime/origination.ts:174-175), the lockbox's clearing account
  (domain/operations-runtime/lockbox.ts:175) and test fixtures.

  The cashiering unit needs all three kinds
  (domain/operations-runtime/cashiering-cycle.ts:109-111). It refuses any loan
  holding a received payment without them as `CUSTODIAL_REQUIRED` (:237), a
  refusal no spec section names. The refusal rolls back the whole unit, so the
  payment stays `received`: it is neither posted nor parked in suspense. The
  loan's 2.7 run and 2.3 check for that day never run either. §35.3 retries
  the unit twice, marks it dead and escalates to `officer` with two choices,
  requeue or abandon (35.3 rule 7). Requeue dies the same way. Abandon lets
  the run close, and the delinquency counters then count the borrower who paid
  as delinquent. Until one or the other, the day's `cashiering_daily` run
  stays `running` and every `delinquency_counters` job that depends on it is
  `blocked` (domain/operations-runtime/cycles.ts:282).

  The officer cannot post the payment by hand either: the 35.8 payment-post
  screen refuses `NO_CUSTODIAL_ACCOUNTS`
  (domain/operations-runtime/derivers-35-8.ts:69, :83). And one dead unit
  holds back more than its own loan: the day's `cashiering_daily` run, and
  every job in the book that waits on it, stays blocked until the officer
  chooses.

  Two related effects, read from the code and not run: postPayoff's default
  ids `C-PI` and `C-TI` (app/tools/section16-2.ts:44) map to uuids with no row
  (infra/db/ledger.ts:19-23, FK at db/migrations/0001_baseline.sql:340), and
  the 35.10 closeout waits on `custodial_accounts` for such a loan
  (app/tools/section35-10.ts:364).

- **Reproduction.** A scratch database with the app's 177 migrations. One
  clean tape loan, harness-35-5's T-7 (P&I $1,896.20, escrow $412.30, next due
  2026-11-01), was boarded on 2026-10-16 through `1.1 boardLoan{batch, files}`
  on the bus, the production writer. It boarded with its schedule and its
  configuration row, and the servicer party held one custodial account,
  `clearing`. The 6.1 path then planned the arrangement's accounts and took
  the P&I and T&I accounts to `active`. That wrote three entity versions, and
  the table still held only `clearing`. A full installment of $2,308.50 was
  received on 2026-11-03 through the cash-rows port, the same write
  lockbox.ts:296 and ach.ts:213 make. `Runtime.sweep` then ran three times a
  day from 2026-11-03 to 2026-12-08, with nothing inserted by hand. Over those
  36 days:
  - 36 dead `cashiering_daily` units, one a day, each `CUSTODIAL_REQUIRED`
    after three attempts;
  - zero `payment.posted`: the payment stayed `received` and the 2026-11-01
    installment stayed `due`;
  - 71 sev 3 officer escalations, from the dead unit and its `SM_JOB_DEAD_2H`
    breach;
  - one breach each of `REGZ_1026_36C1_CREDIT_AS_OF_RECEIPT_POST_1BD` (to
    cashiering) and `FNMA_C1101_DEPOSIT_CUSTODIAL_24H` (to custodial-recon);
  - 36 `delinquency_counters` runs planned and never run.

  On 2026-12-09 a requeue died the same way. Abandoning the dead units let the
  counters run. The loan was then 38 days delinquent on the installment it had
  paid. A Reg X window opened for it, `REGX_1024_39A_LIVE_CONTACT_36`
  breached, the 45-day written notice came due on 2026-12-16 and
  `REGX_1024_41F1_120_DAY_GATE` was armed, all with the payment still
  unposted.

  As a control, a copy of the database at 2026-12-08 was given the `pi` and
  `ti` rows the app's tests insert by hand (harness-35-5.ts:118-125), and one
  dead unit was requeued. The payment posted as interest $1,519.15, principal
  $377.05 and escrow $412.30, credited as of 2026-11-03, and the installment
  was satisfied. The 397-day simulation shows the same thing: its first
  payment was refused `CUSTODIAL_REQUIRED` on 2026-11-23, and `pi` and `ti`
  were inserted by hand about a minute later, before a requeue posted it. Two
  independent checks reproduced it by other paths: the seed route
  (`node scripts/run.mjs seed-demo`), a payment through a fake lockbox file
  and `lockbox.ingest`, and the unit run both by hand and through the hosted
  whole-book run. The harm is the unposted cash and the delinquency counters
  running meanwhile, not a wrong credit date: once the accounts exist, the
  payment is credited as of its receipt. Found and reproduced on 22 October 2026.

- **Smallest fix.** In both boarding writers, find or insert `pi` and `ti`
  beside `clearing`, as 35.1-T10 says
  (`custodialAccount(q, partnerParty, "pi")` and `"ti"` at
  runtime/transfers.ts:114 and app/tools/section01.ts:86), and make
  35-1.spec.test.ts:536 check all three. That makes the posting accounts
  exist. Making them the real accounts §6.1 and §6.2 open needs a 35.1 row
  projector for `custodial_accounts`: one that writes those accounts to the
  table under the servicer party, with their status.
- **Kept out by.** No environment runs the hosted cashiering cycle.
  payments-posting grades the ported allocation engine, which takes its
  custodial accounts as given.

### scra-1. 13.8's SCRA waiver posts the reversal but leaves the fee row `assessed`, so the waived charge is billed, quoted and taken from the next payment 🔴

- **Spec says.** §13.8 rule 8: "waive late charges accruing after the call to
  active duty (2.7 `FNMA_C1102_MILITARY_INDULGENCE_LC_WAIVER_GATE`)". Its
  ledger line is "late-charge waivers (2.7)"
  (13-8-scra-foreclosure-protection.md:95, :109), and 13.8-T3 says that on
  DMDC Y for a pre-service obligation, "late charges waived" (:128). Fannie
  Mae D2-3.4-01: "The servicer must waive any late charges that became due
  after the servicemember was called to active duty"
  (2-7-late-charge-assessment.md:30). §2.7 makes that a 2.7 waiver:
  - rule 3(iii) waives the charge as `fee.waived{scra}` (:78);
  - rule 5 lists SCRA among the automatic waivers: "waived charges are
    `fee.waived` events and reduce `late_charges`" (:80);
  - the gate's satisfier is `fee.waived{scra}` (:63);
  - the `fees` row carries `state` `waived`, `waived_cents` and
    `waiver_reason` `scra` (:49);
  - worked example O waives the charge as `fee.waived{scra}` (:89).

  Rule 4: a charge is collected only from funds beyond the payment and only
  while it is outstanding, and payoff figures include it only while it is owed
  (:79). Reg Z 1026.41(d) and 1026.36(c)(3) require the statement's and the
  payoff's amounts to be accurate. Reg X 1024.35(b)(5): a fee the servicer has
  no reasonable basis to impose is an error. 50 U.S.C. 3937(d)(1) also counts
  fees as interest under the 6% cap once 13.9's period is in force. The
  reproduction below never reaches 13.9, so it rests on D2-3.4-01 and
  §13.8/§2.7, not on 3937.

- **Engine does.** `scra.case.get/open/close{op: open}` takes the outstanding
  late charges assessed on or after `service_begin_on` from the 2.7 `fees`
  rows (app/tools/section13.ts:609-613, :642). It then posts Dr corporate
  `late_charge_income` / Cr loan `late_charges` and appends
  `late_charges.waived` (:655).
  - It writes no fee row. The open op writes only `scra_cases` (:646) and
    `attorney_instructions` (:651).
  - It emits no `fee.waived`, and nothing consumes `late_charges.waived`.
  - 2.7's own SCRA hand-off, `LateChargeOps.scraPeriodStarted`
    (domain/cashiering/ops-2-7.ts:173-187), would waive each such charge as
    `scra` (:183), but it has no caller outside 2-7.spec.test.ts (:206).
  - 13.9's rate-cap waiver does write its rows, `state: "waived"`
    (app/tools/section13-9.ts:219). 13.8's waiver does not.

  So the ledger says the charge is gone, the row says it is open, and the
  readers split the way they do in cashiering-20, the other way round:
  - The row feeds the cash state
    (domain/operations-runtime/cashiering-cycle.ts:144-145), so the next
    payment's remainder pays the charge. It also feeds the 35.8 payoff quote
    (domain/operations-runtime/derivers-35-8.ts:117) and the periodic
    statement (runtime/servicing.ts:105). All of these still carry the charge.
  - The ledger feeds 35.10's quote
    (domain/operations-runtime/closeout-35-10/derive.ts:62) and the console's
    loan page (console/pg-store.ts:59). Both show nothing owed.

  The handler's own idempotence depends on the row: `lateChargesSinceService`
  subtracts `waived_cents` (:611), which the handler never writes, so a second
  open waives the same charge on the ledger again. 13.9's `lateCharges`
  (section13-9.ts:76) also admits a row with no `waived_at`, so a charge
  inside the cap's window would be waived and posted a second time there too.
  One of the two independent checks ran that second effect: a 13.9 rate
  activation after the 13.8 open waived the same charge on the ledger a second
  time. The app's test checks the ledger set and the events, never the row
  (domain/foreclosure/13-tools.test.ts:62-69).

- **Reproduction.** A scratch database with the app's 177 migrations. Copies
  of L-1 were boarded through the transfer path on 2026-08-20, with the daily
  unit run every day. The P&I and T&I custodial accounts were inserted by hand
  with the harness's `seedCustodial`, because a transfer board makes none
  (boarding-4). For the statement, a borrower party was linked by hand
  (boarding-2). Each loan was assessed 7,901c on 09-17. On 09-18,
  `dmdc.results.import` recorded a Y, with service begun 09-05, after the 2021
  note. Then `scra.case.get/open/close{op: open}` ran as foreclosure-ops:
  - The case opened `open_active_duty`, gate closed, status 32 queued,
    `late_charges_waived_cents` 7,901, with a set Dr `late_charge_income`
    7,901c / Cr loan `late_charges` 7,901c. The ledger's `late_charges` stood
    at 0 and the console page listed no late charges.
  - The fee row, as the entity record and in the typed `fees` table, still
    read `assessed` with `waived_cents` 0. There was no `fee.waived`, and the
    derived state read 7,901c due.

  The loans then went three ways:
  - Loan S, no payment. On 09-28 the 35.8 quote (good through 10-15) carried
    7,901c in late charges, 25,320,762c in all. That is the untouched
    control's figure, against 25,312,861c on loan G, where the row was also
    written `waived{scra}` after the open (2.7 `fees.waive` record path, as
    13.9 writes its rows). 35.10's record facts on S carried 0c, giving
    25,312,861c. The statement for 10-01 asked S for 446,415c, with 7,901c in
    late charges, the control's figure; it asked G for 438,514c.
  - Loan P: a 227,158c payment on 09-25, the 09-01 installment plus 7,901c.
    The unit sent 7,901c to `late_charges`
    (`installments.applied:1 → remainder.late_charges:7901`), leaving the
    receivable at −7,901c. On loan F, with its row written `waived{scra}` like
    G's, the same payment sent the 7,901c to `suspense_unapplied`. P's row
    then still read `assessed`, which cashiering-19 compounds, but the first
    collection is this defect.
  - Loan D: two opens on 09-18 with the same inputs. Both succeeded and each
    posted a 7,901c set. `late_charges` stood at −7,901c and
    `late_charge_income` at a net Dr 7,901c. 35.10's facts read −7,901c,
    giving 25,304,960c, while the row and the 35.8 quote still read 7,901c
    due.

  A second run on a database of its own repeated S, G and an untouched control
  N cent for cent, with N's quote at 25,320,762c and its statement at
  446,415c. Found and reproduced on 22 October 2026. Two independent checks
  reproduced it by other paths and fixtures.

- **Smallest fix.** In the open op, beside the ledger post at
  section13.ts:655, write each fee in `waiver.fee_ids` with `state: "waived"`,
  `waived_cents` equal to its outstanding amount, `waiver_reason: "scra"` and
  `waived_at`, and append `fee.waived{reason: scra}` for each, the gate's
  satisfier. That is what 13.9 does at section13-9.ts:219, and it makes
  `waived_cents` at :611 the idempotence guard it was written to be. Assert
  the row in 13-tools.test.ts.
- **Kept out by.** No environment calls 13.8 or runs the hosted cashiering
  cycle. payments-posting carries an `scra` waiver reason
  (packages/environments/src/payments/ported/latecharges.ts:102) but never
  waives.
  - Not cashiering-20: there, 2.7's waivers write the row and never post the
    ledger. Here, 13.8 posts the ledger and never writes the row, and
    cashiering-20's fix, in 2.7's and 4.1's tools, does not reach
    section13.ts; its third fix bullet names the same pattern for 4.1's tools.
    Writing the row alone is not enough either: the fix must emit `fee.waived`
    with reason `scra`, or the FNMA_C1102 gate stays armed.
  - Not cashiering-19: there a paid charge's row goes stale. Here the charge
    was waived, never paid, and even its first collection is wrong.
  - Not cashiering-13 or cashiering-18: those are charges assessed after the
    case opens because no overlay reaches the unit. Here the charge was
    assessed before the waiver, and the reproduction ends before the next
    grace end on 10-17.

### lossmit-3. A borrower performing under a forbearance plan is referred to foreclosure, because activation never writes the plan's hold 🔴

- **Spec says.** 12.4's timer table arms `REGX_1024_41C2III_PERFORMANCE_HOLD`
  on an active plan, with the breach action "13.x refuses referral/motion/sale
  (`foreclosure_holds{kind=fnma_plan_performing}`)"
  (12-4-forbearance-plan.md:86). That hold row is among the section's records
  (:110), and 12.4-T9 reads "13.3 referral command refused while the plan is
  active" (:142). 12.5 says the same for a repayment plan
  (12-5-repayment-plan.md:78, :104; 12.5-T6 at :131). 13.2's vocabulary scopes
  the kind to refer, judgment_motion, sale_schedule and sale_conduct
  (13-2-dual-tracking-restriction.md:76), and calls a kind no section writes
  "a dead gate" (:62). The rules behind it:
  - Fannie Mae E-3.2-01: for a principal residence the servicer must not refer
    when "there is an approved payment arrangement for a workout option" or
    the borrower "has accepted an offer for a workout option and is performing
    in accordance with its terms" (quoted at 13-4-prereferral-review.md:28).
  - E-3.2-04, for any other property: once the first forbearance or repayment
    payment is received, the servicer "must delay the foreclosure referral
    until the borrower breaches the plan" (:30).
  - D2-3.2-01: a forbearance plan needs no complete BRP, and referral is one
    of the four outcomes that must follow once the plan is complete.
  - Reg X 1024.41(c)(2)(iii): no first notice or filing, motion or sale while
    the borrower performs under a short-term forbearance or repayment plan
    offered on an incomplete application. The spec applies the same rule to
    every plan (12-4-forbearance-plan.md:38).
- **Engine does.** `forbearanceActivation` returns the hold,
  `hold("fnma_plan_performing", term_start, term_end)`
  (domain/lossmit/ops.ts:209-211), and the activation path drops it. 12.5's
  `shortTermPlanOffer` computes the same hold (ops.ts:332-336), and only
  domain/lossmit/12-5.spec.test.ts:155 calls it. It takes the notice dates,
  writes `workout_plans` and emits `workout_plan.activated`
  (app/tools/section12.ts:189-192). 12.4's `op: term`
  (app/tools/section12-4.ts:51-65) and 12.5's activation
  (section12.ts:216-224) write no hold either. The refusal exists only as
  12.4's `op: referral_check`, over a `plan_status` the caller states
  (section12.ts:184; ops.ts:272-273). No 13.x or 35.9 code calls it, and
  12.4-T9's test drives only that op
  (domain/lossmit/12-4.spec.test.ts:275-284). The armed clock
  (domain/lossmit/timers.ts:167) has no reader. 13.1's refer gates read the
  loan row, `lossmit_applications` and `foreclosure_holds`
  (app/tools/section13.ts:231, :89-100, :289), never `workout_plans`. Its one
  performing gate reads trial holds only, and not at `refer` (:330). 35.9's
  referral step proposes on open gates, a 13.4 `refer` review, a retained firm
  and no hold row (domain/operations-runtime/default-35-9/referral.ts:58-65,
  :120-137). The officer's approval re-runs the gates (:83-88); that re-run is
  what cancels a referral in 35.9-T8 when a 12.1 application arrives, and a
  plan cancels nothing. What else might stop it:
  - The 13.4 review. Its `PR_NO_APPROVED_ARRANGEMENT` item is the caller's
    statement (`approved_arrangement`, section13.ts:451), and
    `complete_review` reads the store for SCRA, bankruptcy and disaster only
    (:376-381, :420-421). The referral step takes the latest completed review,
    whenever it completed (referral.ts:26), so a plan activated after a
    `refer` review is never seen.
  - The officer. The 35.8 screen reads 13.1's gates and the case
    (domain/operations-runtime/work-35-8/screens.ts:90), and the proposal's
    rationale says "no hold".
  - 12.1's and 12.2's holds (`regx_f2_prefiling`, `regx_g_dual_track`,
    `lm_offer_pending`, `fnma_e3401_*`) open on complete applications, offers
    and appeals (13-2-dual-tracking-restriction.md:66-74). A forbearance plan
    on QRPC or an incomplete application gets none.
  - A complete application does stop it, through the (f)(2) gate
    (section13.ts:94, :309), not a hold. A 12.5 plan past 90 days delinquent
    needs a complete BRP (domain/lossmit/ops.ts:287), so a repayment-plan loan
    past day 120 normally has one, and a performing repayment plan opened on
    QRPC cures arrears before day 121. The exposure is forbearance, whose
    suspended payments let the delinquency grow through the term: 12.4's own
    worked example is 11 months delinquent in its third term
    (12-4-forbearance-plan.md:93).
  - Trial plans: 12.6 writes none, and 12.8's trial is not wired into the
    runtime (lossmit-2).
  - After the referral, 13.1's `first_notice` gates do not name the plan
    either (section13.ts:308-331).
  - Reach: no runtime code opens a `prereferral` foreclosure case or writes
    `note_custody` or the case's `referral_package_document_id`. Only tests
    write them (domain/operations-runtime/35-9.spec.test.ts:100, :494), so the
    runtime as wired refers no loan yet. Seeded as 35.9-T8 seeds them, the
    plan never stops the referral.
- **Reproduction.** A scratch database built by the app's own `db-setup` with
  all 177 migrations. Six copies of L-1 (Texas, owner-occupied, due
  2026-09-01, never paid) were boarded through the transfer path on
  2026-08-20. No payment was posted, so no custodial account was needed. The
  hosted sweep ran daily at 11:00Z as main.ts runs it: 204 sweeps from
  2026-08-21 to 2027-03-12, all completed. Instrumented, in 35.9-T8's shapes
  because nothing else writes them: a retained FAKE Texas firm, and on
  2026-12-16 a `prereferral` case with its package document and a
  `note_custody` row on each loan. Everything else went through the sections'
  tools. On 12-22, inside the review window, each loan's 13.4 review ran
  `start_review`, `dmdc.verify`, `bk.scrub` and `pr_prohibitions` with
  `complete_review`. All but D's completed `refer`.
  - F: a 12.1 incomplete application on 12-26, then on 12-28 a 12.4 short-term
    offer on it and the activation path. The term ran 2027-01-01 to 03-31 with
    payments suspended, the (c)(2)(iii) shape. T: no application, offer and
    then `op: term`. N: no plan.
  - On 12-31 (day 121) the daily unit proposed the referral on N, F and T
    alike, with the rationale "gates open (19 evaluated) … no hold". 13.1's
    refer gates were all open on F and T, no gate named the plan,
    `foreclosure_holds` was empty, and the performance-hold clock was armed.
  - On 2027-01-04 (day 125, the plan's fourth day) the officer approved. The
    re-run gates were open, and `foreclosure.referral.sent`,
    `attorney_referrals` and a `referral_package` dispatch were written for F
    and T as for N. The same day, 12.4's own `referral_check` refused: "13.3
    referral refused: workout plan active (REGX_1024_41C2III_PERFORMANCE_HOLD
    / D2-3.2-01)".
  - On 01-05 the firm acknowledged, and F's `first_notice` gates were all
    open. On 02-18 the FAKE firm's FIRST_LEGAL report recorded
    `foreclosure.first_notice.filed`, and on 03-11 a sale was scheduled for
    04-10. The plan read `active` throughout, and no hold instruction went to
    the firm.
  - Controls. H: as F, plus 12.1's own `foreclosure_holds.set` for kind
    `fnma_plan_performing` on 12-28. 13.1 closed `HOLD:fnma_plan_performing`,
    nothing was proposed, and the officer's `propose` by hand returned "gates
    closed". D: the plan activated 12-18, and the reviewer stated
    `approved_arrangement: true`. The review read `hold_lossmit`, and nothing
    was proposed. R: a 12.1 complete application on 12-23 and a 12.5
    nine-month plan on 12-28. `REGX_1024_41F2_PRE_FILING_APP_GATE` closed,
    nothing was proposed, and R had no `fnma_plan_performing` row either.
  - The same script on a second scratch database, sweeping from 2026-12-14,
    gave the same proposals, approvals and refusals. Found while reproducing
    lossmit-2, and reproduced in isolation on 22 and 23 October 2026. Two
    independent checks reproduced it, one on 35.9-T8's own fixture path with a
    Florida judicial loan and the daily unit called directly. The other found
    a variant: a plan activated after the engine's proposal and before the
    officer's approval is not caught either, because the re-run gates still
    see no plan. High, with one limit on reach: no runtime code yet opens a
    prereferral case or writes the note custody and package records, so the
    runtime as wired refers no loan today; once those writers exist, every
    forbearance loan past day 120 is referable.
- **Smallest fix.** At each activation (section12.ts:189-192,
  section12-4.ts:51-65, section12.ts:223-224), write the hold in 12.1's writer
  shape (app/tools/section12-1.ts:24-27). Use kind `fnma_plan_performing`,
  scoped to refer, first_notice, judgment_motion, sale_schedule and
  sale_conduct, from the activation date, citing 1024.41(c)(2)(iii) and
  E-3.2-01. Close it in `planLifecycle`'s end ops (section12.ts:79-86) with
  `foreclosure_holds.closed`, so a `terminated{failed_terms}` loan opens 1 BD
  later (12.4-T9). The scope should carry `first_notice`, which 13.2's table
  omits, because (c)(2)(iii) bars the first filing on a loan referred before
  its plan began. 13.2's table also names 12.6/12.7 as the writer, against
  12.4's and 12.5's own outputs; correct both in the same change. 13.1 already
  refuses on the row (section13.ts:332), as H shows. Fix lossmit-1 with it, or
  the hold is never released.
- **Kept out by.** No environment runs 12.4's lifecycle, 13.1's gates or
  35.9's referral. lossmit-retention ports only the plan term calculators
  (packages/environments/src/lossmit/ported/plans.ts).

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
  hosted cashiering unit:
  `payment.applied{installment_due_date 2026-10-01, credited_as_of 2026-10-15}`
  and the installment `satisfied`, with no `timer.cancelled`. The 11-07 sweep
  breaches the live-contact clock and its warning, and the 11-16 sweep
  breaches the notice clock: two sev-1 `officer` escalations while
  `regx_ei_windows` reads `cancelled_paid` on both legs. Posting with
  `payments.read/write{op=post}` breaches the same three clocks. The same two
  events through spec-harness.ts cancel all three (`paid_before_36`,
  `paid_before_45`). Two independent checks reproduced it, one with the full
  hosted sweep and the payment made on day 30, and one that attached the
  reader to each restored engine in its own process: all three clocks then
  cancelled. In the 397-day runtime simulation, SM-TR-0000001's notice clock
  breached for 14 windows, 12 of them paid by day 33, and its live-contact
  clock for six windows paid on day 2 or day 32; an inbound call marked three
  more, paid on day 2, `satisfied_late`. Found on 22 October 2026 and
  reproduced the same day.
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

### boarding-3. A transfer tape's co-borrower is dropped without a trace, so a joint loan boards with one borrower 🟡

- **Spec says.** §1.1: "every transferor column maps to a MISMO v3.6 path …
  unmapped columns are stored raw and flagged `info`"
  (1-1-loan-data-intake-validation-note-terms-remittance-type-a-as.md:99), in
  `boarding_staging` (:69). The codec's own dictionary sends `coborrower_name`
  there: "(unmapped → boarding_staging raw, flagged info)"
  (domain/boarding/tape-codec.ts:99;
  fixtures/transfer-batch-demo/LAYOUT.md:80). Boarding writes
  `borrowers`/`loan_borrowers` (:72). Reg X 1024.38(b)(4)(ii) has the
  transferee "identify necessary documents or information that may not have
  been transferred" and obtain them (:28). §8.1's boarding data contract asks
  for the transferor's last Base/J/K segments, or at minimum "ECOA per
  consumer" (8-1-furnish-tradeline-metro-2.md:51). Rule 5 makes "each
  additional obligor → J1 (same address) or J2", ECOA `2` for joint liability
  (:115). Reg V 1022.41 requires furnished information that "correctly
  reflects the terms of and liability for the account" (:34). §1.3 mails the
  hello notice to "each borrower on `loan_borrowers`"
  (1-3-respa-transfer-notices-goodbye-hello.md:85). §4.4 treats a co-borrower
  as a borrower, not a successor (4-4-successor-in-interest.md:113). §14.4
  reports a non-filing co-obligor apart from the filer
  (14-4-credit-reporting-suspension-in-bk.md:64).
- **Engine does.** The decoder never reads `coborrower_name`
  (domain/boarding/tape-codec.ts:222-270; the one borrower at :252), and
  `StagedLoan` has one borrower (domain/boarding/types.ts:60).
  `insertBoardingRows` writes one `borrowers` row and one `loan_borrowers` row
  with role `borrower` (runtime/transfers.ts:190-191). The bus command
  `1.1 boardLoan{batch, files}` decodes and writes through the same two
  functions (app/tools/section01.ts:69, :108). Neither path writes
  `boarding_staging` or `boarding_tapes`, no rule raises an `info` row, and
  `ingestTape` keeps the file's id, kind, hash and row count in memory, not
  its bytes (domain/boarding/service.ts:104-114). The transfer path writes
  `boarding_staging` for no column at all; its one writer is the origination
  path (app/tools/section30-2.ts:32). Once the transaction commits, the
  co-borrower's name exists nowhere on the platform. The Metro 2 builder then
  reads a one-row loan as `individual`
  (domain/operations-runtime/runners.ts:144), so the base segment is ECOA `1`
  (domain/credit-reporting/metro2.ts:121-125) and no J1 is built. 8.2's ACDV
  response takes its ECOA from that segment
  (domain/credit-reporting/ops-8-2.ts:396-398). From reading, not running:
  §14.1 matches a bankruptcy by last name and SSN4
  (14-1-bankruptcy-monitoring-proof-of-claim.md:114), and the platform holds
  no identity to match a co-borrower's petition against. Part of this is the
  layout's. The tape carries only the co-borrower's name, with no TIN, date of
  birth, contact, address or ECOA (tape-codec.ts:99), and §8.1's contract asks
  for more. Dropping the name silently is the engine's doing.
- **Reproduction.** Two scratch databases with the app's migrations, and the
  demo batch boarded, once through `boardTransferBatch` and once through the
  bus command.
  - **The tape.** 100 rows, 33 naming a co-borrower. TR-0000002 is Maria Reyes
    with co-borrower Linda Reyes, and `coborrower_name` is the only
    co-borrower column. `decodeTransferBatch` leaves all 25 co-borrower names
    that are not also a primary's name out of every `StagedLoan`.
  - **What boarding wrote, on both paths.** All 33 joint loans boarded, each
    with one `loan_borrowers` row, and all 100 rows in that table have role
    `borrower`. `boarding_staging` and `boarding_tapes` are empty, and there
    is no `info` validation. A search of every row of all 858 tables found
    none of the 25 names; the same search finds the primaries in `borrowers`.
  - **Metro 2, SM-TR-0000002, as of 2026-09-30.** boarding-2 and metro2-1 were
    patched in the process only: the borrower was linked to a party by the
    35.5 harness's `linkBorrowerParty`, and `k3.min` was taken from
    `loans.min`. Result: one consumer, base ECOA `1`, no J1. The 8.1 cycle
    validated it with no exception, and 8.2's `responsePayload` for that
    borrower gives `ecoa: "1"`.
  - **Control.** A `coborrower` row for Linda Reyes was written by hand
    (`borrowers` and `loan_borrowers`, with a party). The same builder then
    gives base ECOA `2` and J1 ECOA `2`. The furnishing side handles a joint
    loan; boarding never gives it one.
  - **Masked today.** boarding-2 leaves out every transfer-boarded loan as
    `no_consumer`, and metro2-1 drops every record for its MIN. The rendered
    bureau record also carries no consumer fields at all (`renderBase`,
    domain/credit-reporting/metro2.ts:227-252), so no file shows the wrong
    ECOA yet. SM-TR-0000002 is one of the 33 joint loans.

  Two independent checks reproduced it by other paths: the committed fixture
  files posted to the app's own `POST /v1/transfers/batches` route, and the
  deploy's seed entry (`node scripts/run.mjs seed-demo`), each with a search
  of the whole database, binary columns included.

  Found on 22 October 2026 and reproduced the same day. The gap is also
  catalogued as D-14 in docs/synthetic-data-defects.md.

- **Smallest fix.** At the least, store unmapped columns in `boarding_staging`
  with an `info` row, as §1.1 and the layout's own dictionary say, so the
  co-borrower is not lost. Then decode `coborrower_name` into a second
  borrower on the `StagedLoan`, and have `insertBoardingRows` write it as a
  `borrowers` row and a `loan_borrowers` row with role `coborrower` and
  `is_primary` false. It needs a party too (boarding-2's fix), or the Metro 2
  builder still skips it. While the tape has no co-borrower TIN, raise a
  warning so the transferor is asked for it (Reg X 1024.38(b)(4)(ii)).
- **Kept out by.** Nothing needs to. metro2-furnishing generates its own
  consumers, joint ones included
  (packages/environments/src/metro2/generator.ts:212-216), and no environment
  boards a transfer tape.

### http-1. A payoff's buckets and a ledger line's amounts cannot cross the HTTP tool routes 🟡

- **Spec says.** §16.2's AI agent design: the `payoff-release` agent posts the
  payoff with `postPayoff`. §35.1's trigger runs every
  `POST /v1/loans/{id}/tools/{process}/{name}` command. §35.11 rule 10 posts
  every tool over HTTP as its own agent and counts a 500, or a 400 from a
  `TypeError`, as errored. §2.1's human path puts the same commands on the ops
  console, and the officer makes manual ledger adjustments over $10,000. The
  route's wire convention is money as a decimal string of cents
  (runtime/server.ts:50; docs/DEPLOY.md:542), and §35.1 revives "every
  `*_cents` field" to bigint (35-1 :47). §2.1 says the console "exposes the
  same commands with identical validators" (2-1 :146), and §16.2's AI-off path
  is the "ops-console payoff workbench with the same tools" (16-2 :114).
- **Engine does.** The /v1 route turns only keys ending `_cents` into bigints
  (runtime/server.ts:140-150). The console's route converts nothing
  (console/server.ts:464). `postPayoff` casts `buckets` (`accrued_interest`,
  `principal`, …) without converting them (app/tools/section16-2.ts:253,
  guardrail :272; domain/payoff/ops-16-2.ts:132, :142-144). `ledger.post`
  hands `entry_set.lines[].amountCents` to the kernel ledger as sent
  (app/tools.ts:189-193; kernel/ledger/ledger.ts:120-121). A decimal string
  concatenates into the sum, and a number throws `TypeError`, so neither tool
  completes on either route. Separately, `postPayoff` never checks the buckets
  against the loan: a missing key defaults to zero (ops-16-2.ts:141), so a
  buckets object with no principal, `{}` or one renamed `*_cents`, retires the
  loan with nothing applied. That is reachable in process too.
- **Reproduction.** A fresh database, with Runtime and createApiServer booted
  as lifecycle.test.ts boots them. The loan holds principal 55,945,571c and
  interest due 262,864c. A wire of 56,208,435c is cleared by
  `matchPayoffFunds` over /v1 (200).
  - `ledger.post` receipt over /v1, `amountCents` as strings: 500 ("sum
    056208435-56208435 cents"). As numbers: 400, "Cannot mix BigInt and other
    types".
  - `postPayoff` over /v1, buckets as strings or numbers: 400, the same
    TypeError.
  - On `/ops/api/tools` as officer: 500 for both tools.
  - Buckets named `principal_cents` and `accrued_interest_cents`: 200, applied
    0c, unapplied 56,208,435c, `loan.paid_in_full`, `loans.status` paid_off.
    Principal 55,945,571c stays on the ledger, and the wire is booked to
    custodial T&I as an overage pending refund. `buckets: {}` does the same.
  - The same inputs in process with bigints: zero, applied 56,208,435c, every
    loan account at 0.

  Two independent checks reproduced it by other paths, one through the real
  `run.mjs serve` process with a loan boarded by the seed's transfer batch,
  with curl and Python clients.

- **Smallest fix.** Convert at the tool, not the route.
  - In `ledgerPost` (tools.ts:189), pass each line's `amountCents` through
    `cents()` (tools.ts:163).
  - In `postPayoff` (section16-2.ts:253) and its NO_SHORT_APPLICATION
    guardrail (:272), build the buckets with `cents()` per `PayoffBuckets`
    key. Refuse an object that lacks `principal` or `accrued_interest`, or
    carries any other key.
  - Making `UnbalancedEntrySet` (ledger.ts:95) a `RangeError` turns the 500
    into a 400.
- **Kept out by.** Nothing in `packages/environments` runs the hosted runtime.
  payoff-statement grades through ports of quote.ts, remit.ts and
  investor/remittance.ts. The servicing app's own lifecycle test posts the
  receipt and the payoff with `runtime.execute` and bigints
  (lifecycle.test.ts:759, :790, :798), though its header and
  docs/DEPLOY.md:545-547 say every step runs over HTTP. The hosted probe posts
  `{}`, which both tools refuse before any arithmetic (docs/audit/hosted.json:
  `LEDGER_VIA_COMMANDS` and `NO_POST_BEFORE_CLEARED`, both refused_typed).
  Only the 35.10 refinance close pays a loan off, in process
  (section35-10.ts:377, :408).

### lossmit-1. A forbearance plan is never ended at its term end, so it reads active, and "Paused" to the borrower, for good 🟡

- **Spec says.** §35.9 rule 2(c): the daily unit runs, through 12.x's own
  tools, "the workout plan's end-of-term check (12.4/12.5:
  `workout_plan.expired` / `.failed` / `.completed`)"
  (35-9-default-operations-over-time.md:83). §12.4's state machine takes
  `active` to `expired` at the term end, then to a disposition
  (12-4-forbearance-plan.md:68). Under D2-3.2-01, a borrower without QRPC at
  expiry is evaluated for a Payment Deferral or Flex Modification and
  solicited within 15 days after expiration (12-4-forbearance-plan.md:34). The
  registry arms those solicitation clocks on `workout_plan.expired`, and the
  same event releases the performance hold (spec/registry/timers.json:7901,
  :7912, :7923).
- **Engine does.** `caseProgress` runs step (c) only through a hook,
  `PROGRESS_STEPS.current.lossmit`
  (domain/operations-runtime/default-35-9/daily.ts:54, :58). The object is
  `{}` (:45), and nothing in the tree assigns it. The unit's report leaves the
  step out instead of reporting it `skipped`, as daily.ts:40 promises. 12.4's
  end op exists (app/tools/section12.ts:79-86, `op: expire`), and
  12-4.spec.test.ts:186 drives it by hand, but nothing in the runtime calls
  it. The other half of 2(c), 12.2's deemed rejection, runs in the hardship
  flow's tick (runtime/borrower/flows/10-hardship.ts:435-446). Nothing does
  the same for a plan. The one runtime signal is the disposition clock, armed
  at activation for the term end (domain/lossmit/timers.ts:114). It breaches
  into one sev-2 `ops_analyst` escalation, because no breach action is
  registered for it (domain/operations-runtime/default-35-9/sweep.ts:49-52).
  Its satisfier `workout_plan.closed` (timers.ts:168) has no runtime caller
  either. What reads the stale plan:
  - The borrower's status reads "Paused" until a `workout_plan.ended` arrives
    (runtime/borrower/record.ts:353-354), with the state source
    `workout_plans.status=active (forbearance through <term_end>)`. The
    record's hardship section reads `active` too
    (runtime/borrower/flows/10-hardship-record.ts:69-73).
  - `REGX_1024_41C2III_PERFORMANCE_HOLD` is satisfied only by
    `workout_plan.ended` (timers.ts:167), so it stays armed. Nothing reads it
    today.
  - The post-forbearance solicitation clocks arm only on
    `workout_plan.ended{status=expired}` (timers.ts:40-41, :68), so a missed
    15-day solicitation never breaches.
  - Not exercised here: "extend my forbearance" prescreens an extension from
    the stale plan's old `term_end` (10-hardship.ts:397-402). 12.4's
    `month_end` op would keep reporting status 09 for the plan
    (app/tools/section12-4.ts:36, :95-100), but no runtime pass calls it.
  - Late charges are cashiering-18's. Its fix bounds the overlay by the term's
    dates, so it does not depend on this status.
  - 12.5 repayment plans go through the same missing step, and rule 2(b)'s
    `early_intervention` hook (daily.ts:42, :56) is just as uninstalled.
    Neither was reproduced.
  - A neighbor, not filed here: the case fold listens for
    `workout_plan.active` and `workout_plan.expired`
    (domain/operations-runtime/default-35-9.ts:77-78). 12.4 emits
    `workout_plan.activated` and `workout_plan.ended`, so even a hand-run
    expiry never reaches the case timeline.
- **Reproduction.** A scratch database with all 177 migrations, and three
  copies of L-1 boarded through the transfer path on 2026-08-20.
  - P went through 12.4 `workout_plan.*` offer, then the activation path
    (section12.ts:183-192). T went through offer, then `op: term`, the 12.4
    spec test's path. Both terms ran 2026-09-01 to 11-30 with payments
    suspended. C was activated as P.
  - The hosted sweep ran as main.ts runs it (flows tick, `Runtime.sweep`,
    settle): daily to 2027-01-31, then weekly to 2027-08-29. All 189 sweeps
    completed.
  - `default_case_daily` ran `case.progress` on each loan every day from
    09-02, 92 days of it after the term end. A hand run on 12-15 reported
    fold, firm_inbound, referral, exposure, expectations_due, docket and
    claims, with no lossmit step.
  - On 2027-08-29, 272 days past the term end, P and T still read `active`.
    Neither had a `workout_plan.ended`, the performance hold was still armed,
    and no solicitation clock existed. Each had one sev-2 disposition
    escalation, opened 12-01. The borrower status read "Paused (forbearance
    through 2026-11-30)".
  - Control C got the section's own `op: expire` by hand on 12-01. It then
    read `expired` and had a `workout_plan.ended`. Its hold was satisfied, and
    `FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15` was armed for 12-15; it
    breached into its own sev-2 on 12-16. Its status read "Behind",
    `regx_days_delinquent=120`, the same delinquency P's borrower is told is
    "Paused".
  - Found by the 397-day runtime simulation on 22 October 2026, where the plan
    still read active nine months after its February 28 end, and reproduced
    the same day. Two independent checks reproduced it by other paths: other
    loans, a one-month term and a database built by the app's own `db-setup`.
- **Smallest fix.** Install `PROGRESS_STEPS.current.lossmit` beside the
  runners (domain/operations-runtime/runners.ts). For each `workout_plans` row
  on the loan that is `active` with `term_end` before the unit's `as_of_date`,
  run 12.4's own `workout_plan.*{op: expire}` (12.5's `complete` or `fail`) as
  `lossmit-underwriter`. Take `qrpc` from a `contact.qrpc.established` since
  the plan's `workout_plan.expiry_approaching`. Take deferral and Flex
  eligibility from 12.4 rule 4's `op: prescreen`. Have `caseProgress` record
  an absent hook as skipped, as daily.ts:40 says.
- **Kept out by.** No environment runs 35.9's daily unit or the 12.4
  lifecycle. lossmit-retention ports only the term calculators in plans.ts
  (packages/environments/src/lossmit/ported/plans.ts).

### boarding-5. A boarded transfer batch never cuts over, so the hello-notice deadline never arms and its miss reaches nobody 🟡

- **Spec says.** §1.3 starts the hello run on the batch's cutover
  ("`transfer.batch.cutover_completed` → hello notice run",
  1-3-respa-transfer-notices-goodbye-hello.md:50). It watches the run with
  `REGX_1024_33B3_HELLO_15`, armed by that event, due on
  `respa_effective_date` plus 15 calendar days, breach "sev 1 → `officer`"
  (:70; spec/registry/timers.json:212). 1.3-T2: a notice mailed on day 16 is
  "breached with `officer` escalation" (:114). Reg X 1024.33(b)(3)(i) requires
  the transferee's notice "not more than 15 days after the effective date".
  §1.2 moves the batch to `cutover` on the transfer date
  (1-2-servicing-transfer-approval-from-fannie-mae.md:62). The run itself
  belongs to the `transfer` agent (1-3-…md:99), so it is not this defect. The
  clock that holds the agent to the date belongs to the runtime.
- **Engine does.** Transfer boarding boards a past-dated batch "as of its
  transfer date (the cutover)" (runtime/transfers.ts:94-95) and writes the
  batch row with status `cutover` (:179). It calls only `svc.board` (:128),
  never `BoardingService.completeCutover`
  (domain/boarding/service.ts:118-130), and that is the only emitter of the
  event a tool can reach for a transfer-in. Its `BoardingService` is an
  in-memory one that is thrown away (transfers.ts:116-120), so the bus's
  `boarding` service never holds the batch, and
  `1.1 boardLoan{batch_id, complete_cutover}` (app/tools/section01.ts:144-148)
  refuses with `no batch` (service.ts:98). That route is the seed's and the
  demo's: `boardTransferBatch` throws `SEED_ONLY` when
  `ENVIRONMENT=production` (transfers.ts:87). The other emitter,
  `TransferBatchService.transition(…, "cutover")`
  (domain/transfers/inbound.ts:204), has no caller: the 1.2 tools only move a
  batch to `approved` (section01.ts:180). The bus form
  `1.1 boardLoan{batch, files}` (section01.ts:54-123) boards the same way and
  returns before it reads `complete_cutover` (:144, :147). The plain form can
  cut over afterwards, but only when no loan is left in `exception`
  (service.ts:122-124), and `BoardingService` has no act for the `reject` or
  `withdraw` edges the machine defines (domain/boarding/machine.ts:34, :38).
  The bus has no waiver act either: `boarding.proposeWaiver` is in
  app/catalog.ts but not in `listTools`, so a loan leaves `exception` only by
  a data correction, and a failure no honest correction cures, such as the
  demo tape's unlicensed state (HF-020), blocks the cutover for good. So in
  production the defect is narrower but still there: the batch form drops
  `complete_cutover` without a word, and one incurable loan holds the whole
  batch. So for a transfer-boarded book `REGX_1024_33B3_HELLO_15` never arms,
  and neither do the other transfer-in clocks keyed on the cutover: 1.1's
  180-day monitoring report, 1.4's custodian notices, 1.5's MERS check, 1.6's
  reconciliation and final accounting, and the short-year statements. The
  60-day late-fee window is among them, but no late charge depends on it,
  because the cashiering cycle reads overlays, not the clock
  (domain/operations-runtime/cashiering-cycle.ts:154; cashiering-11,
  cashiering-18).
- **Reproduction.** On a fresh database, the demo transfer batch was boarded
  through `boardTransferBatch` as `main.ts seed-demo` does it (94 loans
  boarded, 6 held in `exception`). The demo clock then walked 10 days from 10
  September 2026, with the runtime wired as `main.ts` wires it. Result:
  - zero `transfer.batch.cutover_completed` events;
  - none of the 26 clocks the registry keys on that event armed;
  - no MS-2 notice, no `transfer_notice_runs` row and no escalation for the
    hello deadline, while 58 sev-1 `officer` escalations opened for other
    breaches;
  - `1.1 boardLoan{batch_id, complete_cutover}` refused with `no batch`.

  As a control, the 94 clean loans were boarded on a second database through
  `1.1 boardLoan{batch, files, complete_cutover: true}`, and there was still
  no cutover. A second call in the plain form emitted it, and 13 clocks armed,
  `REGX_1024_33B3_HELLO_15` among them, due 16 September. No hello was mailed,
  so the clock breached on 17 September and opened a sev-1 `officer`
  escalation through `breach_actions`, though none of the 94 borrowers had a
  party.

  That control separates this defect from boarding-2. On the first database,
  1.3's own `renderNotice` for the hello template, addressed through
  `servicingParties`, was held "no recipients" for SM-TR-0000001. It rendered
  for SM-TR-0000002 once that borrower was linked to a party, and the hello
  clock was still unarmed for both.

  In the 397-day runtime simulation the batch stayed at `cutover` from 1
  September 2026, with no cutover event, no 1.3 clock, no MS-2 notice and no
  notice run. Found on 22 October 2026 and reproduced the same day. Two
  independent checks reproduced it through the real `scripts/run.mjs` entry
  points and over HTTP, one keeping the tape's six hard failures on the bus
  write; there the plain cutover was refused, "6 loan(s) … are still
  exception". A cutover sent this late arms a clock that is already overdue.

- **Smallest fix.** In `boardTransferBatch`, once `svc.board` leaves no loan
  staged, validated or in exception, call
  `svc.completeCutover(uuid, { respa_effective_date })` before the events are
  persisted (transfers.ts:151). The batch's own timer engine then arms the
  cutover clocks in the same transaction. Do the same in `boardBatchOnBus`
  after section01.ts:96. Give `BoardingService` the `reject` and `withdraw`
  acts the machine already defines, so that a batch holding a loan that cannot
  be cured can still cut over.
- **Kept out by.** No environment grades a transfer notice, the cutover or any
  clock the cutover arms.

### boarding-6. A tape's late charges are booked on the ledger with no fee row, so no statement, payment or payoff quote sees them, and a refinance's payoff collects them 🟡

- **Spec says.** §2.7's transfer-in edge case: "prior-servicer late charges
  boarded as `fees{state=assessed, source=transferor}` only with supporting
  history (1.6); disputed ones held under NoE rules"
  (2-7-late-charge-assessment.md:104). §1.6 books the same charge on the
  ledger at `loan.boarded`, "Dr `late_charges` receivable … / Cr clearing"
  (1-6-escrow-suspense-upb-reconciliation.md:84), and 1.6-T10 sizes it (:129).
  2.7's note (c): the fee ledger is "the `fees` table plus `late_charges`
  ledger account" (2-7 :34). §2.1 rule 5: "if a late charge/NSF fee is
  outstanding and no instruction → apply to `late_charges`", and otherwise the
  remainder stays in suspense
  (2-1-accept-post-periodic-payment-p-i-escrow.md:120). §2.7 rule 4: late
  charges are "included in payoff (16.1)" (:79). Rule 9: the engine's
  `late_charges_due_cents` is what the reminder shows (:84); the runtime puts
  the same figure in the statement's amount due (runtime/servicing.ts:105).
  §16.1 rule 6 and Reg Z 1026.36(c)(3): the payoff statement includes unpaid
  late charges, accurately. Reg X 1024.35(b)(5): a fee the servicer lacks a
  reasonable basis to impose is an error. Reg X 1024.33(c) is not at stake. It
  protects a payment the transferor receives in the 60 days after the
  transfer, and this charge was assessed before the transfer.
- **Engine does.** Both boarding writers call `BoardingService.board`
  (runtime/transfers.ts:128; app/tools/section01.ts:96). It books the tape's
  `late_charges_due_cents` in the opening set, Dr loan `late_charges` / Cr
  `transfer_in_clearing` (domain/boarding/service.ts:356, :390). It never
  writes the fee row:
  - `insertBoardingRows` writes no `fees` record
    (runtime/transfers.ts:172-206), and neither does the 35.5 boarding hook
    (:146-150).
  - `loan.boarded` carries no late-charge amount (service.ts:357-366).
  - No rule checks the charge against the payment history. HF-015 checks the
    note's terms (domain/boarding/rules.ts:144-145), and W-015 covers
    `fees_advances` only (:189).

  The cash state is rebuilt from the fee rows, not the ledger:
  `late_charges_due_cents` is Σ over `assessed` `fees` records
  (domain/operations-runtime/cashiering-cycle.ts:144-145, :153), though the
  ledger's balances are read beside it (:108). So the readers split:
  - The fee rows feed a payment's remainder
    (domain/cashiering/allocation.ts:195; otherwise suspense at :202), the
    35.8 payoff quote (domain/operations-runtime/derivers-35-8.ts:117) and the
    periodic statement (runtime/servicing.ts:105, :120). None of the three
    sees the charge.
  - 2.7's waive-all sweep also iterates `state.fees`
    (domain/cashiering/ops.ts:384-387). It serves trial conversion, workout
    completion, SCRA and D2-3.2-04's deferral completion (its docstring,
    domain/cashiering/ops.ts:380; the deferral caller,
    domain/cashiering/ops-2-7.ts:204-206). So no waiver the Guide requires can
    reach the charge, and `fees.waive` has no fee id to name.
  - The ledger feeds 35.10's quote
    (domain/operations-runtime/closeout-35-10/derive.ts:62;
    app/tools/section35-10.ts:236), its payoff (:408) and the console's loan
    page (console/pg-store.ts:59). All three carry the charge.

  So the borrower is never billed the charge, and no payment pays it. A
  refinance's payoff then collects it, after the borrower's own payoff quote
  said nothing was owed. A charge the history does not support boards the same
  way.

- **Reproduction.** A scratch database (`run.mjs db-setup`, 177 migrations).
  Copies of L-1 were boarded through the transfer path on 2026-08-20, with the
  daily unit run every day. The P&I and T&I custodial accounts were inserted
  by hand (boarding-4). For the statements, a borrower party was linked by
  hand (boarding-2) and the statement was sent by direct call (statements-1).
  - **The loans.** A's tape carries `late_charges_due` 7,901c, and its history
    shows the 2026-05-01 installment received 05-21, past grace. U carries the
    same charge, with every payment received three days after its due date. K
    is A again, boarded through `1.1 boardLoan{batch, files}` on the bus.
    Control B has no boarded charge, and the unit assesses 7,901c itself on
    09-17. C has no charge.
  - **What boarding wrote (A, U and K alike).** The opening set holds Dr
    `late_charges` 7,901c (`1.6:opening:late_charges_receivable`). There is no
    fee row, typed or entity. `loan.boarded` has no late-charge field, and U
    raised no warning or failed validation. The derived state reads 0c due,
    and the console page lists `late_charges` 7,901c.
  - **A payment.** 227,158c on 09-02, the installment plus the charge with no
    instruction, went `installments.applied:1 → remainder.suspense:7901`.
    Nothing went to late charges, and the ledger then held `late_charges` Dr
    7,901c and suspense Cr 7,901c. B's identical payment on 09-25 went
    `remainder.late_charges:7901`.
  - **Quotes on 09-28, good through 10-15.** For A, U and K, the 35.8 quote
    was 25,154,664c with 0c late charges, the same as C's. 35.10's record
    facts carried 7,901c, and 16.1 on them gave 25,162,565c.
  - **The 10-01 statement, dated 09-28.** A boarded-charge loan that paid the
    09-01 installment exactly was asked 219,257c, with 0c late charges due and
    7,901c Dr on the ledger. One that paid nothing showed 7,901c due, the
    unit's own 09-17 charge, while the ledger held 15,802c.
  - **2.7's `deferralCompleted` (D2-3.2-04).** Run in memory on the first
    loan's derived state, it waived nothing.
  - **End to end through 35.10.** Two copies of AZ-1 were boarded on
    2026-09-20, one with a supported 9,481c tape charge and one without. Each
    paid the 10-01 installment exactly (230,850c) on 10-02, and nothing was
    assessed. On 10-20 the two loans read alike. Both had 0 fee rows, a 35.8
    quote of 28,260,673c with 0c late charges, and an 11-01 statement of
    230,850c with 0c late charges. Only the first loan's ledger held 9,481c.
    Both were then refinanced by this platform as 35.10-T1/T2 set it up,
    consummating 11-09, and only `Runtime.sweep` quoted and settled them. The
    boarded loan's quote carried 9,481c in late charges, 28,282,137c against
    the control's 28,272,656c. Its settlement on 11-13 recorded
    `fees_collected {late_charges: 9481}` and paid the loan off. No fee row,
    `fee.*` event or A2-3-04 timer exists for the charge.
  - **Control.** The row was then written by hand through 2.7 `fees.assess`'s
    record path (app/tools/section02.ts:232) as
    `{state: assessed, source: transferor}`. The derived state read 7,901c,
    and the same 227,158c payment sent 7,901c to `late_charges`, leaving the
    ledger at 0c. The missing row is the whole defect, and nothing prompts an
    agent to write it: no event, warning or task names the charge.

  Two independent checks reproduced it on the servicing app's own demo
  transfer batch, with a lockbox check and the hosted daily run; 18 boarded
  loans carried 415,825c of `late_charges` receivable with no fee row. Once
  fixed, a boarded charge is exposed to cashiering-19 too: in one check's
  control, the hand-written row stayed `assessed` after a payment paid it, and
  the next statement billed it again. Found and reproduced on 22 October 2026.

- **Smallest fix.**
  - In `BoardingService.board`, beside the opening set (service.ts:356), when
    `late_charges_due_cents > 0`, write a `fees` record
    `{fee_type: late_charge, state: assessed, source: transferor, amount_cents, collected_cents: 0, installment_due_date: the history's late installment or null, assessed_on: transfer_date}`.
  - Persist it with the batch on both paths (transfers.ts:151-152;
    section01.ts:108-115), so the 2.x projector writes the typed row, and put
    the amount on `loan.boarded`.
  - Add a boarding rule, a money-field warning, for a charge the history does
    not support (no installment received after its grace), as "only with
    supporting history" asks.
  - Neither cashiering-19's fix nor payoff-19's reaches this, since both take
    late charges from the fee rows.
- **Kept out by.** No environment boards a transfer tape or runs the 35.5
  cycle. payments-posting carries `late_charges_due_cents` in its own state
  (packages/environments/src/payments/reference.ts:71, :272). Not
  cashiering-20: there a waived charge's ledger line is stale and its row is
  right. Here the ledger is right and the row was never written.

### ei-3. A written notice does not cover the next windows, so each later 45-day clock arms and breaches 🟡

- **Spec says.** §11.2 rule 4: "Windows inside an active cycle are
  `satisfied_by_prior_180` at creation (a second missed payment on Dec 1, 2026
  needs no notice by Jan 15, 2027 because the Dec 14 notice covers it)"
  (11-2-written-early-intervention-notice.md:98). The timer table counts
  `satisfied_by_prior_180` "when an active cycle exists" as meeting
  REGX_1024_39B_WRITTEN_NOTICE_45 (:78). 11.2-T3: given a notice provided
  2026-12-14 and Dec 1 unpaid, window(Dec 1).notice is
  `satisfied_by_prior_180` citing the cycle (:146). Reg X 1024.39(b)(1): a
  servicer "is not required to provide the written notice … more than once
  during any 180-day period" (:30). The registry's trigger skips such a leg,
  so it never arms (domain/early-intervention/timers.ts:47, :66).
- **Engine does.** `openWindow` marks the leg `satisfied_by_prior_180` only
  when it is handed the loan's active cycle
  (domain/early-intervention/windows.ts:74), and `counterRun` passes one
  through (domain/early-intervention/ops.ts:60, :76). The hosted counter's
  body, `delinquencyCounterJob`, has no cycle in its input and calls
  `counterRun` without one (domain/early-intervention/ops-11-1.ts:302-306,
  :315). The runtime's per-loan body reads only the event log and calls it
  that way (runtime/delinquency.ts:114-126, :125). Nothing on the counter's
  path reads the `ei_notice_cycles` entity-store row that 11.2's
  `print.request` writes (app/tools/section11.ts:163); only `notice.render`'s
  bankruptcy once-per-case guard reads it (:131), and the SQL table of that
  name stays empty.
  - Every window opened after a notice is `open` and arms its own
    REGX_1024_39B_WRITTEN_NOTICE_45.
  - That clock breaches into a sev-1 `officer` escalation, because the code
    has no breach-action row (`escalated_only`,
    domain/operations-runtime/default-35-9/sweep.ts:49-52).
  - The clock is satisfied only by a `notice.sent`, so it pushes the
    collections agent to mail a notice every month inside the cycle. Reg X
    allows that, but 11.2-T3 says no notice is owed.
  - 11.2-T3 passes because its test hands `counterRun` the cycle
    (domain/early-intervention/11-2.spec.test.ts:61-70).
  - A neighbor, not filed here and inside ei-2's reach: `projectWindows` never
    records a notice leg as `sent`. The 10-01 window below still read `open`
    after its clock was satisfied.
- **Reproduction.** A scratch database cloned from the migrated template (all
  177 migrations). Two copies of 35.5's AZ tape (owner-occupied,
  America/Phoenix, next due 2026-10-01) boarded through the transfer path on
  2026-09-25.
  - Each borrower was linked to a party by hand, to separate boarding-2. No
    payment was made, so no custodial account was needed (boarding-4).
  - The hosted sweep ran daily to 12-20 as main.ts runs it: flows tick,
    `Runtime.sweep`, settle, with fake ports. All 86 sweeps completed, and
    `default_case_daily` ran 80 units on each loan.
  - On 10-30 (day 29), loan B's collections agent called 11.2's own
    `notice.render` (the checklist passed; a continuity team was
    auto-assigned) and then `print.request`. Result:
    `notice.sent{NTC_REGX_39B_EARLY_INTERVENTION}`; the 10-01 window's clock
    `satisfied`; REGX_1024_39B_NOTICE_180_REPEAT armed for 2027-04-28; an
    `ei_notice_cycles` row with `cycle_end_at` 2027-04-28.
  - On 11-02 the counter opened B's 11-01 window with notice_status `open` and
    armed REGX_1024_39B_WRITTEN_NOTICE_45 due 12-16. On 12-02 it did the same
    for 12-01 (due 2027-01-15). Both deadlines fall inside the cycle.
  - On 12-17 the 11-01 clock breached and opened a sev-1 `officer` escalation,
    the same escalation loan A got for the notice it was never sent.
  - Control: the same inputs through `delinquencyCounterJob` give
    `notice_status: open`, while `counterRun` with the cycle gives
    `satisfied_by_prior_180` (`covering_cycle_id: cycle-B`).
  - Found on 22 October 2026 while reproducing a lead about the written notice
    and reproduced the same day. That lead did not hold: the written notice is
    the agent's work by design, and its tool works. Two independent checks
    reproduced this one, one on the NY tape with the notice sent on day 40.
- **Smallest fix.** In `delinquencyLoanBody`, read the loan's active
  `ei_notice_cycles` row from the store. Add `active_cycle` to
  `CounterJobInput` and pass it to `counterRun` at ops-11-1.ts:315;
  windows.ts:74 already applies the `cycle_end_at >= notice_due_at` test.
  `projectWindows` already keeps the event's `satisfied_by_prior_180`
  (delinquency.ts:69, :79).
- **Kept out by.** No environment grades early intervention.

### transfers-1. The goodbye notice's address check reads parties no code writes, so no goodbye run is ever released 🟡

- **Spec says.** Reg X 1024.33(b)(3)(i): the transferor gives the borrower the
  notice of transfer "not less than 15 days before the effective date", and
  comment 33(b)(3)-1 mails it to the address in the loan documents unless the
  borrower gave a new one (17-2-respa-goodbye-notice.md:28). 17.2's recipients
  are "each borrower at their own address of record; confirmed successors in
  interest; ACP substitute addresses", plus counsel for a borrower in
  bankruptcy (:92), from an address file kept "from the system of record"
  (:44). The goodbye run is 1.3's (:67). 1.3 sends to "each borrower on
  `loan_borrowers` at their own address"
  (1-3-respa-transfer-notices-goodbye-hello.md:85) and moves the run to
  `qc_passed` on "checklist and address validation" (:64). 17.2's release
  needs a `qc_passed` run, the verified transferee block,
  `SM_TOLLFREE_LIVE_GATE`, the frozen list and the officer
  (17-2-respa-goodbye-notice.md:67). A miss breaches
  `REGX_1024_33B3_GOODBYE_15`, sev 1 to `officer`, and the transfer date slips
  a month (:72). The spec names no `loan_parties` store.
- **Engine does.** 17.2's `validateAddress` reads the parties of record from
  the entity store's `loan_parties` documents (app/tools/section17-2.ts:109)
  and throws "no parties of record" when there are none (:110). Nothing in
  src/ writes that kind. Its only writer is the 17.2 spec test, by hand
  (domain/transfers/17-2.spec.test.ts:154).
  - The borrower of record is where every other servicing notice finds it:
    `borrowers.party_id` through `loan_borrowers`, or
    `application_borrowers.party_id` (runtime/servicing-parties.ts:16-22).
    4.4's confirmed successors go to the typed `loan_parties` table
    (app/tools/section04.ts:577), which this check does not read either.
  - Parties on the input are refused (`ADDRESS_OF_RECORD_ONLY`,
    section17-2.ts:115), so the agent cannot supply them. The check never
    reads the notice's own recipients, which `renderNotice` takes from the
    caller (app/tools.ts:210).
  - The release refuses a notice without `address_valid`, and refuses the run
    until a checked, address-validated notice covers every loan on the frozen
    list (domain/transfers/ops-17-2.ts:142-145). So no goodbye run can be
    released on any loan, with a party or without one. That an originated loan
    fares the same is read from the code, not run.

  The same release is closed three more ways, each seen in the reproduction:
  - Nothing moves a run past `planned`. `planNoticeRun` writes `planned`
    (section17-2.ts:81), no code writes `rendered` or `qc_passed`, and the
    release requires `qc_passed` (ops-17-2.ts:137). The spec test sets it by
    hand (domain/transfers/17-2.spec.test.ts:148).
  - `contact_center.ready` is emitted only by `contactCenterReady`
    (ops-17-2.ts:152-156), which no tool calls, so `SM_TOLLFREE_LIVE_GATE`
    stays closed (section17-2.ts:47-48).
  - The frozen list holds 10-digit Fannie Mae numbers
    (domain/transfers/ops-17-1.ts:512). The release counts coverage by the
    notice's loan id, a `loans.id` uuid (section17-2.ts:101; ops-17-2.ts:142).

  Two more from the same run. A refused release opens an escalation naming the
  batch (section17-2.ts:137). `escalations.batch_id` references
  `transfer_batches` (db/migrations/0019_transfers.sql:59), and 17.1 keeps a
  transfer-out batch in the entity store only (app/tools/section17-1.ts:58).
  So the refusal fails on that foreign key and rolls back, and its escalation
  is never written. A release that passed would write its row and an event,
  and hand nothing to print-mail (section17-2.ts:136).

  The notice can still be mailed, but only around 17.2's checks. 1.3's
  `releaseToVendor`, the same agent's tool, takes the checklist, the
  authorization and the toll-free facts from the caller and submits the print
  job it is handed (app/tools/section01.ts:199-203). 17.2's
  `ingestMailReturns{op: proofs}` under a run id with no stored row takes its
  loans from the input (section17-2.ts:149-152) and satisfies the clock. Under
  the stored run the proofs must name the frozen list's Fannie Mae number, and
  its `notice.mailed` then fails on `loan_events`' uuid column
  (domain/transfers/inbound.ts:277).

- **Reproduction.** A scratch database with the app's 177 migrations, and the
  demo batch boarded through `boardTransferBatch`. SM-TR-0000002 (Maria Reyes,
  Fannie Mae 4100000014) had her borrower row linked to a party through the
  app's own `PgBorrowerPartyRepository`, as boarding-2's fix would do.
  `servicingParties` then returned her, at the property address, 4996 Sunset
  Blvd, Phoenix, AZ 85004.
  - **17.1.** On the bus, as the transfer agent and an officer: a `sub_to_sub`
    transfer out for 2026-12-01 was proposed, its plan approved, its list
    submitted, and the batch packaged, submitted, approved and attested. It
    reached `loan_list_frozen`, and `REGX_1024_33B3_GOODBYE_15` armed, due
    2026-11-16.
  - **17.2.** `planNoticeRun` planned the goodbye run on the frozen list
    `[4100000014]`, and `verifyTransfereeBlock` passed. `renderNotice` with
    her as recipient rendered, and `runContentChecklist` found all nine
    required items. `validateAddress` threw "no parties of record" for the
    loan id and for the Fannie Mae number. With her party on the input, it was
    refused `ADDRESS_OF_RECORD_ONLY`. The officer's `releaseToVendor` failed
    on `escalations_batch_id_fkey`.
  - **Controls, by hand.** With a typed `transfer_batches` row inserted for
    the batch, the release returned its refusals: the run is `planned`,
    "address not validated", `SM_TOLLFREE_LIVE_GATE` closed, and no covered
    notice for 4100000014. With a `loan_parties` entity record for her written
    through `PgEntityRepository.save`, `validateAddress` passed
    (`own_address`). The release still refused on the other three.
  - **Deadline.** A sweep on 2026-11-17 breached `REGX_1024_33B3_GOODBYE_15`
    and opened a sev 1 `officer` escalation. The notice stayed `rendered`,
    never sent or mailed.
  - **Around 17.2.** A second database was walked the same way. There, 1.3's
    `releaseToVendor` with the facts asserted submitted her print job to the
    fake vendor on 2026-11-13. Proofs under the stored run failed with 22P02
    on "4100000014". Proofs under an unstored run id, naming her loan id,
    satisfied the clock, while the stored run stayed `planned`.
  - Apart from the record the control wrote, no servicing database on this
    machine holds an entity of kind `loan_parties`, the 397-day simulation's
    43,277 entity rows among them.

  Two independent checks reproduced it over the app's own HTTP server on a
  seeded database, one with typed `loan_parties` rows as well; the typed table
  is never read. One also found that a release run with no loan sees none of
  the loan-scoped notices (infra/db/entities.ts:66-67;
  domain/operations-runtime/seam/hydration.ts:39-48), and that a proofs ingest
  writes the run `released_to_vendor` with no release made
  (section17-2.ts:160). Found and reproduced on 22 October 2026. No custodial
  accounts were needed, since no payment was posted.

- **Smallest fix.** In `validateAddress`, read the parties of record from the
  typed rows: `servicingParties` for the borrowers, and the typed
  `loan_parties` rows for confirmed successors. Check the notice's own
  recipients against them. That alone releases nothing. The release also needs
  a run that reaches `qc_passed` once every frozen-list loan has a checked,
  validated notice; coverage counted by the loan's `fnma_loan_number`; an act
  that records `contact_center.ready`; a typed `transfer_batches` row from
  17.1, or an escalation that does not name a batch with no row; and a
  hand-off to print-mail.
- **Kept out by.** No environment runs a transfer out, a goodbye run or 17.2's
  tools.

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
- **lossmit-2.** The 35.9 case fold consumes `workout_plan.active`,
  `.expired`, `.terminated`, `.completed`, `.failed` and
  `foreclosure_holds.set` (domain/operations-runtime/default-35-9.ts:77-78),
  the names 35.9's and 12.4's and 12.5's specs use, but 12.4's tool emits
  `workout_plan.activated`, `.ended{status}` and `.closed`, and a hold opens
  as `foreclosure_holds.opened` (app/tools/section12.ts:83, :89, :103, :192).
  So a loss-mitigation case's timeline, the record an examiner is shown, holds
  a plan's offer but never its activation or its end, and a hold's release
  without its opening. No gate reads the timeline; once 12.8 is wired, the
  claims sweep's workout milestone (:184) would also miss a Flex Mod.
  Reproduced on 22 October 2026 and upheld by two independent checks. Fix:
  consume what the sections emit, correct the specs' spellings, and test that
  every consumed type has a non-test emitter. Kept out: no environment runs
  35.9's fold.

97 defects were recorded and one was dropped: arm-9 (Fannie Mae's notice in
place of a suppressed Reg Z notice is never marked late) did not reproduce,
because the template holds every such notice inside 25 days of the change
date, so none is sent late; what it leaves is an adjustment that never takes
effect, the same failure as arm-3.
