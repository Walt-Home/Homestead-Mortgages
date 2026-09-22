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

      # Refuse a plaintext connection at the instance rather than relying on
      # nobody ever adding an authorized network. The Auth Proxy and the Cloud
      # Run socket carry their own TLS and are unaffected; the only connection
      # this turns away is one that could not happen today anyway. It exists so
      # "does the database enforce encryption in transit" is answered by the
      # instance and not by a description of the network.
      ssl_mode = "ENCRYPTED_ONLY"
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

      # ── The servicing platform ─────────────────────────────────────────────
      #
      # Doug's runtime, deployed below as a service of its own. The API reads
      # a loan's servicing record through the `servicing` connector port over
      # his /v1 door with the token both services mount; "fixture" would make
      # the port answer what his engine answered for the sample book instead.
      # The seam is HTTP and nothing else — see docs/decisions.md, "The
      # servicing platform is read, never joined".

      env {
        name  = "SERVICING_PROVIDER"
        value = "supermortgage"
      }

      env {
        name  = "SERVICING_API_URL"
        value = google_cloud_run_v2_service.servicing.uri
      }

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

# ── The daily refinance review ───────────────────────────────────────────────
#
# Every monitored loan, reviewed each morning by the ported engine
# (packages/refi-review — Doug's 33.2 over his 20.1) against its newest
# servicing observation and the rate the pricing port quotes: one
# loan_reviews row per loan per day. The same image as the service with a
# different entrypoint, the way the APOR fetch is; the deploy runs it once
# after the seed so a fresh deployment has a verdict before anyone looks,
# and a second run in a day writes nothing.
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
          instances = [google_sql_database_instance.homestead-mortgages.connection_name]
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

        # The rate comes off the pricing port, which is the fixture's sheet
        # until a vendor's engine is wired into the registry; every review
        # row names the source it read, so nothing has to be told here.
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

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_loan_review" {
  project  = google_cloud_run_v2_job.loan_review.project
  location = google_cloud_run_v2_job.loan_review.location
  name     = google_cloud_run_v2_job.loan_review.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "loan_review" {
  name        = "homestead-mortgages-${var.environment}-loan-review"
  description = "Review every monitored loan against today's sheet."
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
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_loan_review]
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

# ── Doug's servicing runtime, as a service of its own ────────────────────────
#
# apps/servicing is Doug's platform, vendored whole (docs/decisions.md, "Doug's
# servicing runtime is an app in this repo"). It deploys beside the API the
# shape his own infra gives it: one image with three modes — `serve` as a
# second Cloud Run service, `migrate` run by the deploy before it, `sweep` as
# a Cloud Run job on a schedule — on a database of its own on the shared
# instance, under a runtime identity of its own. Every vendor in it is a
# FAKE, and his config refuses to start a production process on fakes, so
# ENVIRONMENT is `nonprod` here by construction and not by choice.
#
# What keeps the two apps apart is the same argument the instance section
# makes, applied to the two halves of one instance:
#
# - The runtime identity reads exactly two secrets, its database URL and the
#   door token, granted on the secrets themselves. hm-run@ is not granted his
#   database URL and he is not granted ours, so neither container can open
#   the other's database by reading the other's secret.
# - The database role in his URL is NOT a `google_sql_user`. A user created
#   through the Cloud SQL API is a member of `cloudsqlsuperuser`, which owns
#   every database on the instance, so two API-created users can always open
#   each other's databases whatever is revoked. His role is created in SQL,
#   `LOGIN CREATEROLE` and nothing more, owns `homestead_servicing_<env>` and
#   nothing else, and `CONNECT` on our database is revoked from PUBLIC so a
#   plain role cannot reach it. The two extensions his migrations create are
#   created once by hand, because `CREATE EXTENSION` on Cloud SQL needs the
#   superuser-like role and `IF NOT EXISTS` passes an existing one without
#   asking. The asymmetry is real and recorded: our app role is API-created,
#   so it can still open the servicing database; his cannot open ours.
#
# The service is publicly routable for the reason the API is: our API
# presents his bearer in the Authorization header, and Cloud Run's own IAM
# door wants an identity token in the same header, so the two cannot stack.
# His door — /healthz and /readyz open, everything else behind the token or
# a staff session — is the gate.

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

resource "google_secret_manager_secret_iam_member" "servicing_run_reads_database_url" {
  secret_id = var.servicing_database_url_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.servicing_run.email}"
}

resource "google_secret_manager_secret_iam_member" "servicing_run_reads_api_token" {
  secret_id = var.servicing_api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.servicing_run.email}"
}

# The API presents the same token, so it reads the same secret.
resource "google_secret_manager_secret_iam_member" "api_reads_servicing_api_token" {
  secret_id = var.servicing_api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"
}

# Owned by the plain role described above, which SQL sets after this creates
# it; Terraform can describe the database but not a role outside
# cloudsqlsuperuser.
resource "google_sql_database" "servicing" {
  name     = "homestead_servicing_${var.environment}"
  instance = google_sql_database_instance.homestead-mortgages.name

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_cloud_run_v2_service" "servicing" {
  name     = "homestead-mortgages-${var.environment}-servicing"
  location = var.region

  template {
    service_account = google_service_account.servicing_run.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.homestead-mortgages.connection_name]
      }
    }

    containers {
      image = var.servicing_image

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

      # scripts/run.mjs reads SERVICING_PORT and defaults to 8090; Cloud Run
      # listens on the container port, so the two are pinned together here.
      env {
        name  = "SERVICING_PORT"
        value = "8080"
      }

      # `production` would make his config refuse to boot on fakes, and every
      # vendor here is a FAKE; `nonprod` is also what admits the shared token
      # at his /v1 door.
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

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  # The deploy workflow ships the image, as it does the API's.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "servicing_public" {
  count = var.public ? 1 : 0

  project  = google_cloud_run_v2_service.servicing.project
  location = google_cloud_run_v2_service.servicing.location
  name     = google_cloud_run_v2_service.servicing.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The sweep: one pass of every scheduled job his runtime has — the outbox,
# the cycles, the daily refinance check, the partner-book review that writes
# the verdicts our `servicing` port reads, the timers' breach pass, and the
# receipt — as the same image with a different argument, the way the APOR
# fetch is the API's image with a different entrypoint. The sweep lease
# (his advisory lock 35_001) makes a firing that overlaps another exit as
# `skipped`, so the schedule can be as dense as anyone likes.
resource "google_cloud_run_v2_job" "servicing_sweep" {
  name     = "homestead-mortgages-${var.environment}-servicing-sweep"
  location = var.region

  template {
    template {
      service_account = google_service_account.servicing_run.email
      # The next firing is the retry.
      max_retries = 0
      timeout     = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.homestead-mortgages.connection_name]
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

        # The sweep mode never serves the door, but his config refuses to
        # start without a token in any mode.
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

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_servicing_sweep" {
  project  = google_cloud_run_v2_job.servicing_sweep.project
  location = google_cloud_run_v2_job.servicing_sweep.location
  name     = google_cloud_run_v2_job.servicing_sweep.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
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
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_servicing_sweep]
}

# As with the APOR fetch: a sweep that exits non-zero is visible only here.
resource "google_monitoring_alert_policy" "servicing_sweep_failed" {
  count        = var.alert_email == "" ? 0 : 1
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

  notification_channels = [google_monitoring_notification_channel.alerts[0].id]

  documentation {
    content = "A scheduled sweep of the servicing runtime (apps/servicing) failed. A firing that found the lease held exits 0 as skipped, so this is a pass that threw: read the job's logs for the sweep_runs row it left as failed. Until a sweep completes, no timer breaches, no offer goes out, and the partner-book reviews our API reads through the servicing port stop moving."
  }
}
