output "service_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "instance_connection_name" {
  value = google_sql_database_instance.homestead-mortgages.connection_name
}

output "database_name" {
  value = google_sql_database.homestead-mortgages.name
}

output "apor_fetch_job" {
  value = google_cloud_run_v2_job.apor_fetch.name
}

output "servicing_service_url" {
  value = google_cloud_run_v2_service.servicing.uri
}

output "servicing_database_name" {
  value = google_sql_database.servicing.name
}

output "servicing_service_account" {
  value = google_service_account.servicing_run.email
}

output "servicing_sweep_job" {
  value = google_cloud_run_v2_job.servicing_sweep.name
}

output "loan_review_job" {
  value = google_cloud_run_v2_job.loan_review.name
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
