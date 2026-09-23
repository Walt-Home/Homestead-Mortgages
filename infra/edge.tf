# ── The front door: two hostnames, one load balancer ────────────────────────
#
# supermortgage.com (and www) is the consumer app; servicing.supermortgage.com
# is Doug's runtime. One global external Application Load Balancer with a
# serverless network endpoint group per Cloud Run service, one Google-managed
# certificate per hostname (so a hostname whose DNS has not moved yet never
# holds the others back), and host rules that send each name to its service.
# HTTP redirects to HTTPS. On the servicing host the backend is the
# API container, which serves our ops console (apps/console) and forwards
# his console API to his runtime; nothing in his tree is edited here.
#
# The servicing backend sits behind Identity-Aware Proxy, so the branded
# hostname asks for a trywalt.ai Google sign-in before his console's own
# e-mail-code-and-password sign-in. IAP is turned on by `gcloud` rather than
# here: this provider can only describe IAP with an OAuth client it makes
# through the IAP OAuth Admin API, which Google shut down in March 2026, and
# the replacement — a Google-managed client, turned on with nothing but
# `--iap=enabled` — has no field in provider 5.x. The IAM side (who may pass
# IAP) is declared below; the on/off switch is one gcloud line, run once
# after the first apply and never touched by the deploy, which changes the
# services and not the backend in front of them:
#
#   gcloud iap web enable --resource-type=backend-services \
#     --service=homestead-mortgages-staging-console --project homestead-mortgages
#
# The IAP-side command, not `compute backend-services update --iap=enabled`:
# on the second backend that flag read "enabled" while nothing was enforced
# and his API answered the world; the IAP-side enable enforced within
# seconds. `ignore_changes` keeps Terraform from reading it as drift and
# turning it back off. Turned on 22 September 2026.
#
# IAP reaches Cloud Run as a Google-managed service agent that has to be
# provisioned once per project, and this project never had one: the first
# person through the Google sign-in was answered "The IAP service account is
# not provisioned". One more gcloud line, run once, on the same day:
#
#   gcloud beta services identity create --service=iap.googleapis.com \
#     --project homestead-mortgages
#
# That makes service-<project number>@gcp-sa-iap.iam.gserviceaccount.com,
# which does not appear in `gcloud iam service-accounts list`. Its right to
# invoke the servicing service is declared below.
#
# His run.app URL is closed by Cloud Run's own gate, not by IAP: since
# 22 September his service has no public invoker, `hm-run@` — the API's
# identity — is the one member with `roles/run.invoker`, and the API's two
# callers (the servicing adapter and the console proxy) carry a Google
# identity token for his URL on `X-Serverless-Authorization`, which Cloud
# Run checks and strips. A request to his run.app without one is a 403
# before his server sees it. The API's own run.app stays public: it is the
# borrower app, and a foreign Host on it is refused by Google's front end,
# so the console is reachable only through the front door and IAP.
#
# Retiring a backend: remove it from this file and run a plain apply, or
# `terraform state rm` it and delete it with gcloud. Never
# `terraform destroy -target` it — Terraform takes the target HTTPS proxy
# and the forwarding rule down with it as dependents, and every hostname
# is dark until they are recreated. That cost three minutes on
# 22 September 2026.
#
# The certificates provision only after DNS points each hostname at
# `edge_ip`; until then each sits at PROVISIONING / FAILED_NOT_VISIBLE and
# retries on its own. `dns_records` in outputs.tf is what to hand whoever
# holds the registrar login.

resource "google_compute_global_address" "edge" {
  name         = "homestead-mortgages-${var.environment}-edge"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "homestead-mortgages-${var.environment}-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  # The service by name, not by resource: the two services are deployed by
  # the workflow with gcloud and are not in this state, and a reference
  # would make a targeted apply try to create them.
  cloud_run {
    service = "homestead-mortgages-${var.environment}"
  }
}

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

# The servicing hostname's one backend: the API container, which on that
# Host serves the ops console and forwards his console API to his runtime
# (apps/api/src/console-host.ts). One backend because IAP keys its cookie
# per backend, and a console on one backend calling an API on another would
# sign in twice. His runtime's own endpoint group stays declared for the
# day a direct route is wanted; nothing routes to it today.
resource "google_compute_backend_service" "console" {
  name                  = "homestead-mortgages-${var.environment}-console"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  # No timeout_sec here, and not by oversight: Google refuses one on a backend
  # of serverless endpoint groups ("Timeout sec is not supported"), and the
  # front door defers to Cloud Run's own request timeout — 300 s on the API
  # (deploy.yml) — which is what a whole book through the tape desk gets.

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }

  # IAP is switched on by gcloud with Google's managed OAuth client (see the
  # header). Terraform must not read that as drift and switch it off.
  lifecycle {
    ignore_changes = [iap]
  }
}

# The project, for the IAP service agent's number.
data "google_project" "this" {
  project_id = var.project_id
}

# IAP's service agent invokes the servicing service on the signed-in
# person's behalf. The service is public, so this is belt and braces today;
# it is what keeps IAP working the day the service stops being public. By
# name, like the endpoint groups, because the service is not in this state.
# The API's identity may invoke his service, and nothing else may: the
# deploy removes `allUsers` from it and asserts that. Declared by name, like
# the endpoint groups, because the service is not in this state.
resource "google_cloud_run_v2_service_iam_member" "api_invokes_servicing" {
  project  = var.project_id
  location = var.region
  name     = "homestead-mortgages-${var.environment}-servicing"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_account_email}"
}

resource "google_cloud_run_v2_service_iam_member" "iap_invokes_api" {
  project  = var.project_id
  location = var.region
  name     = "homestead-mortgages-${var.environment}"
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# Who may pass IAP on the servicing hostname. IAM only — it grants nothing
# until IAP is on, and revoking a member here is what locks a person out.
resource "google_iap_web_backend_service_iam_member" "servicing_console" {
  for_each            = toset(var.servicing_console_members)
  web_backend_service = google_compute_backend_service.console.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}

locals {
  edge_hostnames = concat(var.consumer_hostnames, [var.servicing_hostname])
}

# One certificate per hostname: a Google-managed certificate provisions only
# when every name on it resolves to this address, so one certificate for all
# three would wait for the slowest DNS change.
resource "google_compute_managed_ssl_certificate" "edge" {
  for_each = toset(local.edge_hostnames)
  name     = "homestead-mortgages-${var.environment}-${replace(each.value, ".", "-")}"

  managed {
    domains = [each.value]
  }
}

resource "google_compute_url_map" "edge" {
  name            = "homestead-mortgages-${var.environment}-edge"
  default_service = google_compute_backend_service.api.id

  host_rule {
    hosts        = var.consumer_hostnames
    path_matcher = "consumer"
  }

  host_rule {
    hosts        = [var.servicing_hostname]
    path_matcher = "servicing"
  }

  path_matcher {
    name            = "consumer"
    default_service = google_compute_backend_service.api.id
  }

  # Everything on the servicing hostname goes to the console backend; the
  # API container decides by Host what to serve and sends `/` to `/console/`.
  path_matcher {
    name            = "servicing"
    default_service = google_compute_backend_service.console.id
  }
}

resource "google_compute_target_https_proxy" "edge" {
  name             = "homestead-mortgages-${var.environment}-edge"
  url_map          = google_compute_url_map.edge.id
  ssl_certificates = [for c in google_compute_managed_ssl_certificate.edge : c.id]
}

resource "google_compute_global_forwarding_rule" "edge_https" {
  name                  = "homestead-mortgages-${var.environment}-edge-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  ip_address            = google_compute_global_address.edge.id
  target                = google_compute_target_https_proxy.edge.id
}

# Port 80 exists to say "not here": every request is redirected to HTTPS.
resource "google_compute_url_map" "edge_http" {
  name = "homestead-mortgages-${var.environment}-edge-http"

  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "edge" {
  name    = "homestead-mortgages-${var.environment}-edge"
  url_map = google_compute_url_map.edge_http.id
}

resource "google_compute_global_forwarding_rule" "edge_http" {
  name                  = "homestead-mortgages-${var.environment}-edge-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  ip_address            = google_compute_global_address.edge.id
  target                = google_compute_target_http_proxy.edge.id
}
