# ── The front door: every hostname, one load balancer ────────────────────────
#
# One global external Application Load Balancer for every environment: one
# address, a Google-managed certificate per hostname (so a hostname whose
# DNS has not moved yet never holds the others back), and host rules that
# send each hostname to its environment's backends — the consumer names to
# the environment's API backend, the servicing names to its console backend
# (the API container serving the ops console on that Host, behind IAP).
# HTTP redirects to HTTPS.
#
# Which hostnames belong to which environment is `var.stacks`, and moving a
# hostname between environments is moving a string there: the certificate is
# the hostname's, not the environment's, so the roots can pass from the
# staging stack to the production stack without a certificate being
# recreated. Today (24 September 2026) every hostname is staging's; the
# roots become production's the day that stack is stood up and cut over.
#
# The names below say "staging" because that is what they were called when
# staging was the only environment; the address, the proxies and the
# forwarding rules are shared, and renaming a global address is a new IP.
#
# Applied by hand, with -target, and the one lesson worth repeating:
# `terraform destroy -target` of a backend takes the HTTPS proxy and the
# forwarding rule down as dependents (three minutes of every hostname dark,
# 22 September). Retire a backend by removing it from config and applying,
# never by destroying it by target.
#
# IAP on a console backend is enabled by hand —
#   gcloud iap web enable --resource-type=backend-services --service=<backend>
# — and the module's lifecycle ignores it. The IAP service agent
# (service-<project number>@gcp-sa-iap) is created once per project with
# `gcloud beta services identity create --service=iap.googleapis.com`.

resource "google_compute_global_address" "edge" {
  name         = "homestead-mortgages-staging-edge"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

locals {
  edge_hostnames = distinct(flatten([
    for k, s in var.stacks : concat(s.consumer_hostnames, s.servicing_hostnames)
  ]))
}

# One certificate per hostname: a Google-managed certificate provisions only
# when every name on it resolves to this address, so one certificate for all
# would wait for the slowest DNS change. It provisions after DNS points the
# hostname at `edge_ip`, and is ACTIVE a few minutes after that.
resource "google_compute_managed_ssl_certificate" "edge" {
  for_each = toset(local.edge_hostnames)
  name     = "homestead-mortgages-staging-${replace(each.value, ".", "-")}"

  managed {
    domains = [each.value]
  }
}

resource "google_compute_url_map" "edge" {
  name            = "homestead-mortgages-staging-edge"
  default_service = module.stack[var.default_stack].api_backend_id

  dynamic "host_rule" {
    for_each = { for k, s in var.stacks : k => s.consumer_hostnames if length(s.consumer_hostnames) > 0 }
    content {
      hosts        = host_rule.value
      path_matcher = "${host_rule.key}-consumer"
    }
  }

  dynamic "host_rule" {
    for_each = { for k, s in var.stacks : k => s.servicing_hostnames if length(s.servicing_hostnames) > 0 }
    content {
      hosts        = host_rule.value
      path_matcher = "${host_rule.key}-servicing"
    }
  }

  dynamic "path_matcher" {
    for_each = { for k, s in var.stacks : k => s if length(s.consumer_hostnames) > 0 }
    content {
      name            = "${path_matcher.key}-consumer"
      default_service = module.stack[path_matcher.key].api_backend_id
    }
  }

  # Everything on a servicing hostname goes to that environment's console
  # backend; the API container decides by Host what to serve and sends `/`
  # to `/console/`.
  dynamic "path_matcher" {
    for_each = { for k, s in var.stacks : k => s if length(s.servicing_hostnames) > 0 }
    content {
      name            = "${path_matcher.key}-servicing"
      default_service = module.stack[path_matcher.key].console_backend_id
    }
  }
}

resource "google_compute_target_https_proxy" "edge" {
  name             = "homestead-mortgages-staging-edge"
  url_map          = google_compute_url_map.edge.id
  ssl_certificates = [for c in google_compute_managed_ssl_certificate.edge : c.id]
}

resource "google_compute_global_forwarding_rule" "edge_https" {
  name                  = "homestead-mortgages-staging-edge-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  ip_address            = google_compute_global_address.edge.id
  target                = google_compute_target_https_proxy.edge.id
}

# Port 80 exists to say "not here": every request is redirected to HTTPS.
resource "google_compute_url_map" "edge_http" {
  name = "homestead-mortgages-staging-edge-http"

  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "edge" {
  name    = "homestead-mortgages-staging-edge"
  url_map = google_compute_url_map.edge_http.id
}

resource "google_compute_global_forwarding_rule" "edge_http" {
  name                  = "homestead-mortgages-staging-edge-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  ip_address            = google_compute_global_address.edge.id
  target                = google_compute_target_http_proxy.edge.id
}
