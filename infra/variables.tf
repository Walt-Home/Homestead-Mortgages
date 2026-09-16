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
