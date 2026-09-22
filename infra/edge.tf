# ── The front door: two hostnames, one load balancer ────────────────────────
#
# supermortgage.com (and www) is the consumer app; servicing.supermortgage.com
# is Doug's runtime. One global external Application Load Balancer with a
# serverless network endpoint group per Cloud Run service, one Google-managed
# certificate per hostname (so a hostname whose DNS has not moved yet never
# holds the others back), and host rules that send each name to its service.
# HTTP redirects to HTTPS. On the servicing host, `/` redirects to `/ops`,
# his console, because his runtime answers `/` with a JSON 404 and nothing
# in his tree is edited here.
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
#   gcloud compute backend-services update homestead-mortgages-staging-servicing \
#     --global --project homestead-mortgages --iap=enabled
#
# `ignore_changes` keeps Terraform from reading that as drift and turning it
# back off. Turned on 22 September 2026.
#
# What this does NOT close: the run.app URLs. Both services keep ingress
# `all`, because the API reaches his door and the deploy probes both over
# those URLs without VPC egress; a person who knows the servicing run.app
# hostname reaches `/ops` without IAP. Closing that means internal-and-LB
# ingress plus Direct VPC egress on the API and the sweep, or an adapter that
# passes IAP with `Proxy-Authorization`. Named here so nobody thinks IAP did it.
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

resource "google_compute_backend_service" "servicing" {
  name                  = "homestead-mortgages-${var.environment}-servicing"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.servicing.id
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

# Who may pass IAP on the servicing hostname. IAM only — it grants nothing
# until IAP is on, and revoking a member here is what locks a person out.
resource "google_iap_web_backend_service_iam_member" "servicing_console" {
  for_each            = toset(var.servicing_console_members)
  web_backend_service = google_compute_backend_service.servicing.name
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

  path_matcher {
    name            = "servicing"
    default_service = google_compute_backend_service.servicing.id

    # His runtime answers `/` with a JSON 404; the console is `/ops`.
    path_rule {
      paths = ["/"]
      url_redirect {
        path_redirect          = "/ops"
        https_redirect         = true
        strip_query            = false
        redirect_response_code = "FOUND"
      }
    }
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
