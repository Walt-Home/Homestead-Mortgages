output "stacks" {
  description = "Each environment's instance, databases, jobs and backends."
  value = {
    for k, m in module.stack : k => {
      instance_connection_name = m.instance_connection_name
      instance_name            = m.instance_name
      api_database             = m.api_database_name
      servicing_database       = m.servicing_database_name
      apor_fetch_job           = m.apor_fetch_job
      loan_review_job          = m.loan_review_job
      servicing_sweep_job      = m.servicing_sweep_job
      console_backend          = m.console_backend_name
      consumer_hostnames       = var.stacks[k].consumer_hostnames
      servicing_hostnames      = var.stacks[k].servicing_hostnames
    }
  }
}

output "edge_ip" {
  description = "The load balancer's address; every hostname's A record points here."
  value       = google_compute_global_address.edge.address
}

output "dns_records" {
  description = "What to set at the registrar, one A record per hostname."
  value       = [for h in local.edge_hostnames : "${h}  A  ${google_compute_global_address.edge.address}"]
}

output "certificates" {
  description = "Each hostname's Google-managed certificate; PROVISIONING until its DNS points at edge_ip."
  value       = { for h, c in google_compute_managed_ssl_certificate.edge : h => c.name }
}
