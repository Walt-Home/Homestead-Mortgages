# What DU needs, and what we have

Where the Desktop Underwriter work stands, against the readiness audit of
2026-09-08. It exists so nobody re-derives the same answer twice.

Re-measured at `07e594f`. **Update it in the commit that changes what it
says** — a status page that lags the code is worse than none, because it gets
believed. Line numbers move; treat them as pointers to a name.

## Where this stands

**The model a submission is assembled from is built, a submission is now
assembled and emitted from it, and both ends of the exchange with DU exist.
Nothing refuses to emit, and nothing sends.**

Fourteen items are tracked below: eight done, five partial, one not. The count
still flatters us — what remains of the submission path is the preflight and a
transport that actually carries a document somewhere, and until there is one,
the port that would submit has nothing beneath it.

What changed since the last measurement is that **all three of the gaps that
blocked any submission are closed**. Declarations are asked and stored,
residences with them; the fabricated housing basis is gone; and assets,
liabilities, expenses and owned property exist as tables with real ownership,
enforced by the database rather than intended by a service.

Still true, and the sentence to keep at the front: **nothing in this system
transmits anything to anyone.** There is now a port that could — `du`, with a
fixture that answers and a real adapter that refuses — and what stops it is
that the real one has no seller/servicer number, no endpoint and no message
envelope, none of which is code.

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
- **More than one borrower.** Two are now real above the database: a route
  appends one, the projection orders everybody by `borrower_ordinal`, Section 5
  is answered and stored per person, and the review screen renders a block
  apiece, and a signature is one person's — their own authorization, their own
  4506-C, and nobody may make either on their behalf. What is missing is a
  screen that adds one, any surface a co-borrower can sign on at all, a bank a
  second borrower can link, and demographics asked of each of them — item 5.
- **Vesting and the non-borrower parties** have tables. `du_vestings` holds the
  sentence that will read on title, `du_deal_parties` holds the origination
  company, the originator, the note holder and the counseling agency, and a
  deferred trigger counts the ten-party ceiling across those two and the
  borrowing parties together. Nothing writes either table yet: there is no
  screen for a vesting and no place an NMLS number is configured.

### Missing

- **The compute boundary** — which figures we assert and which DU derives —
  still unrecorded, still two untyped JSON columns.
- **The rest of the submission path**: the preflight that refuses to send a
  file DU would reject, and the transport itself. The serializer is built —
  `packages/du` assembles an application into a MISMO 3.4 `MESSAGE` and emits
  it, `RELATIONSHIP` arcs included, ordered by the generated child sequence and
  checked against all eighteen vendored samples. It emits no `LOAN_IDENTIFIER`
  and no submitting party, because both wait on an answer about the institution
  we submit under, and no `DU:UNDERWRITING_VERIFICATION`, which arrives with its
  selection rule.

  The two ends of the exchange are built. The `du` port takes an assembled
  submission and answers with a recommendation, a findings report and DU's
  casefile id; the guard inside it refuses unless EVERY borrower the submission
  DECLARES has authorized every category of data it declares about them, on a
  signature made on THIS application — which is why a two-borrower application
  cannot be submitted until each of them can sign. And `du_responses` with
  `du_response_messages` receive what comes back, append-only, writing
  `applications.du_casefile_id` the once, refusing a status or a recommendation
  this system has never seen rather than defaulting either.

  **The document itself is never inspected.** The guard reads the assembler's
  manifest of who is in the casefile and what was retrieved about each of them;
  the emitted bytes are opaque to it, and the only thing asserted about them is
  that there are some. So the guard is exactly as good as the assembler's
  honesty about who is in the document — a person the emitter puts in and the
  manifest leaves out is transmitted with nobody's permission checked.

  **A recommendation is recorded and is not a decision.** Nothing in those
  tables moves an application: what DU returns is Fannie Mae's assessment of a
  loan they might buy, the creditor is Grander, and every move in the
  nineteen-state machine carries an actor principal DU has no row among. A file
  that moves because of an answer moves by somebody's hand, with a ledger row
  naming the response.

And one that is not code: **institution credentials and the agency agreement**,
which have a longer lead time than anything above.

## At a glance

| #   | Item                                | Status | One line                                                                  |
| --- | ----------------------------------- | ------ | ------------------------------------------------------------------------- |
| 3   | Borrower declarations               | Green  | Asked on their own screen, stored, chains enforced                        |
| —   | Current residence                   | Green  | The fabricated `"rent"` is gone; the question is asked                    |
| 6   | Assets, liabilities, owned property | Green  | Tables, ownership arcs, identity across a re-pull                         |
| —   | The generators and `du:verify`      | Green  | The whole corpus is vendored; all six tables rebuilt in CI, none skipped  |
| 1   | One casefile per loan               | Green  | Ours stable; DU's write-once, and a response is what writes it            |
| 2   | Income survives a re-pull           | Green  | Snapshot lineage instead of delete-and-recreate                           |
| —   | Identity model                      | Green  | The party layer won; `borrowers` is a record about a person               |
| —   | Ownership shape                     | Green  | Relational + join tables, now applied to assets                           |
| —   | The serializer                      | Green  | Assembles and emits MISMO 3.4, arcs included, round-tripped on eighteen   |
| 7   | Employer as an entity               | Yellow | Real entity, derivable arc; two current employers get none                |
| 4   | Verification report identifier      | Yellow | Stored and attributed; assets still do not read it                        |
| 5   | Up to four borrowers                | Yellow | Two render and answer for themselves; no screen adds one                  |
| —   | Vesting and non-borrower parties    | Yellow | Two tables and the ten-party ceiling; nothing writes them yet             |
| 8   | What we compute vs what DU does     | Red    | Two untyped JSON columns and no recorded boundary                         |
| —   | The submission                      | Red    | Emitter and both ends built; no preflight, and nothing carries a document |

**The three that blocked any submission are closed.** Declarations, the current
residence, and assets with liabilities and owned property were each a hard stop
— a file missing any of them is malformed rather than thin — and each is now
built and enforced at the database.

What remains splits cleanly. The borrower count and the compute boundary limit
_which_ loans we could submit and how confidently. The submission path is what
makes submitting possible at all, and it is now half built: an application
becomes a document, and nothing yet decides whether that document should go.

## Decided: we submit

**We assemble and submit to DU ourselves.** Not a handoff to Grander's intake.
Decided 2026-09-11.

That decision is what makes the schema chain ours to satisfy, the compute
boundary ours to draw, and the casefile a thing that has to round-trip. It is
also why the specification corpus is a dependency rather than reference
material. **The whole of it is vendored**, in `packages/du-schema`, with a
README naming where every file came from:

- **The schema chain**, in `xsd/` — nine XSDs, the transitive closure of the DU
  wrapper's imports — plus Fannie's eighteen test cases in `samples/`. It is a
  frozen 2016 MISMO publication and a dated Fannie release, and it is what makes
  an emitted document either legal or not. Having it in the tree is what lets
  `du:verify` re-derive every child sequence in `generated/order.ts`, and
  re-count from the eighteen samples which arcs in `generated/arcroles.ts` a
  shipped DU document actually carries. Its own suite validates all eighteen
  samples against the chain on every `npm test`.
- **The workbook**, in `workbook/` — `DU_Specification v1.9.3.xlsx`, 745,422
  bytes, 707,679 of history. It was held out for a while on the argument that it
  is a document that moves, reissued several times a year, against a chain that
  is frozen; what that cost was four of the six generated tables — enums,
  lengths, cardinality, conditionality — plus the arcroles' endpoints, which no
  automated check ever read, because the only machine that gates a merge did not
  have the file. **Reversed 2026-09-14.** `du:verify` now rebuilds all six
  tables everywhere and skips nothing, there is no `DU_SPEC_DIR` and no corpus
  to obtain, and the byte-for-byte proof that the vendored copy is the one the
  committed tables came from is that regenerating from it changed nothing.

Schema validity is a lint and not a gate, and `packages/du-schema/README.md` is
where that is spelled out: a dangling `xlink:to`, a duplicate label, an invented
arcrole, five borrowers, a deleted `RELATIONSHIPS` container and a document with
no `<LOANS>` and no `<PARTY>` in it at all — nothing to underwrite and nobody to
underwrite it — all validate. Its own tests assert every one of them passes, so
nobody promotes `xmllint` to a gate later.

### What is still open, and it is not technical

Grander is the creditor and Supermortgage administers as their agent. A DU
submission goes in under a seller/servicer number, so:

- **Whose institution credentials do we submit under, and what does the agency
  agreement permit?** Presumably Grander's, since they are the creditor — but
  that is a contract question, not one the code can decide.
- **The corpus is vendored under a decision, not under a signed license.** The
  instruction is to build as though the EULA and the DU integration agreement
  are in place, on the understanding that no real borrower and no real loan
  goes through this system until they are. MISMO's five files carry a copyright
  notice and point at the MISMO End User License Agreement; Fannie's four, the
  eighteen samples and the specification workbook carry no notice and sit under
  the DU integration agreement; `xml.xsd` is the W3C's. Whose each file is, is
  recorded in `packages/du-schema/README.md`, and a test fails if a re-vendor
  brings in one nobody assigned. Somebody with authority to accept the EULA
  still has to read it.
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
the application out of ever receiving one. `recordDuResponse` is what populates
it, and it is the only thing that does; a second trigger on `du_responses`
refuses a response filed under any other casefile than the one the application
carries, so the two tables cannot come to disagree about which case this is.

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

**Item 5 — up to four borrowers.** The database half landed first.
`application_parties.borrower_ordinal` exists, is constrained to one through
four, admits exactly one Borrower 1, is required of a borrowing role and
forbidden of a non-borrowing one, and existing rows were backfilled;
`ensureApplicationParty` locks the application and allocates the smallest free
position, so two concurrent appends cannot take the same one.

Two borrowers are now real above it as well. `POST /api/files/:id/co-borrowers`
appends a person — a PROVISIONAL party, since a co-borrower named by the
applicant has never signed in and has asserted nothing themselves — and takes
the smallest free position. The projection orders a file's borrowers by that
position rather than by when the row was written, which is the same order DU
reads them in. Section 5 and the residence history hang off the person, not the
file: `POST /files/:id/declaration` takes a `borrowerId`, each borrower carries
their own answers, and `borrowers.current_housing` reads NULL for a co-borrower
who has not been asked. The review screen renders a block per person under
their own name, and the file list names everybody on a joint application.

Naming a borrower is not answering for them. The row is stamped with the
principal of whoever sent the request, and `du_declarations_are_self_attested`
admits the declaring borrower or a member of staff and nobody else — so an
applicant posting a co-borrower's `borrowerId` is refused with a 403 rather
than recording that person as having attested to a bankruptcy on a form they
have never seen. A fifth append is refused too, as a 409 naming the ceiling
rather than the 500 the ordinal allocator used to surface.

The engine and the authorization boundary came off the subscript with it.
`satisfaction.ts` puts its per-applicant requirements to everybody through
`ofEveryBorrower` — satisfied only once every answer is in, unsatisfied naming
whoever is still missing — and the three-valued ones through `ofAnyBorrower`,
which stays `null` while anybody is silent rather than letting one person's
answer settle a question about another. APP-005 and APP-012 read that
borrower's own consent row rather than a file-level `some()`, which is what the
only minter does: `tokenFor` takes a Borrower rather than a `LoanFile` and
filters `authorizations` by that party, and `requireSubject` refuses inside the
adapters a token naming somebody who is not on the file. So the party half of
"nothing may be pulled before APP-005" is enforced where the pull happens, not
at the route.

**Each borrower signs their own 4506-C.** The IRS form names one taxpayer, so
the tax boundary is now identical to the credit boundary rather than an
exception to it: the applicant's signature on screen 5 authorizes the
applicant's transcripts, and a co-borrower who never finishes has nothing
pulled rather than having their tax records pulled on their partner's
signature.

A signature is taken from the person signed in and from nobody else. `signerOn`
resolves the signer by PARTY rather than by position — on a file whose Borrower
1 has been replaced the person signing is still a borrower and no longer the
first row, and `borrowers[0]` filed their signature under the replacement's name
— and `assertSignsForThemselves` refuses the two doors that were handed a
borrower id outright: completing an e-sign envelope minted for somebody else,
and `POST /files/:id/consents`. The e-sign route takes no borrower id at all,
because one there would be a capability rather than a question: the applicant
owns a joint file and holds the only session on it, so it would let them execute
the co-borrower's 4506-C. `du_declarations_are_self_attested` makes the same
refusal about Section 5, and this is that rule where the signatures are taken.

A RETRIEVAL is a different question, so `POST /files/:id/irs` does take a
`borrowerId`: the pull is ours to make, and naming whose records to fetch is a
question the minter then answers. Saying nothing means the person asking,
resolved by party — the connector screens post no borrower id, and on a file
whose Borrower 1 has been replaced defaulting to the first row refused the
borrower who had signed and pulled the other person's records. `/credit`,
`/bank` and `/payroll` resolve their subject the same way, so one press of
Connect retrieves about the person who pressed it.

**The signature that licenses a pull has to have been made HERE.** `tokenFor`
takes the file as well as the person, and asks two things that fail in
different directions: the party's own grants, which say whether the permission
was never given, revoked or merely lapsed; and then this file's own consent row
for that purpose. The second is the one a party-keyed read of `authorizations`
did not do — a grant carries no loan file and lives 120 days, so read by party
alone it is one person's permission everywhere, and the applicant on a joint
file could pull a co-borrower's federal tax transcripts onto this application
on a 4506-C the co-borrower signed for a different one. The row is what the
engine reads too, so `evaluateSatisfaction` and the guard now agree about the
same file rather than disagreeing out loud: a file where INC-008 is outstanding
is a file where the pull is refused. `signedOn` asks about one party as well —
it used to ask whether the FILE held a row of the kind, which answered "already
signed" for somebody whose only signature on it was another person's. INC-008
follows, and is per applicant now like APP-005 and APP-012, because the
retrieval is.

The receipt names each signer, with that person's own three party-side pieces
and their own two signature dates. What it COUNTS is unchanged and deliberate:
the TRID clock opens on one applicant's three pieces plus the three request-side
ones, never on a mixture of two people's. Two reasons, and the second is why the
clock does not wait for a co-borrower. TRID's pieces are about the consumer
asking for credit, so one person's name beside another's SSN describes nobody;
and a clock may only ever err EARLY, which is the rule `ECOA_ADVERSE_ACTION_30D`
already follows — withholding the receipt until every borrower had finished
would delay a legal deadline that has already started, and on a joint file today
it would withhold it forever, because a co-borrower cannot sign in. So the
consent and the e-sign routes put a signer on the application at the role they
actually hold, through `borrowingRoleFor`. Naming `PRIMARY_BORROWER` outright,
as both did, made a signer who is not Borrower 1 — the shape a replaced
applicant leaves — a SECOND applicant at ordinal 2, because the index that says
there is one Borrower 1 is over the position and not the role; and the receipt
counts any primary's pieces, so their three would have started the clock.

Two answers are still settled by a co-borrower's silence, and they are the two
the party projection supplies for free. `marital_status` is required of every
party and `preferred_language` falls back to `en`, so APP-015 and APP-017 read
back an answer for somebody nobody asked — the applicant stated both on the
append, and neither has been put to the person it is about.

Four more have no path to an answer for a second borrower at all, and that is a
consequence already in the tree rather than work still ahead. APP-001 wants an
identity verification, and the ID scan is a POST only a signed-in borrower can
make; APP-005 and APP-012 want that person's own signature; APP-011 wants
demographics, which the append takes as a nullable field and no screen goes
back to ask. Asked of every borrower, they now sit outstanding on a joint file
with nothing on any screen able to clear them — APP-011's screen is `identity`,
and `branchesFor` renders a card for payroll, the IRS and documents and for
nothing else. They reach a decided file as open conditions rather than parking
it at "Needs you".

What is still missing is narrower than it was, and none of it is structural:

- **No screen adds one.** The route is there and nothing in `apps/web` posts to
  it, so a second borrower can only arrive through the API.
- **`connector_links` is unique on `(loanFileId, kind)`**, so a second borrower
  cannot link their own bank.
- **The demographics are asked once**, of the applicant. Regulation B wants
  them requested of each applicant, and screen 5 asks its three questions of
  the person signing.
- **A co-borrower's Section 5 cannot be written at all** until they have a
  session of their own or a member of staff takes the answers by phone, and
  there is no staff route either. The refusal is the correct one — a
  declaration is a statement the declaring borrower signs — but it means a
  joint application is not completable by the applicant alone, and the
  signature is still the applicant's own.
- **A co-borrower has nowhere to sign, and the applicant may not sign for
  them.** They are appended by the applicant and have never signed in, so
  neither their verification authorization nor their 4506-C can be collected
  through any route today, and nothing of theirs is retrieved. Both halves are
  enforced rather than merely absent — the routes refuse a signature taken on
  somebody else's behalf, and the minter refuses a pull on a signature made
  anywhere else — and the review screen says so in the applicant's own words
  instead of looking finished: in the signing panel before the signature, and
  in the two endings after it, because the signature is what makes every other
  sentence on that screen stop rendering. An outstanding co-borrower signature
  raises no branch card — its source is the signature, which `branchesFor()`
  deliberately excludes — so those sentences are the only place the product
  says it. A claim or invite path is its own work.
- **Four `borrowers[0]` reads remain** in TypeScript source excluding tests —
  the figure moves a lot with the filter, so it is stated here with its filter
  attached. The eight route reads are gone: the connector, application and
  e-sign routes each resolve one person — the signer through `signerOn`, a
  named retrieval subject through `namedBorrower`, the applicant through
  `primaryBorrower` — and use that person for the token, the snapshot and the
  ledger row. What is left is three server-side — the
  subscript inside `primaryBorrower` itself, the persona seed's ordering guard,
  and the one in `conditions.ts` that says whose the file's single credit
  report is — and the screens' own in `apps/web/src/lib/borrowers.ts`, where
  `primaryBorrower` names the intent the subscript used to stand for.

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

**Vesting and the non-borrower parties.** `DEAL/PARTIES/PARTY` is `1:10` with
the note "Each Deal must have at least one party (non-Borrower)", and a
submission made only of borrowers satisfies neither half — all eighteen samples
carry a `LoanOriginationCompany` and a `LoanOriginator`, nine carry a
`PropertyOwner`. Both tables exist now. They are two tables rather than one
because the corpus says they are two kinds of thing: every `PropertyOwner` is
an `INDIVIDUAL` whose `FullName` holds a vesting sentence with no taxpayer
identifier and no arc pointing at it, so `du_vestings` stores the sentence,
while `du_deal_parties` holds institutions and one employee and carries the
thing no borrower does, a license. The ten is counted across all three sources
by a deferred trigger that fires on those two tables and deliberately not on
`application_parties`: the only writer that appends a borrowing party cannot
see the other two, and refusing a co-borrower because somebody recorded a
counseling agency would be a lockout in the borrower flow. An honest eleventh
is therefore reachable, and it is the preflight that has to catch it — item 5
below, and not built, so nothing catches it today. The trigger fires only on a
write that could ADD a party, so a file already over ten stays editable.

Nothing writes either table yet, `Trust` has no home in either, and each role
carries one license where the container allows two. One narrowing is worth
knowing before it bites: `NotePayTo` is bound to the legal-entity name shape,
while DU Map 4b.1 gives it both containers and defines the role as "The
individual or legal entity whose name appears on a note". All nine in the
corpus are institutions and DU's individual slot there is an unparsed
`NAME/FullName` the parsed columns cannot express, so a seller carryback or a
private second cannot be recorded until that column exists.

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

1. **The second borrower.** The ordinal column, the appending route, per-person
   declarations, an engine that judges each person on their own answers, and a
   review screen that renders both are done. What is left is a screen that adds
   one, a bank each of them can link, the demographics asked of each applicant,
   and a signature apiece.
2. **Write down the compute boundary** and type the two JSON columns.
3. **Writers for vesting and the non-borrower parties.** The tables and the
   ten-party ceiling landed; what is missing is anything that fills them — a
   vesting on the review screen, and our own NMLS numbers somewhere other than
   a fixture.
4. **The modeled set and the derived inventory** — what we emit, and what we
   deliberately do not, derived from the corpus rather than hand-listed.
5. **Assemble and emit**, then **preflight**, which refuses to send a file DU
   would reject for a reason schema validation cannot see.
6. **The transport**, which is where the credentials question stops being
   deferrable. The response it will carry already has tables and a port to
   arrive through; what is missing is the endpoint, the envelope and the
   seller/servicer number a casefile goes in under.

Steps 1 through 4 wait on neither the EULA nor the credentials.

## How to check this

Every claim about our code is a file:line at the commit named above; every
claim about DU is a named tab or test case in the specification corpus. Open
five at random and confirm they say what this says they say.

The corpus, all of it now in `packages/du-schema`: DU Specification v1.9.3 (DU
Map, Enumerations, Cardinality, ArcRoles), the Fannie schema chain, the MISMO
v3.4 reference model, and the eighteen-case test suite of June 2026. **`DI-C09`
is the one to read first** — it links one asset to two borrowers, one liability
to two obligors, an asset to the liability secured by it, and income items to
employers as first-class entities. A DU submission is a **graph of
`RELATIONSHIP` arcs**, not a nested document, and that is the fact the data
model had to satisfy.

**Two counts in the original audit are off, this document repeated them, and
the first correction was wrong too.** The ArcRoles tab holds **11** arcs, not
82 and not 23. The reason both readings overshoot is the tab's shape: it
describes every arc **twice**, once in its "Establishing Endpoints in the
Relationship" section and once as a `RELATIONSHIP` block, across 82 rows
including headers, sub-headings and a blank line between blocks. No count of
its rows is a count of its arcs. **Nine** of the eleven appear across the
eighteen shipped samples; the two that do not are the two that compute an income
figure, `UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET` and `..._EMPLOYER`.
All of that is now `packages/du/src/generated/arcroles.ts`, generated rather
than counted by hand, and `du:verify` re-counts the corpus column against the
vendored samples on every run. The Cardinality tab holds **171** distinct
container XPaths, not 174.

**And the tab disagrees with itself at two ends.**
`UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET` targets
`OWNED_PROPERTY_DETAIL` in its endpoint XPath and its Target column, and `ASSET`
in its `to` row and in the arcrole's own name; the EMPLOYER one targets
`EMPLOYER` by XPath and by name, and `EMPLOYMENT` by column and by `to` row. The
generated table carries all four names at each end and a `disputed` flag, and
picks neither — the arcs are the two nothing has been seen to send, so there is
no shipped example to break the tie, and it is a question for Fannie Mae.

**And validating the XML proves much less than it looks like it does.** The XSD
enforces almost nothing about the relationship graph: a dangling `xlink:to`, a
duplicate label, an invented arcrole, duplicate sequence numbers, five
borrowers where DU allows four — and deleting the entire `RELATIONSHIPS`
container — all validate. Schema validity is necessary and nowhere near
sufficient, and DU's own rejection is the only other feedback loop. That is why
these invariants live in our database, where a second writer who never read the
design still cannot break them.
