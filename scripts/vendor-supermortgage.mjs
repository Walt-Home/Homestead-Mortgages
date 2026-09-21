/**
 * Re-sync everything vendored from doug-ludlow/Supermortgage, from one clone
 * at one commit.
 *
 *   node scripts/vendor-supermortgage.mjs <commit> [--branch <name>]
 *
 * Three places in this repo carry his code byte for byte, and each has a
 * VENDORED_FROM that names the commit. Syncing them separately is how they
 * drift from each other; this copies all three from the same checkout and
 * prints the hash each VENDORED_FROM should record. It edits nothing else:
 * updating the three notes, the typecheck and the tests are the caller's.
 *
 *   apps/servicing            src db spec docs fixtures tools tsconfig.json
 *   packages/kernel           src/kernel  spec/registry/timers.json
 *   packages/partner-book     src/infra/files/xlsx.ts → src/vendored/xlsx.ts
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/doug-ludlow/Supermortgage.git";
const DEFAULT_BRANCH = "claude/mortgage-subservicer-builder-y9nr7e";

const args = process.argv.slice(2);
const commit = args.find((a) => !a.startsWith("--"));
const branch = args.includes("--branch") ? args[args.indexOf("--branch") + 1] : DEFAULT_BRANCH;
if (!commit) {
  console.error("usage: vendor-supermortgage.mjs <commit> [--branch <name>]");
  process.exit(2);
}

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });

const clone = mkdtempSync(join(tmpdir(), "supermortgage-"));
try {
  console.error(`cloning ${REPO} (${branch}) …`);
  sh("git", ["clone", "-q", "--branch", branch, REPO, clone]);
  sh("git", ["-C", clone, "checkout", "-q", commit]);
  const committed = sh("git", ["-C", clone, "log", "-1", "--format=%H %cI %s"]).trim();
  console.error(`at ${committed}`);

  const filter = (src) => !/__pycache__|\.DS_Store/.test(src);
  const copyTree = (from, to) => {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter });
  };

  // apps/servicing: the whole runtime.
  for (const d of ["src", "db", "spec", "docs", "fixtures", "tools"]) {
    copyTree(join(clone, d), join(root, "apps", "servicing", d));
  }
  cpSync(join(clone, "tsconfig.json"), join(root, "apps", "servicing", "tsconfig.json"));

  // packages/kernel: the kernel and the registry it reads.
  copyTree(join(clone, "src", "kernel"), join(root, "packages", "kernel", "src", "kernel"));
  cpSync(
    join(clone, "spec", "registry", "timers.json"),
    join(root, "packages", "kernel", "spec", "registry", "timers.json"),
  );

  // packages/partner-book: the xlsx reader.
  cpSync(
    join(clone, "src", "infra", "files", "xlsx.ts"),
    join(root, "packages", "partner-book", "src", "vendored", "xlsx.ts"),
  );

  const hash = (cwd, paths) =>
    sh(
      "bash",
      [
        "-c",
        `find ${paths.join(" ")} -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64`,
      ],
      { cwd },
    ).trim();

  console.log(`Commit       ${commit}`);
  console.log(`Committed    ${committed.split(" ")[1]}`);
  console.log(
    `apps/servicing        ${hash(join(root, "apps", "servicing"), ["src", "db", "spec", "docs", "fixtures", "tools", "tsconfig.json"])}`,
  );
  console.log(
    `packages/kernel       ${hash(join(root, "packages", "kernel"), ["src/kernel", "spec"])}`,
  );
  console.log(
    `packages/partner-book ${hash(join(root, "packages", "partner-book"), ["src/vendored/xlsx.ts"])}`,
  );
  console.error(
    "Now update the three VENDORED_FROM files, then: npm run typecheck -w @hm/servicing && npm test -w @hm/kernel -w @hm/partner-book -w @hm/servicing",
  );
} finally {
  rmSync(clone, { recursive: true, force: true });
}
