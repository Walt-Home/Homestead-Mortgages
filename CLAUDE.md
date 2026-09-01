# SuperMortgage

Mortgage underwriting onboarding, built against Drew's V1 flow sheet. Read
`docs/requirements.md` before touching anything in `packages/requirements`, and
`docs/decisions.md` before trusting any number the engine produces.

## The shape

npm workspaces + Turbo, following the HMX pattern. Express 5 API, React 19 SPA,
Prisma against Postgres, Terraform for the GCP pieces this repo owns.

```
data/v1-build.csv          source of truth for WHAT must be satisfied
packages/requirements      the 77 requirements, executable
packages/underwriting      the shadow AUS
packages/connectors        five ports, fixture adapters, the authorization guard
packages/shared            domain types; LoanFile is the object everything reads
packages/db                Prisma
apps/api                   Express 5
apps/web                   React + Vite
infra                      Terraform
```

## Four rules that are not style preferences

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
applicability is unknown made the satisfied count go *backwards* across the
payroll connection (23 → 21, five requirements at once). There is a regression
test; do not relax it.

**3. Nothing may be pulled before APP-005.** The guard is inside the connector
adapters, not the routes, so a new route cannot forget it. `guard.test.ts`
calls every adapter against an unauthorized file and fails if any returns data.
The e-sign adapter is deliberately unguarded — it is how the authorization gets
signed, and guarding it would make APP-005 unobtainable.

**4. Every number on screen 8 comes from a recorded derivation.** Nothing
reaches the `Decision` object except through `DerivationLog.record`, and a
computation that cannot run records `blocked` with what it is waiting for. A
figure with no explanation is a bug in the engine, not in the copy. The engine
also returns `refer` rather than `approve_eligible` when any input was blocked
— "we could not compute this" and "we computed it and you passed" must never
collapse into the same checkmark.

## Storage

Relational tables are what the product queries. `connector_snapshots` and
`decisions` are **append-only**: a re-pull writes a new row, a recomputation
writes a new decision. That is what makes the monitoring loop expressible —
"your situation changed" is a diff between two snapshots, and you cannot diff
against a row you overwrote. Nothing in this repo updates a snapshot.

SSN never lands in Postgres. `borrowers.ssn_vault_handle` is an opaque
reference; `ssn_last4` is display only.

## Where this shares infrastructure

Walt's GCP project (`walt-489214`) and Walt's Artifact Registry. **Not** Walt's
database instance — SuperMortgage has its own, `supermortgage-db`.

That was not the first plan, and the reason it changed is worth keeping:
**Cloud SQL users are instance-scoped, not database-scoped.** With the database
on the shared `walt-db`, the `supermortgage_app` role could open an
authenticated connection to `walt_prod`. It could read nothing — 0 of 98 tables
— but that posture depends on table grants staying correct forever, and this
product will eventually hold SSNs, credit reports and twelve months of bank
transactions. A separate instance makes the boundary structural rather than
maintained. It also decouples point-in-time recovery, maintenance windows and
CPU contention, all of which are instance-scoped.

The runtime identity is `supermortgage-run@`, not `walt-cloud-run@`, for the
same reason at the IAM layer: `walt-cloud-run@` carries project-wide
`secretmanager.secretAccessor` and `storage.objectAdmin`. Ours has
`cloudsql.client` and accessor on one secret, granted on the secret itself.

Terraform manages `supermortgage-db`, its database, its app role and the Cloud
Run service. It does **not** manage the shared Artifact Registry repo or the
WIF pool — those pre-date this repo and belong to Walt, and importing them
would let a `terraform destroy` here take down two live apps.

## Commands

```bash
npm run dev                  # API :8080, web :5173
npm test                     # all workspaces
npm run check                # tsc -b + registry verify
npm run requirements:build   # after editing data/v1-build.csv
npm run db:migrate           # prisma migrate dev
```
