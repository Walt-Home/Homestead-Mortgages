/**
 * Upload finished run records to the archive bucket, never replacing one.
 *
 *   npm run env:archive -w @hm/environments
 *
 * The bucket is gs://homestead-mortgages-eval-runs (infra/evals.tf), named
 * by project rather than by gcloud's default, which on Joe's Mac is not ours.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readyToArchive, runFiles } from "./archive.js";
import { DEFAULT_VERTEX_PROJECT } from "./vertex.js";

const BUCKET = `gs://${DEFAULT_VERTEX_PROJECT}-eval-runs`;

const { ready, stillWriting } = readyToArchive(runFiles("runs"), Date.now());
for (const f of stillWriting) console.log(`waiting  ${f.key} (written to in the last 15 minutes)`);
for (const f of ready) {
  // --no-clobber: an object already archived is left as it is, and the
  // bucket's retention policy would refuse to replace it anyway.
  const { stdout, stderr } = await promisify(execFile)("gcloud", [
    "storage",
    "cp",
    "--no-clobber",
    f.path,
    `${BUCKET}/${f.key}`,
    `--project=${DEFAULT_VERTEX_PROJECT}`,
  ]);
  const skipped = /skipping/i.test(stdout + stderr);
  console.log(`${skipped ? "kept    " : "archived"} ${f.key}`);
}
console.log(
  `${ready.length} finished, ${stillWriting.length} still being written; archive is ${BUCKET}`,
);
