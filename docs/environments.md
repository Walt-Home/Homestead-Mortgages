# Environments

An environment is a task, the tools a model may use, and a grader the model
never sees. `packages/environments` holds them. The first, `refi-review`
1.0.0, grades a model on the daily refinance review, using synthetic loans
only and with the engine itself as the grader. `escrow-analysis` is the
first on the servicing side, and `regz-price-tests` the first on the
origination side.

## refi-review

**The task.** One loan as the review sees it (the engine's row, after the
tape is read), the review date, today's quoted 30-year rate (or none), the
loan's offer history and the tape's exceptions. The system prompt is the
rulebook (`src/refi/rulebook.ts`): `reviewLoan` written out step by step, in
the engine's order, with every rounding where the engine makes it.

**The tools.** Primitives only: `level_payment`, `balance_after`, `per_diem`,
`present_value`, `date_add`, `days_between`, `end_of_month`,
`whole_months_between`, and `calculate` (exact decimal arithmetic, no
`eval`). The money tools are the engine's own exported primitives. No tool
takes a loan or returns a verdict. The answer goes in through
`submit_review`; a malformed submission comes back as an error and can be
resubmitted.

**The grader.** `reviewLoan` on the task's inputs, run at grading time. It
checks:

- the verdict;
- the reasons, as a set of the rulebook's codes;
- for a candidate, all 13 disclosure figures, to the cent;
- for a watched loan, the watch rate.

A pass means every field is right. The score is the share of fields right;
it is recorded next to the pass and never replaces it.

**Splits.**

- `train`: any seed.
- `heldout`: seed 1, 200 tasks. Every reported score is measured on this
  suite, and it never appears in a prompt, a few-shot example or a training
  run.
- `spec`: the servicing spec's own cases (worked example 1, the
  Massachusetts rule, cooldown, cap, watching, no quote, stale value,
  exclusions).

Each task is drawn from its own seeded stream keyed by its id, so any task
can be rebuilt from its split, seed and index alone.

**Runs.** Each episode is one line appended to a JSONL file and never
rewritten. A line records:

- the task's coordinates and rendered text;
- the environment version, plus hashes of the rulebook and the tools;
- the engine's rule-set and port versions;
- the policy;
- the whole transcript, the answer, every graded field, and the token usage
  (uncached, cache read, cache write, output).

Runs land in `packages/environments/runs/`, which git ignores. Once a run
has finished, `npm run env:archive -w @hm/environments` copies it to
`gs://homestead-mortgages-eval-runs` (`infra/evals.tf`).

- The bucket keeps every object for a year and replaces none, so the archive
  is as append-only as the files.
- A file written to in the last 15 minutes is left for the next archive,
  because once uploaded it could not be finished.

## refi-tape

refi-tape is option A of the plan's harder versions (1.1.0 since 20 October,
when a PMI rate of three digits became readable): the same review,
starting from what the daily review is actually handed.

**The task.** It is our loan record and the servicer's newest tape
observation, the tape's own fields in `facts`, instead of the cleaned row.

**Step 0** of its rulebook is `universeLoanOf` written out. It reads every
field the review needs from the record and the tape:

- dates that may be in the record, the facts, or nowhere;
- delinquency counted to the tape's own date, or said late by a pay string
  or status;
- the newer of two valuations;
- a PMI rate as a percent or in basis points;
- bankruptcy from filing, discharge and dismissal dates.

Then comes refi-review's rulebook unchanged. A tape the reader cannot
describe takes a fifth verdict, `not_reviewable`, with the reader's reason.

**The tasks.** The generator starts from the loan refi-review would draw
under the same coordinates and writes it out the way a book arrives. The
held-out suite is again seed 1 with 200 tasks, in its own namespace.

**The proof of fairness.** The grader is the tape reader and then the review.
The reference policy reads Step 0 and passes all 701 tasks it was checked
on.

## refi-hard

refi-hard (1.1.0, with refi-tape's) is option D: refi-tape's rulebook, tools and grader, over
tasks placed on the rules' edges. Only the generator differs, so a score
beside refi-tape's measures what the edges cost. `refi-hard-policy` puts
refi-policy's wording over the same tasks.

**Why.** Both models score near 100 % on refi-review and refi-tape, and
every miss they made landed where one slip changes the answer: PMI
arithmetic, a percent, a rounding step. A book's loans rarely sit there.

**The ten edges.** Each task sits on one, on one side of it:

| Edge               | One side                                                                                 | The other                 |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------- |
| `rate_floor`       | a 25 bps reduction                                                                       | 12.5 bps                  |
| `cash_cap`         | cash back on the rounded amount up to $5 under its cap                                   | up to $5 over             |
| `ltv_limit`        | exactly at 9700, 9000 (second home, or a low-confidence value), 7500 or the 8000 MI line | one over                  |
| `value_confidence` | LTV over 9000, value dated 12 months back to the day                                     | a day earlier             |
| `value_stale`      | value dated 24 months back to the day                                                    | a day earlier             |
| `ma_window`        | Massachusetts, consummated 60 months before the candidate to the day                     | a day later               |
| `gates`            | declined 90 days ago, or first offer 12 months ago to the day                            | 89 days, or a day inside  |
| `month_end`        | disbursement on the last day of a month (29 February among them)                         | the first day             |
| `paid_ahead`       | next due date after disbursement                                                         | before it                 |
| `pmi_unit`         | PMI rate 5 or just under: a percent                                                      | just over 5: basis points |

**The tasks.** The edge is the index modulo ten and the side alternates, so
any ten tasks hold every edge and any twenty hold each on both sides. Each
starts as a refi-tape draw made clean (active, current, unsuppressed, a
recent value, a quote a point under the note rate) so the edge decides. It
is kept only if it does: its answer must differ from the answer on the
other side, and an edge that moves figures rather than the verdict must be
a candidate. Otherwise it is redrawn under the next key. The held-out suite
is seed 1, 200 tasks, pinned by hash.

**The proof of fairness.** The reference passes all 520 tasks it was
checked on. A test re-reads every one of 1,200 tasks off its tape, apart
from the generator, and confirms it sits where its edge says.

## escrow-analysis

escrow-analysis 1.0.0 is the servicing side's first environment: one
escrowed loan's annual escrow analysis under RESPA (Regulation X §1024.17),
the servicing app's spec §3.2.

**The task.** It gives the account as the analyst has it on the run date:

- the escrow lines (county taxes in two installments, a school or city tax,
  hazard, sometimes flood, sometimes borrower-paid MI), each with the bills
  the payee has issued or last year's figures;
- the ledger balance and the postings still scheduled before the new year;
- the cushion the policy, the instrument and the state allow;
- the delinquency, any workout, and today's escrow payment.

The model projects the year, finds the low point, sets the cushion,
compares the target with the balance the account will start with, decides
(balanced, refund, credit, retain or shortage), and sets the new payment and
its effective date. 24 fields are graded, to the cent and the day.

**The grader is the servicing app's own engine.**
`src/escrow/ported/analysis.ts` is `apps/servicing/src/domain/escrow/analysis.ts`
byte for byte but for its three imports, and a test fails on any other
difference. A re-vendor of the servicing app that changes the engine fails
that test until the port is copied again (see `PORTED_FROM` there).

**The tasks.** Each account is aimed at an edge of the decision: a surplus of
exactly $50 or a cent under, a shortage of exactly one month's payment or a
cent under, 30 or 31 days late, a deficiency, a workout. The rules' own traps
come with it:

- a discount date that moves a disbursement;
- CPI that applies to taxes and not insurance;
- an MI line that ends mid-year, or has no termination date;
- a stale prior-year estimate;
- ledger postings outside the window;
- a statement sent too late for the first month.

The held-out suite is seed 1, 200 tasks, pinned by hash.

**The proof of fairness.** The reference passes all 504 tasks it was checked
on, the spec's worked example and its three variants among them, to the
cent.

## regz-price-tests

regz-price-tests 1.0.0 is the origination side's first environment:
Regulation Z's price tests on one quoted loan, as the shadow AUS runs them
before a decision. These are the General QM price and points-and-fees tests
(§1026.43), the higher-priced mortgage test (§1026.35), the HOEPA triggers
(§1026.32), and a refinance's net tangible benefit.

**The task.** It gives the quote as the file holds it:

- the loan and product;
- the property and its occupancy;
- the lender's itemized fees, each with who is paid;
- the instant the rate was set, in UTC;
- whether ability to repay was documented;
- on a refinance, the loan being paid off.

The model prices the fees and derives the total loan amount, the APR and the
APOR. It then decides each test, and says null where the engine cannot
decide. 16 fields are graded.

**The grader is `@hm/underwriting`.** It is `runComplianceTests` itself, fed
the way `resolveMarketInputs` feeds it. The one difference from production
is the fee schedule: each task carries its own lender's fees, and a line's
two flags follow from who is paid, the way the production schedule classifies
its own lines. The tools are the engine's own functions: the Appendix J
solve, the APOR lookup, and the New York calendar date.

**The three answers.** Each test is yes, no, or cannot decide:

- an APR is refused above 80% of value and for an adjustable rate;
- HPML and HOEPA do not reach a second home or an investment property;
- a prepayment penalty whose terms are not on file leaves HOEPA undecided.

**The tasks.** Each quote is aimed at an edge:

- a loan amount a dollar either side of a tier bound or the jumbo line;
- a loan at exactly 80% of value;
- a note rate searched so the spread lands within a tenth of a point of the
  HPML line, the QM threshold or the HOEPA trigger;
- a rate set late on a Sunday in New York, which is the week before;
- small loans whose flat fees trip the points-and-fees tests.

**Fair to grade by construction.** The engine computes in binary floating
point; the rulebook and tools compute in exact decimals. The generator keeps
a quote only once the reference, solving through the tools, matches the
engine on every field. Under 1.0.0 about 1.5% of first draws failed that,
every one a percentage fee on an exact half cent that the engine rounded
down. The engine has priced fees in exact cents since 21 October, and 1.1.0
redraws none in 1,000. The held-out suite is seed 1, 200 tasks, pinned by
hash.

**The proof of fairness.** The reference passes all 501 tasks it was checked
on. Hand-worked quotes at each edge are held to figures worked by hand,
apart from the engine.

## flexmod-terms

flexmod-terms 1.1.0 is the second servicing environment: one delinquent
Fannie Mae loan evaluated for a Flex Modification (Servicing Guide F-1-27
and D2-3.2-06), the servicing app's spec §12.8.

**The task.** It gives what the loss-mitigation analyst has on the
evaluation date:

- the loan's balances, arrears and advances, and any earlier forbearance or
  buydown;
- its rate, whether it is an ARM not on its final rate, and its remaining
  term;
- the property's value and the pre-modification payment;
- the Modification Interest Rate table;
- the loan's prior modifications and failed trials;
- what the trial notice will carry.

The model decides whether the loan is denied before the waterfall. It then
runs the waterfall's five steps (gross up, rate, rate reduction to the MIR,
term extension to 480, principal forbearance with its three caps) and
decides eligibility. For an offer it sets the trial plan and the
modification's dates. 22 fields are graded.

**The grader is the servicing app's own waterfall.**
`src/flexmod/ported/flexmod.ts` is `apps/servicing/src/domain/lossmit/flexmod.ts`
byte for byte but for the paths of its four imports, held by a test as
escrow's is. The service conventions around it live in the servicing app's
stateful FlexModService, which does not port, so they are restated in the
grader with the lines they come from:

- the prechecks, in order: a failed trial within 365 days, then three prior
  modifications;
- the rate-table lookup;
- exhaustion, which is null on a denial. That null is the environment's own
  convention: the service's record keeps the false it starts with;
- the 60-month shortage spread, half up, which is the borrower's default
  election;
- the capitalization and maturity dates.

A test holds the prechecks, the lookup and the spread to the service's own
lines, so a re-vendor that changes one fails until the grader and the
rulebook are looked at again.

**The tools.** refi's level payment, date steps and calculator, plus one
new tool: the principal a payment supports, floored to the cent. That is the
closed form step 5 starts from, computed as the engine computes it.

**The tasks** are aimed at the waterfall's edges:

- MTMLTV printing 50.00 or 50.01, where step 3 starts and step 5 needs
  more;
- rates on, above or off the eighth-point grid;
- an ARM below the MIR;
- targets reached by the rate, the term, forbearance, or nothing at all,
  including a rate that stops above the MIR;
- a P&I equal to the pre-modification payment after the waterfall is
  exhausted, where being 31 or more days delinquent decides eligibility;
- a pre-modification payment whose 80% is an exact cent;
- a rate-table row effective on the evaluation date;
- a failed trial 364 or 365 days back;
- a shortage whose 60-month spread ends in exactly half a cent;
- notices on the 15th, the 16th, and in December, never before the
  evaluation.

The engine and tools are exact decimal arithmetic. The generator keeps a draw
only when the reference lands where the engine does, so a suite it built
cannot by itself show the rulebook is fair. A test runs the reference over
2,000 unfiltered draws as well and allows no disagreement, and no draw in 600
needs redrawing. The spec's worked example ($251,405.31 gross, $35,483.32
forborne, $1,264.13 P&I) comes out to the cent, and unit cases settle the
rounding ties the rulebook specifies (an MTMLTV of exactly 50.005, a
forbearance cap and a payment reduction at exactly half) as the engine does.

**1.1.0** changed the generator, so the held-out suite moved. A notice is
never drawn before the evaluation. In 1.0.0 a December notice could fall
before a December evaluation or a year after an evaluation. Two aims are new:
a target the rate alone reaches above the MIR, and a P&I equal to the
pre-modification payment, drawn about half delinquent. Some escrow shortages
now spread into exactly half a cent. The grader spreads a shortage with the
service's own division, which gives the same cent on every shortage drawn.
The rulebook and the tools did not change.

## payments-posting

payments-posting 1.0.0 is the third servicing environment: one loan's
receipts posted over a window of four to six weeks, the way the servicing
app's cashiering posts them (its spec §2.1 receipt and allocation, §2.2
partials and the $50 rule, §2.4 curtailments, §2.7 late charges).

**The task.** It gives the loan's cash state when the window opens and the
receipts in the order they arrived:

- the balance, rate, last paid installment and the installments projected
  four months back and three ahead, each due, satisfied or prepaid;
- suspense, late charges due, and the late charges already recorded;
- the note's late-charge terms: percentage, grace days, cap, basis;
- any hold or trial, and any forbearance, bankruptcy, foreclosure referral
  or transfer shield in force;
- each receipt's amount, day, designation, amount of additional principal
  and written instruction.

The model runs each day's late-charge run, then that day's receipts through
the waterfall, and reports where every receipt went (installments with
their interest, principal and escrow, late charges, curtailment, suspense),
every late-charge decision, and where the loan stands at the end.

**The grade.** A pass is every field right. A receipt is three fields: its
outcome, the installments it applied, and where the rest went. A run is one
field, its outcome and amount together. The lists of receipts and of runs
are a field each, and a run reported that did not happen is a field of its
own, so hedging is never cheaper than committing. The final state is six
fields. An answer that posts nothing scores about 0.38 on the held-out
suite. That is the floor to read the mean field score against, which never
replaces the pass.

**The grader is the servicing app's own engine.** `src/payments/ported/`
holds `types.ts`, `allocation.ts` and `latecharges.ts` from
`apps/servicing/src/domain/cashiering/`, and `biweekly.ts` because
allocation imports its interest function. Each is byte for byte but for its
import lines, held by a test that rewrites the original's imports and
compares. The harness around them is the servicing app's daily convention,
restated in the grader with the line it comes from:

- each day's late-charge run comes before that day's receipts;
- it takes every installment whose grace end was the day before, in the
  loan's order and whatever its status;
- a charge it assesses is recorded at once;
- each receipt is allocated against the loan the one before it left.

**The tools.** refi's date steps and calculator, plus the servicer's
business-day calendar (`next_business_day`), which is what a grace end on a
weekend or holiday rolls forward on.

**The tasks** cycle by index through eleven edges, a hundred months each in
a suite of 1,100:

- a payment on the grace end, and on the day after it, when the run comes
  first;
- a payment short by $50.00 or less, by $50.01, and on each loan the $50
  rule does not reach (unescrowed, before March 1999, a second lien, three
  partials already, opted out);
- a partial completed by the next receipt, and suspense the late-charge test
  counts;
- arrears caught up at once, and once every installment due is paid, the
  rest to late charges;
- designated principal on a current loan (applied apart, the whole receipt
  curtailed) and on a delinquent one (redirected to the arrears);
- an amount of additional principal that never prepays a future
  installment;
- two or three installments prepaid in one receipt;
- an instruction to principal in words, a refused instruction to pay a
  second lien, and both at once;
- a bankruptcy hold with its charges suspended, a foreclosure referred past
  120 days delinquent, a dispute and a fraud hold;
- forbearance with and without a default (a full payment or none, never a
  partial), an active bankruptcy, a foreclosure referral, and the transfer
  shield over a payment sent to the old servicer and forwarded late (spec
  Example L);
- a PITI basis, a cap, a rate other than 5 % and a grace other than 15 days.

**What v1 leaves out, and why.** The engine has regions where it departs
from its spec or produces a figure no servicer would book. v1 does not grade
a model on those, because the grader would be teaching the defect. The
generator never draws:

- a payoff, fees other than late charges, or non-interest-bearing principal;
- a receipt credited on a different day from the one it arrived;
- a trial. The servicing app posts a trial loan's receipts through its trial
  path, which applies an installment once the amount held reaches a payment.
  The allocation alone never does.

`paymentsInScope` runs on the engine's own postings, and keeps a month only
when the engine does nothing in it that its spec calls wrong:

- the balance stays above zero, and the $50 rule never books negative escrow;
- late charges are paid only once every installment due is paid, and never
  out of suspense accumulated without an instruction;
- the $50 rule is never applied ahead of a due date, where the engine says
  prepaid and the spec says applied_with_50_rule;
- a payment during a forbearance plan is never held as a partial;
- no charge is assessed under a bankruptcy or foreclosure hold;
- the transfer shield spares only an installment the forwarded payment then
  satisfies;
- every receipt meets an open installment, and one is still open at the end,
  so no answer depends on where the projection stopped.

On 5,000 unfiltered training draws it rejects none, because the generator
aims around all of them. It is a guard, not a filter. Where the engine and
its spec disagree inside v1's scope, the rulebook states what the engine
does:

- the whole suspense balance counts toward each unpaid installment's
  late-charge test;
- designated principal on a current loan curtails the whole receipt.

Spec Example C (a $2,000.00 partial held, then the run) is the visible
case. The spec assesses $79.01. The engine does not, because $2,000.00 in
suspense is more than the P&I. A test holds the engine's answer, and
docs/decisions.md has the engine defects found on the way.

The reference passes the held-out suite, a 300-task training suite and
seven of the spec's worked examples (A, D, F, G, K with M, L, N) to the cent,
with no task redrawn, and agrees with the engine on 2,000 candidates nothing
filtered. Its longest month is 59 tool calls across 5,000 training draws.
That fits inside the episode's 80 turns even for a model that makes one call
a turn, once it computes each grace end once, as Step 1 now says to.

## arm-adjustment

arm-adjustment 1.0.0 is the fourth servicing environment: one adjustable-rate
loan on one change date, adjusted the way the servicing app's ARM engine
adjusts it (its spec §7.2, Regulation Z §1026.20(c)), with the §1026.20(d)
initial notice of its spec §7.3 on the loan's first change.

**The task.** It gives what the servicer has boarded and recorded on the day
the change is worked:

- the note's ARM terms: the index, margin and look-back, the first change
  date and the adjustment period, the initial, periodic and lifetime caps,
  the rounding rule, any interest-only period, the term, the first payment
  and the closing, and whether the (d) disclosure at closing was an estimate;
- the current rate and payment, and the schedule basis the last change left
  (the note itself on the first change);
- any FDCPA cease on file, and whether the servicer is a debt collector;
- the index as published: business-day prints from three or four weeks
  before the index date to two weeks after it;
- the date the notice would be sent.

It does not give the index date, the first new payment's due date, the
remaining term, the expected balance or any window. The model finds the
index, rounds to the eighth under the note's midpoint rule, applies the caps
and the floor in the engine's order and names the limit that bound, works the
scheduled balance at the old rate and the new payment, classes the (c)
notice's timing, says which notice goes and whether the proposed send date is
blocked, on time or late, and on the first change gives the (d) notice's duty
and window.

**The grade.** A pass is every field right. Twenty-two answers are graded as
eight fields, and a ninth on the first change: the index (its date, the print
and its value), the rounding (the unrounded rate, the eighth, the midpoint),
the rate (the new rate and the limit that bound it), the expected balance,
the schedule (the first new payment, the remaining term, the next change),
the payment, the notice's timing (its kind, opening and due date), the notice
(which one goes, and the send check), and the initial notice. A label that is
nearly always the same (no limit binds, no midpoint, the Reg Z notice on
time) is graded with the figure or the decision beside it, so an answer that
works nothing and guesses the commonest label everywhere scores about 0.10 on
the held-out suite. An initial notice reported on a later change is a field
of its own, so hedging is never cheaper than committing.

**The grader is the servicing app's own two engines.** `src/arm/ported/`
holds `arm.ts` (engine A, fixed-scale decimal) and `arm-verify.ts` (engine B,
BigInt fixed point) from `apps/servicing/src/domain/notices/`, each byte for
byte but for its import lines, held by a test that rewrites the original's
imports and compares. The grader runs both, and a test holds them equal on
every generated change: the spec's own dual-calculation gate. The conventions
around them live in the servicing app's stateful ARM service (`ops-7-2.ts`,
`ops.ts`), which does not port, so they are restated in the grader with the
lines they come from, and a test holds those lines to the service's source:

- the schedule row: the first new payment's due date, the notice kind, the
  index date, the window's opening and the notice's due date;
- the expected balance, counted from the schedule basis through the payment
  due on the change date, or the basis itself while interest only; and the
  remaining term with both ends counted;
- the interest-only payment while the first new payment falls inside the
  interest-only period;
- which notice goes, and how its send date is checked;
- the next change date.

**The tools.** refi's level payment, scheduled balance, date steps, month
count and calculator, and nothing new: no index lookup (the model reads the
series), no eighth, no cap test and no window. Those are the task.

**The tasks** cycle by index through twelve edges, two hundred changes each in
a suite of 2,400:

- a Fannie Mae SOFR plan (4926 to 4929) or a legacy note, nothing aimed;
- index + margin exactly halfway between two eighths, and one
  hundred-thousandth either side, under both rounding rules;
- the first change above and below its cap, exactly on it, and a midpoint that
  lands on the cap rounding down and passes it rounding up;
- the same on a later change, with the periodic cap;
- a later change near the lifetime ceiling, exactly on it, and the tie where
  prior + cap is the ceiling (the cap is named, not lifetime), which a 7/6 or
  10/6 plan's 5 % initial cap also makes on the first change;
- an off-grid margin (2.800) whose eighth falls below it, so the floor binds
  off the grid, and an on-grid margin an index of 0 lands on exactly;
- no print on the index date (a weekend, a holiday or a missing print), with
  a print after it that would round otherwise;
- interest only through the change, ending with it, and ended at an earlier
  change;
- the 25-day loans: closed before 2015-01-10 with a look-back under 45 days,
  closed on 2015-01-09 and on 2015-01-10, and monthly adjusters;
- the first change's (d) duty: the servicer's, the originator's at 209, 210
  and 211 days from closing, and exempt on a one-year term; and the (c)
  exemptions beside it, the first change without an estimate within 210 days
  and the 25-day first change within 60 days of closing after an estimate;
- a send the day before the window opens, on the index date, on the deadline,
  the day after it, and a month late;
- an index that rounds back to the current rate, where the scheduled balance
  re-amortized moves the payment a cent (Fannie Mae's notice, late after
  change − 25) or does not (no notice); and an FDCPA cease on file with a debt
  collector and without one.

**What v1 leaves out, and why.** The engine has places where it departs from
its spec or books a figure no servicer would (docs/decisions.md lists them).
v1 does not grade a model on those, because the grader would be teaching the
defect. The generator never draws:

- error correction, the LAR 83 report and its pass-through rate, or the
  late-notice deferral of the payment change;
- the (d) notice's estimate and its index-freshness hold; its status and
  window are graded, its figures are not;
- a two-month adjuster, a due day other than the 1st, or a rate written with
  other than three decimals;
- payment-cap plans, buydowns, conversions, Chapter 13 filings, and index
  revisions or fallback captures, which are stateful or policy rather than
  arithmetic.

`armInScope` runs on the engine's own results, and keeps a change only where
the engine does nothing its spec calls wrong:

- every rate has three decimals, as the service compares the new rate with
  the current one as text;
- every index print has five decimals and none is negative, where the two
  engines round differently;
- every schedule date falls on the 1st, and the change is on the schedule;
- no two-month adjuster, which the service classes as adjusting every 60 days
  or more often;
- an interest-only period ends with a change, as the engine never recasts a
  payment between changes;
- both engines agree, and the balance and term left are positive;
- no notice is proposed before the index date unless it is a Reg Z notice
  before its window opens. The engine's send check passes a Reg Z notice sent
  after the window opens and before the index date, and the spec's sendable
  window starts at the index date;
- Fannie Mae's notice in place of a suppressed Reg Z notice (an FDCPA cease,
  or an exempt first change) is never proposed after change − 25. The engine
  never marks that one late, and the spec's 25 days apply to it.

On 8,000 unfiltered training draws it rejects none, because the generator aims
around all of them. It is a guard, not a filter.

The reference passes the held-out suite, a 300-task training suite and ten of
the spec's cases to the cent: §7.2's worked example and its cap variant, a
missing print (T1), the midpoint both ways (T2), a send a day late and one
before the window opens (T5), the second change, the monthly legacy loan's
25-day deadline (T6) and an FDCPA cease (T11), with §7.3's window on the same
loan. No task is redrawn, and it agrees with the engine on 2,000 candidates
nothing filtered. Its longest change is 26 tool calls in 7 turns. §7.3's
estimate (6.375 % and $2,476.44 on the April print) is held by a test through
the ported engine, as v1 does not grade it.

## escrow-history

escrow-history 1.0.0 is escrow-analysis started from the account's ledger.
An analyst does not get each line's prior-year total and dates, or the
balance on the run date: they get the ledger. Here the task gives:

- the balance the account was opened at, thirteen months before the new year;
- every deposit and disbursement posted since, each disbursement tagged with
  the line it paid;
- what is still scheduled after the run date.

The rulebook is escrow-analysis's with a Step 0 in front, which reads last
year's figures and the run-date balance off the ledger. A test holds the
rest unchanged.

**The traps.**

- A line's payment from the year before last, which falls outside the
  twelve-month window.
- Last year's payments still to come, scheduled after the run date.
- One-off disbursements tagged with no line.
- Postings that belong to the new year.

**The grader cannot drift from escrow-analysis.** Every history is written
from an escrow-analysis account, with the opening balance set last so the
projected starting balance is kept. The account read back out of it
(`readHistory`, which is Step 0 in code) concludes exactly what the original
did; a test holds that over 1,500 accounts. The reference passes all 500
tasks it was checked on.

## regz-apr

regz-apr 1.0.0 is regz-price-tests with the Appendix J solve taken out of
the tools. In its place is refi's present-value tool, and Step 3 says what
the APR is: the rate at which the payments' present value equals the amount
financed, to three decimals, rounded half up. Finding it is a search, the
one a compliance analyst runs when checking a disclosed APR. Every price
test stands on its result. A test holds Step 3 and the tools as the only
changes.

Fairness is by construction, as in regz-price-tests: a quote is kept only
once the reference, searching through these tools, lands on the engine's APR
and every answer after it. About 4.5% of first draws are redrawn. These are
quotes where the search's payment, rounded to the cent as a disclosed
payment is, moves the third decimal against the engine's unrounded one. The reference passes all 400 tasks it was checked
on.

## escrow-policy and regz-policy

Each is its environment's tasks, tools and grader, with only the system prompt
changed: the rules stated as a policy, not a procedure. The rules are
organized by topic and in defined terms, with precedence stated as
precedence and no order of work given. This is the move that first made
the models miss on refi.

**Nothing is lost in the rewriting.** A test holds that every field, code
and term the step rulebook names appears in the policy: 72 names for escrow
and 39 for Reg Z. Every threshold, constant and rounding the grading turns
on is there too, and no numbered procedure survives. The reference passes
under the policy, as it does under the rulebook.

The policies keep refi-policy's lesson: no sentence ends on an "otherwise"
that could attach to more than one condition. Run on the same tasks as the
procedure, a score measures what the procedure was doing for the model.

## Commands

```bash
npm run build -w @hm/environments
npm run env:refi -w @hm/environments -- --policy reference
npm run env:refi -w @hm/environments -- --policy anthropic --model claude-opus-5-5 --effort high --n 20
npm run env:refi -w @hm/environments -- --policy vertex --split train --n 5
npm run env:refi -w @hm/environments -- --policy anthropic-vertex --split train --n 5
npm run env:refi -w @hm/environments -- --env refi-tape --policy reference
npm run env:refi -w @hm/environments -- --env refi-hard --policy reference
npm run env:refi -w @hm/environments -- --env escrow-analysis --policy reference
npm run env:refi -w @hm/environments -- --env regz-price-tests --policy reference
npm run env:refi -w @hm/environments -- --env escrow-policy --policy reference
npm run env:refi -w @hm/environments -- --env regz-policy --policy reference
npm run env:refi -w @hm/environments -- --env escrow-history --policy reference
npm run env:refi -w @hm/environments -- --env regz-apr --policy reference
npm run env:refi -w @hm/environments -- --env flexmod-terms --policy reference
npm run env:refi -w @hm/environments -- --env payments-posting --policy reference
npm run env:refi -w @hm/environments -- --env arm-adjustment --policy reference
npm run env:compare -w @hm/environments -- --a runs/refi-review/a.jsonl --b runs/refi-review/b.jsonl
npm run env:audit -w @hm/environments -- runs/refi-review/a.jsonl [--read INDEX ...]
npm run env:archive -w @hm/environments
```

`env:audit` gives one line per episode and then totals. It flags the things
that point a reader at a transcript:

- every submitted figure that no tool ever returned, meaning arithmetic done
  in the model's head;
- a pass that skipped a tool a full review needs;
- tool calls that came back as errors.

It also shows the slowest turn and the fields missed. Phase 1's gate was
read this way. `--read` prints an episode's turns, and refuses for a
held-out task: that suite is what every reported score is measured on, and
reading its transcripts tunes toward them.

`env:compare` pairs two policies' runs by task. For each side it gives:

- the pass rate with a Wilson 95 % interval;
- the cost per episode, at the providers' list prices;
- per-verdict counts.

It also puts the tasks the two disagree on to McNemar's exact test. An
episode that ended in a transport error is not scored, the newest scored
episode for each task counts, and a task not scored on both sides is left
out by name. Phase 2's gate is read from it.

The default is the reference policy on the held-out suite. A model run
spends real money, and it is never the default.

There are three model policies, and none falls back to another model:

- **`anthropic`** calls Claude over the Messages API. It reads
  `ANTHROPIC_EVAL_API_KEY` first, then the SDK's usual credentials. Keep the
  eval key under that name: the API's refi analyst calls Claude whenever
  `ANTHROPIC_API_KEY` is set, and the API's tests load the root `.env`.
- **`anthropic-vertex`** runs the same Claude loop through Anthropic's Vertex
  SDK (pinned at 0.20.2), billed to our project.
  - That SDK version ignores its `accessToken` option and reads the machine's
    application-default credentials instead, which are stale on Joe's Mac.
    So the policy gives it an auth client that returns the gcloud token on
    every request.
  - Claude Opus on Vertex needs a quota grant before the first call; our
    project's is unset (zero) until one is approved.
- **`vertex`** calls an open model that Vertex AI serves as a managed API on
  our own project. The default is `deepseek-ai/deepseek-v4.1-flash-maas`, at
  $0.30 / $1.20 per million input / output tokens ($0.03 cached), billed to
  the Google Cloud project.
  - It authorizes with `gcloud auth print-access-token` and names
    `homestead-mortgages` in the URL and in `x-goog-user-project`, because
    gcloud's default project on the Mac is Walt's.
  - Google's docs say DeepSeek's function calling is worse with a system
    prompt, so this policy puts the rulebook at the top of the first user
    message instead.
  - Thinking is on (`--thinking off` turns it off), and the reasoning goes
    back with its assistant turn.
  - Every request streams. The endpoint takes 2 to 70 seconds a turn, and
    some turns run past five minutes. Unstreamed, that is where Node's fetch
    gives up waiting for headers, which ended four of the first five smoke
    episodes. A dropped connection is retried whole.

## What keeps it honest

- **The reference policy** (`src/refi/reference.ts`) follows the rulebook
  through the tools alone, reading only the rendered task. The tests hold
  it to 100 % on the held-out suite, a 300-task training suite and the spec
  cases. A task it fails is a defect in the environment, not a hard
  question.
- **The grader matches the spec.** Every spec case gets the verdict the
  spec states, worked example 1 matches to the cent, and an answer one cent
  off any figure fails on exactly that field.
- **The generator** makes every loan internally consistent: the payment,
  balance and remaining term agree under the engine's own amortization. It
  turns up every verdict at more than 12 % and every reason code in the
  rulebook.

- **A miss two models share is checked as wording first.** `env:compare`
  lists every task both sides missed on the same field. Two models that
  fail the same way are usually reading the same unclear sentence.
  - The first case was refi-policy. Both models dropped the existing loan's
    mortgage-insurance premium on the same task, because a sentence ending
    "…whenever it is above 5; otherwise the premium is 0" read as applying
    to any PMI rate of 5 or less.
  - 1.1.0 renamed the premium, which was a guess and did not fix it.
  - 1.2.0 split the sentence in two. Claude then passed the task.
    DeepSeek's remaining miss was its own: it multiplied by 0.25 instead of
    0.25 %.
  - The second was refi-hard: both read a PMI rate of `"100"` as 100 basis
    points. The rule is stated plainly, and it is what the engine does, so
    the defect is the engine's tape reader, not the wording. It was fixed
    the same day (port v3, refi-tape 1.1.0); see docs/decisions.md, "A PMI
    rate of 1 % or 100 basis points was read as no premium".

## Not in 1.0.0

- Reading the raw tape line. The task starts after `universeLoanOf`.
- The two gates that read Fannie Mae delivery records. The engine treats
  them as open, so the task does too.
- Cash-out candidates, and the analyst's written rationale.
- Nothing outstanding on Phase 1's gate. It was met on 19 October:
  DeepSeek-V4.1-Flash passed 58 of 60 training tasks, and none of 64
  passing episodes passed without the work (see docs/decisions.md).
