# System Architecture

> **As of 17 September 2026.** The Party / Application / Loan model designed in
> `docs/states.md` is the running system now: every route reads people through
> facts on a party, every pull is minted a purpose token for one party, and a
> credit request is an `Application` with a gapless ledger. What is still a
> fixture or a stub is marked ⚠ in place. If this file and the code disagree,
> the code wins and this file is stale.

## Overview

Homestead Mortgages onboards a homebuyer, retrieves what underwriting needs from
connected accounts rather than uploads, and returns a decision that explains
itself. It is one npm-workspaces monorepo — an Express 5 API and a React 19 SPA
over eight domain packages — shipped as **a single container** on Cloud Run,
backed by its own Cloud SQL Postgres, with Google sign-in for identity.

Three things distinguish it from a CRUD app and shape every section below:

- **The requirements engine is the product's spine.** Drew's V1 flow sheet
  (`data/v1-build.csv`, 85 rows) is compiled into an executable registry. What a
  borrower is asked, which branch they see, and what blocks a decision all fall
  out of evaluating that registry against one `LoanFile`.
- **Authorization is structural, not procedural.** The rule that nothing may be
  pulled before APP-005 lives inside the connector adapters, not the routes, so
  a new route cannot forget it.
- **Every figure the decision engine computes carries its derivation**, and a
  computation that could not run records `blocked` rather than a comfortable
  default.

## Infrastructure

One GCP project, `homestead-mortgages` — its own Cloud Run service, Cloud SQL
instance, Artifact Registry and service accounts.

⚠ The comments in `infra/main.tf` and `infra/variables.tf` still describe the
pre-move layout, in which the project, registry and Workload Identity pool were
Walt's. They are stale; `docs/decisions.md` records why the move happened.

```
                        Browser (any Google account)
                                    │
                                    ▼
              ┌──────────────────────────────────────────┐
              │  Cloud Run v2   homestead-mortgages-      │
              │                 staging   (us-central1)   │
              │  ┌────────────────────────────────────┐   │
              │  │  ONE Node 22 container, port 8080  │   │
              │  │  Express 5  ── /api/*              │   │
              │  │  express.static ── apps/web/dist   │   │
              │  └────────────────────────────────────┘   │
              │  SA hm-run@ · min 0 / max 3 · 1 CPU / 1Gi │
              │  invoker: allUsers  (asserted post-deploy)│
              └───────┬───────────────────────┬──────────┘
                      │ Cloud SQL socket      │ --set-secrets
                      ▼                       ▼
        ┌─────────────────────────┐   ┌──────────────────────────────┐
        │ Cloud SQL  POSTGRES_16  │   │ Secret Manager ×6            │
        │ homestead-mortgages-db  │   │ HOMESTEAD_MORTGAGES_* → env  │
        │  db: homestead-         │   │  …_DATABASE_URL_STAGING      │
        │      mortgages_staging  │   │  …_SESSION_SECRET            │
        │  no authorized_networks │   │  …_VENDOR_TOKEN_KEY          │
        │  PITR · deletion_       │   │  …_PLAID_SECRET              │
        │  protection · 07:00 bkp │   │  …_STRIPE_SECRET_KEY_SANDBOX │
        │                         │   │  …_GOOGLE_PLACES_API_KEY     │
        └─────────────────────────┘   └──────────────────────────────┘

        ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
          infra/*.tf — 6 resources, applied BY HAND, local state
        │ Cloud SQL instance · database · app role · Run       │
          service · 2 invoker-binding variants.  ⚠ WIP:
        │ CI never runs it, and it already disagrees with what  │
          `gcloud run deploy` ships (see Environments).
        └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

**The secret names are prefixed.** The box above shows the Secret Manager names;
inside the container they arrive as `DATABASE_URL`, `SESSION_SECRET`,
`VENDOR_TOKEN_KEY`, `PLAID_SECRET`, `STRIPE_SECRET_KEY_SANDBOX` and
`GOOGLE_PLACES_API_KEY`. `gcloud secrets describe DATABASE_URL` finds nothing.

**Know this failure mode.** `gcloud run deploy --allow-unauthenticated` does not
fail when the org's `iam.allowedPolicyMemberDomains` constraint blocks it. It
logs and continues, leaving a service with no invoker bindings that 403s
everything and reads exactly like a broken container. The deploy workflow binds
`allUsers` explicitly, reads the policy back, and fails the build if it is
missing.

**Not in Terraform, and this is the gap worth knowing:** the service accounts,
every IAM role binding _except_ the two Cloud Run invoker bindings, the six
Secret Manager secrets, the Artifact Registry repository and the Workload
Identity pool. They exist in the project and in prose (`docs/decisions.md`), and
nowhere in code.

⚠ **The deployed URL is recorded, not verifiable from this repo.** `README.md`
and `docs/decisions.md` both give
`https://homestead-mortgages-staging-dhlswvsiia-uc.a.run.app`; nothing in code
produces it — the workflow resolves it at deploy time with
`gcloud run services describe`. It also sits in tension with the outstanding
prerequisite recorded below, that CI cannot authenticate to GCP until this
repository is added to the Workload Identity provider's attribute condition.
A live URL and a CI that cannot authenticate cannot both be current; one of the
two records is stale and the repo does not say which.

## Technology Stack

Versions are what the lockfile resolves, with the declared range in parentheses
where the two differ meaningfully.

| Layer                                                   | Technology                                                           | Purpose                                                                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Monorepo**                                            | npm workspaces + Turbo 2                                             | `apps/*` and `packages/*`; `build` and `test` both `dependsOn: ["^build"]`                                                                                                                                            |
| **Language**                                            | TypeScript 5.9 (declared `^5.4.0`), ESM, Node16 resolution           | `strict` + `noUncheckedIndexedAccess`, composite project references                                                                                                                                                   |
| **API**                                                 | Express 5.2                                                          | One process; serves `/api` and, in the image, the built SPA                                                                                                                                                           |
| **SPA**                                                 | React 19.2 + Vite 8 + react-router 7                                 | Five borrower screens, three branches, a public front door                                                                                                                                                            |
| **Server state**                                        | TanStack Query 5                                                     | `staleTime: 0`, `retry: false` — a stale panel showing satisfied work as outstanding is what makes the flow feel broken                                                                                               |
| **Styling**                                             | Tailwind 3.4 driven by the `@hm/brand` preset                        | The preset **replaces** Tailwind's palette and scales rather than extending them                                                                                                                                      |
| **Database**                                            | PostgreSQL 16 (Cloud SQL)                                            | 18 models, 10 enums; relational for what we query, JSONB for what a vendor said                                                                                                                                       |
| **ORM**                                                 | Prisma 7.10 (declared `^7.8.0`) via `@prisma/adapter-pg` over `pg` 8 | Driver adapter; `prisma.config.ts` sets `datasource.url` only when `DATABASE_URL` is present, so `prisma generate` runs in CI with no database                                                                        |
| **Sessions**                                            | `express-session` + `connect-pg-simple`                              | Server-side sessions in Postgres so sign-out is possible. ⚠ The `user_sessions` table is created at boot by `createTableIfMissing` and is in **no migration**                                                         |
| **Auth**                                                | `google-auth-library` (`verifyIdToken`)                              | Google ID token → `User` upsert on `googleSub` → session                                                                                                                                                              |
| **Validation**                                          | Zod 3                                                                | Per-route body schemas; every `:id` is `z.string().uuid()`                                                                                                                                                            |
| **Headers**                                             | Helmet 8 + `cors`                                                    | `security-policy.ts` owns COOP and the CSP allowing the Google and Plaid scripts                                                                                                                                      |
| **Crypto**                                              | `node:crypto` AES-256-GCM                                            | Vendor bearer tokens at rest; refuses to boot without a 32-byte key                                                                                                                                                   |
| **Bank**                                                | Plaid (sandbox) — hand-rolled `fetch`, no SDK                        | ⚠ Deployed as `PLAID_PRODUCT=assets`, which is **not** a consumer report; CRA is the target                                                                                                                           |
| **Identity**                                            | Stripe Identity (test mode)                                          | ⚠ Refuses an `sk_live_` key unless explicitly allowed — live mode collects biometrics under BIPA and there is no retention policy                                                                                     |
| **Address**                                             | Google Places API v1                                                 | ⚠ `suggestAddresses` only; assessor, AVM and flood stay fixture                                                                                                                                                       |
| **Credit / payroll / IRS / e-sign / screening / liens** | —                                                                    | ⚠ **No real adapter.** Fixture-only, three hand-written personas                                                                                                                                                      |
| **Email**                                               | Resend, behind a `mail` port (`MAIL_PROVIDER=resend`)                | ⚠ Resend is chosen and **not integrated**. Several regulatory clocks can only be stopped by a delivered notice                                                                                                        |
| **Desktop Underwriter**                                 | `adapters/du.ts` (`DU_PROVIDER=fannie`)                              | ⚠ Built and tested against a stubbed fetch, and called by the decision route; the endpoint, credential and seller/servicer number come from the integration agreement, and the adapter refuses to submit without them |
| **Average prime offer rate**                            | CFPB's published table, fetched by a Cloud Run job daily             | The engine reads `apor_weeks`; a week the series does not reach blocks UW-008 and `/api/health` says so                                                                                                               |
| **Tests**                                               | Vitest 4 against a real `postgres:16-alpine`                         | The API suite mocks almost nothing — see [Testing](#testing)                                                                                                                                                          |
| **Lint / format**                                       | ESLint 10 flat config (root, one for all workspaces) + Prettier 3    | ⚠ `format:check` exists and is not in CI                                                                                                                                                                              |
| **CI/CD**                                               | GitHub Actions → Artifact Registry → Cloud Run                       | Keyless via Workload Identity Federation                                                                                                                                                                              |
| **IaC**                                                 | Terraform ≥1.5, `hashicorp/google ~>5.0`                             | ⚠ Six resources, applied by hand, local state                                                                                                                                                                         |
| **Observability**                                       | **None**                                                             | See [Observability](#observability) — this is an absence, not a stack                                                                                                                                                 |

## Data Flow

```
Browser
   │  same origin in production (the API serves the SPA), so no CORS hop
   ▼
Express 5  apps/api/src/index.ts   ── order is the load-bearing fact ──
   trust proxy (a HOP COUNT, so a client cannot forge the IP on a consent)
   helmet(securityHeaders)  ·  cors  ·  express.json(1mb)  ·  session
   │
   ├─ /api/health ── OPEN ──► SELECT 1 → 200 | 503
   ├─ /api/auth   ── OPEN ──► verifyIdToken → user.upsert → session.regenerate
   │
   ├─ app.use("/api", requireAuth)   ◄── ONE gate, so a new router cannot forget
   │
   └─ /api/files/* ──► assertFileAccess(id, user, read|self|write|own)
          │              missing → 404 · a stranger → 404 (never 403)
          │              a member (their party holds a borrower row) → read, and
          │                self for the screens about themselves
          │              the owner → everything · demo + any write → 403
          ▼
     services/repository.ts   ── the ONLY place Prisma rows become a LoanFile
          │
          ├──► @hm/connectors ──► guard (APP-005) ──► vendor  ──┐
          ├──► @hm/requirements   assessAll / outstanding       │
          ├──► @hm/underwriting   underwrite() → Decision       │
          └──► Postgres                                          │
                 ├─ relational, mutable   (files, borrowers, …)  │
                 └─ append-only           ◄───────────────────────┘
                      connector_snapshots · decisions · file_events
   │
   ├─ /api catch-all → JSON 404  (an unmatched API path must not return HTML)
   ├─ serveSpa: GET !^/api/ → index.html (no-store; hashed assets immutable)
   └─ errorHandler
        AuthorizationError → 403 + requirementId   ZodError → 400
        PlaidRequestError  → 409 relink | 502      AppError → its own status
```

**`services/repository.ts` is the seam.** `loadLoanFile(id)` issues one query
with every child relation included and all snapshots ordered newest-first, then
takes the first snapshot per kind — which is how "latest wins while history is
retained" is implemented. Loan conditions are the one exception: they come from
a second query. Nothing else in the codebase maps a Prisma row to the domain.

**There is no API contract artifact.** ⚠ No OpenAPI spec, no generated client,
no shared response types in practice: `apps/web` declares a dependency on
`@hm/shared` and imports nothing from it, re-declaring every response shape
locally. This is the one place the API and the SPA can drift with nothing
catching it.

## Shared Libraries

```
apps/api ──┬──► @hm/requirements ──┐
           ├──► @hm/underwriting ──┼──► @hm/shared   (LoanFile, no runtime deps)
           ├──► @hm/connectors  ──┤
           ├──► @hm/du ───────────┘──► @hm/db, @hm/du-schema (the vendored corpus)
           ├───────────────────────    (direct, for LoanFile)
           └──► @hm/db             (Prisma — depends on NO workspace package)

apps/web ──┬──► @hm/brand          (tokens, Tailwind preset, .super-* CSS)
           └──► @hm/shared         ⚠ declared, aliased, imported by nothing
```

**Dependency flow**: `apps → {requirements, underwriting, connectors} → shared`,
with `apps/api` also importing `shared` directly. `@hm/shared`, `@hm/db` and
`@hm/brand` are leaves.

**Only `@hm/underwriting` is pure** — it is handed `now` and `casefileId`, so a
run is reproducible from its inputs. ⚠ `@hm/requirements` touches no database and
makes no request, but it _does_ read the wall clock in four places
(`conditions.ts` ×3, `satisfaction.ts` ×1), so an assessment is not reproducible
from its inputs alone. `@hm/connectors` makes real HTTPS calls to Plaid, Stripe
and Google Places.

| Package                 | What it is                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`       | The vocabulary. `LoanFile` is the object everything reads — nullable sections all the way down, because a file is legitimately half-empty for most of its life                                                                             |
| `packages/requirements` | The 85 requirements, executable: 39 applicability predicates, 85 satisfaction evaluators, a dependency graph                                                                                                                               |
| `packages/underwriting` | The shadow AUS — ratios, reserves, compliance, pricing, each figure carrying its derivation                                                                                                                                                |
| `packages/connectors`   | Thirteen ports, fixture adapters for all thirteen, six real ones (three partial), and the authorization guard                                                                                                                              |
| `packages/du`           | The Desktop Underwriter submission: the six generated tables, the assembler, the MISMO 3.4 emitter, the preflight, the institution and originator placeholders, and the compute boundary the Map holds                                     |
| `packages/du-schema`    | The vendored corpus — DU Spec 1.9.3, the Fannie schema chain, the MISMO reference model and the eighteen sample casefiles — that `du:verify` rebuilds the tables from                                                                      |
| `packages/db`           | Prisma schema and migrations. Several guarantees are triggers and CHECK constraints, not application code                                                                                                                                  |
| `packages/brand`        | Supermortgage design tokens. `tokens.mjs` is the source of truth and `tokens.css` is generated from it; `base.css`, `components.css`, `scene.css` and the Tailwind preset are hand-written and read the tokens rather than being generated |

⚠ `packages/brand` is the only workspace absent from the root `tsconfig.json`
project references — it is plain JS and CSS with no `tsc` build, which is why
`npm run check`'s `tsc -b` cannot catch a brand regression and `brand:verify`
has to exist separately.

## The two vocabularies

This is the single most confusing thing about the codebase, so it is drawn
rather than described.

```
sheet screens (10) property_loan · identity · credit · declarations · bank ·
                   payroll · irs_transcript · upload_fallback · decision ·
                   persistent_consent (0 requirements)

FlowStage (11)     the 10 above + COMPLETE
                   ⚠ the eleven names are still typed out five times by hand —
                     Prisma's enum and STAGE_ORDER in UPPERCASE, FLOW_STAGES in
                     shared and STAGE_TO_SCREEN in the web app in lowercase,
                     and STAGE_TO_DOMAIN in both. Nothing generates any of them
                     from any other. What there is only ONE of now is the
                     union: it is derived from FLOW_STAGES and the web app
                     re-exports it. The web app used to declare a second one,
                     spelled in UPPERCASE, and no compiler could see the
                     difference because a stage crosses the wire as a string.
                     `stage.test.ts` reads `pg_enum` and fails when STAGE_ORDER
                     disagrees with the database, which is what caught the
                     eleventh name being added in four places instead of five

borrower screens   1 Property → 2 About you → 3 A few questions →
        (5)        4 Your bank → 5 Review
                   + payroll / irs / documents as BRANCHES, never steps
```

The UI was rebuilt from nine screens to four, and a fifth was added when
somebody finally had to be asked URLA Section 5 and where they live. That one
is a step rather than a branch because `branchesFor()` renders work the engine
reports as outstanding, and the engine cannot report work that has no
requirement: the questions are seven rows in the sheet, so the engine tracks
eleven `FlowStage` values and evaluates 85 requirements.

`apps/web/src/lib/flow.ts` is where the translation is supposed to live:
`SCREENS`, `STAGE_TO_SCREEN` and `branchesFor()`. ⚠ It is not the only copy —
`components/DebugPanel.tsx` carries its own engine-screen → borrower-screen map, and
`pages/UploadPage.tsx` filters on raw engine vocabulary.

**Branches are computed, not routed to.** `branchesFor()` filters the outstanding
list on three conditions at once: the actor is the borrower, applicability is
_known_, and the source is one of `borrower_input`, `document_upload`,
`connect_payroll`. `connect_irs` and `esign` are deliberately excluded — treating
them as triggers sent every clean W-2 borrower down a tax-transcript branch to
authorize something screen 5 was about to ask them to sign anyway.

**The engine screens do not map evenly onto the borrower's five.** Counted from
the registry: `decision` 31, `credit` 10, `bank` 10, `identity` 7,
`upload_fallback` 7, `declarations` 6, `property_loan` 5, `payroll` 4,
`irs_transcript` 3, `persistent_consent` 0. Nearly forty percent of the
registry sits behind `decision`, which the borrower meets as screen 5 — the
screen that asks them for almost nothing. The screens they never see at all are `credit`, folded into "About
you", and `persistent_consent`, which has no requirements behind it.

`stage` is a **high-water mark, not a cursor** — where you are is the URL, how
far you got is the stage. `advanceStage`'s _write_ is one statement:

```
UPDATE loan_files SET stage = :target
 WHERE id = :id AND stage IN (every stage earlier than :target)
```

evaluated under the row lock, so the loser of a concurrent race matches nothing.
(A second, read-only query then reports where the file actually stands when the
update matched no row.) The read-then-write version lost that race, and a
real-Postgres test caught it on its first run.

## The requirements engine

`data/v1-build.csv` is the source of truth and the generator refuses to guess.
Every prose→enum mapping in `scripts/build-requirements.mjs` is exhaustive and
throws on an unrecognized value, so a sheet change that adds a screen, source,
condition or timing phrase **stops the build** instead of landing as a silent
default. `npm run requirements:verify` regenerates in memory and fails on drift;
it runs in CI. Never hand-edit `packages/requirements/src/generated.ts`.

The engine keeps three questions apart:

```
                        ┌──────────────────────────┐
   LoanFile  ──────────►│       assessAll()        │
                        └────────────┬─────────────┘
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  conditions.ts               satisfaction.ts                 graph.ts
  Does it apply?              Is the evidence in?             Workable yet?
  38 predicates               84 evaluators                   edges from the
  true / false / NULL         satisfied / unsatisfied         timing column
                              / blocked
        └────────────────────────────┼────────────────────────────┘
                                     ▼
                   Assessment { requirement, applies,
                                satisfaction, blockedBy }
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
   outstanding()                progress()                 explainBlock()
   applies !== false            applies === true ONLY      walks transitive
   → null INCLUDED              → null EXCLUDED            deps to the roots
```

**Applicability is three-valued and `null` is not `false`.** The asymmetry above
is the whole point: the _list_ includes undetermined items ("we might still
ask"); the _count_ does not. Counting vacuously-satisfied requirements while
applicability was unknown made the satisfied count go **backwards** across the
payroll connection — five income requirements flipping at once (INC-005, INC-019,
INC-020, INC-021, INC-023). There is a regression test asserting monotonicity;
do not relax it.

`evaluateSatisfaction` degrades to `blocked` when an id has no evaluator, rather
than throwing or defaulting to satisfied. Fail-closed.

⚠ Six timing constraints point at `CLS-*` requirements from a closing-stage sheet
that does not exist. They are excluded from the graph and recorded in
`DANGLING_REFERENCES` — the seam where V1 hands off.

## Connectors and the authorization guard

Thirteen ports in one file. Six have a real adapter (three of them partial); seven are fixture-only.

| Port                                                           | Real adapter                                    | State                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propertyData`                                                 | Google Places v1 over CoreLogic Property API v2 | Places answers autocomplete; CoreLogic the county record and the AVM. ⚠ Flood delegates to the fixture: a certified determination is a separate product |
| `identity`                                                     | Stripe Identity                                 | ⚠ Test mode only; refuses `sk_live_` without an explicit flag                                                                                           |
| `bank`                                                         | Plaid                                           | ⚠ Sandbox, `assets` rather than CRA, so `vendorAuthorizedForDu` is false and CRD-017 stays unsatisfied                                                  |
| `du`                                                           | Fannie Mae                                      | ⚠ Submits under `DU_*` credentials nobody holds yet; fixture answers Approve/Eligible                                                                   |
| `aporSeries`                                                   | CFPB (FFIEC)                                    | The published `YieldTableFixed.txt`, cross-checked against the survey by Appendix J                                                                     |
| `mail`                                                         | Resend                                          | The co-borrower invitation is the only message; a fixture outbox otherwise, and the invitation route refuses to pretend in production                   |
| `credit` `payroll` `irs` `esign` `screening` `liens` `pricing` | —                                               | ⚠ Fixture only. Three hand-written personas                                                                                                             |

Selection is per-connector and happens once, at boot, from three independent env
vars; anything unset stays on the fixture. Missing credentials throw at boot, not
at first use. `/api/health` reports the resulting mix, and the deploy asserts it.

**Nothing may be pulled before APP-005, and the guard sits on the adapter side of
the port line:**

```
   routes/*.ts  ──►  port interface  ──►  ┌─────────────────────────┐ ──► vendor
                                          │ assertVerificationAuth. │
   credit · bank · payroll ──────────────►│      (APP-005)          │
   screening · liens                      │   ├─ assert4506cExec.   │
   irs ──────────────────────────────────►│      (INC-008)          │
                                          └─────────────────────────┘
   esign · propertyData · identity · aporSeries · mail ─ ─ ─ ─ ─ ─ ─ ─► vendor
        unguarded, deliberately
```

**The split is what a call reveals before consent exists, not what it is keyed
on.** Property lookups are unguarded because their payload is a street address
and a public county record about a building. E-sign and the ID scan are unguarded
because they are how the authorization is _obtained_ and how it gets a verified
name on it — guarding either would make APP-005 unobtainable. Everything that
reaches a third party _about_ an already-identified borrower — credit, bank,
payroll, IRS, screening, liens — is guarded.

(⚠ `CLAUDE.md` states this as "anything keyed on an address is unguarded,
anything keyed on a person is not." That shorthand does not survive contact with
the ports: e-sign and identity both take a `borrowerId` and are unguarded, and
the lien search is keyed on a parcel number and is guarded.)

`guard.test.ts` calls each of the six guarded fixture adapters against an
unauthorized file and fails if any returns data. It also pins the three unguarded
ones by asserting they still answer, so staying unguarded is a recorded decision
rather than an omission. It drives `fixtureRegistry()` only; Plaid's guard is
covered in its own suite, and the Stripe and Places adapters are unguarded by
design.

The guard takes a **purpose token**, minted by `tokenFor(file, subject,
category)` for one party under a live grant of the right purpose, and every
route resolves that subject by the session (`retrievalSubject`). On a
two-borrower file borrower A's signature therefore authorizes nothing about
borrower B: the minter refuses, and `guard.test.ts` calls every guarded port
with a stranger's token and fails if any answers.

## The decision engine

`underwrite(file, options)` is a pure function returning a `Decision`. It stamps
`engine: "shadow"` on every result so a stored decision is never ambiguous about
what produced it. It is **not** an agency recommendation and must never be
presented as one.

```
  credit → income → ratios → assets → compliance + pricing → roll-up
     each stage writes to ─────────────────► DerivationLog
                                             record()  → value + formula + inputs
                                             blocked() → value null + blockedBy[]
                                                  │
   determineRecommendation(findings, hasBlockedInputs)   ── a priority ladder
     any eligibility finding ────────────► approve_ineligible
     any blocked derivation ─────────────► refer          ◄── the rule
     any finding at all ─────────────────► refer_with_caution
     otherwise ──────────────────────────► approve_eligible
                                                  │
   determineOutcome(recommendation, conditions, compliance)
     high-cost ──► denied   ineligible ──► counteroffer
     clean + no open conditions ──► clear_to_close   else ──► approved_with_conditions
```

**Every figure the engine computes reaches the `Decision` through
`DerivationLog.record`, and a computation that cannot run records `blocked` with
what it is waiting for.** "We could not compute this" and "we computed it and you
passed" must never collapse into the same checkmark — which is why any blocked
input downgrades the recommendation to `refer`.

⚠ The _verdicts_ assembled from those figures are not themselves recorded:
`reserves.satisfied`, `compliance.isHpml`, `compliance.pointsAndFeesPass`, and
the findings and conditions they generate, are computed inline. The audit trail
covers the arithmetic, not the conclusions drawn from it.

⚠ **The arithmetic is real; the constants are not.** Escrow is a national-average
guess (1.1% tax, 0.35% insurance) that drives PITIA and therefore DTI. The MI
table is an estimate. The pricing grid is labeled ILLUSTRATIVE in its own header
— "the wrong kind of wrong: plausible enough to be believed." Guideline
thresholds are hard-coded, and the `thresholdsReviewedFor: 2025` marker meant to
date-stamp every result **is never read** — no `Decision` carries it, so a
decision made against stale numbers is not identifiable after the fact. Several
of those thresholds change every January.

**What the engine computes is the shadow of what DU derives.** Every figure in
`ratios` and `reserves` — the two DTIs, the three LTVs, the housing payment, the
debt total, the qualifying income, the reserve months — is one Desktop
Underwriter derives itself from the inputs we send; `DU_DERIVED_FIGURES` in
`packages/shared` records that boundary figure by figure and a test in
`packages/du` holds the generated Map to it. The two columns are parsed at the
writer and the reader and held to their eight and four keys by CHECKs. The
Regulation Z thresholds are a dated table (`REGULATION_Z_THRESHOLDS`, 2026, from
the Federal Register), so a decision names the year it was measured against.

⚠ APR, APOR and the fee totals are now derived from the file rather than
accepted from a caller — the average prime offer rate computed from the CFPB's
weekly survey by the CFPB's published method and fetched into `apor_weeks` on
a schedule, a versioned fee schedule, and Appendix J's actuarial solve — so the
four compliance tests run on a file a borrower walked and `clear_to_close` is
reachable. Two things still block by design: a week the fetched series does
not reach (the fetch script and `/api/health` both say so before a borrower
does), and the APR on any loan carrying mortgage insurance, whose premium this
engine holds only an estimated rate card for. Both produce `referred`, which is
the honest outcome. See `docs/decisions.md`, "APOR, a fee schedule, and an APR
we are willing to defend".

⚠ `apps/web/src/pages/DecisionPage.tsx` — the only surface that ever rendered the
derivation audit trail — is dead code, reachable from no route. The derivation
discipline is an engine invariant today, not something the UI shows.

## Storage

Relational tables are what the product queries. The append-only tables are what
make the monitoring loop expressible — "your situation changed" is a diff between
two snapshots, and you cannot diff against a row you overwrote.

**Immutability comes in three strengths, and the differences matter:**

| Table                                             | Enforcement                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `facts`                                           | **Postgres trigger.** Every column but `superseded_by_id`, `retracted_at` and `retraction_reason` is frozen; a prohibited `UPDATE` raises. `DELETE` is deliberately allowed, so account-deletion cascades still work                                                     |
| `authorizations`                                  | **Postgres trigger, partial.** Not append-only — revocation is an in-place `UPDATE`. The trigger freezes party, purpose, categories, dates and the disclosure hash, and makes revocation one-way. ⚠ `counterparties`, the envelope id, IP and user agent are not covered |
| `connector_snapshots`, `decisions`, `file_events` | ⚠ **Convention and code only.** No triggers; the guarantee is that `.create()` is the only call anyone makes. A stray `.update()` would succeed                                                                                                                          |

`apor_fetches` and `apor_weeks` are append-only the same way: a re-fetch of an
unchanged CFPB document inserts nothing, and the latest fetch is the figure in
force. `decisions.ratios` and `decisions.reserves` are held to their eight and
four figures by CHECKs and parsed at both ends. `co_borrower_invitations` holds
the SHA-256 of a token that exists only in the emailed link, with one live row
per named person by partial unique index. `connector_links` is one row per
person per kind — `(loan_file_id, kind, party_id)` — so a co-borrower's bank is
a second link beside the applicant's, and every snapshot says whose it is.

`VendorToken` is deliberately _not_ append-only — a re-link replaces the
credential, because old bearer tokens are liability, not history.

**SSN never lands in Postgres.** `borrowers.ssn_vault_handle` is an opaque
reference; `ssn_last4` is display only. ⚠ And the vault behind the handle does not
exist: the handle is minted in the browser as `vault:<last4>:<uuid>` and nothing
on the server ever exchanges it, while the requirements engine treats its
presence as evidence the SSN was collected.

⚠ The subject property is flattened onto `loan_files`, and the repository's
reconstruction fills gaps with silent defaults (`single_family`,
`primary_residence`, `borrower_stated`, 360 months). Those reach the engine as if
they were stated facts.

## Security Model

| Layer                       | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication**          | Google ID token verified with `verifyIdToken` against `GOOGLE_CLIENT_ID`; `email_verified === false` → 403. The process refuses to boot in production without a client id                                                                                                                                                                                                                                                                                                                                                              |
| **Session**                 | Postgres-backed, cookie `hm.sid`: `httpOnly`, `secure` in production, `sameSite: lax`, 12h rolling. `session.regenerate()` before `userId` is set — session-fixation rotation                                                                                                                                                                                                                                                                                                                                                          |
| **Route gate**              | `app.use("/api", requireAuth)` mounted once, after `/api/health` and `/api/auth`, so a new router cannot forget it                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **File authorization**      | `assertFileAccess` on every file route, in four modes: `read` for anyone on the file, `self` for the screens a person fills in about themselves, `write` and `own` for the applicant. Someone else's file returns **404, not 403** — a 403 confirms the id exists, which is an enumeration oracle. What a reader gets back is redacted in both directions: everybody but the reader is a name and two facts (answered, signed), the decision and its derivation log are the applicant's, and the Section 5 read is the asker's own row |
| **Invitation token**        | 32 random bytes in the emailed link and nowhere else; the table holds its SHA-256; seven days, once, one live per person, a re-send kills the last. It rides in the URL fragment and reaches the API in a POST body, so no request log records it; every bad link answers the same 404; a sample-borrower session cannot take one; taking it is a press, not a page load                                                                                                                                                               |
| **Connector authorization** | The APP-005 guard inside the adapters, not the routes. `AuthorizationError` → 403 + `requirementId`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Vendor credentials**      | AES-256-GCM at rest, fresh IV per encryption, key from Secret Manager with **no default** — a missing key is a boot failure, not a table of plaintext bank credentials                                                                                                                                                                                                                                                                                                                                                                 |
| **Biometrics**              | The Stripe adapter throws on an `sk_live_` key unless explicitly allowed; the deploy fails the build if `/api/health` ever reports live identity                                                                                                                                                                                                                                                                                                                                                                                       |
| **Headers**                 | Helmet, plus COOP `same-origin-allow-popups` (strict COOP hangs the Google popup) and a CSP naming the Google and Plaid script origins                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Proxy trust**             | `TRUST_PROXY` is a **hop count**, not `true`, so a client cannot spoof `X-Forwarded-For` and forge the IP recorded on a consent                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Validation**              | Zod per route; every `:id` is a UUID; a document's `satisfiesRequirementId` must exist in the registry                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Deletion**                | `DELETE /api/auth/me` deletes the `User` row and relies on schema cascades; a test reads the schema and fails if any child relation lacks `onDelete: Cascade`. Refused with 409 while the person's party holds a borrower row on somebody else's application, because the cascade would take them out of it                                                                                                                                                                                                                            |
| **AI safety (schema)**      | A trigger blocks an `AI_AGENT` principal from writing the top confidence tiers. An AI filling a gap with a plausible value is exactly how "we do not know" becomes "we checked and you passed"                                                                                                                                                                                                                                                                                                                                         |
| ⚠ **CSRF**                  | **None.** What stands in for it is `sameSite: lax` alone. The "every mutating route needs a JSON body" argument does not generalize — `POST /files/:id/credit`, `/payroll`, `/irs`, `/identity-verification`, `/intent-to-proceed`, every `DELETE` and `POST /auth/signout` parse no body at all                                                                                                                                                                                                                                       |
| ⚠ **Rate limiting**         | **None**, including on `/api/auth/google`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ⚠ **Health endpoint**       | `/api/health` is public and returns the first line of the underlying driver error on failure, which can disclose connection details — a host and port, or the Cloud SQL socket path — depending on how the connection failed                                                                                                                                                                                                                                                                                                           |
| ⚠ **Personal data at rest** | DOB, address, phone and email sit in plain columns. No retention window, no privacy policy beyond `/privacy`                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Environments & Branching

⚠ **There is one deployed environment.** The table is short on purpose.

| Environment | Branch         | Database                                              | URL                                    |
| ----------- | -------------- | ----------------------------------------------------- | -------------------------------------- |
| Development | `main` (local) | `homestead_mortgages` on `localhost:5433`             | API `:8080`, web `:5173`               |
| Staging     | `main`         | `homestead-mortgages_staging` (as Terraform names it) | `homestead-mortgages-staging-…run.app` |
| Production  | —              | —                                                     | Does not exist                         |

**Branch flow**: work happens on `main`; a push to `main` deploys. There is no
`pull_request` trigger, so the check job — types, lint, generated-file
verification, real-Postgres tests — runs only _after_ a merge. There is no
promotion path, no rollback step, no canary, and no traffic splitting: Terraform
pins 100% to `LATEST` and the `gcloud` deploy takes the default.

⚠ Terraform and the shipping path describe different services. Terraform sets
`CORS_ORIGIN` and `ALLOWED_DOMAIN` and omits `STATE_GALLERY`; the deploy sets
`STATE_GALLERY=true` and neither of the others. A `terraform apply` after a
deploy would revert the running configuration.

⚠ `CONNECTOR_MODE=fixture` is shipped and is now cosmetic — the same deploy
selects Plaid, Stripe and Google Places individually, which the code honors. The
variable only feeds what `/api/health` prints.

## CI/CD Pipeline

```
push to main  (.github/workflows/deploy.yml — the only workflow)
     │
  [check]  postgres:16-alpine service on :5433 — same image and port as
     │     docker-compose.yml, so one DATABASE_URL works in both places
     ├─ npm ci · db:generate
     ├─ requirements:verify   ◄── fails on drift from data/v1-build.csv
     ├─ brand:verify          ◄── fails on drift from tokens.mjs
     ├─ tsc -b (7 workspaces; packages/brand has no tsc build) · lint
     ├─ db:test:setup  ── creates <db>_test and applies EVERY migration to it;
     │                     the only check that migrations apply to an empty DB
     └─ npm test · npm build
     │
  [awaiting-oauth-client]  runs only when vars.GOOGLE_CLIENT_ID is empty and
     │                     warns — so nothing ships a sign-in page that cannot work
     ▼
  [deploy]  gated on GOOGLE_CLIENT_ID being set
     ├─ Workload Identity Federation (keyless; no SA JSON key in the repo)
     ├─ docker build → Artifact Registry, pushed in up to 3 attempts with
     │                 10s/20s backoff (an observed transient 502 on the push)
     ├─ cloud-sql-proxy v2.14.1 → npm run migrate:deploy
     ├─ gcloud run deploy  --set-secrets (×6)  --set-env-vars  --allow-unauthenticated
     │
     └─ THREE post-deploy assertions, any of which turns a green deploy red:
          1. allUsers really is bound as run.invoker  ── read back, not assumed
          2. /api/health reports the vendors the deploy asked for,
             and fails if it ever reports "stripe-identity (LIVE)"
          3. /api/health reports "database":"ok"  (6 tries, 10s apart)
```

Assertion 3 exists because a malformed Cloud SQL socket path once produced a
deploy where every route anyone tested passed and the first real sign-in 500'd.

⚠ CI never runs Terraform, never runs `format:check`, and downloads
`cloud-sql-proxy` at deploy time with no checksum verification.

## Testing

**The API tests talk to a real Postgres and mock almost nothing.** This is a
decision, not an accident. Every promise this product makes — who may read whose
file, that cascades delete what they say they delete, that a stage only moves
forward — is kept by the database, and a suite that mocks `@hm/db` can see none
of them. `assertFileAccess` used to be asserted by checking that `findUnique` had
been called; that assertion cannot fail when a column is renamed.

```bash
docker compose up -d postgres
npm run db:test:setup     # creates <db>_test, applies every migration
npm test
```

The suite truncates every table between tests, which is why it uses a separate
`_test` database — a developer running `npm test` should not lose the file they
were halfway through. It found a live lost-update race in `advanceStage` on its
first run.

The one deliberate exception is `vendor-tokens.test.ts`, which stands an
in-memory `fakePrisma()` in for the `vendorToken` delegate, because what it tests
is the encryption and not the storage.

⚠ **Nothing drives the real Express app end to end.** `app` is never exported
from `index.ts`, so no test exercises routing, `requireAuth`, the API 404 or the
error handler over HTTP. The one HTTP-level test, `headers.test.ts`, boots a
purpose-built app carrying only `securityHeaders()` and fetches it over a real
socket, because the COOP/CSP failures it guards against are invisible to an
in-process assertion.
⚠ **No component tests exist** either — the web suites read `.tsx` files as text
and test pure functions, so the routing, the branch rendering and the BankPage
state machine are unverified.

## Observability

⚠ **There is none, and this is the largest single gap in the system.**

No request log, no request id, no structured logging, no error tracking, no
metrics, no tracing, no uptime check, no alerting. The entire logging surface is
six `console.log` boot lines and two `console.error` calls. In production that is
unstructured stdout scraped into Cloud Logging, with no way to correlate a
borrower's 500 with a log line.

⚠ There is also **no graceful shutdown** — nothing handles `SIGTERM` and nothing
disconnects Prisma. With `--min-instances 0`, Cloud Run tears instances down
routinely, so in-flight requests and open connections are dropped at the default
grace period.

## The design system

The product wears **Supermortgage**: black ground, one red accent, Georgia
display, Helvetica text. `docs/brand.md` documents the identity; `packages/brand`
is how it reaches a screen.

```
primitives   gray-600, red-500, serif           named by what they ARE
semantic     rule → gray-600, accent → red-500  named by what they are FOR
outputs      border-rule, --sm-color-rule       generated; never hand-edited
```

**To change a color or a font, edit `packages/brand/tokens.mjs` and run
`npm run brand:build`.** That is the whole procedure for every product surface,
and it is why the package exists. ⚠ The one exception is the pixel street in
`scene.css`, which hardcodes `#153a1c` and `#101014` in its ground gradient —
marketing scenery no token edit reaches.

Tailwind's default palette is **replaced**, not extended: there is no
`text-gray-500`, no `bg-white`, no `font-sans`. A value that is not a token
cannot reach a component by accident, and a typo'd class generates nothing rather
than silently working. `apps/web/src/index.css` is four `@import`s from
`@hm/brand` and the three `@tailwind` directives — no declaration of its own, and
a test enforces both that and the import ordering (an out-of-place `@import` is
dropped by PostCSS, so the build succeeds and ships with no component layer).

Two rules are tests, not guidance: the WCAG contrast floors are computed from the
tokens themselves and fail the build on a bad edit, and `danger` may never be the
accent — red means "you can act on this", and a screen that also uses red for
"something is wrong" has made both meaningless.

## Built, or designed

`docs/states.md` is the model for user states and account states. Its own status
table, verified against the schema:

| Piece                                          | Status                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FlowStage`, five screens, decision outcomes   | **Built**                                                                                                                                                                                                                                                                      |
| Tests against a real Postgres                  | **Built**                                                                                                                                                                                                                                                                      |
| Party, facts, principals                       | **Built** and wired: screen 2 asserts facts on the party, every reader projects from them                                                                                                                                                                                      |
| Authorizations and the purpose token           | **Built** and used: every pull is minted a token for one party under a live grant, and the adapters refuse without one                                                                                                                                                         |
| Applications, scenarios, the transition ledger | **Built**: `POST /api/files` births an application, its scenario and the ledger; the machine moves it                                                                                                                                                                          |
| Co-borrowers                                   | **Built**: named, invited by an emailed link, claimed by Google sign-in as a merge, walking their own half — screen 2, Section 5, their own bank, demographics, one signature — with the read redacted in both directions, and the engine reading everybody's reports by party |
| The Desktop Underwriter submission             | **Built** and wired: the decision route assembles, gates, emits, sends and records after every decision, refusals as rows. ⚠ Waits on a vault for taxpayer identifiers and on the endpoint, credential and seller/servicer number; placeholders are refused in production      |
| Loans and servicing                            | **Built** as tables and a machine (`createImportedLoan`, the claim edge); ⚠ no importer, no ingest route, no machine credential                                                                                                                                                |
| Roles and staff tooling                        | Designed — there is no role on `User`, so an underwriter cannot open a file at all                                                                                                                                                                                             |
| Monitoring, notifications                      | Designed, deferred                                                                                                                                                                                                                                                             |
| Notice generation and delivery                 | ⚠ Resend is integrated behind a `mail` port and sends exactly one message, the co-borrower invitation; no regulatory notice is generated or delivered                                                                                                                          |

That last row governs more than it looks like it does. Several regulatory clocks
can only be _stopped_ by a delivered notice, so until a notice can be sent, a
clock whose satisfying channel is unconfigured **must not be opened** — either
the application is not taken, or the clock opens tolled with the reason
recorded. Opening them on schedule with no way to satisfy them would write a
permanent, tamper-evident record of a breach we never had the means to avoid.

### Other known stubs

- **Address autocomplete against the fixture is three addresses.** Anything else
  falls back to manual entry with no property card, and the UI says so.
- **Manual bank-statement upload collects filenames and sends nothing.** Document
  upload records metadata with `storageUri: "fixture://content-not-transmitted"`.
  Where the bytes go is a real decision.
- **`currentHousing` is nullable, and screen 3 is what fills it.** It was
  `String @default("rent")` NOT NULL and screen 2 sent the literal `"rent"`;
  the column, the route and the screen all stopped manufacturing it together.
  `du_residences` holds the real answer, `POST /files/:id/declaration` writes
  both, and the column is a derived copy of that row. Until somebody answers it
  reads back NULL, and `renter_limited_mortgage_history` answers "cannot know
  yet" rather than calling an unasked borrower a renter.
- **Property corrections are recorded, not applied.** A disagreement with the
  county record writes a `FileEvent` and changes nothing the engine reads.
- **The monitoring loop does not exist.** `persistentMonitoringEnabled` and
  `nextSyncDueAt` are indexed together for a scheduler nobody has written; the
  route answers `{scheduled: false}`.
- **Seven vendor decisions are outstanding** — credit tri-merge, payroll
  aggregator, IRS IVES, e-sign, OFAC screening, the lien/O&E search, and
  pricing. (`docs/decisions.md` lists five; it predates the screening and liens
  ports.) Plus the CLS-* closing sheet, a real tax/insurance source, the real
  LLPA matrix, a real fee table, and a mortgage-insurance rate card — the one
  input that keeps every loan above 80% LTV at `referred`. The APOR is no longer
  on this list: the CFPB's published table is fetched daily and cross-checked
  against their own method. Neither is the DU transport: it is built, and waits
  on the integration agreement's numbers.
- **Our NMLSR numbers are placeholders** until `ORIGINATION_COMPANY_*` and
  `LOAN_ORIGINATOR_*` are set; `/api/health` reports `originator: placeholder`
  until then, and a production assembly refuses a row carrying one.
- **CI cannot authenticate to GCP** until this repository is added to the Workload
  Identity provider's attribute condition and to `hm-github-actions@`'s
  `workloadIdentityUser` binding — per `docs/decisions.md`, which is in tension
  with the live URL recorded in the same file. See Infrastructure.

## Where the reasoning lives

- `docs/decisions.md` — what was decided, what is assumed, what is known wrong
  and shipped anyway, and why the tests need a real database
- `docs/states.md` — the user-state and account-state model, both halves, with
  the built/designed boundary marked throughout
- `docs/requirements.md` — the registry and the three questions it keeps apart
- `docs/du-readiness.md`, `docs/du-graph.md`, `docs/du-generation.md` — what a
  Desktop Underwriter submission is, what it needs, and where the generated
  tables come from
- `docs/entities.md` and `docs/loan-lifecycle.md` — the nouns, who writes them,
  and the loan side
- `docs/brand.md` — the Supermortgage identity and what adopting it took
- `CLAUDE.md` — the rules that are not style preferences

⚠ **`README.md` and parts of `docs/decisions.md` are stale and should not be
cited as current.** The README says all five connectors are fixtures (three of
eleven ports now have real adapters) and lists five ports where there are
eleven.
`docs/decisions.md` says `allUsers` cannot be bound and that access means
`gcloud run services proxy`, while the deploy binds `allUsers` and fails the
build if it is absent; it also says `hm-run@` has accessor on "exactly two
secrets" — as does the header comment in `.github/workflows/deploy.yml` — while
the deploy mounts six. Quote the code, not these paragraphs.
