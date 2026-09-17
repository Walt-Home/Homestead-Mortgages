# What DU needs, and what we have

Where the Desktop Underwriter work stands, against the readiness audit of
2026-09-08. It exists so nobody re-derives the same answer twice.

Re-measured at `3e2b10d`. **Update it in the commit that changes what it
says** — a status page that lags the code is worse than none, because it gets
believed. Line numbers move; treat them as pointers to a name.

## Where this stands

**The model a submission is assembled from is built; a submission is assembled
and emitted from it, jobs included; a preflight refuses to emit one Desktop
Underwriter would reject; both ends of the exchange exist and the transport
that would carry a casefile is written and tested against a stubbed server. What
it lacks is the endpoint, the credential and the seller/servicer number the
integration agreement supplies, so nothing reaches Fannie Mae yet — and a
household of up to four people can now be named, invited, claimed and walked
through its own halves, with how title will read and who originated on every
application.**

Seventeen rows are tracked below: thirteen green, three yellow, one red. The
yellow three are narrower than they read — assets not yet reading the
verification identifier, a co-borrower's reports not yet reaching the engine,
and a document nothing carries anywhere — and the red one is a number nobody
holds, which no code closes.

**The gate found things, and they are in this page rather than in a comment.**

**Eight of the eleven columns that stood between this model and a sendable
casefile are built.** Six are the PRODUCT's, and they are a table rather than
six columns on a file: `loan_products` holds `MortgageType` and the four
indicators — construction, balloon, interest-only, negative amortization — plus
the prepayment penalty, because whether a loan builds or balloons is true of
`CONF-30-FIXED` itself and identical on every file quoted against it. A
prepayment penalty reads at first like a term of the note rather than a family
of product; Regulation Z makes it structural, because a penalty is permitted
only on a fixed-rate qualified mortgage that is not higher-priced and the
creditor has to offer an alternative loan without one — which is a second
product at a second price, not a second checkbox on this one.
`loan_files.product_code` is now a foreign key to that table, so a file cannot
be quoted against a product whose characteristics nobody holds.

**A seventh moved onto that table rather than arriving with it.**
`AmortizationType` was `loan_files.amortization`, the literal string `'fixed'`
written onto every file by the create route, and it is a product characteristic
by exactly the test the five indicators are chosen by. Left on the file it could
contradict them: a product whose `interest_only` and `balloon` are true, quoted
onto a file still saying Fixed and fully amortizing, is a casefile that
disagrees with itself and validates. The column holds the DU value now rather
than a word of ours, so the emitter has no lookup table left to be wrong.

The other two are the PROPERTY's, and they split on where an answer can come
from. `financed_unit_count` is retrieved: the county holds it and screen 1's
assessor lookup already returned it. `property_estate_type` is asked, on screen
3, as APP-028 — no assessor record, valuation or flood determination carries it,
and the title commitment that settles it does not exist when a casefile is
submitted. Both are nullable and **nothing defaults**: an address no vendor
answers for and a borrower who has not reached screen 3 each leave a null, the
preflight refuses, and the refusal is ours instead of Desktop Underwriter's.

**A ninth column came out of the gate rather than out of the audit.**
`AttachmentType` is required the moment `FinancedUnitCount` exists — "Required
IF FinancedUnitCount < 5" — and all eighteen shipped samples carry it, six
`Attached` and twelve `Detached`. Answering one of the eight is what made it
bite, and the preflight said so on the first run. It is retrieved beside the
unit count off the same assessor record, because it describes the building and
a borrower's word for a fact the county holds is what screen 1 exists to avoid.
It is not derivable from `property_type`: a single-family house on a row is
attached.

The three columns on a job are closed. `EmploymentClassificationType` is
derived — the current job carrying the most employment income is Primary, the
rest Secondary, and nobody is asked — and the other two are asked:
`EmploymentBorrowerSelfEmployedIndicator` (URLA 1b.9) and
`SpecialBorrowerEmployerRelationshipIndicator` (1b.8) are the borrower's own
statements about each current job, the same class of answer as Section 5 and
refused the same derivation. They are asked on the review screen, once the
pulls have said which jobs there are, stored on `employments` with who said
them and when, held whole by a CHECK, and attested by the signature beneath.
`APP-029` is the requirement, three-valued until a pull has looked for a job.
A casefile with a job on it now emits; `du-submission.test.ts` proves it both
ways, and the scoreboard carries a job.

The api suite names what is left exactly, so the list shortens in the commit
that adds a column and cannot quietly grow. The eight-column test now asserts an
EMPTY finding list and emits through `emitSubmission`, with three tests beside
it that withhold the product, the property facts and the attachment one at a
time and name what goes missing — an empty list is only worth something if
withholding something puts it back.

What changed since the last measurement is that **all three of the gaps that
blocked any submission are closed**. Declarations are asked and stored,
residences with them; the fabricated housing basis is gone; and assets,
liabilities, expenses and owned property exist as tables with real ownership,
enforced by the database rather than intended by a service.

Still true, and the sentence to keep at the front: **nothing in this system
transmits anything to anyone.** The port and the real adapter behind it are
now built as far as code can take them — the HTTP exchange, a credential in
one of three schemes, a response reader that refuses what it does not
recognize rather than filing it, the case identifier that makes a
resubmission a resubmission, and a production refusal of every placeholder —
and every one of them is exercised against a stubbed server. What stops it is
five values from the DU integration agreement: the endpoint, the seller/servicer
number, the credential and its scheme, and the environment. None is code, and
`DU_ENDPOINT` has no default on purpose.

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
  in a block labelled "generated". What a submission carries and this model
  does not is derived from the corpus rather than hand-listed, and every table
  in the schema is now either claimed by the modeled set or excused by name
  with a reason, so a new table cannot leave the inventory overstating what we
  cannot emit.
- **One casefile per loan, in both shapes.** Ours, stable across
  resubmissions; and `du_casefile_id`, DU's own, write-once by trigger. Nothing
  populates the second yet, because nothing has asked DU for one.
- **Identity lives on Party**, with facts carrying provenance and a confidence
  tier, and an AI or partner principal barred by trigger from asserting a
  verified one.

### In progress

- **Employer is a real entity** — but only a vendor pull creates one, so a job
  a borrower typed still has nothing behind it.
- **The verification report identifier** is stored, snapshots say whose report
  they are, and one `DU:UNDERWRITING_VERIFICATION` per report type per borrower
  now reaches the wire with its arc to that borrower's `ROLE` — the latest pull
  of each kind and never the history, because `connector_snapshots` is
  append-only and six resubmissions on a two-borrower file would otherwise emit
  thirty-six elements against a maximum of fifty. A vendor with no row in the
  emitter's approved-supplier table emits nothing, which is where a change to
  DU's list lands. Assets still read neither the identifier nor the snapshot.
- **More than one borrower.** Two are now real above the database: a route
  appends one, the projection orders everybody by `borrower_ordinal`, Section 5
  is answered and stored per person, and the review screen renders a block
  apiece, and a signature is one person's — their own authorization, their own
  4506-C, and nobody may make either on their behalf. Screen 2 names one — a
  name, an email, whether they will live in the home — and the file waits on
  them: signing, deciding and assembling all refuse while somebody named has
  not completed their own profile. The invitation and the claim are built,
  and the sample household is seeded through them rather than beside them:
  the seed names Dev, reads his link out of the fixture outbox, claims it as
  a sign-in of his own and walks his own half — screen 2, Section 5, his
  signature — through the same services a real co-borrower goes through.
  The read is redacted in both directions — the applicant sees that a
  co-borrower has answered and signed, never what they said — and the
  invitation is sent from screen 2, its token in the URL fragment where no
  request log records it. What is missing is a co-borrower's reports
  reaching the engine — item 1.
- **Vesting and the non-borrower parties** have tables and, now, writers.
  `du_vestings` holds the sentence that will read on title — asked on the review
  screen, stated by the applicant, refused at signing when absent —
  and `du_deal_parties` holds the origination
  company, the originator, the note holder and the counseling agency, and a
  deferred trigger counts the ten-party ceiling across those two and the
  borrowing parties together. Nothing writes either table yet: there is no
  screen for a vesting and no place an NMLS number is configured.

### Missing

- **The transport's credentials.** The transport itself is built: `submit`
  posts the emitted casefile to `DU_ENDPOINT` under the configured credential,
  reads the answer through a `DuResponseReader` that refuses any shape it
  cannot vouch for (a sign-in page, an unfamiliar verdict) rather than filing
  it against the write-once casefile column, and emits DU's own
  `AutomatedUnderwritingCaseIdentifier` on a resubmission so one loan does
  not open two cases. The reader is written against the one response shape the
  vendored chain declares, `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE`, and is
  the only file that changes when a real payload is in hand. What is missing
  is what the integration agreement supplies. The serializer is built — `packages/du` assembles
  an application into a MISMO 3.4 `MESSAGE` and emits it, `RELATIONSHIP` arcs
  included, ordered by the generated child sequence and checked against all
  eighteen vendored samples. It emits no `LOAN_IDENTIFIER` and no submitting
  party, because both wait on an answer about the institution we submit under.

  **And the gate is built.** `packages/du/src/preflight` runs between assembling
  and emitting: `emitSubmission` returns bytes or throws, and there is no
  argument that turns it off. It checks the graph the schema cannot see — a
  dangling arc, a duplicated label, an invented arcrole, an arc whose end lands
  on the wrong kind of container, an asset nobody owns — the cardinality minima
  SCOPED BY ROLE rather than read literally off the tab, forty-three data points
  the specification requires with no statement in front of them, eighty-eight of
  its conditional rules, every value's format and width at the destination it is
  written to, the two figures a casefile states twice, and the live rows the
  identity matcher refused to tell apart. All eighteen shipped samples pass it;
  every check has a fixture built by mutating one of them, and `xmllint` accepts
  all but two of those fixtures, which is the measurement behind the claim that
  schema validity is not the same thing as a casefile DU will take.

  Where a refusal goes: to whoever asked for the document, which is an operator
  or a job. Nothing renders it to a borrower, and a finding names an XPath, a
  label or a row id and never a value — so it is safe in a log, which the
  document it is about is not.

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

| #   | Item                                | Status | One line                                                                                       |
| --- | ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 3   | Borrower declarations               | Green  | Asked on their own screen, stored, chains enforced                                             |
| —   | Current residence                   | Green  | The fabricated `"rent"` is gone; the question is asked                                         |
| 6   | Assets, liabilities, owned property | Green  | Tables, ownership arcs, identity across a re-pull                                              |
| —   | The generators and `du:verify`      | Green  | Corpus vendored, six tables rebuilt in CI, holder check runs both ways                         |
| 1   | One casefile per loan               | Green  | Ours stable; DU's write-once, and a response is what writes it                                 |
| 2   | Income survives a re-pull           | Green  | Snapshot lineage instead of delete-and-recreate                                                |
| —   | Identity model                      | Green  | The party layer won; `borrowers` is a record about a person                                    |
| —   | Ownership shape                     | Green  | Relational + join tables, now applied to assets                                                |
| —   | The serializer                      | Green  | Assembles and emits MISMO 3.4, arcs included, round-tripped on eighteen                        |
| 7   | Employer as an entity               | Green  | Real entity, derivable arc, classification derived, the two 1b answers asked                   |
| 4   | Verification report identifier      | Yellow | Stored and attributed; assets still do not read it                                             |
| 5   | Up to four borrowers                | Yellow | Named, invited, claimed, and walking their own half; their reports do not reach the engine yet |
| —   | Vesting and non-borrower parties    | Green  | Asked on the review screen; the originator on every application from birth                     |
| 8   | What we compute vs what DU does     | Green  | Boundary written, both columns typed and CHECKed, a corpus test holds it                       |
| —   | The submission                      | Yellow | Emitter, gate and both ends built; nothing carries a document                                  |
| —   | The product and the property        | Green  | A product table, a retrieved building and one question on screen 3                             |
| —   | Who we submit under                 | Red    | Both elements emitted, both PLACEHOLDERS, refused outside development                          |

**The three that blocked any submission are closed.** Declarations, the current
residence, and assets with liabilities and owned property were each a hard stop
— a file missing any of them is malformed rather than thin — and each is now
built and enforced at the database.

What remains splits cleanly. The borrower count limits _which_ loans we could
submit; the compute boundary is written, and every figure we compute is one DU
derives for itself. The submission path is what
makes submitting possible at all, and an application now becomes a document the
gate is willing to let out — bytes, on a file with no job on it. What it does
not become is a document anything carries anywhere.

**What V1 will submit is narrower than what the model can hold, and that is a
decision rather than a gap.** Conventional Fannie purchase and simple
rate-and-term refinance, with up to four borrowers including co-signers. Out:
cash-out refinance, HELOCs, seconds, VA, FHA, USDA, Ginnie. Two of those are
enforced rather than merely intended, because the product could otherwise take
a borrower somewhere nobody underwrites: `loan_files_v1_scope` refuses a file
that arrives in or moves into `CASH_OUT_REFINANCE`, and `ApplicationPartyRole`
has no `GUARANTOR` — Desktop Underwriter's eight party roles carry no
guarantor and neither does the MISMO chain, so a co-signer is a
`NON_OCCUPANT_CO_BORROWER`, who signs the note and emits a `BORROWER`. The
enum member and the two cash-out columns stay: cash-out is a later version, and
the tables that would carry it are the shape a later version needs.

**The two new rows are the gate's own output and not a re-reading of the
audit.** Neither the product columns nor the employment ones were visible
before something evaluated the specification's required column against a
casefile this repository built — and the same is true one layer down, of the
attachment type nobody knew was missing until a unit count existed to trigger
it.

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

  **A submission now carries both elements, and both are placeholders that
  must be replaced before any of this is real.** They were absent, which made
  the question invisible in the document; they are present now so that what is
  missing is a value somebody supplies rather than a block somebody has to
  remember to build.

  | Element                                                                                                    | Placeholder       | What it has to become                                                             |
  | ---------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
  | `LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER` with `LoanIdentifierType` `LenderLoan`, `String 15`                | `PLACEHOLDER-DEV` | The lender's own number for this loan. Nothing mints one and no column holds one. |
  | `MESSAGE/DEAL_SETS/PARTIES` party with `PartyRoleType` `SubmittingParty`, `PartyRoleIdentifier` `String 6` | `PLCHLD`          | The seller/servicer number — the Map files it as "Institution ID".                |

  Both live in `packages/du/src/institution.ts`, which is also what refuses
  them: `assembleSubmission` calls `assertInstitutionEmittable` before it reads
  a row, and that throws when either value is still the placeholder and
  `NODE_ENV` is `production`. **The values say what they are**, which is the
  point — an empty element is a casefile Fannie Mae rejects, and a
  plausible-looking number is one it accepts against somebody else's
  institution. The submitting party is not in `MODELED_CHILDREN`, and cannot
  be: none of the eighteen shipped samples carries one, and that list has to
  partition the corpus.

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

Two borrowers are now real above it as well, and the second arrives in two
steps that are two different people's. `POST /api/files/:id/co-borrowers`
NAMES a person — first name, last name, email and whether they will live in
the home — as a PROVISIONAL party holding those two facts under the
applicant's principal and nothing else, a borrower row whose `ssn_last4` is
NULL, and a membership at the smallest free position in the role the
occupancy answer gives them. The schema is strict: an identity posted there is
refused, not stripped to the name inside it, because the applicant has no
business stating somebody else's date of birth. The projection lists such a
person as `invitedBorrowers` rather than among `borrowers`, since a person
with no date of birth is not a borrower the engine can evaluate, and
`identityMissing` is what tells the two apart — a CLAIMED party with a hole in
it is still the invariant violation `requireIdentity` throws on by name.
`appendCoBorrowerWithFacts` is the whole-identity writer, the paper joint URLA;
no screen offers it, and the tests and the persona seed build complete
households with it. The projection orders a file's borrowers by position
rather than by when the row was written, which is the same order DU reads
them in. Section 5 and the residence history hang off the person, not the
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
would delay a legal deadline that has already started — and on a joint file it
would wait on a person who may take days to claim their invitation. So the
consent and the e-sign routes put a signer on the application at the role they
actually hold, through `borrowingRoleFor`. Naming `PRIMARY_BORROWER` outright,
as both did, made a signer who is not Borrower 1 — the shape a replaced
applicant leaves — a SECOND applicant at ordinal 2, because the index that says
there is one Borrower 1 is over the position and not the role; and the receipt
counts any primary's pieces, so their three would have started the clock.

Two answers are still settled by a co-borrower's silence on a household
stated in full, and they are the two the party projection supplies for free.
`marital_status` is required of every party and `preferred_language` falls
back to `en`, so APP-015 and APP-017 read back an answer for somebody nobody
asked — whoever stated the household on paper stated both, and neither has
been put to the person it is about. A NAMED co-borrower is not in `borrowers`
at all until they arrive, so nothing is asked of them and nothing is answered
for them; the file waits instead, and three gates say so in the same words —
`POST /sign-application` and `POST /decision` with a 409 `CO_BORROWER_PENDING`,
and the assembler by refusing the party by name before a generic "no date of
birth" could say it worse.

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

- **A co-borrower's own half stops at screen 2.** The invitation and the
  claim are built: `POST /files/:id/co-borrowers/:borrowerId/invitations`
  emails a link whose token exists nowhere but the email (the table holds its
  SHA-256; seven days; a re-send kills the last one), `GET /auth/claims/:token`
  shows a stranger what the email already said and answers every bad link
  with the same 404, and `POST /auth/claims/:token/accept` — signed in with
  Google, never an email match — merges the named party into the person's own:
  the borrower row and the membership move to the survivor, the two facts the
  applicant stated are restated on it, and the person is listed as `claimed`
  until their own screen 2 states a number. A member reads the household's
  half of the file and their own — the applicant's person is redacted to a
  name — and completes their own half in their own session: screen 2 about
  themselves, Section 5 about themselves (the route resolves an unnamed
  `borrowerId` to the person asking), the three demographic questions, and
  one signature that is theirs alone — their 4506-C and an
  `application_signature` consent in their name, never the file's
  `applicationSignedAt`, which stays the applicant's. A link is a person's now
  — `connector_links.party_id`, one per person per kind — so a co-borrower
  links their own bank and their read of the file carries their own reports;
  the file's own fields stay Borrower 1's by party, which is what the engine
  reads. A co-borrower's reports reaching the engine is the compute-boundary
  item's, not the projection's.
- **A co-borrower's reports do not reach the engine.** Links and snapshots are
  theirs by party, and their own read carries them, but the file's own
  `credit`, `assets` and `payroll` are Borrower 1's, which is what the engine
  reads. Consuming a second person's reports is the compute-boundary item's
  question, not the projection's.
- **Two answers are still settled by a stated household's silence** — APP-015
  and APP-017 read back `marital_status` and `preferred_language` for a person
  appended on paper who was never asked. A named co-borrower states both on
  their own screen 2, so the gap is only the paper path.
- **No staff route takes a co-borrower's answers by phone**, so a household
  that cannot sign in has to be stated on paper through the service.
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

**The product and the property.** Built, in three places, because the eight
data points the specification requires unconditionally on the subject loan and
the subject property are three kinds of thing.

`loan_products` is the first, keyed on the code a file is quoted under.
`MortgageType` at `TERMS_OF_LOAN` and the five `LOAN_DETAIL` indicators —
`ConstructionLoanIndicator`, `BalloonIndicator`, `InterestOnlyIndicator`,
`NegativeAmortizationIndicator`, `PrepaymentPenaltyIndicator` — are all true of
`CONF-30-FIXED` itself rather than of the person being quoted, and a code is a
string, not a statement that the loan behind it amortizes. The rate and the term
stayed on the file: those are quoted per borrower from a rate sheet keyed on
product, FICO, LTV and lock period. The prepayment penalty is the one that had
to be argued onto the table rather than beside the rate, and Regulation Z is the
argument: a penalty is permitted only on a fixed-rate qualified mortgage that is
not higher-priced, it is capped, it expires, and the creditor has to offer an
alternative loan WITHOUT one — an alternative that is a second product at a
second price. `amortization` is on this table too, spelled the way DU spells it
— `Fixed`, `AdjustableRate` — because a loan that pays interest only or balloons
is not one that amortizes fully, and two rows cannot disagree about one loan
when there is only one row.

A quoted file keeps the product it was quoted under, and keeps what that product
SAID. `loan_files.product_code` is a foreign key, `ON DELETE RESTRICT` and `ON
UPDATE RESTRICT`: a cascading rename would re-point every historical file at
whatever the new code means, which is the same loss as the delete with a
different spelling on it. Neither direction of the key stops the row being
rewritten in place, so a trigger does — flipping `prepayment_penalty` on
`CONF-30-FIXED` restates what every casefile ever sent under it told Desktop
Underwriter, with nothing appended and nothing to diff against, which is the
reason `connector_snapshots` and `decisions` are append-only in the first place.
A product on different terms is another row, and that sentence is now a
constraint rather than a note.

`loan_files.financed_unit_count` and `loan_files.property_attachment_type` are
the second, and both are RETRIEVED: they describe a building, the county holds
them, and screen 1's assessor lookup already went and asked. `POST
/files/:id/property-data` writes them off the connector result rather than off
anything the client sent, because a column DU reads should not be a value a
browser could have edited on its way past. A unit count outside one to four is
kept out of the column rather than clipped into it — five units is a commercial
loan, and a 4 standing in for a 12 is worse than a null.

`loan_files.property_estate_type` is the third, and it is ASKED, on screen 3, as
APP-028 with `source = borrower_input`. Nothing we retrieve carries it and the
document that settles it is the title commitment, which does not exist when a
casefile is submitted — so at submission the answer can only be the borrower's,
read off their contract or their deed. The question is worded as "Do you own the
land the home sits on?", because "fee simple or leasehold" is a question about
vocabulary.

All three columns are NULLABLE and nothing fills one in. A column with a
plausible default is how `borrowers.current_housing` came to say every borrower
rents, and undoing that took a migration, a route change and a screen. An
unknown value is null, the preflight refuses, and the refusal is ours instead of
Desktop Underwriter's.

And all three describe ONE building, so a moved address forgets all three.
`loan_files_building_follows_the_address` nulls whichever of them the same
statement did not restate: a borrower who corrects a mistyped address after the
lookup card rendered, or types a new-construction address no vendor holds a
record for, would otherwise submit a unit count, an attachment and an estate
that were true of the address they just left — none of them null, so nothing
downstream could tell. It is a trigger rather than a route guard for the reason
the unit-count CHECK is one: these arrive from a vendor as well as from a
person, and the screen that moves an address today is not the only door there
will ever be.

`buildingFacts` also refuses an attachment nobody mapped instead of writing
`undefined`, which Prisma reads as "leave this column alone". The fixture's two
values hold today; the field is the one a real Places, Smarty or ATTOM adapter
fills from parsed vendor JSON, and an unmapped string there would leave the
column holding the previous building's answer.

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

A third gap is newer, and the preflight is what found it: an `EMPLOYMENT` whose
status is Current must carry `EmploymentClassificationType`,
`EmploymentBorrowerSelfEmployedIndicator` and
`SpecialBorrowerEmployerRelationshipIndicator`, all three unconditional once the
status is Current, and `employments` holds a name, a position, a start date and
a status. Every shipped sample carries all three. So a casefile with a job on it
assembles and is refused, which is the gate working and the model being short
three columns.

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

**Item 8 — what we compute versus what DU computes.** Written down, typed, and
held by a test. The boundary has three tiers, and each claim is a file or a
corpus fact:

- **DU derives, we shadow.** Every one of the eight `Ratios` keys and the four
  `ReserveAssessment` keys. MISMO defines an element for most of them —
  `LTVRatioPercent`, `CombinedLTVRatioPercent`,
  `HomeEquityCombinedLTVRatioPercent`, `TotalDebtExpenseRatioPercent`,
  `HousingExpenseRatioPercent`, `TotalLiabilitiesMonthlyPaymentAmount`,
  `BorrowerQualifyingIncomeAmount`, `BorrowerReservesMonthlyPaymentCount` —
  and `DU_FORMATS` lists none of them, and none of the eighteen samples
  carries one. The `totalQualifyingIncome` continuance filter (INC-026) is
  ours; `buildCurrentIncome` sends every income item unfiltered and DU applies
  its own. The representative score, seasoning and the recommendation are
  shadow too: there is no credit data point in the Map at all, because DU
  pulls credit itself. `DU_DERIVED_FIGURES` in
  `packages/shared/src/types/decision.ts` is this tier as data, figure by
  figure, naming the Map data points DU derives each from, and
  `packages/du/src/__tests__/boundary.test.ts` fails the build the day a
  workbook upgrade lists one of the elements or drops one of the inputs.
- **We assert, DU consumes.** The inputs: `BaseLoanAmount`, `NoteRatePercent`,
  `PropertyEstimatedValueAmount`, each liability's payment and balance, each
  asset's value, each income item — all emitted today — and four
  lender-computed inputs the Map lists and the model does not yet emit, all in
  `du-not-round-tripped.txt`: the proposed `HOUSING_EXPENSE` rows (the
  components of `housingPitia`, estimated), `CashFromBorrowerAtClosingAmount`
  (`fundsToClose`), `HMDARateSpreadPercent` (`compliance.hpmlSpread`) and
  `QualifyingRatePercent`. Those four are item 4's to model.
- **Ours alone.** The compliance block, the pricing, the outcome, the
  adverse-action reasons and the derivations have no DU counterpart of any
  kind.

The two columns are typed at both ends and at the table. `recordDecision`
parses `ratios` and `reserves` through `@hm/shared/decision-figures` before the
row exists, `loadLoanFile` and the decision history parse them on the way out,
and `decisions_ratios_are_the_eight_figures` and
`decisions_reserves_are_the_four_figures` hold the same rule in Postgres —
exactly those keys, each a number or null (`satisfied` a boolean or null),
added `NOT VALID` so an old row cannot abort a deploy, to be validated once
every deployment's rows have been read back through the parser. `ReserveResult`
is gone; the engine returns `ReserveAssessment` itself, so there is one shape
with one owner.

Derived figures live on `decisions`, not as `DERIVED` facts. A decision is an
append-only snapshot with its own provenance columns — engine, version, inputs
by snapshot id — and a fact is an assertion about one subject. `FactSourceKind.DERIVED`
stays unused on purpose.

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

1. **The second borrower.** Named on screen 2, invited by a link whose token
   exists only in the email, claimed by a merge into the person's own Google
   sign-in, and walking their own half — screen 2, Section 5, their own bank,
   demographics, one signature — with every route resolving "the borrower" by
   the person asking. What is left is a co-borrower's reports reaching the
   engine (the compute-boundary item's to decide) and the sample household
   walking that same flow.
2. ~~**Write down the compute boundary** and type the two JSON columns.~~ Done:
   item 8 above, `DU_DERIVED_FIGURES`, the two CHECKs and the corpus test.
3. ~~**Writers for vesting and the non-borrower parties.**~~ Done: the review
   screen asks how title will read (L2.1, L2.4, and L2.2 on a refinance) and the
   signature is refused without an answer; every application is born with the
   origination company and the loan originator as deal-party rows from
   `ORIGINATION_COMPANY_*` / `LOAN_ORIGINATOR_*`, with `packages/du`
   placeholders standing in until the numbers exist, refused at assembly in
   production, and `/api/health` reporting which.
4. ~~**The modeled set and the derived inventory.**~~ Done: every table the
   corpus names is either on the wire or in `TABLES_OFF_THE_WIRE` with a
   reason, and `npm run du:verify` fails when the inventory and the code
   disagree.
5. ~~**The three employment columns.**~~ Done: the classification is derived
   and the two 1b answers are asked on the review screen (`APP-029`). A
   casefile carrying a job emits.
6. **The transport's credentials**, which is where the code stops. The
   exchange, the reader, the resubmission identifier and the configuration are
   built and tested against a stubbed server; what is missing is the endpoint,
   the credential and the seller/servicer number from the DU integration
   agreement — and a first real payload, which is what the reader is checked
   against next.

Step 1 waits on neither the EULA nor the credentials; step 6 is the credentials.

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
no shipped example to break the tie, and it is a question for Fannie Mae. The
emitter builds only the `ROLE` variant, and it is not a convention that the
others are left alone: every arc in the block gets its URI from one function,
and that function throws on a name the table marks disputed. Each construction
validates against the whole chain, so a guess would be accepted and misread
rather than rejected.

**And validating the XML proves much less than it looks like it does.** The XSD
enforces almost nothing about the relationship graph: a dangling `xlink:to`, a
duplicate label, an invented arcrole, duplicate sequence numbers, five
borrowers where DU allows four — and deleting the entire `RELATIONSHIPS`
container — all validate. Schema validity is necessary and nowhere near
sufficient, and DU's own rejection is the only other feedback loop. That is why
these invariants live in our database, where a second writer who never read the
design still cannot break them.
