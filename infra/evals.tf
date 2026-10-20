# ── Evaluation run records ───────────────────────────────────────────────────
#
# Where the environments' run records are kept once a run has finished
# (20 October 2026). A record is the evidence a score rests on — the task,
# the rulebook's hash, the engine's version, the policy, every turn and every
# graded field — and until now each one lived only in the git-ignored
# `packages/environments/runs/` on the machine that ran it.
#
# Append-only by retention, not by versioning: a retention policy keeps every
# object from being deleted or overwritten for a year, and Cloud Storage does
# not allow a retention policy on a versioned bucket, so this one is not
# versioned. The policy is not locked, so the project owner can still lift it
# if a record must ever go. `npm run env:archive -w @hm/environments` uploads
# finished runs; a file still being written is left for the next archive,
# because once uploaded it cannot be replaced.
#
# Every record is a synthetic loan: no borrower's or partner's data, ever.
# Nothing is granted on the bucket beyond the project's owners.

resource "google_storage_bucket" "eval_runs" {
  name                        = "${var.project_id}-eval-runs"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  retention_policy {
    retention_period = 31536000 # 365 days
    is_locked        = false
  }

  labels = {
    purpose = "eval-runs"
  }
}
