output "service_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "database_name" {
  value = google_sql_database.supermortgage.name
}
