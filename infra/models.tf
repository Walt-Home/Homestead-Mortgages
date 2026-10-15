# ── Model weights ────────────────────────────────────────────────────────────
#
# Where the weights of any model we run ourselves are kept (15 October 2026).
# Shared by both environments, like the service accounts, because a model is
# not an environment's: staging and production would serve the same bytes.
#
# A model is stored under its publisher's name and the exact revision it was
# taken from — `deepseek-ai/DeepSeek-V4-Flash-0731/<revision>/` — never under
# a name of ours, because a name of ours is what made a stock download read
# as a fork. Beside it sits `SHA256SUMS`, every file's digest checked against
# what the publisher states, so "these are the bytes they released" is a file
# anyone can re-run rather than a claim.
#
# The first copy came from Walt's project (gs://homestead-weights), which is
# exactly the arrangement this project exists to end: there, Walt's default
# compute and Cloud Build accounts could read and delete it. Here nothing is
# granted on the bucket; whatever serves or trains a model is given
# objectViewer on this bucket by name when it exists. Weights trained on a
# partner's data never land here — they would get a bucket and a key of the
# partner's own.
#
# Versioned, so an overwrite or a delete keeps the old bytes for thirty days
# beyond the seven soft delete already holds. Nothing should overwrite: a new
# revision is a new path.

resource "google_storage_bucket" "models" {
  name                        = "${var.project_id}-models"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    purpose = "model-weights"
  }
}
