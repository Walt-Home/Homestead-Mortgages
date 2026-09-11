# Loan lifecycle

A **Loan** is a mortgage that exists in the world. An **Application** is a
request for credit. They are different objects with different lifetimes, and
conflating them is what `LoanFile` used to do.

Split out of `docs/states.md`, which covers the application side. Read that
one first if you want the whole model.

## Why it is its own object

An application starts, ends, and is never reopened. A loan outlives the
application that made it, and may never have had one:
`loans.originating_application_id` is **nullable, and that nullability is
load-bearing** — a Grander portfolio mortgage has no application behind it.

The Loan hangs off Party rather than Application, through the `loan_parties`
join. So deleting a stale application cannot erase the record of a mortgage
somebody is still paying.

## The eleven states

`LoanState`, at `packages/db/prisma/schema.prisma:1292`.

**Ours, not yet placed**

| State                | Means                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `PENDING_BOARDING`   | Funded and ours, not yet at a servicer                             |
| `BOARDING`           | Transfer file sent, not acknowledged                               |
| `IMPORTED_UNCLAIMED` | A Grander mortgage attached to a party who has never authenticated |

**Live**

| State                   | Means                                                           |
| ----------------------- | --------------------------------------------------------------- |
| `ACTIVE`                | Serviced in our system of record                                |
| `MONITORING_ONLY`       | We watch it and can offer better; we neither own nor service it |
| `IN_SERVICING_TRANSFER` | Moving to us or away                                            |

**Ended** — all five terminal

| State                   | Means                                               |
| ----------------------- | --------------------------------------------------- |
| `PAID_OFF`              | Satisfied by any means other than our own refinance |
| `REFINANCED_INTERNALLY` | Paid off by a loan we originated                    |
| `TRANSFERRED_OUT`       | Servicing sold; we may keep the relationship        |
| `CHARGED_OFF`           | Terminal loss; starts the party's seasoning clocks  |
| `MATURED`               | Term completed                                      |

## Three distinctions that must not collapse

**`REFINANCED_INTERNALLY` is not `PAID_OFF`.** It is the monitoring loop's
success metric: prior loan → opportunity → application → new loan is the one
attributable chain the product exists to produce. Folding it into `PAID_OFF`
makes the product unable to measure itself.

**`IMPORTED_UNCLAIMED` is the Grander path's actual object** — a loan and a
party with no application, because an application in any state would assert
the person asked us for credit. Nothing person-keyed may be retrieved for one.
A rate comparison against a published rate sheet is lawful, because our own
servicing data joined to a rate sheet is not a consumer report.

**Delinquency is an attribute of the newest servicing observation, not a
state.** A loan does not become a different kind of thing because a payment
was late.

## What the database enforces

**Terminal is final.** `loans_terminal_is_final` refuses any update that moves
a loan out of the five ended states — `loan % is % and cannot be reopened`
(migration `20260910100000_the_loan/migration.sql:292`, terminal list at
`:354`). The same trigger body is generated for applications, so the two
aggregates cannot drift on what "ended" means.

**A loan survives losing one owner.** Deleting a co-borrower removes their
`loan_parties` link; the loan itself is swept only when the last party leaves
(`the_loan/migration.sql:473`, `:488`). This is the join-table pattern the DU
work will reuse for assets and liabilities.

**Integration depth is a connection detail, not a lifecycle fact.** Deep link,
then API, then Supermortgage as the subservicer. Becoming the servicer is a
configuration change rather than a migration, which is why no state names it.

## Status: built, with no production writer

This is the part to be honest about.

| Piece                                           | Status                         |
| ----------------------------------------------- | ------------------------------ |
| `LoanState`, the enum and its migration         | Built                          |
| `loans`, `loan_parties`, the cascade            | Built                          |
| `loans_terminal_is_final`, the transition guard | Built                          |
| `services/loan-transition.ts`                   | Built, exercised only by tests |
| `services/loans.ts` constructor                 | Built, **no non-test caller**  |
| A route that creates a loan                     | **Does not exist**             |
| The Grander import that would fill it           | **Deferred, deliberately**     |

No mounted router mentions loans. Nothing a borrower can do produces one. The
model is in place and waiting for the import that populates it, which was
deferred on purpose rather than forgotten — see `docs/du-readiness.md` for why
the Grander relationship is the question that gates it.

Treat "there is no production writer" as load-bearing when reading anything
that renders a loan: the sample borrowers are the only rows that exist, and
they are seeded.

## Where the rest lives

- `docs/states.md` — the application lifecycle, and what the product can say
  about a person today.
- `docs/du-readiness.md` — what a submission needs, and which parts of this
  model it depends on.
- `docs/decisions.md` — why state is stored rather than derived, and why the
  tests need a real database.
