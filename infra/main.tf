# SuperMortgage infrastructure.
#
# The app runs in Walt's GCP project (walt-489214) but on its OWN Cloud SQL
# instance. That is a deliberate change from where this started.
#
# The first cut put SuperMortgage's database on the shared `walt-db` instance,
# alongside walt_prod and homestead_prod. Wiring it up produced the argument
# against: Cloud SQL users are INSTANCE-scoped, not database-scoped, so the
# `supermortgage_app` role could open a connection to walt_prod. It could read
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

resource "google_sql_database_instance" "supermortgage" {
  name             = "supermortgage-db"
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

resource "google_sql_database" "supermortgage" {
  name     = "supermortgage_${var.environment}"
  instance = google_sql_database_instance.supermortgage.name

  lifecycle {
    prevent_destroy = true
  }
}

# The application role. Its password is NOT in Terraform state — it is
# generated out of band and stored in Secret Manager, because a password in
# state is a password in whoever can read the state bucket.
resource "google_sql_user" "app" {
  name     = "supermortgage_app"
  instance = google_sql_database_instance.supermortgage.name
  password = var.db_password

  lifecycle {
    ignore_changes = [password]
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "supermortgage-${var.environment}"
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
        instances = [google_sql_database_instance.supermortgage.connection_name]
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

      # Fixture connectors are the ONLY implementation. Any other value makes
      # the API throw at boot rather than fall back, so a deploy that believes
      # it has real vendors fails visibly.
      env {
        name  = "CONNECTOR_MODE"
        value = var.connector_mode
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

# The prototype is not public. Access is granted explicitly rather than with
# allUsers, because the fixture flow still renders SSN-shaped fields and asks
# for real-looking consent — and a URL is not an access control.
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invoker_members)

  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = each.value
}
