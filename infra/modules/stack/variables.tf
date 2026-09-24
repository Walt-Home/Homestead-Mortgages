# One environment of Homestead Mortgages: what an environment owns and nothing
# an environment shares. See the root's main.tf for what is shared.

variable "environment" {
  description = "staging | production. Suffixes every name here."
  type        = string
}

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "instance_name" {
  description = <<-EOT
    The environment's Cloud SQL instance. Its own, not a database on another
    environment's instance: Cloud SQL users are instance-scoped, so two
    environments on one instance could open each other's databases, and a
    production instance is where point-in-time recovery, maintenance windows
    and CPU contention get to be production's alone. Staging's keeps the name
    it had when it was the only one.
  EOT
  type        = string
}

variable "db_tier" {
  type    = string
  default = "db-g1-small"
}

variable "public_ip_enabled" {
  type    = bool
  default = true
}

variable "service_account_email" {
  description = "hm-run@: the API's runtime identity, shared by every environment."
  type        = string
}

variable "servicing_run_service_account_email" {
  description = "hm-servicing-run@: the servicing app's runtime identity, shared by every environment."
  type        = string
}

variable "scheduler_service_account_email" {
  description = "hm-scheduler@: invokes this environment's jobs on their schedules."
  type        = string
}

variable "image" {
  description = "The API image the jobs are created with; the deploy updates the tag."
  type        = string
}

variable "servicing_image" {
  description = "The servicing app's image the sweep is created with; the deploy updates the tag."
  type        = string
}

variable "database_url_secret" {
  description = "Secret Manager secret holding this environment's API connection string."
  type        = string
}

variable "servicing_database_url_secret" {
  description = "Secret Manager secret holding this environment's servicing connection string; read by the servicing identity and nothing else."
  type        = string
}

variable "servicing_api_token_secret" {
  description = "Secret Manager secret holding the bearer the servicing app's /v1 door takes; both identities read it."
  type        = string
}

variable "refi_analyst" {
  description = "on mounts the Anthropic key on the review job; off leaves the model off."
  type        = string
  default     = "off"
}

variable "anthropic_api_key_secret" {
  type    = string
  default = "HOMESTEAD_MORTGAGES_ANTHROPIC_API_KEY"
}

variable "apor_fetch_schedule" {
  type = string
}

variable "loan_review_schedule" {
  type = string
}

variable "servicing_sweep_schedule" {
  type = string
}

variable "notification_channel_id" {
  description = "Where a failed job is reported; null disables the alerts."
  type        = string
  default     = null
}

variable "servicing_console_members" {
  description = "Who may pass Identity-Aware Proxy on this environment's servicing hostname."
  type        = list(string)
}

variable "iap_service_agent_member" {
  description = "The project's IAP service agent, which must be able to invoke the API service behind the servicing hostname."
  type        = string
}
