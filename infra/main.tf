# SuperMortgage infrastructure.
#
# The app runs inside Walt's existing GCP project (walt-489214) and on the
# existing `walt-db` Cloud SQL instance, but in its OWN database and its OWN
# Cloud Run service. That is a deliberately narrower kind of sharing than
# Homestead has: Homestead shares Walt's database and inherited a long list of
# cross-service hazards for it (see that repo's CLAUDE.md). SuperMortgage owns
# every object in `supermortgage_staging`, so `prisma migrate` here cannot
# reach anything Walt or Homestead owns.
#
# What Terraform does NOT manage: the walt-db instance itself, the shared
# Artifact Registry repository, and the WIF pool. Those pre-date this repo and
# belong to Walt. Importing them here would let a `terraform destroy` in this
# directory take down two live applications.

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

# The application database on the shared instance. `prevent_destroy` because a
# `terraform destroy` that took this with it would delete borrower files, and
# the instance it lives on also holds two production databases.
resource "google_sql_database" "supermortgage" {
  name     = "supermortgage_${var.environment}"
  instance = var.sql_instance_name

  lifecycle {
    prevent_destroy = true
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
        instances = ["${var.project_id}:${var.region}:${var.sql_instance_name}"]
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
      # records this product writes are only evidence because the client
      # cannot forge the IP on them.
      env {
        name  = "TRUST_PROXY"
        value = "1"
      }

      # Fixture connectors are the ONLY implementation. Setting this to
      # anything else makes the API throw at boot rather than fall back, so a
      # deploy that thinks it has real vendors fails visibly.
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
