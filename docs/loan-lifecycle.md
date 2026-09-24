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

| Piece                                           | Status                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LoanState`, the enum and its migration         | Built                                                                                                         |
| `loans`, `loan_parties`, the cascade            | Built                                                                                                         |
| `loans_terminal_is_final`, the transition guard | Built                                                                                                         |
| `services/loan-transition.ts`                   | Built; the importer moves a loan a tape says ended                                                            |
| `services/loans.ts` constructor                 | Built; `services/partner-book.ts` is its first caller                                                         |
| A route that creates a loan                     | `POST /api/partner/book/imports`, opened by a partner key                                                     |
| The tape reader                                 | `packages/partner-book`, one profile, Doug's §33.1 ported                                                     |
| A loan's record, to its party                   | `GET /api/loans` and `/api/loans/:id/servicing`; the web's `/loans/:id` renders it                            |
| The claim                                       | Built: a token the servicer delivers or the tape desk mails, never an e-mail match at sign-in — `loan_claims` |

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
a token the partner delivers — and it links no row to a party somebody has
signed in as, because a loan appearing in an account without a claim is the
oracle the 404 rule suppresses. Every row is its own provisional party until
the claim merges it. `docs/decisions.md`, "A book is a tape, read once". The
tape desk reads the supplement's e-mail once, for the invitation, and keeps
it nowhere but on the claim it mailed.

The claim is `loan_claims`: the partner mints a single-use token for one
unclaimed loan through its key and delivers it, or ops staff mint it from the
tape desk and the desk mails it to the supplement's address; whoever holds the
link takes it after signing in, the tape's party folds into theirs, the loan
moves to `monitoring_only` as `claim_confirmed`, and the offer the review
made while nobody could see it is delivered.
`docs/decisions.md`, "A mortgage is claimed by a token the servicer delivers"
and "The tape desk is one screen, and a claim is mailed from it".

And since 22 September the review is ours. Each morning at seven Eastern a
job reads every watched loan off its newest observation — since
24 September that is every loan on a servicer's book from the day it is
loaded, claimed or not; the claim delivers the offer the review made, and
the desk runs the same review the day the book lands so it can invite the
candidates first — asks the pricing
port for one 30-year fixed on the candidate, and runs the ported engine —
Doug's §33.2 over his §20.1, `packages/refi-review` — writing one
`loan_reviews` row per loan per day, append-only, with the verdict, its
reasons, its facts and, for a candidate, the benefit disclosure. The deploy
runs it once after the seed. `docs/decisions.md`, "The daily review is ours
now".

Since the same day a loan answers for itself, to the party on it and to
nobody else: `GET /api/loans/:id/servicing` is the newest observation — what
the tape said on its as-of date — beside what the servicing platform has
concluded since, read live through the `servicing` connector port when the
servicer's `integrationDepth` is `API` or `SUBSERVICED`: the daily review's
verdict and reasons, the offer if there is one, what a refinance still needs,
the open clocks. The two halves stay apart on the wire, and the live half
says whether it was not asked, asked and empty, or asked and unreachable.
Our own newest review rides beside them as a third field, and the page shows
it first. `docs/decisions.md`, "The servicing platform is read, never
joined".

Since 23 September a candidate is an offer, and an offer is answered. The
review's candidate becomes a `refi_offers` row carrying the review's
benefit disclosure as its own figures, open thirty days, one per loan at a
time, delivered as the card on the person's loan page and nowhere else. The
review leaves a loan with an open offer alone. Yes opens a refinance
application in our five screens with screen 1 answered from the loan and
the tape — the person states their income on the card, the one thing no
tape knows — and `applications.prior_loan_id` names the loan from birth; at
most one such application is open per loan. Not now is his ninety-day
cooldown, never is a standing suppression, two offers per loan per year,
and the engine reads all three off the offers. When the refinance funds,
`retirePriorLoan` names the successor and moves the prior loan
`refinanced_by_us`. `docs/decisions.md`, "An offer is a row and a card".

Nothing a borrower can do produces a loan, still. What renders one is the
twelve-loan Northlight book: the persona seed loads it under its servicer at
integration depth `API` and walks the `grander_import` sign-in through the
claim on NL-100001 — a token minted as the partner, taken as the sign-in —
so a tester on staging can sign in as that row, find a watched mortgage
leading the home page, and open `/loans/:id`: the tape's figures under the
servicer's name and date, the platform's verdict, offer and readiness under
ours. In a
development database, `npm run partner:book -- sample northlight` loads the
same book with nobody standing on it.

## Where the rest lives

- `docs/states.md` — the application lifecycle, and what the product can say
  about a person today.
- `docs/du-readiness.md` — what a submission needs, and which parts of this
  model it depends on.
- `docs/decisions.md` — why state is stored rather than derived, and why the
  tests need a real database.
