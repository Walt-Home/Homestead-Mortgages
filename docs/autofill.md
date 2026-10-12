# Autofill: what the vendors can say, and how a suggestion reaches a screen

The design for prefilling onboarding answers from Stripe Identity, the Plaid
Check report, and the records a file already holds. Written 12 October 2026
against `b1eed8e`, after every question on the five screens was tried against
every source and each proposed inference was argued against from three sides:
is the signal really in the data we can obtain, is using it permitted by the
repo's rules and the law, and would a wrong prefill do more harm than asking.
Of 266 question-and-source pairs, 65 survived; 201 were ruled out. Read
`docs/decisions.md` for the rules this leans on and `docs/states.md` for the
tiers it may and may not write. **Update it in the commit that changes what it
says.**

## 1. The bottom line

- **What it is.** A pure function, `suggestionsFor()`, run by the API on every
  `GET /files/:id` over rows that already exist: the reader's own newest bank
  snapshot, the reader's own live facts, the file's columns. It hands back
  `suggestions[]` beside the file. Nothing is stored. A suggestion is a caption
  with a source tag, never a filled control and never a row.
- **What it may do.** Show a person their own prior statements, the three
  fields off their ID, what their bank found beside a figure they typed, and
  what the servicer's tape carried, each tagged with where it came from. The
  confirmation is the save the screen already makes, under the borrower's own
  principal, as SELF_ATTESTED.
- **What it may not do.** Touch a Section 5 or URLA 1b control (rule c, held
  by a type and a test); prefill a money figure; default an unanswered question
  (rule d); read a report across a file or across a person; write a fact at any
  tier. The questions bank data bears on hardest (housing, rent, borrowed
  funds, bankruptcy) are asked bare and compared afterwards, and a disagreement
  is a diary row for a human, never a changed answer.
- **The honest headline.** For a first-time applicant, almost nothing can be
  prefilled from Plaid, because the bank connects on screen 4 and the questions
  it bears on sit on screen 3; and almost nothing may be prefilled from Stripe
  beyond what screen 2 already takes. The value is in three other places: the
  returning person, whose own facts are already on the party; the refinance
  opened from a servicer's loan, whose tape is seeded and never shown; and the
  questions screen 4 does not ask yet (which accounts count, whose pay this is,
  what a deposit was, whether a job ended).
- **Where it lives.** `packages/shared/src/types/autofill.ts` (the type),
  `apps/api/src/services/autofill.ts` (the rules), `apps/web/src/components/Found.tsx`
  (the one rendering). Outcomes and disagreements are `FileEvent` rows, modeled
  on `property_correction_suggested`.
- **What it costs.** Three small migrations (a trigger on `facts`, a per-user
  prefill-session table, a purpose column on `connector_snapshots`), one extra
  `findMany` per file read, no new stage, no moved screen, no new fact writer.
  Deleting it is removing one service and leaving inert diary rows behind.
- **What Joe decides.** Section 8. First among them: the permissible purpose
  the bank route certifies to Plaid, because nothing bank-sourced ships until
  that is settled.

## 2. Found along the way

The matrix was built against the code as it stands, and the code has defects
an autofill would inherit. They are listed here because several are worth a
commit of their own before any suggestion is built.

| What                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A returning applicant skips screen 3.** The credit pull at the end of screen 2 advances the stage to `BANK`; the stage only moves forward; the declaration save's `DECLARATIONS` is then a no-op; resume goes by stage alone. Close the tab after screen 2 and you reopen on the bank screen with Section 5 unasked.                                                                    | `routes/connectors.ts:271`, `services/stage.ts`, `routes/declarations.ts:304`, `App.tsx:245`                                                           |
| **The bank report is ordered as a prequalification.** The adapter certifies `WRITTEN_INSTRUCTION_PREQUALIFICATION` to Plaid as the consumer-report purpose for a full application past APP-005. The code FCRA names for a credit transaction the consumer initiated is `EXTENSION_OF_CREDIT`. Counsel's call; see section 8.                                                              | `adapters/plaid.ts:411`, `:542`                                                                                                                        |
| **Stripe is never asked for the date of birth.** The adapter expands `verified_outputs`; `dob` is a second, sensitive expansion (`verified_outputs.dob`) that needs a restricted key. The decision that blames Stripe's test identity for returning no date of birth was probably reading the request shape. Unverified against the sandbox.                                              | `adapters/stripe-identity.ts:189`; `docs/decisions.md`, "Screen 2 under a hosted identity vendor"                                                      |
| **Manufactured answers.** Screen 1 starts on purchase, primary residence, single family. Screen 2 starts on `us_citizen` and `unmarried`, pre-ticks E-SIGN, sends language `en` (so `borrower_lep` can never be true) and `isMilitary` false, which nothing asks. The first-time-buyer flag is `true` on a file with no county record, and both review screens re-send it with `?? true`. | `PropertyLoanPage.tsx:218-222`, `IdentityPage.tsx:201-212`, `:420-426`, `routes/files.ts:399-409`, `ReviewPage.tsx:320`, `CoBorrowerReviewPage.tsx:90` |
| **Nothing asks for a non-borrowing spouse's name.** APP-015 reads `married && !nonBorrowingSpouseName`, so every married borrower on a community-property property fails it.                                                                                                                                                                                                              | `packages/requirements/src/satisfaction.ts:200`                                                                                                        |
| **A co-borrower is never asked URLA 1b or their income.** Their review page has no "Your work" block; their stated income is "asked where their own half asks it", and nothing does. Dependents are asked of nobody.                                                                                                                                                                      | `CoBorrowerReviewPage.tsx`, `routes/files.ts:494-503`                                                                                                  |
| **What came off the ID is recorded as typed.** `assertFacts` writes SELF_ATTESTED at ATTESTED for everything screen 2 posts, so the document's name, date of birth and address carry the borrower's principal and no trace of the document. The adoption event in section 5 is what fixes that.                                                                                           | `services/party.ts:260`                                                                                                                                |
| **The tier trigger keys on the principal's kind.** `facts_ai_may_not_verify` refuses only an `AI_AGENT` principal, so a SERVICE principal writing `DERIVED` at `VERIFIED` passes today. Nothing does; the first thing that does must not.                                                                                                                                                 | migration `20260903170000`, `facts.test.ts`                                                                                                            |
| **A stale comment says a co-borrower cannot link a bank.** The unique index is on `(loanFileId, kind, partyId)`; they can.                                                                                                                                                                                                                                                                | `routes/connectors.ts:284-286`, `schema.prisma` `ConnectorLink`                                                                                        |
| **The ID prefill locks the address and splits the name.** The document address is posted verbatim with no edit path but "Scan again"; `line2` is dropped; a joined `documentName` is split on the first space, so a middle name lands in the surname; a passport (no address) leaves Continue disabled.                                                                                   | `IdentityPage.tsx:312`, `:360`, `:398-403`, `:646-652`                                                                                                 |

## 3. What each source can say

One row per question and source that survived. **Mode**: `prefill_confirm`
(seeded, the person confirms or edits), `suggest` (a caption beside an empty
or answered control, one tap at most, never filled), `check` (compared at the
pull, an event for a human, nothing rendered to the borrower), `read-back`
(shown with its tag above the signature). **Direction** is what the signal may
argue for; a clean report argues for nothing. **When** says which increment.

| Question                                             | Source                                                                      | Mode                                                                                                                                                                          | Direction                      | When                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| **Offer card and screen 1**                          |                                                                             |                                                                                                                                                                               |                                |                                                           |
| Stated monthly income                                | the person's own prior `monthly_income` fact                                | suggest, one tap: "Last time you told us $X (March 2026)"                                                                                                                     | the prior figure               | returning person · inc. 1                                 |
| Value, existing loan                                 | the servicer's tape, only the values the tape carried                       | read-back on screen 5, "From your servicer's records"; occupancy and property type are never read back (the mapper defaults them)                                             | the tape's values              | refinance from an offer · inc. 1                          |
| Purchase price or value                              | the AVM                                                                     | suggest; refinance only, or after a purchase price is typed; low confidence suppressed                                                                                        | the model's figure             | during screen 1 · inc. 1                                  |
| Stated vs found income                               | Plaid streams, the reader's own                                             | check at the pull (INC-009's band); read-back on screen 5                                                                                                                     | either                         | inc. 2                                                    |
| **Screen 2**                                         |                                                                             |                                                                                                                                                                               |                                |                                                           |
| Legal name                                           | Stripe `verified_outputs.first_name`, `last_name`                           | prefill_confirm, editable (a license lags a marriage); two fields, never a joined string                                                                                      | the document's                 | today, fixed in inc. 1                                    |
| Date of birth                                        | Stripe `verified_outputs.dob`                                               | prefill_confirm; typed only when the document carried none                                                                                                                    | the document's                 | after the expansion is proven in the sandbox              |
| Current address                                      | Stripe `verified_outputs.address` with `line2`                              | prefill_confirm behind "Is this still where you live?"; "I live somewhere else now" reveals the inputs; a passport goes to typed entry                                        | the document's as a default    | inc. 1                                                    |
| Phone, current address                               | the person's own prior facts                                                | prefill_confirm on a fresh file, "What you told us before"; the address only when no document was read                                                                        | their own                      | returning person · inc. 1                                 |
| Applying with someone                                | county owner of record with two names, refinance only                       | suggest as a question; no name prefilled                                                                                                                                      | a question only                | inc. 2                                                    |
| Name, address, phone, email                          | Plaid `owners[]` (untyped today)                                            | check against the person's own attested facts; the result recorded, never the value                                                                                           | none                           | inc. 2, after a sandbox call settles `owners[]`           |
| Name, date of birth                                  | the tape's PARTNER_SHARED facts on a refinance                              | check after the scan (`name_differs_from_servicer`)                                                                                                                           | none                           | inc. 2                                                    |
| Military service                                     | asked blank; DFAS or VA streams                                             | check for the underwriter; never a value (DFAS pays civilians too)                                                                                                            | yes only                       | inc. 2                                                    |
| Co-borrower's screen 2                               | their own Stripe session, keyed on their user                               | prefill_confirm, in their session only                                                                                                                                        | their document's               | inc. 1                                                    |
| Co-borrower's name                                   | the applicant's spelling vs their document                                  | check (`claim_name_differs`); adopting a session whose document names somebody else is refused                                                                                | none                           | inc. 1                                                    |
| **Screen 3**                                         |                                                                             |                                                                                                                                                                               |                                |                                                           |
| Monthly rent                                         | Plaid rent run, category-gated                                              | suggest under the rent input on a revisit only, only after Rent is chosen: "Your bank shows $2,150 a month to OAKRIDGE PROPERTY MGMT"; a typed amount outside ±25% is a check | a positive amount              | caption inc. 1; check inc. 2                              |
| Rent and basis                                       | the person's own prior `du_residences` at the same address                  | prefill_confirm, dated                                                                                                                                                        | their own                      | second application · inc. 2                               |
| Basis                                                | county owner of record, refinance; a mortgage tradeline on their own credit | check (owner matches and they said Rent; Rent beside a live mortgage)                                                                                                         | none                           | inc. 2; credit is fixture-only today                      |
| Months at address                                    | the rent run's length; `lastSale.soldOn`; the tape's origination date       | check (typed months below a confirmed run, or a deed date beside Own)                                                                                                         | none                           | inc. 2                                                    |
| Prior residence                                      | the person's own prior file                                                 | prefill_confirm                                                                                                                                                               | their own                      | second application · inc. 2                               |
| Section 5 C, borrowed funds                          | a lender disbursement in their own report; a new tradeline                  | check only, through AST-005's sourcing answer: an event exists only when the borrower's own explanation says "a loan" and C says No                                           | yes only                       | inc. 2                                                    |
| Co-borrower's Section 5                              | their own reports only                                                      | check; nothing beside the question; evidence shown only after a contradicting answer, with an explanation box                                                                 | yes only                       | inc. 2; credit is fixture-only                            |
| Co-borrower's intent to occupy                       | the applicant's checkbox vs their own A                                     | check (`occupancy_role_differs`); the role follows their own answer at their save                                                                                             | either                         | inc. 2                                                    |
| **Screen 4**                                         |                                                                             |                                                                                                                                                                               |                                |                                                           |
| Which accounts count                                 | the report's account list                                                   | prefill_confirm of the list; the election is three-valued (`du_assets.used_for_qualifying` NULL until acted on), nothing pre-checked                                          | the list only                  | inc. 2 (a column; changes what reserves and AST-008 read) |
| Is the borrower an owner                             | `owners[]` vs their own attested name                                       | check; a match is ESTIMATED at most                                                                                                                                           | none                           | inc. 2                                                    |
| Retirement liquidity                                 | the balance as a ceiling                                                    | suggest, only for an elected account; no retirement account arrives until `include_investments` is sent                                                                       | the ceiling only               | inc. 2                                                    |
| Employer                                             | `income_provider.name`, the deposit description                             | suggest beside an empty employer input, "From your bank deposits"; a payroll processor's name seeds nothing                                                                   | a payer name only              | inc. 2                                                    |
| Large deposits, gifts, borrowed funds, earnest money | the report's lines, `transaction_id`                                        | suggest a kind with the line beside it, nothing pre-selected; own-transfer pairing shown as evidence                                                                          | a candidate kind only          | inc. 2 (`deposit_explanations`, a table)                  |
| Rent history vs declared                             | `identifiedMonthlyRent` vs the declared basis                               | check (`rent_vs_declared`); Own beside a rent run writes nothing (HOA payees match `RENT_WORDS`)                                                                              | rent-direction only            | inc. 2, after category gating                             |
| Found but not counted                                | DISABILITY and GOVERNMENT_DERIVED streams                                   | suggest "which is it", behind the Reg B 1002.5(d)(2) sentence                                                                                                                 | existence only                 | inc. 2                                                    |
| A job that ended                                     | an INACTIVE stream's `end_date`                                             | suggest, blank yes/no: "Deposits from {payer} stopped in {month}. Did that job end?"                                                                                          | ended, never unemployed        | inc. 2 (the adapter keeps INACTIVE streams)               |
| The identity we send Plaid                           | `/user/create` acceptance                                                   | a refusal names the field, back onto screen 2 (exists: `BANK_IDENTITY_REJECTED`)                                                                                              | none                           | today                                                     |
| Payroll branch employer                              | the bank-inferred employer                                                  | prefill_confirm of the search term                                                                                                                                            | a name only                    | fixture only, until a payroll vendor exists               |
| **Screen 5**                                         |                                                                             |                                                                                                                                                                               |                                |                                                           |
| Stated vs found income                               | the two figures                                                             | read-back: "You told us $A a month; your bank found about $B"; no inline edit                                                                                                 | both                           | inc. 1                                                    |
| The 1b job list                                      | bank-inferred `employments`                                                 | prefill_confirm of the subject; "This is not my employer" records a correction and the typed name                                                                             | the vendor's name as a default | today; correction inc. 1                                  |
| 1b party to transaction                              | an employer name equal to a `du_deal_parties` name                          | check (APP-029); never a surname match                                                                                                                                        | yes only                       | inc. 2                                                    |
| Title held today                                     | county owner of record; the tape's name                                     | check; the field is asked bare                                                                                                                                                | none                           | inc. 2                                                    |
| Demographics on a revisit                            | the reader's own stored `demographics`                                      | prefill_confirm; the one lawful prefill there, never from a prior application                                                                                                 | their own                      | inc. 1                                                    |
| Co-borrower's vesting                                | their verified name in the applicant's default sentence                     | read-back on "Your part"; a Proposed row built from a spelling their document contradicts is marked stale and the signature refuses (`VESTING_REQUIRED`) until re-confirmed   | none                           | inc. 1                                                    |
| Explanation for a derogatory account                 | their own credit report                                                     | suggest the subject above the attach control, per party                                                                                                                       | the subject only               | fixture only, until a credit vendor exists                |

**Ruled out, and the strongest reason for each.** The service has no key for
any of these, and the key-overlap test fails if one is added.

- Any Section 5 or URLA 1b answer, from any source. Rule c: the trigger
  `du_declarations_are_self_attested` refuses every writer but the declaring
  person and staff, and `declarations.test.ts` holds the conditions null
  against everything retrieved.
- Occupancy or intent to occupy, from an ID address, a bank owner address, a
  county record or the tape. `docs/states.md`: occupancy may not be defaulted.
  Stripe's terms bar a document output from being a factor in eligibility.
- First-time buyer from the county record keyed on the ID address: a person
  lookup wearing an address key (rule f), and a name match that calls an adult
  child at a parent's house an owner.
- Citizenship, marital status, preferred language, dependents, military
  service as a value. Reg B 1002.5; an issuing country is a national-origin
  proxy; DFAS pays civilians. The shipped defaults are the defect, not a
  precedent.
- Demographics from anything but the applicant's own control. HMDA Appendix B
  allows exactly two bases, the applicant's answer or in-person observation;
  an internet application has only the first. Stripe's `sex` is never
  expanded.
- Every credit-report and lien-search row on a real file: there is no credit
  vendor (the fixture answers the persona's report on every real file), and
  the lien search is APN-keyed with no debtor.
- Payee-word classes for courts, trustees, law firms, DFAS, HOA and mortgage
  servicers. Each reads child support, trust distributions, divorce fees,
  civilian pay or a relative's mortgage as the borrower's, and the flag rate
  tracks protected class.
- An existing mortgage balance or financed-property count from Plaid loan
  accounts. Whether a Check base report returns loan accounts is unverified,
  and a loan on a joint item may be the spouse's.
- Any money figure prefilled into a field. A figure accepted with Next is a
  statement nobody read, and it destroys the independence the Selling Guide's
  income resubmission rule and the rent-history check rely on.
- Any consent pre-ticked, and anything about person B derived from person A's
  report, and anything carried from a prior file's report into a new one. New
  transaction, new purpose, new report.

## 4. The rules it is built under

- **Rule b.** Absence is never No. A suggestion exists only for a positive
  signal; a snapshot with no recorded purpose is refused, not trusted.
- **Rule c.** Declarations and 1b are asked. `SuggestionKey` cannot name a
  `du_declarations` field, a demographics field, occupancy, citizenship,
  marital status, military service or first-time buyer; a test enumerates the
  keys against `packages/shared/src/types/declaration.ts` and fails on overlap.
- **Rule d.** Null means nobody asked. A `prefill_confirm` is emitted only
  while the target is unanswered, and the manufactured answers in section 2
  go first.
- **Rule e.** Every suggestion carries `source`, `evidence` and
  `evidenceTier`, and the tier union is `attested | estimated`: the type
  cannot express a tier above it. The written row is always the borrower's
  own SELF_ATTESTED one through `assertFacts`. A new trigger makes the cap a
  database rule for whoever writes the first DERIVED fact later.
- **Rule f.** Nothing is pulled before APP-005. The service pulls nothing: it
  reads snapshots already written under a token. The ID prefill route and the
  e-sign adapter stay the two unguarded person-keyed calls.
- **Rule g.** The frame is free and stays: no stage added, no screen moved.
  The one stage change is the fix in section 6.
- **Three-valued progress and recorded derivations.** The engine reads nothing
  from a suggestion or an autofill event, held by a repo-walking test.
- **Who asserts is who spoke.** An outcome event's actor is `borrower`; a
  pull-time check's is `system`; the rule version rides in the payload.
- **Permissible purpose.** A bank-sourced rule runs only over a snapshot whose
  recorded purpose is `EXTENSION_OF_CREDIT`, which is why nothing bank-sourced
  ships until section 8's first question is answered.

## 5. The shape

### The record

`packages/shared/src/types/autofill.ts`, exported from `types/index.ts`:

```ts
export const AUTOFILL_RULES = "hm.autofill.v1";

export interface Suggestion {
  key: SuggestionKey; // closed union, tested against Section 5
  screen: "property" | "identity" | "declarations" | "review";
  mode: "prefill_confirm" | "suggest";
  target:
    | { kind: "fact"; predicate: "phone" | "current_address" | "monthly_income" }
    | { kind: "residence"; residencyType: "Current"; field: "monthlyRent" }
    | { kind: "employment"; employmentId: string; field: "employerName" }
    | {
        kind: "file";
        column: "value_or_price" | "existing_balance" | "existing_rate" | "existing_payment";
      }
    | { kind: "readback"; of: "stated_vs_found_income" };
  value: unknown;
  source: "identity_document" | "bank" | "prior_statement" | "servicer_record" | "county_record";
  tag:
    | "From your ID"
    | "From your bank activity"
    | "What you told us before"
    | "From your servicer's records"
    | "From the county record";
  basis: string; // one sentence a person can read
  evidence: { snapshotId: string | null; verificationId?: string; retrievedAt: string };
  evidenceTier: "attested" | "estimated"; // the evidence's tier; the written row is always ATTESTED
  partyId: string; // the reader's; never anyone else's
}
```

The file target names no `occupancy` and no `property_type`: on a refinance
the seed defaults both when the tape is silent, and a default read back as
"From your servicer's records" would be a manufactured answer wearing a tag.
The refinance seed should write them as null when the tape and the loan are
silent, and ask occupancy on that file's screen 3, with the tape value as a
check.

### Where it is computed

`apps/api/src/services/autofill.ts` exports `suggestionsFor(input)`, pure: no
database, no clock. Input: `{ file, partyId, own: { assets, credit,
snapshotIds } | null, priorFacts, dismissed: Set<"key@snapshotId">, purposes:
Map<snapshotId, string> }`. Rules are named functions returning zero or one
suggestion each: `priorPhone`, `priorCurrentAddress`, `priorStatedIncome`,
`foundRent`, `foundIncomeReadBack`, `servicerSeededFields`, `jobSubject`,
`avmHint`. Refusals live in the service: no target that is a declaration slot;
no `monthlyRent` while the basis is not Rent; a dismissed `key@snapshotId`
dropped, the same key on a newer snapshot not; nothing from a bank snapshot
whose purpose is not `EXTENSION_OF_CREDIT`; nothing from a report carrying
`USER_FRAUD_ALERT`.

`GET /files/:id` assembles the inputs after `you`, `yours` and `own` are known
and returns `suggestions` beside `file`. **`own` is the reader's own snapshot
for the owner too**, through `ownReportsFor`: today the route computes it only
for a member, and the file-level `assets` is Borrower 1's, who need not be the
owner. A demo reader gets `[]`. `?debug=1` changes nothing.

### Where it is stored

Nowhere. The decision to write into `docs/decisions.md` is "A suggestion is
computed, never stored", and the reason is the ledger's reader: `liveFact`
picks the newest live row and reads neither `sourceKind` nor `confidence`, so
a stored suggestion that was a fact would become the live value and
`pinTridPieces` would pin it. A re-pull supersedes by construction; a
confirmed suggestion disappears by construction, because its target now holds
the borrower's value.

Three things are stored, none of them a suggestion:

- `connector_snapshots.permissible_purpose`: what the bank route certified at
  order time, returned by the adapter on the result and written from that,
  never from a route constant. The service refuses null.
- `identity_prefill_sessions (loan_file_id, user_id, verification_id,
created_at, UNIQUE (loan_file_id, user_id))`, replacing
  `loan_files.identity_prefill_verification_id` for everybody. Keyed on the
  signed-in user because no party exists at the top of screen 2, and the
  applicant's two tabs overwrite each other today as much as a co-borrower's
  scan does.
- A trigger `facts_inference_may_not_verify` BEFORE INSERT ON `facts`, keyed
  on `source_kind`: `DERIVED` above `ESTIMATED` raises; `AI_INFERRED` above
  `INFERRED` raises.

### How a screen reads it

`apps/web/src/lib/autofill.ts`: `suggestionsOn(data, screen)`,
`suggestionFor(data, key)`, `outcomesFrom(seen, final)`. One component,
`Found.tsx`, renders `{basis} · {tag}` as a `.super-source` line, a new
neutral class in `packages/brand` (color stays reserved for outcome states),
with two quiet links, "Use it" (only for `prefill_confirm` and the one-tap
income) and a dismiss. Never a control, never a pre-selected option. The
sessionStorage draft never carries one.

### How a confirmation is written

The save the screen already makes. `POST /files/:id/borrowers`,
`/declaration`, `/employment-declarations`, `/vesting`, `POST /files` and
`PATCH /files/:id` accept an optional body field:

```ts
autofill?: Array<{ key: SuggestionKey; snapshotId: string | null;
                   outcome: "accepted" | "corrected" | "dismissed";
                   proposed?: unknown; given?: unknown }>  // max 20
```

After the existing write succeeds, one `recordEvent` per entry: kind
`autofill_${outcome}`, actor `borrower`, `requirementId` the question's own,
payload `{ key, snapshotId, partyId, proposed, given, rules }`. The facts are
written by `assertFacts` under the requester's principal exactly as today. A
body with `autofill` and no matching save is still just a save. The schema
comment on `FileEvent.requirementId` changes from "advanced" to "bears on",
which is the sense `property_correction_suggested` already uses.

On adoption of an ID session, `identity_document_read { verificationId,
partyId, fields, documentObservedAt: session.created }` is written. It is what
says which fields came off the document and when Stripe read them, since the
facts themselves cannot.

A `shown` event, one `autofill_shown` per `(key, snapshotId, partyId)`, is
written by `GET /files/:id` the first time it serves that suggestion. It is
the one write on a read path, and it exists so fair-lending monitoring can
tell "never rendered" from "rendered and abandoned". Joe can veto it.

### How a disagreement is recorded

Two kinds, two actors, two increments.

- **The borrower's**, actor `borrower`, increment 1: `autofill_corrected` with
  `proposed` and `given`, written by the save. Never refuses the answer, never
  lowers a tier, never blocks.
- **The system's**, actor `system`, increment 2: written inside the bank
  route's transaction after `reconcileAssets` by `services/autofill-checks.ts`.
  `rent_vs_declared`, `stated_vs_found_income`, `employer_vs_deal_party`, each
  reading the subject party's rows only. `USER_FRAUD_ALERT` on the report
  writes `identity_review_needed` and runs no rule over that report.
- **The reader lands before the first system event is written.** An event
  nobody reads is not an underwriting control, and today no console page opens
  a borrower-app loan file: the console's loan page reads the servicing app's
  loans. So increment 2 starts with `routes/console-autofill.ts` at
  `/console/hm/files/:id/autofill` (staff session, redacted by
  `payload.partyId`, the `autofill_resolved` write) and a console page for our
  files. Increment 1 writes no system event.

The engine reads none of this. `packages/requirements`, `packages/underwriting`
and `services/decide.ts` import no autofill module and touch no `fileEvent`; a
repo-walking test holds it, and walks `services/refi-analyst.ts` too, which
reads review facts and no file events.

### The co-borrower boundary

A suggestion's `partyId` is the reader's, computed from the reader's own
snapshot and the reader's own facts. A member's read goes through `memberView`
and can carry nothing derived from the applicant's report. `income_sources`
carry `party_id` in the table but not on the domain type; the type gains
`partyId`, `memberView` filters by it, and the stated-vs-found read-back runs
for both halves. `FileEvent` has no party column, so every autofill payload
carries `partyId` and every reader redacts by it.

### Re-pulls and revisits

A re-pull writes a new snapshot; the next `GET` computes from it, and a
dismissal keyed on the old snapshot no longer applies. A revisit reads the
stored answer into the control and the suggestion beside it; the control is
never filled from the suggestion. A Check report lives 24 hours and
`recordSnapshot` never writes `raw`; the basis sentence is computed from the
mapped payload, which persists. A rule that needs a field the mapper drops
cannot be back-filled, which is why typing `owners[]`, `credit_category`,
`merchant_name`, `transaction_id` and `pending` comes before any rule that
names them.

## 6. The timing problem on screen 3, and the answer

The bank report lands on screen 4, one screen after the residence questions
and Section 5 were answered. Everything Plaid can say about screen 3 is
therefore a retrospective check, unless screen 3 moves behind the bank.

**Nothing moves.** Screen 3 asks every question bare, as today. At the pull
the API compares the stored residence and the stated income to the report and
writes an event for a human. On a later visit the rent field shows the stored
answer with the found figure under it. Section 5 is never beside bank data,
which is the configuration `buildDeclarations` was removed from.

Why not reorder, in three lines: every row a reorder would help was argued
down to a check (basis, months, borrowed funds), leaving one caption; the
reorder gates APP-026, a universal borrower input, behind the step with the
highest abandonment; and a borrower who declines Plaid would answer the same
block cold while a connected one got help, an asymmetry not worth creating for
one caption.

**What does move is a stage, and it is a fix.** The credit route advances to
`DECLARATIONS` instead of `BANK`; the declaration route advances to `BANK`;
the bank route keeps `PAYROLL`, which already resumes to the review screen.
`FLOW_STAGES`, `SCREENS` and the prose counts are untouched.

## 7. The order of work

Each step is one or two commits and names the test that holds it. Steps 0 to
3 stand on their own and are worth doing whether or not the rest follows.

0. **Remove every manufactured answer, in one commit.** Delete the four
   `useState` defaults on screens 1 and 2 and the two zod `.default()`s;
   render citizenship and marital status on "Choose one"; start "They will
   live in the home" unanswered; open E-SIGN unchecked; ask preferred language,
   military service and a non-borrowing spouse's name (married, community
   property state), or leave them null and say so in `docs/du-readiness.md`;
   drop `?? true` from both review saves; delete the county derivation of
   `first_time_homebuyer` on screen 2 and let APP-021 read the party's own
   `homeowner_past_three_years`. A real-vendor file's decision moves to
   `referred` until APP-021 has an asked input, which is the truth. Tests: a
   `/borrowers` save without a field writes no fact for it; a stored null
   stays null across both review saves.
1. **The stage fix.** `connectors.ts:271` to `DECLARATIONS`,
   `declarations.ts:304` to `BANK`. Test: a borrower who finished screen 2
   resumes on screen 3, against a real Postgres.
2. **The trigger.** `facts_inference_may_not_verify` keyed on `source_kind`.
   Test: `facts.test.ts` gains SERVICE + DERIVED at VERIFIED refused, at
   ESTIMATED accepted, SERVICE + VENDOR_RETRIEVED at VERIFIED still accepted,
   AI_AGENT + AI_INFERRED at ESTIMATED refused.
3. **The ID read, done right.** First a sandbox experiment: add
   `expand[]=verified_outputs.dob` under a restricted key
   (`STRIPE_IDENTITY_RESULTS_KEY`, `rk_test_` or `rk_live_`, refused the way
   `stripe-invoicing.ts` refuses a live key) and record in `docs/decisions.md`
   what comes back. Then: `identity_prefill_sessions`; the adapter carries
   `documentFirstName`, `documentLastName`, `address.line2` and
   `documentObservedAt`; adoption refuses a session whose document name does
   not match the row being adopted onto and records `identity_document_read`;
   screen 2 stops splitting the joined name, posts `line2`, offers "Is this
   still where you live?" with an edit path, and sends a passport holder to
   typed entry. Tests: two users mid-scan on one file; the mismatch refusal;
   the request string pins both expansions; the mapped fields are exactly
   first, last, dob, address with line2, created.
4. **The purpose, threaded once.** The bank route sets `permissiblePurpose`
   on the adapter at Link-token time, `EXTENSION_OF_CREDIT` for a file past
   APP-005 once Joe says so; the adapter returns it on the result;
   `recordSnapshot` writes the returned value. Adapter hygiene in the same
   step: `warnings[]` typed; employers built from EARNED_INCOME streams only
   (a VA stream becomes an employer today); `identifiedMonthlyRent` set only
   when the run's category is `RENT_AND_UTILITIES_RENT` (`RENT_WORDS` matches
   WASTE MANAGEMENT and HOA managers); pending lines excluded; `owners[]`,
   `ownership_type`, `credit_category`, `merchant_name`, `transaction_id`,
   `days_available` typed. Test: `plaid.test.ts` over the three sandbox
   fixtures, one case per rule, and a snapshot row carrying the purpose.
5. **The type and the service.** `autofill.ts` and `autofill-keys.test.ts`
   (no key names a Section 5 field, a demographics field, occupancy, property
   type, citizenship, marital status, military service or first-time buyer;
   `evidenceTier` is exactly `{attested, estimated}`). A pure `autofill.test.ts`:
   no snapshots and no prior facts yield `[]`; a Rent residence with an
   answered rent and a category-gated run yields one caption and no prefill;
   an unanswered basis yields nothing; a dismissed `key@snapshotId` is dropped
   and the same key on a newer snapshot is not; a member's input built from
   `own` yields nothing from `file.assets`; a returning party with no row
   yields prior-statement suggestions and the same party with a row yields
   none; a snapshot whose purpose is not `EXTENSION_OF_CREDIT` yields nothing
   bank-sourced.
6. **The route.** `GET /files/:id` attaches `suggestions`, computes `own` for
   the owner too, reads `autofill_dismissed` for the filter, writes
   `autofill_shown` once per key and snapshot; `IncomeSource` gains `partyId`
   and `memberView` filters by it. Test, real Postgres: an owner whose Borrower
   1 was replaced reads suggestions from their own snapshot and none naming
   the other party's; a claimed co-borrower reads only theirs; a demo file
   reads `[]`; a second GET writes no second `autofill_shown`.
7. **The saves.** The six routes accept `autofill[]` (zod, max 20, an unknown
   key is a 400) and write the events. Test: the facts and the
   `du_residences` row written are byte-identical with and without the array;
   exactly one `autofill_corrected` with the requester's `partyId`.
8. **The screens.** `Found.tsx` and `.super-source`; the returning person's
   phone with a Found line; screen 1's one-tap income and the refinance-only
   AVM hint; screen 3's revisit caption under the rent input only when the
   basis is Rent, with "Not my rent"; screen 5's two read-back kinds, "This
   is not my employer" with "Who is your employer?", the stale-vesting refusal,
   and demographics seeded from the reader's own stored row on a revisit.
   Tests: no Found on a first pass of screen 3 and none under any
   `YesNoQuestion`; a co-borrower is seeded nothing from a prior statement;
   the correction sends `proposed` and `given`; the servicer lines render only
   with `prior_loan_id` and only for values the tape carried.
9. **The engine-blind tests and the docs.** `engine-reads-nothing.test.ts`
   walks the requirements and underwriting packages, `services/decide.ts` and
   `services/refi-analyst.ts` for `autofill` and `fileEvent`; `LoanFile` has
   no `suggestions` key; the decision is byte-identical with and without
   suggestion inputs; no production path writes a fact with a `sourceKind`
   other than SELF_ATTESTED or PARTNER_SHARED on a TRID predicate.
   `docs/decisions.md` gains "A suggestion is computed, never stored";
   `docs/states.md` one line under the tier table; `docs/testing.md` where a
   tester sees a caption on staging.
10. **The gate on increment 2.** One scripted sandbox call against a retained
    Check base report to settle `owners[]` and `ownership_type`, whether loan
    accounts arrive, and whether `include_investments` and `require_identity`
    can be said at Link time; the answer goes in `docs/decisions.md` before any
    rule names them. Then, as its own design: the console reader and the
    system checks; `du_assets.used_for_qualifying` (nullable, with
    `elected_by_principal_id` and `elected_at`) and the accounts list on
    screen 4, read as "cannot know yet" when NULL; `deposit_explanations`; a
    borrower-side retire path for a disowned employer; INACTIVE streams kept
    for "did that job end"; the co-borrower's own "Your work" and income
    question; the Reg B 1002.5(d)(2) sentence before any "should this count".

## 8. Open questions for Joe

- **Plaid purpose.** May the bank route certify `EXTENSION_OF_CREDIT` for a
  file past APP-005? Lean: yes, it is the code FCRA 604(a)(3)(A) names for a
  credit transaction the consumer initiated, and prequalification was a
  placeholder; counsel confirms, and until then nothing bank-sourced reaches
  staging, which holds a real book.
- **The `shown` event.** Keep the bounded `autofill_shown` or count outcomes
  only? Lean: keep it; it is the only way "who was offered what" is a query,
  and the cost is one insert per distinct suggestion.
- **Step 0's asks.** Ask citizenship, marital status, language, military
  service and the spouse's name blank now, or leave them null and let the
  requirements say so? Lean: ask; each is a sheet requirement, and a null that
  blocks a decision is better than a default that passes one, but it is five
  more controls on screen 2.
- **A disowned employer.** Record the correction and leave the vendor's string
  as the 1b subject with the typed name beside it, or hide the two 1b
  questions for a disowned row? Lean: hide them, which needs the retire column
  in increment 2; until then the heading reads both names.
- **The servicer-seeded fields.** Read back on screen 5 only, or also a
  confirm card on screen 2 of a refinance? Lean: screen 5 only; the signature
  covers them, and the LTV runs on them either way. Revisit if the read-back
  shows corrections.
- **Retention.** `connector_snapshots` payloads carrying a consumer report
  persist indefinitely and would now feed captions on revisits; Stripe
  sessions are never redacted. Lean: name a period (the decision plus the FCRA
  disposal window) and a job, as its own decision, before production use of
  anything in step 8.
