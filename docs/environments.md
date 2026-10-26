# Environments

An environment is a task, the tools a model may use, and a grader the model
never sees. `packages/environments` holds them. The first, `refi-review`
1.0.0, grades a model on the daily refinance review, using synthetic loans
only and with the engine itself as the grader. `escrow-analysis` is the
first on the servicing side, and `regz-price-tests` the first on the
origination side. `catchup-posting`, `escrow-review` and `boarding-triage`
are the first drawn from the life generator's histories, `call-qa` draws
from them through the contact center, `contact-audit` reads a loan's whole
contact history for the staff errors the contact center plants, and
`tape-intake` is the first drawn from its tape stream. The defects found in the servicing app's own engines
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

### The annual statement's explanation

The statement the analysis goes out with says why the payment changed:
the shortage, the bills that moved, and the cushion. The servicing app's
statement engine writes the last two, and it is ported beside the analysis
so a later grader can hold a borrower's "why did my payment go up?" call to
it. escrow-analysis does not read it; its grading and its version are
unchanged.

**The port.** `src/escrow/ported/statement.ts` is
`apps/servicing/src/domain/escrow/statement.ts` (§3.3) byte for byte but for
its three kernel imports, held by `escrow-statement.test.ts` as analysis.ts
is held. Its `lowPointExplanation` writes item (viii) of Reg X
§1024.17(i)(1), the reasons the low balance last year's projection set was
not reached:

- each bill paid at another amount than projected;
- each bill nobody projected;
- the low balance against the projected one, which is the cushion.

**The wrapper.** `statementExplanation(analysis, ledger, labels)` in
`src/escrow/statement.ts` runs it over one computation year. It takes:

- the analysis that set the year's payment, as the escrow port computed it:
  the year's start and `project()`'s items and targets;
- the year's ledger: the opening balance, the deposits, and the
  disbursements by line;
- optionally, the name the statement prints for each line type.

The servicing app pairs the engine's input in its agent, not in code, so
the pairing is ours:

- a projected bill and a paid one are one line when they share a line type
  and a month;
- a bill that moved is two lines: paid $0.00 where it left, and "not
  projected" where it arrived;
- the actual low is the lowest month-end balance, as the servicing app's
  statement assembly computes it (`buildHistory` and
  `assembleAnnualStatement` in its escrow `ops.ts`); a test holds those
  source lines;
- the projected low is the projection's lowest target: the cushion, unless
  the trial balance never falls to zero in the year. The projection must be
  monthly, as the history is.

**Held to the spec.** A test recomputes §3.3's worked example from last
year's projection and the year's bills. It gets the four lines the spec
prints and the servicing app's own test asserts, read out of both files.
3.3-T9's two lines are among them. The year ends at $700.00, the projected
actual §3.2's worked example starts from, so the shortage ($406.68, $33.89
a month) and the new payment ($172.22) that escrow-analysis grades are the
ones these lines explain.

**What the lines leave out.**

- **A negative low.** The engine prints one wrongly: −$105.50 as $-105.-50,
  and −$0.50 as $0.-50 (escrow-4 in `docs/servicing-engine-defects.md`). An
  account overdrawn during the year has a negative low, so
  `statementScopeIssues` names it and `statementExplanation` refuses it. In a
  thousand-loan book from the life generator (1.2.0, seed 1, the typed
  defaults), 54 of the 4,930 computation years `escrowYears` reads whole had
  one (under 1.0.0, counting every analysis's twelve month-ends, 75 of
  6,016).
- **The shortage sentence.** Items (vi) and (vii), the surplus or shortage
  and the repayment plan, are `decisionText` and `planText` in the servicing
  app's escrow `ops.ts`. That file is not ported, because it carries the
  stateful operations layer around them. Their figures are the analysis's
  own, which `analysisDecision` (below) decides again for a reader.
- **Thousands separators.** The engine prints $1710.50 where the statement's
  other items print $1,710.50.

**A generated year.** Since life 1.2.0 each analysis row carries its
projection's bills and twelve targets (`AnalysisRow.projection`), so a
generated year can be explained. `escrowYears(loan)` (`src/life/escrow-year.ts`)
reads every computation year the history holds whole on one servicer's
books (every month-end in it and the one before it, no transfer or payoff
inside it, the account open throughout) into the wrapper's two inputs:

- the analysis that set the year's payment, with its projection;
- the year's ledger: the month-end balance before it, the escrow share of
  every receipt posted in the year and any money a payee returned as
  deposits, and every bill by its line as disbursements, with a surplus
  refund to the borrower as a line of its own, `refund`, which the engine
  prints as a bill nobody projected.

A test runs the engine over every such year of a 300-loan decade: each
year's month-end balances are the history's, every line is one of the
engine's three templates, and the years overdrawn somewhere in them are the
ones `statementScopeIssues` names. In that decade every year it explains has
at least one line, because the account's low is never exactly the
projected cushion.

**The year a statement explains.** `escrowYears` is the year as it turned
out. The statement mailed with an analysis cannot be: the analysis runs 45
to 75 days before the year it sets, so the year it closes is not over. The
servicing app's statement assembly marks the months after the approval as
assumed (`assembleAnnualStatement`: `assumed: late ? false : r.month >
f.approved_on`). `statementYearOf(loan, analysis)` reads that year as the
statement has it:

- the analysis before it, whose projection the year is held to;
- the ledger through the run date, as `escrowYears` reads it;
- after the run date, what the analysis itself counted on for its
  projected actual: the escrow share of each installment still due before
  the year, at its due date, and each bill still to pay, at its amount.

The year ends at the analysis's projected actual balance, and a test holds
that on every analysis of a 300-loan decade, a book of loans transferred in
with vendor and system errors (and its twins), and the demo loan's four.
Through the run date its postings and month-ends are `escrowYears`' own.
What the statement says is known the day it goes out, so a call after it
reads the same lines whatever the history did next. A refund the analysis
itself orders is item (vi), not (viii), and is not in them.

An analysis has no statement year when:

- its year's payment was set by no analysis the history holds: the first
  one, whose year's payment was set at closing;
- the borrower was more than 30 days behind at it, so no statement goes
  out (§1024.17(i)(2), the ported `exemption`; the shortage notice still
  does);
- the year runs across two servicers' books;
- the history ends before an installment the analysis counted on (a payoff
  after the run date).

In seed 1's thousand loans (life 1.2.0, the typed defaults), 4,906 of 5,741
analyses have one: 745 are first analyses, 65 exempt and 25 end early. 27
of the 4,906 are overdrawn. `statementReading` reads item (viii) for one,
every figure parsed back out of the engine's own lines. An overdrawn year
keeps its bill lines, which the engine prints whole when it is handed the
same low twice, and loses the low line, with `refused` saying why.
`analysisDecision(row)` decides the analysis again through the escrow
port's `decide` and `newPayment`, for items (vi) and (vii): the shortage's
and deficiency's level installments and months, a refund's date, a
credit's monthly amount. It throws if the port disagrees with the row; a
test holds it to every row.

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

**1.2.0** (22 October) reworded the General QM threshold so the
manufactured-home rule comes first and says it holds whatever tier the loan
amount reaches. 1.1.0 listed the tiers and then the manufactured-home case,
so a reader working down the tiers could stop at 3.5 for a manufactured home
between $82,775 and $137,958, where the answer is 6.5; 6 of the 200 held-out
tasks and 56 of 3,000 training tasks are that case. The underwriting
decision's review found the same wording in its own rulebook first. No answer
changed. regz-policy's policy text and regz-apr, which shares this rulebook,
moved to 1.2.0 with it, and the 1.1.0 held-out namespaces stay on the guard.

**The proof of fairness.** The reference passes all 501 tasks it was checked
on. Hand-worked quotes at each edge are held to figures worked by hand,
apart from the engine.

## aus-decision

aus-decision 1.0.0 grades the origination side's whole decision: one loan
file decided the way the shadow AUS decides it (`underwrite` in
`@hm/underwriting`), from the credit scores to the outcome. regz-price-tests
grades the compliance block inside it; this grades the rest around it.

**The task.** It gives the file as an underwriter holds it:

- one or two borrowers, each with whether they will live in the home and
  their own reports: bureau scores, tradelines (creditor, type, opened date,
  balance, limit, payment, and why a payment is left out of the ratio, if it
  is: the mortgage a refinance pays off is on the report, marked paid off at
  closing), bankruptcies, foreclosures, short sales and deeds in lieu,
  deposit and retirement accounts, and tax transcripts, or a report missing;
- the household's income sources, each with whether its continuance is
  established;
- the property, the loan (purchase or rate-and-term refinance, junior liens,
  interested-party contributions, and on a refinance the loan it pays off),
  the product, and the instant the rate was set;
- the instant the decision is made;
- two figures the engine computes from placeholders, given as the lender's
  estimates and never asked for: the monthly housing payment (it carries an
  escrow assumption and a mortgage-insurance estimate) and the closing cost
  total (it carries a national title premium).

The model works the scores and seasoning, qualifying income, the transcript
check, the debts and both ratios, ability to repay, the three loan-to-value
figures and the maximum, the fees, the APOR and the APR, funds to close and
reserves, the contribution cap, the Regulation Z price tests and a
refinance's net tangible benefit; then the findings, what could not be
computed, the recommendation and the outcome.

**The grade.** A pass is every field right. 38 answers are graded as 11
fields, and a twelfth on a refinance: the scores with the seasoning, income
with the transcript variance and the debts, the two ratios with ability to
repay, the collateral (the three ratios, the maximum, the contributions and
their cap), funds to close, reserves, the fees with their two tests, the
APOR, the APR with the spread and the QM and HPML tests, each with the
threshold it was decided against, the engine's own result (findings,
blocked requirements, recommendation), and the outcome. No file is non-QM
or higher-priced, so the two verdicts are one-sided where they are known;
the spread and the thresholds are what a model has to work for. Findings
are graded as a set of codes and blocked requirements as a set of ids,
never as text. The best answer that works nothing scores 0.134 on the
held-out suite: for purchases and refinances apart, each field takes
whichever got it right more often on a training suite, its commonest value
there or the file's own figures copied where one is near. A net tangible
benefit reported on a purchase is a field of its own.

**The grader is the engine, imported, not ported.** The task is built into
the `LoanFile` the engine reads, every borrower's reports under `reports`
and Borrower 1's mirrored onto the file-level fields, and `underwrite` runs
on the production path: no stated market, so the fee schedule, the APOR and
the APR are derived from the file as the decision route derives them. Two
things differ from production, both for reproducibility. The APOR table is
a frozen copy of the engine's checked-in table (507 weeks, 2017-01-02 to
2026-09-14), held in `src/aus/apor-frozen.ts` and pinned by its hash, so
refreshing the engine's table never moves a graded answer. The decision
instant is the task's. The given housing payment and closing costs are
checked against the engine's own before anything is graded. A test holds
the grader's decision byte-equal to `underwrite` called as the route calls
it.

**The tools.** regz-price-tests' New York calendar date and Appendix J solve,
an APOR lookup over the frozen table, and refi's level payment, whole months
and calculator. None takes a file, picks a threshold or returns a finding.

**The tasks** cycle by index through fourteen edges, two hundred files each
in a suite of 2,800:

- a purchase or a refinance, nothing aimed;
- a loan of exactly 80% of value, and one a dollar or more over it that
  still shows 80.00, where the APR is refused;
- each maximum (97, 90, 85, 95 with a non-occupant co-borrower, 97 on a
  refinance), exactly and a hundredth over;
- the back-end ratio at 45.00, 45.01 and 50.00, with joint debts, excluded
  payments and income whose continuance is pending;
- three, two and one bureau scores, a low bureau the middle score passes
  over, an own score of 620, two borrowers whose average lands on a half,
  and a report with no scores;
- each seasoning minimum (24, 48, 84) met and missed by a month, for
  chapters 7, 11 and 13 and a bankruptcy with no chapter, a bankruptcy with
  no discharge, an older record deciding behind a later one, and records on
  the co-borrower's report;
- a rate set late on a Sunday in New York, on New Year's Eve there (a 2025
  rate, whose thresholds the engine does not hold) and New Year's Day, on
  the last day the table reaches and the first it does not, an adjustable
  rate, a 25-year term, and a prepayment penalty;
- spreads just under the HPML line, under the jumbo line's, and under each
  General QM threshold on its tier, on second homes, investment properties
  and manufactured homes in the middle tier, whose 6.5 is not the tier's;
- the high-cost line between $37,307 and $37,308, loans on each small-loan
  tier, and a second home's points-and-fees counteroffer;
- a refinance's scheduled payment, a saving of nothing, and the recoup at
  60.0 and 60.1 months, with a home-equity line kept behind it now and then;
- reserves at the requirement and a tenth under it, for second homes,
  investment properties and extra financed properties, with retirement at
  60%, joint accounts and accounts not used to qualify;
- contributions at each cap and a hundredth over, and LTV on each side of
  the 75% and 90% bands;
- the transcript variance at 10.00 and 10.01 either way, two borrowers'
  latest years, income still under review beside them, and a borrower
  without one;
- a borrower without a credit report, no asset reports, no established
  income, and a base wage still under review beside one that counts.

Amounts are whole dollars, but for the engine's own figures and what follows
from them (a payoff with the costs rolled in, an old payment set from the
new one) and, where a ratio's window is narrower than a dollar of income,
the lead salary. A refinance is a loan someone could hold: the mortgage it
pays off is on Borrower 1's report with its balance and payment, its
principal and interest retires its balance at its stated rate within
thirty years, a home-equity line kept behind it is a tradeline with a
payment of its own, and no borrower files a bankruptcy while another of
theirs is open. Overtime, a bonus or commission only ever comes beside a
base wage.

**What v1 leaves out, and why.** The engine raises questions of policy that
its owners have not settled (docs/decisions.md, "Seasoning is counted in
UTC, and the record that decides is the one tested"). v1 never draws a file
whose graded answer depends on one, and its rulebook states only what the
engine does in the region it draws. `ausInScope` runs on the task and the
engine's own derivations and rejects:

- a borrower's own score under 620, because a score under the minimum is
  referred only through the illustrative pricing grid's floor;
- a back-end ratio over 50, exactly or as rounded, because the engine's
  maximum is an income finding, not an eligibility one;
- eligible assets short of the funds to close, or funds below zero, because
  the engine never compares them and adds a refinance's cash back to
  reserves;
- a non-QM or higher-priced result, because neither raises a finding. A
  file whose ability to repay is undocumented has its APR or APOR refused
  too, so it is never decided non-QM;
- a refinance of a second home or investment property, because a
  refinance's maximum ignores occupancy;
- a household with no base wage, because INC-004 blocks every file
  without a base-wage source where the sheet scopes it to wage earners, and
  whether a commission or bonus earner with no base is one is open; and
  transcripts on a household with no variable, self-employed or rental
  income, which the sheet scopes INC-009 to;
- asset reports from some borrowers and not others, because ability to
  repay reads Borrower 1's report;
- a bright line where the rounded figure and the exact one fall on
  different sides (the ratio at 45 and 50, LTV against its maximum and the
  75 and 90 bands, the contribution cap, the variance at 10, the reserve
  months, the 60-month recoup), and any figure the engine rounds in binary
  exactly on a half, where binary rounding parts from decimal (two
  borrowers' score average lands on one on purpose: it is exact, and both
  round it up);
- a seasoning record dated on the 1st or after the decision's day of the
  month, where the engine's calendar months part from whole months, and two
  records of one kind with one margin or date;
- two different debts or accounts sharing the key a joint one is known by;
- a two-to-four-unit property over 75%, a manufactured home over 80%, a
  loan over the conforming limit above 80% or over the high-balance limit,
  and junior liens past the maximum, because the engine's maximum reads
  purpose and occupancy alone and tests the first lien alone;
- a finding or a blocked requirement the rulebook does not name.

It also rejects junior liens on a purchase, because funds to close takes no
second lien's proceeds; a refinance keeps its home-equity line. Every
refinance is one whose investor requires a net tangible benefit, which the
rulebook states, because the engine tests it on all of them and the sheet
only where a state or investor requires it. Also not in v1: cash-out
refinances (V1 does not offer them), the LLPA basis points (the grid is
illustrative; only its block is graded), the housing payment and closing
costs as derivations, the adverse-action text and condition descriptions
(copy), and UW-011, UW-012 and UW-013. A test builds a file that each clause
rejects and shows what the engine does there. The guard rejects none of
40,000 training candidates, because the generator aims around all of it.

**Every case a wrong reading turns on is in the held-out suite.** The edges
whose cases a misread rule answers differently on (an LTV at its maximum, a
non-occupant co-borrower's 95%, the 75% band at 75.00, a contribution at its
cap, the older seasoning record, a chapter 11 or a bankruptcy with no
chapter, a late-Sunday or New Year's Eve rate, a 25-year term, a prepayment
penalty on a primary residence, a report with no scores, a manufactured
home in the middle tier, income under review beside a transcript check)
take them in a set order by their own count, so the 200 held-out files,
about fourteen of each edge, carry at least three of each of 30 wrong
readings, and a test holds that.

**The rulebook's numbers are the reference's.** Every limit the rulebook
states (the maximums, the reserve months, the seasoning minimums, the fee
schedule, the Regulation Z tiers and lines, the recoup) is in `AUS_RULES`,
which the text is written from and the reference reads; a test fails if a
limit is typed into the reference instead. A number changed there moves
the reference, and the tests that hold the reference to the engine fail.
The rulebook's rules are also pinned sentence by sentence in the test, so
a rule reworded or a number typed into the text fails until the test is
changed with it by hand: refreshing the hash pin is not enough.

The reference passes the held-out suite, a 300-task training suite and
twelve worked cases: the verified minimal file ($400,000 on $500,000 at
6.5%, DTI 20.88, APR 6.587 against 6.57, clear to close), a loan $10 over
80%, 97.01%, a ratio of 45.01, each side of the high-cost line, 48 months
of seasoning, the older record deciding, two borrowers' scores, a 60.0-month
recoup, a late-Sunday rate and a co-borrower with no credit report. No task
is redrawn, held-out or in 600 training draws, and the reference agrees with
the engine on 2,000 candidates nothing filtered, and on 40,000 more in a
probe. Its longest file is 27 tool calls in 4 turns. A test runs a sample under America/New_York and
Asia/Tokyo in child processes and gets one hash. `env:audit` and
`env:compare` read the outcome as the verdict.

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
receipts posted over a window of about four weeks to about two months (26
to 63 days over 12,000 training draws on ten seeds, the shortest a
prepayment month between two runs; the spec's cases run one to three months),
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

pmi-termination 1.1.0 is the fourth servicing environment: one loan's
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

**1.1.0** (22 October) narrowed one sentence of Step 10. 1.0.0 said a value
below the original value asks for another; for a delivered valuation the
spec says it is a denial (docs/servicing-engine-defects.md, pmi-6), and the
generator never draws one, so the sentence graded nothing and taught the
wrong rule to anyone reading the rulebook in the Gym. It now says a delivered
valuation is never below the original value in a task, and that the AVM
below it asks for a valuation. No answer changed, but the rulebook is
pinned, so the version and the held-out suite moved. Three of the tests that
held 1.0.0's suite to a distribution now hold 2,000 training tasks to it,
with a looser guard on the suite, because 1.1.0's draw sits in the tail of
what 200 tasks give.

## qualifying-income

qualifying-income 1.0.0 is the origination side's second environment
family, beside Reg Z's price tests: Fannie Mae B3-3 qualifying income on one
purchase application, the way the servicing app's origination engine
computes it (its spec §22.3, rules R2, R3, R5, R6, R11 and R13).

**The task.** One purchase application on its scheduled note date, with one
or two borrowers and three to six income sources on the file (across both
borrowers, not each). Each source carries what its documents show:

- a salary, per year, month, half month, two weeks or week;
- hourly pay: the rate and either guaranteed weekly hours or the weekly
  range with its average, and the paystub's year-to-date, the prior year's
  W-2 and the months of history;
- overtime, commission or tips: the same earnings figures, offsetting
  factors for a history of 12 to 23 months, and the paystub series' flat run
  after a decline, when there is one;
- Social Security: the award, whose record it is on, any nontaxable share
  the tax return documents, and when a benefit on another's record ends;
- child support, alimony or separate maintenance: the decree, the months of
  receipts and whether they were full, regular and timely, and the child's
  birth date and any state extension, or the award's term;
- a retirement distribution, its account balances and whether access is
  unrestricted and penalty-free;
- public assistance, whether the agency letter is on file, and its stated end;
- rent on the subject property: Form 1007's rent, the PITIA, and the
  Schedule E's Fair Rental Days or the months of management experience.

Each borrower also carries facts Regulation B protects: age, retirement,
part-time work, and the intake's flags. None of them may change a figure.

The model classifies each source, computes its monthly qualifying figure,
decides continuance against the note date plus 36 months and what is
excluded and why, and totals the household.

**The grade.** A source is one field: its whole row, which is

- the method, the trend, and the monthly figure;
- the nontaxable share and the gross-up;
- the continuance end, whether it counts, and why not;
- a rental loss carried to obligations.

Most labels are nearly fixed by the type or usually empty, so each travels
with the figure that decides it, and a label guessed alone earns nothing.
The file is one field: the total and the rental obligations together. A
source answered that the file does not have is a failed field of its own.
The submission is read strictly: anything the schema forbids, a source
listed twice included, comes back as an error to correct.

On the held-out suite:

- an answer that answers nothing scores about 0.002;
- copying each stated amount as the monthly figure scores about 0.15;
- every label right with no money scores about 0.14;
- applying no rule at all scores about 0.19: copy each stated amount and
  each stated end (a benefit's, a term's, a letter's), count every source,
  exclude none. That is the floor to read a score against. It checks no
  balance, letter, receipt or end against the line, and it is still right
  on most retirement distributions, alimony, separate maintenance and public
  assistance, because most of those count at their stated amount.

**The grader is the servicing app's own engine.** `src/income/ported/`
holds `ops-22-3.ts` and `ops-22-1.ts` from
`apps/servicing/src/domain/verification/`. The second comes only for the
three constants the first imports. Each is byte for byte but for its import
lines, held by a test that rewrites the original's imports and compares. The
grader calls only the pure calculators. `calculateIncome` and the other
service entry points append events, so the conventions around the
calculators are restated in the grader with the line each comes from, and a
test holds the lines:

- the dispatch by type and its defaults (`calculateIncome`,
  ops-22-3.ts:764-790);
- an hourly source whose hours fluctuate is trended as variable base income
  (:767-768);
- the Reg B check on every calculation (:791);
- a source is used when its figure or gross-up is above zero
  (section22-3.ts:74);
- the three-year continuance gate (evaluators-22-3.ts:17-22). A failure keeps
  the figure but drops it from the total (section22-3.ts:84);
- the total (section22-3.ts:88).

**The tools.** refi's date step, day count and exact calculator, and nothing
else. No tool classifies hours, assesses a trend, grosses up income or
decides continuance.

**The tasks** cycle by index through thirteen edges, a hundred files each in
a suite of 1,300. Each edge's aims take turns by index, so the held-out 200
has every one:

- a salary whose twelfth ends in exactly half a cent, and pay per week, two
  weeks, half month or month, annualized exactly;
- hours spread exactly 10% of the high week, which is fixed, and a tenth of
  an hour more, which is trended; also guaranteed hours, spreads well inside
  the band and spreads well outside it;
- a year-to-date exactly 5% under the prior year, which is stable, and a cent
  under that, which is decreasing, with and without a stabilized run; also
  exactly level, which is stable, and a cent over, which is increasing;
- a decline under each formula: since stabilization for overtime,
  commission and tips (B3-3.3-02), year-to-date over the months elapsed for
  variable hours (B3-3.3-01), and no stabilization at all;
- 11 months of history against 12, and 23 against 24, on an application
  from April to August. At 12 the W-2 covers only part of the prior year,
  so the source is a stabilized decline, whose figure never reads it (see
  below);
- Social Security's share at the 15% default and documented at 14%, 15%,
  15.01% and above, with amounts where its two roundings differ from one;
  benefits on another's record ending on the continuance date, a day before
  it, or years after;
- child support whose 18th birthday is on the continuance date or a day
  before, a state extension that does or does not reach it, an extension
  that falls before the birthday (support runs to the later of the two), a
  29 February birth date against a 1 March line, five months of receipts, a
  late payment, and no decree;
- alimony and separate maintenance with no term, and with a term on the line
  or a day short;
- retirement balances of exactly 36 months of distributions, a cent short,
  and restricted access;
- public assistance ending on the line, a day short, never, and with no
  letter;
- rent with 365 Fair Rental Days or 364, 12 months' experience or 11,
  netting to the payment exactly, at a loss, and 75% of a rent that ends in
  half a cent, where rounding half up decides between nothing and a cent;
- households of two, totaled together;
- a retired borrower past 62 with Social Security, a retirement distribution
  or public assistance, and part-time work.

Year-to-date periods run through a month's end or its 15th, so the months
are whole or half, on every trended source. Each borrower has one paystub,
dated no more than 30 days before the application, as B3-3.2-01 requires of
the qualifying paystub, and every source of theirs with earnings reads it.

Every borrower is a household that could exist, and a test holds each rule
over a suite:

- work is drawn before the rest: one base job at most, part-time below 30
  hours, overtime only on a full-time job and tips only on a job, one
  stream of each kind of variable pay;
- one Social Security benefit a borrower. On their own record it is a
  retirement benefit from 62, or a disability benefit before 67 beside no
  earnings. Anyone else draws one on another's record, which has an end;
- a history of earnings begins no earlier than 16, a management record no
  earlier than 18. A parent is 16 to 55 at a child's birth, and support is
  received no longer than the child has lived;
- a retired borrower is past 62 and holds no full-time job. Public
  assistance sits beside no job paying over $50,000 a year. A borrower has
  at most one alimony or separate maintenance award.

**What v1 leaves out, and why.** Mapping the engine against its spec turned
up places where it departs from its own text. v1 does not grade a model on
any of them, because the grader would be teaching the defect. The task
cannot carry most of them. These are never drawn:

- a bonus, which the engine trends without annualizing;
- an annuity or pension, which it sends to the retirement-account test;
- the Average Hours method or a pay raise, which its dispatch drops;
- an ADU, temporary leave or an employment offer;
- a refinance, and non-subject, departing-residence or short-term rental;
- self-employment.

`incomeOutOfScope` runs on the engine's own results and keeps out the rest:

- hours not in tenths, a range without its average, and guaranteed hours
  beside a range;
- an hourly source where the engine's floating-point 10% test disagrees with
  exact arithmetic. At exactly 10% it reads 30 of the 80 whole high weeks
  from 1 to 80 as variable (33.3 to 37 is one), so the edge draws only from
  the high weeks where it is exact, and a test holds the engine's class to
  the exact one on every hourly source drawn;
- fixed hours with under a year of history, which the engine never reads;
- year-to-date months that are not whole or half on a paystub's own date;
- a borrower's earnings read from two paystubs, or from one dated after the
  application or more than 30 days before it (B3-3.2-01);
- a prior year with no earnings;
- a W-2 that covers part of the prior year, where the two readings of it
  disagree. R3 divides the prior year by 12 and averages over the
  year-to-date's months plus 12, whatever the history. The B3-3.3-02 text
  the spec quotes divides by the months the paystub and the W-2s include.
  So a source whose income began during the prior year is kept only when
  both readings give the same trend, and, from 12 months of history, only
  as a decline, whose figure never reads the prior year;
- 12 to 23 months of history without offsetting factors, which the engine
  pays in full;
- a stabilized run that does not fit the year;
- a trend the engine's decimals decide otherwise than exact arithmetic;
- Social Security on another's record with no end, or on the borrower's own
  with one;
- child support with no birth date, or with a decree term beside it;
- rent on a home the borrower lives in.

On 5,000 unfiltered training draws it rejects none, because the generator
aims around all of them.

Where the spec says two things, the rulebook says what the engine does, and
says it in words:

- Social Security's gross-up is two roundings: R6's formula, not the
  preamble's single rounding. On $1,000.10 it is $37.51, not $37.50;
- the 10% band for "minor variances" is the engine's constant, 10% exactly
  included; the spec names no figure;
- an end on the note date plus 36 months passes, as the spec's own gate row
  states it (`continuance_end_date ≥ note_date + 3 years`). T8's "born
  after" is read as on or after;
- an alimony award with no term has no defined end and passes;
- a 29 February birthday falls on 28 February.

docs/decisions.md has each departure, reproduced against the port.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and the spec's worked examples, eleven files to the
cent:

- R13's total of $9,246.43;
- examples A and B;
- T6's hours both ways;
- T7's Social Security;
- T8's two children;
- T9's three rentals;
- T13's part-time salary.

It redraws none of 600 first draws (none of 5,000 when last measured), and
agrees with the engine on 2,000 candidates nothing filtered (5,000 when last
measured). Its longest file is 21 tool calls in five turns across 5,000
training draws, well inside the episode's 80 turns even at one call a turn.

The rulebook and the tools a model is told are pinned by their hashes, and
a test states each of the engine's figures in the rulebook's words, built
from the engine's own constants: an edit to either fails until the version
and the pin move together. `env:audit` reads each source's figures as well
as the totals, so a source's monthly figure, nontaxable share, gross-up or
rental loss that no tool returned and the file does not state is flagged by
its source. Neither it nor `env:compare` has a verdict to group this
environment's files by yet; both show "?".

## lossmit-retention

lossmit-retention 1.0.0 is a servicing environment: one delinquent Fannie
Mae loan's complete loss-mitigation application, evaluated on the day it
became complete under Fannie Mae's workout hierarchy (Servicing Guide
F-2-10), as the servicing app evaluates it (its spec §12.2
complete-application evaluation, §12.4 forbearance, §12.5 repayment plan,
§12.6 payment deferral).

**The task.** It gives what the evaluator has that day:

- the evaluation date, the date the decision notice is provided, any
  foreclosure sale scheduled, and the state;
- the loan's origination and maturity dates, its P&I and escrow payment, its
  late charge, its oldest unpaid installment and the late charges unpaid;
- the borrower's hardship (temporary and unresolved, resolved, or
  permanent), the funds they have to reinstate, and the most they say they
  can pay a month;
- the months forborne so far, and any forbearance asked for;
- the workout history: months deferred before, the last deferral and
  disaster deferral, the last failed trial and modification;
- the deferral's escrow and servicing advances, the escrow shortage, and
  the partner's processing-month election;
- whether the Flex Modification evaluation found the loan eligible.
  flexmod-terms grades that evaluation; here it is an input.

The model works out the arrears and walks the hierarchy (reinstatement,
forbearance, a repayment plan, a payment deferral, Flex Modification) to the
option offered. Then it sets that option's terms:

- a forbearance term within its caps (three months at a time, twelve
  forborne, twelve delinquent), its dates, and whether it is a Reg X
  short-term forbearance;
- a repayment plan's term, searched over 1 to 12 months against 150% of
  PITI and the borrower's capacity, with its installments and percentage;
- a deferral's screen (seasoning, the delinquency window, a prior deferral
  within the year, maturity, conflicting arrangements, a recent trial or
  modification), the months deferred under the cumulative cap, the
  non-interest-bearing balance, the new payment, and the completion clock:
  the entry deadline, the reporting deadline a Fannie Mae business day
  before it, the effective date and the custodian's.

Every file also gets Reg X's tier, decision date, acceptance window, deemed
rejection and appeal rights.

**The grade.** A pass is every field right. Six groups are graded, each one
field: the arrears, the option offered, its terms, the deferral screen, the
deferral's clock, and Reg X's windows. The arrears, the offer and the
windows are graded on every task. The terms, the screen and the clock are
graded where the engine has them, and wherever an answer gives one the
engine does not. Answering a section that is not called for costs a field,
the same as leaving out one that is. A section neither has is not a field,
so a null that is right by default earns nothing. Nor does an eligible
screen: the submission may carry one only with the deferral offered, so it
would be the offer counted twice. The screen is a field only where a screen
failed, in the engine's answer or the model's.

The submission must also hang together, or it comes back as an error to
correct, the way a schema error does:

- the terms fit the option offered, and are null for reinstatement and Flex
  Modification;
- the screen is null where the walk stops before it, eligible under a
  deferral, and not eligible under Flex Modification;
- the clock is given exactly when the deferral is offered;
- capped_by names each cap once. Its order is put into the engine's order,
  not graded.

The floor to read the mean field score against is a shallow answer, and it
passes some tasks: on the held-out suite it scores 0.680 and passes 49 tasks
of 200. It gets the arrears (Step 1) and Reg X's windows (Step 8) right,
reads the offer off the funds and the hardship alone (reinstatement when the
funds cover the arrears, forbearance on a temporary hardship, Flex
Modification otherwise), and works out no terms, screen or clock. Its passes
are all 32 reinstatements and the 17 Flex Modifications on a permanent
hardship, where Steps 1, 2 and 8 are the whole evaluation. It passes none of
the 42 forbearances, 42 repayment plans, 45 deferrals or 22 Flex
Modifications reached past the screen.

The bench reports passes by class, and Flex Modification is two classes,
"on a permanent hardship" and "after the screen", so a score can be read
against the classes that need Steps 3 to 7. Two lower baselines:

- offering one option every time with nothing worked out scores 0.045 to
  0.056, whichever option it is;
- every date and count right and no money scores 0.515 and passes nothing.

**The grader is the servicing app's own engines.** `src/lossmit/ported/`
holds `evaluation.ts`, `plans.ts` and `deferral.ts` from
`apps/servicing/src/domain/lossmit/`, each byte for byte but for its kernel
import paths, held by a test. None imports a sibling. `ops.ts` is not
ported, because it imports the Flex Modification and liquidation engines and
the kernel's ledger. The servicing app has no orchestrator that turns a loan
into the walk's facts: `hierarchy.walk` takes five booleans and passes them
straight through. So the grader restates what it needs, each with the line
it comes from, and a test holds those lines:

- months delinquent: the installments due from the oldest unpaid one through
  the evaluation date, both included (12.6 rule 1);
- the arrears, with late charges, and the late charges a deferral waives;
- the walk's facts as 12.2 rule 2 composes them;
- the forbearance term's start on the 1st of the month after the evaluation
  (12.4-T1), through the service's term computation with no MBS cap and no
  repayment component, and its Reg X short-term test;
- the deferral's installments to pay and cumulative months after, as the
  offer records them, and its timeline with the partner's election;
- the tier and windows, from the complete date, the sale and the notice's
  date.

**The tools.** refi's date steps, whole months and exact calculator, and
payoff-statement's business-day step for the reporting deadline. No tool
walks the hierarchy, applies a cap, searches a repayment term, screens a
deferral or sets a window.

**The tasks** cycle by index through ten edges, a hundred files each in a
suite of 1,000. Within an edge, its arms are taken in turn too:

- reinstatement: funds at the arrears to the cent, a cent over, or more,
  under every hardship. The walk tests reinstatement first, a temporary
  hardship included;
- the other edges' files with funds exactly at the arrears or a cent short,
  so one cent moves the offer;
- a first forbearance term, sometimes near the delinquency cap;
- an extension at the cumulative cap, at the delinquency cap, at both (and
  the three-way tie at 3), a month under, and landing on six forborne
  payments or seven. Installments paid during the plan leave fewer
  delinquent than forborne, so the cumulative cap binds alone, or tied with
  the increment;
- a repayment plan at its capacity to the cent, at exactly 150% of PITI,
  past 150% only because the installment rounds up, a cent short of one
  term's total, and a month behind;
- a deferral at its boundaries: originated, deferred, modified or failed a
  trial exactly a year before, 37 months from maturity, and a disaster
  deferral inside the year, which never counts. The file modified a year
  before is two installments behind, so its 60 days fell on the
  modification's first anniversary. The trial failed on a month's last
  day, so the evaluation a year later is one too;
- the contractual payment at six months and at the cumulative cap, a
  processing month, and a reporting deadline that steps back over a weekend
  or holiday;
- the screen failing on the delinquency window, a prior deferral within the
  year, or maturity, alone and before a later failure;
- a permanent hardship, and capacity a cent short of the twelve-month plan.

Reg X's windows vary on every file. About four files in five have no sale.
Sales fall at 90, 89 and 38 days, New York gets its 30 days, and acceptance
dates land on weekends and holidays and stay there. New York's 30 days are
drawn only at ge_90, because v1 puts no sale in New York. So a test holds
the lt_90 branch, where New York's window is Reg X's 7 days, and no task
grades it. On the held-out 200, reinstatement is offered 32 times,
forbearance 42, a repayment plan 42, a deferral 45 and Flex Modification 39
(17 on a permanent hardship, 22 after the screen).

**What v1 leaves out, and why.** Reading the engines against their spec
turned up places where they compute a figure the spec calls wrong.
docs/decisions.md has each, reproduced. v1 does not grade a model on those,
because the grader would be teaching the defect.

- **Liquidation.** When every retention option fails, the walk offers a
  short sale with no eligibility test (D5). So Flex Modification is eligible
  on every file, and the walk never runs past it.
- **Files the Flex Modification would refuse.** Its own criteria (12.8) bar
  a loan under a year old, one with a conflicting arrangement, one with a
  failed trial or a modification in the last year, and one whose
  modification went 60 days delinquent in its first year without
  reinstatement. The last modification of a Fannie Mae loan in these years
  is a Flex Modification, and an unpaid installment was never reinstated, so
  the guard bars a file whose delinquency reached 60 days before its last
  modification's first anniversary. The first three bars match three of the
  deferral screen's own tests. A file the screen fails on any of them goes
  on to the liquidation options, which the walk offers with no test. v1
  draws none, so the reason codes it grades are the delinquency window, a
  prior deferral and maturity. The other three stay in the rulebook and
  never decide a v1 answer. A file at the Flex Modification rung is also 60
  days delinquent. Section 12 counts that in months delinquent, the
  installments due through the day, so it means two installments or more.
- **The reporting deadline from 2026-11-30.** The engine steps the
  deferral's reporting deadline back over the federal calendar, to Friday
  2026-11-27. Spec 5.1 owns that deadline and says Fannie Mae-only holidays,
  such as the day after Thanksgiving, shift reporting deadlines, which puts
  it on 11-25. Sections 19.1-T6 and 19.3 count the 27th as a business day,
  and the servicing app's audit report lists the contradiction for the spec
  owner to settle. v1 enters no deferral by 2026-11-30, so 12.6-T3's
  evaluation on 2026-11-01 is held as an engine example, not a task.
- **The disaster deferral and the D1-3-01 order.** The walk has no disaster
  rows (D8).
- **Imminent default (11.5).** Its inputs are scores, payment history,
  housing expense and income, and it carries defects of its own. It belongs
  in a sibling environment.
- **Flex Modification's terms**, which flexmod-terms grades; the 12.1
  acknowledgment and 12.3 appeal clocks; the deferral's ledger split; the
  filter on escrow advances (given already filtered, since no engine line
  does it); notices.

`lossmitInScope` runs on the engine's own outputs and keeps out:

- a deferral of no months or one, which the screen calls eligible past the
  cumulative cap (D1), and a cap that leaves more than one installment to
  pay, where 12.6-T4 and rule 4 name one contractual payment;
- a forbearance of no months, which the walk offers on the hardship alone
  and the servicing app's own term creation refuses;
- a decision date that is not a business day. The spec's timer row moves a
  day 30 on a weekend back to the business day before, as policy; the
  engine never moves it (D7);
- a sale 37 days away or less, where Reg X has no (c)(1) duty and the engine
  still sets 7 days;
- exactly 36 months to maturity, where the spec's gate rows ("maturity >36")
  and the engine (36 passes) disagree;
- a borrower at the screen who cannot make the deferral's new payment.
  Criterion 2 requires it, and the screen never tests it;
- a processing month elected on or before the 15th, which the engine
  refuses;
- a deferral entered by 2026-11-30, whose reporting deadline the spec
  disputes (above).

It also keeps the facts coherent:

- a sale only from day 122 of the delinquency. Reg X allows no first notice
  before day 121 (1024.41(f)(1), counted as 13.1 counts it) and none once
  the complete application is in ((f)(2)). There is no forbearance plan
  running, and the sale is never in New York, whose courts take years;
- an extension decided in the active term's last month, so the new term
  starts the day after the old one ends;
- workout dates no later than the oldest unpaid installment;
- a workout history the loan could have had. A payment deferral takes
  effect 13 months after origination at the earliest (12.6 criterion 5),
  and a later one 13 months after the last (criterion 7). More than six
  months deferred means two deferrals. A modification takes effect 16
  months after origination at the earliest (12.8's year, then its trial). A
  failed trial is on a month's last day, 13 months after origination at the
  earliest. No deferral comes within 13 months after a modification or a
  failed trial, and no modification within 16 after a failed trial, since
  each evaluation would have refused it. Each deferral and modification has
  a day of its own.

On 40,000 unfiltered training draws it rejects none, because the generator
aims around all of them. It is a guard, not a filter.

Where engine and spec disagree inside that scope, the rulebook says what the
engine does:

- **A processing month is the partner's election** (D6), as 12.6's open
  question 2 and the engine have it. 12.6-T5 reads as if it were automatic
  after the 15th. A file evaluated after the 15th with no election has none.
  12.6's own worked example is one: evaluated on the 20th, entered by the
  30th.
- **The walk offers reinstatement whenever the funds cover the arrears**,
  as 12.2 rule 2 says, on a temporary hardship too, where 12.4's pre-expiry
  screen would offer it only on a resolved one.
- **The cumulative cap sums the forborne months.** v1 draws consecutive
  terms, so the sum never differs from the months since the initial plan
  started. On most extensions every forborne installment is still unpaid,
  so the cumulative cap is never under the delinquency cap and binds only
  tied with it. One arm draws installments paid during the plan, as 12.4
  rule 1 applies reduced payments once a full installment accrues. There
  the cumulative cap is the smaller, and binds alone.

The rest do not reach v1: two names for one tier (`lt_90` in
`evaluation.ts`, `gt_37` in `application.ts`; evaluation's is graded),
mislabeled disaster reason codes, and 12.6's worked example giving 348
months to maturity where its own loan has 300. The worked example here
carries 300, and either passes.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and 14 spec cases to the cent, through the tools
alone:

- 12.6's worked example: NIB $7,370.68, $252.00 waived, $2,131.17 a month,
  entry by 09-30, reporting by 09-29, effective 10-01, custodian 10-26, and
  12.6-T7's acceptance by 10-16 and deemed rejection on 10-21;
- 12.6-T2 at 6 and 7 months, T3's deferral within the year and its
  disaster deferral, and T4's 9 + 4;
- 12.5's plan, $6,426.00 over 8 months at $803.25 and 138.25%, and the same
  file at $2,500.00 a month, which goes to a 3-month deferral;
- 12.2 rule 7's dates (11-06, 11-16, 11-21; New York 12-02) and 12.2-T2's
  sale 75 days out (7 days, no appeal), on a permanent hardship so the walk
  stops at Flex Modification;
- 12.4's four terms, the fourth one month to 2027-07-31 with the exception
  required.

12.6-T2's one month, T3's evaluation exactly a year on and T5's processing
month are held as engine examples, not tasks, because none is a v1 file. A
resolved borrower one month behind reaches Flex Modification, which needs 60
days. T3's evaluation on 2026-11-01 enters its deferral by 2026-11-30. T5's
decision date falls on a Sunday.

The reference redraws none of 600 first draws and agrees with the engine on
2,000 candidates nothing filtered (40,000 when last measured). Its longest
task is 34 tool calls in 10 turns across 5,000 training draws, well inside
the episode's 80 turns at one call a turn.

## metro2-furnishing

metro2-furnishing 1.0.0 grades credit reporting: one loan's monthly Metro 2
Base records for three to six consecutive month-ends, the way the servicing
app furnishes them (its spec §8.1).

**The task.** It gives what the servicer holds:

- the reporting policy: truncate or round to whole dollars, the forbearance
  freeze or contractual aging, original or remaining terms;
- the note: date, amount, term, rate, P&I and escrow;
- the consumers on the loan, with their position, address, liability and
  flags (released, deceased, never liable, a successor in interest);
- the installments from a few months before the first month, and every
  receipt from the first of them through the last month's end;
- the last record furnished before the first month: ours, a prior
  servicer's hand-off (its PHP sometimes shorter than 24), or none;
- for each month, its books (balance, deferred and forborne principal, term
  left, maturity, the Fannie Mae loan number and the MIN) and what is in
  force at its end: a forbearance, repayment or trial plan, a modification
  or payment deferral, a foreclosure referral, or the loan's closing (a
  payoff with its funds, a short sale, a foreclosure sale, a deed in lieu).

The model applies the receipts to the installments oldest first, as the
FIFO ledger does, and for each month in order finds the days past due, the
account status, the amount past due and the date of first delinquency,
carries the payment history profile from the record before, applies the
condition matrix (the forbearance's entry figures under the freeze, a
repayment plan's arrears, CO and K4 for a modification, K4 for a deferral, a
closing's payment rating at its date), and validates the record. A record
with a hard error is not furnished, and the next month's PHP shows D for it.
Last, it reports the consumers' segments and ECOA codes.

**The grade.** A pass is every field right. A furnished month is seven
fields, each standing or falling whole, so fields that are constant on most
months ride with the one that decides them:

- status: account status, payment rating and date closed;
- amount past due;
- date of first delinquency;
- payment history profile, graded against the engine's own chain. A wrong
  status, or a month furnished that should be omitted (or the reverse), sits
  in every later month's PHP in the window, one position deeper each month,
  and costs each of them, as it would at the bureaus: an error in the first
  of six months costs five later PHPs, one in the last costs none;
- special comment;
- terms and balance: current balance, scheduled payment, terms duration and
  K4. On a closing month the scheduled payment is not graded (below);
- payments: actual payment and date of last payment.

A month the engine omits is the same seven fields, each right only when the
answer omits it with the same hard errors, so furnishing a month that should
be omitted costs what omitting one that should be furnished does. The last
furnished month's consumer segments are one field, in any order. A month
answered that the task does not have is a field of its own.

An answer that answers nothing (every month current, nothing past due, 24
B's) scores about 0.23 on the held-out suite. One that repeats the last
record every month and reads the balance, payment and terms off the books
scores about 0.40. The floor to read the mean field score against is
higher, about 0.65. That is what an answer scores that never applies a
receipt and never counts a day: it takes every month-end as current and
reads everything else off the task by the rulebook (the special comment,
the balance, payment, terms and K4, the month's receipts, the identifiers,
the PHP carried with D, and the consumers' segments). It passes none of the
200, because every window has a month-end whose ledger decides a graded
field. A test holds that, and the same on 600 training draws. The mean
field score never replaces the pass.

DeepSeek-V4.1-Flash's held-out baseline (thinking, 16,000 output tokens a
turn) is 136 of 200 (68.0 %), corrected on 26 October from 133 when the three
turns the endpoint cut were run again (docs/decisions.md, "DeepSeek's held-out
baselines on the newest suites, and two corrected").

**The grader is the servicing app's own engine.** `src/metro2/ported/` holds
`metro2.ts` and `types.ts` from
`apps/servicing/src/domain/credit-reporting/`, each byte for byte but for
its import statements. metro2.ts's import from types.ts spans four lines,
and the test joins each statement before it compares. The FIFO ledger both
import is `boarding/delinquency.ts`, already ported for pmi-termination, so
the port names `../../pmi/ported/delinquency.js` rather than keeping a second
copy. The servicing app's one caller of the engine fixes no convention for a
condition, a prior record or a month-end's ledger, so the grader restates the
ones the servicing app keeps elsewhere, each with its line:

- a month-end's ledger is FIFO over the receipts received on or before it, as
  early-intervention's delinquency snapshot builds it;
- a record that fails validation is omitted, and the next month carries it
  with D for its month (the cycle builder and `phpAfterOmission`);
- the actual payment is the receipts dated in the month and the date of last
  payment the latest receipt, both on or before the month-end. A borrower's
  payoff funds count in both, but never enter the ledger;
- a forbearance's entry status and amount past due are the ledger's on the
  day before the plan takes effect: 78 and $7,378.65 for the spec's plan
  effective 05-01;
- a last record's PHP shorter than 24 is padded with B, as a hand-off is;
- a short sale's foreclosure had started when a referral is in force at its
  month-end. v1 never dates one after the closing date, and the guard
  refuses one that is.

**The tools.** refi's `date_add`, `days_between`, `end_of_month` and
`calculate`, and nothing else. The balances are the servicer's books, so no
amortization tool is given. No tool applies a receipt, counts days into a
status, carries a PHP, formats a field or validates a record: each of those
is graded.

**The tasks** cycle by index through twelve edges, a hundred windows each in
a suite of 1,200:

- buckets: a borrower who stops paying, pays one installment a month two or
  three behind, or pays part of one, walking the month-ends across 29/30,
  59/60 (February 2028 included: 59 days at a month-end needs a leap
  February), 89/90, 119/120 and 149/150 days;
- dofd: the date of first delinquency set, kept through a partial catch-up
  that leaves 30 days or more, and reset by a cure and a new delinquency;
- pool: a part payment waiting in the pool and completed after the
  month-end, a prepayment, a double payment, an overpayment that builds up,
  an installment paid in two halves, each with a month-end that finds an
  installment unpaid;
- forbearance: entered current, at 1 to 29 days or at 30 to 149, under the
  freeze and under contractual aging, payments suspended or reduced, ending
  with the window, a reinstatement or a payment deferral of 2 to 6
  installments (8.1-T4 and T5, 12.6). Entered current under the freeze,
  the window opens two months before the plan, the first of them paid a few
  days late;
- repayment_plan: one that repays the arrears in two to six months, still
  running at a month-end in the window, and one paying less than the
  installment (AC), each sometimes under a referral (BO), which the cure
  ends;
- trial: a three-month trial plan (AC, aging) offered 60 days or more
  behind, sometimes under a referral, then a modification or a trial failed
  by a payment missed (12.8);
- workout: a payment deferral (K4) of 2 to 6 installments, evaluated at the
  month-end before it, the month's installment paid first when six are
  behind (12.6 rule 4); or a modification (480 or 360 months, with forborne
  principal and K4, or without) after its three-month trial, in the window
  or begun before it. Either ends a referral made before it;
- foreclosure: a referral, then a foreclosure sale (at 179 or 180 days
  every other time) or a deed in lieu (each side of a bucket's edge in
  turn), with and without a deficiency;
- closing: a payoff current at its date, a payoff of a delinquent loan (by
  refinance or not), a short sale with no foreclosure started (13) and one
  after a referral (65), each rated at the closing date on each side of a
  bucket's edge in turn;
- boarding: a prior servicer's hand-off, full or short, and a loan boarded
  with no history, each current or past due;
- identifiers: a month whose MIN is missing, 17 or 19 digits, or holds a
  letter, or whose Fannie Mae number is not 10 digits, omitted, with D next;
- consumers: joint borrowers at the same address and another, a guarantor
  (5), a released borrower (T and H), a deceased one (X), one never liable
  (Z), and a successor who is not furnished. The flags come only in the
  combinations 8.1 rule 5 allows: a successor carries no other, a released
  borrower was never never-liable, and the base is always liable.

A window for an edge about something else, which would be current
throughout, is paid on time but once, a few days after a month's end. Receipts land now and then
on a month's last day, which that month-end's ledger holds, and on the 1st
after it; a forbearance entered three behind sometimes has one installment
caught up on the plan's eve, which its entry figures count. A workout's
loan is twelve months seasoned at its evaluation (12.6, 12.8), and a
foreclosure referral is in force only while the delinquency it was made on
continues (13.3).

Every task also draws the policy, and one in four an installment ending in 50
or 49 cents, which rounding turns on. The spec's worked example and test
cases are 17 spec tasks on its loan SM-1001: January to April (8.1-T1, T2),
the forbearance under the freeze and its Payment Deferral (T3, T4), the same
months under contractual aging, the reinstatement (T5), a Flex Modification
after a trial (T6), the short sale with and without a referral (T7), the
foreclosure sale, deed in lieu (with and without a deficiency) and payoff
(T8), a hand-off and no hand-off (T15), the successor and released borrower
(T16), January to April rounded (T19), 8.2 rule 10's corrected variant, and
a malformed MIN omitted with D after it (T9).

**What v1 leaves out, and why.** Mapping the engine against its spec turned
up places where it furnishes what its spec calls wrong. v1 does not grade a
model on any of them. `metro2InScope` runs on the engine's own outputs, and
the generator aims around every one, so on 12,000 unfiltered draws it rejects
none. It keeps out:

- a modification or deferral carried into a month whose new installments
  are 30 days unpaid: the engine reports 11 and nothing past due in every
  month the condition is carried. Workouts come only in the window's last
  month, their first payment made;
- a month with contractual status after a forbearance month, with an
  installment unpaid at its end: the spec resumes aging from the frozen
  status (78 to 80), and the engine reads the ledger (84 at 211 days);
- a date of first delinquency that is not the due date that began the
  delinquency running: the engine blanks the DOFD at a month of 1 to 29 days
  and re-anchors it later, against rule 3. The generator keeps a delinquency
  at two installments or more once it has a DOFD;
- a receipt on or after a closing date, and closing funds in the ledger: the
  engine reads the payment rating off the ledger, so funds in it rate a loan
  134 days late as current;
- a closing current at its date with an installment unpaid at the month-end,
  which the engine furnishes as 13 with a DOFD;
- a hard error no input can satisfy: a freeze at 30 days or more whose
  arrears are then paid, and a deed in lieu or foreclosure sale with nothing
  unpaid (DOFD_REQUIRED). Only a missing or malformed identifier omits a
  record;
- a foreclosure referral in force once the delinquency it was made on has
  ended, by a cure or a workout. The engine reports BO whenever it is handed
  a referral, so a completed deferral or a reinstated loan would be 11 with
  nothing past due and BO, where 8.1 rule 7 gives a deferral a blank comment
  and 13.3 closes a reinstated or worked-out foreclosure. The generator ends
  the referral there, and the guard refuses one in force after a cure,
  beside a workout, or dated after a closing;
- a zero balance before a closing: the engine never furnishes E;
- a disaster case, a charge-off (97) and a transfer out (05). With a disaster
  case the engine's trial reports AC where the spec's precedence gives AW; the
  spec says nothing of a 05 record's balance or a 97's.

A closing's scheduled payment is not graded: the engine keeps the PITI there,
and the spec says only that the balances are 0. Two choices the spec leaves
open are stated in the rulebook rather than left out. The engine uses the
optional codes AS (a payoff by refinance) and H (a released borrower's
segment), which 8.1-Q10 leaves off until confirmed. The servicing app's own
8.1-T16 test asserts T and H, and the rulebook says this servicer furnishes
both. And a loan boarded past due is a debt collector's (11.4), which 8.1's
Reg F gate (8.1-T17, 8.3 rule 8) holds back until a live contact or a
validation notice plus 14 days. The task carries no contact facts, so the
rulebook states the gate open: the notice went with the hello letter, as
11.4 sends it, more than 14 days before the first month's end, and none came
back.

The §8.3 and §14.4 overlays (the notice-of-error bar, bankruptcy, SCRA,
disaster, deceased) are not in 1.0.0: reproducing them found the bar furnishing a more adverse status than
the freeze, the confirmed Chapter 13 plan reading a FIFO ledger its overlay
does not reset, and the SCRA stay leaving a DOFD on a frozen 11.
docs/decisions.md has each departure, reproduced.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and the 17 spec tasks to the character, with no task
redrawn in 600, and agrees with the engine on 2,000 candidates nothing
filtered (12,000 when last measured, all in scope). Its longest window is 42
tool calls, the submission included, across those 12,000 draws (34 on the
held-out suite), well inside the episode's 80 turns. Step 1 says which ledger steps are reading: a
receipt into an empty pool, and a pool below or exactly one installment.

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

## ei-clocks

ei-clocks 1.0.0 grades early intervention: where every clock on one
delinquent loan stands on one day, the way the servicing app's windows
engine keeps them (its spec §11.1 live contact and §11.2 written notice,
Regulation X §1024.39), with the three duties that run beside them: the
assigned contact under §1024.40 (§4.3), Fannie Mae's outbound cadence under
D2-2-02 (§11.1) and, for a debt collector, Regulation F's call cap (§11.1
rule 9).

**The task.** It gives the loan as the early-intervention desk has it at the
end of `as_of`:

- whether it is the borrower's principal residence, and whether the servicer
  is a debt collector for it;
- the installments due on the 1st, each with the day it was credited in full
  (payments go to the oldest first), or none;
- every contact and attempt in order: the channel (AI or human voice, a
  text, an email, a letter, the borrower calling in), the person (the
  borrower or the co-borrower), the outcome, and whether the person asked
  for the call;
- the written early-intervention notices provided, each with its variant;
- the days personnel were assigned;
- a bankruptcy's petition and discharge, and a written FDCPA cease.

The model opens a window for every installment unpaid the day after it fell
due and says, for each, the live-contact deadline (day 36) and whether it was
met, met late, breached, canceled by payment or exempt, and the written
notice's deadline (day 45) and whether it was sent (late or not), covered by
a notice within 180 days, canceled by payment, owed or exempt. Then each
notice's cycle (superseded, running, or reviewed at day 180 with the repeat
due then or moved to a window), the once-per-case bankruptcy notice, and for
each delinquency its assigned-contact deadline, its outbound cadence's
deadlines and the ones missed, and the Reg F call count.

**The grade.** A pass is every field right. Each window is two fields, its
live leg and its notice leg, each with its deadline, its status and whether
it was met late. Each notice's cycle is one field, and so are the
bankruptcy notice, Reg F and the day count. Each delinquency is two fields,
its assignment and its cadence. The lists of windows and of delinquencies are
a field each. A window, a cycle or a delinquency answered that the loan does
not have is a field of its own, and a section neither the engine nor the
answer has is not a field, so hedging is never cheaper than committing. The
submission must hang together or it comes back as an error to correct: a
late flag only on a breached live leg or a sent notice, a repeat only on a
cycle that required one, an assignment deadline exactly when one is owed.

On the held-out suite an answer that answers nothing scores 0.013. The
floor to read the mean field score against is 0.580: every deadline right,
the delinquencies and the cycles' ends right, and every status read off the
date alone (breached once its deadline has passed, open before). It passes
17 of 200, loans where nothing happened in time. A test holds both.

DeepSeek-V4.1-Flash's held-out baseline (thinking, 16,000 output tokens a
turn) is 190 of 200 (95.0 %), corrected on 26 October from 188 when the two
turns the endpoint cut were run again (docs/decisions.md, "DeepSeek's held-out
baselines on the newest suites, and two corrected").

**The grader is the servicing app's own engine.** `src/ei/ported/windows.ts`
is `apps/servicing/src/domain/early-intervention/windows.ts` byte for byte
but for its three kernel import lines, held by a test that rewrites the
original's imports and compares. It imports no sibling.

The servicing app has no fold that runs this engine over a loan's history.
The runtime's counter projection writes the windows table without calling
it, and its unit of work and counter job drop two of the engine's inputs;
those are ei-1, ei-2 and ei-3 in `docs/servicing-engine-defects.md`. So the
grader folds the engine day by day as §11.1's and §11.2's state machines run
it, and grades the spec's reading:

- each day starts with the engine's `sweep`, and window D opens on D + 1
  before anything else that day, through `openWindow` with the overlays that
  stand before it and the latest notice's cycle (11.1 rule 1, ops.ts:76);
- an installment credited on or before a leg's deadline cancels it
  (`installmentPaid`), later leaves the duty standing (11.1 rule 1);
- a live contact satisfies only the open legs whose window contains its day
  (`applyContact`, 11.1-T4);
- a petition and a cease move what `applyBankruptcyPetition` and
  `applyFdcpaCease` move. The engine has no step for a discharge, so the
  grader makes every leg still waiting on the case's notice
  `exempt_discharge` there, as 11.2's state machine does and 11.2-T7 ("no
  notice is ever due") requires, and the discharge decides how later
  windows open;
- a notice provided is the notice for every leg breached or waiting on the
  bankruptcy notice, and for the oldest open leg (`noticeProvided`); every
  other open leg is inside the cycle it starts, `satisfied_by_prior_180`, as
  `openWindow` marks a window opened inside a cycle (windows.ts:74). That is
  11.2-T3's answer: the Dec 14 notice covers the Dec 1 window, which opened
  on Dec 2;
- each notice's cycle is `noticeCycle`, and one that runs to its end is
  reviewed there by `cycleEndReview` with that day's §1024.31 count, from the
  boarding FIFO pmi-termination already ports;
- a breached live leg met by a later live contact is late, as the timer
  engine marks the clock `satisfied_late` (kernel/timers/engine.ts:172).

The duties beside the engine are restated in the grader with the lines they
come from, and a test holds each line to the servicing app's source:

- the assignment: by the day the first notice of the delinquency is
  provided when that comes first, and in any event by day 45
  (`assignmentTrigger`, servicing-requests/ops.ts:178-182;
  `assignmentDue`, continuity.ts:4). A delinquency cured by then owes none;
- the cadence: open from day 17 (plan.ts:16), a first attempt by day 36 and
  then every 7 days, each deadline moved to the servicer's next open day
  (plan.ts:17, :64, :95), every outbound attempt but a letter counting
  (plan.ts:191), ended by the cure (plan.ts:151-155) and suspended for good
  by a petition or a cease (plan.ts:179-181). A deadline is missed when the
  cadence was still running at its end, the timer rows' reading;
- the call cap: outbound voice calls that connected and that the person did
  not ask for (ops.ts:222, section11.ts:328), per person, more than 7 in the
  seven days ending on a call's day (ops.ts:224-231, evaluator-kit.ts:24).

A further test holds every deadline the grader computes to its row in
`apps/servicing/spec/registry/timers.json`: the live contact at +36, the
notice at +45, the repeat at +180 and the FDCPA variant's at +190, the
bankruptcy notice at +45 from the petition or the delinquency, the
assignment at day-1 + 44, the cadence's day 36 and +7 on the next open day,
and the cap of 7 in a trailing 7 days.

**The tools.** refi's `date_add` and `days_between`, and payments-posting's
`next_business_day` on the servicer's calendar. No tool opens a window,
decides a leg, reviews a cycle, finds a delinquency or counts a call.

**The tasks** cycle by index through fourteen edges, a hundred loans each in
a suite of 1,400, each edge's arms in turn:

- a live contact on day 36, day 37, early, or never;
- one contact on the next due date (the older window only), on day 36 (both)
  or day 37 (the newer one, the older late), 11.1-T4's overlap;
- the installment credited on day 36, day 37 or early; on day 45 or day 46
  with no notice;
- the notice on day 45, day 46, day 30 (covering the next window) or never;
- a window whose day 45 is the notice's day 180, or a day past it;
- a cycle reviewed at 45 days or more with the repeat on its day, late or
  missing, under 45 days with the duty moved to its window, and current;
- a petition while delinquent with the bankruptcy notice on time, late or
  missing; a petition while current, the notice owed from the first due date
  missed, or not yet; a cease before it; a discharge after the notice;
- a debt collector's cease mid-window and before the delinquency, and an
  fdcpa notice's 190 days reaching a window's day 45 or a day short;
- a property that is not the borrower's residence;
- each installment paid on the next due date (11.1-T3) or before day 36;
- personnel assigned on day 45 or 46, by a notice on day 30 or the day
  after, never, and a cure on day 45 or 46;
- a cadence gap of 7 days or 8, a deadline on a weekend or holiday met on
  the next open day or the day after it, a first attempt on day 36 or 37;
- seven counted calls in seven days, eight, nine, and eight over eight days,
  among a dropped line, a text, the co-borrower's calls and a call asked
  for.

Around each edge sits an ordinary servicer: attempts every four to seven
days from day 17 with a conversation in most windows, a notice mailed
between day 38 and day 44, personnel assigned in time about nine times in
ten. On the held-out suite 117 loans are breached somewhere, 50 owe something
not yet due and 33 are clear; every status the grader can give turns up there
but the bankruptcy notice not yet owed, which training has.

**What v1 leaves out, and why.** Reading the engine and the runtime around
it against the spec found places where an answer would turn on a reading
the spec does not settle, or where the engine computes what the spec calls
wrong. docs/decisions.md has each, reproduced. v1 does not draw them, and
`eiScopeIssues` names each clause a loan breaks:

- two of a credit, a live contact, a notice, the petition, the discharge
  and the cease on one day, whose order would decide a leg; and a notice,
  petition or discharge on a window's opening day;
- an installment credited the day after it fell due. The counter opens its
  window and starts a delinquency that day (ops.ts:76, :79), and the day's
  end shows none;
- a cease after the petition. The engine leaves the leg waiting on the
  bankruptcy notice, where §1024.39(c)(1)(ii) and (d)(2) exempt it;
- a window opened in a bankruptcy case after its one notice. `openWindow`
  opens it waiting on the notice again (windows.ts:71), and the case's
  notice is once per case;
- a window opened inside a notice's cycle after a cure. 11.2's state machine
  closes a cycle when the delinquency ends; §1024.39(b)(1) excuses a second
  notice within 180 days whatever came between;
- an installment credited after a review that moved the duty to a window.
  11.2 rule 3 recomputes that date each night as installments are paid, and
  11.2's state machine closes the cycle when the delinquency ends; the
  answer reads it on the review day;
- a cycle reviewed after a petition, after a cease inside it (11.2 moves the
  running cycle to 190 days, which the engine is never handed), or with a
  credit on its review day; and an fdcpa cycle that reviews differently at
  day 180, where §1024.39(d)(3)(iii) tests the delinquency, and at day 190,
  where `cycleEndReview` does. No generated cycle reaches either;
- a delinquency that closes on its start deadline with no attempt, where the
  timer and `fnmaCadenceBreaches`'s `end >= startDue` (plan.ts:193) part;
- any contact after a petition or a cease, an outbound attempt outside a
  cadence, a credit after a petition, and a discharge before the bankruptcy
  notice was due;
- on a debt collector's loan, a counted call in the seven days after a
  conversation with that person (§1006.14(b)(2)(ii), 11.1-T14), which v1
  does not grade.

Not in 1.0.0: the good-faith determination (11.1 rule 6, whose policy
minimum reads numbers and dayparts), ongoing loss-mitigation contact, the
transferee rule and boarding, a dismissal and its resumed windows, a
post-petition payment after a discharge, the cadence's cessation on a
promise to pay or a workout request (`FNMA_D2202_CESSATION_ON_QRPC`; a
conversation here carries no commitment, so the cadence runs on), the
pre-sale stop, TCPA, quiet hours, the post-conversation gate, and the
content of a notice. On 10,000 unfiltered training draws the guard rejects
none, because the generator aims around all of it. It is a guard, not a
filter.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and nineteen spec cases: 11.1 rules 3 and 10 and
T1, T2, T3, T4, T8, T13, T15 and T22, 11.2 rules 3 and 5 and T2 to T7 and
T13, and 4.3-T1 and T2, each held to the spec's own dates (12-07 and 12-16,
2027-06-12, 07-16, 06-22, 03-06, 11-27, 10-16) and 11.1-T13's running counts
of 1, 2, 2, 2, 3, 4 and 1. Every held-out loan is its index's first draw, none
of 600 training draws is redrawn, and the reference agrees with the grader
on 2,000 candidates nothing filtered (10,000 when last measured). Its longest
loan is 51 tool calls, the submission included, in 4 turns across 5,000
training draws, well inside the episode's 80 turns at one call a turn.

## catchup-posting

catchup-posting 1.0.0 is drawn from the life generator, and is one of the
first demo's graded moments. A borrower who missed
an installment sends money to catch up. The note caps a late charge in
dollars, and the servicing system may have boarded the loan without the cap
(D-03, docs/synthetic-data-defects.md).

**The task.** One receipt, and the loan as the system shows it on the day the
receipt arrives, after that morning's late-charge run:

- the note's late-charge terms (percent, grace, the dollar cap or none), and
  beside them the terms the system boarded and charges with;
- the cash state: the balance, the installment it is paid through, suspense,
  the late charges the system says are due, and the installments of the last
  two to three years and the next one;
- every late charge since the first payment, with the P&I it was charged on
  and what was collected on it;
- the last twelve months of payments, each with where it went, and the last
  twelve month-ends.

The model holds every charge to the note, posts the receipt, states the
refund due and says whether the loan is current after posting.

**The rules.** Step 1 is D-03's correction. Each charge is held to
`lateChargeAmount(P&I, the note's percent, the note's cap)`. What is still
owed on it falls to that amount, and what was collected above it is owed
back to the borrower: that sum is the refund due. Steps 2 to 5 are
cashiering's waterfall on the corrected balance. The installments are paid
whole, oldest first, at the rate in force; what is left goes to the late
charges, and the rest to suspense. A twin's borrower sends what the system
billed, so a catch-up there leaves exactly the excess of the open charges
over the cap in suspense. It is held as the engine holds any remainder, and
the refund due is what was already collected above the cap.

**The grade.** A pass is every field right. There are nine fields:

- the installments applied, each with its split (one list);
- the late charge paid and what went to suspense;
- every charge held to the note (one list), and the refund due;
- the late charges still due, the balance, the installment the loan is paid
  through, and whether it is current.

The paid-through date is graded rather than the next due date. The history
projects one installment ahead, and an early catch-up prepays it.

**The grader is the servicing app's own engine.** `lateChargeAmount` and
`allocate` are the ports payments-posting holds byte for byte
(`src/payments/ported`). They run on the task's state with every charge
held to the note: received and credited the same day, designation
unspecified, no instruction.

**The tasks** are drawn from a decade the life generator runs for one loan,
and its D-03 twin where the arm calls for it. The moment is the first
catch-up after a scripted missed installment, and the task is read off that
moment (`LifeMoment`). The arm cycles by index through seven, one for each
verdict the runner tallies and two for the commonest, so every verdict is
14 % of a suite or more:

- `breached`: the twin, meeting its first charge above the cap. The loan was
  boarded by transfer three to ten months before the miss, so nothing was
  collected above the cap before;
- `breached_refund`: the twin, after charges already collected above it;
- `breached_behind` and `breached_refund_behind`: the same two, the borrower
  paying only the oldest installment;
- `within_capped`, `within_uncapped` and `within_behind`: the clean history,
  with the cap boarded and holding a charge down, with no cap that binds,
  and paying only the oldest installment (on a note with no cap three times
  in ten).

A draw that does not land on its arm is drawn again under the next key: 125
of the held-out suite's 200 are first draws. The suite holds:

- 116 tasks above the cap, 58 of them current after posting and 58 still
  behind, and 84 within the note;
- 58 tasks with a refund due (a median near $240), 58 that send something
  to suspense, and 33 that prepay an installment;
- 79 loans boarded by transfer, and 39 notes with no cap;
- up to 19 charges on a loan (5.0 on average), and catch-ups of up to seven
  installments, from March 2027 to August 2035.

Every figure here is the suite drawn on life 1.2.0, whose histories charge
an installment in the 60 days after a transfer as the spec does: only a
payment the prior servicer received on time is spared (below, "The life
generator").

**Out of scope.** The receipts stay on the pay-in-full route, where every
installment the money reaches is paid whole. They stay off the
partial-payment paths that carry logged engine defects
(docs/servicing-engine-defects.md):

- no receipt pools suspense (cashiering-4's balance, and cashiering-7's
  accumulation);
- none is short of the oldest installment (the $50 rule, cashiering-10, and
  the partial hold);
- none leaves money for late charges while an installment due is unpaid
  (cashiering-7);
- no loan carries a hold, a trial or a plan (cashiering-13).

The history before the moment is held to the same. No receipt in it paid
late charges ahead of the arrears or out of accumulated suspense, and no
late-charge run in it excused an installment on suspense that another
unpaid installment also had a claim on. No loan pays off, and every
installment a receipt pays is charged one rate: a payment across an ARM
change is posted in two calls.

**The proof of fairness.** The reference passes the held-out suite, a
300-task training suite and five spec cases on §2.1's fixture L-1 and §2.7's
example K:

- K caught up on 2026-10-05: September at example A's split, October at
  $1,351.71 interest, and K's $79.01;
- the same note under a $50.00 cap the system never boarded, which leaves
  $29.01 in suspense;
- the cap boarded;
- K's $79.01 already collected above that cap and November missed, which
  owes $29.01 back;
- September's installment alone, which leaves the loan behind.

It agrees with the engine on every in-scope candidate among 600 first draws
nothing filtered. Its longest held-out task is 44 tool calls in 27 turns,
and its longest training task 39 in 24. Two tests
hold the moments to their histories:

- each clean moment posts to the cent as the history posted it;
- each twin's charges, held to the note, are the clean history's charges.

An answer that trusts the system's charges passes every task within the note
and none above it, with a mean score of 0.65 on those.

DeepSeek-V4.1-Flash's held-out baseline (thinking, 16,000 output tokens a
turn) is 197 of 200 (98.5 %) on the life 1.2.0 pin, beside 198 on the life
1.1.0 pin (docs/decisions.md, "DeepSeek's held-out baselines on the newest
suites, and two corrected").

## escrow-review

escrow-review 1.1.0 is the first demo's other graded moment. It is an annual
escrow analysis that the servicing app holds for anomaly review before
approval, drawn from a decade the life generator runs. A hold follows a
large change in the payment or in a bill (spec §3.2 R10, `anomalies`,
`apps/servicing/src/domain/escrow/analysis.ts:101-107`). Half the analyses come
from a history in which the county reassessed the property or the hazard
premium rose at renewal; the other half are ordinary years, the negatives.

**The task.** escrow-analysis's inputs exactly, read off the history at the
analysis (`LifeMoment`):

- the lines as the analyst has them: taxes estimated from last year with
  CPI, hazard on a known renewal quote half the time and on last year's
  premium otherwise, mortgage insurance on its contract;
- the balance on the run date, and the escrow shares and bills still to post
  before the year;
- the delinquency, and the escrow payment on the loan's terms today, which
  the new one replaces: the one the terms carry for the first installment
  due after the run date, with any shortage or credit spread from last
  year's analysis still in it at its level amount.

Beside them is the account's history: the two analyses before this one, the
disbursements of the last 24 months, and the last twelve month-ends. The
model finds the shortage or surplus, the new payment, its effective date
and the months a shortage is spread over, and says whether the flag stands.

The payment on the terms is what the servicing app compares the new
payment with. `loan_terms.escrow_payment_cents` carries the running spread
at its level amount through the spread's last month, and the step-down after
it is held apart (`apps/servicing/src/domain/escrow/ops-3-6.ts:105-117`);
the app's installments read it so (`escrowPortionOn`,
`apps/servicing/src/domain/operations-runtime/installments.ts:57-61`). Reg
X's annual statement sets the new payment beside the current one (12 CFR
1024.17(i)(1)). A spread's final installment carries the spread's rounding,
which the plan holds apart (`final_installment_cents`; spec 3.6, worked
example (b): "payment $243.05, final $243.09"), so it is not the payment on
the terms. On 70 of the held-out suite's 200 analyses the next installment
is a final one whose rounding is not zero: it bills 1 to 6 cents more or
less than the task's payment, and read instead it would change no graded
answer.

1.0.0 handed the old schedule's payment from the new one's effective date,
after last year's spread had run out. On its 200 held-out tasks the payment
on the terms differs on 154, and 15 graded answers change, 4 of them whether
the flag stands (measured from the generator under life 1.1.0; the billed
payment differs on the same tasks and changes the same answers). 1.1.0 is
drawn on life 1.2.0, and `escrow-review/1.0.0` is retired in
`HELDOUT_SUITES`.

**The rules.** escrow-analysis's rulebook from its conventions through Step
9, word for word (a test holds it), under a reviewer's opening. Step 10 is
the app's triggers: a payment change over 25 % or over $150 against the
payment on the terms today, a refund over $2,500, and a bill's variance
against last year over 20 %. Step 11 is the flag, which stands when
anything was flagged.

**The grade.** Thirteen fields, a pass being every one right:

- the annual total, base payment, target and projected actual balance;
- the decision, and the surplus, or the shortage with its deficiency and its
  months;
- the new payment and its effective date;
- the triggers, as a set, and whether the flag stands.

**The grader is the servicing app's own engine.** The analysis is
escrow-analysis's run of the port (`analyze`). The flag is the engine's
`anomalies`, handed `bill_variance_gt_20` as the app's own
`compareBillToPriorYear` computes it
(`apps/servicing/src/app/tools/section03.ts:144`). That is the variance in
hundredths of a percent, `(current − prior) × 10000 ÷ prior` in integer
division, flagged above 20 %. The app compares two amounts its agent hands
it; here they are a line's known bills for the coming year and its
prior-year total, wherever both exist. A test holds both cited lines.

**The tasks.** The arm cycles by index through six:

- `reassessed_up`: a reassessment 25 to 80 % up, held with a shortage;
- `premium_up`: a premium 20 to 80 % higher at renewal, held with a
  shortage;
- `reassessed_down`: a reassessment 30 to 60 % down on a loan of $400,000 to
  $800,000, where the taxes are large enough to move the payment, held with
  a surplus refunded;
- `ordinary_shortage`, `ordinary_refund` and `ordinary_credit`: no event, an
  analysis of the second year or later, not held.

Each arm names the verdict it lands on, so each of the five verdicts the
runner tallies is 16 % of a suite or more.

After an event the generator tries the first three analyses whose coming
year ends after the first bill the event changed. The first can see a
renewal's increase among the coming year's bills; the next two see it in
last year's. A draw that lands on no analysis of its arm is drawn again: 160
of the held-out suite's 200 are first draws. The suite holds:

- 101 analyses held, 68 with a shortage and 33 with a refund;
- 99 not held: 33 shortages, 33 refunds and 33 credits;
- triggers: a payment change over $150 on 94, over 25 % on 68, a refund over
  $2,500 on 28, and a bill over 20 % on 16.

Every shortage is spread over 12 months. The life generator runs no workout,
so neither the 60 months of one nor a borrower's election appears, and
neither does a retained or a balanced surplus.

**What the histories showed.** The hazard renewal falls in the two months
before the computation year: on the note's month, two months before the
first payment. So last year's figure always carries the newest renewal, and
a premium's increase reaches a bill compared only in the analysis whose
coming year holds the first increased renewal, and only when its quote is
known. Drawn as "the first analysis after the event", no bill was ever
flagged, which is why the generator aims as it does. Taxes are estimated
from last year with CPI and never carry a bill, so a reassessment is found
in the payment, never in the bill comparison.

**The proof of fairness.** Every one of the 400 analyses in forty decades,
read off as a task, concludes what its history concluded. The reference passes
the held-out suite, a 300-task training suite and §3.2's worked example and
its three variants, with today's payment at the $130.00 the ledger deposits:

- the example's $172.22 is a change of 32 %, held;
- the deficiency variant's $243.05 is held too;
- the refund's $138.33 and the credit's $136.11 are not.

It agrees with the engine on every candidate among 600 first draws nothing
filtered. Its longest held-out task is 71 tool calls in 31 turns, and its
longest training task 73 in 33. An answer with the analysis right and no
bill comparison passes 184 of the held-out suite's 200, and one that says
every flag stands passes 101.

DeepSeek-V4.1-Flash's held-out baseline on 1.1.0 (thinking, 16,000 output
tokens a turn) is 194 of 200, 97.0 % (docs/decisions.md, "DeepSeek's held-out
baselines on the newest suites, and two corrected").

**Both environments draw from the calibration's typed defaults**
(`defaultCalibration`), as the life generator's tests do. So a change to
`calibration.json` does not move a pinned suite, and the browser, which
reads no file, draws the task the command line does. A change to how the
generator draws does move them, as life 1.1.0 and 1.2.0 did
(docs/decisions.md, "Life 1.1.0 moved the three suites drawn from it" and
"Life 1.2.0"). The held-out suites are seed 1, 200 tasks each, pinned by
hash.

## boarding-triage

boarding-triage 1.1.0 grades the review a servicing-transfer package gets
before its loans board: the defects the servicing app's gate cannot see. It
is built on the life generator, and reads a package where the two above
read a moment. 1.0.0 drew two defects, D-42 and D-03; 1.1.0 draws the first
ten of docs/synthetic-data-defects.md, and grades a defect's root apart from
its symptoms.

**The task.** One package from the life generator's writer (below, "The
transfer package"). It holds one to four loans that reach us by transfer on
one date, each with its prior servicer's months generated in full. Some
loans carry a planted defect, and the rest are clean twins. The model is
shown:

- the final tape, loan by loan;
- the short detail files in full, and the images manifest without its
  hashes.

It reads the payment history and the correspondence with a tool. The
fair-lending file is restricted, and a reviewer does not read it. For each
defect it names the loan, file and column, the row in a file of several rows
per loan (a payment-history row's due date), what the cell says, and what is
true (null when the package cannot say, or the row should not be there). It
also gives a handling: board as is, correct, hold, or query the prior
servicer. A loan with no finding is passed.

**The rulebook** (`src/boarding/rulebook.ts`) is ten checks on every loan:

1. every Y/N or coded cell holds one of its column's codes, because the
   decoder reads anything but a literal Y as N (`tape-codec.ts:49`);
2. the escrow cells agree with the escrow files;
3. the tape's late-charge terms give the fee on the latest periodic
   statement: `round(pi × pct / 100, 2)`, capped at `late_charge_max`;
4. the next due date and the payment agree with the payment history (the
   date alone on a loan whose servicemember's flag is Y, because its history
   bills the capped payment);
5. each flag agrees with the details delivered beside it: a row in the
   loss-mitigation file, a bankruptcy case in the bankruptcy file, an SCRA
   rate-cap reason on the tape;
6. an ARM's caps are its plan's: a 5/6, 7/6 or 10/6, read off the first
   change date, has Fannie Mae's caps for that plan (200, 100 and 500 basis
   points on a 5/6; 500, 100 and 500 on the others);
7. the mortgage insurance's original value and termination date are the
   lender's disclosure's, in the correspondence;
8. the flood zone is the life-of-loan determination's, in the correspondence;
9. the payment history's first row is due on the first payment date, each
   later one a month on;
10. each paid row's escrow is at most what its statement billed. A row that
    took more took principal into escrow, and what the principal should be is
    the statement's P&I less the row's interest.

Three handlings are right, each for its own kind of cell. Correct a code or a
flag the rest of the package settles: D-42's Yes, D-35's, D-37's and D-12's
flags left off beside their details, D-15's zone. Query a term of the loan or
a payment's split, which only the prior servicer may correct
(`service.ts:247-248`): D-03's cap, D-01's cap, D-18's date and D-25's
principal. Hold the loan when its history would board its delinquency
wrong, because boarding applies the history oldest first: D-24's row.

**Roots and symptoms.** A cell can look wrong only because another is. D-24's
row moves the history's oldest unpaid installment off the tape's next due
date, so check 4 flags the date. D-12's capped payments differ from the
tape's P&I when the flag that says so is off. D-25's misapplied principal is
in the tape's balance, the trial balance, Fannie Mae's position and every
later split. The rulebook asks for the root, the cell whose correction fixes
the rest.

**The tools.** Primitives only:

- `read_file`: one file, or one loan's rows of it;
- `code_list`: the layout's code lists, read from the ported codec's column
  dictionary, with the writer's own columns and FEMA's flood zones;
- refi's `calculate`.

No tool compares cells or decides. The file reader is the first tool that
needs the task, so the episode loop hands `execute` the task, and the
playground hands it the page's. Every other environment's tools ignore it.
`submit_triage` takes a `row` on each finding, null for a file of one row
per loan.

**The grader** is the package's label manifest. It reads the manifest the
way the servicing app's demo-batch test reads the sample's designed outcomes
(`demo-batch.test.ts:77-87`):

- each root is four fields: found, what it says, what is true, and a
  handling the label accepts;
- a root with symptoms has a fifth, traced: a finding names the root, or
  one of its symptoms. A finding that names a symptom but not its root earns
  that field alone, so partial credit at most. One that names the root covers
  its symptoms, and a symptom named beside it is neither required nor extra;
- each clean loan is one field: passed, meaning neither held nor corrected;
- extra findings, a second finding on a cell among them, are one field: at
  most two.

Money is compared in cents, and a blank as "", null, blank or empty. An
empty submission passes a package with nothing planted; no submission passes
nothing. A finding in a file of several rows per loan without its row is a
malformed submission, returned to the model to correct.

**The tasks** take twenty plans in turn, ten packages of each in the
held-out suite:

- one clean loan;
- one loan with each of the ten defects;
- one loan with D-03 and D-42, the demo's shape;
- three or four loans pairing two defects beside clean ones: D-03 and D-01;
  D-35 and D-37; D-24 and D-25; D-12 and D-15; D-18 and D-42; D-35 and D-24;
  D-42 and D-03;
- three clean loans.

So each defect is planted on at least 20 of the 200 held-out packages, the
floor a test holds: D-03 and D-42 on 40, D-35 and D-24 on 30, the other six
on 20. That is 260 roots and 346 symptom labels. A defect's loan is drawn
with what it needs:

- a capped note, an ARM, an escrow account or a flood line, pinned;
- a servicemember called to duty three to twelve months before the
  transfer, on a fixed rate above 6 %;
- a Chapter 13 petition two to nine months before the transfer;
- a missed installment two months before the transfer and a six-month
  repayment plan from its 20th, in force at the transfer;
- mortgage insurance at 85 to 95 % loan-to-value.

The clean loans are drawn to look like the defects. Of the held-out suite's
130 clean loans:

- 52 carry a cap their tape carries too;
- 30 have no escrow, and 15 are ARMs;
- 5 are servicemembers, 9 are in bankruptcy and 10 are paying a plan, each
  flagged with its details;
- 41 carry mortgage insurance, and 19 are in zone AE.

Each history runs a year past the transfer, and the package reads what came
before it. Behavior is drawn from the calibration's typed defaults, so a new
calibration file does not move the suite. A package is kept only when two
things hold. The gate's 35 rules, ported and run on the package as the
decoder reads it, pass on every loan. And the reference finds exactly the
planted roots. Otherwise it is redrawn. On the held-out suite 52 of 200 first
draws were redrawn (life 1.2.0):

- 22 for a payoff before the transfer;
- 12 at the gate: 10 for a hazard renewal within 30 days of the transfer
  (W-005), 2 for that and an analysis more than a year old (W-009);
- 18 for a defect the draw cannot carry. Four drew a note D-03 cannot be
  planted on (a cap the P&I never reaches) and two a note D-24 cannot (a
  closing on the first of its month). Twelve had a history without what the
  defect needs, which the defect's own check meets before the payoff check
  does: seven of D-12's, two of D-18's, and one each of D-24's, D-25's and
  D-35's (no plan in force at the transfer).

**The floors.** Submitting nothing passes 20 of the 200 held-out packages,
the ones with nothing planted, with a mean score of 0.27. Correcting every
flag (escrow, loss mitigation, bankruptcy, servicemember) and nothing else
passes 70. Every check the tape and the short files settle alone (checks 1,
2, 5 and 6), with no payment history or correspondence read, passes 80.

**The output budget** is 32,000 tokens a turn, reasoning included, where
the policies' default is 16,000 (`outputBudget` in `src/boarding/index.ts`,
decided 26 October 2026). A package is long and most of a model's misses at
16,000 were the budget, not the answer, so 16,000 measured how much a model
could write before answering more than how it triages. The budget is in no
fingerprint: the tasks and the grading are the same at any budget, and a
run's policy id says the budget it ran at.

DeepSeek-V4.1-Flash's held-out baseline on 1.1.0 (thinking) is 95 of 200
(47.5 %, 40.7 to 54.4) at that budget. At 16,000 it was 28 (14.0 %), which
stands as what the smaller budget measured. Every answer it submitted
passed at both, and most misses ran out of tokens: 165 at 16,000, 93 at
32,000, so the 32,000 score is partly the budget too. Part of each run was
on the Vertex policy before the stream-cut check, so both are lower bounds,
at most 107 and 35. 1.0.0, retired, passed 65 of the 150 tasks its run
scored (docs/decisions.md, "DeepSeek's held-out baselines on the newest
suites, and two corrected", and "boarding-triage and tape-intake run at
32,000 tokens a turn").

**The proof of fairness.** The reference passes the held-out suite (seed 1,
200 packages, pinned by hash), 300 training tasks, four spec cases (the demo
loan clean, with D-42, with D-03, and with both) and a package of each
defect alone. It takes three turns and at most 18 tool calls. Of the first
draws of 1,000 training tasks (train seed 11), 745 reached the fairness
check, and the reference missed nothing on any of them.

**What the servicing app does with them.**
`apps/servicing/scripts/board-life-package.mjs` boards packages through the
servicing app's own `decodeTransferBatch` and `BoardingService`, in process,
with no database. With no argument it writes and boards the demo's four and
one training package of each defect alone (`npm run env:transfer-package --
--out DIR --each`, `src/boarding/one-of-each.ts`). It reports every label,
the root and each symptom, with whether the gate caught it, and what boarded
in the root's place:

- every tape is accepted, and every loan boards with no hard failure and no
  warning. The gate catches none of the ten, at the root or beside it;
- D-42's loan boards with `escrowed=false`, D-35's with
  `lossmit_in_process=false` though its details stage, D-37's with
  `bk_active=false` and its case dropped, D-12's with `scra_active=false`;
- D-01's initial cap stages as the periodic one;
- no package boards a cap, an MI date or value, or a flood zone, because the
  decoder reads none of them;
- D-24's loan boards delinquent: one of each boards 15 days behind, a loan
  whose tape says it is paid ahead;
- D-25's boards the tape's balance, which keeps the misapplied principal.

A test runs it on the demo's four and the ten.

Not in 1.1.0:

- the other 37 defects, and the harder variants of the ten. D-35's has no
  loss-mitigation row at all, only trial payments in the history. D-37's has
  no details in the package. D-12's is found only by the military-status
  lookup;
- a package the gate already fails, which is what the sample's designed
  outcomes grade;
- the preliminary tape and delta boarding;
- the transfer's timers;
- what a defect does after boarding. The generator labels the twin's
  symptoms (`generate`'s labels) for the environments that will grade them.

## tape-intake

tape-intake 1.0.0 grades the review a partner's monthly tape gets at the tape
desk before it is loaded. It is drawn from the life generator, and reads a
month of a partner's tape stream where boarding-triage reads a transfer
package.

**The task.** One delivery, as the desk receives it, beside the last tape the
desk loaded. The partner is a servicer whose book we watch, and its tape is
the tape writer's m3-v1 file for a book of 8 to 14 loans the generator ran
for five years. The model is shown:

- the delivery: the month the partner says it is for, the day it came, its
  name, its row count, and its header row exactly as written;
- the last tape loaded: its month, name and rows;
- the desk's reading: what the m3-v1 reader made of the delivery, its
  refusal and its exceptions by row, loan and column (`desk.ts`).

It reads the cells with the tools. For each defect it names which, the
month, the loan and column (or none, for the file as a whole), what the tape
says and what is true (null when the delivery cannot say), and what to ask
the partner. It also gives the delivery's verdict: `load`,
`load_after_correction` or `hold`.

**What a delivery can carry.** The five tape-stream defects, in their forms,
and the three history errors that show on one month's tape:

| Defect | How the tape shows it                                                                              | Verdict                                 |
| ------ | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| T-01   | the last tape is two months back; or every row is last month's again                               | loads; or hold                          |
| T-02   | a header that is not the layout's for its column                                                   | hold if required; else after correction |
| T-03   | a ZIP under five digits, a pay string under twelve                                                 | after correction                        |
| T-04   | a date column with two-digit years, serial numbers, or the day first                               | loads; day first after correction       |
| T-05   | an As of Date that is not the month's last day                                                     | after correction                        |
| V-01   | an escrow balance fallen by more than twelve months of T&I                                         | loads                                   |
| V-02   | in the policy's anniversary month, an escrow balance that rose by the escrow paid in               | loads                                   |
| D-25   | a loan paid nothing, and the loan a keystroke away was paid its own Total Due and the first loan's | loads                                   |

A history error loads because the tape carries the partner's records as they
are: what is wrong is theirs to correct, and the finding says what to ask.
D-28, a payment drafted twice, is not drawn. On a monthly tape it is a month
paid twice and the next paid ahead, which a borrower who pays the next
installment early in the same month shows too.

**The rulebook** (`src/tape-intake/rulebook.ts`) is eight checks in order:
the month (T-01), the headers, the codes, the dates, the as-of, then the
partner's records on each loan Active on both tapes (V-01, V-02, D-25), read
as the first five correct the tape. It says first what the reader already
does, from the m3-v1 profile and `parseBook`:

- it refuses a file missing a required header, by name, and keeps the cells
  of a header it does not know;
- it reads a date month first, a two-digit year in the century nearest the
  day it reads it, and an Excel serial; any other cell is `unreadable_cell`;
- it never pads a code, takes the tape's own as-of, and compares nothing
  across months.

So a refusal or an exception in the desk's reading is a symptom, and the
finding names its cause. In the held-out suite the reader refuses 13
deliveries, each for a required header renamed, and raises exceptions on
one, a day-first closing date past the 12th. It says nothing of any other
defect there.

**The tools.** Primitives only:

- `read_rows`: rows of either tape, cells as written, by loan and by column
  letter or the file's own header;
- `compare_months`: the two tapes column by column, which headers and cells
  differ and which loans are on one and not the other;
- `parse_date`: what the reader reads a date cell as, on a day (the reader's
  own `parseDateIso`, ported);
- `lookup_layout`: each column's letter, header, type, whether it is
  required, its export form, and the rules its dates keep;
- refi's `calculate`.

No tool checks a rule or decides. The reader's profile is ported byte for
byte but for one import (`src/tape-intake/ported/`): the profile takes its
serial-date function from the vendored workbook reader, which imports
`node:zlib`, so the function is copied word for word beside it. A test holds
both to their sources, and reads every task's delivery with `readBook`
itself to hold the desk's reading to it.

**The grader** is the delivery's labels, read as boarding-triage reads its
manifest:

- each expected finding is found (its defect, month, loan and column), says,
  truth and ask; T-01, which names a file, is found and ask;
- the verdict is one field;
- extra findings, a second finding on one among them, are one field: at most
  two.

Money is compared in cents, a date as its date, a header as the reader
compares one, a column by its letter or any header the layout gives it. A
stream defect is one finding per column, with its first row's cell; a history
error is one per loan. The labels are the generator's root causes: the tape
defects' cells, and each history error's loan as the delivery shows it, with
the clean history's cell as what is true for D-25. A clean delivery is load
with nothing found.

**The tasks** take 16 arms in turn: clean twice; T-01 missing, sent again
and relabeled; T-02 required and not; T-03; T-04 and T-05 in drawn forms; a
spreadsheet's T-03 and T-04 together; V-01; V-02; D-25; D-25 under a T-05
as-of; V-02 under a renamed header. A history error is made in the delivery's
month on an event the clean history had there: a tax bill; the first hazard
renewal after a transfer, on a loan with no mortgage insurance and no other
bill that month; or a borrower's payment, with a loan paying one installment
that month for it to land on, whose number the scenario pins a keystroke
from the payer's. A third of each book's loans reach the partner by transfer.
The held-out suite (seed 1, 200 tasks, pinned by hash) holds:

- 82 deliveries to load, 80 to load after correction and 38 to hold;
- 25 clean, and findings of every defect: T-01 38, T-02 38, T-03 40 (a ZIP
  and a pay string on most), T-04 25 (7 two-digit years, 12 serials, 6 day
  first, over all six date columns), T-05 25, V-01 12, V-02 24 and D-25 48
  (24 payments, two loans each);
- deliveries of 5 to 14 loans, 8.9 on average, from October 2027 to March 2032.

186 of the 200 are first draws (life 1.2.0). 14 were redrawn: 11 books had
no first renewal after a transfer in range for V-02, and 3 had a tape with
fewer than five loans.

**The floors.** Submitting load with nothing found passes 25 of the 200
held-out deliveries, the clean ones. Finding only what the desk's reading
shows (a required header it refused on, a column it raised an exception on)
passes 39. Every stream defect found, with no record read, passes 140;
every finding with the verdict always load passes 82.

**The output budget** is 32,000 tokens a turn, reasoning included, where
the policies' default is 16,000 (`outputBudget` in `src/tape-intake/index.ts`,
decided 26 October 2026). A delivery is two tapes and the partner's records,
and most of a model's misses at 16,000 were the budget, not the answer. The
budget is in no fingerprint: the tasks and the grading are the same at any
budget, and a run's policy id says the budget it ran at.

DeepSeek-V4.1-Flash's held-out baseline (thinking) is 175 of 200 (87.5 %,
82.2 to 91.4) at that budget. At 16,000 it was 106 (53.0 %), which stands as
what the smaller budget measured. All but one answer it submitted passed at
each, and most misses ran out of tokens: 92 at 16,000, 23 at 32,000
(docs/decisions.md, "DeepSeek's held-out baselines on the newest suites, and
two corrected", and "boarding-triage and tape-intake run at 32,000 tokens a
turn").

**The proof of fairness.** The reference passes the held-out suite, 300
training tasks and 13 spec cases, one per defect in a named form, in at most
5 turns and 30 tool calls. A delivery is kept only when
it finds exactly the labels, nothing extra, and the verdict. Of the first
draws of 1,000 training tasks (train seed 11), 943 reached that check, and
the reference missed three. One is a V-02 loan that paid two installments
in the month, as under life 1.1.0. Two are V-01 bills whose tenfold amount,
less the month's deposits, took the account down by less than twelve months
of T&I, the line the rule draws.

**What the first draws taught the generator.** A D-25 payment that came
before the receiving borrower's own once left that borrower paying nothing,
because a borrower does not pay an installment already paid, and then paying
the next installment's amount. A borrower knows only what they paid
themselves, so an installment another loan's payment paid is paid again, as
billed. V-02's and D-25's rules read a T&I payment and a Total Due from
either tape, because an escrow analysis can move them between the two, and
the record checks read the tape with its dates corrected, because a
day-first next due date once made a current loan look like an unpaid
renewal.

Not in 1.0.0:

- the supplement beside the tape, and a supplement's own defects;
- a stream defect in the last tape loaded, which was reviewed when it came;
- D-28, which a monthly tape cannot tell from a borrower paying early, and
  the history errors that show only in a payment history;
- staff errors, which a monthly tape does not show; contact-audit grades two
  from the contact history.

## The life generator

`src/life/` is not an environment. It writes ten-year histories of loans for
environments to draw tasks from. It is a module of this package and not a
workspace of its own: it runs the environments' ports, and the environments
built on it import it, so as two packages each would import the other.

`generate(seed, scenario, { defects })` draws a book of Fannie Mae
conventional loans and runs each one month by month for ten years. The
loans are first liens on one-unit principal residences, 30 years, first
payments from March 2026, fixed or SOFR ARMs (5/6, 7/6, 10/6), with
borrower-paid MI above 80 % loan-to-value. The same seed and scenario give
the same book byte for byte.

**The engines decide every figure.** Receipts post through cashiering's
`allocate` and late charges through `assessLateCharge`, run the day after
grace as the servicing app's daily run does
(`apps/servicing/src/domain/cashiering/ops-2-7.ts:110`). Each year's escrow
analysis is composed the way escrow-analysis's grader composes it. Each ARM
change is computed by engine A and checked by engine B. The MI trigger is
swept by `automaticTermination`, a payoff is quoted by `quote`, and every
month-end goes through `buildSnapshot`, `validateSnapshot` and `renderBase`.

**What it carries that the engines do not:**

- the borrower;
- the escrow balance between analyses, and each year's bills;
- the P&I and escrow schedule each analysis or ARM change writes;
- the rate `allocate` reads. It charges one rate to every installment a
  payment covers (`apps/servicing/src/domain/cashiering/allocation.ts:107`,
  `:112`), so a payment across a rate change is posted in two calls;
- the rolling twelve months of $50-rule partials. `allocate` only adds to
  the count (`allocation.ts:157`);
- which fee a payment collected, oldest first. `allocate` lowers the amount
  due and names no fee (`allocation.ts:195`);
- the ledger Metro 2 and the MI sweep read, which is the cashiering ledger
  itself, never a FIFO replay of the receipts;
- the index feed, a transferred loan's boarding, and the payoff.

**What it invents.** The borrower's behavior, drawn from
`src/life/calibration.json`: payment timing, partials, curtailments, misses,
cures and repeat misses by roll rate, contacts and their reasons, disaster
months, payoffs and transfers out. The book's note rates, loan-to-values,
escrow, ARM and MI shares, tax and insurance bills, and the mortgage rate's
starting point come from it too. Another builder writes that file. The
generator reads every key of it as written and converts each to the unit it
draws in; "Calibration" below says how each value is used. A key missing or
unreadable takes a typed default marked `design_choice`, with the reason in
the result's warnings. The committed file gives no warning.

**Habits.** Each borrower draws two habits, `lateness` (when they pay) and
`fragility` (whether they miss), lognormal with mean one. Their own
probabilities are a base times the habit, capped: a miss or a payment
after grace at most half the time, on time at least one time in twenty. A
cap cuts the largest habits off, so `behavior.ts` sets each base so that the
mean over the habit's distribution, after the caps, is the file's share.
Without that, the within-grace share of a half would come out at 0.43.

A borrower who is behind does one of three things, by roll rate:

- pays everything owed;
- pays the oldest open installment's amount, which applies;
- misses again.

A receipt for an installment a cure or a promise already paid is not sent.

Also invented: the index feed, the mortgage-rate path, names and addresses,
and the terms the calibration does not cover. The design choices without a
calibration key are named in `draw.ts`, `behavior.ts` and `simulate.ts`.
`calibrationCheck` reads a book against the calibration. Some rows are draws:
the payment shares, the monthly roll and cure, the escrow, ARM and MI shares,
and contacts. Others are checks, figures the draws only make: the 30+ share,
the missed-month share, and the quarter-ahead roll and cure the file states.
The payment shares are read as the file states them, over installments on
loans current at the due date.

**Scenarios.** A scenario dates the events the borrower obeys: a transfer
in, a missed payment, a promise to pay (kept or broken), a repayment plan, a
tax reassessment, an insurance increase at renewal, bill pay sending the old
amount once after a payment change, a payoff and a transfer out. Two more
date what happens to the borrower:

- **A call to active duty** (`active_duty`). From the first installment due
  after it, the interest is capped at 6 % (50 U.S.C. 3937) and no late
  charge is assessed (the `scra_reduced_rate` overlay, 2.7 rule 3(iii)).
  The capped payment re-amortizes the balance at 6 % over the remaining
  term, as an ARM change does, because the servicing app states no formula
  for it. It is refused on an ARM, whose cap is not modeled.
- **A bankruptcy petition** (`bankruptcy`, Chapter 13 unless named). Every
  charge on an installment due from it accrues suspended (2.7 rule 3(iv)),
  and the servicer does not call the borrower (12 CFR 1024.39(c)(1)). The
  month-end and the tape report the case, and since life 1.2.0 the contact
  center takes it as its own (below, "The contact center"). The plan's
  payments, the trustee and a discharge are not modeled.

A pin may also give a loan a flood line (`flood`). On a transfer in, the
prior servicer's months are generated in full and marked `prior`, and the
prior servicer's books at the close of the day before are kept
(`at_transfer`), with the repayment plan in force then, if any. A payment
the borrower sends the prior servicer (`misdirected_payments`) is decided the
day the prior servicer has it, reaches us 5 to 10 days later, and is
credited as of that day. The 60-day transfer shield is read as the spec
reads it (§2.7 rule 3(i) and its example L; 12 CFR 1024.33(c)(1)): in the 60
days beginning on the transfer date (through the transfer date plus 59, as
example L counts them), a payment the prior servicer received by the end of
grace is not late, so when what it received pays the installment in full, a
`transfer_window_60` overlay naming that installment alone is written on
the day it had the payment, and the late-charge run charges nothing whether
the money has reached us or not. The engine's `transfer_shield_until`,
which spares every installment due in the window paid or not
(cashiering-11), is never set: a missed installment in the window is
charged, and so is one paid late or short, to either servicer. Until life
1.2.0 the generator set it on every transfer.

With `outreach` on (it is off by default), the servicer calls a delinquent
borrower as the servicing app's D2-2-02 plan does: on day 17, then 7 days
after each attempt moved to a business day, ceased by a promise to pay
within 30 days and closed by the cure (`early-intervention/plan.ts`). None
of these moves a book drawn without them. `LIFE_VERSION` is 1.2.0
(docs/decisions.md, "Life 1.2.0"), and every suite drawn from it is pinned
at that version.

**Twins.** With `defects`, each planted loan runs again from the same draws
with the defect planted. Every draw comes from a stream keyed by the loan and
the installment, month or analysis, and none reads the loan's state, so the
twin differs only where the defect reaches. Most enter at boarding, as a
value boarding writes (`BoardedTerms`); D-25 enters earlier, in the prior
servicer's own books (`HistoryPlant`). The labels are the planted value
(`root_cause: true`) and every difference between the two histories, field
by field (`root_cause: false`). The month-end tape is one of the tables
compared, so what the servicer reports, such as a cap, a plan or a
bankruptcy it no longer knows of, is labeled too.

`DEFECTS` in `defects.ts` is the registry each wave extends. It holds the
first ten of docs/synthetic-data-defects.md, which enter at boarding or, for
D-25, in the prior servicer's books before it, each with what it needs, what
it plants and what its twin does:

| ID   | Needs                                                        | Planted                                                     | The twin                                                                                                                       |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D-42 | escrow lines, a transfer                                     | Yes in the tape's escrow cell                               | boards non-escrowed (D-31): no escrow billed, paid or analyzed from the transfer                                               |
| D-35 | a repayment plan in force at the transfer                    | N in `lm_in_process`, the loss-mitigation row kept          | the plan's charges assessed rather than suspended, nothing waived at its end, no plan reported to the bureaus or on the tape   |
| D-03 | a dollar cap that binds                                      | a blank cap                                                 | cashiering charges the full percent                                                                                            |
| D-01 | an ARM                                                       | the periodic cap in the first-change cap's cell             | every rate change after boarding reads the wrong cap                                                                           |
| D-12 | a servicemember on a fixed rate above 6 %                    | N in `scra_active`, the cap's reason kept                   | billed the note's rate and P&I from the transfer date, and charged late fees again; what was past due keeps the capped payment |
| D-37 | a petition before the transfer                               | N in `bk_active`, the case kept in the bankruptcy file      | charges on post-petition installments assessed, the borrower called, no case on the tape                                       |
| D-18 | mortgage insurance in force                                  | a termination date computed from 95 % of the original value | the insurance and its premium run past the date the law ends them                                                              |
| D-24 | a closing after the first of its month                       | a history row due on the first of the closing month, unpaid | boards an installment behind: the last installment paid is open again, and each payment after pays the one before its own      |
| D-25 | escrow, a regular payment 3 to 12 months before the transfer | that payment's principal posted to escrow                   | the balance keeps the principal: every later split, analysis, month-end and payoff on it                                       |
| D-15 | a flood line                                                 | zone X where the determination says AE                      | the history is the clean one: flood tracking is not modeled, so the root is its only label                                     |

Of the ten, every defect but D-03 enters only through a transfer. A loan
may carry two defects. Its twin carries both, and each symptom is labeled
for the defect whose own twin shows it, or for the pair when neither does
alone. A symptom is dated by its row, so a row the prior servicer wrote
that the root changed later is dated before the root: a charge it suspended
that D-35's twin never waives, and the installment D-24's row opens again.

Four are errors made in the history after boarding, by a vendor or a system
the servicer depends on. The catalog's D-25 has two forms, and the registry
plants them apart: the prior servicer's split above is `D-25`, and the
system's wrong loan below is `D-25/wrong-loan`. Both label D-25, and draw
from D-25's streams and its calibration rate; a request names the form by
its key.

| ID   | Whose  | The error                                                                                      | Its root cause                                    |
| ---- | ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| V-01 | vendor | the tax service reports a bill ten times the county's, and it is paid from escrow as reported  | `escrow_bills.amount_cents`                       |
| V-02 | vendor | the first hazard renewal after a transfer is billed to the prior servicer, and paid late       | `insurance_policies.mortgagee_clause`             |
| D-28 | system | a borrower's payment drafted twice, the same amount on the same day                            | the second draft, a `payments` row                |
| D-25 | system | a payment keyed to a loan number a keystroke away, and posted to the loan that has that number | a `payments` row on each loan: missing, and extra |

A history error is made on one event the clean history had: a bill, or a
borrower's own payment on our books. It is read off that history, so the
twin is the clean history until that event, and the engines' from there:

- **V-01.** The county returns the excess 45 to 120 days later, into
  escrow. Until then the account is short by nine times the bill, and an
  analysis that runs in between finds a shortage the borrower is billed for.
  The analyst still projects from the county's bill.
- **V-02.** The renewal reaches the servicer 30 to 75 days late, when the
  prior servicer sends it on, and is paid then. Until then the account holds
  the premium. Whether the policy lapsed is the carrier's, and not modeled.
- **D-28.** The waterfall posts the second draft as it posts any payment:
  to the next installment, paid ahead, and the borrower's own payment for it
  then finds it paid. An early payer's second draft, with nothing billed yet,
  sits in suspense. Nothing in the history returns it.
- **D-25.** The payer's installment stays open and runs late, with a late
  charge. The other loan's borrower, who knows nothing of it, pays as billed,
  so that loan is paid ahead (the borrower's own rule, that an installment
  already paid is not paid again, is for what they paid themselves). Nothing
  in the history moves it back: the catalog's reversal weeks later is a correction cashiering has no
  engine for. A book draws its loan numbers at random from a hundred
  million, so no two are a keystroke apart unless a scenario pins one
  (`LoanPins.servicer_loan_number`). D-25 lands only there.

A request names the loans and the date to make it from (`at`), or a rate
per eligible event: per bill or per payment, where a boarding defect's rate
is per loan (the prior servicer's D-25 reads its "per receipt" as the
chance that a loan with that many payments it could misapply carries one).
`D-25/wrong-loan` names the loan it lands on with `with`. A row an error adds
is named off the row it comes from, and a row it removes keeps its id
spent, so every other row keeps its id. The payments table is compared by
day and kind of payment rather than by receipt number, because a payment one
history never sends would renumber every receipt after it. The
disbursements table is compared the same way for the same reason: a bill as
the next of its line's, named by its line and the day it was due
(`tax_county@2028-01-01`), which a bill paid late or at the wrong amount
still is; any other row by its kind and day (`refund@2028-07-18`). A refund
one history makes and the other does not once renumbered every later bill,
and labeled each with another bill's day, line and amount. Staff errors,
which need the contacts layer, are planted by the contact center the same
way (below, "The contact center", "Staff errors"): a promise not tracked is
S-01, and a complaint not logged with everything that follows from it is
S-02. The call defects it plants on calls and notes are numbered apart (C-01
to C-08, below): a complaint not logged on the call alone is C-04, a wrong
figure in a call explaining the annual statement C-05.

**Moments.** `generate(…, { observe })` shows an environment what each
engine is about to be handed, as it stands, in the clean history and in the
twin the book carries (`LifeMoment`): every receipt the waterfall posts,
with the cash state it is posted against and the rate each installment is
charged at (a payoff is quoted, not posted, and is not shown), and every
annual analysis with the lines as the analyst has them, the CPI, the balance
on the run date, what is still to post before the year and the payment it
replaces: the escrow payment on the loan's terms for the first installment
due after the run date, last year's shortage or credit spread still in it at
its level amount, not the final installment's rounding (since life 1.2.0;
the old schedule's after the spread ran out before it). Each analysis row
carries its projection's bills and targets too. Each moment is a copy, and
observing changes no draw. An environment
built on the generator reads its task off one of these, so the task is the
engine's own input at that moment and the history before it is the loan's.
catchup-posting and escrow-review are the first two.

**The transfer package.** `writeTransferPackage` writes, for loans boarded
by transfer on one date, the twelve files of the servicing app's sample
layout (`apps/servicing/fixtures/transfer-batch-demo/LAYOUT.md`), encoded by
its own codec, ported in `src/boarding/ported/`. So a package reads back
through the decoder the servicing app boards with, as the sample does. The
vendored sample is never edited. Four things go beyond the sample:

- the payment history is the loan's life, not 24 months: one row per
  installment with the day it was paid in full, off the cashiering ledger.
  After the layout's columns each row carries how the prior servicer split
  the payment that paid it: principal, interest and escrow;
- `correspondence_file.csv`, the file the sample lacks. It holds the prior
  servicer's periodic statements, each with the late fee its system charges
  (cashiering's `lateChargeAmount` on the note's terms), its late-charge
  notices, escrow analysis statements, ARM notices, calls, and the notice of
  transfer. It also holds the documents of record the prior servicer keeps:
  the lender's mortgage-insurance disclosure (the original value and the
  termination dates), the life-of-loan flood determination (its zone), a
  repayment plan it agreed, the court's notice of a petition, and its notice
  of a servicemember's rate cap. The spec names the file (spec 1-1 :59), the
  boarding service takes it as a tape kind, and the decoder reads its twelve
  files by name, so it changes nothing that boards;
- four tape columns after the layout's own: `late_charge_max`, the note's
  dollar cap; `mi_original_value` and `mi_termination_date`, the mortgage
  insurance's original value and the date it ends automatically (12 U.S.C.
  4902(b)); and `flood_zone`. The layout has a column for none of them, so
  no package boards one;
- the flags and details the generator's facts call for: a repayment plan in
  `lossmit_file.csv` with `lm_in_process` Y, a petition in `fc_bk_file.csv`
  with `bk_active` Y, and a servicemember's cap with `scra_active` Y and its
  reason. A servicemember's tape carries the note's rate and P&I, as the
  sample's does; the history bills the capped payment.

A defect that enters at boarding is planted in the package: a tape cell, or,
for D-24, a row of the history. A defect in the prior servicer's books, D-25,
is written from its twin's history, so its package differs wherever the books
do. The writer labels whatever differs from the clean twin's package, cell
by cell: the planted cell is the root, and every other cell it reached is a
symptom. So is each cell a reviewer's checks flag because of it, though the
cell holds what it should (`PackageDefect.flags`: D-24's next due date, D-12's
P&I). The manifest is shaped like the sample's: each file's hash, size and
rows, and `designed_outcomes` with the gate's hard failures and warnings
(none planted), the defects planted for the gate not to see, the clean
twins, and the labels. `npm run env:transfer-package` writes packages to
disk (`--each` adds one of each defect alone), and
`apps/servicing/scripts/board-life-package.mjs` boards them through the
servicing app's own boarding (see boarding-triage).

**The demo loan.** `demoLoan()` (`demo.ts`) is the plan's first demo as a
scenario. It is a 30-year fixed Fannie Mae loan at 90 % with borrower-paid
MI and escrow, paid by bill pay. The first payment is due on 1 March 2026.

- **The transfer.** Another servicer's until 16 December 2027, then ours,
  with the Yes escrow cell and no cap on the tape.
- **Year 3.** March is missed. The $50 capped late charge is assessed on day
  16, the call comes on day 17, a promise on day 22 ceases the calls, and
  the borrower catches up on 5 April.
- **Year 4.** A tax reassessment and a renewal increase make the analysis
  for March 2030 a flagged shortage, and bill pay sends the old amount for
  March to suspense.
- **Years 5 to 10.** The MI ends at its 78 % date on 1 March 2035, and the
  loan is paid off in September.

It comes with its clean twin, a twin for each defect, the defective one with
both, and their four packages.

Two places it departs from the plan, each the engines' doing:

- The transfer is in December, not January. It was set there when the
  generator used the cashiering engine's blanket shield, which spares every
  installment due within 60 days of a transfer (cashiering-11) and would
  have spared March's charge. Since life 1.2.0 the shield spares only a
  payment the prior servicer received on time, so a January transfer would
  charge a missed March too; the date stays where the demo was set.
- Year 4's short payment draws no late charge. Cashiering counts suspense
  toward the P&I basis (decision 2.7-Q1, latecharges.ts:58-66), and the old
  amount covers the P&I. The calls come all the same.

**The month-end projection.** `monthEndRow(loan, month)` and
`bookTape(book, month)` return what a partner's tape carries, under the m3-v1
profile's keys: terms, balances, status and dates, a twelve-month pay
string, the escrow balance, twelve months of cash flow, and the PMI,
foreclosure and bankruptcy fields. The tape writer lays them out. The month
a loan pays off or transfers out is measured on the day it closed, so an
installment still in grace at a payoff never ages to 30 days.

A loan still being paid always has a next due date. The ledger runs one
installment ahead of the month, so a borrower who paid next month's
installment early has none open at the month-end. Since life 1.2.0 the
month-end's own `next_due` is then the installment after the one interest is
paid to, as it is on every other month-end, and its remaining term counts
from it; the projection copies both. (Under 1.1.0 the month-end's was null
there, and the projection filled it, which is the fix the tape row took
first.) The payment the month-end reads is still next month's installment's,
the one just paid, so no tape cell moved. The round trip below has 2,916
such rows out of 15,385.

**The tape writer.** `writeTape(book, month)` (`src/life/tape.ts`) writes a
month's tape in the m3-v1 layout that `@hm/partner-book` reads:

- one row per loan on the servicer's books at the month-end;
- the profile's 118 columns, in its order, with its header text;
- the month's last day as the as-of date, on every row.

`tapeStream(book)` writes a tape for every month, 131 of them for the
default ten-year book. `writeSupplement(book, month)` writes the supplement
that goes with each tape, because the layout carries no date of birth. With
`{ servicer: "prior" }`, both write the prior servicer's files for a loan
transferred in.

Each cell is the projection's value, in the form a partner's export gives:

- **Dates** are m/d/yyyy. A real tape writes the year in two digits, and the
  reader puts a two-digit year in the century nearest the day it reads it.
  Four digits keep the round trip from depending on the clock.
- **Money** is dollars and cents, with no symbol or grouping and a minus
  sign before a negative.
- **Rates** are in percent. A rate of 1 or less carries its percent sign,
  because the reader takes a bare one for a fraction. The PMI rate is in
  basis points, the form the one borrower-paid loan on a real tape uses.
- **Flags and codes.** Flags are Y and N. Codes follow `M3_NOTATION`, which
  uses the sample partner's notation where it has one, and "Current
  Occupancy" fills both of its columns. A code with no notation stops the
  writer.
- **Loan numbers.** A loan number on two rows of one tape stops the writer
  too. The reader would keep the first row and drop the second as a
  duplicate, which is T-01's damage and not a clean tape's. The generator
  draws loan numbers at random from a hundred million, so a book of
  thousands of loans can draw a pair.
- **Pay strings** are written as the projection writes them.

A column the projection has nothing for is left empty: FICO, a BPO, the
property's rooms, the investor's economics. The writer invents nothing.

**The round trip.** `tape.test.ts` writes a 200-loan book over ten years,
with transfers out on: 131 tapes and 15,385 rows (life 1.2.0). It reads each
tape back through `readBook`.

- The reader raises no exception.
- Every fact it keeps equals the projection's, and so does every field of
  the `ImportedLoanRecord` it makes.
- Every loan still being paid has a next due date, the month after the
  interest paid-to date, with the remaining term counted from it.
- The same seed writes the same bytes.
- A test holds the writer's columns equal to the profile's, and a workbook
  of the same rows reads the same as the CSV.

What the layout cannot carry, the record does not have: the co-borrower, a
mailing address, and the loan's purpose (the projection has none).

The contract's status is the reader's, not the projection's. A closed loan
keeps its own status; otherwise the MBA status decides. "C" is current at
zero days, and a bucket is delinquent by its days. The projection's status
follows the Regulation X count instead. At the end of a month shorter than
31 days, a loan one payment behind is under 30 days by that count and 30 by
the MBA's. So the contract says delinquent where the projection says current
on 104 of the 15,385 rows.

**Tape-stream defects** are what a delivery does to right values. The 47 in
docs/synthetic-data-defects.md are wrong values in a servicer's records;
these are their own family, in `src/life/tape-defects.ts`. All five are
built, each in the forms a request may name (`variant`):

| ID   | Defect                                        | Forms                                   | Loads                                    |
| ---- | --------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| T-01 | a month missing, or last month's sent again   | `missing`, `resent`, `relabeled`        | not until the partner sends it           |
| T-02 | a renamed column                              | `required`, `optional`                  | refused by name; or read, the fact empty |
| T-03 | leading zeros stripped from a column of codes | `stripped`                              | once the codes are padded back           |
| T-04 | a column of dates mangled by a spreadsheet    | `two_digit_year`, `serial`, `day_first` | as delivered; day first once re-read     |
| T-05 | an as-of date that drifts from the month-end  | `export_date`, `prior_month_end`        | once the as-of is the month-end          |

`plantTapeDefects(book, stream, requests)` plants them in a written stream.
A request names its months, or reaches each tape at a rate. The rate, the
form and the column (for T-02 and T-04, which reach one) are drawn from
streams keyed by the book, the defect and the month, so a defect's months
move with nothing else. A definition's own draws (T-02's new header, T-05's
export day) are under the month's key, apart from the planter's: when they
shared the stream that drew the month, a month drawn at a low rate always
read a low number from it, and every rename was a column's first and every
export ran the first business day after the month-end.

- **Root causes.** Each definition gets the whole stream, so one that drops,
  repeats or renames a file has the stream to do it in. It returns each value
  it changed: the file, row and column, the true value and the planted one.
  The labels are the generator's `DefectLabel` with the file added.
- **Symptoms.** `tapeSymptomLabels(planted, read)` finds them by difference,
  as a twin's are found. It reads each planted month's clean and planted
  files with the reader it is handed. Every difference in the records, the
  facts, the cells kept under `raw`, the exceptions or the refusal is a
  label.
- **How each loads** (`loading`) is stated per form, and a test holds it to
  the reader: a form that loads as delivered has no symptom at all, one
  loaded once corrected has symptoms and is not refused, and one the partner
  must send again is refused or is not the month's tape.
- **Why the reader is handed in.** The life generator cannot import
  `@hm/partner-book`, because its profile reaches `node:zlib` through the
  vendored workbook reader. The tests hand it `readBook`, a dev dependency
  here as it is in refi-review.

**T-01** is the stream. A month's file never comes (`missing`), or last
month's comes in its place, under its own name (`resent`) or under this
month's (`relabeled`). The planted file's `month` is the month it was
delivered for; its rows and as-of are last month's. Missing, every row of the
month is read from one stream and not the other. Sent again, every row
reads as last month's.

**T-02** is the export's configuration. One header is written in other words
(`T02_RENAMES`, none of which reads as another of the profile's headers). A
`required` one gets the file refused by name, and every row is lost. Any
other is read, with that column's fact empty on every row and its cells kept
under `raw`: a renamed "MBA Delinquency Status" leaves the reader to date
delinquency from the next due date to the as-of.

**T-03** is a file opened in a spreadsheet. A column of digits is read as a
number and loses its leading zeros. On the m3 tape that hits two columns:

- a ZIP code that starts with 0. Massachusetts and New Jersey are the
  generator's states with one;
- every pay string whose oldest month was current, so "000000000000"
  arrives as "0". That is 12,916 of the 15,385 rows.

The reader takes both as written. The record's postal code, the ZIP fact
and the pay-string fact change, and nothing else does. The review reads
only the pay string's last character, which survives. Text columns are
found by position, so a renamed header does not hide one.

**T-04** is a spreadsheet's date format, on one of six date columns that
carry a date on every live loan (`T04_COLUMNS`; the as-of is T-05's):

- `two_digit_year`, "5/1/57". The reader puts a two-digit year in the
  century nearest the day it reads it, which is right for every date here
  read near its month: no symptom.
- `serial`, Excel's day number, "57100". The reader converts it: no symptom.
- `day_first`, "1/5/2057" for 1 May. The reader takes a date month first,
  so a day of 12 or less reads as the month, silently, and a day over 12 is
  an `unreadable_cell` exception. A day the same as the month reads right,
  and is not changed.

**T-05** is the export's as-of: the day it ran, one to four business days
after the month-end (`export_date`), or last month's end
(`prior_month_end`), on every row. The rows are this month's. The reader
takes the tape's own as-of when it carries one, so the observation is filed
under it.

**Two defects drawn for one month are merged.** Both are planted, each where
it happens to a delivery (`stage`): the export writes the as-of and the
headers, then a spreadsheet rewrites codes and dates. They rewrite different
parts of the file, and a real delivery carries several at once: the
spreadsheet that strips a ZIP code's zero also rewrites a date column. A
symptom of a merged month belongs to each defect whose own plant shows it,
and to the group when none does, as a twin's do. In the test, a renamed MBA
status and an export-date as-of together make the reader call current loans
delinquent, which neither does alone. T-01 is the exception, because it
replaces the month's file whole:

- a defect drawn at a rate for a month T-01 is in is skipped;
- a T-01 drawn at a rate for a month another defect was asked for by name
  is skipped;
- two asked for by name, T-01 among them, are refused.

Every skip is reported in `skipped`, with the reason. Skipping rather than
redrawing keeps each defect's months its own draw: a second defect moves
none of the first's.

**Not covered yet:**

- the other 36 defects of the catalog;
- foreclosure, forbearance, trial plans and modification, whose tape fields
  are present and always empty; a bankruptcy's plan, trustee, discharge and
  dismissal; loss mitigation beyond a repayment plan; the end of a
  servicemember's service, and the cap on an ARM;
- what follows a flood zone boarded wrong (D-15): flood-insurance tracking
  and force-placement are not modeled;
- returned payments and NSF fees. The file's returned share is read and not
  drawn;
- the interim escrow analysis an MI termination calls for. The next annual
  analysis returns the surplus;
- early-intervention notices, a call that reaches the borrower, and a
  borrower's request to cancel MI;
- what follows a loan boarded non-escrowed: its taxes go unpaid and its
  insurance lapses, and nothing here models the tax sale or the force-placed
  policy;
- `book.loan_age_distribution` is read only when a scenario boards a book by
  transfer;
- a run longer than the decade. A scenario may ask for up to 360 months, but
  a loan its curtailments pay to zero before maturity ends on a last payment
  that overpays, and neither the overage nor the escrow balance is refunded.

A thousand loan-decades run in about 3.5 seconds, and a test holds them
under 15. Reading the round trip's 131 tapes takes about five.

**Checked against the servicing app.** docs/cross-check.md boards 178
generated loans in the servicing app, replays their receipts and steps its
own cashiering, delinquency and Metro 2 cycles every day, about 305
loan-years. Away from logged defects the two agree on every receipt's split,
installment, late charge and month-end balance; it also lists two generator
bugs and three unlogged credit-reporting defects. Its figures are life
1.0.0's, and the harness (`apps/servicing/scripts/cross-check-life.mts`)
refuses to read back a run drawn under another life version. Life 1.2.0
fixes both generator bugs (a drawn MIN carries its Mod-10 check digit,
computed by the port of the boarding gate's own `min.ts`, and a month-end
paid ahead has a next due date) and steers around the engine half of
cashiering-11, which the generator walked into on every transfer. The batch
was rerun on it on 26 October 2026 (docs/cross-check.md, "Life 1.2.0"): it met
neither bug, and no field named cashiering-11.

### The demo page

`npm run env:demo -w @hm/environments` writes `playground/dist/demo.html`,
the first demo as one self-contained page titled "Synthetic Loan
Histories", its data inlined (about 587 KB). `scripts/build-demo.mjs`
bundles `src/demo/page-data.ts` from the workspace's sources, runs it, and
fills `playground/demo/template.html`. No figure on it is typed by hand, and
the same code writes the same bytes.

It shows the demo loan by year, in its clean history and its defective twin,
in three lanes:

- **Inside the servicing system.** Each month's receipts and their splits,
  late charges, escrow analyses and disbursements, calls, the transfer and
  the payoff. On the twin, every row a label names carries its defect, and
  what the clean history did that the twin did not (the bills, the
  analyses, the calls) is struck through.
- **The monthly tape.** The m3-v1 row `writeTape` writes for the loan at
  each month-end: fourteen of its 118 columns, and the whole row on demand.
  Cells that differ from the clean tape are underlined, and each year lists
  what its months did that no column carries. The year-4 payment rises in
  February 2030 with no reason given.
- **Moments a model is asked to act.** Boarding triage on 16 December 2027
  (boarding-triage's own spec cases on the demo's packages), the catch-up
  on 5 April 2028 and the flagged analysis of 29 December 2029. Each is read
  off the history with its environment's task builder (`catchupTaskAt`,
  `reviewTaskAt`), and the build stops unless the environment's own filters
  would pose it. The analysis's build stops too unless its payment today is
  the one on the loan's terms for the next installment, worked out from the
  history's analyses apart from the moment. Each shows the task abridged,
  the reference policy's answer through the environment's tools, and every
  graded field. The twin poses no analysis, because it boarded
  non-escrowed.

Below the lanes are two of the loan's calls, as the contact center writes
them for the history chosen (page 1.1.0). The center draws the demo loan as
it draws any loan, with one pin, `escrow_call`; unpinned, the year-4 call is
drawn as a question about the payment change. The borrower drew Spanish, so
both calls run through an interpreter. Each call shows its row, what the
record held that day, the lines that say a figure (with the interpreter's
relay of each), the whole transcript on demand, the agent's note and the
system's notes around it.

- **Year 3, the promise.** On day 22 of the missed March the borrower calls,
  is told the $2,997.99 past due with the $50.00 charge in it, and promises
  $5,945.98 by 5 April, the receipt that keeps it. Before it are the text
  reminder and the dialer's voicemail. On the twin, the promise is
  $4,664.65, the charge $113.77 and no escrow.
- **Year 4, the escrow call.** On 4 February 2030 the borrower asks about
  the flagged analysis. The agent quotes the escrow payment on the loan's
  terms today, $662.42, and the new $1,130.68, then the deficiency of
  $441.98 and the shortage of $2,517.25 with their installments. Then the
  agent reads the statement's three lines: both county taxes and the
  January renewal, which falls after the run date. The year was overdrawn in
  January, so there is no low line, and the agent says so. Each statement
  line is shown beside the transcript time that read it. The twin ran no
  analysis, and the page says why no call came.

The page data refuses to build when a figure it shows disagrees with the
history:

- a promise that is not the receipt that kept it;
- a number said or written that the record does not hold that day;
- statement lines that are not the engine's over `statementYearOf`;
- a payment today that is not the one escrow-review poses;
- a plan's figures that are not `analysisDecision`'s;
- a day the promise card counts (the late charge's, the dialer's first
  attempt, the call's) that is not the history's, a promise that is not
  everything owed by its day, or a dialer call while it was open.

`check-page.mjs` renders the calls for both histories and holds the
rendered text to each note and statement line.

Below the calls is what missing the defects costs on the twin:

- the late charge above the note's cap and its refund, $63.77, from
  `lateChargeAmount`;
- the bills its escrow never paid, $35,904.96 of them county tax.

No engine prices a tax penalty, so the page says so rather than inventing
one.

Last is a book of 1,000 loans drawn from `calibration.json` (seed
`demo-book-1`), read against every test in `calibration-acceptance.json`
(`src/demo/book-panel.ts`). Each test shows our figure, the figure it is
held to, the tolerance, and whether the book is within it, outside it, or
not a verdict. Each also shows the target's provenance and whether the book
meets the test's sample floor. Every target and tolerance is read from the
two files, the ones the acceptance file states only in words too (0.01 on
the delinquency total, 0.08 on the cure, 25 % on each contact status), and
words the panel cannot read stop the build. On 24 October, under life
1.2.0, 10 were within, 7 outside and 3 not a verdict. The seven outside:

- returned payments, which are not generated;
- missed months, a check that reads low;
- the all-loans delinquency stock, whose target includes FHA and VA;
- the quarterly roll from current, 1.16 % against 0.86 % (±30 %), which a
  quarter-end reads above the monthly chain (below, "Calibration"); the
  cure is within;
- contacts by delinquency status, a design-choice split that the
  borrower's own calls do not reach;
- the note rates, whose 4 to 5 % bin reads 18.9 % against 16.5 % (±2
  points), on a fifth of the test's sample floor;
- loan-to-value, drawn at origination against a mark-to-market target.

The ARM share, outside under 1.1.0 at 5.5 %, is 4.3 % against 4.3 %.

The demo loan draws from the calibration's typed defaults, as the three
environments do, so the page shows the tasks they pose. `demo-page.test.ts`
runs the build. It checks that the script parses and renders every view
against a stub DOM (`playground/demo/check-page.mjs`, which the build runs
too), and holds the page's data equal to `demoPageData`. It then works
every graded field, every cost and both calls again from the environments,
the ports and the contact center.

## Calibration

`src/life/calibration.json` holds the rates the life generator draws loan
histories from. The generator reads every key of it as written: loading the
committed file gives no warning, and a test holds that. Each of its 28 keys
carries a value, a unit, a kind, a source URL with the date it was fetched,
the source's terms, and a note on what the figure is and where it stops. 18
are `public`. 10 are `design_choice`, with source `none` and the reason
nothing public fits.

`src/life/calibration-acceptance.json` is what a validation sample is held
to: payment arrival day, late fees, short and returned receipts, missed
months, delinquency stock and transitions, contacts by status, reason mix,
note length, transactions per loan-year, defect rates and the book's
distributions. Each test names the key it checks, how its target is read
from that key, the smallest sample it means anything on, and a tolerance.
Every tolerance is a design choice and says why. `calibration.test.ts` holds
both files to the generator's key list (`CALIBRATION_KEYS`, imported, not
copied), a source and date on every public value, no NaN, distributions that
sum to one, every derived figure (a mean, a ratio, an interpolated median, a
share of counts) equal to what it is derived from, and the acceptance
targets the calibration gives today. It also holds the reader to each
conversion below, and a book drawn from the file to the file.

Version 2026-10-23, every source fetched that day:

| Source                                                                       | Keys                                        | Terms                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| MBA National Delinquency Survey, Q2 2026 press release (MBA's NewsLink copy) | the two delinquency stocks                  | The press release, quoted with attribution. The survey's tables are licensed; not used. |
| New York Fed Household Debt and Credit Report, 2026Q2 data file              | the quarterly roll and cure                 | New York Fed Terms of Use; attribute "New York Fed Consumer Credit Panel / Equifax".    |
| FHFA NMDB Aggregate Statistics (outstanding 2026Q2, originations 2025)       | ARM share, the three book distributions     | CC0 1.0.                                                                                |
| Census ACS 1-year, 2021 to 2024, tables B25103 and B25141                    | tax and insurance medians, and their growth | U.S. Government work; cite the table.                                                   |
| Freddie Mac PMMS, weekly 30-year, January 2016 to 22 October 2026            | `refi.pmms_30y_series`                      | Use with attribution; alteration strictly prohibited.                                   |
| OpenFEMA DisasterDeclarationsSummaries v2                                    | declarations by month                       | OpenFEMA terms: the non-endorsement statement, the endpoint and the access date.        |
| CFPB, Mortgage Servicing COVID-19 Pandemic Response Metrics (May 2022)       | contacts per loan-year, handle time         | U.S. Government work.                                                                   |
| CFPB Consumer Complaint Database, 2025 mortgage complaints                   | reason mix                                  | CC0. Not a statistical sample, and a skewed proxy for why people call.                  |
| U.S. Mortgage Insurers' 2024 report (MBA NewsLink summary), over NMDB        | `mi.share_of_loans`                         | Quoted with attribution.                                                                |

- **Not used:** Fannie Mae and Freddie Mac loan-level performance data. Their
  terms need counsel first. The keys they would measure (monthly rolls,
  payment timing, curtailments, transfers) are design choices that say so.
- **The PMMS series is copied as published.** A replay that shifts, rescales
  or splices it uses altered content, and is a question for counsel before
  any generator does it. The generator does not replay it (below).
- **The escrow share is open.** The ACS asks it, but only its microdata
  answers. That needs the 251.5 MB PUMS housing file or a Census API key; the
  API refused keyless requests on 23 October. Until then it is a design choice
  of 0.8.
- **HMDA was not read.** It covers originations only, and the NMDB covered
  both the outstanding book and 2025's originations.

**How each key is read.** `src/life/calibration.ts` has a reader per key. It
takes the part of the value the generator draws from and converts it to the
generator's unit; each conversion is stated there and here. "Check" means
the generator does not draw the figure: its draws make it, and
`calibrationCheck` reads it off a book.

| Key                                                          | Read                                                      | Used as                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `delinquency.conventional_30plus_share`                      | the share, 2.72 %                                         | check: month-ends one payment or more past due                                                                |
| `delinquency.all_loans_30plus_share_sa`                      | `total`, 4.37 %                                           | reported only                                                                                                 |
| `delinquency.roll_current_to_30`, `delinquency.cure_from_30` | `trailing_8_quarter_mean`: `to_30_60_late`, `to_current`  | the monthly roll and cure whose quarter is the stated one: 0.357 % and 16.3 % a month (below)                 |
| `delinquency.roll_30_to_60`                                  | the share, monthly, 0.33                                  | a behind borrower misses again                                                                                |
| `payment.day_of_month`                                       | `arrival_share`; `due_day` 1 and `grace_days` 15 required | the day inside grace: each bin spread over its days, a day off moved within its bin; early payers, below      |
| `payment.late_within_grace_share`                            | the share, 0.508                                          | within grace, for a borrower who pays: share / (1 − m)                                                        |
| `payment.late_after_grace_share`                             | the share, 0.042                                          | after grace in the month: (share − m) / (1 − m), less late partials (below)                                   |
| `payment.partial_share`                                      | `partial_receipt_share`, and `returned_receipt_share`     | short receipts, 1 %; the returned share is read, not drawn                                                    |
| `payment.curtailment_share`                                  | the share, 0.03                                           | receipts carrying extra principal                                                                             |
| `payment.missed_month_share`                                 | the share, 0.012                                          | check: installments on current loans not received by month end                                                |
| `contacts.per_loan_year`                                     | `inquiries_per_loan_year`, 2.0                            | inbound contacts a loan-year; a borrower who is behind calls three times as often                             |
| `contacts.handle_time_minutes`                               | `min` and `max`, 4.3 and 19.8                             | √(min · max) = 9.2 minutes, each call spread lognormally around it                                            |
| `contacts.inbound_reason_mix`                                | `counts` over their total                                 | every inbound contact's reason                                                                                |
| `escrow.share_of_loans`                                      | the share, 0.8                                            | loans without MI escrow at the rate that brings the book to it                                                |
| `escrow.tax_annual_median`, `escrow.insurance_annual_median` | `with_mortgage_usd`, $3,580 and $1,450                    | the first year's bills, in cents, scaled by the home's value                                                  |
| `escrow.tax_growth_yoy`, `escrow.insurance_growth_yoy`       | `medians_with_mortgage_usd`                               | (newest / oldest)^(1 / years) − 1: 5.0 % and 8.7 % a year                                                     |
| `arm.share_of_outstanding`                                   | `loans`, 4.3 %                                            | the ARM share                                                                                                 |
| `mi.share_of_loans`                                          | `enterprise_originations_2025_cltv_over_80`, 0.352        | MI on every loan above 80 % loan-to-value                                                                     |
| `book.note_rate_distribution`                                | `loans`                                                   | note rates; each open bin a point wide, like its neighbor                                                     |
| `book.ltv_distribution`                                      | `at_origination_enterprise_2025.cltv_loans`               | loan-to-value at origination; over 97 is 97; 70 and under runs down to 39.7, which gives the stated 73.3 mean |
| `book.loan_age_distribution`                                 | `loans`, in years                                         | a boarded book's ages in months; 4 years and under from zero; over 10 to 19.5 years, which gives a mean of 80 |
| `refi.pmms_30y_series`                                       | `rows`, weeks as M/D/YYYY                                 | the mortgage rate's start, pull and spread (below)                                                            |
| `disaster.declarations_by_month`                             | `major_disaster_individual_assistance_areas`, by month    | a disaster in the loan's county, per loan-month by calendar month (below)                                     |
| `transfer.annual_rate`                                       | the share, 0.04                                           | 1 − (1 − rate)^(1/12) a month, when a scenario turns transfers out on                                         |
| `defects.field_error_rates`                                  | each defect's `rate`                                      | the rate a defect is planted at over its eligible units                                                       |

m is the monthly miss from current. A share the file gives over installments
on loans current at the due date counts the missed ones too, and the
generator decides a miss first, so a borrower who pays is late within grace
s / (1 − m) of the time.

**The roll and cure.** The file's are the New York Fed's quarterly
transitions: 0.864 % of accounts current at one quarter's end are 30 to 60
days late at the next, and 41.2 % of those 30 to 60 days late are current.
The eight-quarter means are read, not the latest quarter, because one quarter
moves (0.69 % to 1.00 % for the roll) and the acceptance test holds a book to
the mean. The generator draws monthly. Each month a current borrower misses
with the roll p. A borrower who is behind cures with c, misses again with
the roll from behind r, or pays the oldest installment and stays as far
behind. Whether a loan is current or behind is then a two-state chain, and a
quarter later:

```
behind → current     = c / (p + c) · (1 − (1 − p − c)³)
current → 30 to 60   = p / (p + c) · (1 − (1 − p − c)³) − p · r²
```

Three payments behind means all three months were missed, p · r². The reader
solves both equations for p and c by bisection, holding r at 0.33: 0.357 %
and 16.3 % a month. Dividing by three would be wrong both ways. A loan that
falls behind and catches up inside a quarter is in neither count, so the
monthly roll is above a third of the quarter's (the file's own floor, 0.28 %).
A cure that leaves 41 % current a quarter later is 16 % a month. The chain
does not fit two figures the file gives beside these. It puts 0.04 % of
current loans 90 days late a quarter later, against the file's 0.20 %. And
it puts 20 % of loans one payment behind 90 days late a quarter later,
against the file's 16 % of those 30 to 60 days late.

**Payments.** The arrival bins give the shape inside grace and one split.
Of the installments paid by the due day, 0.14 / (0.14 + 0.31) = 31 % are paid
before it, and that is the share of borrowers drawn in the habit of paying
early. An installment is also not in by the end of grace when a partial
payment's rest comes after it. That route is the partial share times the
chance the rest, 5 to 25 days after the first piece, lands past day 16. The
after-grace draw is lowered by it, so a book's late charges are the file's
4.2 % and not a tenth more. A payment drawn for a weekend or a holiday inside
grace arrives on the next business day of its own bin, else the one before
it in the bin. Rolled forward alone, a fifth of the payments drawn for days
2 to 5 arrived on days 6 to 10, and the bin read 0.21 against the file's
0.27. A payment after grace stays in its month; one never received in the
month is a miss, drawn apart.

**The mortgage rate.** The generator reads three figures from the PMMS
series: its newest print (7.32 % on 22 October 2026), where the path starts;
its mean over the last ten years of months, which the path is pulled toward;
and the spread of its month-to-month changes, which sets each month's step.
It walks a path of its own from them. Nothing replays, shifts, rescales or
splices the series.

**Disasters.** The hazard the generator draws is a declaration covering the
loan, which is what opens disaster relief on a Fannie Mae loan: a major
disaster with Individual Assistance in the loan's county. So the series read
is the designated areas under those, and the others in the value are not.
A county's chance of a designation in a month is that month's areas over the
3,143 counties and county-equivalents of the fifty states and DC, averaged by
calendar month over the years: 0.15 % in November to 1.7 % in September. It
treats every county alike. A month that designated more than a fifth of the
counties at once is nationwide, not a hazard to a house, and is left out:
March and April 2020, the COVID-19 declarations.

**Open bins.** A bin open at one end is closed by the quantity's own limit
where it has one: an age starts at zero, and Fannie Mae lends to 97 %
loan-to-value. When one bin is still open and the value states the
distribution's mean, its free bound is the one that gives that mean. Any
other open bin is as wide as the closed bin beside it. The note rates' two
open bins are a point wide, and their mean, 4.39 %, is the stated 4.4 % to
its rounding.

**What a book shows.** Four years of 1,500 loans drawn from the file, against
it (life 1.2.0): 50.1 % of installments within grace (50.8 %), late charges on
3.8 % (4.2 %), a borrower's monthly roll 0.37 % (0.357 %) and cure 16.4 %
(16.3 %), 0.94 % short receipts (1 %), 30.6 % of on-time payers early
(31.1 %), 2.06 contacts a loan-year (2.0). Every arrival bin lands within the
acceptance test's 0.02 of the file's: 26.7 % of installments on days 2 to 5
(27 %), 11.7 % on days 6 to 10 (12 %), 11.7 % on days 11 to 16 (11.8 %). A book from the defaults
differs in each the file moves, and a test holds both. The arrival shares,
within grace and around the due day, are read on due dates that are a
business day following one: around a weekend, a payment drawn for the day
before or after the due date lands on the same business day as one drawn
for it.

**Where the file and the generator part:**

- **The missed-month share is not drawn.** The public quarterly roll makes a
  current borrower miss 0.36 % of months, and a book has 0.47 % of
  installments not in by month end. The file's design choice is 1.2 %, which
  its own note bounds below at 0.28 %. Drawing 1.2 % would put three times
  the New York Fed's quarterly roll on the book. It stays a check, and reads
  low.
- **A quarter-end finds more loans behind than the chain.** The rest of a
  partial payment can come after the month ends, and a disaster month makes a
  miss likelier. So the quarterly roll reads over the file's 0.864 %: 1.01 %
  on the four years of 1,500 loans above, inside the acceptance test's 30 %,
  and 1.16 % on the demo page's decade of 1,000, outside it.
- **The reason mix is of complaints.** Every inbound contact draws its reason
  from it, so disputes (loss mitigation 23 %, foreclosure 7 %) are as common
  among a current borrower's calls as among complaints. The file's own note
  says the mix is a skewed proxy for why people call.
- **Loan-to-value is drawn at origination.** The acceptance test reads the
  mark-to-market bins, which describe a seasoned book after house prices
  moved. The generator has no house-price path to meet them with.
- **The ARM share is all loans', 4.3 %.** Enterprise loans alone are 1.1 %.
  The acceptance test reads the all-loans figure, so the book follows it.
- **The ACS medians are 2024's.** A book starting in 2026 bills its first
  year at them, not grown to the book's start.
- **The book's delinquency runs deep.** A monthly cure of 16 % against a roll
  from behind of 33 % puts more of the behind loans past 90 days than MBA's
  buckets show.

## The contact center

`src/contacts/` is not an environment either. It writes what a
subservicer's contact center would hold for a book the life generator wrote:
the contacts, the call transcripts, the comment log, and planted, labeled
call and note defects for a call-QA environment to grade.

- `contactCenter(book)` derives every loan's contact rows, promises,
  bankruptcy, cadence and notes.
- `transcriptOf(center, book, id)` writes one call's transcript when asked.
  A 300-loan decade holds about 2,700 handled calls and 1.65 million words
  (life 1.2.0 and contacts 1.2.0, on the defaults), so transcripts are not
  written in advance.
- `plantContactDefects(center, book, requests)` makes the defective twin and
  its labels.

Every draw comes from a stream keyed by the book's seed, the loan and the
month, delinquency, event or call, and none reads another loan. So a center
is a function of its book's seed, byte for byte, and a loan's contacts are
the same in a book of 30 as in a book of 300.

Every stream hangs off the contact center's version too
(`CONTACTS_VERSION`, `contacts/<version>/<book seed>`), so any change to
what it draws or writes draws every center again. It is 1.2.0:

- the record holds the annual statement mailed with an analysis and the
  analysis's plan, and a call about the escrow analysis is answered from
  them (below, "The escrow call");
- C-05 and C-08 plant their wrong figure in that explanation;
- no statement goes to a borrower more than 30 days behind at the
  analysis;
- a pin draws the borrower's call about each one;
- an interpreted call's note no longer reads the interpreter's relay of the
  question as a second one.

1.1.0, since life 1.2.0, made a petition the scenario dates the center's
case, said a complaint with no filler inside it, kept the word that makes a
number a rate, and ended the transfer shield on the transfer date plus 59
(below, "The record on the day").

**The rows** are shaped like the servicing app's `contacts` table
(`apps/servicing/db/migrations/0005_servicing_requests.sql:201`, with
`outcome`, `purpose`, the disclosures, the TCPA basis and the Reg F count
added at `0013_early_intervention.sql:53`). Each row holds:

- the direction, the mode (a call, the phone menu, the portal, an e-mail, a
  text or a letter), the day and the local time;
- the outcome, in the 11.1 spec's vocabulary ("wrong party" is
  `wrong_number`, "bad number" is `disconnected`), plus four of ours for the
  menu, the portal and mail received;
- live contact and its basis, QRPC, and whether the person passed the
  identity checks;
- the purpose, the reason and the resolution, the last because "an inbound
  contact resolved" is a rate-card event;
- the issue, and the earlier contacts on the same issue;
- the language and any interpreter, the duration and the handle time;
- the TCPA basis and consent, the Reg F count, the disclosures the agent
  marked, and a complaint voiced and logged.

Promises, a bankruptcy and each delinquency's cadence are kept beside the
rows.

**What the history decides:**

- **The outbound cadence.** It opens on day 17 of a delinquency (`plan.ts:16`)
  and makes an attempt at least every 7 days until the cure (`plan.ts:17`,
  `:151-155`). A pending promise ceases it until its date; a petition
  suspends it (`plan.ts:179-181`). On a debt-collector loan, the next call
  after a conversation waits 7 days (§1006.14(b)(2)(ii)). The dialer runs
  Monday to Saturday, in the morning, afternoon and evening, after 08:00
  and through 20:30 at the property (the voice window of 11.1 rule 8). On a
  Massachusetts loan it calls twice in seven days at most (940 CMR 7.04),
  and a welcome call stays a week away from the collection calls.
- **How an attempt ends.** About one in seven is a conversation. The rest are
  no answer, voicemail (one per number per 7 days, the 11.1 guardrail),
  busy, someone else answering, a refusal, a reassigned number (wrong party)
  or a disconnected one.
- **Written outreach.** The written early-intervention notice goes out
  between days 38 and 44, at most once in 180 days. A text reminder goes on
  days 6 to 9 only with consent, and a STOP ends them. Without texts, an
  e-mail reminder goes to a paperless borrower.
- **The calls each event brings.** An escrow analysis (more for a shortage
  or a flagged one), an ARM change notice, a transfer in, a disaster, a late
  charge, bill pay sending the old amount, an MI termination, a refund, the
  1098 in January, a payoff before and after.
- **Promises.** The scenario's promise calls, read through the history's
  behavior rows. A promise drawn on a call is kept when a receipt in the
  next three weeks keeps it; otherwise some are made and broken.
- **The pinned escrow call.** With `escrow_call` pinned
  (`ProfilePins`, beside `bankruptcy`), the borrower calls 4 to 40 days
  after each analysis an annual statement explains, on a stream of its own,
  and the call reaches an agent. The demo page and call-qa's escrow arms pin
  it.

**What it draws.** Every figure below is a design choice, named in
`derive.ts` and `profile.ts`.

- **The inbound volume, by the loan's status in the month.** The
  calibration's inquiries per loan-year are split 0.85, 3, 4.5 and 5 times
  over current, 30, 60 and 90+ days. That is the acceptance file's split
  (1.7, 6, 9 and 10 at 2.0, `contacts-per-loan-year-by-status`), so a change
  to the calibration moves all four. Each status's ordinary calls are its
  share less what its events bring, so the total lands on the share.
- **The reason mix.** Separate tables for a performing loan and a delinquent
  one. January and February add the 1098; an unescrowed loan has no escrow
  calls; a loan without MI has no MI calls.
- **The channel.** A share of each reason's calls is served by the phone
  menu (more than half of "did you get my payment"), and some reasons come
  by e-mail, text or letter. A portal user logs in about four times a year,
  and more after an analysis and in January. Most inbound contact ends in
  the menu or the portal.
- **Who calls.** Mostly the borrower or a co-borrower. Also a spouse not on
  the note (authorized, or with the borrower beside them, or refused), a
  housing counselor on a hardship 30 or more days late (the authorization
  arrives first), the borrower's bankruptcy attorney, and a caller who fails
  verification. A Spanish-speaking borrower (4%, or 40% with a Spanish
  surname) talks through an interpreter.
- **A bankruptcy.** A petition the scenario dates (`LoanLife.bankruptcy`,
  which D-37 plants on) is the contact center's case: its filing date and
  chapter, the attorney's notice one to three days later, and no discharge,
  because the history keeps the case open to its end. On a loan whose
  history dates none, the life generator draws none, so the contact center
  draws one on 2% of delinquencies that reach day 30, 70% of them under
  Chapter 13. Either way, from the petition no collection call is made until
  a Chapter 13 discharge, and every call after the attorney's notice carries
  the informational-only disclaimer. From the notice's day the ordinary
  calls draw no payment arrangement or hardship, and no agent asks when the
  borrower will pay. Where a boarding left the scenario's case off (D-37's
  twin), the servicer knows nothing of it from the transfer
  (`BankruptcyCase.known_until`) and calls as if none were open, as the
  history's month-ends report none. The history's payments know of a
  scenario's case (its charges accrue suspended) and not of a drawn one.
- **Handle time.** A lognormal around the calibration's mean, by reason (a
  hardship runs longest, a statement copy shortest), longer through an
  interpreter, with a 90-second floor.
- **Complaints.** About 4% of handled calls, more from an irritated
  borrower, weighted by reason toward the calibration's complaint mix. That
  is the one use of `contacts.inbound_reason_mix`, which is a complaint mix
  and not a reason to call.

**The calibration, in either shape.** `contactRates` reads the three
`contacts.*` keys through `loadCalibration` and takes a scalar or the file's
object: `inquiries_per_loan_year` (or a range's midpoint), a mean with its
`min` and `max` (with only the range, their geometric mean, 9.23 minutes),
and a mix's `shares` or `counts`.

Since life 1.1.0 the calibration reader reads the file's objects itself and
hands over the shapes the life generator's `monthHazards` draws from
(`simulate.ts:2199-2217`): a number of inquiries a loan-year (2.0, the
file's `inquiries_per_loan_year`), a number of minutes (9.23, the geometric
mean of its range) and the complaint mix as a list of pairs, from its
counts. The contact center takes those as the file's, with no warning. With
no file the reader's typed defaults stand (1.5 a loan-year, 7 minutes), and
the contact center says in its warnings that they are the reader's
defaults. The object shapes are still read, for a calibration that hands
them over, and a test holds both. On the 300-loan seed-7 book, drawn on the
defaults under life 1.2.0, with contacts 1.2.0:

|                                                        | Defaults               | The file, as the reader reads it |
| ------------------------------------------------------ | ---------------------- | -------------------------------- |
| Inquiries a loan-year, against the status mix's target | 1.38 against 1.35      | 1.82 against 1.79                |
| Current; 30, 60 and 90+ days                           | 1.31; 3.9, 8.1, 7.1    | 1.73; 5.0, 10.9, 9.3             |
| Mean handle time                                       | 6.82 against 7 minutes | 8.91 against 9.23                |
| Words in a transcript, on average                      | 391                    | 514                              |

Contacts 1.2.0 draws every center again, so the delinquent statuses, a few
hundred loan-months each, moved: under 1.1.0 they read 4.7, 5.5 and 7.2 on
the defaults.

**The life generator's own contacts.** The life generator draws a few inbound
contacts a year: a reason and a duration, flat across the year. The contact
center draws the volume itself, so the calibration is met once, and reads
only the scenario's promise calls, through the history's behavior rows. A
tape writer that wants the contact center's last contact date reads
`lastContactOn`.

**The record on the day.** `recordOn(life, day)` holds every figure an agent
may say or write that day. It reads the history as dated on or before the
day, plus the contact center's own records (the promise a call writes, the
bankruptcy notice, an authorization on file). The figures:

- the next installment and its grace;
- what is past due, with the late charges outstanding;
- the last receipt;
- the escrow balance on the last statement;
- the latest analysis, with its plan (`analysisDecision`), and the annual
  statement mailed with it (`statementYearOf`, read by `statementReading`
  under the labels the statement prints, `STATEMENT_LABELS`);
- the latest ARM change;
- the last tax and premium paid;
- the latest late charge, and the 1098;
- MI, a transfer, a payoff, the last Metro 2 month;
- the servicer's own constants.

A transfer carries the last day of its shield. §1024.33(c)(1) protects a
payment the prior servicer receives on time "during the 60-day period
beginning on the effective date of transfer", and the spec's example L
counts the transfer date as the first of the 60 (effective 2026-09-01,
window through 2026-10-30), as the life generator does. So `shield_until`
is the transfer date plus 59, and an agent asked about the transfer says
the 60 days start on the transfer date and run through that day. Under
contacts 1.0.0 the record put it a day later.

The facts come first and the text second: `checkTranscript` reads every
number back out of a transcript (money, dates in English and Spanish, rates,
the telephone number, the menu's keys, counts) and finds it in
`factNumbers`. A number the recognizer misheard is logged on its turn, and
a planted wrong amount is labeled. Every figure is written in digits, as a
recognizer writes them. A month said with its year ("January 2030") reads
as the year alone, which the record holds for each statement line; until
contacts 1.2.0 the date reader took it for the 20th and a 30.

**The escrow call.** A call whose reason is the escrow analysis, when the
record holds the annual statement mailed with it, is answered from the
analysis and the statement:

- which analysis it is, and when it went out with the statement;
- the escrow payment on the loan's terms today beside the new one, from the
  effective date. That is escrow-review 1.1.0's payment today, the analysis
  row's `old_payment`. Then the total payment from then. A call on or after
  the effective date, when the new payment is the one on the terms, says
  the change in the past tense;
- the decision and how it is handled, in the words of the servicing app's
  `decisionText` and `planText`: a shortage (and a deficiency) and its
  level installments over 12 months from the effective date, a surplus
  refunded by its date (and that it went out, once it has), or credited at
  so much a month;
- the statement's item (viii), one agent turn a line, in the engine's
  three templates with the month read aloud: "the {line} paid in {month
  year} was {amount} versus {amount} projected", "a {line} bill of {amount}
  paid in {month year}, which wasn't projected", "the low balance was
  {amount} versus {amount} projected". The demo's first reads "the county
  tax paid in May 2029 was $2,278.09 versus $1,687.49 projected", where the
  engine wrote "county tax paid 05/2029 was $2278.09 vs $1687.49
  projected". The agent adds that the projected low is the cushion when
  re-projecting the projection's own bills says it is. A line whose month
  runs past the run date is followed by a sentence saying the statement
  shows what the analysis expected, worded to hold whether the call comes
  before the bill or after it;
- for a year the engine cannot print the low of (escrow-4, an account
  overdrawn during the year), the bill lines without the low line, and the
  agent says plainly that the account was overdrawn, so the statement does
  not compare the low balance with the projected one. The agent's opening
  promises the low point only on a year whose statement compares it;
- the shortage question and the cushion, as before.

The interpreter relays each line with the same figures and month ("en mayo
de 2029"), each line's slots read under their own names. A test holds the
agent's figures to the engine's on every such call of the seed-7 book with
the call pinned: 1,853 calls and 5,724 lines, 1,536 of them after the run
date, 10 overdrawn years and 118 calls through an interpreter. Drawn, the
book holds 314 conversations about the escrow analysis, 257 of them with a
statement. A call about an analysis no statement explains (the first one, a
borrower behind at it, a year on two servicers' books, the prior servicer's
after a transfer), and a call about
the payment change, are answered from the analysis alone, with its tax and
premium totals of the last two years, as before.

**Transcripts.** A call's plan comes first: the record on the day, the
shape from the row, the agent's manner, further questions, side topics and
holds. The template writer then writes it:

- the menu, its recording notice and the agent's answer;
- the identity checks (two or three of the loan number, the address, the
  last four and the date of birth), or a refusal to someone unverified;
- the mini-Miranda or the bankruptcy disclaimer when needed;
- the question and its answer, each figure stated by a statement turn;
- a credit question, a complaint, a transfer to loss mitigation, a
  promise, side topics and small talk, holds;
- the recap and the close.

The words come from a small phrase grammar (`grammar.ts`): `[a|b]` picks
one, `{slot}` fills a figure and throws if the record lacks it. Leads,
fillers and restarts vary by the borrower's manner and the agent's. An
interpreter call adds the interpreter's Spanish after every agent turn and
the caller's Spanish before the interpreter's English.

The timing fills the row's duration exactly. Speech runs at each speaker's
rate, and the rest is dead air of at most 25 seconds a gap, or holds. Then
the recognizer adds noise:

- personal data `[REDACTED]`, and now and then an amount;
- numbers misheard (a digit, a teen for a ty) and logged;
- words misheard, dropped or `[inaudible]`;
- speakers swapped on a mono recording, crosstalk;
- two engine styles, one cased and one lower case.

On the defaults, the speech runs at about 99 words a minute across a call,
dead air included.

**Notes.** The comment log is one line a note: the loan, the day and time,
the user, an area code and the text.

- **System notes outnumber agent notes about nine to one.** Each dialer
  attempt, menu session, portal login, text and letter writes one, and so do
  the history's late charges, analyses, disbursements, transfers, payoffs
  and the 1098.
- **An agent writes one note per call handled**, from the call's turns: what
  was asked, what was quoted, what else came up. The note is in that agent's
  hand: capitals and codes, lower case, or sentences, each misspelled at the
  agent's own rate.
- **A collector often copies the last note on a delinquency forward**
  (`copied_from`), so its figures are of the day it was first written.
- **The escrow call's note is the escrow desk's (ESC)** and records what
  was explained: the escrow payment from and to, the decision and its
  spread or refund, each statement line's figures ("CNTY TAX 2,278.09 VS
  1,687.49 PROJ"), and the low line, or that the account was overdrawn and
  the statement has none.
- **The median agent note is 246 characters**, and a longer call leaves a
  longer note.
- **An analysis's system note says what was mailed.** A borrower more than
  30 days behind at the analysis gets no annual statement (§1024.17(i)(2),
  the ported `exemption`), so its note says the statement was not mailed,
  or that the shortage notice was.

Until contacts 1.2.0 an interpreted call's note read the interpreter's
relay of the question as a second question, and asked about "undefined":
142 of the seed-7 book's 3,282 agent notes did.

**The seam for model-written text.** `ContactTextWriter` (`writer.ts`) is the
seam. It has two calls: `callTurns(plan)` and `callNote(plan, turns)`.
`templateWriter` is the one there is, and no model is called anywhere. A
model writer replaces it and is held to what the templates are held to:

- every number in its text is the record's, or `checkTranscript` refuses
  it;
- it writes the tagged turns the defects need;
- it is written once, offline, and kept by contact id, so the book stays a
  function of its seed.

The timing, the noise and the defects are applied after the writer,
whoever wrote the words.

**Defects.** Eight call and note defects, numbered apart from
docs/synthetic-data-defects.md's data defects:

| Id   | Defect                                            | Planted in                                                                                         |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C-01 | Account details disclosed to someone not verified | The refusal turn of an unverified call or a wrong number                                           |
| C-02 | Collection language during a bankruptcy stay      | The disclaimer turn, replaced by a demand                                                          |
| C-03 | "This won't hurt your credit"                     | The answer to the credit question                                                                  |
| C-04 | A complaint voiced and not logged                 | The row's flag, the acknowledgment turn, the log entry (symptoms)                                  |
| C-05 | A wrong amount quoted                             | The first quote of a record amount; on an escrow call, the first statement line                    |
| C-06 | The mini-Miranda missing on a call that needed it | The disclosure turn, removed                                                                       |
| C-07 | The recording notice missing on an outbound call  | The disclosure turn, removed                                                                       |
| C-08 | A note that contradicts the record                | A figure in the agent's note (on an escrow call, a statement line's), or a status the record lacks |

Each label is the life generator's (the loan, the defect, the table and
field, the row, the day, the true and planted values, the expected handling,
root cause or symptom), plus the turn. A defect changes one turn and its
interpreter relay. Every other turn is the clean call's, word for word,
because each turn's noise has a stream of its own. At the default rate, 2%
of the contacts each defect fits, the 300-loan book carries 148 defects in
all on life 1.2.0 and contacts 1.2.0.

A wrong figure in the annual statement's explanation is C-05 in the call
and C-08 in its note, and no new defect is needed: the rubric's provenance
check holds the agent's figures to the record, which carries the statement
lines. On every call explaining a statement in call-qa's 120-loan rubric
book, pinned, both are planted and both found, 215 of 215 each.

**Staff errors.** Two errors an agent makes by not recording something,
`plantStaffErrors(center, book, requests, { pins })` (`staff.ts`), numbered
S-01 and S-02 apart from the catalog's and the call defects. Each is planted
the way the life generator plants a vendor's or a system's error: on one
contact the clean history has, with the twin derived again from the same
draws and the error made on that contact (`StaffOverride`, `derive.ts`). So
the twin is the clean history until the call, and the contact center's own
rules from there:

- **S-01, a promise not tracked.** The borrower promises a payment on a
  call, and the call's words and the agent's note carry it, word for word
  the clean call's but for a transfer. No record is written: the row's
  `promise_id` is null, the call is dispositioned as it would have been
  without the promise, by the same draw (a hardship call transferred or
  referred to loss mitigation, a dialer's conversation referred or
  "information provided" half the time each, a payment arrangement
  "information provided" or a callback), so its row is one a clean history
  holds for a call of its kind that took no promise, and the promise log
  holds nothing (`unrecorded_promises` keeps the promise, for the writer).
  It is made on a promise the contact center drew from a call, never on the
  scenario's own promise call: that call's purpose code is `promise_to_pay`,
  a twin keeps every row's purpose, and a `promise_to_pay` call with no
  promise is one no clean history holds, found from the row without reading
  its note. What the rules then do: nothing ceases the dialer, so it calls
  inside the window, about twice a root in the held-out suite; no "PTP SET"
  line, and a kept promise is never marked kept, a broken one never marked
  broken or the dialer resumed for it. A later call may take a promise of
  its own, which the first would have stopped. A call made before the
  promise is still the clean one's: the promise keeps it from taking one of
  its own, as it did, and the dialer stays quiet on the day of a promise
  taken on an inbound call, the hours before the call among them, as the
  clean history ceased it for the whole day. A center pinned to cease the
  dialer from the call itself (`cease_from_call`, contact-audit's books)
  made the attempts before the call that day in the clean history too, so
  there the twin dials the call's day as any other.
- **S-02, a complaint not logged.** C-04's error at the call (the row's
  flag, the agent's acknowledgment, the note, the CMPL line), and everything
  after it: the complaint system opens no case (below), so nothing
  acknowledges it and nobody answers it in writing. Nobody escalates it
  either: the call is dispositioned as its reason would have it without the
  complaint, by the same draw (a late fee may be escalated anyway, a
  hardship call transferred or referred), and it is followed up as a call of
  that row is: where the row is open, the follow-up on its issue is the
  clean history's; where it is closed, nothing in the log holds the issue
  open, and the follow-up the escalation drew is not made (it is drawn and
  undone, so every later call keeps its number). Nobody tells the borrower
  how to put it in writing either, so no written request follows it, as one
  may follow a logged complaint (on a clean history every complaint voiced
  is logged, so that draw is what it was). Nothing having come of it, the
  borrower calls about it again 3 to 60 days later (`RAISED_AGAIN_AFTER`, a
  design choice: as soon as a follow-up would be, or weeks later once no
  written answer has come), a call that voices the complaint and is not
  logged or escalated either. No case links it to the first, so it is filed
  as any call about its reason is that day, under an issue of its own (the
  root's own when the two fall in one month), and its reason is what ties
  the two. On a center whose borrower is pinned to call again about the
  matters an agent handled (`closed_follow_up`, below), it is that call,
  which the pin makes at its chance and a complaint nobody logged always, so
  the one the clean history drew there is not made. Beside the complaint it
  is drawn as any call about its reason that reaches an agent is: whoever
  calls (someone the agent can verify, the co-borrower or a counselor among
  them), how it is dispositioned, a promise taken on it, a follow-up and the
  letters after it. It is drawn before the dialer, so a promise it takes
  ceases the dialer as any other does, keeps no call before it from taking
  one, and takes sequence numbers of its own, so no other call's stream
  moves.

The complaint system is the servicing app's spec 4.5, "Complaint handling /
UDAAP", whose blueprint names a complaint log in a case-management system
(`apps/servicing/spec/sections/04-customer-service-borrower-communications/4-5-complaint-handling-udaap.md`).
`complaintLog(loan, key)` (`complaints.ts`) reads it off the contact log:
every complaint an agent logged on a call opens a case, received on the
call's day (an oral complaint is a complaint, 4.5 "Inputs and triggers"),
acknowledged on the call (`SM_COMPLAINT_ACK_1BD`: any channel), and answered
by the response letter `NTC_COMPLAINT_RESPONSE` within 15 calendar days
(`SM_COMPLAINT_RESOLVE_15`), three to eleven days after the call moved to a
servicer business day. It is a view, so no clean center holds anything new.
§1024.35's notice-of-error procedures reach a written notice, and a call is
not one; §1024.38(b)(5) has a borrower unsatisfied with an oral complaint
told how to send one.

Rows the two histories share keep the clean ids (`contactKey`: the day and
time, direction, mode, purpose, reason and issue), so every stream a contact
id keys draws the same; a row the twin adds is named off the root
(`<root>-S01-1`, the borrower's call again `<root>-S02`, what follows from
it `<root>-S02-1`), and a row it drops keeps its id spent. The labels are
the life generator's, with the contact a finding names and, for a symptom a
reviewer's rule names, which: the root is the call's missing record
(`contacts.promise_id`, with the promise the record should have held, or
`contacts.complaint_logged`); every other difference between the two
histories, field by field, is a symptom (the contact log but for its
`related` lists, the promise log, the comment log, the complaint log, the
transcripts, the dialer's pauses); and the named ones are
`dialed_in_window`, `kept_not_marked`, `broken_not_followed_up`,
`no_acknowledgment`, `no_response` and `raised_again`. A loan takes one of
each. Where one error's twin does not make the call the other was asked for,
the other is not made, and the planter says so: S-01's, when a hardship call
days after the promise call takes a promise of its own, so it is no longer
escalated and its follow-up is never made; S-02's, when a promise taken on
the call raising the complaint again, or on the borrower's next call about
the same matter, ceases the dialer and the dialer's conversation S-01 was
asked for is never made, or when the call S-01 was asked for was the
borrower's call again about the complaint's matter, whose place the call
raising it again takes.

A clean center is byte for byte what it was. The override and
`unrecorded_promises` are absent from every clean history, and
`complaintLog` stores nothing, so the staff errors moved no version of their
own: they arrived beside contacts 1.2.0's escrow call, and a center with
them is the center without them, held side by side (rows, notes, every
transcript and C-01 to C-08 planted at 5 %, on 120 loans over 48 months and
60 over 120, 80 loans over 72 months with the escrow call pinned, and 60
over 36 pinned irritated).
call-qa's held-out pin (`4e175948…`) passes as contacts 1.2.0 left it.
contact-audit's books set seven profile pins of their own, `style`,
`complaint_chance` (the share of handled calls that carry a complaint, in
place of the reason's weight and the multiples; `complaint_multiplier` is
the other way to pin it), `call_multiplier` (the ordinary inbound volume,
month by month), `closed_follow_up` (how often the borrower calls again, 3
to 60 days later, about a matter an agent handled, open or closed, filed as
any call about its reason is that day, beside the follow-up an open issue
gets; unset, never), `kept_promise_share` (how often a conversation the next
payment follows within three weeks takes a promise for it; unset, always),
`kept_promise_slack` (how many days past the payment's day a kept promise's
date may fall, the borrower naming a day and paying on or before it; unset,
none) and `cease_from_call` (a promise taken on an inbound call ceases the
dialer from the call's minute, so an attempt earlier that day is made;
unset, from the start of the day), each of which changes no draw on a center
that does not set it. The audit's busier books reached one call the writer
had never written, a payment taken on a call with nothing left to quote,
which threw; it now quotes nothing, which changes no call that was written
before.

**Not covered yet:**

- the §1024.40 assignment and the good-faith determination;
- credit disputes, loss mitigation past the application package, and
  foreclosure;
- the AI voice, which 11.1 counts as live contact only in a sandbox until
  a legal opinion and the partner's sign-off (design item 8;
  `11-1-live-contact.md:54`). call-qa (below) writes the AI voice's
  introduction into a call itself;
- the text of e-mails and letters, and phone-menu transcripts;
- the annual statement for a first analysis, whose year's payment was set
  at closing by a projection the history does not keep; a call about it,
  and a call about the payment change, are answered from the analysis
  alone;
- a discharge or dismissal of the scenario's case, which the life generator
  does not model; and a drawn case the history's payments know about.

The 300-loan book's center takes about three seconds, and a thousand
transcripts about a second.

## call-qa

call-qa 1.0.0 grades a QA reviewer: one recorded servicing call, reviewed
the way the servicer's QA desk reviews it. The call comes from the contact
center above; the form is the servicing app's collections spec, 11.1
(`11-1-live-contact.md`): the decision record and guardrails every AI call
is held to (line 158) and the evaluation suite its go-live needs (line 56:
disclosure compliance, prohibited-statement detection, quiet-hour and
frequency guard tests).

**An AI voice is not yet the live contact the law requires.** 11.1 counts a
conversation with the AI voice as Regulation X §1024.39(a) live contact and
Fannie Mae QRPC only after a written legal opinion and the partner's
sign-off are attached to the flag that turns it on (line 54); until then the
flag is on only in a sandbox, and production's default waits on open
decision 11.1-Q1. call-qa grades what an AI call said and whether it should
have been dialed, never whether it was live contact.

**The task.** It gives the call as the desk has it the day after:

- the call's row: the direction, a person or the AI voice, the outcome, who
  it was with, whether they passed the identity checks, whether the agent
  logged a complaint, and the loan's debt-collector and active-duty flags;
- the transcript, line by line: the time, the stereo recording's channel
  (Agent, Customer, IVR) and the recognizer's text, noise and all;
- the loan's record at the end of the call's day, in dollars. Since
  contacts 1.2.0 it carries the latest analysis's plan (the shortage's and
  deficiency's installments and months, a refund's date, a credit's monthly
  amount) and the annual statement mailed with it, when one was: the year
  it explains, the run date it was read through, and each item (viii) line
  with its month, its figures and the engine's sentence. So on a call
  explaining the statement the provenance and wrong-amount checks hold the
  agent to the statement's own figures;
- for an outbound call, the facts the dialer held when it dialed, named as
  the servicing app's `preDialChecks` names them;
- the agent's note, when the call left one.

The model lists every rubric item the call fails, with its line (or none,
for what is missing and what happened before the call), says whether the
call fails outright, whether the note matches the record (and what in it
does not), and which loss-mitigation options the agent named, at the first
line that names each.

**The rubric** (`src/calls/`) is not an environment either; call-qa grades
with it. Its items:

- **Who was told what.** A dollar amount said to someone nobody verified.
- **Disclosures.** The AI voice says it is an automated assistant among its
  first three lines (11.1 design item 1). An outbound conversation carries
  the recording notice. A conversation carries the mini-Miranda when the
  servicer is a debt collector or the loan is past due, and during a
  bankruptcy case the informational-only disclaimer in its place. The
  FDCPA asks the mini-Miranda of a debt collector alone (§1006.18(e)); on a
  past-due loan that is not one it is the contact center's policy (ours),
  which the rubric holds its calls to.
- **Before the call.** Consent (an AI voice to a mobile number needs TCPA
  consent), the line type (an AI voice to a landline without written
  consent, three in 30 days), the time zone (after 08:00 and through 20:30
  in every candidate zone), the call count (7 in 7 days for a debt
  collector, 2 in Massachusetts, 5 elsewhere), and a cease, a bankruptcy or
  counsel on file.
- **The loan's flags.** An active-duty servicemember is told of the
  Servicemembers Civil Relief Act. 11.1 makes the military flag part of the
  pre-dial record but stops no dial on it ("cadence continues but scripts add
  the military-indulgence path"), so the rubric reads it as the script.
- **What is never said.** A threat, modification terms offered, a second
  voicemail on a number within 7 days, collection language during a
  bankruptcy case, "this won't hurt your credit", a complaint voiced and not
  logged.
- **Figures.** Every run of digits an agent says has a source in the
  caller's words or the record: the servicing app's provenance check. A run
  inside a dollar amount with no source is a wrong amount; any other is
  provenance.
- **Verbatim.** No agent line is a copy-library template read whole: the
  servicing app's verbatim check, over six of its lines a delinquent
  borrower's call could reach.
- **The note.** Every number in the agent's own note is in the record of
  the call's day, every number in a note copied forward is in the record of
  the day it was first written, and an account the note calls current or
  past due is.

Five items fail a call outright, whatever else the call did well: a
disclosure to someone unverified, collection language during a bankruptcy
case, the credit misstatement, a complaint not logged, and a wrong amount.

**The grader is the rubric, and two of its checks are the servicing app's
own.** The conversation harness grades the app's chat agent with five
checks (`apps/servicing/src/domain/borrower/eval/checks.ts:1-25`). Two read
nothing but words and a record, and carry over to a call: provenance and
verbatim. `src/calls/ported/` holds the harness's `types.ts` byte for byte
and its `checks.ts` through those two checks, byte for byte but for the
imports; a test compares them. The other three read the chat product's own
tables. Every word list and gate the rubric restates is held by a test to
the line it comes from: the threat words and the options
(`section11.ts:54-57`), the pre-dial checks (`section11.ts:84-105` and the
evaluators at `evaluators.ts:256-259`), the state caps
(`early-intervention/ops.ts:499`), the voicemail and counsel guardrails
(`section11.ts:336-337`), and the templates, parsed from the copy library
the way `channels.ts` parses it. The rest of the words are ours, each a
design choice that says so.

**The tools.** `search_transcript` (the lines that say each phrase, read as
the rulebook reads them), `record_on` (the record on any day up to the
call's, rebuilt from the book's seed), `local_time` and `minutes_between`.
No tool returns a finding. The first two read the task's own material: the
episode loop hands a tool the task, a third argument boarding-triage's file
reader and tape-intake's tape readers read too and every other environment
ignores, and the browser playground passes the task it has drawn.

**The tasks** cycle by index through thirty edges, seven each in the
210-task held-out suite:

- eight clean calls: an inbound conversation (one arm in three a
  borrower's call about the escrow analysis, answered from the statement);
  an outbound collection call;
  a caller nobody verified (a spouse not on the note, an answering third
  party or wrong number, a refusal); a voicemail; the AI voice (to a
  consenting mobile, or a landline under its cap); an active-duty
  servicemember told of the protections; a call during a bankruptcy case;
  and a debt collector's call;
- the contact center's eight defects, C-01 to C-08, planted by
  `plantContactDefects`. C-05 and C-08 take every other draw on a call
  explaining the statement, with the wrong figure in a statement line or in
  the note's record of one;
- fourteen of ours, Q-01 to Q-14: the AI voice that does not disclose;
  consent; the fourth landline call; the time zone, early and late; the
  call count, a debt collector's and the policy's; a cease, oral and
  written; a dial into a bankruptcy case; counsel; a servicemember not
  told; a threat; terms offered; a second voicemail; a template read whole;
  and an invented figure.

Each draw is a fresh book of one loan (four for a complaint, a call few
loans make) from the task's own key, behind the way its edge needs, run
through the contact center. An escrow arm's loan is escrowed, with no
missed payment scripted, and pins the borrower's call about each analysis
(`escrow_call`); its 30 months hold one analysis with a statement, the
second. Two plants bring findings beyond their own. A demand in a
bankruptcy case (C-02) takes the disclaimer's turn, so the disclaimer is
missing too. A dial into a bankruptcy (Q-07) ignored the case on the call as
well: it carries the mini-Miranda, not the disclaimer, and often asks for a
payment. On the held-out suite 63 calls are clean, 111 fail items and 36
fail outright; every item turns up seven times or more. Eight of the 210 are
escrow calls: two clean, three with C-05 and three with C-08.

**A draw is kept only when it is fair to grade, and this is a filter.**
ei-clocks' guard rejects nothing it draws; this one does. A draw is kept
when the call without its plant draws no finding and its note matches, the
planted call draws the plant's finding on the planted line and nothing the
plant does not name, and the rubric finds exactly the same on the
recognizer's text and labels as on what was said, by whom. Of the first
draws of 1,500 training tasks (seed 3), 461 found no call that fits their
edge and drew again. Of the other 1,039, 113 were turned away because the
recognizer's noise moved a finding (a misheard amount reads as a wrong
one), and one because a wrong amount's digits were already in the record.
An escrow call says a dozen figures or more, so the recognizer moves more
of them. The contact center's clean calls draw no finding of their own, its
dialer's times and counts included. The kept draws average 1.8 attempts, at
most 9 on the held-out suite.

**What v1 leaves out, and why.**

- A call the recognizer misheard where it matters: a figure, or a word a
  rule reads. The reviewer reading the text could not tell the recognizer's
  slip from the agent's, and only the label could.
- A wrong amount whose digits the record already holds: the P&I quoted as
  the payment, last year's payment, a transposition whose runs are other
  figures' (the servicing app's check reads runs of digits, so $58.23 for
  $85.23 passes when 58 and 23 are sources). The same for a note's figure.
- An amount said before the identity checks on a call that passed them
  later. The rubric reads the row's `identity_verified`, not the line where
  the checks passed, which a transcript does not mark; the contact center
  never quotes before its checks, and a test holds it to that.
- Calls through an interpreter, mono recordings (whose speaker labels a
  reviewer would have to infer), welcome calls after a transfer, and the
  servicing app's other three pre-dial gates: the post-conversation
  cooling-off (§1006.14(b)(2)(ii), which ei-clocks leaves out too), the
  pre-sale stop and the workplace rule. 11.1-T23's first-fifteen-seconds
  rule for an all-party-consent state is out too: the contact center's dead
  air puts some clean notices past it.
- Whether a loss-mitigation option was appropriate to tell (comment
  39(a)-4). The rubric reads which options were named; the servicing app
  checks named options against `lossmit_facts`, which the record here does
  not carry.

**The proof of fairness.** The reference reads its word lists from the
rubric's constants (the rulebook writes the same constants in) and none of
the rubric's code: it reads the figures, the templates and the note as the
rulebook's sentences say. It passes the held-out suite, a 300-task training
suite and seventeen spec cases: 11.1-T12's three dial times (20:45 ET and
08:00 PT refused, 12:00 ET permitted), T10, T21 and its boundary, T13's
eighth counted call, T7's dial into a Chapter 13 case, rule 13's $4,165.00
and a balance worked out instead, design item 1, Q3, the threat and
negotiation guardrails, T23, and the edge cases' cease and counsel. It
takes two turns: every search, clock reading and other day's record in one,
then the submission; at most 12 tool calls. On the contact center's own
calls, as said, over a 120-loan book, the rubric finds nothing; on its
planted defects it finds C-01 to C-04, C-06 and C-07 every time, and C-05
and C-08 except where the record holds the planted figure. With every
borrower on that book calling about each statement, C-05 and C-08 planted
in the explanation are found on all 215 calls.

The scores to read a model against, on the held-out suite: an answer that
says nothing scores 0.509 and passes 7 (clean calls with no note and no
option named); one that calls every call clean but gets the note and the
options right scores 0.763 and passes the 63 clean calls; one that names
every finding but no line scores 0.915. A test holds the pins. Every figure
in this section is the suite drawn on life 1.2.0 and contacts 1.2.0, pinned
at `4e175948…`; the rubric and the rulebook are 1.0.0's, so the version
holds (docs/decisions.md, "The escrow call reads the annual statement").

DeepSeek-V4.1-Flash's held-out baseline (thinking, 16,000 output tokens a
turn) is 194 of 200 (97.0 %), from a whole run on the checked Vertex policy
(docs/decisions.md, "DeepSeek's held-out baselines on the newest suites, and
two corrected").

Generating the held-out suite takes about nine seconds on a loaded machine.

## contact-audit

contact-audit 1.0.0 grades a quality-control desk's audit of a contact
center for staff errors: one loan's contact history over a window, read for
a promise an agent heard and did not record (S-01) and a complaint an agent
heard and did not log (S-02), each reported at its root with the symptoms it
caused. It is built on the contact center's staff errors (above, "The
contact center", "Staff errors").

**The task.** The loan (its number, borrowers, state and servicer), the
window, and the contact log for the window in the task itself: every call,
phone-menu session, portal login, text, e-mail, letter and dialer attempt,
each with its disposition, issue, agent, the promise it recorded and whether
a complaint was logged. The ids are the desk's own: every contact and note
is numbered in its log's order, because a twin names what it added off its
root. The rest it reads with the tools.

**The rulebook** says first what the servicer's systems do: a promise is
written in the note ("PTP $1,234.56 BY 03/28/27") and recorded, ceases the
dialer through its date, and is marked kept or broken; a complaint is
acknowledged on the call, logged, and answered in writing within 15
calendar days (spec 4.5). Then the two errors:

- **S-01.** A call made a promise when its note's own part (before a
  copied-forward "| PREV:") says an amount, BY and a date. Such a call with
  no promise in the log is a root, reported with the promise as the note
  gives it. Its symptoms: each outbound collection attempt after the call
  through the pay-by date (`dialed_in_window`), and `kept_not_marked` when
  the payments after the call's day through the pay-by date add up to the
  amount (with the calculator), `broken_not_followed_up` otherwise.
- **S-02.** A call voiced a complaint when any line of its transcript says
  one of the call rubric's complaint phrases (`COMPLAINT_PHRASES`), whoever
  the recognizer labeled. Such a call with `complaint_logged` false is a
  root, unless an earlier one with the same reason was too: then it is the
  borrower raising that root's complaint again, a symptom and never a root.
  Nobody logged the first, so no case links the two, and the later call may
  be filed under an issue of its own: its reason is what ties them. Its
  symptoms: no line acknowledging it (`ACK_PHRASES`, the contact center's
  three wordings), no case in the complaint log, and each later call with
  the same reason that voiced one and was not logged (`raised_again`).

**The tools.** Primitives only: `read_notes` (by contact or by days),
`read_transcript`, `search_transcripts` (every recorded call in the window,
read as call-qa's search reads a line), `read_promises`, `read_complaints`
(each as it stood at the window's end), `read_payments` and refi's
`calculate`. No tool compares two records or names an error.

**The grader** is the twin's labels, a root read apart from its symptoms as
boarding-triage 1.1.0 reads its manifest, with two differences: a root's
symptoms are required, and a root the window does not hold fails it.

- Each root is found when a finding names its error, kind "root" and its
  call; an S-01 root also has its promise, the amount in cents and the
  date.
- Each root has a symptoms field: every symptom the rules give it, each on
  its contact. The root without them fails; they without the root earn
  that field and fail on the root.
- Every window has a false-roots field: a finding of kind "root" that no
  label names fails the window, whatever else is right. A promise the log
  holds, a complaint logged, a call raising a complaint again, and a root's
  call named under the other error are each no staff error, and naming one
  is the mistake a QA reviewer must not make. A clean window is a control:
  it passes only with no root.
- Extra findings are one field, symptoms only, a second finding on one
  thing among them: at most two.

**A root's symptoms are required.** The rulebook asks for them, and they are
where a window's arithmetic and timing are: the payments after the call's
day through the pay-by date, added with the calculator; an attempt later on
the promise call's own day inside its window and one earlier outside it; the
three wordings of an acknowledgment; the call raising a complaint again,
found by its reason. The reference reaches every one on every kept draw, so
they are fair to require. The roots alone, once false roots fail, would
already tell a recorded promise from an unrecorded one and a logged
complaint from an unlogged one; with the symptoms required they pass the
50 clean windows and nothing else (mean score 0.816), so a pass is the
whole audit.

**The tasks.** Each is a life book of one loan, run 30 months: a delinquency
every two to four months, half of them with the scenario's promise (kept or
broken), beside the ones the contact center draws from the receipts. Seven
profile pins make the borrower the kind a desk audits: irritated, with a
grievance voiced on 35 % of the inbound calls an agent handles whatever the
call is about (0.352 of them on the books of 400 training keys, seed 11, and
0.323 of every handled call; an outbound call carries none), so whether a
call carries one says nothing of what the call is about; calling fourteen
times as often as the calibration's borrower in the same status; calling
again 3 to 60 days later about seven in ten of the matters an agent handled,
open or closed, filed as any call about its reason is that day, as S-02's
borrower always calls again about a complaint nobody logged; paying within
three weeks of a conversation without having promised to on it 85 % of the
time (in the calibration's center every such conversation takes a promise,
which made a kept promise's call the only one of its kind: below); naming,
when promising, a day up to a week past the one the payment then comes (in
the calibration's center the promise's date is the payment's); and a promise
taken on an inbound call ceases the dialer from the call, an attempt earlier
that day being made. The task takes two anchors from the clean center, in
turn by index a promise the borrower kept and one broken, which the contact
center drew from a call (never the scenario's own promise call: "Staff
errors" above), and a complaint call, within 120 days of each other, each a
call no other contact on the loan shares a key with. A pair needs from ten
days before the first to a week past the promise's date and past the last
day the complaint can be raised again. The window is what one pair drawn
from them needs and 90 to 210 days more, split at random between before and
after, and the anchors are then drawn again from every pair the window holds
as it holds that one, so given the window they are any pair it holds: where
they sit in it, and how far apart, says nothing of which pair they are. Four
plans in turn make nothing (the control), S-01 on the promise, S-02 on the
complaint, or both, so the held-out suite (seed 1, 200 windows, drawn on
life 1.2.0 and contacts 1.2.0, pinned by hash) holds 50 of each. It has 100
roots of each error, 212 dialer attempts inside a promise's window, 50
promises kept and 50 broken, and 100 calls raising a complaint again, 3 to
60 days after it (19 within 15 days; 19 under the root's own issue, 81 under
issues of their own; 19 made by someone other than the borrower, and 4
taking a promise). A kept promise's date falls 0 to 7 days past the payment
that keeps it, 9, 6, 4, 9, 5, 3, 8 and 6 of the 50 on each day. S-01's roots
are 30 dialer conversations, 32 inbound calls about a payment arrangement
and 38 about a hardship; S-02's are on 16 reasons, a payment arrangement
(30) and a hardship (17) the most. A window averages 252 days, both ends
counted (102 to 373), 89.5 contacts (28 to 188), 53.8 recorded calls, 4.7
calls whose note states a promise and 14.2 that voice a complaint. 216 of the
windows' calls are about an escrow analysis, 3 of them S-02 roots.

**Beside the roots, every window holds promises recorded and complaints
logged.** Counting the calls whose promise the log holds, and the logged
calls whose transcript says the complaint in the rubric's words (one the
recognizer hid is no false root a reviewer could name): at least one of each
in every window, a draw with fewer being turned away (`AUDIT_MIN_HANDLED`),
and 4.2 promises (1 to 9) and 13.2 complaints (2 to 32) on average. 186
windows hold two promises or more and 161 three or more; 200 hold two
complaints or more and 197 three or more. So reporting every promise or
every complaint names a false root in every window.

**A draw is kept only when it is fair to grade, and this is a filter.** The
reference, reading the window as rendered, must find exactly the labels'
roots and the symptoms a rule names, and nothing more (nothing at all in a
clean window). On the held-out suite 144 of 200 windows are first draws,
and the longest took 6; the redraws are 72 books with no pair of anchors,
5 windows with too few promises recorded or complaints logged beside the
roots, 5 where the recognizer hid the complaint raised again (a misheard or
dropped word in the phrase) and 5 where it hid the root's own. Of the first
draws of 1,000 training tasks (train seed 11), 769 had a pair of anchors and
reached the check, and 42 were turned away: 16 for too few promises recorded
or complaints logged, 9 because the recognizer hid the complaint, 15 the
complaint raised again, and 2 because S-02's twin does not make the call
S-01 was asked for (a promise taken on the call raising the complaint again,
or on the borrower's next call about the same matter, ceases the dialer, and
the dialer's conversation is never made; or S-01's call was the borrower's
call again about the complaint's matter, whose place the call raising it
again takes). None is turned away for its payments any more: a scripted
promise, which the scenario could break on a day the borrower's own payment
met it, is never an anchor. The same filters are v1's limits.

**The floors.** Each cheap policy in the first table chooses its roots and is
then given every symptom the rules give those roots, read off the window as
the reference reads them, so a floor is what its choice of roots is worth.
Passes are of 200 windows, then of the 50 clean, S-01, S-02 and both:

| Policy                                                                            | Passes | Clean | S-01 | S-02 | Both |  Mean |
| --------------------------------------------------------------------------------- | -----: | ----: | ---: | ---: | ---: | ----: |
| Report nothing                                                                    |     50 |    50 |    0 |    0 |    0 | 0.546 |
| Every promise (each call whose note states one, as an S-01 root)                  |      0 |     0 |    0 |    0 |    0 | 0.301 |
| Every complaint (each call whose transcript voices one, as an S-02 root)          |      0 |     0 |    0 |    0 |    0 | 0.390 |
| Every promise and every complaint                                                 |      0 |     0 |    0 |    0 |    0 | 0.472 |
| S-01 by disposition: a promise call with no promise, "information provided"       |      1 |     0 |    1 |    0 |    0 | 0.141 |
| The first such call                                                               |      4 |     0 |    4 |    0 |    0 | 0.301 |
| S-02 by disposition: escalated and not logged, the first on its issue             |     30 |    30 |    0 |    0 |    0 | 0.386 |
| Both by disposition                                                               |      0 |     0 |    0 |    0 |    0 | 0.134 |
| Every promise call with no `promise_id`                                           |      0 |     0 |    0 |    0 |    0 | 0.257 |
| A `promise_to_pay` call with no `promise_id`                                      |     50 |    50 |    0 |    0 |    0 | 0.541 |
| A hardship call with no promise, "information provided"                           |     50 |    50 |    0 |    0 |    0 | 0.546 |
| A promise call with no promise that a payment followed within three weeks         |     18 |    16 |    2 |    0 |    0 | 0.322 |
| The same, only where it is the only one                                           |     43 |    41 |    2 |    0 |    0 | 0.509 |
| Every handled call with no CMPL note                                              |      0 |     0 |    0 |    0 |    0 | 0.196 |
| Every call with no CMPL note whose reason a logged complaint has                  |      0 |     0 |    0 |    0 |    0 | 0.158 |
| An unlogged call another unlogged call for its reason follows within 3 to 60 days |      0 |     0 |    0 |    0 |    0 | 0.078 |
| The first such pair                                                               |      3 |     0 |    0 |    3 |    0 | 0.272 |
| The same, only where it is the only pair                                          |     49 |    49 |    0 |    0 |    0 | 0.543 |
| The first such pair whose later call is under an issue of its own                 |      4 |     0 |    0 |    4 |    0 | 0.279 |
| A written request on an issue no logged call has                                  |     48 |    48 |    0 |    0 |    0 | 0.539 |
| A closed call followed on its issue within 15 days                                |      0 |     0 |    0 |    0 |    0 | 0.061 |
| The promise note nearest the window's middle                                      |     16 |     0 |   16 |    0 |    0 | 0.369 |
| Every complaint not logged, the raised-again clause left out                      |     50 |    50 |    0 |    0 |    0 | 0.645 |
| The roots the rules give, no symptom                                              |     50 |    50 |    0 |    0 |    0 | 0.816 |

The second table is the policies that read only the logs' structure: the
rows' fields and flags, their dispositions, reasons, purposes, issues and
dates, the promise log's dates, the payments, and the comment log's areas
and counts, never what a transcript or a note says. With no words to read,
each gives its roots the symptoms a structure can: an S-02 root
`no_acknowledgment`, `no_response` where the complaint log holds no case for
it, and `raised_again` on the later unlogged calls for its reason (every one,
or the first 3 to 61 days on); an S-01 root its promise guessed as the next
payment after the call, which a kept promise is, and the symptoms the rules
give from there. V1 to V8 are the second review's; the rest are the ones the
rework tried against itself. Training is the passes of the 300 training
windows (seed 11), 75 of them clean:

| Policy                                                                                                          | Passes | Clean | S-01 | S-02 | Both |  Mean | Training |
| --------------------------------------------------------------------------------------------------------------- | -----: | ----: | ---: | ---: | ---: | ----: | -------: |
| V1: the first unlogged hardship or escrow-analysis call                                                         |      1 |     1 |    0 |    0 |    0 | 0.034 |        4 |
| V2: the only conversation with no promise, "information provided", a payment within 21 days and no promise near |     39 |    38 |    1 |    0 |    0 | 0.457 |       51 |
| V2': the same, any disposition                                                                                  |     39 |    38 |    1 |    0 |    0 | 0.484 |       56 |
| V3: a closed first call on its issue that a later contact follows into the next month                           |     24 |    24 |    0 |    0 |    0 | 0.306 |       36 |
| V4: the only two unlogged calls for a reason no logged call has, 3 to 61 days apart                             |     35 |    34 |    0 |    1 |    0 | 0.356 |       41 |
| V5: V1, or else V3                                                                                              |      1 |     1 |    0 |    0 |    0 | 0.034 |        4 |
| V6: V1 and V2                                                                                                   |      0 |     0 |    0 |    0 |    0 | 0.033 |        3 |
| V7: V1, or else V2                                                                                              |      0 |     0 |    0 |    0 |    0 | 0.027 |        3 |
| V8: the first unlogged hardship call referred to loss mitigation                                                |      8 |     7 |    0 |    1 |    0 | 0.090 |       10 |
| The same, transferred                                                                                           |      7 |     7 |    0 |    0 |    0 | 0.089 |       14 |
| The first conversation of V2''s kind                                                                            |     22 |    19 |    3 |    0 |    0 | 0.280 |       22 |
| The last                                                                                                        |     20 |    19 |    1 |    0 |    0 | 0.321 |       21 |
| The one its payment follows soonest                                                                             |     21 |    19 |    2 |    0 |    0 | 0.342 |       21 |
| The only one the dialer made                                                                                    |     39 |    37 |    2 |    0 |    0 | 0.469 |       61 |
| The only inbound one                                                                                            |     42 |    42 |    0 |    0 |    0 | 0.480 |       56 |
| The first unlogged call a later one for its reason follows within 3 to 61 days                                  |      3 |     0 |    0 |    3 |    0 | 0.031 |        6 |
| The first such call whose later one is under an issue of its own                                                |      3 |     0 |    0 |    3 |    0 | 0.041 |        4 |
| The last such call                                                                                              |      2 |     0 |    0 |    2 |    0 | 0.035 |        6 |
| Every such call, one a reason                                                                                   |      0 |     0 |    0 |    0 |    0 | 0.071 |        1 |
| The only such call                                                                                              |     49 |    49 |    0 |    0 |    0 | 0.539 |       73 |
| The only such call whose later one is with the borrower and took no promise                                     |     48 |    48 |    0 |    0 |    0 | 0.528 |       66 |
| A reason's only two unlogged calls, 3 to 61 days apart, the only such reason                                    |     33 |    32 |    0 |    1 |    0 | 0.345 |       40 |
| The first unlogged call of the reason with the most                                                             |      2 |     0 |    0 |    2 |    0 | 0.047 |        2 |
| The unlogged call the most later ones for its reason follow within 3 to 61 days                                 |      2 |     0 |    0 |    2 |    0 | 0.039 |        3 |
| The only closed unlogged call followed on its issue within 3 to 15 days                                         |     48 |    48 |    0 |    0 |    0 | 0.516 |       69 |
| The unlogged call before the only later arrangement or hardship call no dialer attempt is near                  |     33 |    31 |    0 |    2 |    0 | 0.395 |       54 |
| The last conversation of V2''s kind, and the first call of a pair                                               |      1 |     0 |    0 |    1 |    0 | 0.039 |        2 |

The rows that read the logs' structure are the tells the twin has carried,
and what each passes now. The first build left five, which the first rework
removed: a scripted `promise_to_pay` call with no `promise_id` and
"information provided" (S-01 is never made on one); a hardship call
"information provided" (a hardship call whose promise nobody recorded is
dispositioned as one that took none); a written request on an issue no
logged call has (nobody tells the borrower whose complaint nobody logged how
to send one); the call raising a complaint again 16 to 35 days later on the
root's own issue (now 3 to 60 days, under an issue of its own, tied by its
reason); and a promise call with no promise that a payment followed within
three weeks (in the calibration's center every such call takes a promise, so
a kept promise nobody recorded was the only one of its kind). The second
review found that the rework's pins and dispositions left more, each removed
at its cause:

- **V1, an unlogged hardship or escrow-analysis call** (73 of 200 on the
  first rework's suite, 50 clean and 23 of the S-02 windows): a borrower
  complaining five times as often complained on nearly every hardship and
  escrow call, so an unlogged one was nearly always the root. The pinned
  chance is now 35 % on every call whatever its reason, so a reason says
  nothing of whether its calls carry one, and every reason's calls go
  unlogged without a complaint in the clean windows as often as any other's;
- **V8, the first unlogged hardship call referred to loss mitigation** (66):
  the twin referred a hardship call nobody logged, or whose promise nobody
  recorded, because a transfer would change its words, while a clean one is
  transferred half the time. It now takes the same draw, a transfer
  included: the root's words change, and nothing grades them;
- **V2, the only conversation with no promise, "information provided", a
  payment within 21 days and no promise near** (53, 13 of the 25 on S-01's
  kept arm): the twin's dialer conversation was always "information
  provided", while a clean one that takes no promise is referred half the
  time, and few clean conversations a payment followed took no promise. The
  twin draws the disposition half and half on a stream of its own; half the
  scenario's delinquencies carry its promise call, so the contact center
  draws the others' promises from what the borrower did; and the pinned
  borrower pays without having promised to 85 % of the time, so such
  conversations are many in every window. V6 (V1 and V2) passed 83 and V7
  76;
- **the call raising a complaint again** was always the borrower, by phone,
  with no promise, drawn after the dialer, and the only call in a clean
  window that came weeks after another of its reason under an issue of its
  own. It is now drawn as any call of its reason that reaches an agent is
  (whoever the agent can verify, its disposition, a promise, a follow-up and
  the letters after it, and before the dialer, so a promise ceases it). That
  left the pair: with every other fix made, the first unlogged call another
  for its reason follows within 3 to 61 days passed 19 of the 50 S-02
  windows, 14 of one arm's 25, with the call raising it again read off the
  transcripts, and 21 where the later call came under an issue of its own.
  So the pinned borrower calls again about two in five of the matters an
  agent closed (seven in ten since the third review, and of the matters an
  agent handled, open or closed, since the fourth: below), 3 to 60 days
  later and filed the same way, and a clean window holds such calls without
  a complaint as a twin holds one with: the two pass 3 and 3 now.

The passes of V3, V4 and V5 were near the clean share on the first rework's
suite too (52, 49 and 71, V5 riding on V1), and are lower now. What is left
is a guess: the structural policies that pass most S-01 windows pick the
first, the last or the soonest-paid of several conversations of V2's kind,
and the ones that pass most S-02 windows the first or the last call of a
pair; each loses as many clean windows as it gains.

A third review the same day tried structural policies the tables did not
then hold, on the suite before the fix below; they are the third table's,
with what each passes now. Two were tells. An unlogged complaint left its
issue open, so its call's follow-up was filed under the call's own issue:
one landing in a later month on a closed call's issue, or on a closed call's
fee or analysis, was nearly always the root's (A1), which found 2 and 3 S-02
roots and lost one clean window of 325 on four suites. And one policy broke
a bound (Z3): naming as an S-02 root, whenever a window has one, the last
unlogged call in the anchors' zone (from ten days after the window opens to
61 before it closes, where an S-02 root always is) that a later unlogged
call for its reason follows 3 to 61 days on in another month, with a
recorded promise call within 120 days. It failed 44 of the 50 clean windows
and passed 27, but 21 of the 50 S-02 windows, 14 of one arm's 25, and out of
sample a quarter of S-02 roots (24 and 26 % on two fresh suites of 400). The
borrower always calls again about a complaint nobody logged, and called
again about two in five of the matters an agent closed, so a root was nearly
always such a call and a clean call seldom, and a window held two to four of
them in the zone. Two changes, at those causes:

- the pinned borrower calls again about seven in ten of the matters an
  agent closed (`closed_follow_up` 0.7; since the fourth review, of the
  matters an agent handled), so a clean window holds such pairs with no
  complaint nearly as often as a twin holds its one with; the pin is read
  only where it is set, so no clean center moves;
- the follow-up drawn on an unlogged complaint's issue, which the clean
  history draws for the escalation and the twin drew the same, was filed,
  where the root's row is closed, as one after a closed call is: under the
  issue its own day gives its reason, since nothing in the log holds the
  issue open. Since the fourth review (below) it is not made there at all,
  as no closed row's issue is followed up.

After that fix Z3 passed 15 (4 clean and 11 S-02, 5 and 6 by arm) and 20 on
the training suite (5 clean, 6 and 9), and found 17 and 20 % of S-02 roots
on the two fresh suites; it passes 6 (6 S-02, 3 and 3) and 11 (1 clean, 10
S-02) now, and 14 and 18 % on two fresh suites of 400 (train seed 12,
held-out seed 2); A1 finds none. The rest of the third review's policies
held the bounds before and hold them now. The only conversation of V2's kind
with no attempt on its day and one the next (A2) passed 52 and 75, and 54
and 76 in either direction (A2'), while the twin kept an inbound promise
call's own day quiet on the dialer (the fourth review, below); they pass 46
and 64, and 47 and 66, now. The review's searches, every conjunction of up
to four structural filters with a first, last or only choice, 4,413 on
S-01's kept arm and 28,926 on S-02's pairs, found at most 54 and 79 for S-01
and 55 and 78 for S-02 after the third review, and now find at most 51 and
75 for S-01 and 52 and 77 for S-02, and at most 4 and 7 of an arm's 25 on
the held-out suite, 3 and 9 of its 37 or 38 on the training suite. M1 to M3
are the rework's own, Z3 read for where a chain of such calls starts; M4 is
one of the S-02 search's best on the held-out suite (its best, 55, adds a
later call on a Saturday), M5 the S-01 search's that passes most of the kept
arm on the training suite, and M6 the S-02 search's that passes most of an
arm on the held-out suite:

| Policy                                                                                                                              | Passes | Clean | S-01 | S-02 | Both |  Mean | Training |
| ----------------------------------------------------------------------------------------------------------------------------------- | -----: | ----: | ---: | ---: | ---: | ----: | -------: |
| A1: a closed unlogged call an open call's follow-up follows, into a later month or onto a fee's or analysis's issue                 |     49 |    49 |    0 |    0 |    0 | 0.537 |       74 |
| A1': the only one, `raised_again` on the first call of the shape                                                                    |     49 |    49 |    0 |    0 |    0 | 0.537 |       74 |
| A2: the only inbound conversation of V2''s kind with no attempt on its day and one the next                                         |     46 |    45 |    1 |    0 |    0 | 0.483 |       64 |
| A2': the same in either direction, its payment a week before the window closes                                                      |     47 |    46 |    1 |    0 |    0 | 0.491 |       66 |
| A3: the only conversation of V2''s kind no other conversation follows before its payment                                            |     29 |    27 |    2 |    0 |    0 | 0.407 |       42 |
| A3': the same, with no attempt on its day, its payment a week before the window closes                                              |     32 |    30 |    2 |    0 |    0 | 0.433 |       48 |
| A4: the only reason with one unlogged call in the zone and one call of the shape after it                                           |     40 |    40 |    0 |    0 |    0 | 0.451 |       65 |
| A4': the same, no logged call for its reason, a promise the log holds within 120 days                                               |     44 |    44 |    0 |    0 |    0 | 0.490 |       68 |
| A5: the only conversation of V2''s kind from four days in, its payment a week before the window closes                              |     40 |    39 |    1 |    0 |    0 | 0.489 |       58 |
| A6: the only first call in the zone of three for a reason, each of the shape after the one before                                   |     39 |    39 |    0 |    0 |    0 | 0.454 |       61 |
| A7: the only closed call in the zone with its issue's call 3 to 15 days on and one of the shape under another                       |     44 |    44 |    0 |    0 |    0 | 0.482 |       66 |
| A8: A1, or else A4', and A2 beside it                                                                                               |     40 |    39 |    1 |    0 |    0 | 0.426 |       57 |
| A8': A1 and A2, nothing else                                                                                                        |     45 |    44 |    1 |    0 |    0 | 0.474 |       64 |
| A9: the only first call of a pair in the zone with a single note                                                                    |     48 |    48 |    0 |    0 |    0 | 0.526 |       72 |
| A10: the only first call of a pair in the zone whose later call is its reason's only unlogged call that month                       |     49 |    47 |    0 |    2 |    0 | 0.523 |       71 |
| Z0: the last unlogged call a call of the shape follows                                                                              |      0 |     0 |    0 |    0 |    0 | 0.008 |        3 |
| Z0': the same, one of those under another issue                                                                                     |      4 |     0 |    0 |    4 |    0 | 0.035 |        5 |
| Z1: the last such call in the zone                                                                                                  |      3 |     0 |    0 |    3 |    0 | 0.035 |       11 |
| Z1': the first                                                                                                                      |      8 |     0 |    0 |    8 |    0 | 0.062 |        7 |
| Z2: the last in the zone, one of its later calls under another issue                                                                |      6 |     0 |    0 |    6 |    0 | 0.053 |       11 |
| Z3: the same, with a promise the log holds within 120 days                                                                          |      6 |     0 |    0 |    6 |    0 | 0.059 |       11 |
| Z4: the same, one of its later calls with no promise                                                                                |      7 |     0 |    0 |    7 |    0 | 0.062 |        9 |
| Z5: Z2, with a settled promise a draw could have anchored within 120 days                                                           |      6 |     0 |    0 |    6 |    0 | 0.059 |       11 |
| Z6: the first of those                                                                                                              |      8 |     0 |    0 |    8 |    0 | 0.070 |        8 |
| V2' as the earlier script had it, hardship calls left out                                                                           |     40 |    39 |    1 |    0 |    0 | 0.472 |       57 |
| V8 as the earlier script had it, `raised_again` on the later calls with the root's disposition                                      |      7 |     7 |    0 |    0 |    0 | 0.119 |       10 |
| M1: Z3, skipping a call that is another candidate's later call                                                                      |      4 |     1 |    0 |    3 |    0 | 0.061 |        8 |
| M2: the first of those                                                                                                              |      8 |     1 |    0 |    7 |    0 | 0.075 |        9 |
| M3: Z3 where a chain of three starts                                                                                                |      8 |     6 |    0 |    2 |    0 | 0.098 |       18 |
| M4: the only call with no promise, no logged call for its reason, none on its issue 3 to 15 days on, and a chain after              |     43 |    43 |    0 |    0 |    0 | 0.491 |       74 |
| M5: the last conversation of V2''s kind with no attempt on its day                                                                  |     23 |    22 |    1 |    0 |    0 | 0.341 |       23 |
| M6: the first call in the zone with no promise, a later one of the shape with the borrower, a promise the log holds within 120 days |      9 |     0 |    0 |    9 |    0 | 0.076 |        7 |

A fourth review the same day tried structural policies that read what the
tables did not: the window's extent, the dialer on a promise call's day, and
how often a candidate's reason is called about. They are the fourth table's
(G1 to G10, the two naive Bayes rankers it fitted written out, and the
rework's own N1 to N3), with what each passes now. Three tells, each removed
at its cause:

- **the window's extent.** The window was drawn about the pair of anchors,
  so a pair fit it only when the days before it (past the ten the anchors
  need) and after it added up to 90 to 210, and a closer fit was a likelier
  pair. Over the settled promises the log holds, that ruled out about a
  fifth of the calls that look like an S-02 root and few roots. Read beside
  how many unlogged calls the candidate's reason has in the window (a root's
  call raising it again is certain, a look-alike's later call came at the
  pin's chance or by chance, and chance favors a reason the borrower calls
  about often), it passed 13 of the 25 windows on S-02's kept arm (G4, and
  the ranker it is written from), a majority of an arm. The window is now
  drawn about one pair, and the anchors drawn again from every pair it holds
  as it holds that one, so given the window they are any pair it holds;
- **the dialer on a promise call's day.** A recorded promise ceased the
  dialer from the start of its call's day, and the twin kept that day quiet
  to stay the clean history until the call, so no root's day held another
  attempt where 13 % of the look-alikes' did, and the twin dialed the next
  day (A2's quiet day). Reading both, G7 passed 18 of the kept arm's 38 on
  the training suite and 26 to 31 of 50 on three of four fresh suites. A
  pinned promise now ceases the dialer from the call's minute
  (`cease_from_call`): an attempt earlier that day is made in the clean
  history too, and the twin dials that day as any other;
- **the follow-ups around an S-02 root.** The twin drew the escalation's
  follow-up on a closed root's issue and refiled it, on a Sunday as often as
  any day, which no closed call's follow-up is; it called again about the
  complaint beside the borrower's call again about the matter; and only a
  closed matter was called about again, so an open row with a later call
  was twice as likely a root. The pinned borrower now calls again about the
  matters an agent handled, open or closed; about a complaint nobody logged
  that call is the one raising it again, and the one the clean history drew
  is not made; and where the twin's row is closed the escalation's
  follow-up is not made either (each is drawn and undone, so every later
  call keeps its number).

What is left is the reason count: a root's call raising it again is certain
and a look-alike's later call is not, so a reason called about three to six
times in a window holds a root two to three times as often as one called
about nine times or more. Two pins thin what it buys. The borrower calls
fourteen times as often (`call_multiplier`, nine before), so a window holds
about thirteen calls that look like an S-02 root where it held seven. And an
S-01 root's promise is no longer the payment that kept it: the pinned
borrower names a day up to a week past the payment's (`kept_promise_slack`),
as a promise's date is the borrower's and the payment comes on or before it,
so only the note says the date, and a policy that guesses the promise from
the payment names the wrong date seven times in eight. Before that pin the
kept arm was the nearest: a random pick among the conversations of V2's kind
the zone allows found 35 % of its roots, and NB01, refitted, 26 of 50 on a
fresh held-out draw (seed 3).

| Policy                                                                                                                                                           | Passes | Clean | S-01 | S-02 | Both |  Mean | Training |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----: | ---: | ---: | ---: | ----: | -------: |
| G1: S-02, the candidate in the zone the window's extent fits best                                                                                                |      7 |     0 |    0 |    7 |    0 | 0.085 |       14 |
| G2: the first the extent fits                                                                                                                                    |      9 |     0 |    0 |    9 |    0 | 0.094 |       11 |
| G3: the first it fits with no call for its reason in the 61 days before, or else the first it fits                                                               |      7 |     0 |    0 |    7 |    0 | 0.087 |       10 |
| G4: a reason with three or four unlogged calls first, then two, five or seven, the rest last; a fit the extent rules out a third, a loose one before a close one |      8 |     0 |    0 |    8 |    0 | 0.076 |        9 |
| G5: the only one the extent fits with no call for its reason in the 61 days before and no promise                                                                |     34 |    33 |    0 |    1 |    0 | 0.421 |       50 |
| G6: S-01, the conversation of V2''s kind the extent fits best                                                                                                    |     26 |    23 |    3 |    0 |    0 | 0.332 |       31 |
| G7: of those with no other attempt on their day and the guessed promise in the zone, the best fit, a quiet dialer day counted thrice                             |     29 |    26 |    3 |    0 |    0 | 0.351 |       32 |
| G8: no other attempt on its day, the promise in the zone, a quiet day first, the last                                                                            |     26 |    24 |    2 |    0 |    0 | 0.353 |       29 |
| G9: the only one of G7's with a quiet dialer day                                                                                                                 |     47 |    46 |    1 |    0 |    0 | 0.493 |       66 |
| G10: both, the conversation and the S-02 candidate whose pair the extent fits best                                                                               |     24 |    24 |    0 |    0 |    0 | 0.248 |       32 |
| NB, refitted: S-02 by a reason's unlogged calls and the extent's fit                                                                                             |      4 |     0 |    0 |    4 |    0 | 0.058 |       14 |
| NB01, refitted: S-01 by the fit, the anchors, an attempt that day, the zone, the next attempt and the payment's lag                                              |     21 |    19 |    2 |    0 |    0 | 0.305 |       21 |
| N1: S-02, a reason with three to six calls an agent handled, no complaint logged for it, none in the 61 days after                                               |      2 |     0 |    0 |    2 |    0 | 0.034 |       18 |
| N2: S-01, G8's choice, its promise dated the log's median days between a kept promise's date and its payment                                                     |     25 |    24 |    1 |    0 |    0 | 0.350 |       29 |
| N3: S-01, NB01's choice, its promise dated a week past the payment                                                                                               |     22 |    19 |    3 |    0 |    0 | 0.295 |       24 |

A fifth review the same day read the redraw itself, and what the tables still
did not: the share of a window's pairs a candidate is in, the call raising a
complaint again and what follows it, which call comes first on an issue, the
comment log's counts and users, and the payments around a call. It wrote ten
policies on them (H1 to H9, and H6') and fitted logistic rankers on those and
about seventy other features of a candidate, the smallest written out (LF).
They are the fifth table's. None found a tell:

- **the redraw.** Given the window, a candidate is as likely as the share
  of the window's pairs it is in, by arm its promise partners over every
  logged complaint's and its own. The pairs a window holds are held to the
  zone, so most candidates share the largest: the root's is the largest in
  41 of the 50 held-out S-02 windows, tied there with eight or nine others
  on average, and H1 finds 4 roots;
- **what follows the call raising a complaint again.** It is followed for its
  reason, at the pin's chance, by a call of its own, which a look-alike's
  call again about its matter, a follow-up itself, never is. The borrower
  calls fourteen times as often, so a later call for the reason comes by
  chance about as often (H2, H4, H8);
- **the window with no pair of a kind.** Where no settled promise the log
  holds fits a logged complaint, the window's promise anchor was not recorded
  or was of the other arm: on the held-out suite no kept promise fits one in
  33 of the 50 S-01 and both windows on the kept arm and in 1 of the 50 clean
  and S-02 ones, but in 32 of the 100 clean and S-02 windows on the broken
  arm. It says S-01 is likelier, not which call, and never the date, which
  the borrower names up to a week past the payment's; dated by the log's
  commonest slack, or three days past the payment, the call finds no kept
  promise held out and at most 2 of an arm's 38 in training (H6, H6', H7);
- **the rankers.** LF, fitted on the 800 clean and S-02 windows of four fresh
  suites of 400 (train seeds 12 and 13, held-out seeds 2 and 3) and written
  out with 32 weights, passes 12 S-02 windows held out (6 and 6 by arm) and
  17 of 75 in training (10 and 7). The same logistic over all 281 indicator
  features passes 14 (10 and 4) and 19 (10 and 9); with the reason, its count
  and the later call's crossed, 15 (8 and 7) and 22 (11 and 11); a
  conditional logit fitted on the S-02 windows, alone or with the both
  windows, at most 12 (10 and 2) and 21 (12 and 9). Fitted on three of the
  fresh suites and scored on the fourth, the 281-feature logistic passes 15
  to 26 of 100 S-02 windows, at most 15 of an arm's 50. Naming its candidate
  only where its fitted chance clears a threshold, the one chosen on the
  fitting suites or any from 0.3 to 0.6, a logistic passes at most 51 held
  out and 78 in training: the window and the anchors are drawn before the
  plan is made, and the root's row is a clean row's, so a window with an S-02
  root reads as a clean one does.

| Policy                                                                                                                                                                                                         | Passes | Clean | S-01 | S-02 | Both |  Mean | Training |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----: | ---: | ---: | ---: | ----: | -------: |
| H1: S-02, the candidate the redrawn pair most likely lands on                                                                                                                                                  |      4 |     0 |    0 |    4 |    0 | 0.040 |       11 |
| H2: its later call followed for its reason 3 to 61 days on, logged or not, the reason three to six calls, the likeliest pair                                                                                   |     32 |    23 |    0 |    9 |    0 | 0.266 |       37 |
| H3: a closed call off the arrangement and hardship reasons, its later call closed, with the borrower and no promise, the last                                                                                  |     16 |    11 |    0 |    5 |    0 | 0.136 |       24 |
| H4: one note on it and one on its later call, an agent's each, and a call after that, the only one                                                                                                             |     44 |    43 |    0 |    1 |    0 | 0.506 |       68 |
| H5: nothing on its issue 3 to 15 days on, its later call the first on an issue of a later month, the reason with the fewest calls, three or more                                                               |      7 |     2 |    0 |    5 |    0 | 0.098 |       19 |
| H6: S-01, where no kept promise the log holds fits a logged complaint, the conversation of V2''s kind one payment follows within 21 days and none preceded, the most partners, dated the log's commonest slack |     43 |    43 |    0 |    0 |    0 | 0.472 |       62 |
| H6': the same call in every window, dated three days past the payment                                                                                                                                          |     28 |    28 |    0 |    0 |    0 | 0.362 |       35 |
| H7: both, where no promise the log holds fits a logged complaint, H6's call and LF's candidate                                                                                                                 |     50 |    50 |    0 |    0 |    0 | 0.525 |       77 |
| H8: a reason's first call, in the zone, of three or four for it, each 3 to 61 days after the one before, the only such reason                                                                                  |     40 |    39 |    0 |    1 |    0 | 0.406 |       62 |
| H9: a payment in the week before it and none in the three weeks after, the likeliest pair                                                                                                                      |     22 |    19 |    0 |    3 |    0 | 0.263 |       46 |
| LF: S-02, a logistic written out: the pair's share, the later call and what follows it, the reason, its count, the caller                                                                                      |     12 |     0 |    0 |   12 |    0 | 0.095 |       18 |

The clean share is 50 of 200, and 75 of 300 on the training suite. On the
held-out suite no structural policy in the five tables passes more than 50:
of the ones that pass an error's window the most there is 49, A10 (47 clean
and 2 S-02), and 48 by reason, the only unlogged pair for a payoff request
(46 and 2). On the training suite the most is 77, H7 (75 clean, one S-02
window and one both), then 74, M4 (67 and 7), and by reason 72, the
online-access pair (71 and 1). None passes a majority of any error's windows,
nor of either promise arm's within one: on the held-out suite the most is 16
S-01 windows (the promise note nearest the window's middle, which reads the
notes; 8 of the kept arm's 25) and 3 structurally, and 12 S-02 windows (LF),
7 of an arm's 25 (M6); on the training suite 24 of 75 S-01 windows (the same
note; 17 of the kept arm's 38) and 4 structurally (N3), and 17 of 75 S-02
windows (N1 and LF), 12 of an arm's 38 (N1). Out of sample, on four fresh
suites of 400 (train seeds 12 and 13, held-out seeds 2 and 3; NB and NB01
fitted on the first two, and LF, fitted on all four, left out), no structural
policy in the tables passes more than 20 of the 100 S-02 windows (H2,
held-out seed 3) or 12 of an arm's 50 (H2), nor 9 of the kept arm's 50 (N3).
Beyond the tables, the fifth review's larger rankers pass at most 15 of the
50 S-02 windows held out and 10 of an arm's 25, 22 of 75 in training and 12
of an arm's 38, and out of sample 26 of 100 and 15 of an arm's 50. A test
holds every row of the five tables, and holds each policy, every one of the
structural ones by reason too (a reason's first unlogged call, and its only
pair), under those bounds on both suites: at most four points past the clean
windows, and less than half of any error's windows and of either arm's. The
rule itself, clause by clause, passes all 200, so each row of the first table
is what leaving a clause out costs: the raised-again clause alone costs the
100 windows with an S-02 root, every one of which holds a call raising it
again.

**The proof of fairness.** The reference passes the held-out suite, 300
training tasks (seed 11) and fifteen hand-built histories in at most three
turns and seven tool calls (two and six on the generated windows): one turn
reads the logs and searches the transcripts, one adds up a window's
payments, one submits. The histories hold each rule on its edge: a promise
recorded and kept; one not recorded with two attempts in its window; the
window's pay-by date in and the day after out, and a payment a cent short;
an attempt earlier on the promise call's day out and one later in; two
payments after the call's day adding up to the promise, beside one on the
call's day that does not count; a copied-forward note's promise; a complaint
logged and answered on day 9; one not logged and raised again; a later
complaint for the same fee, logged this time; both on one loan; and, for the
rules on false roots, a clean window beside promises recorded, kept and
broken, and complaints logged; an unrecorded promise beside promises the log
holds; an unlogged complaint beside complaints logged, raised again under an
issue of its own; one raised again four days later, before an answer was
due; and a promise on a hardship call referred to loss mitigation, whose
disposition says nothing either way. On the first three of those, reporting
every promise or every complaint fails on a false root; on every history
raising a complaint again, so does leaving the raised-again clause out; and
on every history with an error, the roots alone fail on their symptoms.

DeepSeek-V4.1-Flash's held-out baseline (thinking, 16,000 output tokens a
turn) is 160 of 200 (80.0 %); 37 of its 40 misses ran out of tokens
(docs/decisions.md, "DeepSeek's held-out baselines on the newest suites, and
two corrected").

Not in 1.0.0:

- other staff errors (a payment taken over the phone and not posted, a
  callback promised and not made, a third party's authorization taken and
  not recorded);
- interpreted calls: the borrower is English-speaking, as in call-qa;
- the written channels' complaints: a complaint by letter or e-mail may be
  a notice of error (§1024.35), with clocks of its own, and the contact
  center draws complaints on calls only;
- a promise or a complaint the recognizer hid from the reviewer, which only
  the label could tell;
- a staff error on the scenario's own promise call.

Generating the held-out suite takes about a minute on a loaded machine.

## The Supermortgage Gym

Every environment also runs in a browser, for people without a checkout:
https://claude.ai/artifact/LKEDiyPJyoQ4UwijqwpNw6 (private; shared by its
owner). `playground/entry.ts` puts each environment the CLI registers behind
one plain-JSON interface and hands every call to that environment's own
generator, tools, parser, grader and reference, so the page cannot drift from
the runner. `scripts/build-playground.mjs` bundles it and gathers
`runs.json`: model episodes on the train split only, each held to the
held-out guard. The page offers training tasks and spec cases and never a
held-out task. A held-out score at its environment's own output budget is
labeled by the model alone ("DeepSeek") and comes first; a score at another
budget names it ("DeepSeek, 16k budget" on boarding-triage, "DeepSeek, 32k
budget" elsewhere), read off the policy id and the bundle's `outputBudget`.
Republish both files after an environment changes:

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
npm run env:refi -w @hm/environments -- --env qualifying-income --policy reference
npm run env:refi -w @hm/environments -- --env lossmit-retention --policy reference
npm run env:refi -w @hm/environments -- --env metro2-furnishing --policy reference
npm run env:refi -w @hm/environments -- --env aus-decision --policy reference
npm run env:refi -w @hm/environments -- --env ei-clocks --policy reference
npm run env:refi -w @hm/environments -- --env catchup-posting --policy reference
npm run env:refi -w @hm/environments -- --env escrow-review --policy reference
npm run env:refi -w @hm/environments -- --env boarding-triage --policy reference
npm run env:refi -w @hm/environments -- --env call-qa --policy reference
npm run env:refi -w @hm/environments -- --env contact-audit --policy reference
npm run env:refi -w @hm/environments -- --env tape-intake --policy reference
npm run env:refi -w @hm/environments -- --env boarding-triage --policy vertex --max-tokens 16000   # a budget other than the environment's own
npm run env:transfer-package -w @hm/environments -- --out /tmp/packages   # the demo loan's four packages
npm run env:transfer-package -w @hm/environments -- --out /tmp/packages --each   # and one of each defect alone
npm run env:demo -w @hm/environments                                      # the first demo's page, playground/dist/demo.html
npm run board:life-package -w @hm/servicing -- /tmp/packages/defective     # boarded by the servicing app's own boarding
npm run board:life-package -w @hm/servicing                                # the demo's four and the ten, each label caught or not
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
episode that ended in a transport error, or whose turn never ran (no tool
called and not one token spent, `neverRan` in `src/record.ts`), is not
scored. The newest scored episode for each task counts, and a task not
scored on both sides is left out by name. `--resume --out FILE` runs exactly
those two kinds again, and the Gym's held-out counts skip them the same way.
Phase 2's gate is read from it.

The default is the reference policy on the held-out suite. A model run
spends real money, and it is never the default.

**The output budget** is what a model may write in one turn, reasoning
included, and every model policy runs at the same one: `--max-tokens` if
the run asks, else the environment's own (`outputBudget` on its
`Environment`), else the policies' default of 16,000 (`outputBudgetFor` in
`src/episode.ts`). boarding-triage and tape-intake declare 32,000 (decided
26 October 2026; their sections say why); no other environment declares
one. Each policy's id names any budget but 16,000, `…:max-tokens-32000`
after the Vertex policy's thinking mode or the Claude policies' effort, so
a run record always says its budget, and a run on boarding-triage with no
flag is recorded at 32,000. Pricing reads the id by its prefix, so the
suffix costs nothing. The budget is in no fingerprint, because the tasks
and the grading do not change with it.

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
  - Each turn may write the episode's output budget, reasoning included
    (above): 32,000 on boarding-triage and tape-intake, 16,000 elsewhere.
    The policy id names any budget but 16,000
    (`…:thinking:max-tokens-32000`). An episode that spends its budget
    mid-turn ends `max_tokens` and fails.
  - Every request streams. The endpoint takes 2 to 70 seconds a turn, and
    some turns run past five minutes. Unstreamed, that is where Node's fetch
    gives up waiting for headers, which ended four of the first five smoke
    episodes. A dropped connection is retried whole.
  - A tool call whose arguments are not a JSON object goes back in the
    history wrapped as `{"unparsed_arguments": …}`. Sent back as written,
    Vertex refused the next request whole (400, "Expected a valid JSON
    object"), which ended 2 of about 4,000 episodes by 22 October; the
    environment answers the call with an error, and the episode goes on.
  - A turn is taken only when its stream arrives whole: a `finish_reason`,
    then the usage chunk or `[DONE]`. Anything else is retried whole, with
    the waits a dropped connection gets. After the last try the episode
    ends `error` and says what came, and `--resume` runs it again. What the
    endpoint sent, probed on call-qa training tasks on 26 October:
    - **A stream cut mid-turn.** An HTTP 200, `text/event-stream`, that
      stops as a clean end of the body: no error, no `finish_reason`, no
      usage, no `[DONE]`. The call-qa streams in flight were cut together,
      on the same second and at the same chunk count, and a cut can fall
      inside a tool call's arguments. All of the first 15 call-qa first turns sent as
      the policy sends them were cut, one, two, four and eight at a time.
      Then 24 sent at once all came whole, and 40 of 48 sent at once were
      cut. Before this check a cut first turn read as a model that stopped
      with no answer: `no_submission`, one turn, no tool calls, no tokens.
    - **A line of plain text in the stream**, before the turn: a `data:`
      line reading "inference error: ServiceUnavailable - failed to find
      endpoint candidates for serving the request", then a whole turn from
      its first chunk. The parser threw on it and ended the episode
      (`Unexpected token 'i', "inference "… is not valid JSON`), and a
      line starting `upstream c` did the same. Such a line before anything
      of the turn has arrived is now a notice, and the whole turn after it
      is taken. After the turn has begun, it is a cut.
    - **An error in the stream**, not sent in the probe but recorded seven
      times in the baselines of 21 to 23 October: "Prediction for model …
      failed with error: Model server early terminated the request
      (truncated headers)". It ended the episode at once. It is now retried
      the same way, and the rest of the body is let go unread.
    - **Not seen, and retried the same way:** an empty 200, a 200 whose
      body is not a stream, a `finish_reason` followed by neither usage nor
      `[DONE]`, and a turn with no content, reasoning, tool call or usage. A
      `data:` line that is JSON but not an object is read as a line of text.

    The cuts do not follow concurrency or prompt size. A call-qa first turn
    sent alone was cut, eight escrow-review first turns sent beside eight
    cut call-qa ones all came whole, and call-qa's prompts are no longer
    than boarding-triage's. They follow how the prompt opens: four call-qa
    turns with a varying line put before the rulebook, sent beside four that
    were cut, all came whole. That suggests the endpoint sends prompts that
    open alike to the same server, but it is an inference, and the policy
    does not vary its prompts. Eight call-qa training episodes through the
    checked policy all passed, seven of them after one retry.

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
