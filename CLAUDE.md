# Homestead Mortgages

Mortgage underwriting onboarding, built against Drew's V1 flow sheet. Read
`docs/requirements.md` before touching anything in `packages/requirements`, and
`docs/decisions.md` before trusting any number the engine produces.

`docs/states.md` is the model for user states and account states — what a
person is trying to do, and where it stands. It covers both what is built today
and the Party / Application / Loan model replacing it, and marks which is which.
Read it before adding anything that looks like a status.

## The shape

npm workspaces + Turbo, following the HMX pattern. Express 5 API, React 19 SPA,
Prisma against Postgres, Terraform for the GCP pieces this repo owns.

```
data/v1-build.csv          source of truth for WHAT must be satisfied
packages/requirements      the 77 requirements, executable
packages/underwriting      the shadow AUS
packages/connectors        five ports, fixture adapters, the authorization guard
packages/shared            domain types; LoanFile is the object everything reads
packages/brand             design tokens, Tailwind preset, .super-* components
packages/db                Prisma
apps/api                   Express 5
apps/web                   React + Vite
infra                      Terraform
```

## The borrower flow is FOUR screens; the engine still has nine

The UI was rebuilt from nine screens to four. **Nothing about the requirements
engine, the stage machine or the data model changed** — the engine still tracks
ten `FlowStage` values and evaluates all 77 requirements. It just stopped
rendering itself at the borrower.

```
1 Property   →  2 About you  →  3 Your bank  →  4 Review
   property_loan   identity+credit   bank          decision
```

`apps/web/src/lib/flow.ts` is the only place that knows both vocabularies. It
holds `SCREENS` (four), `STAGE_TO_SCREEN` (ten → four) and `branchesFor()`.

**Payroll, IRS and document upload are branches, not steps.** They render only
when the engine reports outstanding work whose `source` is one the borrower
must personally supply — `borrower_input`, `document_upload`, `connect_payroll`.
`connect_irs` and `esign` are deliberately excluded: those are ours to do, and
treating them as triggers sent every clean W-2 borrower down a tax-transcript
branch to authorise something screen 4 was about to ask them to sign anyway.

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

- **Address autocomplete is a fixture list of three addresses.** Anything else
  falls back to manual entry with no property card. A real Places/Smarty
  adapter implements `suggestAddresses` only; the assessor, AVM and flood
  lookups are separate vendors, and a flood determination on a federally
  related mortgage has to be a _certified_ one, not a FEMA map read.
- **Manual bank-statement upload collects filenames and sends nothing.**
  `apps/web/src/pages/BankPage.tsx`. Deliberate — where the bytes go is a real
  decision, and `routes/documents.ts` never transmits them today.
- **`currentHousing` is asserted, not asked.** The four screens do not collect
  rent-vs-own and no retrieval establishes it, so screen 2 sends `"rent"`. The
  honest fix is making the field nullable, which touches the engine.
- **Property corrections are recorded, not applied.** A borrower disagreeing
  with the county record writes a `FileEvent` for review and changes nothing
  the engine reads.
- **Screen 4's single signature covers the application AND the 4506-C**, then
  pulls transcripts and recomputes. Disclosed in the signing panel.

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

**4. Nothing may be pulled before APP-005.** The guard is inside the connector
adapters, not the routes, so a new route cannot forget it. `guard.test.ts`
calls every adapter against an unauthorized file and fails if any returns data.
The e-sign adapter is deliberately unguarded — it is how the authorization gets
signed, and guarding it would make APP-005 unobtainable.

**5. Every number on screen 8 comes from a recorded derivation.** Nothing
reaches the `Decision` object except through `DerivationLog.record`, and a
computation that cannot run records `blocked` with what it is waiting for. A
figure with no explanation is a bug in the engine, not in the copy. The engine
also returns `refer` rather than `approve_eligible` when any input was blocked
— "we could not compute this" and "we computed it and you passed" must never
collapse into the same checkmark. A `refer` becomes the outcome `referred`,
which carries no edge out of underwriting and no adverse-action obligation: it
is not a decision, and nothing downstream may render it as one.

## The design system is a package, and it has one source of truth

The product wears **Supermortgage**: black ground, one red accent, Georgia
display, Helvetica text. The identity is documented in `docs/brand.md`;
`packages/brand` is how it reaches a screen.

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
error color is its own primitive and a test enforces the split.

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

Publicly, at the Cloud Run URL, signed in with any Google account. That needed
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
npm run db:migrate           # prisma migrate dev
npm run db:test:setup        # create <db>_test and apply migrations to it
```

The API tests talk to a real Postgres and mock nothing: `docker compose up -d
postgres`, then `npm run db:test:setup`. Every promise about who may read whose
file, about cascades, and about a stage that only moves forward is kept by the
database, and a suite that mocks `@hm/db` can see none of them — see
`docs/decisions.md`, "Tests run against a real Postgres".
