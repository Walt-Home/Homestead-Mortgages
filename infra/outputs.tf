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
