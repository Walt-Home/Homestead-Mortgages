# Environments

An environment is a task, the tools a model may use, and a grader the model
never sees. `packages/environments` holds them. The first, `refi-review`
1.0.0, grades a model on the daily refinance review, using synthetic loans
only and with the engine itself as the grader.

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

refi-tape 1.0.0 is option A of the plan's harder versions: the same review,
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

## Commands

```bash
npm run build -w @hm/environments
npm run env:refi -w @hm/environments -- --policy reference
npm run env:refi -w @hm/environments -- --policy anthropic --model claude-opus-5-5 --effort high --n 20
npm run env:refi -w @hm/environments -- --policy vertex --split train --n 5
npm run env:refi -w @hm/environments -- --policy anthropic-vertex --split train --n 5
npm run env:refi -w @hm/environments -- --env refi-tape --policy reference
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

## Not in 1.0.0

- Reading the raw tape line. The task starts after `universeLoanOf`.
- The two gates that read Fannie Mae delivery records. The engine treats
  them as open, so the task does too.
- Cash-out candidates, and the analyst's written rationale.
- Nothing outstanding on Phase 1's gate. It was met on 19 October:
  DeepSeek-V4.1-Flash passed 58 of 60 training tasks, and none of 64
  passing episodes passed without the work (see docs/decisions.md).
