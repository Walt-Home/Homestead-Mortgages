# Homestead Mortgages infrastructure.
#
# Its own GCP project (homestead-mortgages): own Cloud SQL, own Artifact
# Registry, own Workload Identity pool, own service accounts. It did not
# start that way — the first cut put the database on Walt's shared instance,
# and Cloud SQL users being instance-scoped is what moved it (see CLAUDE.md,
# "Infrastructure", for the argument, which is also why each environment
# below has an instance of its own).
#
# Two environments, one configuration (24 September 2026). Everything an
# environment owns — its database instance and databases, its jobs and their
# schedules, its alerts, its secret grants, its two backends on the front
# door — is `modules/stack`, instantiated once per environment from
# `var.stacks`. What is shared lives here: the three service accounts, the
# alert channel, and the front door in edge.tf (one address, one
# certificate per hostname, one URL map whose host rules send each
# hostname to its environment's backends). The Cloud Run services themselves
# are the deploy's — `gcloud run deploy` in .github/workflows/deploy.yml —
# and are declared nowhere here; Terraform owns the shape around a service
# and never the service or its image. See docs/decisions.md, "Two
# environments, one configuration".
#
# Terraform does NOT manage the Artifact Registry repository or the WIF pool.
# They pre-date this file, and importing them would let a `terraform destroy`
# here take the deploy pipeline down with it.
#
# Applied by hand, with local state, and always with `-target`: the module
# declares each environment's jobs with `var.image`, which the deploy owns,
# so a whole-configuration apply is never what anyone means.

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# The project, for the IAP service agent's number.
data "google_project" "this" {
  project_id = var.project_id
}

# ── The identities every environment shares ──────────────────────────────────
#
# hm-run@ (the API's runtime identity) and hm-github-actions@ (the deploy's)
# were made before this file and are named, not managed. The two below are
# this file's.

resource "google_service_account" "scheduler" {
  account_id   = "hm-scheduler"
  display_name = "Cloud Scheduler for Homestead Mortgages jobs"
  description  = "Invokes Cloud Run jobs on a schedule. Holds run.invoker on those jobs and nothing else."
}

resource "google_service_account" "servicing_run" {
  account_id   = "hm-servicing-run"
  display_name = "Runtime identity for the servicing app"
  description  = "Runs the servicing service and its sweep job. cloudsql.client, plus accessor on its own database URL and the door token, granted on the secrets themselves; nothing on the API's secrets."
}

resource "google_project_iam_member" "servicing_run_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.servicing_run.email}"
}

# Where a failed job is reported, for every environment. Empty disables the
# alerts rather than creating a channel to nowhere.
resource "google_monitoring_notification_channel" "alerts" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Homestead Mortgages alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

# ── The environments ─────────────────────────────────────────────────────────

module "stack" {
  for_each = var.stacks
  source   = "./modules/stack"

  environment       = each.key
  project_id        = var.project_id
  region            = var.region
  instance_name     = each.value.instance_name
  db_tier           = each.value.db_tier
  public_ip_enabled = var.public_ip_enabled

  service_account_email               = var.service_account_email
  servicing_run_service_account_email = google_service_account.servicing_run.email
  scheduler_service_account_email     = google_service_account.scheduler.email
  iap_service_agent_member            = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"

  image           = var.image
  servicing_image = var.servicing_image

  database_url_secret           = each.value.database_url_secret
  servicing_database_url_secret = each.value.servicing_database_url_secret
  servicing_api_token_secret    = each.value.servicing_api_token_secret
  refi_analyst                  = each.value.refi_analyst
  anthropic_api_key_secret      = var.anthropic_api_key_secret

  apor_fetch_schedule      = var.apor_fetch_schedule
  loan_review_schedule     = var.loan_review_schedule
  servicing_sweep_schedule = var.servicing_sweep_schedule

  notification_channel_id   = var.alert_email == "" ? null : google_monitoring_notification_channel.alerts[0].id
  servicing_console_members = var.servicing_console_members
}
