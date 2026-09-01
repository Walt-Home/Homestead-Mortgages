# The requirement registry

`data/v1-build.csv` is Drew's V1 build sheet. It is the source of truth for
what this product must satisfy, and this document is about the machinery that
turns it into code.

## The pipeline

```
data/v1-build.csv
  → scripts/build-requirements.mjs
  → packages/requirements/src/generated.ts   (committed)
  → conditions.ts + satisfaction.ts + graph.ts
  → engine.ts
```

The generated file is committed on purpose. The registry is the spine every
other package imports, and a build step that has to run before TypeScript can
resolve a type is a build step that breaks somebody's editor on a Monday.
`npm run requirements:verify` regenerates in memory and fails on drift, and it
runs in CI, so the committed copy cannot silently diverge from the sheet.

## Changing the sheet

1. Replace `data/v1-build.csv`.
2. `npm run requirements:build`.
3. If it throws, it found a value it has no mapping for. Add the mapping and,
   for a new `Applies when`, a predicate in `conditions.ts` and an evaluator in
   `satisfaction.ts`. `registry.test.ts` fails until both exist.

Every mapping in the generator is exhaustive and throws on an unknown value.
That is the design: a requirement that quietly defaults to `universal` is a
requirement applied to borrowers it was never meant for, and nothing would say
so.

## The three questions, kept apart

| Question | Lives in | Answers |
|---|---|---|
| Does it apply to this borrower? | `conditions.ts` | `true` / `false` / `null` |
| Is the evidence here? | `satisfaction.ts` | satisfied / unsatisfied / blocked |
| Can it be worked on yet? | `graph.ts` | dependencies, from the timing column |

A borrower is only shown the intersection: applicable, unsatisfied, unblocked.
Everything else is not their problem, or not their problem *yet*, and showing
it is how a 77-row compliance sheet becomes a form nobody finishes.

### Why applicability is three-valued

At screen 1 we do not know whether the credit report carries a dispute flag,
so CRD-014 is not inapplicable — it is undetermined. The UI says "we might
still ask" for these, which is the honest sentence.

This is also why `progress()` counts only requirements that **definitely**
apply. Several evaluators are vacuously satisfied against empty data — "0
investment income sources with a two-year history" is trivially true before any
income exists. Counting those while applicability is unknown inflated the
satisfied count early and then *deflated* it when payroll resolved them to
inapplicable: 23 → 21 across one connection, on five requirements at once. A
borrower watching their progress go backwards for connecting an account is
exactly what this product exists to prevent. There is a regression test.

## The dependency graph

`Before UW-004` and `After CRD-001` are edges. Once drawn, the sheet stops
being a checklist and becomes an order of operations, which is what lets the
product answer "what is left?" with work that is genuinely unblocked.

Six timing constraints point at `CLS-001`, `CLS-002` and `CLS-013` — the
closing-stage family, which lives in a sheet that does not exist yet. They are
recorded in `DANGLING_REFERENCES` rather than dropped, and a test pins the
count. That seam is where V1 hands off.

## Two things to take back to Drew

**APP-002's clock does not start where the row sits.** It is on screen 1 and
says the three-business-day Loan Estimate clock starts when six pieces are
received: name, income, SSN, property address, value estimate, loan amount.
Screen 1 collects address, price and down payment; name and SSN arrive on
screen 2; income does not arrive until the bank or payroll connection. So as
drawn, a regulatory-violation-severity clock starts at an unpredictable point
mid-flow.

The product's answer is a stated, unverified monthly income field on screen 1.
One number, no verification, and the sixth piece lands at the end of screen 2 —
predictably, before any connector runs. `services/application.ts` stamps the
receipt exactly once and never un-stamps it.

**Screen 7's sourcing contradicts its premise.** Four rows sit on "Upload
fallback" or "Decision" but name a connector as their source: AST-006 (gift
funds), INC-021 (support income), INC-023 (equity comp), AST-004 (reserves).
If screen 7 is "only what didn't connect", these are miscategorised. If they
are genuinely connector-derived with an upload fallback, then the real model is
that *every* requirement has a connector path and a fallback path, and the
sheet should say so uniformly. The code is built to the second reading.
