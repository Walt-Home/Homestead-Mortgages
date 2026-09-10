# What DU needs, and what we have

A status page for the Desktop Underwriter work, kept against Drew's readiness
audit of 2026-09-08. It exists so nobody re-derives the same answer twice, and
so a change that closes an item can say so in the same commit that lands it.

**This document goes stale.** Every claim about our own code carries a
file:line, and lines move. Treat them as pointers to a name, not to a line.
Re-derive anything you are about to build on; the last section says how.

Last re-measured at `d7573f1`, 2026-09-10. Audit written at `e68182a`.

## The one thing that is not in this document

**Whether Grander submits to DU on our behalf, and what their intake accepts.**
Nothing in this repository can answer it, and nothing in Fannie's corpus can
either. `Servicer` is a model with a slug and a display name and no host, no
endpoint and no credential (`packages/db/prisma/schema.prisma:1266`), and
`LoanSource.PARTNER_IMPORT` points inbound.

It is not a small question. Grander is the creditor, Supermortgage
administers, and Grander's own system already submits to DU. If that holds, we
are not building a DU integration at all — we are building a handoff to their
intake, and the payload is whatever _they_ accept, which may be narrower or
wider than MISMO 3.4. It decides whether we ever write a serializer, whether
the compute boundary below is ours to draw, and what shape the declarations
have to be captured in.

Answer it before writing a serializer. It is the one wrong turn that wastes
the largest single piece of remaining work.

## Where each item stands

Green is done and verifiable. Yellow is real but partial. Red has not started.
The audit's numbering is kept so the two documents can be read side by side.

### Green

**1 · One casefile per loan.** `applications.aus_casefile_id`, NOT NULL and
UNIQUE, minted once at application birth
(`packages/db/prisma/schema.prisma:999`). The decision route reads it rather
than minting per underwrite (`apps/api/src/routes/decision.ts:44`). Two
underwrites of one file now hand DU the same case.
`decisions.aus_casefile_id` stays and is still written per decision — that is
append-only evidence of what each submission went out under, not a duplicate.
Residue: the id is one we mint, and nothing writes DU's own returned casefile
identifier back.

**2 · Income and employment survive a re-pull.** Rows carry
`first_seen_snapshot_id` / `last_seen_snapshot_id` / `retired_by_snapshot_id`
(`packages/db/prisma/schema.prisma:436`, `:483`) instead of being deleted and
recreated. DU can recognize the same income across resubmissions. The same
work fixed a live bug: the delete had no party filter, so a co-borrower's pull
would have deleted the primary borrower's income.

**Identity model (audit decision B).** The party layer won. Sixteen
identifying columns were dropped from `borrowers`, `party_id` is NOT NULL, and
the read path throws rather than falling back, because there is nothing to
fall back to (`apps/api/src/services/borrower-projection.ts:64`). Screens 1
and 2 write parties on the production path (`apps/api/src/routes/files.ts`).
The audit's "no production writers" was already stale when it was written.
Residue: permissions are still written legacy-first into `consents`, with a
database trigger mirroring them into the party-keyed `authorizations` the
token minter reads.

**Ownership shape (audit decision C).** Relational tables with join tables
carrying a role column — decided, and proven twice. `application_parties`
(`schema.prisma:1033`) and `loan_parties` (`:1438`) are real many-to-many
joins keyed on `party_id`, and the loan one is enforced at the database:
deleting one co-borrower removes their link and sweeps the loan only when the
last party leaves. The pattern is settled. It has not been applied to assets,
liabilities or property, because those entities do not exist to join to.

### Yellow

**7 · Employer as an entity.** `Employer` is real, with a party FK and an
identity key that survives the EIN promotion (`schema.prisma:365`), and both
`income_sources` and `employments` carry `employer_id`. Two income items from
one employer can be shown as such. **But only a vendor pull creates one** —
`services/income.ts` is called from `routes/connectors.ts` and nowhere else in
the product, so a job a borrower typed has no employer entity behind it.

**4 · The verification report identifier.** The vendor's own report id has
been stored in `connector_snapshots.external_id` since the first migration;
what the audit found was that nothing read it. Income and employment now do.
Assets do not. And `connector_snapshots` has no `party_id`, so on a file with
two people nothing records whose report it is —
`vendorAuthorizedForDu` is payload-only with no column
(`packages/shared/src/types/verification.ts:208`).

### Red

**3 · Borrower declarations. The only hard stop.** `DECLARATION_DETAIL` is
1:1, so a submission without it is malformed rather than thin — rejected
before anyone reads it. No table, no column, no request field, no route. Zero
of the fourteen Section 5 questions are asked. Citizenship and intent to
occupy exist and are real, and both predate the audit.

**6 · Assets, liabilities and owned property.** Nothing. Balances exist only
as vendor JSON inside `connector_snapshots.payload`, with no owner and no
obligor. The schema says so in its own comments (`schema.prisma:1128`,
`:1387`). Two shapes to get right the first time, because retrofitting either
is a rearchitecture: an asset can have **two owners**, and `OWNED_PROPERTY`
nests **inside** an asset rather than beside it.

**5 · Up to four borrowers.** `POST /api/files/:id/borrowers` updates the
first borrower or creates the only one; it cannot append
(`apps/api/src/routes/files.ts:366`). No ordinal column, so DU's Borrower
1/2/3/4 positions cannot be persisted. No co-borrower screen in `apps/web`.
`connector_links` is unique on `(loanFileId, kind)`, so a second borrower
cannot link their own bank. The requirements engine reads `borrowers[0]` in
about twenty places (`packages/requirements/src/satisfaction.ts`). CO_BORROWER
has exactly one writer, the persona seed; the other three roles have none.

What did land nearby is defensive rather than enabling: the TRID receipt
counts one primary borrower's pinned pieces, intake refuses an application
with no primary borrower, and withdrawal is restricted to the borrowing roles.
Those stop a co-borrower's data from corrupting the single-borrower path. They
do not let a second borrower do anything.

**8 · What we compute versus what DU computes.** `decisions.ratios` and
`decisions.reserves` are still bare `Json` (`schema.prisma:558`), written
through a cast and read back through another. Nothing records which figures
are ours to assert and which are DU's to derive. `FactSourceKind.DERIVED`
exists in the database and no code ever writes one.

**Delivery boundary (audit decision A).** Undecided _and_ unbuilt. No submit,
export, package or deliver route in any of the eleven mounted routers; no
MISMO, XML or SOAP dependency in any package.json; no `ApplicationState`
meaning submitted-to-AUS; no inbound path for a DU response.
`engine: "shadow" | "du" | "lpa"` is declared
(`packages/shared/src/types/decision.ts:36`) and only `"shadow"` is ever
produced.

One correction to the audit, in its favor on substance: _"nothing in this
system transmits anything to anyone"_ is literally false — Plaid, Stripe
Identity and Google Places are outbound calls. All three are retrieval _into_
the system, and the point stands exactly.

## Two problems that are not on the audit's list

Both are about declarations, and both are worth fixing whether or not DU ever
enters the picture.

**A borrower's written explanation of their own bankruptcy is discarded.**
Screen 4 asks the follow-up question when a declaration is flagged, binds the
answer to component state (`apps/web/src/pages/ReviewPage.tsx:106`), and sends
it nowhere. It dies on unmount. Silent data loss on a regulated screen, and a
one-route fix.

**The declarations that screen shows are derived, not asked.** They are read
off connector output, so an unrun credit pull leaves one reading "clean" —
which is asserting "no bankruptcy" from an absence of evidence, on a document
the borrower signs. Deriving them is not a cheaper way to satisfy DECLARATION;
it is a worse one.

## Why the reds are not equal

**Invalid** and **narrow** are different failures. Declarations are the only
confirmed cardinality-minimum-1 gap: a file missing all fourteen indicators is
malformed, and no volume of good data elsewhere rescues it.

Everything else limits _which loans_ we can submit. One borrower means
single-borrower files. No asset or liability entity means only files where the
vendor payload happens to carry everything and nothing needs per-person
attribution. No property entity means one subject property and a scalar
`financed_property_count` as the only fact about anything else they own.

Those are scope constraints. Sequence them by which loans we intend to take
first, not by Fannie's schema.

## The sequence

Dependency order, not importance. No time estimates: anyone who needs a
schedule should build one from this with the people doing the work.

1. **Get the downstream answer.** Who submits, against what schema, and
   whether they recompute our ratios. Everything below step 4 is shaped by it.
2. **Stop discarding the declaration follow-ups.** A route that receives what
   `ReviewPage` already collects.
3. **Ask the fourteen questions and store them**, per application rather than
   as facts — a declaration is as-of _this_ credit request, not a standing
   truth about a person. This is what moves the blocking gap.
4. **Give `connector_snapshots` a `party_id`.** The prerequisite for
   everything per-borrower, and cheap now, while every file has exactly one.
5. **Assets and liabilities**, on the `application_parties` join pattern
   already proven. Joint ownership from the first migration, and
   `OWNED_PROPERTY` inside an asset.
6. **The second borrower.** An appending route, an ordinal column, and a
   subject chosen deliberately at each `borrowers[0]` site.
7. **Write down the compute boundary** and type the two JSON columns.
8. **The serializer and the transport** — and only once step 1 is answered.

Steps 2 through 4 are worth doing however step 1 comes back.

## How to re-check this

Every claim about our code is a file:line at the commit named at the top, and
every claim about DU is a named tab or test case in the specification corpus.
Open five at random and confirm they say what this says they say. That is the
only real check on a document like this.

The corpus Drew read directly: DU Specification v1.9.3 (the DU Map,
Enumerations, Cardinality and ArcRoles tabs), the Fannie schema chain, the
MISMO v3.4 reference model, and the eighteen-case test suite of June 2026 —
including a three-borrower cash-out refinance, a four-unit investor property
and construction-to-permanent. `DI-C09` is the one to read first: it links one
asset to two borrowers, one liability to two obligors, an asset to the
liability secured by it, and income items to employers as first-class
entities. A DU submission is a **graph** of `RELATIONSHIP` arcs, not a nested
document, and that is the fact the data model has to satisfy.
