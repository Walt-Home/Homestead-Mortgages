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
