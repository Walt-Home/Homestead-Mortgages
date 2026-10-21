# Environments

An environment is a task, the tools a model may use, and a grader the model
never sees. `packages/environments` holds them. The first, `refi-review`
1.0.0, grades a model on the daily refinance review, using synthetic loans
only and with the engine itself as the grader. `escrow-analysis` is the
first on the servicing side, and `regz-price-tests` the first on the
origination side. The defects found in the servicing app's own engines
are in `docs/servicing-engine-defects.md`.

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

**No train task draws a held-out stream.** The stream is seeded with a
32-bit hash of the id, and 32 bits collide. Train coordinates whose id
hashes to a held-out id's seed are that held-out task, and environments that
draw the same loans share it across their names: refi-review, refi-tape and
refi-hard; escrow-analysis and escrow-history; the two Reg Z suites. A
search finds such coordinates for any held-out task in under a second, and
four ordinary ones exist: escrow-analysis 1.0.0, train seed 5920, indexes
9554, 9555, 9558 and 9559 are held-out tasks 29, 28, 25 and 24. Treat train
seed 5920 of escrow-analysis 1.0.0, and of escrow-policy, which draws the
same tasks, as contaminated.

`src/heldout-guard.ts` names every train id whose stream, at its first draw
or any redraw, some held-out task draws from, in any environment, current or
retired. The runner leaves those indexes out of a train suite and prints
them, the browser playground refuses them, and its build drops any recorded
run on one. A trainer that draws train tasks itself calls
`drawsHeldoutStream` first. The guard also turns away about one honest train
coordinate in 3,000. The lasting fix is a wider stream key, which moves
every suite and so bumps every environment's version.

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

flexmod-terms 1.2.0 is the second servicing environment: one delinquent
Fannie Mae loan evaluated for a Flex Modification (Servicing Guide F-1-27
and D2-3.2-06), the servicing app's spec §12.8.

**The task.** It gives what the loss-mitigation analyst has on the
evaluation date:

- the loan's balances, arrears and advances, and any earlier forbearance or
  buydown;
- its rate, whether it is an ARM not on its final rate and, for one, its
  lifetime cap or final step, and its remaining term;
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
- an ARM below the MIR, and an ARM whose step-2 rate is exactly its cap;
- a loan modified before to 480 months, 12 to 40 payments back, so more than
  360 months are left;
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

**What it keeps out.** The waterfall departs from F-1-27 in two places a
task could reach. `flexInScope` rejects a loan in either, and the generator
never draws one:

- a remaining term over 480 months, which the engine keeps as it finds it.
  F-1-27 step 4 extends to 480 and no further, and an amortizing Fannie Mae
  loan never has more left (flexmod-1 in `docs/servicing-engine-defects.md`);
- an ARM or step-rate loan whose step-2 rate, the greater of its contract
  rate and the MIR, is above its cap. F-1-27 step 2 caps the rate at the
  lifetime cap or final step; the engine does not (flexmod-2). The task
  carries the cap and the rulebook applies it, which inside that scope
  changes nothing the engine computes.

The engine and tools are exact decimal arithmetic. The generator keeps a draw
only when the reference lands where the engine does, so a suite it built
cannot by itself show the rulebook is fair. A test runs the guard and the
reference over 2,000 unfiltered draws as well and allows no rejection and no
disagreement, and no draw in 600 needs redrawing. The spec's worked example
($251,405.31 gross, $35,483.32 forborne, $1,264.13 P&I) comes out to the
cent, and unit cases settle the rounding ties the rulebook specifies (an
MTMLTV of exactly 50.005, a forbearance cap and a payment reduction at
exactly half) as the engine does.

**1.1.0** changed the generator, so the held-out suite moved. A notice is
never drawn before the evaluation. In 1.0.0 a December notice could fall
before a December evaluation or a year after an evaluation. Two aims are new:
a target the rate alone reaches above the MIR, and a P&I equal to the
pre-modification payment, drawn about half delinquent. Some escrow shortages
now spread into exactly half a cent. The grader spreads a shortage with the
service's own division, which gives the same cent on every shortage drawn.
The rulebook and the tools did not change.

**1.2.0** stopped grading the two departures above, so the task, the
rulebook, the generator and the held-out suite all changed. 1.1.0 drew 470 to
500 months left on about 5% of loans, a term its own loan could not have, and
graded 10 held-out tasks above 480; it carried no cap, so an ARM's uncapped
rate was graded. Now a term over 360 is drawn only on a loan with an earlier
modification, its balance and P&I the modification's, and every ARM not on
its final rate carries `rate_cap_pct`, a quarter of the time exactly at its
step-2 rate. The held-out suite has 4 modified loans, 32 ARMs and 8 on their
cap. The grader did not change. See docs/decisions.md, "Five departures the
environments graded, decided".

## payments-posting

payments-posting 1.1.0 is the third servicing environment: one loan's
receipts posted over a window of four weeks to about two months (27 to 63
days over 1,200 training draws; the spec's cases run one to three months),
the way the servicing app's cashiering posts them (its spec §2.1 receipt and allocation, §2.2
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
- designated principal on a current loan, less than a payment (applied
  apart, the whole receipt curtailed), and on a delinquent one (redirected
  to the arrears);
- an amount of additional principal that never prepays a future
  installment;
- two or three installments prepaid in one receipt, sometimes in a window
  between two runs, so a month with no late-charge run turns up;
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
- a trial. The spec applies an installment once the amount a trial has held
  reaches a payment. The allocation alone never does, and the servicing app's
  trial operation has no caller outside its tests (cashiering-14 in
  `docs/servicing-engine-defects.md`).

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
- one suspense balance never excuses two installments' late charges. The
  engine counts the whole balance toward every unpaid installment's test,
  where 2.7 rule 1 counts what is attributable to the installment
  (cashiering-4). The guard runs the engine's own `assessLateCharge` again,
  handed the balance attributed oldest first, and rejects a run whose
  decision changes; the generator brings any receipt the engine parks in
  suspense after the window's last run for an installment with another
  unpaid before it;
- designated principal on a current loan, which the engine curtails whole,
  is less than the next payment and pools no earlier suspense. 2.4 rule 2
  applies funds sent with a scheduled payment to the payment first, and 2.2
  rule 4 keeps earlier suspense unapplied (cashiering-9);
- every receipt meets an open installment, and one is still open at the end,
  so no answer depends on where the projection stopped.

On 15,000 unfiltered training draws it rejects none, because the generator
aims around all of them. It is a guard, not a filter. Inside v1's scope the
rulebook states what the engine computes, and none of it is a figure the
spec calls wrong. Two readings are close to the line:

- funds held in suspense count toward an installment's late-charge test.
  2.7-Q1 leaves that open, its default counts them (the borrower-favorable
  reading of the note), and the engine documents the default as its
  decision, so it stays graded. The rulebook says so, and counts a balance
  once, oldest installment first, as rule 1 does;
- designated principal on a current loan, less than a payment, is curtailed
  at once, as 2.4 rule 2 says of a curtailment received separately.

Spec Example C (a $2,000.00 partial held, then the run) is the visible
case of the first. The example assesses $79.01; 2.7-Q1's default does not,
because $2,000.00 in suspense is more than the P&I and the one open
installment is the only claim on it. A test holds the engine's answer, and
docs/decisions.md has the engine defects found on the way.

The reference passes the held-out suite, a 300-task training suite and
seven of the spec's worked examples (A, D, F, G, K with M, L, N) to the cent,
with no task redrawn, and agrees with the engine on 2,000 candidates nothing
filtered. Its longest month is 61 tool calls across 5,000 training draws.
That fits inside the episode's 80 turns even for a model that makes one call
a turn, once it computes each grace end once, as Step 1 now says to.

**1.1.0** stopped grading two departures 1.0.0 graded at the engine's
reading, the suspense counted twice and the separate curtailment that could
carry a payment. The guard has the two clauses above, the generator aims
around them, and Step 2 counts a suspense balance once, oldest first. Two
smaller changes came with it: the history before the window is run with the
balance attributed the same way, and a prepayment month sometimes falls
between two runs, so a month with no run at all turns up reliably rather
than about five times in 1,100. The held-out suite moved. The grader did
not change. See docs/decisions.md, "Five departures the environments
graded, decided".

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
works nothing and guesses the commonest label everywhere scores about 0.11 on
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

- a Fannie Mae SOFR plan (4926 to 4928) or a legacy note, nothing aimed;
- index + margin exactly halfway between two eighths, and one
  hundred-thousandth either side, under both rounding rules;
- the first change above and below its cap, exactly on it, and a midpoint that
  lands on the cap rounding down and passes it rounding up;
- the same on a later change, with the periodic cap;
- a later change near the lifetime ceiling, exactly on it, and the tie where
  prior + cap is the ceiling (the cap is named, not lifetime), each far
  enough into the loan for the caps to have got there, and the same tie on
  the first change, which a 7/6 plan's 5 % initial cap makes;
- an off-grid margin (2.800) whose eighth falls below it, so the floor binds
  off the grid, and an on-grid margin a small index rounds onto exactly;
- no print on the index date (a weekend, a holiday or a missing print), with
  a print after it, a day's move away, that would round otherwise;
- interest only through the change, ending with it, and ended at an earlier
  change;
- the 25-day loans: closed before 2015-01-10 with a look-back under 45 days,
  closed on 2015-01-09 and on 2015-01-10, and monthly adjusters;
- the first change's (d) duty: the servicer's, the originator's at 209, 210
  and 211 days from closing, and exempt on a one-year term; and the (c)
  exemptions beside it: the first change whose rate was known at closing (the
  loan closed within the look-back, so the disclosure there was no estimate),
  and the 25-day first change within 60 days of closing after an estimate;
- a send the day before the window opens, on the index date, on the deadline,
  the day after it, and a month late;
- an index that rounds back to the current rate, where the scheduled balance
  re-amortized moves the payment a cent (Fannie Mae's notice, late after
  change − 25) or does not (no notice); and an FDCPA cease on file with a debt
  collector and without one.

**The loans are ones a servicer could hold.** Each product closes in the
months it was made: a Fannie Mae plan or a lender's own 30-day Average SOFR
ARM since the averages were published, a Term SOFR note while LIBOR was
still offered, a legacy one-year Treasury note before 2015. No loan is on the
11th District Cost of Funds Index, which was discontinued in 2022, and no
10/6 plan appears, because one closed since 2020 has no change before 2030.
A plan loan is on the uniform note, which states no tie rule (so a midpoint
rounds down), with a margin of at most 3.000; a loan that rounds a midpoint
up, or has a higher margin, is the lender's own. A later change starts from a rate the caps could have carried
the note to by then, and from a balance never back above the original. Where
the (d) disclosure was made at closing, it was an estimate exactly when the
first change's index date came after the closing, the rule the servicing app
applies to its own (d) notice. Prints are never below 0.01 %, and they move
by what the index moves in a business day: at most 2 basis points for a 30-day
average, more for a one-year yield or term rate.

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
- the current rate is one the caps could have carried the note to by this
  change (the note itself on the first). Any other is an earlier change
  misapplied, which is the error correction v1 leaves out;
- the (d) disclosure at closing, where there was one, is an estimate exactly
  when the first change's index date came after the closing (Regulation Z
  §1026.20(d)(2)). The engine takes the flag as given, so a flag the dates
  contradict would grant or withhold the (c) exemption on a disclosure
  Regulation Z would not have allowed;
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

## payoff-statement

payoff-statement 1.0.0 is the fourth servicing environment: one Fannie Mae
loan's payoff, from the written request to the money owed Fannie Mae, the
way the servicing app computes it (its spec §16.1 payoff statement, §7.6's
Regulation Z 1026.36(c)(3) clock, §16.2 payoff proceeds, §5.2 rule 6 payoff
interest by remittance type).

**The task.** It gives:

- the written request: the day it arrived, the property's state, the
  statement date and the good-through date it names;
- the loan on the statement date: interest-bearing balance, rate, accrual
  method (30/360 months with a 365-day partial, or daily simple), its last
  paid installment, deferred and forborne principal, late charges, fees,
  advances, the recording fee, MI, and the buydown and suspense credits;
- its next scheduled installment, always when it falls due after the
  statement date and by the good-through, because the statement then prints
  the figure if it posts (16.1 rule 7), and sometimes when it does not;
- the borrower's wire: the day it arrived and the amount;
- the loan's Fannie Mae terms: remittance type (A/A, S/A, S/S), pass-through
  rate, whether it is in an MBS pool, and the day the payoff is reported. The
  pass-through rate is the note rate less a servicing fee from 0.25 % to
  0.50 % (Fannie Mae's band for a fixed-rate loan, quoted in spec 29.1), and
  on an MBS loan less a guaranty fee besides (spec 5.2's rate stack).

The model issues the statement (the federal and state deadlines and the one
that governs, how long the figure is good, the day count, the two interest
blocks, the per diem, the total, and the figure if the next installment
posts), reconciles the wire against the exact figure on the payoff date
(the payoff date, the variance, the disposition, the escrow refund's
deadline), and splits Fannie Mae's share (principal, interest by remittance
type, the A/A servicing fee, the S/S gap, the total).

**The grade.** A pass is every field right. 24 figures are graded as 12
fields, each a group that stands or falls together, so the figures that
seldom move are graded with the one that decides them:

- the state's deadline with how long the statement is good (good-through,
  except in Massachusetts);
- the payoff date with the exact figure and the variance (the funds' own
  day, except under the non-business-day rule);
- the NIB line with the total;
- the servicing fee and the S/S gap with Fannie Mae's interest.

Five of the twelve fields need no money worked out: the federal deadline,
the state's rules, the day count, the escrow refund's day, and the per
diem, which is one tool call. So on the held-out suite:

- an answer that copies the request and the funds back scores 0.086, and
  the best constant answer 0.118;
- an answer with every date and count right, the per diem from its tool,
  the disposition guessed from the funds' day against the good-through, and
  no money at all scores 0.549, and passes nothing.

The mean field score is read against the last of these, and it never
replaces the pass. A test holds all three. Cents may be submitted as
strings of digits or as whole numbers, as in every other environment.

**The grader is the servicing app's own engine.** `src/payoff/ported/`
holds `quote.ts` and `remit.ts` from `apps/servicing/src/domain/payoff/`,
and `remittance.ts` and `types.ts` from its `investor/`, because `remit.ts`
takes Fannie Mae's payoff interest from them. Each is byte for byte but for
its import lines, held by a test that rewrites the original's imports and
compares; `remit.ts`'s import of `../investor/remittance.ts` becomes
`./remittance.js`. What the engine takes from its caller lives in the
servicing app's ops layer, so the grader restates it with the line it comes
from, and a test holds those lines:

- the payoff date: the day the funds arrived, or the installment due date
  when it is not a business day and the funds arrive the next one (F-1-09);
- the exact figure: the statement recomputed as of the payoff date;
- a reliance state is Florida, Texas or California, and the payoff is
  within good-through when the payoff date is on or before it;
- the S/S exception: an MBS loan processed on the month's first Fannie Mae
  business day and reported by the second owes no interest for the month,
  processed on the payoff date.

**The tools.** refi's date steps, whole months, per diem and calculator,
and the business-day calendars (`add_business_days`, `is_business_day`) on
the servicer's, Regulation X's and Fannie Mae's days, which are the same
days. One call answers one field: refi's per diem, given the balance and
the note rate, is the statement's per diem. No tool computes a deadline, an
interest block, a total, a disposition or a share.

**The tasks** cycle by index through thirteen edges, a hundred payoffs each
in a suite of 1,300:

- a good-through on the 1st (a full month, no partial days, or no interest
  at all on the loan's own due date) and on the last day of a month, with
  late funds that cross into the next;
- daily simple interest across a month end, and payoffs across February 29,
  2028;
- deferred and forborne principal, every fee and advance, and both credits,
  each in some payoffs and out of others;
- funds a day early and a day late (a day's interest either side of the
  $50.00 tolerance), and more;
- a variance of exactly $0, $0.01 short, $50.00 short, $50.01 short and
  $1.01 over;
- more than $50.00 short in Florida or Texas within the good-through, in
  California within it, and in any of the three on the good-through day
  itself (absorbed); and after it, or in a state that relies on nothing
  (demanded);
- an installment due on a weekend or New Year's Day, with the funds the next
  business day (deemed received on the due date) or the one after, and one
  due on a business day with the funds the next, which the rule does not
  reach;
- requests received before a federal holiday, on one, or on a weekend,
  against each state's clock: Florida and North Carolina's ten calendar
  days winning, tying and landing on a Saturday, Massachusetts' five
  business days, Texas's tie, Connecticut's requested date and its floor
  (a requested date before the floor among them), and a Massachusetts
  statement good through a date past thirty days from issue;
- the next installment due inside the window, on the statement date, on the
  good-through and after it;
- an S/S payoff on the month's first Fannie Mae business day: in an MBS
  pool, reported on the first or second business day (where the 1st is
  one, and where it is not) or on the third; and a portfolio loan's, which
  owes the month whenever it is reported. A/A and S/A shares come from
  every other edge.

**Every case a rule turns on is in the held-out suite.** Where a wrong
reading of a rule answers differently from the engine only on one case,
the edge takes its cases in turn by its own count rather than by chance:
each tolerance threshold, reliance's state and its day, the S/S
exception's business days and its MBS test, the non-business-day rule's
due date, Connecticut's floor and Massachusetts' thirty days. So the 200
held-out payoffs, fifteen or sixteen of each edge, carry at least three of
each, and a test holds that. In a training suite each edge's hundred is
counted on its own, so a test fails when an edge stops drawing its case,
whatever the other edges happen to draw.

**What v1 leaves out, and why.** Mapping the engine against its spec found
places where it departs from its own text; docs/decisions.md lists them. v1
does not grade a model on those, because the grader would be teaching the
defect. The generator draws loans due on the 1st, paid through the
good-through's month or the one before, and:

- never reaches two full months on any day count, where the engine rounds
  each month and the spec rounds the block once, and the month walk drifts
  for due days 29 to 31;
- prints an alternative figure only for the installment after the last paid
  one, so it never skips arrears;
- keeps participation at 100 %, never grades the S/A deficit, and grades
  the servicing fee for A/A only and the gap for S/S only: the portable
  engine's fee of 0 for S/A and S/S is not what the servicing app's runtime
  books;
- draws S/A balances only where the engine's two roundings of the half month
  agree with the spec's one;
- never draws an overage of $0.01 to $1.00, which the engine keeps and the
  ops layer refunds;
- pays a daily-simple loan off in its last paid installment's month, where
  the share's 30/360 walk is the statement's day count;
- never deems an S/S MBS payoff received on a non-business due date, whose
  processing day is in doubt, or deems a payoff back across the
  good-through;
- has the borrower pay directly, so the S/S closing agent's settlement date
  never applies.

Lien release (16.3), the remittance and finality clocks in Eastern time,
rate segments and ARM changes, the 7.6 notice's own payoff calculator, the
70 % warning date, CT interest forfeiture and bankruptcy or foreclosure
components are not in v1. `payoffInScope` runs on the engine's own figures
and rejects a payoff in any of the regions above, or with the request, the
statement (issued on a business day) and the funds out of order. A test
builds a payoff that each clause alone rejects, for every clause no other
one covers. It rejects none of 20,000 training
candidates, because the generator aims around them. Where the
spec and the engine disagree inside scope, the rulebook states the
engine: a shortage is the exact recomputation, so 16.1-T2's $221.10 (five
per diems) is graded at the exact $221.09. The good-through is the
statement's own; the generator keeps it within 31 days of the request, the
cap the ops layer applies, and the spec's own §7.6 example runs to 38.

The reference passes the held-out suite, a 300-task training suite and
fifteen of the spec's worked examples to the cent. Every held-out payoff
is its index's first draw, no training task is redrawn in 600, and the
reference agrees with the engine on 2,000 candidates nothing filtered, so
the generator's filter is not what makes those passes. Its longest payoff
is 37 tool calls, the submission included, in 8 turns: the calls that do
not wait on each other go side by side. `env:audit` and `env:compare` read
a payoff's disposition as its verdict.

## pmi-termination

pmi-termination 1.0.0 is the fourth servicing environment: one loan's
borrower-paid mortgage insurance under the Homeowners Protection Act, as the
servicing app administers it (its spec §10.1 borrower-requested
cancellation, §10.2 automatic termination at 78%, §10.3 final termination at
the midpoint, §10.5 the unearned-premium refund).

**The task.** It gives one loan's MI on an evaluation date:

- the note as originated: price and appraisal, units and occupancy, the
  balance, rate and term, any ten years of interest only;
- the ARM rate changes since, or a modification with forborne principal;
- the MI plan: a monthly, annual or single premium, or lender-paid;
- a ledger of installments and receipts;
- on a request, the borrower's written request: its date, the path asked
  for, the AVM or the borrower's paid valuation, the balance on receipt and
  every posting since, deferred and forborne principal, and any
  installments a disaster excuses.

The model builds what it needs of the MI schedule with the tools: the P&I,
the balance row by row, a re-amortization at each rate change. It finds the
78% date, the midpoint and the trigger. Then it decides what the date calls
for:

- a request: eligible, ineligible, a value check needed, or refused, with
  its LTV in floored basis points, its threshold, the two late-payment
  counts, its reasons and its 30-day clock;
- otherwise, the sweep at the trigger: current or not, the installments
  that failed, the not-current notice and the cure;
- for lender-paid MI, the options notice.

Where the MI ends it sets the effective date, LAR 89's code and date, the
notice, premium-stop, refund, insurer and escrow clocks, and the unearned
premium.

**The grade.** A pass is every field right. The position is six fields; the
78% payment and its date are one. A section the date does not call for (no
request, no sweep, no termination) is one field when it is answered null.
Answered anyway, it costs every field it holds, as leaving out a section the
date does call for does. So claiming a grant, a cure or a sweep that is not
there costs exactly what missing one costs: ten fields either way for a
request or a sweep, nine for a cure. Inside a section, fields that are all
null on that task are one field: a refused request, a sweep that found the
loan current, the two late counts.

The sections must also agree, or the submission comes back as an error to
correct, the way a schema error does:

- a request or a sweep, never both;
- a result with its own reasons;
- a sweep's findings with whether it found the loan current;
- a termination exactly when the request is eligible or the sweep found the
  loan current or cured, coded 51 or 52 for a request and 53 for a sweep;
- the lender-paid notice alone.

An answer cannot say "ineligible" and hand in the termination as well.

An answer that answers nothing scores about 0.16 on the held-out suite. The
floor to read the mean field score against is higher, about 0.47. That is
what a policy scores that reads the original value and the rule, works the
note's P&I and the midpoint with a call each, takes the midpoint for the
trigger and searches no schedule. Taking the trigger from the evaluation date
instead scores less, about 0.44, because the date says nothing about where
the trigger fell. A test holds that.

**The grader is the servicing app's own engine.** `src/pmi/ported/` holds
four files from `apps/servicing/src/domain/pmi/` and two from
`apps/servicing/src/domain/boarding/`:

- `schedule.ts`, `termination.ts`, `cancellation.ts` and `refund.ts`;
- `delinquency.ts`, the ledger's FIFO, and `types.ts`, which it imports.

They sit flat, each byte for byte but for its import lines, held by a test
that rewrites the original's imports and compares. One file is ours:
`src/pmi/lossmit-stub.ts` stands in for a type `types.ts` imports from a
stateful transfers module. The conventions around the engine are restated
in the grader, with the line each comes from:

- the trigger is the earlier of the 78% date and the midpoint for a loan the
  rule reaches (`pendingTriggerDate`, 10.3 R4);
- the sweep runs at every trigger, whatever the 78% rule: it decides only
  which date triggers;
- the midpoint runs from the governing first due and full term, the
  modification's after one. It is never measured from a rate change;
- a rate change re-amortizes over the rows the note has left;
- the premium-stop anchor, the refund's coverage period, and the date the
  threshold was reached, which the engine takes as an input.

**The tools.** refi's level payment, balance after payments, date steps and
calculator, plus the servicer's business-day calendar
(`add_business_days`), which the insurer's notice and the escrow analysis
are counted on. No tool finds a threshold's date, a midpoint, a cure or a
refund.

**The tasks** cycle by index through twelve edges, a hundred tasks each in a
suite of 1,200. Every loan is one that could exist:

- no more borrowed than the spec's extract of Fannie Mae's Eligibility Matrix
  allows: a second home 90%, an investment property 85%, and that only on a
  one-unit purchase;
- a certificate effective between closing and the first payment;
- no more than 30% of a modification forborne, the Flex Modification's cap.

The evaluation date is drawn apart from the trigger, up to thirteen months
after it (or before it, when nothing has happened yet). The ledger runs back
from the evaluation date by a span of its own. Neither says where the
trigger fell; only the schedule does.

The edges:

- the 78% threshold on a row's balance to the cent, a cent either side, and
  half a cent under a row's balance (an odd one), which only rounding half up
  puts on that row;
- the 78% date a payment either side of the midpoint, on interest-only loans
  and modifications, and the sweep the day before the trigger;
- the rule's reach: consummated 1999-07-28 or 29, a second home against an
  investment property, one unit against two to four, before 1999;
- one or two rate changes, up and down;
- a modification whose own 78% date or midpoint triggers;
- the month before the trigger paid on its last day or on the trigger, with
  February of a leap year as that month;
- cures on the trigger, on a month's last day and on a 1st, by partial and
  double receipts, in two steps, and none by the evaluation date (each in
  turn by index); an older arrear caught up on the test month's last day,
  which the not-current list leaves out;
- an annual premium on its anniversary, a day after it, and 365 days into a
  year with a 29 February; a single premium on a row of its refund schedule
  and a month short of one;
- a request's LTV at 80.00% (70.00% for two to four units or an investment
  property, 75.00% on the current-value path) in floored basis points, a
  point either side, at the top and bottom of the point; deferred and
  forborne principal; a curtailment posted after the request;
- a 30-day late in the last twelve months and a 60-day late in the twelve
  before, each alone, at 29 and 30 days, 59 and 60, February included; a
  disaster exclusion that decides; a 60-day late on a loan younger than 24
  months; not current at the request, or current to the day (the month
  before paid on its last day); an installment 30 days late that is due on
  the request date (outside the windows, which end before it) or due earlier
  that month and satisfied after it (inside them, counted to its
  satisfaction);
- an AVM below, at or above the original value, or none; a borrower's paid
  valuation; the 120th day after delivery and the 121st; the current-value
  path with a valuation and without one (each in turn by index, so the
  held-out 200 has every one), at 23, 24, 59 and 60 months, by class and
  with improvements;
- lender-paid MI.

Effective dates on 1sts whose business-day clocks step over a federal
holiday are drawn throughout.

**What v1 leaves out, and why.** Mapping the engine against its spec turned
up places where it departs from its own text. v1 does not grade a model on
any of them. `pmiInScope` runs on the engine's own outputs, and the
generator aims around every one, so on 5,000 unfiltered draws it rejects
none. It keeps out:

- odd terms, whose midpoint the engine places a month late;
- due days other than the 1st, where the current test misses an
  installment;
- New York. The engine reads a New York purchase's appraisal alone as the
  original value. New York's own 75% stop (§6503(d), 10.2's overlay) ends
  the borrower's premium with no request, and nothing ported computes it;
- a rate change after the 78% row or the midpoint of the schedule then in
  effect, or inside an interest-only period;
- a request after the scheduled 80% date on a one-unit principal residence
  or second home, on either path, where the engine never tests the scheduled
  balance;
- a current-value request whose balance already meets the original-value
  threshold. 10.1 R1 evaluates the original-value paths first and grants on
  any of them; the engine evaluates only the path asked for. So on every
  current-value task the original-value paths fail on the balance, and the
  request section is the current-value path's own evaluation;
- a current-value request with no threshold and no valuation, where the
  engine asks for a paid valuation that cannot help;
- a borrower's paid valuation below the original value, where the engine
  loops back to a value check;
- a request whose borrower is current a month before it and not at the
  decision, where the engine discards the HPA's own test;
- an evidence date other than the valuation's delivery, where the 30-day
  clock is ambiguous;
- a threshold reached after the request that would change the late counts
  sent to Fannie Mae's servicing system.

The payment-history windows shorten to the loan's age, as 10.1 R5 says,
and the rulebook restates that. It never changes an answer in v1. A request
comes after the loan's first installment, and the windows shortened back
from it reach before that installment. The guard keeps the counts at a later
threshold date equal to the counts at receipt, so the age clause decides
nothing there either. The young-loan edge is a 60-day late on a loan under
24 months, not a window the age cuts short.

Where engine and spec disagree inside that scope, the rulebook says what
the engine does. One reading is graded on purpose, though it departs from
the statute's "80 percent". The LTV is floored to the basis point and
tested at or below the threshold, as 10.1 R3 says, so $370,522.40 on a
$490,000 BPO is 75.61%, where the spec's example prints 75.62%. A balance
up to $39.99 over 80% of a $400,000 value is 8000 and granted. R3 states
the floor, the test and why ("so a borrower is never denied by a rounding
artifact"), so the figure is the spec's own and not one it calls wrong.
Step 7 of the rulebook states the floor and the test, and the generator
aims at the top of the basis point (pmi-9 in
`docs/servicing-engine-defects.md`). The value-check fee options and the
denial notice's content are not graded. docs/decisions.md has each
departure, reproduced.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and all 25 of the spec's worked examples to the
cent. The examples include 10.2's three scenarios, its ARM, Flex
Modification and lender-paid cases, 10.3's four loans, 10.1's requests and
10.5's two estimates. It redraws none of 600 first draws, and it agrees with
the engine on 2,000 candidates nothing filtered (5,000 when last measured,
none out of scope). Its longest task is 35 tool calls across 5,000 training
draws, well inside the episode's 80 turns. Step 6 says which ledger steps
are reading: a receipt added to nothing held, and an installment taken from
an equal amount. A model that also counts every window installment's days
with a tool, ignoring Step 7.5's note, needs at most 57 turns at one call a
turn.

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
did; a test holds that over 1,500 accounts. The reference passes the
held-out suite, 300 training tasks and 10,000 more training ledgers, each
of those within 35 turns. It makes the calls that wait on nothing else
together in one turn, as escrow-analysis's reference now does too. Made one
a turn, it ran out of the 80 turns on 5 of those 10,000: the longest ledger
is 82 tool calls, so a model that makes one call a turn would run out on
about one ledger in 2,000.

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

## The Supermortgage Gym

Every environment also runs in a browser, for people without a checkout:
https://claude.ai/artifact/LKEDiyPJyoQ4UwijqwpNw6 (private; shared by its
owner). `playground/entry.ts` puts each environment the CLI registers behind
one plain-JSON interface and hands every call to that environment's own
generator, tools, parser, grader and reference, so the page cannot drift from
the runner. `scripts/build-playground.mjs` bundles it and gathers
`runs.json`: model episodes on the train split only, each held to the
held-out guard. The page offers training tasks and spec cases and never a
held-out task. Republish both files after an environment changes:

```bash
npm run env:gym -w @hm/environments     # build, and serve at http://localhost:8765
```

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
npm run env:refi -w @hm/environments -- --env payoff-statement --policy reference
npm run env:refi -w @hm/environments -- --env pmi-termination --policy reference
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
