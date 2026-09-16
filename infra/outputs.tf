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
