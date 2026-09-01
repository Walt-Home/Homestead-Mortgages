variable "project_id" {
  description = "GCP project. Shared with Walt and Homestead."
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

variable "sql_instance_name" {
  description = "Existing Cloud SQL instance. NOT managed by this configuration."
  type        = string
  default     = "walt-db"
}

variable "service_account_email" {
  description = "Runtime service account for the Cloud Run service."
  type        = string
  default     = "walt-cloud-run@walt-489214.iam.gserviceaccount.com"
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

variable "invoker_members" {
  description = "Who may call the service. Deliberately not allUsers."
  type        = list(string)
  default     = []
}
