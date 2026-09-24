# One environment: its database instance and databases, its jobs and their
# schedules, its alerts, the secret grants its two identities need, and its
# two backends on the shared front door. The Cloud Run services themselves
# are the deploy's (`gcloud run deploy` in .github/workflows/deploy.yml),
# which is why nothing here declares one: Terraform owns the shape around
# the service and never the service or its image.

# ── The database instance ────────────────────────────────────────────────────
#
# Its own per environment. Cloud SQL users are INSTANCE-scoped, not
# database-scoped: an environment sharing an instance with another could
# open the other's database with its own role, and "authenticated, reads
# nothing" is a posture that depends on grants staying correct forever. A
# separate instance makes the boundary structural, and it gives production
# its own point-in-time recovery, maintenance window and CPU.

resource "google_sql_database_instance" "this" {
  name             = var.instance_name
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    # On, because the first instance has it on: the provider knows the
    # attribute, GCP defaults it to true, and a config silent about it
    # planned to switch it off.
    enable_dataplex_integration = true

    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      # No authorized networks and no public reachability beyond the Cloud
      # SQL Admin API. Everything connects through the Auth Proxy (CI) or the
      # Cloud Run socket (runtime), both IAM-authenticated.
      ipv4_enabled = var.public_ip_enabled

      # Refuse a plaintext connection at the instance rather than relying on
      # nobody ever adding an authorized network.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "07:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
  }

  # This instance holds borrower files. A `terraform destroy` that took it
  # with it would be unrecoverable past the backup window.
  deletion_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

# The API's database. Its role, `homestead_mortgages_app`, is NOT a
# `google_sql_user`: its password would be in the state, and a password in
# state is a password in whoever can read the state file. It is made out of
# band with the environment's secrets (see docs/decisions.md, "Two
# environments, one configuration").
resource "google_sql_database" "api" {
  name     = "homestead_mortgages_${var.environment}"
  instance = google_sql_database_instance.this.name

  lifecycle {
    prevent_destroy = true
  }
}

# The servicing app's database. Owned by a plain role made in SQL — `LOGIN
# CREATEROLE` and nothing more — which Terraform cannot make, because a user
# created through the Cloud SQL API is a member of `cloudsqlsuperuser` and
# owns every database on the instance. See docs/decisions.md, "The servicing
# app deploys beside the API".
resource "google_sql_database" "servicing" {
  name     = "homestead_servicing_${var.environment}"
  instance = google_sql_database_instance.this.name

  lifecycle {
    prevent_destroy = true
  }
}

# ── The secrets each identity reads ──────────────────────────────────────────
#
# Granted on the secrets themselves, never project-wide. The servicing
# identity reads its database URL and the door token; the API's identity
# reads the door token too, because it presents it. Neither reads the
# other's database URL, so neither container can open the other's database
# by reading the other's secret. The API's own secrets — its database URL,
# session secret, vendor keys — are granted to hm-run@ out of band with the
# secrets, the way they were made.

resource "google_secret_manager_secret_iam_member" "servicing_run_reads_database_url" {
  secret_id = var.servicing_database_url_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.servicing_run_service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "servicing_run_reads_api_token" {
  secret_id = var.servicing_api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.servicing_run_service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "api_reads_servicing_api_token" {
  secret_id = var.servicing_api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"
}

# ── The jobs ─────────────────────────────────────────────────────────────────
#
# Each is the service's own image with a different entrypoint. The deploy
# updates the image on every deploy, as it deploys the service; Terraform
# owns the shape and not the tag.

# The average prime offer rate, fetched daily. General QM, HPML and HOEPA are
# decided against it for the week the loan's rate was set; a table nobody
# fetches was current the day somebody last typed it. The job exits non-zero
# when the series it leaves behind does not cover the current week, which
# makes a failed run the alarm.
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
          instances = [google_sql_database_instance.this.connection_name]
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

        # The live adapter. The service never fetches — it reads the table
        # this job writes — so this is the one place the provider is set to
        # anything but the fixture.
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

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# The daily refinance review: every watched loan, each morning, by the
# ported engine against its newest servicing observation and the rate the
# pricing port quotes — one loan_reviews row per loan per day, an offer made
# for each candidate. The deploy runs it once after the seed so a fresh
# deployment has a verdict before anyone looks; a second run in a day writes
# nothing.
resource "google_cloud_run_v2_job" "loan_review" {
  name     = "homestead-mortgages-${var.environment}-loan-review"
  location = var.region

  template {
    template {
      service_account = var.service_account_email
      max_retries     = 1
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.this.connection_name]
        }
      }

      containers {
        image   = var.image
        command = ["node"]
        args    = ["apps/api/dist/scripts/review-loans.js"]

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

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.database_url_secret
              version = "latest"
            }
          }
        }

        # The analyst's key, only when the analyst is on: a job that names a
        # secret with no version fails to start, so the secret is created and
        # granted first and the variable flipped after.
        dynamic "env" {
          for_each = var.refi_analyst == "on" ? { ANTHROPIC_API_KEY = var.anthropic_api_key_secret } : {}
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

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# The servicing app's sweep: one pass of every scheduled job its runtime
# has, as its image with a different argument. Its sweep lease makes a firing
# that overlaps another exit as skipped, so the schedule can be dense.
resource "google_cloud_run_v2_job" "servicing_sweep" {
  name     = "homestead-mortgages-${var.environment}-servicing-sweep"
  location = var.region

  template {
    template {
      service_account = var.servicing_run_service_account_email
      # The next firing is the retry.
      max_retries = 0
      timeout     = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.this.connection_name]
        }
      }

      containers {
        image = var.servicing_image
        args  = ["sweep"]

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

        # `production` would make the servicing app's config refuse to boot
        # on fakes, and every vendor in it is a FAKE; `nonprod` is also what
        # admits the shared token at its /v1 door.
        env {
          name  = "SERVICING_ENVIRONMENT"
          value = "nonprod"
        }

        env {
          name  = "SERVICING_INTEGRATIONS"
          value = "fake"
        }

        env {
          name  = "SERVICING_LOG_FORMAT"
          value = "json"
        }

        env {
          name = "SERVICING_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.servicing_database_url_secret
              version = "latest"
            }
          }
        }

        # The sweep never serves the door, but the config refuses to start
        # without a token in any mode.
        env {
          name = "SERVICING_API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = var.servicing_api_token_secret
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

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# ── Their schedules ──────────────────────────────────────────────────────────

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_apor_fetch" {
  project  = google_cloud_run_v2_job.apor_fetch.project
  location = google_cloud_run_v2_job.apor_fetch.location
  name     = google_cloud_run_v2_job.apor_fetch.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scheduler_service_account_email}"
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
      service_account_email = var.scheduler_service_account_email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_apor_fetch]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_loan_review" {
  project  = google_cloud_run_v2_job.loan_review.project
  location = google_cloud_run_v2_job.loan_review.location
  name     = google_cloud_run_v2_job.loan_review.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scheduler_service_account_email}"
}

resource "google_cloud_scheduler_job" "loan_review" {
  name        = "homestead-mortgages-${var.environment}-loan-review"
  description = "Review every watched loan against today's sheet."
  schedule    = var.loan_review_schedule
  time_zone   = "America/New_York"
  region      = var.region

  retry_config {
    retry_count = 2
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.loan_review.name}:run"

    oauth_token {
      service_account_email = var.scheduler_service_account_email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_loan_review]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_servicing_sweep" {
  project  = google_cloud_run_v2_job.servicing_sweep.project
  location = google_cloud_run_v2_job.servicing_sweep.location
  name     = google_cloud_run_v2_job.servicing_sweep.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scheduler_service_account_email}"
}

resource "google_cloud_scheduler_job" "servicing_sweep" {
  name        = "homestead-mortgages-${var.environment}-servicing-sweep"
  description = "One pass of every scheduled job in the servicing runtime."
  schedule    = var.servicing_sweep_schedule
  time_zone   = "America/New_York"
  region      = var.region
  # Scheduler answers the moment the job STARTS; the deadline only bounds
  # that call.
  attempt_deadline = "180s"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.servicing_sweep.name}:run"

    oauth_token {
      service_account_email = var.scheduler_service_account_email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_servicing_sweep]
}

# ── The alarms ───────────────────────────────────────────────────────────────
#
# A failed execution is the alarm, and an alarm nobody hears is a log line.
# Scheduler's own retry_config retries the HTTP call that STARTS the job, not
# the job; the :run endpoint answers 200 before the container has done
# anything. So the failure a script exits with is only visible here.

resource "google_monitoring_alert_policy" "apor_fetch_failed" {
  count        = var.notification_channel_id == null ? 0 : 1
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

  notification_channels = [var.notification_channel_id]

  documentation {
    content = "The scheduled fetch of the CFPB's average prime offer rate table failed. Until it succeeds, every decision computed in a week the stored series does not reach blocks UW-008 and ends referred. Read the job's logs; if the CFPB has published and the fetch still fails, the file has changed shape."
  }
}

resource "google_monitoring_alert_policy" "servicing_sweep_failed" {
  count        = var.notification_channel_id == null ? 0 : 1
  display_name = "Servicing sweep failed (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "a scheduled sweep of the servicing runtime exited non-zero"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${google_cloud_run_v2_job.servicing_sweep.name}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [var.notification_channel_id]

  documentation {
    content = "A scheduled sweep of the servicing runtime (apps/servicing) failed. A firing that found the lease held exits 0 as skipped, so this is a pass that threw: read the job's logs for the sweep_runs row it left as failed. Until a sweep completes, no timer breaches, no offer goes out, and the partner-book reviews our API reads through the servicing port stop moving."
  }
}

# ── This environment's backends on the shared front door ─────────────────────
#
# Two serverless endpoint groups, one per Cloud Run service, by NAME: the
# services are the deploy's and a group may be made before its service is.
# Two backends: the consumer app, and the servicing hostname's — which is
# the API container again, serving the ops console on that Host and
# forwarding the console's calls to the servicing app, behind IAP. One
# backend for the servicing hostname because IAP keys its cookie per
# backend.

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "homestead-mortgages-${var.environment}-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = "homestead-mortgages-${var.environment}"
  }
}

# The servicing app's own group. Nothing routes to it since the console
# backend took its hostname; it stays because a group the servicing app
# might one day need is cheaper to keep than to remember.
resource "google_compute_region_network_endpoint_group" "servicing" {
  name                  = "homestead-mortgages-${var.environment}-servicing"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = "homestead-mortgages-${var.environment}-servicing"
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "homestead-mortgages-${var.environment}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_backend_service" "console" {
  name                  = "homestead-mortgages-${var.environment}-console"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  # No timeout_sec, and not by oversight: Google refuses one on a backend of
  # serverless endpoint groups, and the front door defers to Cloud Run's own
  # request timeout — 300 s on the API — which is what a whole book through
  # the tape desk gets.

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }

  # IAP is switched on by hand with Google's managed OAuth client:
  #   gcloud iap web enable --resource-type=backend-services --service=<this backend>
  # (the IAP OAuth Admin API is shut down, so the provider cannot express
  # it). Terraform must not read that as drift and switch it off.
  lifecycle {
    ignore_changes = [iap]
  }
}

# Who may pass IAP on this environment's servicing hostname. IAM only — it
# grants nothing inside the console, whose staff are its own list.
resource "google_iap_web_backend_service_iam_member" "servicing_console" {
  for_each            = toset(var.servicing_console_members)
  web_backend_service = google_compute_backend_service.console.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}

# The API's identity is the one invoker of the servicing service: its
# run.app has no public invoker, and the adapter and the console proxy carry
# a Google identity token for it.
resource "google_cloud_run_v2_service_iam_member" "api_invokes_servicing" {
  project  = var.project_id
  location = var.region
  name     = "homestead-mortgages-${var.environment}-servicing"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_account_email}"
}

# IAP fronts Cloud Run through a Google-managed agent that must be able to
# invoke the API service behind the servicing hostname.
resource "google_cloud_run_v2_service_iam_member" "iap_invokes_api" {
  project  = var.project_id
  location = var.region
  name     = "homestead-mortgages-${var.environment}"
  role     = "roles/run.invoker"
  member   = var.iap_service_agent_member
}
