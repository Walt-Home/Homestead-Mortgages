variable "project_id" {
  description = "The GCP project. Homestead Mortgages's own."
  type        = string
  default     = "homestead-mortgages"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "public_ip_enabled" {
  description = <<-EOT
    Whether each instance has a public IPv4 address. True is safe here BECAUSE
    there are no authorized networks: reachability still requires the Cloud SQL
    Auth Proxy or the Cloud Run socket, both IAM-authenticated. Set false only
    once private services access is configured on the VPC.
  EOT
  type        = bool
  default     = true
}

variable "service_account_email" {
  description = <<-EOT
    Runtime identity for the API's Cloud Run service and jobs, in every
    environment. Holds cloudsql.client and secretAccessor on exactly the
    secrets it needs, granted on the secrets rather than the project — so a
    compromised container cannot enumerate Secret Manager.
  EOT
  type        = string
  default     = "hm-run@homestead-mortgages.iam.gserviceaccount.com"
}

variable "image" {
  description = "Fully qualified API container image. The deploy owns the tag; this is what a job is created with."
  type        = string
}

variable "servicing_image" {
  description = "Fully qualified container image for apps/servicing, built from apps/servicing/Dockerfile. The deploy owns the tag."
  type        = string
}

# ── The environments ─────────────────────────────────────────────────────────

variable "stacks" {
  description = <<-EOT
    The environments, by name, each with what is its own: a Cloud SQL
    instance, the secrets its two identities read, the hostnames the front
    door sends to it, and whether the refinance analyst runs. Everything
    else an environment has is derived from its name.

    24 September 2026: two. `staging` is the stack that has been deployed
    since the start; `production` was stood up the same day. 25 September,
    Joe: the roots (supermortgage.com, www) are the marketing site's, not
    ours; the consumer app is app.supermortgage.com in production and
    staging.supermortgage.com in staging, and the servicing app is
    servicing.supermortgage.com in production and
    staging.servicing.supermortgage.com in staging. Moving a hostname
    between stacks is moving a string here — the certificates are the
    hostnames' and the address is shared.

    A secret named here must exist and be granted before the plan that
    references it is applied; Terraform grants the servicing pair and the
    deploy mounts the rest.
  EOT
  type = map(object({
    instance_name                 = string
    db_tier                       = optional(string, "db-g1-small")
    consumer_hostnames            = list(string)
    servicing_hostnames           = list(string)
    database_url_secret           = string
    servicing_database_url_secret = string
    servicing_api_token_secret    = string
    refi_analyst                  = optional(string, "off")
  }))
  default = {
    staging = {
      instance_name                 = "homestead-mortgages-db"
      consumer_hostnames            = ["supermortgage.com", "www.supermortgage.com", "staging.supermortgage.com"]
      servicing_hostnames           = ["servicing.supermortgage.com", "staging.servicing.supermortgage.com"]
      database_url_secret           = "HOMESTEAD_MORTGAGES_DATABASE_URL_STAGING"
      servicing_database_url_secret = "HOMESTEAD_MORTGAGES_SERVICING_DATABASE_URL_STAGING"
      servicing_api_token_secret    = "HOMESTEAD_MORTGAGES_SERVICING_API_TOKEN"
    }
    production = {
      instance_name = "homestead-mortgages-prod-db"
      # 25 September: the roots go to the marketing site (Doug's), and the
      # consumer app lives at app.supermortgage.com in production and
      # staging.supermortgage.com in staging. The roots stay on the staging
      # stack's list only until Doug's DNS takes them, so they never go dark.
      consumer_hostnames            = ["app.supermortgage.com"]
      servicing_hostnames           = []
      database_url_secret           = "HOMESTEAD_MORTGAGES_DATABASE_URL_PROD"
      servicing_database_url_secret = "HOMESTEAD_MORTGAGES_SERVICING_DATABASE_URL_PROD"
      servicing_api_token_secret    = "HOMESTEAD_MORTGAGES_SERVICING_API_TOKEN_PROD"
    }
  }
}

variable "default_stack" {
  description = "Which environment answers a request whose Host matches no hostname: the run.app URLs and strangers."
  type        = string
  default     = "staging"
}

# ── Shared settings ──────────────────────────────────────────────────────────

variable "apor_fetch_schedule" {
  description = <<-EOT
    When the survey behind the average prime offer rate is fetched, as a cron
    expression in UTC.

    The CFPB posts a new survey on Thursdays; the APORs computed from it take
    effect the following Monday. Daily at noon UTC is deliberately more often
    than weekly: the fetch is idempotent — a document already held inserts
    nothing — and a run that finds nothing new costs a conditional GET. What
    the extra runs buy is a series that recovers on its own from a Thursday the
    file server was down, instead of a week of every decision blocking on
    UW-008 until somebody notices.
  EOT
  type        = string
  default     = "0 12 * * *"
}

variable "loan_review_schedule" {
  description = <<-EOT
    When the daily refinance review runs, as a cron expression in
    America/New_York. The servicing app's 33.2 reviews at 07:00 ET, after its
    20.1 run at 06:30; ours is one pass, so one time. A run reviews each
    watched loan once for the day and writes nothing the second time.
  EOT
  type        = string
  default     = "0 7 * * *"
}

variable "servicing_sweep_schedule" {
  description = <<-EOT
    When the servicing app's sweep runs, as a cron expression in
    America/New_York — the zone its platform day is kept in. Its own nonprod
    runs it every minute; every five is enough, because a sweep is one pass
    of every scheduled job and the passes with a clock each fire once per
    platform day on their own schedule, whichever sweep first crosses it.
    The sweep lease keeps two firings from overlapping.
  EOT
  type        = string
  default     = "*/5 * * * *"
}

variable "alert_email" {
  description = <<-EOT
    Where a failed scheduled job is reported, in every environment. Cloud
    Scheduler sees a 200 the moment the job STARTS, so a run that exits
    non-zero reaches nobody unless an execution failure is itself alerted
    on. Empty disables the alerts rather than creating a channel to nowhere.
  EOT
  type        = string
  default     = ""
}

variable "anthropic_api_key_secret" {
  description = "Secret Manager secret holding the Anthropic API key the refinance analyst runs under, where a stack has the analyst on."
  type        = string
  default     = "HOMESTEAD_MORTGAGES_ANTHROPIC_API_KEY"
}

variable "servicing_console_members" {
  description = <<-EOT
    Who may pass Identity-Aware Proxy on a servicing hostname, as IAM
    members, in every environment. Joe's list, 22 September 2026: Doug, Drew
    and Joe. Spelled by the accounts' PRIMARY e-mail, which is what IAM
    reads a member back as: the three were trywalt.ai accounts, and on
    25 September Google reported them as supermortgage.com — the Workspace
    had moved its primary domain — and Terraform, writing one spelling and
    reading the other, dropped every member from state as "present, but now
    absent". A member spelled by an alias will do that again. Passing IAP
    reaches the console's own sign-in, not a session; the console's admins
    are made by staff-bootstrap and its own invitations, a separate list.
  EOT
  type        = list(string)
  default = [
    "user:doug@supermortgage.com",
    "user:drew@supermortgage.com",
    "user:joe@supermortgage.com",
  ]
}
