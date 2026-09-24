output "instance_connection_name" {
  value = google_sql_database_instance.this.connection_name
}

output "instance_name" {
  value = google_sql_database_instance.this.name
}

output "api_database_name" {
  value = google_sql_database.api.name
}

output "servicing_database_name" {
  value = google_sql_database.servicing.name
}

output "apor_fetch_job" {
  value = google_cloud_run_v2_job.apor_fetch.name
}

output "loan_review_job" {
  value = google_cloud_run_v2_job.loan_review.name
}

output "servicing_sweep_job" {
  value = google_cloud_run_v2_job.servicing_sweep.name
}

output "api_backend_id" {
  description = "The load balancer backend for this environment's consumer app."
  value       = google_compute_backend_service.api.id
}

output "console_backend_id" {
  description = "The load balancer backend for this environment's servicing hostname (the API container serving the console)."
  value       = google_compute_backend_service.console.id
}

output "console_backend_name" {
  value = google_compute_backend_service.console.name
}
