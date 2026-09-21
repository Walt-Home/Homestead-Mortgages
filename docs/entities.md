# The nouns

What every entity in this system is, who writes it, and what the database
itself guarantees about it. Written so a new reader can tell a table that is
load-bearing from a table that is waiting for its first row.

Two distinctions do most of the work here, and both are easy to get wrong by
reading the Prisma schema alone:

- **Exists** is not **written**. Several tables are fully modeled, fully
  constrained, and have never held a row outside a test.
- **Enforced** is not **intended**. An invariant held by a trigger survives a
  new route written by somebody who never read this file. An invariant held by
  application code does not.

Inventoried from the schema and the migrations. The adversarial pass that
normally re-derives every "production writer" claim did not complete, so treat
the writer column as good but not proven, and re-check before you build on one.

## The map

`LoanFile` conflated a process, a set of terms, a property and a decision.
Three durable objects came out of it, and the folder stayed.

| Object          | Is                                     | Lifetime                                    |
| --------------- | -------------------------------------- | ------------------------------------------- |
| **Party**       | A durable person or legal entity       | Before, between and after every application |
| **Application** | One request for credit                 | Starts, ends, never reopened                |
| **Loan**        | A mortgage that exists in the world    | Outlives the application that made it       |
| `LoanFile`      | The working folder behind four screens | The old shape, still the one borrowers fill |

A Party carries **no name, date of birth or SSN column**. Those are Facts. An
Application holds no borrower fields and no property columns; it **borrows**
them by pinning facts, and the pin names the authorization it was borrowed
under. That pin is the legal act — TRID's six pieces must be received _in
connection with a request for credit_, and the pin is what makes that provable
rather than asserted.

## Who writes what

"Production" means a route a real borrower reaches. "Seed" means
`seed-personas.ts`, which is gated on `DEMO_PERSONAS`.

### People

| Entity                    | Is                                                                             | Written by                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `users`                   | A sign-in, as Google knows it. An account, not a person                        | Production — upsert on `google_sub`                                                                                              |
| `parties`                 | The durable person we hold information about                                   | Production — `CLAIMED` for a sign-in; `PROVISIONAL` for a named co-borrower, `CLAIM_PENDING` once invited, `MERGED` once claimed |
| `principals`              | Anything that can assert or cause something                                    | Production — 3 of 5 kinds                                                                                                        |
| `facts`                   | One dated statement, by a named actor, about a person                          | Production — always `SELF_ATTESTED`                                                                                              |
| `borrowers`               | A record _about_ a party, on one file                                          | Production                                                                                                                       |
| `application_parties`     | Who is on a credit request, in what role                                       | Production                                                                                                                       |
| `loan_parties`            | Who is on a mortgage, in what role                                             | Seed and tests — no importer yet                                                                                                 |
| `co_borrower_invitations` | The SHA-256 of a link a named person was emailed, and when it stops being good | Production — the invitation route                                                                                                |
| `partner_credentials`     | The SHA-256 of a servicer's bearer key, and when it was revoked                | The `partner:key` command; read on every `/api/partner` request                                                                  |
| `employers`               | A company that pays this person                                                | Production — vendor pulls only                                                                                                   |

### The application

| Entity                       | Is                                                                    | Written by                |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------- |
| `applications`               | One request for credit, in one of 19 states                           | Production — screen 1     |
| `application_transitions`    | Every move it ever made, in order                                     | Production, via the mover |
| `loan_scenarios`             | One version of the deal on the table                                  | Production                |
| `application_evidence_links` | **The pin** — this request relies on this fact, under this permission | Production                |
| `regulatory_clocks`          | A legal deadline it is running against                                | **Nothing**               |

### Evidence

| Entity                | Is                                                                   | Written by                                    |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| `consents`            | A named borrower signed a named form at a named moment               | Production                                    |
| `authorizations`      | Scoped, dated, revocable permission to retrieve                      | **A trigger only** — mirrored from `consents` |
| `connector_links`     | A live connection to one vendor for one file                         | Production                                    |
| `connector_snapshots` | Exactly what a vendor sent, word for word                            | Production                                    |
| `decisions`           | One complete run of the underwriting engine                          | Production                                    |
| `documents`           | A note that the borrower picked a file. **The bytes are never sent** | Production                                    |
| `file_events`         | The file's diary                                                     | Production                                    |
| `disclosures`         | Proof a required disclosure was delivered                            | **Nothing**                                   |

### Income

| Entity           | Is                                                 | Written by                |
| ---------------- | -------------------------------------------------- | ------------------------- |
| `income_sources` | One stream of money coming in                      | Production — bank/payroll |
| `employments`    | A job: employer, role, since when, and how we know | Production — bank/payroll |

### The loan

Every table here exists and is fully constrained. The first three have **no
writer of any kind** — see `docs/loan-lifecycle.md`. The fourth gained one on
21 September 2026: `partner:key` writes a servicer when it issues that
servicer a key, so the row exists before any loan points at it.

| Entity             | Is                                           |
| ------------------ | -------------------------------------------- |
| `loans`            | A mortgage in the world, in one of 11 states |
| `loan_parties`     | Who is on it                                 |
| `loan_transitions` | Every move it made                           |
| `servicers`        | Who collects the payments, and holds a key   |

## What the database actually enforces

This is the section to read before assuming a rule holds.

**Append-only, by trigger.** `facts`, `application_transitions` and
`loan_transitions` each have a trigger that raises on UPDATE. `facts` permits
exactly three columns to change — `superseded_by_id`, `retracted_at`,
`retraction_reason` — and freezes the rest.

**Append-only by convention only.** `connector_snapshots`, `decisions` and
`file_events` have a primary key and a cascading foreign key and nothing else.
The promise is held by there being exactly one writer each — `recordSnapshot`,
`recordDecision`, `recordEvent`, all of which only ever call `.create`. The
database would accept an UPDATE. Worth knowing before writing a second writer.

**Frozen except for named columns.** `loan_scenarios` freezes everything but
`is_active` and `superseded_by_seq`, so a change of terms is a new scenario
rather than an edit. `application_evidence_links` freezes everything but
`released_at`, and a released pin cannot be re-released.

**An AI cannot verify anything.** `facts_ai_may_not_verify` refuses an
`AI_AGENT` principal asserting `VERIFIED` or `VALIDATED_D1C`;
`facts_partner_may_not_verify` refuses a `PARTNER` principal asserting
anything above attested. A trigger rather than a CHECK, because the
principal's kind lives on another table. This is the AI-safety principle as a
constraint rather than a policy: filling a gap with a plausible value is
exactly how "we do not know" becomes "we checked and you passed".

**A gapless ledger.** Three things together, not one constraint: UNIQUE
`(application_id, seq)`, a CHECK that `seq >= 1`, and a trigger forcing a
status change to advance `status_seq` by exactly 1 — plus a **deferred**
constraint trigger that fails at COMMIT if any value `status_seq` passed
through has no ledger row. A status change and its ledger row land together or
neither does.

**Terminal is final.** Both `applications` and `loans` refuse any update out
of a terminal state, generated from the same trigger body so the two aggregates
cannot drift on what "ended" means.

**One live thing per subject.** Several partial unique indexes do real work:
one active scenario per application; one live pin per `(application, fact)`;
one live authorization per `(party, purpose)`; one Loan Estimate clock and one
adverse-action clock per application.

**An unclaimed person cannot be pulled on.** A `PROVISIONAL` or
`CLAIM_PENDING` party structurally cannot hold an authorization, and the token
minter reads nothing else. That makes an imported, unclaimed person someone no
connector adapter can retrieve for, by any route.

**`loan_files` enforces nothing at all.** Zero CHECK constraints, zero
triggers — only its foreign keys. The stage-only-moves-forward rule lives in
`advanceStage`; 404-not-403 lives in `assertFileAccess`. Both are application
code, and both would be bypassed by a new route that forgot them.

**Account deletion is three triggers on `users`,** firing in name order —
files, then loans, then the party — and the order is load-bearing, because the
transition ledger's actor FK is RESTRICT and a principal dies with its party.
The delete route restates the order rather than trusting the triggers.

## Tables with no writer

Not a backlog — a map of what is scaffolding. Each is fully modeled and fully
constrained, which is deliberate: the rules were written before the writers so
the first writer arrives into a shape that already refuses the wrong thing.

| Table                                       | Waiting on                                                           |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `loans`, `loan_parties`, `loan_transitions` | The Grander import, deliberately deferred                            |
| `regulatory_clocks`                         | Notice delivery. A clock nothing can stop must not be opened         |
| `disclosures`                               | The same. `DisclosureRecord` exists as a type with no rows behind it |
| `authorizations`, written directly          | Nothing writes it by hand; `consents` mirrors into it by trigger     |

`createProvisionalParty` is what naming a co-borrower does, and `mergePartyInto`
is what claiming an invitation does — the named party folds into the party the
person's own sign-in made, and the borrower row, the membership and the loan
parties follow. `PartyKind.ENTITY` still distinguishes nothing in a live
database.

## What is not modeled at all

**Assets, liabilities, expenses and owned property are entities now** —
`du_assets`, `du_liabilities`, `du_expenses` and the owned property nested
inside an asset — each owned by a borrowing party through an arc, with a
deferred trigger that refuses an emittable row left without an owner. The
Desktop Underwriter pages own them: `docs/du-graph.md` for the shape and
`docs/du-readiness.md` for what is written and what is not. ⚠ The underwriting
engine still reads liabilities and reserves out of snapshot JSON rather than
out of those tables; the tables are what a submission carries.

**What is not modeled at all:** a regulatory notice that was delivered, and a
role on a `User` that would let staff open a file. A servicer with a row is
modeled now — `partner:key` writes one — but nothing yet points a loan at it.

## Where the rest lives

- `docs/states.md` — the application lifecycle and what the product can say
  about a person today.
- `docs/loan-lifecycle.md` — the loan side.
- `docs/du-readiness.md` — what a Desktop Underwriter submission needs.
- `docs/decisions.md` — why state is stored rather than derived, and why the
  tests need a real database.
