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

**Google sign-in, open to any Google account.** Started as Internal to
trywalt.ai; widened when the prototype went out to friends and family, who do
not have Workspace accounts. `ALLOWED_DOMAIN` is now unset, which means the app
adds no restriction of its own — the OAuth consent screen is the only thing
deciding who Google will mint a token for.

Be clear-eyed about what that means: **the front door is open, and what
protects a person's data is ownership, not authentication.** `assertFileAccess`
is now load-bearing in a way it was not when everyone signing in was a
colleague. The 404-not-403 rule and its tests matter more, not less.

**Superseded: sign-in restricted to the Workspace domain.** The OAuth app is
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

## Two engine errors found by the readiness audit, and fixed

**QM was decided from DTI.** The 43% back-end limit everyone remembers was
replaced: since the CFPB's General QM Final Rule took mandatory effect in
October 2022, first-lien General QM is a **price test** — APR minus APOR
against a threshold that tiers by loan size. DTI must still be considered and
documented, which is what the ATR determination is for, but it does not decide
the question. Deciding it from DTI produced a confidently wrong legal
determination in both directions, and without APR and APOR the honest answer is
that we do not know. `compliance.ts` now blocks rather than guessing.

**PITIA omitted mortgage insurance and association dues.** The A in PITIA is
dues, and every conventional loan above 80% LTV pays MI. Omitting both
understated the housing payment for exactly the borrowers whose DTI is
tightest. The effect was not cosmetic: the thin-file fixture at 95% LTV showed
46.4% DTI and actually sat at 50.35% — over the maximum. It had to be resized
to a loan the borrower can genuinely carry. **A missing term in PITIA is a
borrower being told they qualify when they do not.**

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

**Helmet's `Cross-Origin-Opener-Policy: same-origin` breaks Google sign-in
invisibly.** The popup GIS opens gets a severed `window.opener`, so it cannot
post the credential back. The modal renders blank and never returns, with no
error in either window — and it looks exactly like an unregistered OAuth
origin, which is what we chased first. `same-origin-allow-popups` fixes it and
keeps the isolation that actually matters. `headers.test.ts` pins it, because
no other test can see it: the API is fine, the button renders, and only a real
browser doing a real popup exposes the fault.

**Secret values must not end in a newline.** A secret created from a file
written by `python3 -c "print(...)"` carries a trailing `\n`. Cloud Run injects secret bytes into the environment verbatim,
and a newline in an env var value makes the container fail to start — with
**no container logs at all**, reported only as the generic "failed to start and
listen on the port." Docker passes the same value through happily, and `$(...)`
in a shell strips it, so it reproduces nowhere except Cloud Run. Create secrets
with `printf '%s'`, never `print()` or `echo` without `-n`.

**`$VAR:us-central1` in zsh is not what you think.** zsh applies `:u` as an
uppercase history modifier to the parameter, so
`CONN="$P:us-central1:db"` with `P=homestead-mortgages` yields
`HOMESTEAD-MORTGAGESs-central1:db` — uppercased, and the `u` eaten. It went
into the Cloud SQL socket path inside `DATABASE_URL`, and the deployed service
could not reach its database at all for several hours. Always brace:
`${P}:us-central1`.

**A health check that cannot fail tells you nothing.** The bug above survived
because `/api/health` and every unauthenticated 401 answered perfectly without
touching Postgres — so a deployment with no database looked identical to a
working one. `/api/health` now runs `SELECT 1` and returns 503 if it cannot,
and the deploy workflow fails on that. Verify the thing that would break, not
the thing that is easy to check.

**Build the container locally before letting CI find the bugs.** Two of the
three deploy failures in this repo's first hour were things a local
`docker build` catches in ninety seconds.

## Real people, real data

The banner used to say "don't enter real personal information." That was the
safe thing to write and the wrong thing to ask — a mortgage flow tested
entirely with invented numbers teaches you nothing about how it feels to hand
over your own. Once people outside the company started testing, the banner
changed to tell the truth instead, and `/privacy` says in plain words what is
stored and offers a button that removes it.

Two things make that honest rather than decorative:

**The SSN never reaches the server.** The browser keeps the full number and
sends only the last four digits plus a fake vault handle. That was true before
anyone outside the company touched it; it is the reason this was defensible at
all.

**Deletion actually deletes.** `users → loan_files` cascades, and every child of
a loan file cascades from there, so removing an account empties the person out
of the database rather than flagging them. `deletion.test.ts` reads the schema
and fails if a new table arrives without `onDelete: Cascade`, because the
privacy page makes a promise and a missing cascade would quietly turn it into a
lie.

What is still NOT true, and should be said out loud: there is no privacy
policy, no encryption of the personal columns beyond what Cloud SQL does at
rest, and no automatic retention window. Date of birth, address, phone and
email sit in plain columns. That is acceptable for a prototype with a handful
of testers who have been told what it is. It is not acceptable for anything
more, and the gap should close before the audience grows.

## Privacy posture

**SSN never lands in Postgres.** `borrowers` holds `ssn_last4` for display and
`ssn_vault_handle`, an opaque reference. Only three call sites in the entire
sheet need the real number — the credit pull (CRD-001), the SSA-89 validation
(CRD-011) and the 4506-C (INC-008) — and all three are server-side. The
prototype simulates the vault exchange client-side so that no code above ever
learns to expect a plaintext SSN in a request body. A migration adding a
plaintext SSN column is the single change most likely to turn this prototype
into a breach.

**The prototype is PUBLIC and open to any Google account.** It was not always:
the service ran `--no-allow-unauthenticated` behind a shared passphrase until
the audience widened to friends and family. Today Cloud Run is
`--allow-unauthenticated` under a project-level exception to the org's Domain
Restricted Sharing constraint, `ALLOWED_DOMAIN` is unset, and the banner
invites people to enter real details.

What follows from that, and should be said plainly rather than left implied:
**this is a consumer-facing system holding real personal data.** Date of birth,
address, phone and email sit in plain columns. There is no privacy policy, no
retention window, and no encryption beyond what Cloud SQL does at rest. That is
a defensible posture for a handful of testers who have been told what it is,
and it stops being defensible the moment the audience grows or a real
application is taken.

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
4. **Authorised JavaScript origins must list every host the app is served
   from.** Cloud Run gives a service TWO live hostnames — the hash form
   (`SERVICE-HASH-uc.a.run.app`) and the numeric form
   (`SERVICE-PROJECTNUMBER.REGION.run.app`) — and browsers land on the hash
   form. Registering only one produces a **blank Google popup that never
   returns**, with no callback and no console error: identical to a hung
   network. Register both:
   - `https://homestead-mortgages-staging-dhlswvsiia-uc.a.run.app`
   - `https://homestead-mortgages-staging-193197012613.us-central1.run.app`
   - `http://localhost:5173`
5. **Audience must be External** if anyone outside trywalt.ai will sign in.
   Internal produces `Error 403: org_internal` at Google, before the app is
   ever reached.
6. Copy the client id and set it:
   `gh variable set GOOGLE_CLIENT_ID --repo Walt-Home/Homestead-Mortgages`

The deploy job is skipped while that variable is empty, so nothing ships a
sign-in page that cannot work. The client id is public — it is embedded in
every page offering the button — which is why it is a repo _variable_ and not
a secret.

## The org policy that shapes access

`constraints/iam.allowedPolicyMemberDomains` is set org-wide to customer
`C02l6gns3`, so `allUsers` cannot be added to any IAM policy under trywalt.ai.
That means no plain shareable link: Cloud Run answers 403 to an anonymous
browser no matter what the application would have done with the request.

Worth knowing about the failure mode — `gcloud run deploy
--allow-unauthenticated` does **not** fail when the org blocks it. It logs and
continues, and you get a service with no invoker bindings at all that returns
403 to everything, which reads exactly like a broken container. The workflow
now asks for `domain:trywalt.ai` instead, which the constraint permits, and
re-asserts it on every deploy.

Reaching it therefore means `gcloud run services proxy` on port 5173 — a
registered OAuth origin, so sign-in works unchanged. Two layers of Google auth
(the proxy's, then the app's) is redundant but not harmful.

If a plain link is wanted, someone in `gcp-organization-admins@` or
`gcp-security-admins@` has to grant this project an exception to the
constraint. That is a real loosening of an org-wide control and is deliberately
not something this repo can do to itself.

## What a borrower can and cannot do

A five-dimension audit of the flow found 35 verified defects, and the shape of
them was consistent: the product was built forwards-only. Every screen assumed
it was being seen for the first time, by someone who would never go back, never
refresh, and never close the tab.

The ones worth remembering, because the same mistake is easy to make again:

**Stage was a cursor, not a high-water mark.** Every connector wrote it
directly, so re-pulling your credit to look at it dragged the whole flow back
to the bank step. It is now monotonic (`services/stage.ts`) — where you are is
the URL, how far you got is the stage.

**Screens held their results in component state.** A refresh lost them, and
revisiting a completed step showed an empty form whose only button re-ran the
connector. Screens now read the file from the server (`lib/file.ts`).

**The 4506-C could not be signed.** The e-sign port and its fixture adapter
existed from the start and had no caller anywhere, so INC-008 was unsatisfiable
and screens 6–9 were unreachable behind it. The adapter was also stateful — an
envelope created on one Cloud Run instance could not be completed on another —
which would have been an intermittent, load-dependent failure the day it
scaled.

**The borrower's list was mostly not the borrower's.** Twenty-one outstanding
items, eleven of which were disclosures and derived arithmetic with no button
anywhere. Requirements are now classified by actor (`engine.ts`), and the rail
separates "your turn" from "we're handling". This matters more than it sounds:
burying two real actions under nine impossible ones makes the product look
broken to anyone who reads the list and goes looking for the control.

**Two requirements were unsatisfiable by construction.** CRD-013 counted rent
as at most one alternative reference and then demanded three, so a thin-file
borrower could never clear the requirement that exists for thin-file
borrowers. CRD-010 (OFAC) had no path at all.

### What still cannot be satisfied, on purpose

Eight requirements remain permanently outstanding on a real file, and all of
them are ours rather than the borrower's: the four disclosure deliveries
(APP-006, APP-008, APP-009, APP-010) and the compliance tests blocked on APR,
APOR and a fee schedule. **Recording "Loan Estimate delivered" when no Loan
Estimate was delivered would be a lie in an audit trail**, so the prototype
leaves them outstanding and labels them as ours. The consequence is that a file
reaches "approved with conditions" and never "clear to close", which is the
honest outcome for a product that has not generated a single disclosure.

## Vendors, one at a time

The registry used to be a single `CONNECTOR_MODE`: everything fixture or
everything real. Vendors do not arrive that way. Address autocomplete needs an
API key and an afternoon; a credit reseller needs an entity licence and a site
inspection. Each connector now reads its own variable and falls back to the
fixture, and `/health` reports the resulting mix.

**Google Places** implements one method of `PropertyDataConnector`. It knows
which addresses exist and nothing else — the assessor record, the valuation and
the flood determination stay with the fixture, and the adapter claims no
requirements at all, because APP-004 is satisfied by the public-record match
rather than by autocomplete.

**Stripe Identity refuses a live key** unless `STRIPE_ALLOW_LIVE_IDENTITY=true`,
and nothing sets it. This is not squeamishness about a few dollars per
verification. Live mode collects a real government ID and a real face scan from
everyone who walks the flow, friends and family included. Face geometry is
biometric data: Illinois BIPA and its equivalents attach consent, notice and
retention duties to collecting it, and BIPA carries a private right of action.
This product has no retention policy, which is documented above. Collecting
real biometrics into a prototype is the one integration mistake that cannot be
undone by deleting a row — test mode proves the entire integration against
Stripe's own sample documents and collects nothing real.

Verified against Stripe in test mode: a session is created with
`require_matching_selfie` (without it you have verified a document, not the
person holding it), `livemode: false`, and reads back with
`verified_outputs` expanded — unexpanded, a verified session returns nothing
about who was verified.

**Resend is the email vendor.** Chosen 3 September 2026; not yet integrated.
It matters more than a vendor pick usually does, because several regulatory
clocks can only be _stopped_ by a delivered notice. The Loan Estimate is due
three business days from the TRID application moment, and adverse action within
thirty days of a complete application — and with no delivery channel at all, a
system that opens those clocks on schedule is recording its own breach, on
every file, in an audit trail built to be tamper-evident. So until the
integration lands, a clock whose satisfying channel is unconfigured must not be
opened: either the application is not taken, or the clock opens tolled with the
reason recorded. A gap you can see is fine. Permanent evidence of a breach you
never had the means to avoid is not.

## Bank: Plaid, and CRA rather than Assets

CRD-017 wants "a 12-month asset verification report from an authorized DU
vendor". That phrase does not describe a bank-data feed — it names Fannie
Mae's Day 1 Certainty programme, and Day 1 Certainty is why the flow can be
four screens: a validated report is what lets INC-002 take deposits instead of
paystubs, which is what lets a salaried borrower skip the payroll step.

Plaid's ordinary **Assets** product returns the same transactions and carries
none of that status. The **CRA** products — `cra_base_report` and
`cra_income_insights` — are the ones issued as consumer reports under the FCRA.
They are enabled per account and are not on by default: a client id that works
for Assets fails at `/link/token/create` the moment the CRA products are named.
Sandbox needs no approval; production does.

Three consequences worth knowing before reading the adapter:

**The borrower is in the middle of the call.** Every other connector is a
server-side request. This one is create-session → the borrower signs into
their bank inside Plaid's own widget → the client hands back a `public_token`.
That is why `LinkSession` grew `requiresClientHandoff` and `fetchAssetReport`
can answer `pending` — a twelve-month report from a bank with slow history
takes minutes, and "still building" must not render as "failed".

**Plaid supplies the report; DU performs the assessment.** So
`vendorAuthorizedForDu` is true and `cashFlowAssessmentResult` stays undefined,
and CRD-017 reads "cash flow assessment not performed" — which is the truth
until there is a DU submission. Filling that field in would turn the
requirement green on the strength of nothing.

**Rent and alternative credit are derived here, not supplied.** Plaid does not
label a payment "rent". `detectRecurringObligations` groups outflows by
normalised payee and requires a consistent amount across consecutive months.
Two limits it does not hide: bank data cannot see a due date, so `onTime` means
"no month skipped" — the same test Fannie's own bank-statement rent history
uses (B3-5.4) — and a payee whose amount swings more than 25% around its median
is not treated as one obligation at all, because a false positive here reaches
an underwriter as a claimed credit reference.

Employment start dates became nullable in the same change. Deposits name a
payer and never a hire date, and `new Date("")` is an Invalid Date that would
have failed at the insert. Nothing in the registry computes from the field; it
is displayed.

### Assets mode, and what it deliberately does not claim

CRA products are enabled per account by a sales request, so `PLAID_PRODUCT=assets`
exists to make screen 3 walkable in the meantime. It is a real bank login
returning real transactions, and it is **not** a consumer report. So it reports
`vendorAuthorizedForDu: false`, CRD-017 reads "asset report did not come from a
DU-authorized vendor", INC-002 is not claimed, and income is _inferred from
deposits_ rather than determined by a vendor — which is why it can never reach
`incomeConfidence: "verified"`, however clean the pattern looks. "Verified" is
what lets a borrower skip the payroll step, and that is a claim only Day 1
Certainty earns.

The inference leans one way on purpose. Income is the figure that makes a
borrower look qualified, so: transfers between their own accounts are excluded,
the monthly figure is the median rather than the mean, small recurring credits
are ignored, and a payer whose amount swings more than 40% is not a salary.

### What running against the real sandbox changed

Five bugs survived a full unit suite and died on first contact with live data.
Recorded because four of them were invisible by construction:

**Liabilities were being counted as assets.** Plaid returns _every_ account at
the institution — mortgage, student loan, auto loan, credit cards — each with a
positive `balances.current` representing what the borrower OWES. The subtype
fallback mapped all of them to "checking". Against the sandbox that turned about
$150k of debt into $150k of verified assets. Accounts are now filtered to
`depository` and `investment`, and a loan account's transactions are excluded
too: a servicer's ledger is not the borrower's cash flow, and the mortgage
payment recorded there would double-count the one in their checking account.

**A coffee subscription counted as alternative credit.** Unclassified recurring
debits were returned with `kind: "other"`, and CRD-013 wants three twelve-month
references to extend credit to a thin file. A $4-a-month Starbucks and a
$12-a-month McDonald's both qualified. `classify` now returns null for anything
that is not rent, a utility, insurance or phone, and the caller drops it.

**`historical_balances` is daily, not monthly.** 357 rows for a year, each
sliced to `YYYY-MM`, gave 357 entries with the same month repeated — so
AST-001's "two months of history" check passed on one month of data.

**Asset reports key the id as `asset_report_id`**, not `report_id`, so every
stored snapshot had an empty id.

**And one that was not a bug:** the sandbox's canned payroll line
`ACH Electronic CreditGUSTO PAY` is recorded as `+5850` — an outflow. Plaid's
documented convention is positive-is-out, which the interest payment and the
refund in the same dataset both honour, so the default sandbox dataset simply
contains no realistic paycheque. Income inference finds nothing against it. Use
Link's custom-user seed (`user_custom` as the username, a transactions JSON as
the password) for data with a real deposit in it.

## The Link widget

No npm package. `react-plaid-link` does not remove the CDN dependency — it
injects the same `link-initialize.js` from cdn.plaid.com, which Plaid requires
and forbids you to bundle — and `loadGsi` in `SignInPage.tsx` is already this
repo's pattern for exactly that. The package also does not list its callbacks
as effect dependencies, so an `onSuccess` closing over state reads whatever was
current at mount; `components/PlaidLink.tsx` routes every callback through a
ref written each render, which makes that impossible rather than something to
work around.

Three hazards the component exists to absorb:

**onExit fires after onSuccess.** Teardown calls `exit({ force: true })` and
Plaid answers with `onExit` — after the success already being acted on.
Unguarded, that knocks screen 3 from "assembling" back to "connect your bank"
at the moment the report starts building. A `done` flag makes a post-success
exit a no-op, and the parent's handler uses the updater form as a second line.

**Silence.** If `frame-src` blocks cdn.plaid.com, or an ad blocker null-routes
it, the script loads, `create()` returns, `open()` runs — and then nothing. No
error, no callback, and an overlay whose close button lives inside the frame
that never booted. A 20-second watchdog, disarmed by `onEvent("OPEN")`, is the
only way to detect it.

**The page goes away.** OAuth institutions navigate the whole document to the
bank and back, so React state is gone on return and Plaid requires the _same_
link token to resume. `hm.plaid.attempt.v1.<fileId>` in localStorage carries
it. Per-file because a single global key meant two loan files in two tabs
overwrote each other; versioned so a later shape change cannot resurrect a
record the new reader misparses.

`/plaid/return` is a top-level route, not under `/f/:fileId`, because Plaid
forbids query parameters on a redirect URI — the file id cannot be in the path,
so the page recovers it from the record. It is a courier: it captures the
public token and hands the borrower back to screen 3, so exactly one component
talks to `POST /files/:id/bank`. Two writers would mean two rows in two
append-only tables for one pull.

**`PLAID_REDIRECT_URI` is unset by default and that is not laziness.** Plaid
rejects `/link/token/create` with INVALID_FIELD when the redirect URI is not on
the dashboard allowlist — for _every_ link token, not only OAuth ones. A
plausible-looking default takes the whole screen down until somebody happens to
register it. Unset, every non-OAuth institution works; `/health` reports
`plaid-assets (sandbox), no OAuth banks` so the gap is visible rather than
inferred.

### What the first live run changed

The CSP needed `cdn.plaid.com` in `script-src` **and** `frame-src`, and the
environment-matched API host in `connect-src`. `security-policy.ts` now holds
that once: `headers.test.ts` used to re-declare the whole helmet config, so it
asserted against its own copy and would have kept passing while the server
served something else.

Two things the run caught that no test had:

**A poll raced the token exchange.** StrictMode invokes the resume effect
twice; the second run polled before the first run's `/item/public_token/exchange`
returned, and the server answered NO_PUBLIC_TOKEN. The retry tolerance absorbed
it, which is precisely why it would have gone unnoticed. The effect now guards
on a `resumedFor` ref — the deps hold callbacks whose identity changes, so
"runs once" was never guaranteed by the dependency list.

**Tolerating consecutive poll failures earned itself immediately.** The first
successful end-to-end run went 202 → 502 → 202 → 202 → 201. Without the
tolerance the borrower would have seen "that connection did not go through"
and lost a bank link that was working.

## Screen 2 under a hosted identity vendor

Turning Stripe on made screen 2 impassable, and every piece of it looked fine
in isolation.

The screen scans the ID _first_ and uses what is on it to fill in name, date of
birth and address — so `/identity-document` created a session and immediately
read it back, requiring `verified`. A fixture verifies in place, so that held
for as long as everything was a fixture. Stripe returns `pending` the instant a
session exists, because the borrower has not been to Stripe yet. The route
threw DOCUMENT_UNREADABLE every single time, `identity` was never set, and the
Continue button it gates stayed disabled forever.

So the scan now answers 202 with the hosted URL and the borrower goes and does
the check. Four things that fell out of that, each of which broke something:

**The session has nowhere to live.** It is created before any borrower exists,
and `Borrower` requires a name, a date of birth and an SSN — the very things
the session exists to discover — so a placeholder row would mean inventing
them. It goes on `LoanFile.identityPrefillVerificationId`, and the completion
route reads the id from there rather than from the request: honouring a
client-supplied id would let any file owner read the name, date of birth and
home address attached to any verification whose id they could obtain.

**The redirect wipes the form.** Everything typed on screen 2 — and the income
screen 1 passed on router state — is gone on return. A draft in
`sessionStorage` carries it, minus the SSN, which is the one field that must
never sit in browser storage.

**Stripe returns no date of birth.** Its verified outputs carry name and
address; its own test identity has no `dob` at all. Refusing the whole result
over one absent field would strand a borrower whose ID genuinely verified, so
the screen shows a date field and says why: "Your ID confirmed your name and
address but not your date of birth."

**Continue sent them back to Stripe a second time.** The verification was
recorded against the file and the newly created borrower row was unverified,
so `/identity-verification` dutifully started another one. It now adopts the
file's verified session onto the borrower and answers `alreadyVerified`.

The return page routes on the presence of the draft, not on whether a borrower
row exists — the first version asked the latter and got it wrong, because a
file can already have a borrower from an earlier pass, and a borrower
re-verifying was shown the result of a stale check.

### `requires_input` means two opposite things

Stripe uses one status for "nobody has started this yet" and "we looked at the
document and refused it". The discriminator is `last_error`. Reading the status
alone told a borrower whose ID had been rejected that it "is being reviewed" —
indefinitely, with a spinner and no way forward. That is the same failure this
codebase guards against everywhere else, running the other way: an answer we
HAVE, rendered as an answer we are still waiting for.

`statusFor` takes both. And the failure copy now uses Stripe's own `reason`
when there is one instead of appending a guess about blurry photos to a
sentence that already explains itself — which matters, because in test mode
that reason is the actual instruction: walking the hosted UI via "Preview user
experience" always comes back unverified, and "Complete with test data" is the
path that passes.

The pending panel's "Carry on" also had to learn where it was. After Continue
the form and consents are saved, so the rest of the flow works while the check
finishes. From the ID button nothing is saved — no borrower, no APP-005 — so
the bank screen answered 403 and told the borrower they needed an
authorisation they had never been offered.

## Vendor credentials at rest

A Plaid `access_token` reads a named person's bank transactions on demand, for
as long as the item lives, with no further action by them — which makes a
leaked row worse than a leaked session cookie, not better. `vendor_tokens`
holds AES-256-GCM ciphertext under `VENDOR_TOKEN_KEY`, which lives in Secret
Manager and not in the database that holds the ciphertext. GCM rather than CBC
because it authenticates: a tampered row fails to decrypt instead of yielding a
token of somebody else's choosing.

There is no default key and no plaintext fallback, so a missing
`VENDOR_TOKEN_KEY` is a boot failure. And unlike `connector_snapshots` and
`decisions`, this table is deliberately **not** append-only — a re-link
replaces the credential. Old live bearer tokens are a liability, not history.

## Tests run against a real Postgres

The API suite used to mock `@hm/db`. Two files did it explicitly, and the cost
was not the mocking style — it was that every guarantee this product keeps in
the database was invisible to CI. `assertFileAccess` was asserted by checking
that `findUnique` had been called; that assertion cannot fail when a column is
renamed, and would have passed just as happily if `isDemo` had been dropped
from the select. The cascades that `deletion.test.ts` reads out of the schema
_text_ were never once exercised against a database.

CI now runs `postgres:16-alpine` as a service on 5433 — the same image and port
as `docker-compose.yml`, so one `DATABASE_URL` works in both places — and
`npm run db:test:setup` creates `<database>_test` and applies every migration
to it before the suite runs. That step is also the only check in this repo that
the committed migrations apply cleanly to an empty database; `migrate dev`
against a shadow database does not prove it.

The tests use a separate `_test` database rather than the development one,
because the suite truncates every table between tests and a developer running
`npm test` should not lose the file they were half way through.

**It found a live bug on the first run.** `advanceStage` was a read followed by
a write: two connector callbacks landing together both read the old stage, both
decided they were moving forward, and the slower write won — leaving the file
at the _lesser_ of the two stages, which is the exact rewind the high-water
mark exists to prevent. It is not an exotic interleaving; it is what happens
whenever a borrower finishes two connectors at once. It is now a single
`UPDATE ... WHERE stage IN (everything earlier than the target)`, evaluated
under the row lock, so whichever transaction goes second matches nothing.

That is the argument for the whole change, and it took one test to surface.

## Lint was never on

There was no eslint config in this repo. Not a stale `.eslintrc` waiting to be
migrated — nothing. The dependencies were installed at the root, every
workspace's `lint` script called `eslint .`, and `npm run lint` had therefore
failed on main since the beginning. Nobody noticed because the `check` job ran
requirements:verify, brand:verify, tsc, the tests and the build, and never once
ran lint.

There is now one flat config at the root. ESLint 10 searches upward from the
working directory, so each workspace's `eslint .` finds it and every package is
held to the same rules. Prettier keeps formatting; `eslint-config-prettier` is
last in the array so the two cannot disagree.

It found five things, in two kinds. Three were dead code and are deleted. Two
were parameters deliberately prefixed with an underscore, which is the codebase's
existing convention for "required by a signature I do not control" — and in one
case load-bearing, because Express recognises error middleware **only** by its
four-argument arity, so `errorHandler(err, _req, res, _next)` must keep `_next`
or error handling quietly stops being error handling. That is a config fix, not
a code fix, and `no-unused-vars` now ignores the `_` prefix.

**Three React Compiler rules are off, on purpose.** `eslint-plugin-react-hooks`
v7 ships `set-state-in-effect`, `refs` and `immutability` alongside the classic
hook rules. They found eight real things and every one is a deliberate pattern
whose compiler-safe rewrite is a behavioural change — reading sessionStorage
into state on mount, prefilling a form from fetched data, resuming a bank
session, a self-scheduling poll, and the latest-ref pattern behind the Plaid
callbacks. Those are the OAuth-return and polling paths, which are the hardest
screens to exercise and the worst to break. Turning lint on and refactoring the
bank flow are two changes; shipping the second one inside the first means it
goes in unreviewed. The classic `rules-of-hooks` and `exhaustive-deps` stay as
errors. The reasoning is repeated at the rules themselves in `eslint.config.mjs`.

## The TRID receipt is a trigger, and its clock opens tolled

The moment all six of TRID's pieces are present on a draft, it is an
application, and a three-business-day Loan Estimate clock starts. That receipt
is a Postgres trigger on the pin table, not a function somebody has to remember
to call. Relationship-first raises the accidental-receipt risk rather than
lowering it: a returning or portfolio member already has name, SSN and income
on file, so six pieces can complete on one careless insert. The highest-stakes
clock in the product should not depend on discipline.

Three decisions were made in that migration that a reader should be able to
find without reading SQL:

**The Loan Estimate clock opens tolled.** There is no delivery channel — Resend
is chosen and not integrated — and the clock can only be satisfied by a
delivered disclosure. Opening it live would breach every application on day
three and write a permanent, tamper-evident record of a breach we never had the
means to avoid. So `regulatory_clocks` rows open with `tolled_from` set and the
reason `no_delivery_channel_configured`. Tolling suspends the breach-writer,
not the deadline: TRID has no tolling, so `due_at` never moves. When the
delivery slice lands it ends the toll by writing `tolled_until` — the reason is
never cleared — and a clock already past `due_at` is breached AS OF `due_at`,
not re-dated.

**Business days skip weekends only, in the creditor's zone.** Reg Z's business
day excludes federal holidays, which needs a calendar table this slice does not
add, so in a holiday week every deadline is one day optimistic — exactly the
direction a regulatory clock must never err, and the other reason clocks stay
tolled. The zone is `America/New_York`, hardcoded in both `add_business_days`
and `CREDITOR_TIME_ZONE`, and "not later than the third business day" is the
END of that day in that zone. A test holds SQL and TypeScript to the same
answer, and an `it.fails` on Thanksgiving week records the holiday gap so the
calendar slice flips a failing assertion rather than editing a passing one.

**`now()` is the transaction start, and that bit us before it shipped.** When
the draft and its sixth piece land in one transaction — the returning-member
case — the receipt's stamp equals the draft's `status_entered_at` default, and
the prior slice's trigger reads an unchanged stamp as "not stamped" and rolls
the whole intake back. The receipt now stamps strictly after the state it
leaves. Found by an adversarial review of the unpushed migration, with plain
SQL, before it reached staging.

## The strangler's first move: dual-write

The four screens still run on `loan_files` and `borrowers`. As of 8 September
2026 they ALSO write the relationship layer, and nothing on the screens reads
it yet. That is the order on purpose — dual-write, prove the two agree, read
from the new with a fallback, then stop writing the old — because the live
flow must never be able to lose a write in between.

Two mechanisms, chosen for where the write sites are:

**Screen 2 writes the party and its facts in the same transaction as the
borrower row.** One route, so it is a service call, `recordBorrowerFacts`,
inside the same `$transaction` — a request records the person both ways or
not at all. Saving screen 2 twice supersedes the earlier assertion of each
predicate rather than adding a second person. A returning user's second file
reuses their party, which is the whole point of having one. "Not asked" is the
absence of a fact, never a null-valued one.

**Consents mirror to authorizations by trigger.** Three routes write a consent
row and a fourth would be written by somebody who had not read the other
three, so the mirror is `AFTER INSERT ON consents` and cannot be forgotten.
It mirrors only when the borrower has a party, and only for kinds that permit
a retrieval — eConsent and SMS grant no data category, and an authorization
must grant at least one.

**The mirrored grant expires in 120 days, and that is a real change.** The
legacy consent never expires. Once a party holds an authorization, `tokenFor`
treats the real table as authoritative and does not fall back — so a pull on
a file older than 120 days is refused, and a 4506-C that exists only as a
legacy row does not license a transcript. The fallback to `consents` remains
for rows with no party, with the old no-expiry semantics, so a refusal is
attributable to exactly one table. The bridge minter in the connectors
package still reads legacy consents with no expiry for the same reason.

## Still outstanding

Four vendor decisions plus sandbox credentials, none obtainable from inside
this repo. Email is settled — Resend — but not yet built, and the clocks above
depend on it:

| Connector                       | Constraint                                                |
| ------------------------------- | --------------------------------------------------------- |
| Credit (soft tri-merge)         | Reseller or bureau-direct; needs FCRA permissible purpose |
| Payroll (consumer-permissioned) | Aggregator                                                |
| IRS transcripts                 | IVES participant or a reseller                            |
| E-sign                          | For APP-005, APP-012 and INC-008                          |

Plus: the CLS-* closing-stage sheet, the requirements for the monitoring loop,
a real tax/insurance source, the real LLPA matrix, and an APOR feed.

## One-time infrastructure prerequisite

CI cannot authenticate to GCP until `Walt-Home/Homestead Mortgages` is added to the
Workload Identity provider's attribute condition and to
`hm-github-actions@`'s `workloadIdentityUser` binding. Both currently
allowlist exactly two repositories. The two commands are in the header of
`.github/workflows/deploy.yml`.
