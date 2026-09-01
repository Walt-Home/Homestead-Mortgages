# Decisions, assumptions, and things that are known wrong

Written down because the dangerous items in this codebase are not the missing
ones — those are obvious. They are the plausible ones.

## Decided

**Connectors are simulated behind real interfaces.** Five ports in
`packages/connectors/src/ports`, fixture adapters behind them, no vendor
contracts yet. Swapping in a real vendor is a new file in `adapters/` and one
line in the registry. The fixtures enforce the same authorization guard a real
adapter must, and they simulate latency, because a fixture that resolves
instantly hides every missing spinner.

**The AUS is ours, and says so.** Screen 8's 18 UW-* requirements all hang off
a DU or LPA submission we cannot make without a seller/servicer number. The
shadow engine computes the same shape from the same inputs and stamps
`engine: "shadow"` on every stored result, so no decision is ever ambiguous
about what produced it. The UI states it plainly. This is also what makes
"show the reasoning, not just a verdict" possible at all — a real DU
submission returns a verdict we could not decompose for a borrower.

**Scope is onboarding through decision.** Screens 1–9 against the 77
requirements. The monitoring loop is modelled but not built: `ConnectorLink`
carries `persistentMonitoringEnabled` and `nextSyncDueAt`, decisions and
connector snapshots are append-only so a re-evaluation has something to diff
against, and `FileEvent` is written from day one. Nothing schedules a re-pull.

**Its own GCP project.** The database moved off Walt's shared instance first,
and then the whole thing moved out of Walt's project. Own Cloud SQL, own
Artifact Registry, own Workload Identity pool, own service accounts, own audit
log. It was done while the database held nothing but fixtures, which is the
only cheap moment it will ever have.

**Its own database instance, not a database on Walt's** (the step before that).
The first cut put `homestead_mortgages_staging` on the shared `homestead-mortgages-db` alongside
`walt_prod` and `homestead_prod`. Wiring up the credential produced the
argument against it: Cloud SQL users are instance-scoped, so `homestead_mortgages_app`
could authenticate against `walt_prod`. Verified it reads nothing there — 0 of
98 tables — but "authenticated, reads nothing" holds only as long as every
table grant stays correct, and the failure mode is a mortgage app with a
foothold in a live consumer database. `homestead-mortgages-db` is a separate
ENTERPRISE-edition instance, db-g1-small, roughly $25/month, in the same
project. Point-in-time recovery, maintenance windows and CPU are now ours too.

**Its own runtime identity, not Walt's.**
Same class of problem as the instance, one layer up, and worse. The deploy
originally ran as `hm-run@`, which holds **project-wide**
`secretmanager.secretAccessor` and `storage.objectAdmin` — so this container
could have read every secret in the project (Anthropic, Twilio, Resend, Walt's
own `DATABASE_URL_PROD`) and deleted objects from Walt's buckets. Nothing in
the code would have done that; the point is that nothing structural stopped it.
`hm-run@` now holds `cloudsql.client` and accessor on exactly two secrets,
granted on the secrets rather than the project.

**HMX monorepo shape.** Turbo, Prisma, Terraform, npm workspaces. Palette and
type stacks ported from Homestead; the component layer was not, because
Homestead's own design doc reports eleven of fourteen kit components have zero
consumers and this product needs form surfaces that kit never had. Two of
Homestead's documented inconsistencies are fixed rather than copied — see the
header comment in `apps/web/src/index.css`.

**Google sign-in, restricted to the Workspace domain.** The OAuth app is
Internal to trywalt.ai, so Google refuses non-domain accounts before a token
exists. The domain is re-checked in `services/auth.ts` anyway: the Internal
setting is console configuration that a future click can loosen silently, and
the audience check says nothing about which domain a user belongs to. The
check that lives in the repo is the one that shows up in review.

Sessions are server-side in Postgres rather than a stateless signed cookie.
Stateless would have been less code and would also have meant no way to sign
anyone out — for something that will eventually front borrower files, ending a
session has to be possible before it is needed.

**Files belong to people, with a shared demo set.** Each person sees their own
files. The three seeded fixture personas are readable by everyone and writable
by nobody, so the team has a common artifact to critique without anyone's real
file becoming shared.

## Assumed, and load-bearing

**Escrow.** PITIA drives DTI and DTI drives the recommendation, but the flow
collects no tax bill and no insurance quote. `calculations.ts` uses national
averages (1.1% annual tax, 0.35% insurance, of value). These are wrong for any
specific property — a Texas tax bill is roughly double — and every derivation
that uses them says so in its formula string. **Replacing this with a real tax
and insurance lookup is the single highest-value accuracy improvement
available.**

**Retirement haircut.** Retirement assets count toward reserves at 60% of
vested balance. Real guidelines vary by whether the borrower is eligible for
withdrawal and by investor.

**Thin file.** Under three tradelines. Fannie's actual rule is "insufficient
tradelines to generate a score", which is a bureau behaviour rather than a
number; three is the industry proxy and matches CRD-013's own ask for three
alternative references.

**Recent derogatory.** 24 months, matching the tri-merge's payment history
window. The sheet does not define "recent".

## Known wrong, and shipped anyway

**The LLPA grid in `pricing.ts` is illustrative.** The shape is right — additive
basis points, each traceable to the attribute that caused it — and the numbers
are the wrong kind of wrong: plausible enough to be believed. Drew's sheet
assigns UW-010 a failure severity of "Financial loss", which is what
mispricing means. Wire the real agency matrix before anything is quoted to
anybody.

**The thresholds in `guidelines.ts` are dated.** QM points-and-fees tiers, the
conforming loan limit and the APOR comparison all adjust annually.
`thresholdsReviewedFor: 2025` is stamped so a decision made against stale
numbers is identifiable after the fact. Before this underwrites anything real
they need to come from the FFIEC tables and the CFPB's annual adjustments, not
from a constant in a repo.

**`refi_ntb_required` cannot return false.** The state list and the investor
overlay list are product configuration we do not have, so on a refinance the
condition answers `null` rather than guessing. It is the one condition whose
negative case we cannot currently prove.

**Business days ignore federal holidays.** `addBusinessDays` skips weekends
only. The Loan Estimate deadline it computes will be optimistic in a week
containing a holiday.

## Operational gotchas that cost real time

**Secret values must not end in a newline.** A secret created from a file
written by `python3 -c "print(...)"` carries a trailing `\n`. Cloud Run injects secret bytes into the environment verbatim,
and a newline in an env var value makes the container fail to start — with
**no container logs at all**, reported only as the generic "failed to start and
listen on the port." Docker passes the same value through happily, and `$(...)`
in a shell strips it, so it reproduces nowhere except Cloud Run. Create secrets
with `printf '%s'`, never `print()` or `echo` without `-n`.

**Build the container locally before letting CI find the bugs.** Two of the
three deploy failures in this repo's first hour were things a local
`docker build` catches in ninety seconds.

## Privacy posture

**SSN never lands in Postgres.** `borrowers` holds `ssn_last4` for display and
`ssn_vault_handle`, an opaque reference. Only three call sites in the entire
sheet need the real number — the credit pull (CRD-001), the SSA-89 validation
(CRD-011) and the 4506-C (INC-008) — and all three are server-side. The
prototype simulates the vault exchange client-side so that no code above ever
learns to expect a plaintext SSN in a request body. A migration adding a
plaintext SSN column is the single change most likely to turn this prototype
into a breach.

**The prototype runs on fixture borrowers.** No real PII should enter it while
`CONNECTOR_MODE=fixture`, and the Cloud Run service is deployed
`--no-allow-unauthenticated` because a URL is not an access control.

**Consent IPs are evidence.** `TRUST_PROXY` is a hop count and never `true`.
With `true`, a client can forge `X-Forwarded-For`, and a consent record whose
IP was chosen by the signer proves nothing.

## Google sign-in — the one manual step

Google removed every API for creating OAuth clients: the IAP OAuth Admin API
that used to do it was shut down in March 2026 and now returns errors on new
projects. So the client has to be made in the console, once:

1. **APIs & Services → OAuth consent screen**, project `homestead-mortgages`.
   User type **Internal**. App name "Homestead Mortgages", support email
   joe@trywalt.ai. Internal is what limits sign-in to the Workspace — Google
   refuses non-domain accounts before a token exists.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Authorised JavaScript origins:
   - `https://<the Cloud Run URL>`
   - `http://localhost:5173`
   No redirect URIs are needed. Google Identity Services returns the ID token
   to the page; there is no server-side redirect leg and therefore no client
   secret to keep.
4. Copy the client id and set it:
   `gh variable set GOOGLE_CLIENT_ID --repo Walt-Home/Homestead-Mortgages`

The deploy job is skipped while that variable is empty, so nothing ships a
sign-in page that cannot work. The client id is public — it is embedded in
every page offering the button — which is why it is a repo *variable* and not
a secret.

## Still outstanding

Five vendor decisions plus sandbox credentials, none obtainable from inside
this repo:

| Connector | Constraint |
|---|---|
| Credit (soft tri-merge) | Reseller or bureau-direct; needs FCRA permissible purpose |
| Bank (12-month asset report) | **Must be a DU-authorized vendor** — CRD-017 says so explicitly |
| Payroll (consumer-permissioned) | Aggregator |
| IRS transcripts | IVES participant or a reseller |
| E-sign | For APP-005, APP-012 and INC-008 |

Plus: the CLS-* closing-stage sheet, the requirements for the monitoring loop,
a real tax/insurance source, the real LLPA matrix, and an APOR feed.

## One-time infrastructure prerequisite

CI cannot authenticate to GCP until `Walt-Home/Homestead Mortgages` is added to the
Workload Identity provider's attribute condition and to
`hm-github-actions@`'s `workloadIdentityUser` binding. Both currently
allowlist exactly two repositories. The two commands are in the header of
`.github/workflows/deploy.yml`.
