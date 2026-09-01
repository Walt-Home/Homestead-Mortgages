variable "project_id" {
  description = "GCP project. Shared with Walt and Homestead; the SQL instance is not."
  type        = string
  default     = "walt-489214"
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
    Password for supermortgage_app. Generated out of band and passed at apply
    time; `ignore_changes` keeps rotations from reverting. Never commit it — a
    password in a tfvars file is a password in the state bucket.
  EOT
  type        = string
  sensitive   = true
}

variable "service_account_email" {
  description = <<-EOT
    Runtime identity for the Cloud Run service. Deliberately NOT
    walt-cloud-run@, which holds project-wide secretmanager.secretAccessor and
    storage.objectAdmin — running as it would give this container read access
    to every secret in the project and delete rights on Walt's buckets.
    supermortgage-run@ has cloudsql.client and access to one secret.
  EOT
  type        = string
  default     = "supermortgage-run@walt-489214.iam.gserviceaccount.com"
}

variable "image" {
  description = "Fully qualified container image, set by the deploy workflow."
  type        = string
}

variable "database_url_secret" {
  description = "Secret Manager secret holding the connection string."
  type        = string
  default     = "SUPERMORTGAGE_DATABASE_URL_STAGING"
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
  default = "https://supermortgage-staging.trywalt.ai"
}

variable "access_passphrase_secret" {
  description = "Secret Manager secret holding the prototype gate passphrase."
  type        = string
  default     = "SUPERMORTGAGE_ACCESS_PASSPHRASE"
}

variable "public" {
  description = <<-EOT
    Whether the service is routable by anyone. True is only defensible while
    connector_mode is "fixture" and the ACCESS_PASSPHRASE gate is set — it
    exists because Cloud Run IAM auth cannot be satisfied by a browser, so an
    IAM-protected URL is not a link anyone can open. Set false before real
    borrower data exists.
  EOT
  type        = bool
  default     = true
}

variable "invoker_members" {
  description = "Who may call the service when `public` is false."
  type        = list(string)
  default     = []
}
