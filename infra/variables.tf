variable "project_id" {
  description = "GCP project. Shared with Walt and Homestead; the SQL instance is not."
  type        = string
  default     = "homestead-mortgages"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "environment" {
  description = "staging | prod. Suffixes the database and the Cloud Run service."
  type        = string
  default     = "staging"
}

variable "db_tier" {
  description = "Cloud SQL machine type. db-g1-small is roughly $25/month."
  type        = string
  default     = "db-g1-small"
}

variable "public_ip_enabled" {
  description = <<-EOT
    Whether the instance has a public IPv4 address. True is safe here BECAUSE
    there are no authorized networks: reachability still requires the Cloud SQL
    Auth Proxy or the Cloud Run socket, both IAM-authenticated. Set false only
    once private services access is configured on the VPC.
  EOT
  type        = bool
  default     = true
}

variable "db_password" {
  description = <<-EOT
    Password for homestead_mortgages_app. Generated out of band and passed at apply
    time; `ignore_changes` keeps rotations from reverting. Never commit it — a
    password in a tfvars file is a password in the state bucket.
  EOT
  type        = string
  sensitive   = true
}

variable "service_account_email" {
  description = <<-EOT
    Runtime identity for the Cloud Run service. Holds cloudsql.client and
    secretAccessor on exactly the secrets it needs, granted on the secrets
    rather than the project — so a compromised container cannot enumerate
    Secret Manager.
  EOT
  type        = string
  default     = "hm-run@homestead-mortgages.iam.gserviceaccount.com"
}

variable "image" {
  description = "Fully qualified container image, set by the deploy workflow."
  type        = string
}

variable "database_url_secret" {
  description = "Secret Manager secret holding the connection string."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_DATABASE_URL_STAGING"
}

variable "connector_mode" {
  description = "fixture is the only implemented mode; anything else throws at boot."
  type        = string
  default     = "fixture"

  validation {
    condition     = contains(["fixture", "sandbox", "production"], var.connector_mode)
    error_message = "connector_mode must be fixture, sandbox or production."
  }
}

variable "cors_origin" {
  type    = string
  default = "https://homestead-mortgages-staging.trywalt.ai"
}

variable "session_secret_secret" {
  description = "Secret Manager secret holding the session signing key."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_SESSION_SECRET"
}

variable "google_client_id" {
  description = <<-EOT
    OAuth client id for Google sign-in. Public by design — it is embedded in
    every page that offers the button — so it is a variable, not a secret. The
    server refuses to boot in production without it.
  EOT
  type        = string
  default     = ""
}

variable "allowed_domain" {
  description = "Workspace domain permitted to sign in."
  type        = string
  default     = "trywalt.ai"
}

variable "public" {
  description = <<-EOT
    Whether the service is routable by anyone. True is correct here: Google
    sign-in is enforced in the application, and Cloud Run's own IAM auth cannot
    be satisfied by a browser — using it would mean nobody could open the link.
    "Routable" is not "accessible"; every /api route past /health and /auth
    requires a session.
  EOT
  type        = bool
  default     = true
}

variable "invoker_members" {
  description = "Who may call the service when `public` is false."
  type        = list(string)
  default     = []
}

# ── Plaid ────────────────────────────────────────────────────────────────────

variable "plaid_client_id" {
  description = <<-EOT
    Plaid client id. Not a secret in the way the secret is — it identifies the
    account rather than authenticating to it — so it travels as a variable,
    the same treatment google_client_id gets.
  EOT
  type        = string
  default     = ""
}

variable "plaid_secret_secret" {
  description = "Secret Manager secret holding the Plaid API secret."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_PLAID_SECRET"
}

variable "vendor_token_key_secret" {
  description = <<-EOT
    Secret Manager secret holding the AES-256-GCM key that encrypts vendor
    bearer credentials at rest.

    Deliberately NOT the key any developer machine uses. A Plaid access token
    reads a named person's bank transactions on demand for as long as the item
    lives, and a key shared with a laptop is not encryption at rest. The API
    refuses to boot without this when BANK_PROVIDER=plaid, rather than falling
    back to writing plaintext into a table.
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_VENDOR_TOKEN_KEY"
}

variable "plaid_product" {
  description = <<-EOT
    "cra" or "assets".

    CRA is the target: only a consumer report satisfies CRD-017's "authorized
    DU vendor". "assets" is the stand-in while that access is granted — real
    bank, real transactions, and honestly NOT a consumer report, so it reports
    vendorAuthorizedForDu:false and CRD-017 stays unsatisfied rather than being
    met by the wrong evidence.
  EOT
  type        = string
  default     = "assets"
}

variable "public_origin" {
  description = <<-EOT
    Where hosted vendors return the borrower — Stripe Identity's return URL and
    Plaid's report webhook. Must be the service's own https URL; empty means
    the API falls back to its localhost default, which is wrong everywhere but
    a developer machine.
  EOT
  type        = string
  default     = ""
}

# ── Stripe Identity and Google Places ────────────────────────────────────────

variable "stripe_secret_key_secret" {
  description = <<-EOT
    Secret Manager secret holding the Stripe SANDBOX key.

    Named for the sandbox deliberately. Live identity verification collects a
    real government ID and a real face scan from every person who walks the
    flow — biometric data carrying consent, notice and retention duties under
    Illinois BIPA and its equivalents, and BIPA has a private right of action.
    This deployment has no retention policy. The adapter refuses an sk_live_
    key unless STRIPE_ALLOW_LIVE_IDENTITY is set, which is why that variable
    does not exist here.
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_STRIPE_SECRET_KEY_SANDBOX"
}

variable "google_places_api_key_secret" {
  description = <<-EOT
    Secret Manager secret holding the Places API key.

    Called server-side from Cloud Run, which has no static egress IP, so an
    application restriction is not available — the meaningful control is the
    API restriction, and the key is narrowed to places.googleapis.com alone
    rather than the 35 Maps Platform services a default key carries.
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_GOOGLE_PLACES_API_KEY"
}

variable "plaid_redirect_uri" {
  description = <<-EOT
    Where an OAuth bank returns the borrower. Must be registered EXACTLY under
    Developers > API > Allowed Redirect URIs before it is set: Plaid rejects
    /link/token/create with INVALID_FIELD otherwise, for every link token
    rather than only the OAuth ones. Empty means non-OAuth banks work and
    OAuth ones do not, which /health reports as "no OAuth banks".
  EOT
  type        = string
  default     = ""
}

# ── The average prime offer rate ─────────────────────────────────────────────

variable "apor_fetch_schedule" {
  description = <<-EOT
    When the survey behind the average prime offer rate is fetched, as a cron
    expression in UTC.

    The CFPB posts a new survey on Thursdays; the APORs computed from it take
    effect the following Monday. Daily at noon UTC is deliberately more often
    than weekly: the fetch is idempotent — a document already held inserts
    nothing — and a run that finds nothing new costs a conditional GET. What
    the extra runs buy is a series that recovers on its own from a Thursday the
    file server was down, instead of a week of every decision blocking on
    UW-008 until somebody notices.
  EOT
  type        = string
  default     = "0 12 * * *"
}

variable "alert_email" {
  description = <<-EOT
    Where a failed scheduled fetch is reported. Cloud Scheduler sees a 200 the
    moment the job STARTS, so a run that exits non-zero — the series not
    covering the current week — reaches nobody unless an execution failure is
    itself alerted on. Empty disables the alert rather than creating a channel
    to nowhere.
  EOT
  type        = string
  default     = ""
}

# ── CoreLogic ────────────────────────────────────────────────────────────────

variable "corelogic_client_key_secret" {
  description = <<-EOT
    Secret Manager secret holding the CoreLogic client key. The portal calls
    the pair the master credentials for every CoreLogic API, which is why both
    halves are secrets rather than one variable and one secret: a client key
    alone still names the account the bill goes to.
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_CORELOGIC_CLIENT_KEY"
}

variable "corelogic_client_secret_secret" {
  description = "Secret Manager secret holding the CoreLogic client secret."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_CORELOGIC_CLIENT_SECRET"
}

variable "property_records_provider" {
  description = <<-EOT
    Who answers for the county record and the AVM beneath autocomplete:
    "corelogic" or "fixture". Separate from PROPERTY_DATA_PROVIDER so the
    Places autocomplete and the CoreLogic record can be turned on one at a
    time. The flood determination stays on the fixture either way.
  EOT
  type        = string
  default     = "fixture"

  validation {
    condition     = contains(["fixture", "corelogic"], var.property_records_provider)
    error_message = "property_records_provider must be fixture or corelogic."
  }
}

# ── The refinance analyst ────────────────────────────────────────────────────

variable "refi_analyst" {
  description = <<-EOT
    Whether the daily review's analyst turn runs: "on" mounts the Anthropic
    key on the review job, "off" leaves the model off and every review row
    says so. Gated the way CoreLogic is, because a job that references a
    secret with no version fails to start: create the secret first, then flip
    this. Nothing about the verdict changes either way — the analyst never
    decides.
  EOT
  type        = string
  default     = "off"

  validation {
    condition     = contains(["off", "on"], var.refi_analyst)
    error_message = "refi_analyst must be off or on."
  }
}

variable "anthropic_api_key_secret" {
  description = "Secret Manager secret holding the Anthropic API key the refinance analyst runs under."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_ANTHROPIC_API_KEY"
}

# ── Doug's servicing runtime ─────────────────────────────────────────────────

variable "servicing_image" {
  description = "Fully qualified container image for apps/servicing, built from apps/servicing/Dockerfile and set by the deploy workflow."
  type        = string
}

variable "servicing_database_url_secret" {
  description = <<-EOT
    Secret Manager secret holding the servicing app's connection string: its
    own database on the shared instance, as its own role. Read by the
    servicing runtime identity and by nothing else — in particular not by
    hm-run@, so the API's container cannot open the servicing database, and his cannot
    open ours because the role in this URL is a plain one that owns exactly
    one database (see main.tf).
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_SERVICING_DATABASE_URL_STAGING"
}

variable "servicing_api_token_secret" {
  description = <<-EOT
    Secret Manager secret holding the bearer his /v1 door takes outside
    production. The one secret both runtime identities read: his service to
    check it, our API to present it. In production his door refuses the
    shared token and this becomes a principal's token his `principals.issue`
    minted; nothing here is production.
  EOT
  type        = string
  default     = "HOMESTEAD_MORTGAGES_SERVICING_API_TOKEN"
}

variable "servicing_sweep_schedule" {
  description = <<-EOT
    When his sweep runs, as a cron expression in America/New_York — the zone
    his platform day is kept in. His own nonprod runs it every minute; every
    five is enough for a testing ground, because a sweep is one pass of every
    scheduled job and the passes with a clock (the daily refinance check, the
    record verify, the daily receipt) each fire once per platform day on
    their own schedule, whichever sweep first crosses it. The sweep lease
    keeps two firings from overlapping.
  EOT
  type        = string
  default     = "*/5 * * * *"
}

variable "loan_review_schedule" {
  description = <<-EOT
    When the daily refinance review runs, as a cron expression in
    America/New_York. His 33.2 reviews at 07:00 ET, after his 20.1 run at
    06:30; ours is one pass, so one time. A run reviews each monitored loan
    once for the day and writes nothing the second time.
  EOT
  type        = string
  default     = "0 7 * * *"
}

variable "consumer_hostnames" {
  description = <<-EOT
    The hostnames the consumer app answers on. Joe's choice, 22 September
    2026: the apex and www. Each gets a Google-managed certificate of its
    own, and each needs an A record at the registrar pointing at `edge_ip`.
  EOT
  type        = list(string)
  default     = ["supermortgage.com", "www.supermortgage.com"]
}

variable "servicing_hostname" {
  description = "The hostname Doug's runtime answers on; `/` there redirects to his console at `/ops`."
  type        = string
  default     = "servicing.supermortgage.com"
}

variable "servicing_console_members" {
  description = <<-EOT
    Who may pass Identity-Aware Proxy on the servicing hostname, as IAM
    members. Joe's list, 22 September 2026: Doug, Drew and Joe, signing in
    as their trywalt.ai accounts. Passing IAP reaches his console's own
    sign-in, not a session; the console's admins are made by his
    staff-bootstrap and his `staff.invite`, which is a separate list.
  EOT
  type        = list(string)
  default = [
    "user:doug@trywalt.ai",
    "user:drew@trywalt.ai",
    "user:joe@trywalt.ai",
  ]
}
