# Homestead Mortgages

Onboard a homebuyer, retrieve almost everything underwriting needs from
connected accounts rather than uploads, and give them a decision that explains
itself.

Built against Drew's V1 flow sheet (`data/v1-build.csv`) — 77 requirements
across nine screens, with the dependency graph and applicability conditions
made executable rather than left as prose.

## Quick start

```bash
docker compose up -d postgres
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

API on `:8080`, web on `:5173`.

## What is here

| Package | What it is |
|---|---|
| `packages/requirements` | The 77 requirements as a typed registry, with a condition predicate and a satisfaction evaluator for each, plus the dependency graph hiding in the timing column |
| `packages/underwriting` | The shadow AUS — ratios, reserves, compliance tests and pricing, every number carrying its own derivation |
| `packages/connectors` | Ports for credit, bank, payroll, IRS and e-sign, with fixture adapters and the authorization guard |
| `packages/shared` | Domain types. `LoanFile` is the object everything reads |
| `packages/db` | Prisma schema. Relational for what we query, JSONB snapshots for what a vendor actually said |
| `apps/api` | Express 5 |
| `apps/web` | React 19 + Vite. Palette and type stacks ported from Homestead |

## The three things worth knowing before changing anything

**1. The registry is generated, and the generator refuses to guess.**
`data/v1-build.csv` is the source of truth. `npm run requirements:build`
regenerates `packages/requirements/src/generated.ts`; `npm run
requirements:verify` fails on drift and runs in CI. Every mapping in the
generator is exhaustive — a new screen, source, condition or timing phrase
stops the build rather than landing as a silent default.

**2. Applicability is three-valued.** A condition returns `true`, `false`, or
`null` for "we cannot know yet". Collapsing `null` into `false` tells a
borrower they are finished right before the credit pull adds four more
requirements. `progress()` counts only requirements that definitely apply, for
the same reason — see the comment there, and the regression test that caught
it going backwards.

**3. Nothing may be pulled before APP-005.** The authorization guard lives
inside the connector adapters, not in the routes, and `guard.test.ts` calls
every adapter against an unauthorized file and fails if any returns data.

## Not built, deliberately

- **Real connectors.** All five are fixtures behind real interfaces. Vendor
  selection and sandbox credentials are outstanding — see `docs/decisions.md`.
- **A real AUS.** The decision comes from our own engine, stamped
  `engine: "shadow"` on every stored result. It is not an agency
  recommendation and the UI says so.
- **The refinance monitoring loop.** Screen 9 records persistent consent and
  the schema models connection liveness and an event stream, but nothing
  re-pulls on a schedule. The requirements for that loop do not exist yet.

## Docs

- `docs/requirements.md` — how the registry works and how to change it
- `docs/decisions.md` — what was decided, what is assumed, and what is known wrong

## Infrastructure

Runs in Walt's GCP project on its **own** Cloud SQL instance (`homestead-mortgages-db`).
Not Walt's instance: Cloud SQL users are instance-scoped, so sharing one would
let this app's role authenticate against `walt_prod`. See `docs/decisions.md`.
