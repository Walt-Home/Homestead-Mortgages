# What DU needs, and what we have

Where the Desktop Underwriter work stands, against the readiness audit of
2026-09-08. It exists so nobody re-derives the same answer twice.

Re-measured at `07e594f`. **Update it in the commit that changes what it
says** — a status page that lags the code is worse than none, because it gets
believed. Line numbers move; treat them as pointers to a name.

## Where this stands

**The model a submission is assembled from is built. Assembling and sending
one has not been started.**

Thirteen items are tracked below: eight done, two partial, three not. That is
about two thirds by count, and the count still flatters us — the three that
remain include the whole submission path, the serializer and the preflight and
the transport and the handling of what DU answers, which is the largest single
body of work left.

What changed since the last measurement is that **all three of the gaps that
blocked any submission are closed**. Declarations are asked and stored,
residences with them; the fabricated housing basis is gone; and assets,
liabilities, expenses and owned property exist as tables with real ownership,
enforced by the database rather than intended by a service.

Still true, and the sentence to keep at the front: **nothing in this system
transmits anything to anyone.**

Treat the fraction as a direction, not a measurement, and re-derive it from the
three lists rather than trusting it after they change.

### Completed

- **Declarations and residences are asked and stored.** A fifth borrower screen
  collects the fourteen Section 5 questions, their follow-ups, the bankruptcy
  chapters and the residence history; `du_declarations`,
  `du_bankruptcy_filings` and `du_residences` hold them, with the conditional
  chains as CHECKs rather than intentions.
- **The fabricated housing basis is gone.** `borrowers.current_housing` was
  `String @default("rent")` NOT NULL on a screen that never asked. The column,
  the route and the client stopped manufacturing it together, and the engine
  answers "cannot know yet" rather than calling an unasked borrower a renter.
- **Assets, liabilities, expenses and owned property exist**, with
  `OWNED_PROPERTY` nested inside an asset, a liability carrying a nullable FK
  to the asset securing it, per-kind CHECKs that constrain the type rather than
  only the nulls, and a derived lien total no caller writes.
- **Ownership is many-to-many and unforgeable.** Join tables with roles; an arc
  may only name a borrowing party on that application; nothing emittable can
  exist without an owner, enforced by deferred triggers that survive a revive,
  a role flip and an account deletion.
- **An account keeps its row across a re-pull.** Three identity tiers with no
  ordinal — a vendor id, a content key, or a refusal to match — each prefixed
  by the durable party, so two borrowers pulling one joint account cannot
  collide and a closed account cannot hand its balance to a neighbour.
- **The generators, and the checks they make possible.** Child order read from
  the schema rather than sorted, enumerations from DU's own tab rather than the
  wider XSD, and `du:verify` failing the build on a `Du*` enum member with no
  row behind it — the check that would have caught a fabricated value sitting
  in a block labelled "generated".
- **One casefile per loan, in both shapes.** Ours, stable across
  resubmissions; and `du_casefile_id`, DU's own, write-once by trigger. Nothing
  populates the second yet, because nothing has asked DU for one.
- **Identity lives on Party**, with facts carrying provenance and a confidence
  tier, and an AI or partner principal barred by trigger from asserting a
  verified one.

### In progress

- **Employer is a real entity** — but only a vendor pull creates one, so a job
  a borrower typed still has nothing behind it.
- **The verification report identifier** is stored, and snapshots now say whose
  report they are. Assets still read neither.

### Missing

- **More than one borrower.** The ordinal exists and the database holds the
  rules; what is missing is above it — no route appends a second borrower, no
  screen renders one, and thirty-two `borrowers[0]` sites in TypeScript source
  still assume there is only ever one. DU allows four.
- **The compute boundary** — which figures we assert and which DU derives —
  still unrecorded, still two untyped JSON columns.
- **The submission itself**: the serializer that emits MISMO 3.4 with its
  `RELATIONSHIP` arcs, the preflight that refuses to send a file DU would
  reject, the transport, and the inbound path for a findings report, a
  recommendation and DU's casefile id.

And one that is not code: **institution credentials and the agency agreement**,
which have a longer lead time than anything above.

## At a glance

| #   | Item                                | Status | One line                                                    |
| --- | ----------------------------------- | ------ | ----------------------------------------------------------- |
| 3   | Borrower declarations               | Green  | Asked on their own screen, stored, chains enforced          |
| —   | Current residence                   | Green  | The fabricated `"rent"` is gone; the question is asked      |
| 6   | Assets, liabilities, owned property | Green  | Tables, ownership arcs, identity across a re-pull           |
| —   | The generators and `du:verify`      | Green  | Order from the schema, enums from DU's tab, drift fails CI  |
| 1   | One casefile per loan               | Green  | Ours stable; DU's write-once and waiting for a response     |
| 2   | Income survives a re-pull           | Green  | Snapshot lineage instead of delete-and-recreate             |
| —   | Identity model                      | Green  | The party layer won; `borrowers` is a record about a person |
| —   | Ownership shape                     | Green  | Relational + join tables, now applied to assets             |
| 7   | Employer as an entity               | Yellow | Real entity, derivable arc; two current employers get none  |
| 4   | Verification report identifier      | Yellow | Stored and attributed; assets still do not read it          |
| 5   | Up to four borrowers                | Yellow | Ordinal and its rules landed; no route, no screen, 35 sites |
| 8   | What we compute vs what DU does     | Red    | Two untyped JSON columns and no recorded boundary           |
| —   | The submission                      | Red    | Serializer, preflight, transport, response. Nothing yet     |

**The three that blocked any submission are closed.** Declarations, the current
residence, and assets with liabilities and owned property were each a hard stop
— a file missing any of them is malformed rather than thin — and each is now
built and enforced at the database.

What remains splits cleanly. The borrower count and the compute boundary limit
_which_ loans we could submit and how confidently. The submission path is what
makes submitting possible at all, and it has not been started.

## Decided: we submit

**We assemble and submit to DU ourselves.** Not a handoff to Grander's intake.
Decided 2026-09-11.

That decision is what makes the schema chain ours to satisfy, the compute
boundary ours to draw, and the casefile a thing that has to round-trip. It is
also why the specification corpus is a dependency rather than reference
material — though the corpus itself is **not in this repository**, and that is
deliberate: `scripts/build-du.mjs` reads it from `DU_SPEC_DIR` and commits only
the TypeScript it derives.

### What is still open, and it is not technical

Grander is the creditor and Supermortgage administers as their agent. A DU
submission goes in under a seller/servicer number, so:

- **Whose institution credentials do we submit under, and what does the agency
  agreement permit?** Presumably Grander's, since they are the creditor — but
  that is a contract question, not one the code can decide.
- **May MISMO's reference model and Fannie's schema chain be vendored into
  this repository?** The EULA has a named answer in its header and somebody
  with authority to accept it has to read it. Until then the build reads them
  from a path, which works and is the design's own fallback.
- A smaller one of the same kind: the conditionality table is keyed by **85
  condition statements verbatim**. They are short functional predicates, they
  are what makes a parse failure legible, and they are Fannie's words. Swapping
  the keys for indices is a small change if the answer is that no spec text
  belongs here.

None of these blocks the data model. All of them block an actual submission.

## What the audit found, item by item

**Item 1 — one casefile per loan.** `applications.aus_casefile_id` is NOT NULL
and UNIQUE, minted once at application birth; the decision route reads it
rather than minting per underwrite. `applications.du_casefile_id` is DU's own,
`VARCHAR(30)`, unique where not null, write-once by trigger — a rewrite of the
same value is a no-op and a different value raises, so a correction cannot lock
the application out of ever receiving one. Nothing populates it yet because
nothing has asked DU for a casefile.

**Item 2 — income and employment survive a re-pull.** Rows carry
`first_seen_snapshot_id` / `last_seen_snapshot_id` / `retired_by_snapshot_id`.
The same work fixed a live bug: the delete had no party filter, so a
co-borrower's pull would have deleted the primary borrower's income.

**Item 3 — borrower declarations.** Built. Three tables, the conditional chains
as CHECKs, an AI principal refused outright, a borrower refused from answering
for somebody else, and a declared bankruptcy that names no chapter refused at
COMMIT — including the deletion of its last chapter in a later transaction. A
borrower answers them on their own screen, and the review screen shows those
answers back rather than ones we inferred.

**Item 4 — the verification report identifier.** The vendor's report id has
always been in `connector_snapshots.external_id`; what was missing was a
reader, and income and employment now have one. `connector_snapshots.party_id`
landed too, so a report on a two-person file says whose it is — required for
person-keyed kinds, forbidden for address-keyed ones, and an unrecognized kind
raises. Assets read neither yet.

**Item 5 — up to four borrowers.** Half done, and the half that landed is the
one the database owns. `application_parties.borrower_ordinal` exists, is
constrained to one through four, admits exactly one Borrower 1, is required of
a borrowing role and forbidden of a non-borrowing one, and existing rows were
backfilled; `ensureApplicationParty` locks the application and allocates the
smallest free position, so two concurrent appends cannot take the same one.

What is missing is everything above it. `POST /api/files/:id/borrowers` still
updates the first borrower or creates the only one — it cannot append. No
co-borrower screen. `connector_links` is unique on `(loanFileId, kind)`, so a
second borrower cannot link their own bank. And thirty-two `borrowers[0]`
sites in TypeScript source still assume there is only ever one, of which the
engine and the authorization boundary hold eleven and the screens seven.
Thirty-three counting the one comment in `schema.prisma`, sixty-six counting
tests and migrations — the figure moves a lot with the filter, so it is stated
here with its filter attached. The `twenty-four` this page carried until now
was not reachable under any of them, and was already wrong when it was
written rather than having gone stale.

**Item 6 — assets, liabilities and owned property.** Built, jointly owned from
the first migration. `OWNED_PROPERTY` nests inside an asset through a composite
FK against a generated `asset_kind` column; a liability carries a nullable FK
to the asset securing it, because across all eighteen shipped samples no
liability is ever the target of more than one asset while one asset with two
liabilities is ordinary. The per-kind CHECKs constrain the type rather than
only the nulls — without that a row could carry a discriminator that lies, and
no check catches those. `lien_upb_cents` is derived by triggers on both sides,
so a second lien moves the total with nobody updating it.

**Item 7 — employer as an entity.** Real, with a party FK and an identity key
that survives the EIN promotion; `income_sources` and `employments` both carry
`employer_id`. `income_sources.employment_income` now makes
`CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` derivable rather than stored
twice — it is true exactly when the row names an employer, held by a CHECK,
which is why that edge is `ON DELETE RESTRICT` and why removing an employer
means repointing its income first. Two gaps stay open. `services/income.ts` is
called only from the connector routes, so a job a borrower typed has no
employer behind it. And no port links an income item to one of the employments
beside it, so a borrower with TWO current employers gets wage income attached
to neither, which the discriminator now turns into a wire-visible
`EmploymentIncomeIndicator` of false — `DI-C04` is exactly that shape.

**Item 8 — what we compute versus what DU computes.** Not started.
`decisions.ratios` and `decisions.reserves` are bare `Json`, written through a
cast and read back through another, and nothing records which figures are ours
to assert and which are DU's to derive. `FactSourceKind.DERIVED` exists and no
code writes one.

**The delivery boundary.** No submit, export, package or deliver route in any
mounted router; no MISMO, XML or SOAP dependency in any package.json; no
`ApplicationState` meaning submitted-to-AUS; no inbound path for a DU response.
`engine: "shadow" | "du" | "lpa"` is declared and only `"shadow"` is produced.

## Two problems the audit did not reach, both now fixed

Recorded because they were real, and because the second one is the more
instructive.

**A borrower's written explanation of their own bankruptcy was discarded.** The
review screen asked the follow-up when a declaration was flagged, bound the
answer to component state, and sent it nowhere. The explanations are persisted
now.

**Those declarations were derived, not asked.** `buildDeclarations` read the
credit report, the lien search, the asset report and the property record and
rendered five declarations above the signature under "Here is what we found.
Signing confirms it." An unrun credit pull therefore produced a declaration
reading "clean" — asserting "no bankruptcy" from an absence of evidence, on a
document the borrower signs. It is deleted. The screen shows the borrower their
own answers and the signature attests to answers they gave.

## The sequence

Dependency order, not importance. No time estimates — build a schedule from
this with the people doing the work.

1. **The second borrower.** An appending route, an ordinal column, a
   co-borrower screen, and a deliberate choice at each `borrowers[0]` site. The
   database is already shaped for it.
2. **Write down the compute boundary** and type the two JSON columns.
3. **Vesting and the non-borrower parties**, which every shipped sample carries
   and no submission can omit.
4. **The modeled set and the derived inventory** — what we emit, and what we
   deliberately do not, derived from the corpus rather than hand-listed.
5. **Assemble and emit**, then **preflight**, which refuses to send a file DU
   would reject for a reason schema validation cannot see.
6. **The transport and the response**, which is where the credentials question
   stops being deferrable.

Steps 1 through 4 wait on neither the EULA nor the credentials.

## How to check this

Every claim about our code is a file:line at the commit named above; every
claim about DU is a named tab or test case in the specification corpus. Open
five at random and confirm they say what this says they say.

The corpus: DU Specification v1.9.3 (DU Map, Enumerations, Cardinality,
ArcRoles), the Fannie schema chain, the MISMO v3.4 reference model, and the
eighteen-case test suite of June 2026. **`DI-C09` is the one to read first** —
it links one asset to two borrowers, one liability to two obligors, an asset to
the liability secured by it, and income items to employers as first-class
entities. A DU submission is a **graph of `RELATIONSHIP` arcs**, not a nested
document, and that is the fact the data model had to satisfy.

**Two counts in the original audit are off, and this document repeated them.**
The ArcRoles tab holds **23** arcs, not 82 — 82 was the sheet's row count,
including a three-row header and trailing blanks. Eleven of the 23 appear
across all eighteen shipped samples. The Cardinality tab holds **171** distinct
container XPaths, not 174.

**And validating the XML proves much less than it looks like it does.** The XSD
enforces almost nothing about the relationship graph: a dangling `xlink:to`, a
duplicate label, an invented arcrole, duplicate sequence numbers, five
borrowers where DU allows four — and deleting the entire `RELATIONSHIPS`
container — all validate. Schema validity is necessary and nowhere near
sufficient, and DU's own rejection is the only other feedback loop. That is why
these invariants live in our database, where a second writer who never read the
design still cannot break them.
