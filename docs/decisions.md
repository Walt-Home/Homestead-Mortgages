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

**Title is a sentence the applicant states, and the originator is a row the
application is born with.** URLA L2.1 asks what will read on title and L2.4
how it will be held; both are facts about the deal, so they live on the
application as `du_vestings` rows and on the file beside `estateType`, asked
on the review screen above the signature and refused at signing when absent.
The origination company and the loan originator (Section 9) are two
`du_deal_parties` rows written inside `createDraftApplication`, because a
casefile with a borrower-only `PARTIES` is one the preflight refuses and the
numbers do not change from one application to the next. They come from five
plain variables — public identifiers printed on every disclosure, not secrets
— and where those are unset the placeholders in `packages/du` stand in, with
the same three rules as the seller/servicer number: they say what they are,
`assertDealPartiesEmittable` refuses a row carrying one in production, and the
widths come out of the generated Map. The refusal is at assembly rather than
at birth so a development database may hold applications born under
placeholders and a document may not.

**The shadow figures never leave the building.** Every figure in a decision's
`ratios` and `reserves` — the two DTIs, the three LTVs, the housing payment,
the debt total, the qualifying income, the reserve months — is one Desktop
Underwriter derives for itself from the inputs we send. MISMO defines an
element for most of them; the DU Map lists none, and none of Fannie's eighteen
samples carries one. So the assembler sends the inputs and never the figures,
`DU_DERIVED_FIGURES` records the boundary figure by figure, and a test in
`packages/du` fails the build the day a workbook upgrade lists one — which is
the day somebody has to decide whether to assert it, rather than the day it
starts going out by accident. The columns that hold the figures are typed at
the writer, the reader and the table (see "A ratio is eight figures, or
nothing", below).

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
`hm-run@` now holds `cloudsql.client` and accessor on the secrets the deploy
mounts — six today, granted on the secrets themselves —
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
`C02l6gns3`, which forbids `allUsers` everywhere else under trywalt.ai. This
project holds a project-level exception, the deploy binds `allUsers` and fails
the build if the binding is missing — because `gcloud run deploy
--allow-unauthenticated` does not fail when the constraint blocks it, it logs
and leaves a service that 403s everything and reads like a broken container.
The service is reached at its public URL with Google sign-in; `gcloud run
services proxy` is no longer how anybody opens it.

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
reaches `referred` and never a decision word — "we're reviewing this
ourselves", which is the honest thing to say to somebody whose pricing tests
could not run, and the reason `referred` is an outcome rather than a shade of
"approved with conditions".

## Vendors, one at a time

The registry used to be a single `CONNECTOR_MODE`: everything fixture or
everything real. Vendors do not arrive that way. Address autocomplete needs an
API key and an afternoon; a credit reseller needs an entity licence and a site
inspection. Each connector now reads its own variable and falls back to the
fixture, and `/health` reports the resulting mix.

**Google Places** implements one method of `PropertyDataConnector`. It knows
which addresses exist and nothing else — the adapter claims no requirements at
all, because APP-004 is satisfied by the public-record match rather than by
autocomplete — and it sits over whatever answers for the record beneath it.

**CoreLogic answers for the record and the valuation** (2026-09-17), read off
the v2 Property API's own specification. `PROPERTY_RECORDS_PROVIDER=corelogic`
is its own variable so the two vendors can be turned on one at a time. Four
rules, each a refusal to guess: a land use the table cannot place is
`PropertyNotDescribableError`, a subclass of the not-found error, so the
borrower gets the manual path rather than a card carrying a guessed
`Detached`; `priorOwnershipInLastThreeYears` is null from a real record, and
screen 2 stops deriving the first-time-homebuyer answer from it, because a
parcel knows nothing about who is buying it; a figure the county did not
report is zero and the card leaves it out; and the flood determination is
never CoreLogic's, because the Property API has none and a certified
determination is a separate product. The AVM is the originations model's
summary, with the confidence read on the 0–100 scale from the score or, where
it is absent, from the forecast standard deviation. One search per address
however many of the three lookups ask, because the trial account allows 100
property requests and 25 valuations a day.

**The kind of dwelling is read off the code, not the description** (2026-09-18).
The first live records carried `landUseCode` and `propertyTypeCode` and null
for every description, so a classifier keyed on words would have refused
every real parcel. The adapter embeds the residential rows of CoreLogic's
Universal Land Use table — the one Realist publishes, "Universal Land Use
Codes as may be found in Realist", First American CoreLogic — and reads that
first: 163 is a house, 102 a townhouse, 112/116/117 a condominium, 111 a
cooperative, 115/165/151 a duplex, triplex and quadruplex with the unit count
the code itself states, 138/137 a manufactured home. The property indicator
settles a residential land use that names no kind (100, 132, 133): 10 is a
house, 11 a condominium, 21 two to four units with the count taken from the
buildings and refused outside two to four. A condominium project (113), a
mobile home lot or park (135, 136), and everything commercial, exempt or
vacant is refused into the manual path. Descriptions are the fallback for a
code the table does not carry. The Dakota answered 111 and the two museums
tried answered 601 and 620, which is how the table was checked against the
wire.

**An absent valuation and an absent flood determination are each their own
absence, and neither is an absent record** (2026-09-18). The originations
model answers a parcel it will not price — a cooperative, a building it has
never seen sell — with a summary of zeros rather than an error, and the
flood determination is still the fixture's, which knows three addresses and
rejects the rest as not found. Both used to reach the borrower as something
else: the zeros as a $0 estimate, the fixture's rejection as "no county
record" for a parcel whose record was sitting in the same settlement. The
adapter throws `ValuationUnavailableError` and `FloodNotDeterminedError`,
`settleLookup` in `routes/property.ts` folds each to null beside a whole
record, and the card leaves the estimate line off and says the zone is not
yet determined. Only the record can make a lookup a 404; the other two are
allowed to be missing on their own, and the demo page names which of the
three came from nobody.

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

## Pricing is a port, and the vendor is still unpicked

Every file in this product was quoted `DEFAULT_NOTE_RATE` — one number in the
environment, the same for every borrower, and the only figure reaching a
decision with no retrieval behind it. It is now the eleventh connector port.

**The port is worth having before the vendor is, and the shape is what makes
that true.** Two kinds of vendor are in play and they disagree about what an
answer is. A **product and pricing engine** returns eligible products carrying
a borrower-facing note rate with the adjustments applied. An **investor
execution API** returns a price for a loan an investor would buy at a stated
coupon — which is not a rate until a grid and a margin have been applied to it.
A port shaped for the first would carry a `noteRate` the second never sends,
and whoever wired it would fill the field in by inventing the margin. So
`PriceQuote` is a union on `basis`, `InvestorPriceQuote` has no note rate to
fill in, and `borrowerNoteRate` returns null for it. A caller holding null
records `blocked`. **Choosing the margin and the grid is a pricing policy with
fair-lending consequences — it decides what every borrower pays over what the
loan is worth — and it is owned, documented and tested as one. It is not a
default in an adapter.**

**Only the ANSWER is a union. The REQUEST is a pricing engine's**, and the
asymmetry is written down rather than left to be discovered. `PricingScenario`
asks what a loan of this size on this kind of property costs. An execution API
is asked for a coupon ladder against a delivery type, with servicing retained
or released, and best execution means naming several investors and comparing
them — four things this request cannot say, and `InvestorPriceQuote` carries no
investor identity to answer with either. So wiring that vendor is a change to
`@hm/shared/types/pricing.ts` BEFORE it is a new file in `adapters/`, which is
the opposite of what the seam promises for the other ten ports. Said here and
in the port's own header, because the alternative is somebody inventing the
ladder's center, width and increment inside an adapter — the same invention the
union exists to prevent, moved one layer down where nothing above can see it.

**The port is half guarded, and the split is the FICO.** `quoteProducts` takes
a `PricingScenario`, which names a loan and nobody: no party, no name, no
score. It takes no `PurposeToken` and cannot be given one, which is the same
device the property lookups use, and it is what lets screen 1 quote a payment
before APP-005 exists. `quoteForBorrower` is guarded on `credit_report`,
because a representative FICO is the credit report's number and sending it to a
vendor is disclosing what a bureau said about somebody. Nothing calls the
guarded half yet: there is no screen that re-quotes after the credit pull, and
adding one means deciding what a borrower is told when the second quote is
worse than the first.

**The fixture is a rate sheet and applies no adjustment at all.** No FICO tier,
no LTV band, no occupancy hit, no lock-extension spread — every one of those is
a published matrix this repository does not hold, and the plausible invention
is the wrong kind of wrong. Its 30-year fixed carries 6.25%, which is what
`DEFAULT_NOTE_RATE` held, so replacing the variable with a port changed where
the rate comes from and not what any file was quoted. `creditTierApplied` is
false on every quote it returns, the guarded call included, because "we applied
no adjustments to this borrower" and "we never looked at a borrower" are
different statements and only one of them is a rate anybody may be shown.

It holds ONE product, for the same reason. A 15-year row sat beside the 30-year
at 5.50% for a while and nothing could say where that figure came from — a 75bp
term spread nobody published, on a sheet whose other rate is accounted for to
the basis point. It was reachable: `QUOTED_PRODUCT_CODE=CONF-15-FIXED` would
have quoted every borrower on that deployment a number this repository made up.
One product is enough to prove a port.

**The engine's own adjustment grid is untouched, and it is the next thing to
move.** `packages/underwriting/src/pricing.ts` answers UW-010 today from a FICO
and LTV matrix its own header calls illustrative, and stamps the derivation
`(ILLUSTRATIVE GRID)` so a reader of the log cannot miss it. That grid is the
same invention this port refuses to carry, sitting one package over and already
reaching a decision. Both adapters therefore claim `satisfies: []` — a base
sheet with no adjustments on it does not answer UW-010 — and the port is where
a vendor's adjustments arrive when somebody has one. Moving the requirement
onto it is a change to what the engine decides, which is why it is not in this
commit.

**Nothing falls back, and a vendor's answer is checked before it is believed.**
`quoteSubjectProduct` raises when no quote arrives and raises again when the
quote is a price rather than a rate. It also raises on three answers that
arrive looking fine:

- **A stack under one product code.** A pricing engine returns the same 30-year
  fixed several times over — 6.875 at 101.5, 6.25 at par, 5.75 at 98.25 — and
  a `find` over that list takes whichever the vendor serialized first. That is
  112 basis points of somebody's rate decided by array order, and choosing par
  pricing over buying the rate down is exactly the pricing policy this port
  says it does not own. So more than one match is refused with its own code
  rather than resolved. The fixture returns one row per product; the first
  vendor that returns a stack stops.
- **The wrong lock column.** The scenario names a lock period so a figure taken
  off the 30-day column cannot later be read as though it came off the 60-day
  one, and nothing compared the answer to the question.
- **A rate no vendor meant.** `requireQuotableQuote` is the answer-side twin of
  `requireQuotableScenario`: a note rate that is not finite, not above zero or
  outside a wide plausible band, a term that is not a positive number of
  months, a window that is not a window. Zero is the case it exists for,
  because zero is what an absent field becomes in most vendor mappings and
  zero is the one bad rate that reads as a number all the way down — it
  amortizes, and `housingPitia` records the payment as a derivation with a
  formula beside it rather than blocking on it.

Screen 1 fails rather than writing a rate nobody stood behind into
`loan_files.note_rate`, where every ratio on the decision would compute from it
and none of them would look wrong. That is `DerivationLog.blocked`'s rule
applied one layer earlier.

**And the row itself refuses a half-quoted product.**
`loan_files_quote_a_whole_product_or_none` holds `product_code`, `term_months`
and `note_rate` present together or absent together, with the rate above zero.
The checks above are code the next writer can forget; this table had no CHECK
constraint at all, and the promise the whole commit is about is a promise about
what is in a row. `LoanFile.product` reads back null rather than zero percent
when the rate is missing, which takes UW-004's existing `log.blocked` path —
the one the decision screen already has copy for.

**What the rate came off is recorded with it.** `rate_quote_lock_days`,
`rate_quoted_at` and `rate_quote_expires_at` go down beside the rate, so a
figure read back next week is readable as stale. Recorded and not enforced:
nothing here refuses an expired quote, because nothing here locks a rate, and
a check would refuse a fixture dated to a past reference day while changing
nothing about a live file.

**A screen may not say a rate is locked or guaranteed, and that is now a test.**
It was a comment on `QuoteBase.locked` and nowhere a suite could read it, while
the landing hero's sub ended "with lowest rates guaranteed" — false by this
port's own standard, on the first page a borrower sees. `RATE_COMMITMENT` sits
beside `PROMISES` in `copy-rules.ts`, `borrower-copy.test.ts` and
`stories.test.ts` read it, and the hero is four words shorter.

**A rate is quoted once, at creation, and a screen-1 revision does not
re-quote.** That was true before the port and is still true. Whether a
borrower's rate may move under them when they go back and fix the purchase
price is a question with a disclosure attached rather than a line of code.

### What this does NOT unblock, and why

`compliance.ts` blocks UW-006, UW-007, UW-008, UW-009 and APP-019 on three
inputs, and **a note rate is none of them**. This commit moves none of the five.

| Input           | What it is                             | Where it comes from                       |
| --------------- | -------------------------------------- | ----------------------------------------- |
| APR             | The rate including the finance charges | This loan's fee schedule, plus the rate   |
| APOR            | Average Prime Offer Rate for the week  | The FFIEC's published table               |
| Points and fees | The QM total                           | The fee schedule behind the Loan Estimate |

**APR is not the note rate and no pricing vendor can supply ours.** It is a
function of this loan's finance charges under Reg Z, so an engine that reports
"APR" reports it on the fee set the engine assumes. Putting that number in
`MarketInputs.apr` would make the HOEPA and General QM determinations turn on
somebody else's assumed fees, which is exactly the confidently wrong answer
`compliance.ts`'s header refuses. The port therefore carries no APR field.

**Pricing contributes one line of the fee schedule and not the schedule.** A
quote below par implies discount points, which are part of the QM
points-and-fees total — alongside origination, underwriting, and every other
charge from a fee table this repository does not have. `pricePercentOfPar` is on
the quote for whoever builds that table; it does not complete it, and the
fixture leaves it null rather than asserting par.

**APOR belongs in its own commit, and not in this one.** It comes from no
pricing vendor: it is a weekly table the FFIEC publishes, and the work is a
dated load with a lookup, not an adapter. Three things make it a commit of its
own rather than a field here:

- It is selected by the **rate-lock date** and by the product's term and type.
  Nothing in this product locks a rate — `QUOTED_LOCK_DAYS` names a column of a
  sheet and no more — so there is no date to select on yet, and picking "today"
  silently backdates or forwards every determination made about an older file.
- The table is **dated data that goes stale**, which makes it storage rather
  than configuration: a HOEPA test run twice on one file has to give the same
  answer, so the week's table has to be recorded with the determination rather
  than read live.
- A stale or mis-dated APOR produces a **confidently wrong** high-cost finding
  in either direction, on a test whose failure severity in Drew's sheet is
  "Regulatory violation". Blocked is the correct output until it is right.

So the five tests stayed blocked at the end of that commit, blocking on inputs
whose sources were written down. What it ended is a rate that was one
environment variable. The section below is what happened to the three inputs.

## APOR, a fee schedule, and an APR we are willing to defend

Four of the five tests above now run on a file a borrower walked, and the fifth
is a refinance test that runs on a refinance. None of the three inputs came
from a vendor.

### APOR is a dated series with a lookup, and it goes stale by refusing

`packages/underwriting/src/apor.ts` holds the FFIEC's own shape — a header of
terms, one row per week — with a loader and a lookup. Where the rows come from
is the section after this one; this one is about what a lookup may and may not
answer, and it is unchanged by the source. The lookup takes the
**week the rate was set**, which is what Regulation Z compares against, and
reads the column for the loan's term. Three refusals rather than
approximations: a term with no column, an adjustable-rate product (compared
against a different series), and a rate set more than six days after the last
row.

That last one is the whole design. The nearest week a stale table holds is the
wrong answer arriving as a right-looking one — the HPML test still returns a
boolean and the HOEPA test still says "not high-cost". So the table stops
answering instead, the tests block, and the decision is `referred`. **The
shipped table therefore holds no week that has not happened, and will go stale
on its own.** Extending it forward by inventing weeks the FFIEC could not yet
have averaged is the one edit that would turn a blocked test into a wrong one.

The loader refuses a series with a hole in it, and that check is load-bearing
rather than tidiness: from inside the lookup a missing week and the end of the
series look identical, so a gap would silently answer the week before it for
every rate set inside it.

**Reproducibility does not need the table copied into a row.** The earlier
section argued that dated data going stale makes APOR storage rather than
configuration, because a test run twice on one file has to answer the same way.
What makes that true here is that the lookup is keyed on a date recorded on the
file — `loan_files.rate_quoted_at`, already written with every quote — and the
derivation records the week, the term and the source it answered from. A
replacement table containing the same week gives the same answer; one that does
not reach that week blocks. Neither is a different answer to the same question.

`rate_quoted_at` is the day the vendor published the sheet, which is the
closest recorded fact to the day the rate was set. Nothing here locks a rate,
so there is no lock date; the two are the same day on every quote this flow
writes, and whoever builds locking replaces the reading with the lock date.

### The APOR is the CFPB's published table, and the survey is the check on it

The first version of this held thirty-eight weeks of rates typed into a source
file and marked fixture data. It was fixture data, and it was also wrong by
fifty-five basis points the week it was written: the real 30-year APOR for the
week of 2026-09-14 is 6.84, and the file said 6.29. Every spread on staging was
being measured against a number half a point low. A table nobody fetches is a
table that was current on the day somebody last typed it.

What replaced it starts from what an APOR actually is. **Nobody quotes it.** It
is an APR the CFPB computes every week from a survey of what prime borrowers
were offered — a contract rate and points for each of eight products — using
Appendix J to Regulation Z with assumptions its methodology page lists: a fully
amortizing loan, monthly compounding, equal payments to the fraction of a cent,
thirty-day months, and no odd-days interest.

The CFPB publishes three things, all on plain file servers with no credential:

- **the table itself**, `https://files.ffiec.cfpb.gov/apor/YieldTableFixed.txt`
  — one Monday per row since 2017, a column for every term from one to fifty
  years, the file its own rate-spread calculator reads. **This is the figure in
  force and it is the source of truth here.**
- **the survey**, `SurveyTable.csv` — one Thursday per row, the rates and
  points the table is computed from. Updated in the same second as the table.
- **the calculator**, `POST https://ffiec.cfpb.gov/public/rateSpread` — a
  spread against a given APR for a given week and term, so at an APR of 10.000
  the APOR is ten minus the answer.

The first draft of this change did not know about the first. It vendored the
survey, computed the table from it with the same Appendix J solver the engine
uses for a borrower's own APR, and pinned one week to the CFPB's published
figures. A refuter pass found the published file, and then found — by
comparing all 208 figures in the vendored year against it — that a
computation from the survey is wrong for the weeks the CFPB deviates from its
own method **by announcement**, which a computation cannot know:

- **2025-12-29.** Christmas fell on the survey Thursday. Per the method's
  footnote 2 the CFPB republished the prior week's figures. The survey file
  nevertheless carries a 2025-12-25 row, which computes to numbers the CFPB
  never put in force — seven basis points off on the 30-year.
- **2026-01-05.** Two sets were published for the week, and the calculator took
  the HIGHER figure per term: for the 30-year that was the revision, for the
  20-, 15- and 10-year it was the first set. The pinned test asserted the
  revised set on all four terms and was wrong on three.
- **Nine other figures were a basis point high** through no fault of the
  CFPB's: `annualPercentageRate` rounds to three places for a decision, and
  rounding that to the two the CFPB publishes rounds anything in [x.xx45,
  x.xx50) up twice. Every one landed in the direction that under-flags HPML
  and HOEPA at the line.

So the design inverted. **`apor-yield.ts` parses the published table, and
`apor_weeks.rate` is taken from it and never computed.** The survey computation
became the **cross-check**: for every week the survey reaches, Appendix J on
the survey row is stored beside the published figure with the difference in
basis points, and the fetch prints every divergence. On every week the CFPB
followed its own method the two agree to the cent; a test sweeps the whole
vendored year and asserts that the divergences are EXACTLY the seven (week,
term) pairs above and nothing else, so a new deviation is a failing test and a
question rather than a number nobody measured. A divergence is never a refusal:
the published figure is in force whatever the arithmetic says. The rounding is
fixed at the root — the solver now exposes its unrounded result and each
consumer rounds once — and a test pins one of the nine boundary cases.

The same pass caught a smaller thing in `compliance.ts` that the refuters'
own arithmetic tripped over: `8.28 - 6.78` is `1.4999999999999991` in a
double, so a spread that equals a bright line stated as 1.5 could miss a `>=`.
An APR carries three places and an APOR two, so the spread is exact in
thousandths, and the three price tests now compare integers.

After every ingest the fetch also asks the calculator for the latest week on
the two terms V1 quotes and compares the answer to the row it stored. An
outage there is printed and is not a failure; an _answer_ that disagrees is two
CFPB sources contradicting each other, and the fetch exits non-zero for a
person to look.

Two corrections to the obvious question, which was "can we fetch the rate from
Freddie or Fannie":

- **Fannie publishes nothing here.**
- **Freddie's survey stopped being the input in April 2023.** The survey data
  are ICE Mortgage Technology's now, published through the CFPB. And the survey
  was never the APOR even when it was Freddie's: the APOR is what the CFPB makes
  of the survey, points included. A loan measured against the raw survey rate is
  measured against a number nobody published as an APOR — the same error as a
  note rate wearing an APR's name, one layer up.

**The series is data, fetched on a schedule, and the engine never reaches for
a file.** `scripts/fetch-apor.ts` fetches both documents through the
`aporSeries` connector port (the fixture adapter serves the vendored copies;
the `ffiec` adapter reads the live files, conditionally — the CFPB's server
honors `If-Modified-Since` and ignores `If-None-Match`, measured, so both are
sent), parses each with a parser that refuses what it cannot vouch for, and
appends the published weeks to two tables with the cross-check beside them. `underwrite` takes the table as a
required option and the API hands it what `apor_weeks` holds — or null, and a
blocked UW-008 whose words say to run `apor:fetch`. There is no default table.
A default would be the week somebody last ran a command, standing in for a
weekly publication, in a legal test that would look current.

Two append-only tables, in the shape of the thing they record:

- `apor_fetches`: one row per document the CFPB served, of either kind,
  verbatim, with the headers it sent and a hash. "Already held" is the same
  bytes as the NEWEST fetch of that kind — not as any fetch ever, because the
  CFPB can restore an earlier file and when it does that file is the
  publication in force again. A daily re-fetch of an unchanged document
  inserts nothing, which is what makes the schedule safe.
- `apor_weeks`: one published rate per (week, term) per fetch of the table,
  and beside it — when the survey reaches that week — the survey figures, what
  Appendix J makes of them, and the difference. The database checks that a
  week is a Monday, a survey a Thursday, the one four days after the other,
  and that the recorded divergence is the recorded difference.

**Revisions are why both are append-only and why the lookup takes the latest
row.** The CFPB updates the published file in place and it holds the figure in
force, so the latest fetch is the latest publication: a changed figure for a
week already held is inserted beside the old, the old stays because a decision
may cite it, and the highest `write_seq` is the rate in force. The ingest
refuses a document that ends earlier, or was modified earlier, than the newest
one held — a stale mirror, a cache, a developer's vendored copy — so the table
cannot walk backwards; it refuses a fixture document in production outright,
and beside a live one anywhere. A trigger refuses UPDATE and DELETE on both
tables. Provenance travels per week: the published file is a rolling window,
so a week can stay in force from a fetch a newer file no longer carries, and
a decision on it cites the fetch that actually answered. Recovering what a
year-old decision was measured against is a read, not a reconstruction.

**The vendored copies are for tests and developers, and they are brought
forward by one command.** `data/ffiec-yield-table-fixed.txt` and
`data/ffiec-survey-table.csv` are the CFPB's files as served, the `.meta.json`
beside each is what the server said, and `scripts/build-apor.mjs` embeds all
of it into `@hm/shared` — `npm run apor:verify` fails CI if they disagree, the
same discipline as the requirement registry, the brand tokens and the DU
tables. `npm run apor:vendor` refreshes them. Nobody edits a row.

### Where the staleness alarm rings now

The previous section's alarm was a test that read the clock and failed the
first Monday the typed table no longer covered today. That test is gone with
the table. The alarm is in the environment where a borrower would have hit it:

- **The fetch script exits non-zero** when the series it leaves behind does not
  cover the current week. The deploy workflow runs it, from the live file,
  before it seeds, and stops the deploy on a non-zero exit — a CFPB outage or a
  reshaped file is a red build with the reason printed, not a service on which
  every decision quietly ends "In review".
- **`/api/health` reports `apor.coversThisWeek`**, and the deploy asserts it
  against the deployed revision after the fetch has run.
- **A Cloud Run job on a Cloud Scheduler cron** (`infra/main.tf`) runs the same
  script daily at noon UTC. Daily rather than weekly because the fetch is
  idempotent and a series that recovers on its own from a Thursday the file
  server was down is worth a conditional GET a day. The job's image follows
  each deploy; Terraform owns its shape and ignores the tag.

⚠ The job and its schedule are declared and not yet applied — CI cannot
authenticate to GCP until the Workload Identity binding exists, and
`terraform apply` is run by hand. Until then the deploy-time fetch is what
keeps staging current, which means staging goes stale between deploys that are
more than a week apart. The deploy step warns when the job is absent.

### The fee schedule is one list and three totals

`packages/underwriting/src/fee-schedule.ts` is versioned and dated because the
numbers it produces land in legal tests, and a decision recomputed a year later
against a newer schedule would quietly answer the QM question on fees that loan
was never charged.

It is a list of lines rather than three constants because the three totals are
**different subsets of the same fees** and nothing about a dollar figure says
which subsets it belongs to. An appraisal is a closing cost, is not points and
fees, and is not a finance charge. Origination is all three. So each line
carries its own §1026.4 and §1026.32(b)(1) flags with the reason beside it, and
the payee is on the line because an appraisal ordered from an affiliate is
inside both subsets.

That split fixed a real error: net tangible benefit was recouping
`pointsAndFeesAmount`, which is roughly half of what a borrower actually pays
at closing. It takes `closingCostTotal` now, and `MarketInputs` carries both.

⚠ Nothing in the schedule varies by state or by property. Transfer and mortgage
recording taxes are set per state and county and title premiums are filed rates
in most states; none can be a lender-wide constant, so they are absent and the
derivation says the total is this lender's own charges rather than a Loan
Estimate.

### APR is computed, and refused on the loans where it would be a guess

`packages/underwriting/src/apr.ts` solves Appendix J's regular-period case: the
monthly rate that discounts the payment stream back to the amount financed,
times twelve. Measured against this schedule on a 30-year loan, it comes out 7
basis points above the note rate at $806,500, 9 at $400,000, 15 at $150,000, 32
at $60,000 and 71 at $25,000 — close enough on the loan sizes anybody would
think to check that substituting one for the other would pass, and two thirds of
a point out on a small loan, which is exactly the loan the HOEPA fee trigger is
about.

It refuses two kinds of loan rather than estimating:

- **Anything that does not amortize that way.** An adjustable rate needs the
  composite-rate rules and a balloon is a different stream.
- **Any loan carrying mortgage insurance.** MI premiums are finance charges
  under §1026.4(b)(5), they are in the payment stream, and they stop at 78% of
  original value — so an APR without them is understated and one with them is
  only as good as the premium. `GUIDELINES.mortgageInsurance` says of itself
  that it is an estimate. §1026.22(a)(2) allows a disclosed APR an eighth of a
  point — 12.5 basis points — and the error in that estimate alone is measured
  at **37 basis points at 95% LTV, 39 at 98% and 22 at 90%** for a fifth's
  error in the premium, solving the full stream with the premium ending at 78%
  of original value. Three times the whole allowance, exactly where mortgage
  insurance matters. (It drops inside tolerance around 85% LTV and below, which
  is not the case this is about.)

So **a loan above 80% LTV still refers**, on the APR alone, and that is the
shape of file that keeps `referred` reachable through the real flow.

⚠ **Read that as a product fact, not a footnote.** Six of the eight sample
borrowers sit at or below 80% LTV and decide; the two who do not — 95% and
97.9% — refer. A first-time buyer putting 5% down is the core case for this
product and is precisely the file that cannot be given an APR today. It is a
vendor gap of exactly the same kind as Grander's seller/servicer number: **a
real mortgage-insurance rate card closes it and nothing else will**, and until
one arrives the honest answer for that borrower is "a person is looking at
this". The alternative is a rate card we made up deciding their HPML status.

What it leaves out is interest from disbursement to the first payment period,
because no file here carries a disbursement date. That is omitted rather than
assumed, and the omission is bounded: a full month of it — the most there can
ever be — moves the APR by less than half the eighth-point tolerance above, in
the direction that understates. A test pins the bound and the derivation records
the omission beside the figure.

### The HOEPA test is three-valued, because its two triggers are not symmetric

Either trigger makes a loan high-cost, so `true` is sound on one trigger alone.
`false` is not: "not high-cost" means neither fired, and a trigger that was
never tested did not fail to fire. With the fee schedule always priced and the
APR blocked on a loan carrying mortgage insurance, the old two-valued OR
returned exactly that — a clean HOEPA determination on a loan whose rate nobody
had compared to anything.

### The decision route no longer takes any of this off the request

It used to parse `apor`, `apr`, `pointsAndFeesAmount`, `estimatedFees` and
`estimatedPrepaids` from the POST body. The only session on a file belongs to
the borrower whose loan is being tested, so a posted `{"apor": 20}` turned a
high-cost decline into an approval. Nobody was exploiting it — both screens
posted an empty body, which is precisely why every walked file ended "In
review" — but four regulatory tests were reachable from outside the engine, and
validation is not the fix for that. The body is ignored.

`UnderwriteOptions.market` survives for the persona seed alone, and it has to:
a high-cost sample borrower needs an APR six and a half points over the market,
and no sheet in this repository quotes one. A seed also cannot depend on a
weekly table covering the day it happens to run.

### A ratio is eight figures, or nothing

`decisions.ratios` and `decisions.reserves` were bare `Json`, written through
a cast and read through another. Three test fixtures wrote `{}`, and a reader
could not tell that from a decision. Now `recordDecision` parses both through
the zod schemas in `@hm/shared/decision-figures` before the row exists —
strict, every key present, each a finite number or null — `loadLoanFile` and
the history endpoint parse them on the way out, and two CHECKs hold the same
rule in Postgres, so a row nothing here wrote is still a row of this shape.
Two JSON columns rather than twelve typed ones because each block is written
as one object, appended as one, and diffed as one. The CHECKs are `NOT VALID`:
a constraint that refused an old row on staging would abort the deploy that
carried it, and validating once every deployment's rows have been read back
through the parser is the safer order.

### The database refuses a stored spread that names nothing

`decisions` is the audit record and is append-only, so a row saying
`"isHighCost": false` outlives the table and the schedule that produced it —
and both of those move. `decisions_a_spread_names_its_week` and
`decisions_a_fee_ratio_names_its_schedule` refuse a row reporting one of those
verdicts without an `apor_source` or a `fee_schedule_version` beside it. The
engine writes both from `Decision.pricedAgainst`, and `"stated"` is what a
caller-supplied market records, for the reason `aus_engine` holds `"shadow"`:
no stored decision may be ambiguous about what produced it.

The facts are already in the derivation log, and a CHECK cannot read a JSON
array — Postgres forbids the subquery that would take — so they are promoted to
columns. The constraints are implications rather than NOT NULLs, and they are
added **NOT VALID**, which is the correction below.

### What a refuter pass changed before any of this landed

Six independent reviews were run against the change above while it was still
uncommitted, each told to break it rather than approve it. Nineteen claims were
raised and thirteen were refuted. What survived is recorded here because most of
it was wrong in the permissive direction — the direction the brief for this work
said must not happen.

**The migration would have stopped the deploy.** Its own comment asserted that
every pre-existing decision "was computed with no APR and no APOR at all". True
of every file a borrower walked, false of the one caller that has always stated
market figures: the persona seed. Three sample borrowers carry a non-null
`hpmlSpread`, so on staging — and on any developer database where
`seed:personas` has run — a validated `ADD CONSTRAINT` fails and
`prisma migrate deploy` aborts. Reproduced against a database holding one such
row, then fixed with `NOT VALID`: unchecked against the rows already there,
enforced for every row written from now on, which for an insert-only table is
every decision this engine will ever record. Deleting them was not available
(append-only) and neither was backfilling — `"stated"` would have been exactly
true of them, but an `UPDATE` against `decisions` is the thing nothing here
does.

**Points and fees was measured against the wrong denominator.**
§1026.32(b)(4) defines the _total loan amount_ the QM cap and the HOEPA fee
trigger are both measured against: the loan less what is paid at closing for the
credit itself — the same figure Appendix J already discounts against. The code
divided by the note amount. The error is the fees' own share of the loan, so it
is invisible at $400,000 and decisive below about $40,000, always understating.
A $36,000 loan on this schedule reported 4.92% and passed the 5% trigger where
the statutory ratio is 5.17% and does not: **a high-cost mortgage originated,
with a stored decision asserting it passed.** `MarketInputs.totalLoanAmount` now
carries the denominator and the ratio blocks without it, because a ratio is a
pair of numbers and only one of them was present.

**HOEPA and HPML were applied to loans they do not reach.** Both rules open on
credit secured by the consumer's _principal dwelling_; a loan to buy an
investment property is business-purpose credit §1026.3(a)(1) exempts from
Regulation Z outright. Nothing read occupancy. This lender's flat fees are 5.8%
of a $30,000 loan, so a small second-home purchase fired the fee trigger, and
one high-cost finding is a denial ahead of every other branch — a borrower
declined, and sent an adverse-action notice naming the reason, on a rule that
does not reach their property. Out-of-scope is now **recorded rather than
blocked**: blocking means "we could not compute this" and forces `refer`, and
this is the opposite — we know the rule does not apply.

**Two bright lines were tested on the wrong side, and on a rounded input.**
§1026.35(a)(1)(i) makes a loan higher-priced at "1.5 **or more** percentage
points" over APOR, and §1026.43(e)(2)(vi) disqualifies General QM at "2.25 **or
more**" — both floors, both tested with operators that excluded the boundary.
Worse, the spread was rounded to hundredths _before_ the comparison, so every
true spread in [1.500, 1.505) collapsed onto 1.50 and failed a strict `>`. The
tests now decide on the exact spread and record the rounded one. §1026.32(a)(1)(i)
keeps its strict `>` — that rule says "**more than** 6.5" — but reads the exact
spread too, because a true 6.5004 rounded to 6.50 failed it the same way.

**The APR solver could return a number it had not found.** Bisection against a
bracket that excludes the root does not fail; it converges on the bound. The
ceiling was a flat 100% a month, asserted as one "no mortgage reaches" — but a
$1,600 loan carrying $1,598 of prepaid finance charges has a true unit-period
root near 492%, and the engine recorded a computed APR of exactly 1200.000%.
A fabricated figure with a derivation behind it is the one thing no number on a
decision may be. The bracket is now found by doubling, and refuses if it cannot
straddle the root.

**`Infinity` is not a number JSON can carry.** A refinance with no monthly
saving set `recoupMonths: Number.POSITIVE_INFINITY`, typed `number`, which
Postgres read back as `null` — so a stored counteroffer said the benefit test
failed and could not say by how much, collapsing "never recoups" into "never
computed" at write time, silently. It is `number | null` now, unambiguous
because a test that did not run leaves `netTangibleBenefit` undefined entirely.
The borrower-facing string said "recoup of Infinity months"; it now says the
new payment is not lower than the old.

**A stated market priced closing costs at zero.** `options.market` short-circuits
the whole derivation, and no caller states a `closingCostTotal` — so funds to
close silently dropped the entire fee schedule for every seeded sample borrower,
on a file whose own decision screen listed those fees. The schedule is this
lender's own, not a market input, so it is priced regardless of who stated the
rest. An empty stated market (`{}`, which is truthy) now throws rather than
turning off all four derivations.

**The mortgage-insurance refusal did not implement its own contract.** `apr.ts`
says it refuses any loan above 80% LTV; the gate read a premium off a band table
whose lowest row starts at 80.01, so the open interval (80, 80.01) got a stated
APR for a loan that carries mortgage insurance in fact.

### The staleness alarm was a comment, not an alarm

`apor.ts` said the table "WILL stop answering, on the Monday after the last row,
and that is the alarm working." Half true. It stops — but every test pins its
quote to the last week in the table, exactly so it does not inherit the clock,
which is right for a test about application states and left **the whole suite
green on the day every real borrower's file starts referring.** One test then
read `new Date()` on purpose and failed in CI the first Monday the series did
not reach. That held for one day: the typed table is gone, the series is
fetched, and "Where the staleness alarm rings now" above is where it went.

### The thresholds are a dated table, and two of the tiers were never percentages

A second pass over "Known and open" closed all five and found a sixth that
was worse than any of them. §1026.43(e)(3)(i) has five points-and-fees tiers,
and tiers (B) and (D) are **dollar caps** — $4,139 and $1,380 for 2026 — not
percentages. The code held all five as percentages, so a $137,000 loan was
allowed $5,343 of points and fees where the rule allows $4,139: a non-QM loan
handed the §1026.43(e)(1) presumption. The permissive direction again.

- **Every indexed figure now lives in `REGULATION_Z_THRESHOLDS`, by year**,
  with the publication it came from recorded on every derivation, and a year
  the table does not hold is a blocked derivation naming the years it does —
  never the nearest year. The year is chosen by the rate-set date, which is
  the nearest recorded fact to consummation and the date the APOR is already
  keyed on, so a file's price tests are judged in one year.
- **The six 2026 figures check each other.** The CFPB indexes all of them
  from one multiplier over continuous statutory bases, so 137,958 × 3% must
  equal 82,775 × 5% and 27,592 × 5% must equal 17,245 × 8%; they do, to the
  dollar, and a test asserts the continuity rather than trusting a comment.
  The two HOEPA figures were read from the CFPB's own §1026.32 commentary;
  the QM four from a summary of the same rule and then checked against them.
- **QM points and fees is a dollar limit compared in cents**, and HOEPA's fee
  trigger is tiered — 5% at and above $27,592 of total loan amount, the lesser
  of 8% and $1,380 below — instead of a flat 5%.
- **The rate-set date is a calendar date in America/New_York.** The CFPB's
  week is a US calendar and the file stored an instant; a Sunday-evening
  Eastern quote was the next week in UTC. `calendarDateIn` reads the day in
  the lender's zone and the derivation records both.
- **A manufactured home under the top bound gets the 6.5-point General QM
  threshold** §1026.43(e)(2)(vi)(D) sets, read off the property type.
- **The prepayment penalty is HOEPA's third trigger.** `loan_products.
prepayment_penalty` reaches the engine as `ProductSelection.prepaymentPenalty`;
  a product that can charge one blocks the test naming the term and the cap
  the rule bounds, because the penalty's term is not modeled yet, and a
  product that cannot settles the trigger false.
- **The existing loan says what it knows.** The credit pull no longer writes
  `existingRate: 0` — null is "the report does not carry a rate" — and
  `existing_payment_basis` records whether the old payment is principal and
  interest or a bureau's scheduled payment, which may carry escrow. Net
  tangible benefit blocks rather than subtracting new P&I from an old escrowed
  figure, and publishes no rate delta it cannot compute.

## A job is declared on, not derived from

Desktop Underwriter requires three things about every current employment:
which of a borrower's jobs is the primary one, whether they are self-employed
at it, and whether they are employed by a family member, the property seller,
a real estate agent or another party to the transaction. The first is derived
— the current job carrying the most employment income is primary — and nobody
is asked. The other two are URLA 1b's questions, and they are asked, stored
with who said them and when, and attested by the signature on the review
screen, exactly as Section 5 is. A payroll pull knows what a job pays and
cannot know whether the employer is the seller; a default of "no" would be an
unrun question asserting a clean answer above a signature, which is the defect
`buildDeclarations` was removed for.

They are asked on the review screen rather than on screen 3 because jobs only
exist after the bank or payroll pull. `APP-029` is the requirement, and its
applicability is three-valued on purpose — unknown until a pull has looked for
a job, false for a borrower with none — so the satisfied count cannot go
backwards across the pull the way it once did. A job a later pull adds arrives
unasked, and only that one is owed.

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

## Sign-in has a second step

Google says who somebody is. Since September 2026 that no longer gets them in:
`requireAuth` refuses everything past `/api/auth` until the session has also
presented a six-digit code from an authenticator app, and a person with no
authenticator is sent to enroll one before they can reach a file. It is
enforced rather than offered, because the file behind the gate holds twelve
months of bank transactions and a credit report, and a second factor a person
can decline is the one the person whose Google password was phished did
decline.

The shape, and why each piece is the way it is:

- **TOTP, hand-rolled, held to the RFCs.** `services/totp.ts` is RFC 4226 and
  RFC 6238 in eighty lines, and `totp.test.ts` reproduces every vector both
  appendices publish. A library would be the same lines behind a name plus a
  base32 package, and the sign-in is the wrong place to inherit a transitive
  dependency's next advisory. Not passkeys, because the relying-party id is the
  hostname and the hostname is a Cloud Run hash today; not SMS, because it
  needs a vendor and a phone number and is the weakest of the three.
- **The secret is ciphertext under `VENDOR_TOKEN_KEY`**, the same key and the
  same argument as the section above: a TOTP secret read out of a backup mints
  every code from then on. The API refuses to boot in production without the
  key; outside production a fixed development key stands in, the way the
  session secret does.
- **A code is good once.** `last_used_step` records the 30-second step of the
  last code accepted and nothing at or before it gets in again, so a code read
  over a shoulder is worthless the moment it is used.
- **Guessing is expensive, and the count is on the row.** Five wrong codes lock
  the row for fifteen minutes. On the row rather than the session, because a
  session is free: an attacker holding the Google password can mint one per
  request, and a per-session counter would hand them five guesses each.
- **Losing the phone is survivable.** Eight recovery codes are shown once at
  enrollment and only their SHA-256 is kept, like an invitation token. Each is
  spent by the one `UPDATE` that finds it unspent, so two requests racing for
  the same code cannot both win.
- **Enrollment is two requests with a phone in the middle.** The secret rides
  in the server-side session until a code from it has been seen, and only then
  is a row written — a half-enrolled row would lock its owner out with an
  authenticator they never finished adding. Replacing an authenticator is the
  same two requests from a session that has already presented a code, so a
  stolen password cannot swap the phone.
- **The session id rotates twice**: at sign-in, as before, and again when the
  code is accepted. A session id fixed before the second step is not the one
  trusted after it.
- **Two things are exempt**, and both are marked on the session by the route
  that minted it: a sample borrower, who is shared with every tester and
  refused every write, and the local developer, who is unreachable in
  production. A Google sign-in is never exempt.

`requireSession` is the weaker gate — a session and a user, nothing about the
code — and exists for `/me`, which is how the client learns which screen to
show, and for the second-factor routes, which are how the code gets presented.
`second-factor.test.ts` reads `routes/auth.ts` and fails if anything else uses
it, and reads `index.ts` to hold that the gate over everything is the strong
one. The `callAs` harness stubs the session as verified, for the same reason it
stubs `userId`: every other route's test is about what a signed-in person's
request does, and the gate is walked through a real express-session in its own
file.

What is not built: anything a support person can use to reset an authenticator
for somebody who has lost the phone and spent every recovery code. Today that
is a `DELETE` on `user_authenticators` by hand, and it should become a route
that records who did it.

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

The setup step also drops and rebuilds that database whenever a recorded
migration's checksum no longer matches the file on disk, or a migration is
recorded as failed, rolled back, or no longer present. `prisma migrate deploy`
applies only what is pending and never re-reads an applied migration, so an
edited migration leaves the test database on the old version while reporting
"No pending migrations to apply" — and an edited unpushed migration is the
normal case while a slice is under review. The rebuild is what makes the suite
run against the migration that is actually in the diff.

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

## One receipt

There were two. The trigger stamped a ledger row when the sixth pinned piece
landed; `POST /api/files/:id/borrowers` separately read the projected loan
file, judged the same six for itself, and wrote `loan_files.application_received_at`
— and APP-002, the requirement that says an application exists, read the
column. So the state machine and the requirements engine each had their own
opinion of the moment a credit request began, computed from different inputs
(pins and the active scenario on one side, a borrower row and an income
argument on the other), and nothing held them together. They disagreed
routinely: the column was stamped from a screen-2 save that had not yet
pinned anything, while the ledger still said draft.

APP-002 now reads the ledger's `intake_completed` row: its `occurred_at` is
`receivedAt`, and the six flags are the pins and the scenario, mapped onto the
engine's older words. The row is the one that opened the Loan Estimate clock,
so it is the one a borrower is entitled to be measured against. A file with no
application answers null, which reads as APP-002 outstanding — the truthful
answer for a file made before applications existed, rather than a receipt
nobody can point at.

What licenses the pins that fire the receipt is the party's live grant for
exactly one purpose, `FCRA_WRITTEN_INSTRUCTION`. Not "any live grant": an
opt-in to persistent monitoring mirrors to an account-review grant, which
covers no credit request and which the pin guard refuses outright, so a
looser question would have turned a monitoring opt-in into the authorization
an application was borrowed under and surfaced the refusal as a 403 on an
ordinary save.

A grant belongs to a person and lasts 120 days, so a borrower who applies
twice inside that window holds it on their second file before signing
anything there, and the second file is received on the screen-2 save rather
than on the consent that follows it a moment later. That is deliberate: TRID
measures receipt of the six pieces, not the collection of a signature, and
starting the clock earlier is the safe direction. It is worth revisiting if
the two posts ever stop arriving together.

The demo files the persona seed writes carry no application, and therefore no
receipt: they are inserted as rows rather than driven through the routes that
open a credit request, so APP-002 reads outstanding on them and will until the
seed goes through those routes — a state chosen here rather than discovered on
staging.

Two smaller things went with it. The API's second `addBusinessDays` — no time
zone, local date arithmetic — is gone, so the Loan Estimate's due date has one
source, the SQL function in the creditor's zone, and the two cannot disagree
across a daylight-saving boundary. And `borrowers` is now ordered: every route
reads `borrowers[0]` and means the person whose request this is, which was the
physical order of the rows.

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

## A borrower row is a record about a person, and identifies nobody

As of 8 September 2026 the `borrowers` table holds nothing that identifies
anyone. Name, date of birth, the SSN vault handle, contact details, address,
marital status, citizenship, language, military service and first-time-buyer
status are facts on the party — written by screen 2, read by the projection —
and the columns that used to duplicate them are gone. `party_id` is NOT NULL:
there is no such thing as a borrower row about nobody.

What stays on the row is what is genuinely per application: the SSN last-4
for display, the ID-verification session, the non-borrowing-spouse question
(which turns on the property's state), rent and current housing, and the HMDA
demographics, which the law collects per application.

**The migration backfills before it drops.** There are no users yet, but the
staging and development databases hold demo files and developer sign-ins, and
"no users" is not a licence to leave a database broken. Every borrower row
without a party gets one — reusing the file owner's party where they have one,
so a developer with several files ends up as one person — plus a principal and
its facts, built from the columns. Every existing consent gets its mirrored
authorization, because the trigger that mirrors new ones fires only on
INSERT. Only then do the columns go. The development database, six migrations
behind at the time, was the rehearsal: the backfill ran against real seeded
rows before it reached staging.

**The projection is strict now.** With no column to fall back to, a missing
or malformed required fact is an invariant violation, and `loadLoanFile`
throws naming the borrower and the predicate rather than rendering a blank
name and letting a screen carry on. Three fields keep the defaults the old
columns had — language, military service, first-time-buyer — because absence
there is a real answer.

**The minter reads `authorizations` and nothing else.** The bridge that
converted a loan file's legacy consents into grants came out of the connectors
package with the columns it read. `tokenFor` in the API is the only minter, a
refusal is attributable to exactly one table, and the connectors tests mint
from grants through the same pure function the API uses.

**A signature renews a lapsed grant and leaves a live one alone.** The unique
index on `authorizations` admits one unrevoked grant per (party, purpose) and
deliberately ignores expiry — `now()` cannot be indexed on, and a lapsed row
blocking a duplicate is the safe direction. That made renewal a revoke-then-
grant, and nothing revoked: a lapsed grant held the slot forever, every later
signature was an `ON CONFLICT DO NOTHING`, and once `tokenFor` stopped
falling back to `consents` there was no route that could get the party out.
So the mirror trigger now retires a grant that has lapsed by the time of the
new signature (reason `lapsed; renewed by a new consent`, revoked by the
party's own principal) and mints anew, and the migration replays every legacy
consent in signature order under the same rule. A signature against a
STILL-LIVE grant is a no-op: the first live grant stands and the clock does
not restart. Restarting it would mean the newest envelope silently replaced
the disclosure the person actually agreed to, and the index exists precisely
so that "which disclosure" has one answer. A consent inserted already revoked
mirrors as already revoked, for the same reason a revocation cannot be a bare
timestamp, and it retires nothing: only a live signature closes a lapsed
grant. Two edges of that rule are worth knowing. A party with no BORROWER
principal can never have a lapsed grant retired, because there is nobody to
attribute the revocation to; nothing in the schema forces the principal to
exist, and `party.ts` and the backfill always create it, so the case is
unreachable rather than impossible. And a consent inserted already revoked
for such a party fails its own INSERT on the `authorizations` revocation
CHECK, loudly, by design — a revocation nobody made is not a row we keep.

**The migration checks that every backfilled party will project before it
drops a column**, and a failing row aborts the whole file with the columns
still in place. Prisma records that as a failed migration: the next deploy
refuses to apply anything until the row is fixed and
`prisma migrate resolve --rolled-back 20260908170000_borrowers_are_records_about_parties`
has been run.

## A pin follows the person, and an ended application still takes the save

A pin is the evidence an application relies on NOW, and every screen that
supersedes a fact re-points every open application the person is applying on —
screen 1's income correction, screen 2's name and SSN, and the consent that
first licenses any of it. It was briefly true of the income and not of the
name, because screen 1 reconciled the party and screen 2 reconciled only the
file the request was about; a person with two files who fixed their surname on
the second left the first application pinned to a name they had taken back.
There is no reading of a pin under which that is right for one of the six
pieces and wrong for another, so screen 2 reconciles the party too. An
application that has ended is left alone wherever this runs: its evidence is
the record of what it was decided on.

**Open, and for Joe.** An application that has ended still accepts the save
around its evidence. `POST /files/:id/borrowers` and `POST /files/:id/consents`
answer 201 at a withdrawn file's URL and write a borrower row, a consent row
and party facts; only the pins refuse. Nothing is corrupted by it — the pins,
the ledger and the clocks are what the ending was made of, and none of them
move — but whether a person may go on editing a file they withdrew is a
question about the product, not about the code, and it would arrive as a new
refusal and a new piece of borrower-facing copy. Recorded here rather than
decided inside a commit scoped to something else.

Reconciling the person also means one save can complete a DIFFERENT file's six
pieces — the file started at screen 1 and left there needs only a name, an SSN
and an income — so the receipt fires on an application the request was not
about. Whatever the reconciliation received is settled too, at the same time,
by the same function. An application that is received and owes nothing is a
file showing "We have it" with no obligation on its ledger and no screen
anywhere asking for its bank, which is the one thing that made the join worth
building.

## Two write races we are living with, and what they cost

Both are a read followed by a write in a second transaction, both are narrow,
and both would cost a lock or an index to close. Written down so the next
person to find a duplicated row knows it is a known window rather than a new
bug.

**Two consents for one signature.** `signedOn` asks whether a live consent of
this kind already stands and the caller writes one when it does not
(`apps/api/src/services/signature.ts`), so two posts arriving together — a
double-pressed button, a retried save — can each find nothing and each write a
row. Only one grant follows them: `authorizations_one_live_per_party_purpose`
is a partial unique index and the mirror trigger inserts `ON CONFLICT DO
NOTHING`, so the pins, the expiry and the revocation are all unambiguous. What
is wrong is the consent history, which says the borrower signed the same thing
twice in the same second. Closing it needs either a unique index over the live
rows or a locking read, and neither belongs in a commit that adds no migration.

**Two live facts for one predicate.** `assertFacts` retires the prior
assertion by finding it and pointing it at the successor
(`apps/api/src/services/party.ts`), so two asserts of one predicate on one
party can each find the same prior and leave two rows with nothing superseding
them. `liveFact` breaks the tie by `observedAt`, and a pin names whichever it
answered, so the effect is that one of the two assertions quietly loses rather
than the chain breaking. No screen writes one predicate twice at once today —
screen 1 and screen 2 are sequential, and a person's two files are two requests
apart — which is why this is recorded rather than fixed.

## Two things the join left standing, on purpose

**An application that has ended still accepts the writes around its ending.**
Bank, documents, consents, borrowers and the decision all answer success on a
withdrawn file. The EVIDENCE is protected — `pinTridPieces` refuses a terminal
application whoever asks, and reconciliation skips one — so nothing rewrites
what a file was decided against. What is not refused is the write itself: a
withdrawn file can still take a borrower row and a consent row. Refusing them
is a new bar on a route a borrower already uses, and that is a product
decision about what withdrawal means, not a tidy-up to slip into a commit
scoped to something else. Recorded here so it is chosen rather than inherited.

**The `irs` branch cannot be reached.** `branchesFor` offers a branch only for
outstanding work whose `source` is one the borrower must personally supply, and
no requirement on the tax-transcript screen carries one — the 4506-C is a
signature we already collect on screen 4, and the pull is ours. The route, the
page and the vocabulary all exist; nothing routes to them. Either the branch is
dead vocabulary or `data/v1-build.csv` is missing a row that would make it
live, and that is a question for the sheet rather than for the code.

## Which ending the review screen renders, and in what order

The endings used to be chosen by the arithmetic: a monthly payment and a
debt-to-income ratio that computed meant "Your Loan Estimate", whatever the
engine had concluded. They are chosen by the decided word and the
application's state now. Four parts of that order were arguable, so they are
written down rather than left in the code to be re-litigated.

**Work the borrower can still finish outranks a referral.** The natural
reading puts `referred` first — it is the outcome this commit exists to make
sayable, and it must never render as an estimate. But a referred file that
still owes a paystub is already in `awaiting_borrower`, and the pill above the
ending reads "Needs you". The referred words say "Nothing is needed from you
right now" and render no branch cards, so putting them first tells a borrower
to act and then gives them nothing to act on. A referral has decided nothing;
the branch cards are the only thing on that screen the borrower can do. The
estimate is still unreachable from `referred` either way, which is the part
that had to hold.

**A decided word only renders once the machine has taken its edge.**
`POST /files/:id/decision` records the computation whether or not there is an
edge for it, on purpose — the row is evidence the engine ran. From
`awaiting_borrower` neither a decline nor a counteroffer is legal, so the
ledger writes `decision_not_applied` and the file stays where it is. Reading
the word off the row alone put "Not that loan — but here's one we can do"
under a "Needs you" pill for an application nobody had counter-offered, which
is the same collapse as a refer wearing an approval. The ending checks the
state the word lands on: `adverse_action_pending` or `denied` for a decline,
`counteroffer_outstanding` for a counteroffer. A file with no application has
nothing to check against, so there the outcome is all there is.

**A decline is read before the file is read as "ended".** `denied` is itself a
terminal state, and terminal states render as their own history and nothing
else. That would have hidden the recorded reasons on the one state the written
notice is actually owed from, so the adverse ending is chosen first.

**`approved` is left out of the states that render as the state.** The list of
states past deciding otherwise reads as "at or after a decision", and
`approved` is plainly one of those — a `clear_to_close` outcome lands the
application there. It is excluded anyway, because the control that records the
borrower's intent to proceed exists on exactly one surface: inside the estimate
ending. Listing `approved` rendered the best outcome the product can reach as a
pill and a Done button, and left APP-007 with no control on any screen. The
departure is one state wide — `clear_to_close`, `closing`, `rescission_pending`
and `funded` all still read as their state, because there the estimate really
is behind the file.

## The one line a screen says instead of the state's

`ApplicationStanding` renders the state's own heading beside the pill on every
screen — only the heading; a state's body is written for the gallery and never
reaches a file page — with one override, used once: the review screen before
the signature. That file is `in_underwriting`, because the bank screen posts
the decision before it navigates to the review screen and the review screen
posts one itself when it arrives without one. Its heading is "Being decided",
printed directly above the button asking the borrower to sign the thing that
would let it be; a file that still owes a branch is `awaiting_borrower`, and
names the branch rather than the signature. Nothing in the ledger can fix
either from below, because `esign` is deliberately outside the obligations the
flow tracks, so no state ever reads "Needs you" for a missing signature. Making
the signature an obligation was the alternative and it is the larger change: it
would put a `borrower_owes` row on every file between the bank screen and the
signature, which is a claim about what the borrower owes us, not a fix to a
heading. The pill and the date stay the state's; only the heading belongs to
the view.

**The second one is the signed-in home page, and it covers the whole of
`in_underwriting`.** That state's heading is "Being decided" and its meaning is
that a named actor holds the file. Both are false: there is no role on `User`,
no assignment and no queue, and essentially every real file lands there because
the four compliance derivations record `blocked`. So the card says
`REFERRED_COPY.headline` — "We're reviewing this ourselves." — for the state
rather than for one outcome. Overriding it only where the newest decision row
reads `referred` was the alternative, and it reprints "Being decided" on the
sibling branch, which is reachable: a decision whose edge the machine refused,
or a signature with no decision row at all. The lead is a claim about **who
holds the file**, and that is unchanged by the word the engine returned, so the
override covers the state and the body carries the difference. The pill stays
neutral and stays the state's, because a file being worked on is not a file
that went wrong.

## Sample borrowers are real rows behind a flag

A tester needs to see what a file in each state looks like, and the only
honest way to show that is to have walked one there. So the sample borrowers
are not fixtures rendered into a gallery: each one is a `users` row, a
`loan_files` row and an application whose every state was written by the same
services the four screens call. Signing in as one mints a real session — a
real `user_sessions` row and the same `hm.sid` cookie — because a picker that
faked a session would be showing a tester a product nobody else can run.

That is a session minter that needs no Google credential, so it is behind
`DEMO_PERSONAS=true` and it MUST NEVER be set on a real production deploy.
The flag cannot key off `NODE_ENV`: staging runs `NODE_ENV=production`, and
the deploy environment is the only thing that tells the two apart. With the
flag off the routes are not mounted at all, and `signInAsPersona` answers 404
rather than 403 — a refusal that admitted the endpoint exists would make the
flag visible to anyone who tried it. `/api/health` reports `personas`, and the
deploy asserts it, because the one thing that must never happen to this flag is
that nobody notices it is on.

Read-only is enforced three times over, and each layer catches what the others
cannot:

1. **The file.** Every persona file is `is_demo` with a `user_id`, so
   `assertFileAccess` refuses every write from everyone — the persona
   included — and allows every signed-in reader. That is the existing demo
   rule; what is new is that a demo file now belongs to somebody, so the
   persona sees it under "Yours" while nobody can change it.
2. **The session.** `personaReadOnly` refuses every `/api/*` request from a
   persona session that is not a GET, HEAD or OPTIONS. This is the layer that
   matters: the file rule can only see a file, and a persona POSTing
   `/api/files` would get a brand-new file that is NOT a demo file, own it,
   and be free to edit it. Mounted on the line after `requireAuth`, so a
   router added later cannot forget it — and a test reads `index.ts` to say
   so, because a test that re-declares the wiring proves only its own copy.
3. **`DELETE /api/auth/me`**, which is mounted before that gate because
   signing out has to stay possible, and so carries the same refusal itself.

The persona `users` row is keyed on `persona_key`, which is what makes the
seed idempotent and what both refusals read. It is a column on `users` rather
than a table of personas because the persona IS a user.

## A co-borrower is named, not described

The applicant names the person they are applying with — first name, last
name, email, and whether they will live in the home — and nothing else. The
co-borrower states everything else about themselves in their own session: a
separate, private application, where their date of birth, their address and
their Social Security number are theirs to give. That is the design the
product was built to, and it is why `POST /files/:id/co-borrowers` refuses an
identity rather than stripping it to the name inside: an applicant typing
somebody else's number is the shape the route exists to end.

A named person is a PROVISIONAL party holding two facts under the applicant's
principal, a borrower row with no `ssn_last4`, and a membership at the next
position — listed on the file as `invitedBorrowers`, never among `borrowers`,
because a person with no date of birth is not one the engine can evaluate and
`requireIdentity` would rightly throw on them. The file waits instead. Three
gates say so in the product's own words, "Your co-borrower needs to finish.":
signing and deciding refuse with `CO_BORROWER_PENDING`, and the assembler
refuses the party by name before a generic "no date of birth" could say it
worse. Removing a named person is the applicant's to do only until the person
has arrived; a party that has claimed or merged is somebody who agreed to be
here, and leaving is theirs.

The whole-identity writer survives as `appendCoBorrowerWithFacts`, the paper
joint URLA, because the seed and the tests build complete households with it
and a phone-taken application is a real shape. No screen offers it.

**Arriving is a merge, and the link is the whole of the trust.** The named
person is a PROVISIONAL party, and `parties_claim_status_moves_forward` lets
such a party go to `CLAIM_PENDING` or `MERGED` and nowhere else — there is no
edge to CLAIMED, on purpose, because "claimed" means a person came to us and
a row the applicant typed never did. So the invitation moves the party to
`CLAIM_PENDING`, and accepting it — signed in with Google, the only way in —
finds or mints the person's OWN party, CLAIMED, and folds the named one into
it: `mergePartyInto` now moves the borrower row and the membership as well
as the loan parties, and the two facts the applicant stated are restated on
the survivor under the applicant's principal, so the name does not vanish
behind the merge pointer. The token is 32 random bytes in the emailed URL and
its SHA-256 in `co_borrower_invitations`, seven days, one live per person; a
re-send revokes the last. It is never logged, never returned — except where
developer sign-in is available, the one environment with no inbox, under
exactly that gate. And never an email match at sign-in: the address the
applicant typed is where the link went, not who may follow it, and a stricter
rule would refuse a person whose Google account is not the address their
partner had for them.

**The privacy promise holds in both directions, and the link is the only
place the token is.** A review of the co-borrower commits found the read
one-sided: a member's read was redacted to the household's half, and the
applicant's read carried the co-borrower's whole person, answers and
transcripts — under a screen that told the co-borrower the opposite. Now
everybody but the reader is reduced to a name and two facts — answered, and
signed — whoever reads, and `GET /files/:id/declaration` reads the asker's
own row and nobody else's. The invitation token rides in the URL fragment,
which a browser never sends to a server, and reaches the API in a POST body;
a path is written to every request log between the browser and the process.
Taking an invitation is a press, not a page load, since the account signed
in on a shared browser is not necessarily the person the link was sent to,
and a merge is not undone. A co-borrower's signature settles nothing of the
applicant's, moves no stage, and is not held by a third person still
pending; their account cannot be deleted while it holds a row on somebody
else's application; a sample borrower cannot take a real person's
invitation; and a person whose identity was stated on their behalf cannot
be invited at all, because the claim would merge a stated identity into a
party that carries none of it.

**Each person signs for themselves, and a route means "the borrower" by
who is asking.** A joint application has one signature per person: the
applicant's is the file's `applicationSignedAt`, and a co-borrower's is a
consent row of kind `application_signature` in their own name, written in
the same act as their own 4506-C and never touching the column. The rule
that made this possible is smaller than it sounds: every route that took an
absent `borrowerId` to mean Borrower 1 now takes it to mean the person
asking, by their own row on the file, and falls back to Borrower 1 only for a
reader with no row. `assertFileAccess` gained the vocabulary — `read` for
anyone on the file, `self` for a person's own screens, `write` and `own` for
the applicant — and the co-borrower's read of the file is redacted to the
household's half and their own, because "your private identity details and
credentials stay private" is a promise kept in the response rather than in
a screen.

**The sample household goes through the same doors.** Priya and Dev used to
be built as two complete people by hand — a second CLAIMED party with every
identity fact under it, written straight into the seed. Now the seed names
him through `nameCoBorrower`, sends the link through `inviteCoBorrower` on
the fixture mailer, reads the token back out of the outbox the way a person
reads it out of an inbox, mints him a sign-in of his own and takes the link
through `acceptClaim`, then walks his half the way his screens would: his
facts under his own principal, his Section 5 attested by himself, his
signature as a consent row in his name. Three services gained the
`recordDeclaration` re-entry idiom for it — handed the top-level client they
open a transaction and call themselves with it; handed one, they do the work
in it — because a walk is one transaction and Prisma cannot nest them. The
reason is not tidiness: a sample built beside the flow drifts from it the
first time the flow changes, and a tester signing in as Dev would be reading
a co-borrower no co-borrower could have become. Built through the flow, the
sample cannot say anything the product would not.

## A household's numbers are the household's

A loan with two borrowers carries two credit reports, two asset reports and
two sets of transcripts, and every figure on the decision is about the loan.
The file-level `credit`, `assets`, `payroll` and `transcripts` stay Borrower
1's, by party, because the screens read them; `LoanFile.reports` carries
everybody's, and `household()` in `@hm/shared` is the only way the engine and
the requirement evaluators read a report now. Decided 2026-09-17.

**The score.** Each borrower's own score is the middle of three bureau scores,
the lower of two, the one. The loan's representative score is the LOWEST of
those, and it is what pricing reads on every loan. The 620 minimum is tested
against the representative score on a one-borrower loan and against the
average of the borrowers' own scores, rounded to the nearest whole number, on
a loan with more than one. That is the Selling Guide's rule for a manually
underwritten loan (B3-5.1-01 and B3-5.1-02, both effective April 22, 2026),
and the nearest rule there is for a shadow engine: DU runs its own model on
the report data and states no score of its own. The rounding is ours; the
guide's example divides evenly.

**A missing report blocks, and names the person.** The score, the liabilities
and the utilization are blocked while any borrower has no credit report, with
"credit report for Dev Raman" as the reason. A lowest-of-one on a two-person
loan looks exactly like the loan's score and is not, and a DTI short one
person's debts is a number that looks like an answer. Reserves are the
opposite case: computed on whoever has connected a bank, with the derivation
counting who has not. Assets only add, so a co-borrower without a bank link
leaves the household with fewer reserves rather than with none.

**A joint account is one account.** A tradeline on both credit reports is one
obligation — `DI-C09` in the DU corpus is one `LIABILITY` with two obligors —
and a deposit account on both asset reports is one balance. Same creditor,
kind and opening date; same institution, kind and mask. The derivation
records how many it folded, so the two fixtures a sample household shares
read as one report rather than as a household twice in debt.

**Transcripts are compared once everybody's are in.** Income rows carry no
party, so the wages they are checked against are every borrower's latest
transcript, summed, and INC-009 is not computed until each borrower has one.
One person's wages against two people's income is a variance nobody would
recognize.

**A non-occupant co-borrower caps the LTV at 95.** Selling Guide B2-2-04, for
a DU casefile with a co-borrower who will not occupy the property. The
projection carries each borrower's `occupiesProperty` off their application
role, and `maxLtvFor` takes the lower of the purpose's ceiling and 95 when
anybody's is false.

**Every read of the file is redacted to the reader's own reports.** The engine
runs on the server with all of them. The one route that serializes a file
strips `reports` to the reader's party, applicant included: a co-borrower's
tradelines are their whole financial life, under a screen that promised them
it stays theirs.

## The pulls write the rows a casefile carries

`du_assets` and `du_liabilities` had writers and nothing called them, so a
real file's casefile emitted neither what the borrower had nor what they owed.
The credit pull and the bank pull now reconcile their reports into rows in the
same transaction as the snapshot — `services/liabilities.ts` and
`services/assets.ts`, the shape `services/income.ts` set — owed or owned by
the person whose report it is, matched in place on a re-pull, retired when a
report drops them, never deleted. Decided 2026-09-17. The engine still reads
the snapshots; these are what the submission carries.

**What a tradeline becomes.** The bureau's kind on DU's list: a mortgage is a
`MortgageLoan`, a card is `Revolving`, a HELOC a `HELOC`, and an auto loan, a
student loan and any other installment are `Installment`, because DU's list
has no finer name. A tradeline the bureau could not classify is `Other` with
one fixed description. No account number, because a credit report carries the
vendor's tradeline id and not the account's. The exclusion indicator follows
the CRD-003 reason code, so the casefile says what the decision did. Nothing
is paid off at closing, because that is the borrower's statement and no pull
can make it. Which owned property secures a mortgage is a person's pairing,
not a match on a creditor's name.

**What an account becomes.** Only accounts the borrower uses to qualify, on
their own answer from the bank screen; a retirement account at its vested
balance, which is what could be withdrawn; a brokerage account on the Stocks
line. A gift is a `GiftOfCash` from the donor the report names, the
relationship mapped onto DU's source list and `Other` carrying the report's
own word, marked as already in the account because the report saw it land. A
gift has no vendor id, so its item id is the donor and the transfer date.

**A joint account pulled by two people is two rows.** The identity key opens
with the party (`packages/du/src/identity.ts` says why), so each person's
pull writes their own row. The household's decision folds the pair, because
it reads the snapshots; collapsing the rows on the wire has a whole balance
riding on it and is a person's call on the way out, not a coincidence of keys
on the way in.

## The decision route submits, and a refusal is a row

Every piece of the Desktop Underwriter path existed and was tested alone, and
nothing called it. `services/du-submission.ts` is the string: after every
decision, assemble, gate, emit, send through the `du` port, record — the
route and the persona seed both go through it. Decided 2026-09-17.

**A refusal is an outcome with a name, never a silence.** The placeholder
institution or originator in production, a borrower with nothing retrieved
about them, a casefile the preflight refuses, a transport that dropped: each
returns a status and writes a `FileEvent` saying why, and the shadow decision
above it stands. A preflight refusal carries XPaths and labels and never a
value, so it is safe in a log. A transport failure says whether a case may
have been opened, because a resubmission that carries no case identifier
opens a second case for one loan.

**Nothing here is a decision.** What comes back is Fannie Mae's assessment of
a loan they might buy. `recordDuResponse` moves no application; the answer is
read back beside the decision through `GET /files/:id/du-responses`, owner
only, and a resubmission carries the casefile DU minted the first time.

**The document is never stored.** It carries up to four cleartext social
security numbers; it lives in memory between the emitter and the transport.

**There is no vault, and the fixture path says so.** `ssn_vault_handle` is
opaque and nothing resolves it. Against the FIXTURE port the resolver hands
the assembler a nine-digit value in the 000 area, which the Social Security
Administration has never issued, deterministic per party; the fixture reads
nothing. Against Fannie Mae there is no resolver, the container is omitted,
and the gate refuses every borrower by name. Where the nine digits live is a
decision before it is code.

**The first full walk found two defects on every seeded file.** The seed
recorded the county's snapshot and never wrote the unit count and attachment
onto the file, which the route did; both now go through
`services/building-facts.ts`. And a telephone number went out as a person
typed it — `512-555-0134`, twelve characters at a destination that takes ten
— so the assembler renders ten digits, whatever was typed around them, and
never invents a number that fits.

## Still outstanding

Five vendor decisions plus sandbox credentials, none obtainable from inside
this repo. Email is settled — Resend — and the co-borrower invitation is the
first thing sent through it; the clocks above still wait on their own
messages:

| Connector                       | Constraint                                                 |
| ------------------------------- | ---------------------------------------------------------- |
| Credit (soft tri-merge)         | Reseller or bureau-direct; needs FCRA permissible purpose  |
| Payroll (consumer-permissioned) | Aggregator                                                 |
| IRS transcripts                 | IVES participant or a reseller                             |
| E-sign                          | For APP-005, APP-012 and INC-008                           |
| Pricing                         | Engine or investor execution; only the ANSWER takes either |

Plus: the CLS-* closing-stage sheet, the requirements for the monitoring loop,
a real tax/insurance source, the real LLPA matrix, a real fee table, and a real
mortgage-insurance rate card — the one input that keeps every loan above 80%
LTV at `referred`. The APOR is off this list: the CFPB's published table is
fetched daily and cross-checked against their own method.

## One-time infrastructure prerequisite

CI cannot authenticate to GCP until `Walt-Home/Homestead Mortgages` is added to the
Workload Identity provider's attribute condition and to
`hm-github-actions@`'s `workloadIdentityUser` binding. Both currently
allowlist exactly two repositories. The two commands are in the header of
`.github/workflows/deploy.yml`.
