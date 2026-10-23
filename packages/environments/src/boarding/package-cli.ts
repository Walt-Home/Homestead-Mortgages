/**
 * Write transfer packages to disk, each as a directory of the thirteen files
 * and its manifest.json, for the servicing app's own boarding to read
 * (`apps/servicing/scripts/board-life-package.mjs`).
 *
 *   npm run env:transfer-package -w @hm/environments -- --out DIR
 *   npm run env:transfer-package -w @hm/environments -- --out DIR --seed 3 --index 12
 *
 * With no seed, the demo loan's four packages: DIR/clean, DIR/D-42, DIR/D-03
 * and DIR/defective. With a seed and an index, that boarding-triage training
 * task's package, as DIR/train-SEED-INDEX. The held-out suite is never
 * written: it is what every reported score is measured on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { drawsHeldoutStream } from "../heldout-guard.js";
import { defaultCalibration } from "../life/calibration.js";
import { demoLoan } from "../life/demo.js";
import {
  PACKAGE_FILES,
  packageManifest,
  type PackageFile,
  type PackageManifest,
} from "../life/transfer-package.js";
import { boardingTaskId, generateBoardingTask } from "./generator.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    seed: { type: "string" },
    index: { type: "string" },
  },
});

function write(
  dir: string,
  files: Readonly<Record<PackageFile, string>>,
  manifest: PackageManifest,
): void {
  mkdirSync(dir, { recursive: true });
  for (const f of PACKAGE_FILES) writeFileSync(join(dir, f), files[f]);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `${dir}: ${manifest.batch.loan_count} ${manifest.batch.loan_count === 1 ? "loan" : "loans"}, ${manifest.labels.length} planted (${manifest.labels.map((l) => `${l.loan} ${l.defect_id}`).join(", ") || "none"})`,
  );
}

function main(): void {
  if (!values.out)
    throw new Error("--out DIR is required: the directory the packages are written to");
  const out = resolve(values.out);
  if (values.seed === undefined) {
    const demo = demoLoan(defaultCalibration());
    for (const [name, pkg] of Object.entries(demo.packages))
      write(join(out, name), pkg.files, pkg.manifest);
    return;
  }
  const seed = Number(values.seed);
  const index = Number(values.index ?? 0);
  const id = boardingTaskId("train", seed, index);
  if (drawsHeldoutStream(id))
    throw new Error(`${id} draws a held-out task's stream; pick another index`);
  const task = generateBoardingTask("train", seed, index);
  write(
    join(out, `train-${seed}-${index}`),
    task.files,
    packageManifest(task.batch, task.files, task.labels),
  );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
