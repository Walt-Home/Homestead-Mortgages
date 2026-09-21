# @hm/servicing

Doug's servicing platform, running as its own app in this monorepo on a
database of its own. Everything under `src/`, `db/`, `spec/`, `docs/`,
`fixtures/` and `tools/` is his, byte for byte, at the commit `VENDORED_FROM`
names; the files beside those directories are ours. It is a testing ground
and a reference, not production: every vendor in it is an in-repo FAKE, and
`INTEGRATIONS=fake` is the only mode that has ever run.

## Run it

```bash
# once: the database, separate from ours (his tables collide with ours by name)
SERVICING_DATABASE_URL=postgresql://homestead_mortgages:homestead_mortgages@localhost:5433/homestead_servicing
npm run servicing:db:setup

npm run dev -w @hm/servicing        # the API, the sweep endpoint and the ops console on :8090
npm run seed-demo -w @hm/servicing  # 100 serviced loans, the entry demo, the 12-loan partner book
npm run sweep -w @hm/servicing      # one pass of every scheduled job
```

Every `/v1` route wants `Authorization: Bearer $SERVICING_API_TOKEN`; unset
outside production the token is `dev-token`, as in his own README. The
variables `scripts/run.mjs` maps are listed at the top of that file; anything
else his config reads passes through under its own name.

Our API reads it through the `servicing` connector port when
`SERVICING_PROVIDER=supermortgage` and `SERVICING_API_URL` name it; the
token is the same variable, so one `.env` line serves both ends. Unset, the
port's fixture answers what his engine answered for the sample book, and
nothing here needs to be running. See `docs/decisions.md`, "The servicing
platform is read, never joined".

What is on the other side, from his `src/runtime/server.ts`:

| Surface                                       | What it is                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/tools`                               | every tool on the command bus                                           |
| `POST /v1/loans/{id}/tools/{process}/{name}`  | execute a tool for a loan, through his guardrails, as a named actor     |
| `GET /v1/loans/{id}/events\|timers\|ledger`   | a loan's record                                                         |
| `POST /v1/transfers/batches`, `/batches/demo` | board a servicing-transfer batch (his §1)                               |
| `POST /v1/partner-book/imports`, `/seed-demo` | his §33.1 tape import (ours is `POST /api/partner/book/imports`)        |
| `POST /v1/sweep`                              | one sweep, the same pass the `sweep` mode runs                          |
| `/ops`                                        | the operator portal, behind a staff sign-in (`staff-bootstrap <email>`) |
| `/v1/borrower/*`, `/v1/partner/*`             | his borrower and partner APIs; their front ends are not here            |

## Test it

```bash
npm run test:servicing                                   # his tests, as his: node --test, a database per file, then his du:verify
npm run test:servicing -- --test-shard=1/4               # anything after -- goes to node --test
npm run test:servicing -- src/runtime/demo-clock.test.ts # a file named on the command line runs alone
REQUIRE_DB=1 npm run test:servicing                      # fail rather than skip when Postgres is unreachable
```

Run it from the root, as above: his manifest contract (23.6-T11) has the
test script end with `npm run du:verify`, and that step spawns `node` on a
`.ts` tool, which Node below 22.18 refuses without the type-stripping flag.
The root script carries the flag in through npm's `node-options`; the runner
carries it into his tests' own child processes. On 22.18 and later it is a
no-op.

Five of his tests are timed, and a laptop with Postgres in Docker is
slower than the Linux runner they were written against. `demo-clock.test.ts`
advances the demo clock 45 days through the sweep inside his 240-second
budget; here each day takes four to twelve seconds and it stops at day 37.
His 35.11 hosted-measurement trio posts all 1,575 tools over HTTP at a probe
database and passes on its own, but not while the other 294 files are
running beside it. Those five fail here under a full run and pass on a
runner; the other 3,518 pass on a laptop in about twenty-three minutes
(21 September 2026). CI runs the whole thing in a job of its own.

Two tools have to be on the machine: `psql`, for his `migrate.sh`, and
`xmllint`, which his DU schema module shells out to and throws without (his
Dockerfile installs `libxml2-utils`; macOS ships it; a GitHub runner does
not, and every journey that reaches the DU moment fails without it). The
database is `SERVICING_TEST_DATABASE_URL`, or our test URL with the name
swapped to `supermortgage_test` (his harness asserts that base name); the user needs `CREATEDB`. The first run
builds a migrated template (about thirty seconds); every file then clones it
in under a second and drops its clone on exit. The seven suites that build his
Next.js apps under Chromium are left out, because those apps are not here.

## What it is for

The servicing plan (`docs/decisions.md`, "Doug's servicing runtime is an app
in this repo") uses this three ways: as the reference for how a servicing
section is built, as the platform our API reaches over HTTP for what it does
not do itself, and as the place a real loan can be serviced end to end
before any of it is rewritten onto our model. Nothing in our API imports
from this tree, and nothing here imports from ours.

## Re-sync

```bash
node scripts/vendor-supermortgage.mjs <commit>
```

re-copies this tree, `packages/kernel` and `packages/partner-book`'s xlsx
reader from one clone at one commit. Then update `VENDORED_FROM` and run the
typecheck and the tests.
