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
