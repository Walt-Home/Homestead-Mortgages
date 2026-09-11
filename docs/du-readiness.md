# What DU needs, and what we have

Where the Desktop Underwriter work stands, against the readiness audit of
2026-09-08. It exists so nobody re-derives the same answer twice.

Re-measured at `d7573f1`. **Update it in the commit that changes what it
says** — a status page that lags the code is worse than none, because it gets
believed. Line numbers move; treat them as pointers to a name.

## At a glance

| #   | Item                                | Status | One line                                                    |
| --- | ----------------------------------- | ------ | ----------------------------------------------------------- |
| 1   | One casefile per loan               | Green  | Minted at application birth, stable across resubmissions    |
| 2   | Income survives a re-pull           | Green  | Snapshot lineage instead of delete-and-recreate             |
| —   | Identity model                      | Green  | The party layer won; `borrowers` is a record about a person |
| —   | Ownership shape                     | Green  | Relational + join tables, proven twice, unapplied to assets |
| 7   | Employer as an entity               | Yellow | Real entity — but only a vendor pull ever creates one       |
| 4   | Verification report identifier      | Yellow | Stored all along; income reads it, assets do not            |
| 3   | Borrower declarations               | Red    | **The only hard stop.** Zero of fourteen asked              |
| 6   | Assets, liabilities, owned property | Red    | No tables. Balances are vendor JSON with no owner           |
| 5   | Up to four borrowers                | Red    | The route cannot append a second                            |
| 8   | What we compute vs what DU does     | Red    | Two untyped JSON columns and no recorded boundary           |
| —   | Delivery boundary                   | Red    | Undecided _and_ unbuilt                                     |

**Invalid and narrow are different failures.** Declarations are the only
confirmed cardinality-minimum-1 gap: a file missing all fourteen indicators is
malformed, and no amount of good data elsewhere rescues it. Everything else in
red limits _which loans_ we can submit — single-borrower files only, only
where the vendor payload carries everything, one subject property. Sequence
those by which loans we intend to take first, not by Fannie's schema.

## The question this repository cannot answer

**Does Grander submit to DU on our behalf, and what does their intake accept?**

Grander is the creditor, Supermortgage administers, and Grander's own system
already submits. If that holds, we are not building a DU integration — we are
building a handoff, and the payload is whatever _they_ accept, which may be
narrower or wider than MISMO 3.4. It decides whether we ever write a
serializer, whether the compute boundary below is ours to draw, and what shape
declarations must be captured in.

Nothing here encodes the relationship: `Servicer` has a slug, a display name,
and no host, endpoint or credential (`schema.prisma:1266`).
`LoanSource.PARTNER_IMPORT` points inbound.

Answer it before writing a serializer. It is the one wrong turn that wastes
the largest remaining piece of work.

## Green

**One casefile per loan.** `applications.aus_casefile_id`, NOT NULL and
UNIQUE, minted once at application birth (`schema.prisma:999`); the decision
route reads it rather than minting per underwrite
(`apps/api/src/routes/decision.ts:44`). `decisions.aus_casefile_id` is still
written per decision — append-only evidence of what each submission went out
under, not a duplicate. Nothing writes DU's own returned identifier back.

**Income and employment survive a re-pull.** Rows carry
`first_seen_snapshot_id` / `last_seen_snapshot_id` / `retired_by_snapshot_id`
(`schema.prisma:436`, `:483`). The same work fixed a live bug: the delete had
no party filter, so a co-borrower's pull would have deleted the primary
borrower's income.

**Identity lives on Party.** Sixteen identifying columns dropped from
`borrowers`, `party_id` NOT NULL, and the read path throws rather than falling
back because there is nothing to fall back to
(`apps/api/src/services/borrower-projection.ts:64`). Permissions are still
written legacy-first into `consents`, mirrored by a database trigger into the
party-keyed `authorizations` the token minter reads.

**Ownership is relational, with join tables.** `application_parties`
(`schema.prisma:1033`) and `loan_parties` (`:1438`) are real many-to-many
joins on `party_id` with role columns, and the loan one is enforced at the
database: deleting one co-borrower removes their link and sweeps the loan only
when the last party leaves. The pattern is settled — it simply has nothing to
join assets to yet.

## Yellow

**Employer as an entity.** `Employer` is real, with a party FK and an identity
key that survives the EIN promotion (`schema.prisma:365`); `income_sources`
and `employments` both carry `employer_id`, so two income items from one
employer can be shown as such. But `services/income.ts` is called only from
`routes/connectors.ts`, so a job a borrower typed has no employer behind it.

**The verification report identifier.** The vendor's report id has lived in
`connector_snapshots.external_id` since the first migration; what was missing
was a reader. Income and employment now read it; assets do not. Snapshots have
no `party_id`, so on a two-person file nothing records whose report it is, and
`vendorAuthorizedForDu` is payload-only with no column
(`packages/shared/src/types/verification.ts:208`).

## Red

**Borrower declarations.** `DECLARATION_DETAIL` is 1:1. No table, no column,
no request field, no route; zero of the fourteen Section 5 questions asked.
Citizenship and intent to occupy exist and both predate the audit.

**Assets, liabilities, owned property.** Nothing. Balances exist only as
vendor JSON in `connector_snapshots.payload`, with no owner and no obligor —
the schema says so in its own comments (`schema.prisma:1128`, `:1387`). Two
shapes to get right the first time, because retrofitting either is a
rearchitecture: an asset can have **two owners**, and `OWNED_PROPERTY` nests
**inside** an asset rather than beside it.

**Up to four borrowers.** `POST /api/files/:id/borrowers` updates the first
borrower or creates the only one; it cannot append
(`apps/api/src/routes/files.ts:366`). No ordinal column, so DU's Borrower
1/2/3/4 positions cannot be persisted. No co-borrower screen.
`connector_links` is unique on `(loanFileId, kind)`, so a second borrower
cannot link their own bank. The requirements engine reads `borrowers[0]` in
about twenty places. CO_BORROWER has one writer, the persona seed; the other
three roles have none.

What landed nearby is defensive rather than enabling — the TRID receipt counts
one primary borrower's pinned pieces, intake refuses an application with no
primary borrower, withdrawal is restricted to the borrowing roles. Those stop
a co-borrower's data from corrupting the single-borrower path. They do not let
a second borrower do anything.

**What we compute versus what DU computes.** `decisions.ratios` and
`decisions.reserves` are bare `Json` (`schema.prisma:558`), written through a
cast and read back through another. Nothing records which figures are ours to
assert and which are DU's to derive. `FactSourceKind.DERIVED` exists and no
code writes one.

**Delivery boundary.** No submit, export, package or deliver route in any of
the eleven mounted routers; no MISMO, XML or SOAP dependency in any
package.json; no `ApplicationState` meaning submitted-to-AUS; no inbound path
for a DU response. `engine: "shadow" | "du" | "lpa"` is declared
(`packages/shared/src/types/decision.ts:36`) and only `"shadow"` is produced.

One correction to the audit, in its favor on substance: _"nothing in this
system transmits anything to anyone"_ is literally false — Plaid, Stripe
Identity and Google Places are outbound. All three are retrieval _into_ the
system, and the point stands.

## Two problems the audit did not reach

Both are about declarations, and both are worth fixing whether or not DU is
ever reached.

**A borrower's written explanation of their own bankruptcy is discarded.**
Screen 4 asks the follow-up when a declaration is flagged, binds the answer to
component state (`apps/web/src/pages/ReviewPage.tsx:106`), and sends it
nowhere. It dies on unmount.

**Those declarations are derived, not asked.** They are read off connector
output, so an unrun credit pull leaves one reading "clean" — asserting "no
bankruptcy" from an absence of evidence, on a document the borrower signs.
Deriving them is not a cheaper way to satisfy DECLARATION; it is a worse one.

## The sequence

Dependency order, not importance. No time estimates — build a schedule from
this with the people doing the work.

1. **Get the downstream answer.** Everything past step 4 is shaped by it.
2. **Stop discarding the declaration follow-ups.** A route that receives what
   `ReviewPage` already collects.
3. **Ask the fourteen questions and store them**, per application rather than
   as facts — a declaration is as-of _this_ credit request, not a standing
   truth about a person. This is what moves the blocking gap.
4. **Give `connector_snapshots` a `party_id`.** Cheap now, while every file
   has exactly one person; the prerequisite for everything per-borrower.
5. **Assets and liabilities**, on the `application_parties` join pattern,
   joint ownership from the first migration.
6. **The second borrower.** An appending route, an ordinal column, and a
   deliberate choice at each `borrowers[0]` site.
7. **Write down the compute boundary** and type the two JSON columns.
8. **The serializer and the transport** — only once step 1 is answered.

Steps 2 through 4 are worth doing however step 1 comes back.

## How to check this

Every claim about our code is a file:line at the commit named above; every
claim about DU is a named tab or test case in the specification corpus. Open
five at random and confirm they say what this says they say.

The corpus: DU Specification v1.9.3 (DU Map, Enumerations, Cardinality,
ArcRoles), the Fannie schema chain, the MISMO v3.4 reference model, and the
eighteen-case test suite of June 2026. **`DI-C09` is the one to read first** —
it links one asset to two borrowers, one liability to two obligors, an asset
to the liability secured by it, and income items to employers as first-class
entities. A DU submission is a **graph of `RELATIONSHIP` arcs**, not a nested
document, and that is the fact the data model has to satisfy.
