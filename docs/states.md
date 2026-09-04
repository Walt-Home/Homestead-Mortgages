# User states and account states

Two questions this product has to answer about every person who touches it:
**what are they trying to do**, and **where does it stand**. This document is
the model for both.

It describes two things at once, and says which is which throughout. What is
**built** is the prototype's flow stage and decision outcome. What is
**designed** is the model those are being replaced by, decided in a pair of
design passes on 3 September 2026. Nothing in the "designed" half exists in the
schema yet. Marking the boundary is the point — a document that described the
target as though it were running would be the same class of untruth this
codebase spends `docs/decisions.md` refusing to tell.

---

## Today

Five fields carry something state-like, and they answer to different masters.

| Field                                    | Where                          | Values                                                                        | Owns                           |
| ---------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------ |
| `loan_files.stage`                       | Postgres enum `FlowStage`      | 10, ordered                                                                   | Which screen to resume to      |
| `decisions.outcome`                      | `String`, append-only table    | `pending` `approved_with_conditions` `clear_to_close` `counteroffer` `denied` | What the engine last concluded |
| `loan_conditions.status`                 | `String`, default `open`       | `open` `submitted` `cleared` `waived`                                         | One outstanding work item      |
| `connector_links.status`                 | `String`, default `active`     | `active` `needs_reauth` `revoked` `error`                                     | One vendor connection          |
| `borrowers.identity_verification_status` | `String`, nullable, no default | `pending` `verified` `failed`                                                 | One hosted ID-vendor session   |

`stage` is a **high-water mark, not a cursor** — where you are is the URL, how
far you got is the stage, and `advanceStage` refuses to move it backward. Ten
stages sit behind four borrower screens; `apps/web/src/lib/flow.ts` holds the
whole translation — `SCREENS`, `STAGE_TO_SCREEN`, `branchesFor` — and is the
only place that maps between them. `FilesPage.tsx` is the one other file that
names a stage and a screen path directly.

### What none of them can say

- **Cancelled, withdrawn, expired, on hold.** `stage` only moves forward, so
  these are not merely absent — they are unrepresentable on that field.
- **The ball is in your court.** The stage says which screen you reached, not
  whether anything is waiting on you.
- **A person has this file.** There is no role on `User`, so an underwriter
  cannot open a file at all. `assertFileAccess` knows two subjects, owner and
  not-owner, plus one file-level exception: a demo file is readable by everyone
  and writable by nobody, and is the only case that answers 403 rather than 404.
  None of the three is a role.
- **Adverse action is owed and a clock is running.** `adverseActionReasons` is
  a `String[]` column on `decisions` — queryable, unlike its `Json` siblings —
  and the requirement that reads it (UW-016) is satisfied by the array being
  non-empty rather than by a notice existing. A `DisclosureRecord` kind
  `adverse_action` exists and nothing in the engine ever checks it.
- **We could not compute this.** `determineOutcome` falls through to
  `approved_with_conditions`, so a `refer` (an input we could not compute) and a
  `refer_with_caution` (findings we did compute) are indistinguishable at the
  outcome field. A clean pass is distinguishable in principle — `approve_eligible`
  carries no findings, so it has no open conditions and lands on
  `clear_to_close` — but the four screens never produce one, because the web
  posts an empty body to `POST /files/:id/decision` and all four compliance
  tests block without an APR, an APOR and a fee schedule.
- **Anything after funding.** There is no object for a mortgage that exists in
  the world. There is also no way to hold one for a Grander portfolio member: a
  file can only name an owner through `users.id`, and a `users` row exists only
  after a Google sign-in. (`loan_files.user_id` is nullable, but a null owner
  means a demo file, not a file held for somebody.)

The event stream (`file_events`) is append-only and already carries fifteen
kinds — `screen_completed`, `consent_granted`, `connector_pull`,
`decision_computed`, `application_signed` among them. `kind` is a free-text
column rather than an enum, so the set grows without a schema change. It is the
substrate the model below builds on.

---

## Where it is going

### Three objects, not one

`LoanFile` conflates a process, a set of terms, a property, and a decision.
It splits.

| Object          | Is                                  | Lifetime                                    |
| --------------- | ----------------------------------- | ------------------------------------------- |
| **Party**       | A durable person or entity          | Before, between and after every application |
| **Application** | A transient credit request          | Starts, ends, and is never reopened         |
| **Loan**        | A mortgage that exists in the world | Outlives the application that made it       |

A Party carries no name, date of birth or SSN column — those are **facts**, in
an append-only ledger with provenance, a confidence tier and two expiry clocks.
An Application holds no borrower fields, no property columns and no income; it
**borrows** them by pinning facts, and the pin records which authorization it
was borrowed under. That pin is the legal act: TRID's six pieces must be
received _in connection with a request for credit_, and the pin is what makes
that provable rather than asserted.

`loans.originating_application_id` is **nullable, and that nullability is
load-bearing** — a Grander portfolio mortgage has no application behind it. The
Loan hangs off Party rather than Application, so deleting a stale application
cannot erase the record of a mortgage somebody is paying.

### The axes that are not there

`LoanPurpose` is a three-member union — `purchase`, `rate_term_refinance`,
`cash_out_refinance` — and every member is an objective. The problem is not that
one field conflates the axes; it is that the other axes are **scattered or
missing**. Program lives on `ProductSelection.productCode`, occupancy on
`SubjectProperty.occupancy`, and lien position is not modeled at all — only the
junior balances on `LoanTerms`. That distinction matters, because "split the
field" and "add the missing axes" are different pieces of work, and this is the
second.

What `LoanPurpose` does do is define refinance **by negation**
(`purpose !== "purchase"`, in `conditions.ts:55` and again in `compliance.ts`,
`routes/connectors.ts` and `PropertyLoanPage.tsx`). That is why adding a HELOC
to the union would silently make it a refinance and silently give it the
purchase LTV cap for its occupancy — 97% on a primary residence, 90% on a second
home, 85% on an investment — with no build failure. The axes:

| Axis                  | Values                                                                  | May not                                                                   |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Objective**         | purchase, rate/term refi, cash-out refi, HELOC draw, closed-end second  | Be defined by negation, or select an LTV ceiling by itself                |
| **Program**           | conventional, high balance, jumbo, FHA, VA, USDA, non-QM, agricultural  | Be inferred from objective or from channel                                |
| **Lien position**     | first, second, subordinate HELOC                                        | Be assumed — HPML and HOEPA both have subordinate-lien spreads            |
| **Occupancy**         | primary, second home, investment                                        | Be defaulted; stated intent is kept apart from established fact           |
| **Party composition** | 1..n parties with roles, including co-borrower and non-borrowing spouse | Collapse to a singleton — permissible purpose is per party, not per file  |
| **Acquisition**       | direct, Grander, LendingTree, paid search, referral, organic return     | **Reach anything** — see the firewall below                               |
| **Confidence tier**   | attested < unverified < inferred < estimated < corroborated < verified  | Be upgraded by a projection, a claim flow, or an AI reviewer              |
| **Evidence posture**  | satisfied_live, satisfied_stale, never_satisfied, blocked, contested    | Shorten an obligation set — abridgement removes screens, not requirements |

**Acquisition channel is the one to be careful with.** A requirements set that
differs by where somebody clicked is a fair-lending defect, so channel is
enforced out of reach twice: the underwriting projection's return type has no
channel field, and the projection's database role has no `SELECT` grant on the
attribution table. The type catches it in the editor; the grant catches the
second Prisma client somebody opens in six months.

The **confidence tier** is the cheapest good idea in the model. One ordered
enum, plus a `CHECK` barring an `ai_agent` principal from writing the top two
tiers, turns the central AI-safety principle into a constraint rather than a
policy: an AI filling a gap with a plausible value is exactly how "we do not
know" becomes "we checked and you passed".

---

## Application lifecycle

Nineteen states. Stored in an ordinary indexed column, moved only by a
`transition()` function that writes an append-only ledger row in the same
transaction. Several exist for regulatory reporting rather than for a person —
a borrower sees six words.

**Before it is an application**

| State             | Means                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| `draft`           | Started; fewer than six TRID pieces pinned. Not an application under Reg B or TRID |
| `intake_received` | All six pinned; the Loan Estimate clock is running                                 |

**Working**

| State               | Means                                                     |
| ------------------- | --------------------------------------------------------- |
| `in_processing`     | Evidence being gathered; nothing is on the borrower       |
| `awaiting_borrower` | At least one open obligation names a borrower             |
| `suspended`         | Blocked on an appraisal, a payoff, a sanctions near-match |
| `in_underwriting`   | A decision is being made, by engine, underwriter or AI    |

**Decided**

| State                      | Means                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `counteroffer_outstanding` | Creditworthy, wrong loan. **Not a denial and not routed as one** |
| `conditionally_approved`   | Risk accepted, eligible, conditions open with named owners       |
| `approved`                 | Every underwriting-phase obligation satisfied by a live artifact |
| `clear_to_close`           | Everything, every phase, with a delivery record per disclosure   |

**Closing**

| State                 | Means                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `closing`             | CD delivered with its own receipt clock; documents out for signature |
| `rescission_pending`  | TILA three-day right to rescind. Funding barred until it expires     |
| `funded` _(terminal)_ | Disbursed. A Loan now exists and questions move to it                |

**Not approved**

| State                     | Means                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| `adverse_action_pending`  | Declined, notice not yet delivered. **A 30-day clock is running**       |
| `denied` _(terminal)_     | Told, with specific principal reasons traced to derivations             |
| `incomplete_closed` _(t)_ | Reg B 1002.9(c). Separately reportable — never a denial or a withdrawal |
| `withdrawn` _(terminal)_  | The borrower stopped it. Guarded on actor kind so staff cannot write it |
| `canceled` _(terminal)_   | We stopped it, for a reason that is not a credit decision               |
| `expired` _(terminal)_    | A draft that never became an application. No notice owed                |

Three distinctions in that last group are the ones under constant pressure to
collapse, and they must not. `withdrawn` is the borrower's act; `canceled` is
ours; `incomplete_closed` is a lapsed response window after a notice, and it is
reportable differently from both. `expired` is a draft that never became an
application at all, which is why nothing is owed for it.

`adverse_action_pending` is the compliance dashboard. It is a row you can
query, age and alert on, and there is **no path from it to any approval word**.

The `approved` guard is a hard SQL predicate over stored rows rather than a
recomputation, so an examiner can run it themselves. Two things it must do, both
of which the first draft of this model got wrong: test applicability as its own
clause rather than folding `undetermined` into a status check, and carry **no
severity filter** — severity is a triage sort key, not an approval gate. A file
with one blocked obligation of any severity cannot reach `approved`.

---

## Loan lifecycle

Eleven states on a separate object. Integration depth — deep link, then API,
then Supermortgage as the subservicer — is a **connection detail, not a
lifecycle fact**, so becoming the servicer is a configuration change rather than
a migration.

| State                   | Means                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `pending_boarding`      | Funded and ours, not yet at a servicer                             |
| `boarding`              | Transfer file sent, not acknowledged                               |
| `imported_unclaimed`    | A Grander mortgage attached to a party who has never authenticated |
| `active`                | Serviced in our system of record                                   |
| `monitoring_only`       | We watch it and can offer better; we neither own nor service it    |
| `in_servicing_transfer` | Moving to us or away                                               |
| `paid_off` _(terminal)_ | Satisfied by any means other than our own refinance                |
| `refinanced_internally` | _(terminal)_ Paid off by a loan we originated                      |
| `transferred_out`       | _(terminal)_ Servicing sold; we may keep the relationship          |
| `charged_off`           | _(terminal)_ Terminal loss; starts the party's seasoning clocks    |
| `matured`               | _(terminal)_ Term completed                                        |

`imported_unclaimed` is the Grander path's actual object. Nothing person-keyed
may be retrieved for one — but a rate comparison against a published rate sheet
is lawful, because our own servicing data joined to a rate sheet is not a
consumer report.

`refinanced_internally` is kept distinct from `paid_off` because it is the
monitoring loop's success metric: prior loan → opportunity → application → new
loan is the one attributable chain the product exists to produce.

Delinquency is an **attribute of the newest servicing observation**, not a
state.

---

## Stored or derived

State is **stored**, and that is a reversal of the first design pass, which
derived it. Three reasons that stand on their own merits:

1. A transition is itself a regulated act. The ECOA clock runs from the
   decision, the Reg B incomplete window from the notice, rescission from
   consummation. A state with no recorded timestamp, actor and cause cannot
   lawfully start a clock, and a derived state has no actor.
2. A derived status is a function of today's code, so "why was this file in
   review on 3 March 2027" changes with every deploy — which is exactly the
   property an examiner is testing.
3. You cannot build operations on a function. `SELECT count(*) FROM
   applications WHERE status = 'in_underwriting' AND status_entered_at < now()
   - interval '5 days'` is a query, not a projection rebuild.

What stays **derived**: the borrower's next action, whether anything is owed by
them, and evidence posture. The engine already recomputes those correctly on
every read, and storing them creates drift with no reconciler.

Concurrency is a unique index on `(aggregate_id, seq)`, so a concurrent
transition is an insert conflict rather than a lost update, plus a
`WHERE status = $expectedFrom` guard on the update so an illegal source state is
caught too. That is not theoretical: the same class of bug was live in
`advanceStage` until a real-database test found it — see `docs/decisions.md`,
"Tests run against a real Postgres".

---

## The four user paths

| Path                  | What it needs                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purchase**          | The baseline. Unchanged end to end                                                                                                                                                    |
| **Refinance**         | Leads with a rate comparison **before** anything is retrieved, on a borrower-stated rate captured as a fact at `attested` and labeled as such. A dated payoff quote replaces it later |
| **Grander portfolio** | A Party and a Loan with no Application. Claimed by a signed single-use token delivered by Grander — **never** an email match at sign-in                                               |
| **Referral / paid**   | Identical flow to direct. Only the attribution payload differs, and it reaches nothing else                                                                                           |

"Sign in and we will find your file" would answer "does Grander share mortgage
data on the person who controls this address" to anyone who can create an
account with it. That is strictly more sensitive than the file-existence oracle
the 404-not-403 rule already exists to suppress.

A returning user gets an abridged flow. Abridgement removes **screens**, never
**requirements** — a returning user with a stale credit report has the same
obligation, satisfied by a re-pull rather than by a form. And a live fact is not
sufficient on its own: last year's written instruction does not authorize this
year's pull.

---

## Built, or not

| Piece                                        | Status                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `FlowStage`, four screens, decision outcomes | Built — and being replaced                                         |
| Tests against a real Postgres                | Built                                                              |
| Party, facts, principals                     | **Built** — schema and constraints; not yet wired to a route       |
| Authorizations and the purpose token         | **Built** — schema, constraints and minting; guard not yet swapped |
| Evidence artifacts, retrieval requests       | Designed                                                           |
| Applications and the transition ledger       | **Built** — 19 states, the machine, and the ledger; no routes yet  |
| Scenarios and pinned evidence                | Designed                                                           |
| Rewritten decision engine (three-axis)       | Designed                                                           |
| Loans and servicing                          | Designed                                                           |
| Roles and staff tooling                      | Designed                                                           |
| Monitoring, notifications                    | Designed, deferred                                                 |
| Notice generation and delivery               | **Not designed in detail. Resend is chosen and not integrated**    |

That last row governs more than it looks like it does. Several regulatory clocks
can only be _stopped_ by a delivered notice, so until Resend is wired in, a clock
whose satisfying channel is unconfigured **must not be opened** — either the
application is not taken, or the clock opens tolled with the reason recorded.
Opening them on schedule with no way to satisfy them would write a permanent,
tamper-evident record of a breach we never had the means to avoid.

---

## Where the reasoning lives

- `docs/decisions.md` — vendor choices, privacy posture, what is known wrong and
  shipped anyway, and why the tests need a real database.
- `docs/requirements.md` — the requirement registry and the three questions it
  keeps apart.
- `CLAUDE.md` — the rules that are not style preferences.

The full design pass behind this document, including the rejected alternatives
and the adversarial review that corrected four of its states, is recorded
outside the repo. The conclusions are here; if a claim in this file and the code
disagree, the code wins and this file is stale.
