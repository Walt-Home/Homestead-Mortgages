# Homestead Mortgages

Mortgage underwriting onboarding, built against Drew's V1 flow sheet. Read
`docs/requirements.md` before touching anything in `packages/requirements`, and
`docs/decisions.md` before trusting any number the engine produces.

`docs/states.md` is the model for user states and account states — what a
person is trying to do, and where it stands. It covers both what is built today
and the Party / Application / Loan model replacing it, and marks which is which.
Read it before adding anything that looks like a status.

`docs/du-graph.md` is what a DU submission actually is — a graph of
`RELATIONSHIP` arcs between labelled containers, not a nested document. Read it
before modelling anything a submission has to carry, because it is the reason
ownership here is join tables rather than nesting. `docs/du-generation.md` is
where the six generated DU tables come from and what CI checks about them; read
it before touching `scripts/build-du.mjs` or anything under
`packages/du/src/generated`, which is never hand-edited.

`docs/du-readiness.md` is where the Desktop Underwriter work stands, item by
item, against the readiness audit. Read it before building anything a DU
submission would have to carry — borrowers, assets, liabilities, declarations,
employers, or anything that computes a ratio. **Update it in the commit that
changes what it says**, the same way `docs/decisions.md` is kept: a status page
that lags the code is worse than none, because it gets believed.

## The shape

npm workspaces + Turbo, following the HMX pattern. Express 5 API, React 19 SPA,
Prisma against Postgres, Terraform for the GCP pieces this repo owns.

```
data/v1-build.csv          source of truth for WHAT must be satisfied
packages/requirements      the 85 requirements, executable
packages/underwriting      the shadow AUS
packages/connectors        five ports, fixture adapters, the authorization guard
packages/shared            domain types; LoanFile is the object everything reads
packages/brand             design tokens, Tailwind preset, .super-* components
packages/db                Prisma
apps/api                   Express 5
apps/web                   React + Vite
infra                      Terraform
```

## The borrower flow is FIVE screens; the engine has ten

The UI was rebuilt from nine screens to four, and a fifth was added when
somebody finally had to be asked URLA Section 5 and where they live. The engine
tracks eleven `FlowStage` values and evaluates 85 requirements.

```
1 Property   →  2 About you  →  3 A few questions  →  4 Your bank  →  5 Review
   property_loan   identity+credit   declarations        bank          decision
```

Screen 3 is a STEP and not a branch, and that is forced rather than chosen:
`branchesFor()` renders work the engine reports as outstanding, and the engine
cannot report work that has no requirement. So the questions are seven rows in
`data/v1-build.csv` with `source = borrower_input`, they have a `FlowStage` of
their own, and a borrower who stops halfway resumes on them. The seventh is the
odd one out: it asks about the property rather than the person, because whether
the land comes with the house is the one thing on that screen the county cannot
tell us and Desktop Underwriter requires anyway.

`apps/web/src/lib/flow.ts` is the only place that knows both vocabularies. It
holds `SCREENS` (five), `STAGE_TO_SCREEN` (eleven → five) and `branchesFor()`.

**Payroll, IRS and document upload are branches, not steps.** They render only
when the engine reports outstanding work whose `source` is one the borrower
must personally supply — `borrower_input`, `document_upload`, `connect_payroll`.
`connect_irs` and `esign` are deliberately excluded: those are ours to do, and
treating them as triggers sent every clean W-2 borrower down a tax-transcript
branch to authorize something screen 5 was about to ask them to sign anyway.

**The requirement rail is gone.** Everything it showed — counts, requirement
ids, severities, blocked roots — now lives behind `?debug=1` on any file URL.
Nothing in the borrower flow renders a req_id. Keep it that way.

**Four new connector ports**, fixture-only, same pattern as the original five:
`propertyData` (autocomplete, assessor, AVM, flood), `screening` (OFAC),
`liens`, `identity` (ID scan). The guard split is the thing to preserve:
**anything keyed on an address is unguarded, anything keyed on a person is
not.** Screen 1 runs before APP-005 exists, so guarding the property lookups
would make the flow unreachable from its own first step — the same trap the
e-sign adapter documents. See `packages/connectors/src/ports/index.ts`.

## Known stubs, for whoever wires the real thing

- **The property card is CoreLogic's when `PROPERTY_RECORDS_PROVIDER=corelogic`,
  and the flood zone is never theirs.** `adapters/corelogic.ts` answers the
  county record (one Property Detail call plus the HOA product) and the AVM
  (the originations model's summary) off a bearer token minted from
  `CORELOGIC_CLIENT_KEY` and `CORELOGIC_CLIENT_SECRET`; Google Places sits
  over it for autocomplete when both are named. A land use the adapter cannot
  place is refused into the manual path rather than guessed onto a federal
  submission, and `priorOwnershipInLastThreeYears` reads null from a real
  record because a parcel knows nothing about who is buying it. The kind of
  dwelling is read off the Universal Land Use code, because a live record
  carries codes and no descriptions. A parcel the model will not price has no
  valuation rather than no record. The flood determination is the fixture's
  for its three addresses and "not determined" for every other one: it is a
  separate product, and on a federally related mortgage it has to be a
  _certified_ one, not a map read.
  Unset, everything is the fixture's three addresses, and anything else falls
  back to manual entry with no property card. `/demo/property` is a vendor
  demo page — type an address, fetch what each adapter answers, read the raw
  response — mounted wherever `DEMO_PERSONAS` is, open to a sample borrower's
  session because the lookup is a `GET` and touches no file.
- **Manual bank-statement upload collects filenames and sends nothing.**
  `apps/web/src/pages/BankPage.tsx`. Deliberate — where the bytes go is a real
  decision, and `routes/documents.ts` never transmits them today.
- **`currentHousing` is nullable, and screen 3 is what fills it.** It was
  `String @default("rent")` NOT NULL and screen 2 sent the literal `"rent"`;
  the column, the route enum and the screen stopped manufacturing it together.
  `du_residences` holds the real answer, `POST /files/:id/declaration` writes
  both, and the column is a derived copy of the row. Until somebody answers it
  reads back NULL and `renter_limited_mortgage_history` answers "cannot know
  yet" rather than calling an unasked borrower a renter.
- **Property corrections are recorded, not applied.** A borrower disagreeing
  with the county record writes a `FileEvent` for review and changes nothing
  the engine reads.
- **Screen 5's single signature covers the application AND the 4506-C**, then
  pulls transcripts and recomputes. Disclosed in the signing panel. It also
  attests to the Section 5 answers and to the URLA 1b answers about each
  current job (self-employed; employed by a party to the transaction), which
  are asked on that screen because jobs exist only after the bank or payroll
  pull. Both are shown back there:
  it used to DERIVE five declarations from a credit report, a lien search, an
  asset report and a county record, so an unrun pull read as the borrower
  declaring themselves clean. `buildDeclarations` is gone and a test keeps it
  gone.
- **The Grander persona is a row on the sign-in page and nothing else.** An
  imported member is a party and a loan with no application, and the loan half
  is built: `Loan`, `Servicer`, `LoanParty` and `LoanTransition` are tables,
  `createImportedLoan` births one `imported_unclaimed` from a `partner_import`,
  and the `borrower_claimed` edge out of it is in
  `packages/shared/src/loan-machine.ts`. What is missing is anything that would
  put a row there: nothing outside the tests calls `createImportedLoan`, there
  is no ingest route and no importer, and the API accepts no machine credential
  at all — `requireAuth` takes a Google sign-in cookie and nothing else. The
  claim flow `docs/states.md` specifies, a signed single-use token delivered by
  Grander rather than an email match at sign-in, is unbuilt too. The persona
  would still refuse to seed if all of that existed: an application in any
  state would say they asked us for credit, and an unclaimed party has never
  authenticated, so there is no user to sign a tester in as. The nearest
  truthful shape is written into `apps/api/src/personas/stories.ts` as a
  comment for whoever builds the importer.
- **A sample borrower on hold needs a knob to be held.** All three connector
  fixtures screen clear, so `FixtureOptions.screening: "near_match"` is what
  makes Omar's snapshot, his `sanctionsScreenClear` column and his ledger row
  agree. A real screening vendor needs no such thing, and nothing but the
  persona seed passes it.
- **Eight sample borrowers share three connector fixtures.** Their facts and
  addresses are their own, but the fixtures' identity documents name three
  other people. That document is only read by the ID-scan branch, which is a
  POST, which a sample borrower cannot make — so nothing shows a document in
  the wrong name today. Wiring the ID scan to a persona means giving the
  fixtures eight people.

- **The decision route submits to Desktop Underwriter, and a refusal is a
  row.** `submitApplicationToDu` runs after every decision and in the persona
  seed: assemble, gate, emit, send through the `du` port, record. On staging
  the placeholders refuse it and the refusal is a `FileEvent`; against the
  fixture in development and tests, every decided sample borrower is answered.
  There is no vault for taxpayer identifiers: the fixture path is handed a
  number nobody has ever been issued, and against Fannie Mae the gate refuses
  every borrower until one exists. `GET /files/:id/du-responses` reads the
  answers back; `npm run du:submit --workspace=@hm/api -- <fileId>` resubmits
  by hand. The document is never stored.
- **Our NMLSR numbers are placeholders until somebody sets five variables.**
  Every application is born carrying the origination company and the loan
  originator as `du_deal_parties` rows, from `ORIGINATION_COMPANY_NAME`,
  `ORIGINATION_COMPANY_NMLS_ID`, `LOAN_ORIGINATOR_FIRST_NAME`,
  `LOAN_ORIGINATOR_LAST_NAME` and `LOAN_ORIGINATOR_NMLS_ID`. Unset, the
  placeholders in `packages/du/src/originator.ts` stand in — values with
  letters in them, which no NMLSR id has — and a production assembly refuses
  a row carrying one. `/api/health` reports `originator: placeholder` until
  then. The vesting on the review screen has no such gap: it is asked.
- **A co-borrower walks their own half, and the engine reads everybody.**
  Screen 2 names one,
  the applicant sends them a link (Resend when `MAIL_PROVIDER=resend`;
  otherwise an in-memory outbox that only a test reads, and the route refuses
  in production rather than pretend), `/claim/:token` takes it after Google
  sign-in, and the claim is a merge — the trigger lets a PROVISIONAL party go
  to `CLAIM_PENDING` or `MERGED` and nowhere else. From there the co-borrower
  walks their own half — screen 2, Section 5, their own bank, demographics,
  one signature — and every route resolves "the borrower" by the person
  asking, with `assertFileAccess` mode `self`; links are per person, and a
  member's read of the file is redacted to the household's half plus their
  own reports.
  The sample household is seeded through exactly this path — Priya names
  Dev, the seed reads his link out of the fixture outbox, and he claims it
  as a sign-in of his own (`priya_dev_raman:dev`, listed under her on the
  sign-in page) — so the sample cannot drift from the flow.
  The file's own `credit`, `assets`, `payroll` and `transcripts` stay
  Borrower 1's, for the screens; `LoanFile.reports` carries everybody's by
  party, `household()` in `@hm/shared` is how the engine and the evaluators
  read a report, and every read of a file is redacted to the reader's own.
  The loan's score is the lowest of the borrowers' own, the minimum is tested
  against their average, a joint account counts once, and a missing report
  blocks by name — `docs/decisions.md`, "A household's numbers are the
  household's". `docs/states.md` has the shape.

## Five rules that are not style preferences

**1. `data/v1-build.csv` is the source of truth, and the generator refuses to
guess.** Never hand-edit `packages/requirements/src/generated.ts`. Every
mapping in `scripts/build-requirements.mjs` is exhaustive and throws on an
unrecognised value, so a sheet change that adds a screen, source, condition or
timing phrase stops the build instead of silently defaulting. `npm run
requirements:verify` runs in CI.

**2. Applicability is three-valued and `null` is not `false`.** `true` /
`false` / "cannot know yet". The third state is why the UI can say "we might
still ask" instead of implying a borrower is finished. `progress()` counts only
requirements that definitely apply — counting vacuously-satisfied ones while
applicability is unknown made the satisfied count go _backwards_ across the
payroll connection (23 → 21, five requirements at once). There is a regression
test; do not relax it.

**3. Sign-in is the only way in, and files belong to people.** Every `/api`
route past `/health` and `/auth` requires a session. `assertFileAccess` gates
every file route, and a request for someone else's file returns **404, not
403** — a 403 confirms the id exists, which is an enumeration oracle for anyone
holding a session. Demo files are readable by all and writable by none. There
are tests; do not relax them.

**Sign-in has a second step.** A Google sign-in identifies; a six-digit code
from an authenticator app authenticates, and `requireAuth` refuses everything
past `/api/auth` until a session has done both. `requireSession` is the weaker
gate and only `/me` and the `/second-factor` routes may use it — a test reads
the routes to hold that. Sample borrowers and the local developer are exempt,
marked on the session by the route that minted it and by nothing else. See
`docs/decisions.md`, "Sign-in has a second step".

**4. Nothing may be pulled before APP-005.** The guard is inside the connector
adapters, not the routes, so a new route cannot forget it. `guard.test.ts`
calls every adapter against an unauthorized file and fails if any returns data.
The e-sign adapter is deliberately unguarded — it is how the authorization gets
signed, and guarding it would make APP-005 unobtainable.

**5. Every number on the decision comes from a recorded derivation.** Nothing
reaches the `Decision` object except through `DerivationLog.record`, and a
computation that cannot run records `blocked` with what it is waiting for. A
figure with no explanation is a bug in the engine, not in the copy. The engine
also returns `refer` rather than `approve_eligible` when any input was blocked
— "we could not compute this" and "we computed it and you passed" must never
collapse into the same checkmark. A `refer` becomes the outcome `referred`,
which carries no edge out of underwriting and no adverse-action obligation: it
is not a decision, and nothing downstream may render it as one.

## The design system is a package, and it has one source of truth

The product wears **Supermortgage**: paper ground, one red accent, Georgia
display, Helvetica text. The colors are the paper-and-ink set Doug's Apply
product ships, adopted 21 September 2026; the faces are still the marketing
prototype's. The identity is documented in `docs/brand.md`; `packages/brand`
is how it reaches a screen.

**To change a color or a font, edit `packages/brand/tokens.mjs` and run
`npm run brand:build`.** That is the whole procedure, and it is the reason the
package exists. `tokens.css` is generated from that file, the Tailwind preset
reads that file, and every utility, custom property and `.super-*` component
follows. `npm run brand:verify` runs in CI and fails when the generated CSS is
stale, exactly like `requirements:verify`.

Three tiers, and product code only ever names the last two:

```
primitives   gray-600, red-500, serif           named by what they ARE
semantic     rule → gray-600, accent → red-500  named by what they are FOR
outputs      border-rule, --sm-color-rule       generated; never hand-edited
```

**Tailwind's default palette is replaced, not extended.** There is no
`text-gray-500`, no `bg-white`, no `font-sans`, no `shadow-md`. A value that is
not a token cannot reach a component by accident, and a typo'd class is a class
that generates nothing rather than one that silently works. If you need a
value, add the token.

**Nothing in `apps/web` declares a color, a face or a size.**
`apps/web/src/index.css` is an assembly of imports and nothing else. A style
that belongs to the brand belongs in `packages/brand`, where the marketing
surface and any future app get it too.

**The display face is never bold.** Georgia at weight 400 is the brand;
`font-display` forces it, and a `font-semibold` alongside it is a bug. Bold
weights are fine on sans text.

**`danger` is never the accent.** Red means "you can act on this". A screen
that also uses red for "something is wrong" has made both meaningless, so the
error color is its own primitive and a test enforces the split. On paper the
split is a shade rather than a hue — Doug's palette has no error color that is
not red — and whether that is enough is open question 9 in `docs/brand.md`.

The contrast floors are tests, not guidance — `packages/brand/test` fails the
build if a token edit drops body text, a label, a status color or an input
border below its WCAG minimum. That is what makes changing a color safe.

## Storage

Relational tables are what the product queries. `connector_snapshots` and
`decisions` are **append-only**: a re-pull writes a new row, a recomputation
writes a new decision. That is what makes the monitoring loop expressible —
"your situation changed" is a diff between two snapshots, and you cannot diff
against a row you overwrote. Nothing in this repo updates a snapshot.

SSN never lands in Postgres. `borrowers.ssn_vault_handle` is an opaque
reference; `ssn_last4` is display only.

**The average prime offer rate is fetched, never typed, and the engine never
reads a checked-in one.** `apor_fetches` and `apor_weeks` are append-only like
the two above; `scripts/fetch-apor.ts` fills them from the CFPB's PUBLISHED
table (`YieldTableFixed.txt`, the figure in force — `apor-yield.ts`) and
cross-checks every week against Appendix J on the CFPB's survey
(`apor-survey.ts`), storing the difference beside the rate. The two agree to
the cent except on the weeks the CFPB deviates by announcement, and a test
asserts that set exactly. `underwrite` takes the table as a required option
and the API hands it what the database holds, or null and a blocked UW-008. The deploy
fetches before it seeds and fails if the series does not cover the current
week; a Cloud Scheduler job (`infra/`) does the same daily. The vendored copy
in `data/` is for tests and developers — `npm run apor:vendor` refreshes it,
`npm run apor:verify` runs in CI, and nobody edits a row.

## Infrastructure

Its own GCP project, `homestead-mortgages`. Own Cloud SQL instance, own
Artifact Registry, own Workload Identity pool, own service accounts. Nothing is
shared with Walt or with the other Homestead any more.

It did not start that way, and the reasons it moved are the reasons not to
move it back:

**Cloud SQL users are instance-scoped, not database-scoped.** With the database
on the shared `walt-db`, this app's role could open an authenticated connection
to `walt_prod`. It read nothing there — 0 of 98 tables — but that held only as
long as every table grant stayed correct, forever.

**The runtime identity was worse.** The deploy ran as `walt-cloud-run@`, which
carries _project-wide_ `secretmanager.secretAccessor` and
`storage.objectAdmin`. This container could have read every secret in that
project and deleted objects from Walt's buckets. Nothing in the code would
have; nothing structural stopped it.

Today `hm-run@` holds `cloudsql.client` and accessor on exactly two secrets,
granted on the secrets themselves. `hm-github-actions@` can deploy and push
images and nothing else. Terraform manages all of it.

## Reaching the deployed app

Publicly, at the Cloud Run URL, signed in with any Google account plus a code
from an authenticator app — the first sign-in enrolls one. That needed
a project-level exception to the org's `iam.allowedPolicyMemberDomains`
constraint, which forbids `allUsers` everywhere else under trywalt.ai.

Know the failure mode: `gcloud run deploy --allow-unauthenticated` does **not**
fail when that constraint blocks it. It logs and continues, leaving a service
with no invoker bindings that 403s everything and reads exactly like a broken
container. The deploy workflow asserts the binding afterwards and fails if it
is missing.

**`DEMO_PERSONAS=true` is set on staging and must never be set anywhere real.**
It mounts `POST /api/auth/personas/:key`, which mints a real session for a
seeded sample borrower with no Google credential. Staging runs
`NODE_ENV=production`, so no code can tell the two deployments apart — the flag
is the whole of the decision. With it off the persona routes are not mounted
and the service answers them exactly as it answers a typo. `/api/health`
reports `personas`, and the deploy fails if it is not what was asked for.

## House style

American English, in code and in prose: color, gray, authorize, behavior,
license. Token names follow it too — the palette primitives are `gray-*`.

Some older comments and a few requirement statements still carry British
spellings from earlier work. Leave them where they sit; correct one only when
you are already editing that line, so the fix never arrives as its own diff.

## Commands

```bash
npm run dev                  # API :8080, web :5173
npm test                     # all workspaces
npm run check                # tsc -b + registry verify
npm run requirements:build   # after editing data/v1-build.csv
npm run brand:build          # after editing packages/brand/tokens.mjs
npm run apor:fetch           # ingest the vendored survey into DATABASE_URL (APOR_PROVIDER=ffiec for the live one)
npm run apor:vendor          # refresh data/ffiec-survey-table.csv from the CFPB and re-embed it
npm run db:migrate           # prisma migrate dev
npm run db:test:setup        # create <db>_test and apply migrations to it
npm run build && npm run seed:personas   # the eight sample borrowers
```

`seed:personas` refuses to run unless `DEMO_PERSONAS=true` is in its own
environment — the same flag that mounts the sample sign-in — so it cannot be
pointed at a production database without also turning on the thing that would
make its rows reachable. It is idempotent by `users.persona_key`: a persona
already standing at its target is reported and left alone, one standing
anywhere else is reported as a DRIFT and the run exits non-zero. `--reset
<key>` re-walks exactly one; `--purge-legacy-demo` clears what the old
`seed-demo.ts` left behind.

The API tests talk to a real Postgres and mock nothing: `docker compose up -d
postgres`, then `npm run db:test:setup`. Every promise about who may read whose
file, about cascades, and about a stage that only moves forward is kept by the
database, and a suite that mocks `@hm/db` can see none of them — see
`docs/decisions.md`, "Tests run against a real Postgres".

**Two runs cannot share one test database, and the suite enforces that rather
than hoping.** `setup.ts` truncates every table between tests, so a second
`npm test` against the same database truncates the tables the first one is
midway through — measured at 235 and 226 failures out of 511, all of which
read like real bugs. A Postgres advisory lock in `globalSetup` makes the second
run wait instead, and says so.

**So to run two suites at once, give them two databases.** Waiting is the
fallback, not the goal — it is exactly what one developer with a watch process
wants and exactly what two agents working in parallel do not.

```bash
TEST_DATABASE_URL=postgresql://homestead_mortgages:homestead_mortgages@localhost:5433/hm_<agent> \
  npm run db:test:setup && npm test
```

`db:test:setup` creates the database if it is absent and applies every
migration — 3.6 seconds from nothing — and `testDatabaseUrl()` in
`scripts/test-database-url.mjs` is the single place that reads the variable, so
every test path follows. The isolation is real rather than nominal because a
Postgres advisory lock is scoped to its **database**, not to the cluster: two
runs take the same lock number under different databases and neither blocks the
other. Name the database after the agent or the branch, not after the suite,
and nothing has to clean up after a run that was killed.
