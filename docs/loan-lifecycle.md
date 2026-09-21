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

Named here the way `LOAN_STATES` spells them
(`packages/shared/src/loan-machine.ts:48`), which is the spelling the product
uses. **Postgres spells the same eleven in uppercase** — `LoanState`, at
`packages/db/prisma/schema.prisma:1292` — so a loan state crosses the boundary
in two cases, exactly as a `FlowStage` does. Map at the edge; never compare
across it.

**Ours, not yet placed**

| State                | Means                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `pending_boarding`   | Funded and ours, not yet at a servicer                             |
| `boarding`           | Transfer file sent, not acknowledged                               |
| `imported_unclaimed` | A Grander mortgage attached to a party who has never authenticated |

**Live**

| State                   | Means                                                           |
| ----------------------- | --------------------------------------------------------------- |
| `active`                | Serviced in our system of record                                |
| `monitoring_only`       | We watch it and can offer better; we neither own nor service it |
| `in_servicing_transfer` | Moving to us or away                                            |

**Ended** — all five are final; nothing leaves them

| State                                | Means                                               |
| ------------------------------------ | --------------------------------------------------- |
| `paid_off` _(terminal)_              | Satisfied by any means other than our own refinance |
| `refinanced_internally` _(terminal)_ | Paid off by a loan we originated                    |
| `transferred_out` _(terminal)_       | Servicing sold; we may keep the relationship        |
| `charged_off` _(terminal)_           | Terminal loss; starts the party's seasoning clocks  |
| `matured` _(terminal)_               | Term completed                                      |

## Three distinctions that must not collapse

**`refinanced_internally` is not `paid_off`.** It is the monitoring loop's
success metric: prior loan → opportunity → application → new loan is the one
attributable chain the product exists to produce. Folding it into `paid_off`
makes the product unable to measure itself.

**`imported_unclaimed` is the Grander path's actual object** — a loan and a
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

## Status: built, and a partner's tape writes it

This is the part to be honest about.

| Piece                                           | Status                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| `LoanState`, the enum and its migration         | Built                                                     |
| `loans`, `loan_parties`, the cascade            | Built                                                     |
| `loans_terminal_is_final`, the transition guard | Built                                                     |
| `services/loan-transition.ts`                   | Built; the importer moves a loan a tape says ended        |
| `services/loans.ts` constructor                 | Built; `services/partner-book.ts` is its first caller     |
| A route that creates a loan                     | `POST /api/partner/book/imports`, opened by a partner key |
| The tape reader                                 | `packages/partner-book`, one profile, Doug's §33.1 ported |
| The claim                                       | **Unbuilt** — a signed token, never an e-mail match       |

Since 21 September 2026 a servicer's tape becomes rows: one
`partner_book_imports` row per tape read, an `imported_unclaimed` loan on a
PROVISIONAL party of its own per loan the servicer has not sent before, and a
`servicing_observations` row per loan per tape — what the servicer said it
looked like on that date, appended and never overwritten, with delinquency as
a column rather than a state. A tape that says a loan ended moves it as
`servicer_reported` through the same mover a route would use; a tape that says
it transferred is recorded and the loan waits, because the machine models a
transfer as a window with two ends and a tape reports only that it closed.

Two things the import does not do, on purpose. It reads no contact from the
supplement — the feed contract has nowhere to put an e-mail, and the claim is
a signed token the partner delivers — and it links no row to a party somebody
has signed in as, because a loan appearing in an account without a claim is
the oracle the 404 rule suppresses. Every row is its own provisional party
until the claim merges it. `docs/decisions.md`, "A book is a tape, read once".

Nothing a borrower can do produces a loan, still. What renders one is the
sample borrowers' seeded rows and, in development, the twelve-loan Northlight
book that `npm run partner:book -- sample northlight` loads.

## Where the rest lives

- `docs/states.md` — the application lifecycle, and what the product can say
  about a person today.
- `docs/du-readiness.md` — what a submission needs, and which parts of this
  model it depends on.
- `docs/decisions.md` — why state is stored rather than derived, and why the
  tests need a real database.
