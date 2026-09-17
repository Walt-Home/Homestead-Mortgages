# Homestead Mortgages infrastructure.
#
# The app runs in Walt's GCP project (homestead-mortgages) but on its OWN Cloud SQL
# instance. That is a deliberate change from where this started.
#
# The first cut put Homestead Mortgages's database on the shared `homestead-mortgages-db` instance,
# alongside walt_prod and homestead_prod. Wiring it up produced the argument
# against: Cloud SQL users are INSTANCE-scoped, not database-scoped, so the
# `homestead_mortgages_app` role could open a connection to walt_prod. It could read
# nothing — 0 of 98 tables — but "authenticated, reads nothing" is a posture
# that depends on table grants staying correct forever, and this product will
# eventually hold SSNs, credit reports and twelve months of bank transactions.
#
# A separate instance makes the boundary structural instead of maintained.
# It also decouples the things that are instance-scoped and matter here:
# point-in-time recovery, maintenance windows, and CPU contention with a live
# consumer app.
#
# Terraform does NOT manage the shared Artifact Registry repository or the WIF
# pool. Those pre-date this repo and belong to Walt; importing them would let a
# `terraform destroy` here take down two live applications.

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

resource "google_sql_database_instance" "homestead-mortgages" {
  name             = "homestead-mortgages-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    # On, because the instance has it on. Surfaced by importing the instance
    # into a fresh state: the provider knows the attribute, GCP defaults it to
    # true, and a config silent about it planned to switch it off.
    enable_dataplex_integration = true

    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      # No authorized networks and no public reachability beyond the Cloud SQL
      # Admin API. Everything connects through the Auth Proxy (CI) or the
      # Cloud Run socket (runtime), both of which authenticate with IAM rather
      # than an IP allowlist.
      ipv4_enabled = var.public_ip_enabled
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "07:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
  }

  # This instance holds borrower files. A `terraform destroy` that took it with
  # it would be unrecoverable past the backup window.
  deletion_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "homestead-mortgages" {
  name     = "homestead-mortgages_${var.environment}"
  instance = google_sql_database_instance.homestead-mortgages.name

  lifecycle {
    prevent_destroy = true
  }
}

# The application role. Its password is NOT in Terraform state — it is
# generated out of band and stored in Secret Manager, because a password in
# state is a password in whoever can read the state bucket.
resource "google_sql_user" "app" {
  name     = "homestead_mortgages_app"
  instance = google_sql_database_instance.homestead-mortgages.name
  password = var.db_password

  lifecycle {
    ignore_changes = [password]
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "homestead-mortgages-${var.environment}"
  location = var.region

  template {
    service_account = var.service_account_email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.homestead-mortgages.connection_name]
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # A hop count, not `true`. See apps/api/src/config.ts — the consent
      # records this product writes are only evidence because the client cannot
      # forge the IP on them.
      env {
        name  = "TRUST_PROXY"
        value = "1"
      }

      # Superseded by the per-connector variables below, and kept because it
      # is still what /health reports. Vendors arrive one at a time and over
      # months, so an all-or-nothing switch would make the whole registry wait
      # for the slowest member; `providerMix()` in the boot log is the truth.
      env {
        name  = "CONNECTOR_MODE"
        value = var.connector_mode
      }

      # ── Plaid ──────────────────────────────────────────────────────────────
      #
      # Note what is NOT here: PLAID_REDIRECT_URI. Plaid rejects
      # /link/token/create with INVALID_FIELD when the redirect URI is not on
      # the dashboard allowlist, and it rejects it for EVERY link token rather
      # than only the OAuth ones — so a plausible-looking value set here takes
      # screen 3 down entirely until somebody registers it. Add it only once
      # "${var.public_origin}/plaid/return" is registered under
      # Developers > API > Allowed Redirect URIs.

      env {
        name  = "BANK_PROVIDER"
        value = "plaid"
      }

      env {
        name  = "PLAID_ENV"
        value = "sandbox"
      }

      env {
        name  = "PLAID_PRODUCT"
        value = var.plaid_product
      }

      env {
        name  = "PLAID_CLIENT_ID"
        value = var.plaid_client_id
      }

      env {
        name = "PLAID_SECRET"
        value_source {
          secret_key_ref {
            secret  = var.plaid_secret_secret
            version = "latest"
          }
        }
      }

      env {
        name = "VENDOR_TOKEN_KEY"
        value_source {
          secret_key_ref {
            secret  = var.vendor_token_key_secret
            version = "latest"
          }
        }
      }

      env {
        name  = "PUBLIC_ORIGIN"
        value = var.public_origin
      }

      env {
        name  = "PLAID_REDIRECT_URI"
        value = var.plaid_redirect_uri
      }

      # ── Stripe Identity ────────────────────────────────────────────────────
      #
      # STRIPE_ALLOW_LIVE_IDENTITY is absent on purpose. See
      # stripe_secret_key_secret in variables.tf: the adapter refuses a live
      # key without it, so the omission is enforced rather than trusted.

      env {
        name  = "IDENTITY_PROVIDER"
        value = "stripe"
      }

      env {
        name = "STRIPE_SECRET_KEY_SANDBOX"
        value_source {
          secret_key_ref {
            secret  = var.stripe_secret_key_secret
            version = "latest"
          }
        }
      }

      # ── Google Places, over CoreLogic ──────────────────────────────────────
      #
      # Places answers autocomplete. Beneath it CoreLogic answers the county
      # record and the AVM. The flood determination stays on the fixture — it
      # is a separate product, and on a federally related mortgage it has to
      # be a certified one rather than a map read.

      env {
        name  = "PROPERTY_DATA_PROVIDER"
        value = "google_places"
      }

      env {
        name  = "PROPERTY_RECORDS_PROVIDER"
        value = var.property_records_provider
      }

      # The two CoreLogic secrets are referenced only when the provider is on.
      # A revision that references a secret that does not exist yet fails to
      # start, so a deployment that has not created them keeps booting on the
      # fixture until somebody flips the variable.
      dynamic "env" {
        for_each = var.property_records_provider == "corelogic" ? {
          CORELOGIC_CLIENT_KEY    = var.corelogic_client_key_secret
          CORELOGIC_CLIENT_SECRET = var.corelogic_client_secret_secret
        } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      env {
        name = "GOOGLE_PLACES_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.google_places_api_key_secret
            version = "latest"
          }
        }
      }

      env {
        name  = "CORS_ORIGIN"
        value = var.cors_origin
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_url_secret
            version = "latest"
          }
        }
      }

      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = var.session_secret_secret
            version = "latest"
          }
        }
      }

      # Public by design; see variables.tf. The server refuses to boot in
      # production if this is empty, rather than serving a door that never opens.
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }

      env {
        name  = "ALLOWED_DOMAIN"
        value = var.allowed_domain
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Publicly routable, gated by Google sign-in in the application.
#
# Cloud Run's IAM auth needs an OIDC token on every request, which a browser
# does not send — so an IAM-protected URL cannot be handed to a colleague as a
# link. Authentication happens in the app instead, where it can also express
# "this file is yours and that one is not".
resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.public ? 1 : 0

  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = var.public ? toset([]) : toset(var.invoker_members)

  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = each.value
}

# ── The average prime offer rate is fetched, on a schedule ───────────────────
#
# General QM, HPML and HOEPA are all decided against the average prime offer
# rate for the week the loan's rate was set. It is a weekly publication, so a
# table nobody fetches is a table that was current on the day somebody last
# typed it, and that is what this replaces. The job is the same image as the
# service with a different entrypoint: `scripts/fetch-apor.ts` fetches the
# CFPB's survey, computes the week's rates by their published method, and
# appends them to `apor_weeks`. It exits non-zero when the series it leaves
# behind does not cover the current week, which makes a failed run the alarm.
#
# The deploy workflow runs the same script once per deploy, against the same
# database, so a deployment is never waiting on the first scheduled run.

resource "google_service_account" "scheduler" {
  account_id   = "hm-scheduler"
  display_name = "Cloud Scheduler for Homestead Mortgages jobs"
  description  = "Invokes Cloud Run jobs on a schedule. Holds run.invoker on those jobs and nothing else."
}

resource "google_cloud_run_v2_job" "apor_fetch" {
  name     = "homestead-mortgages-${var.environment}-apor-fetch"
  location = var.region

  template {
    template {
      service_account = var.service_account_email
      max_retries     = 1
      timeout         = "300s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.homestead-mortgages.connection_name]
        }
      }

      containers {
        image   = var.image
        command = ["node"]
        args    = ["apps/api/dist/scripts/fetch-apor.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        # The live adapter. The service itself never fetches — it reads the
        # table this job writes — so this is the one place the provider is set
        # to anything but the fixture.
        env {
          name  = "APOR_PROVIDER"
          value = "ffiec"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.database_url_secret
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # The deploy workflow updates the image on every deploy, the same way it
  # deploys the service; Terraform owns the shape and not the tag.
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_apor_fetch" {
  project  = google_cloud_run_v2_job.apor_fetch.project
  location = google_cloud_run_v2_job.apor_fetch.location
  name     = google_cloud_run_v2_job.apor_fetch.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "apor_fetch" {
  name        = "homestead-mortgages-${var.environment}-apor-fetch"
  description = "Fetch the CFPB survey and append this week's average prime offer rates."
  schedule    = var.apor_fetch_schedule
  time_zone   = "Etc/UTC"
  region      = var.region

  retry_config {
    retry_count = 2
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.apor_fetch.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_apor_fetch]
}

# A failed execution is the alarm, and an alarm nobody hears is a log line.
# Scheduler's own retry_config retries the HTTP call that STARTS the job, not
# the job; the :run endpoint answers 200 before the container has done
# anything. So the failure the fetch script exits with is only visible here.
resource "google_monitoring_notification_channel" "alerts" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Homestead Mortgages alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "apor_fetch_failed" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "APOR fetch failed (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "a scheduled fetch of the average prime offer rate exited non-zero"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${google_cloud_run_v2_job.apor_fetch.name}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.alerts[0].id]

  documentation {
    content = "The scheduled fetch of the CFPB's average prime offer rate table failed. Until it succeeds, every decision computed in a week the stored series does not reach blocks UW-008 and ends referred. Read the job's logs; if the CFPB has published and the fetch still fails, the file has changed shape."
  }
}
