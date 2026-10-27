/**
 * Production says what it runs, and the approver sees what ships.
 *
 * On 26 October 2026 the promotion of 4ef79e7 shipped 194 commits that nobody
 * on the run page was shown, and /api/health named no commit, so "what is
 * production running?" meant reading the Actions history. Now the image
 * carries the commit it was built from, health reports it, both deploys fail
 * unless it is the commit they deployed, the promotion moves the `production`
 * tag, and before its approval it writes what ships since that tag. The
 * workflows cannot run here, so they are read; the summary script is run
 * against a repository made for the purpose. See docs/decisions.md,
 * "Production says what it runs, and the approver sees what ships".
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildIdentity } from "../config.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const COMMIT = "4ef79e7cf019d78673dca626f3cde293e0073b9b";

/** A workflow's jobs, by name, each as the text under its key. */
function jobsOf(yaml: string): Map<string, string> {
  const body = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  return new Map(
    heads.map((m, i): [string, string] => [
      m[1]!,
      body.slice(m.index, heads[i + 1]?.index ?? body.length),
    ]),
  );
}

/** One step of a job, from its `- name:` to the next step. */
function stepNamed(job: string, name: string): string {
  const start = job.indexOf(`- name: ${name}\n`);
  expect(start, `no step named "${name}"`).toBeGreaterThan(-1);
  const next = job.slice(start + 1).search(/\n {6}- /);
  return next === -1 ? job.slice(start) : job.slice(start, start + 1 + next);
}

describe("the commit health reports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Health, read with the build's two variables as given and nothing else. */
  async function healthWith(env: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv("BUILD_COMMIT", "");
    vi.stubEnv("BUILT_AT", "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { healthRouter } = await import("../routes/health.js");
    const user = await createUser();
    return callAs<{ commit: string | null; builtAt: string | null }>(
      user.id,
      [healthRouter],
      "GET",
      "/",
      undefined,
      "/api/health",
    );
  }

  it("is the commit the image was built from, and when", async () => {
    const health = await healthWith({ BUILD_COMMIT: COMMIT, BUILT_AT: "2026-10-27T14:03:11Z" });
    expect(health.status).toBe(200);
    expect(health.body.commit).toBe(COMMIT);
    expect(health.body.builtAt).toBe("2026-10-27T14:03:11Z");
  });

  it("is null where no build named one, never a guess", async () => {
    const health = await healthWith({});
    expect(health.status).toBe(200);
    expect(health.body).toHaveProperty("commit", null);
    expect(health.body).toHaveProperty("builtAt", null);
  });

  it("reads anything but a full commit id, or a UTC time to the second, as unknown", () => {
    for (const commit of ["", "unknown", "4ef79e7", COMMIT.toUpperCase(), `${COMMIT}0`, "HEAD"]) {
      expect([commit, buildIdentity({ BUILD_COMMIT: commit }).commit]).toEqual([commit, null]);
    }
    for (const builtAt of [
      "",
      "yesterday",
      "2026-10-27",
      "2026-10-27T14:03:11+02:00",
      "2026-13-40T99:99:99Z",
    ]) {
      expect([builtAt, buildIdentity({ BUILT_AT: builtAt }).builtAt]).toEqual([builtAt, null]);
    }
    expect(buildIdentity({ BUILD_COMMIT: ` ${COMMIT}\n` }).commit).toBe(COMMIT);
  });
});

describe("the image carries it", () => {
  const dockerfile = read("Dockerfile");
  const [build = "", runtime = ""] = dockerfile.split(/^FROM .* AS runtime$/m);

  it("hands the commit to the build, so the console's bundle names it too", () => {
    expect(build).toMatch(/^ARG BUILD_COMMIT\b[\s\S]*^RUN npm run db:generate && npm run build/m);
    const vite = read("apps/console/vite.config.ts");
    expect(vite).toContain("process.env.BUILD_COMMIT");
    expect(vite).toMatch(/define: \{\s+__BUILD_COMMIT__:/);
  });

  it("keeps the commit and the build time in the runtime's environment", () => {
    expect(runtime).toMatch(/^ARG BUILD_COMMIT\b/m);
    expect(runtime).toMatch(/^ARG BUILT_AT\b/m);
    expect(runtime).toMatch(/^ENV .*\bBUILD_COMMIT=\$BUILD_COMMIT\b/m);
    expect(runtime).toMatch(/^ENV .*\bBUILT_AT=\$BUILT_AT\b/m);
  });

  /**
   * Turbo runs a task with only the variables its configuration names, so a
   * build argument that is not named here reaches `docker build` and never
   * reaches the console's Vite, and the footer stays empty in every image.
   */
  it("lets the variable through turbo to the build", () => {
    const turbo = JSON.parse(read("turbo.json")) as { tasks: { build: { env?: string[] } } };
    expect(turbo.tasks.build.env).toContain("BUILD_COMMIT");
  });
});

describe("the staging deploy", () => {
  const deploy = jobsOf(read(".github/workflows/deploy.yml")).get("deploy") ?? "";

  it("builds the image for the pushed commit, tagged with it and carrying it", () => {
    const build = stepNamed(deploy, "Build and push");
    expect(build).toContain(":${{ github.sha }}");
    expect(build).toContain("--build-arg BUILD_COMMIT=${{ github.sha }}");
    expect(build).toContain("--build-arg BUILT_AT=");
  });

  it("fails unless health reports the commit it deployed", () => {
    const check = stepNamed(deploy, "Confirm the service runs the commit that was pushed");
    expect(check).toContain("EXPECTED: ${{ github.sha }}");
    expect(check).toMatch(/\/api\/health[\s\S]*\.get\("commit"\)/);
    expect(check).toMatch(/if \[ "\$COMMIT" != "\$EXPECTED" \]; then[\s\S]*::error::[\s\S]*exit 1/);
    // After the deploy, not before it.
    expect(deploy.indexOf("Confirm the service runs the commit")).toBeGreaterThan(
      deploy.indexOf("- name: Deploy to Cloud Run"),
    );
  });
});

describe("the production promotion", () => {
  const yaml = read(".github/workflows/deploy-production.yml");
  const jobs = jobsOf(yaml);
  const resolveJob = jobs.get("resolve") ?? "";

  it("says what ships before the gate: `resolve` names no environment and writes the summary", () => {
    expect(resolveJob).not.toMatch(/^\s+environment:/m);
    expect(resolveJob).toMatch(/fetch-depth: 0/);
    const say = stepNamed(resolveJob, "Say what ships");
    expect(say).toContain("node scripts/promotion-summary.mjs");
    expect(say).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(say).toContain("refs/tags/production");
    // Beside the tag, what production's own health says it runs.
    expect(say).toMatch(/\/api\/health[\s\S]*--running "\$RUNNING"/);
    // Every job that deploys waits behind the approval, and after `resolve`.
    for (const name of ["deploy-servicing", "deploy"]) {
      expect(jobs.get(name)).toMatch(/^ {4}environment: production$/m);
      expect(jobs.get(name)).toMatch(/needs: .*resolve/);
    }
  });

  it("refuses a commit that is not on main", () => {
    expect(resolveJob).toMatch(
      /git merge-base --is-ancestor "\$SHA" origin\/main \|\| \{[^}]*exit 1/,
    );
    // The input reaches the shell through the environment, not spliced into it.
    expect(resolveJob).toContain("REQUESTED: ${{ github.event.inputs.sha }}");
    expect(resolveJob.match(/\$\{\{ github\.event\.inputs\.sha \}\}/g)).toHaveLength(1);
  });

  it("fails unless health reports the commit it promoted", () => {
    const check = stepNamed(
      jobs.get("deploy") ?? "",
      "Confirm production runs the commit it promoted",
    );
    expect(check).toContain("EXPECTED: ${{ needs.resolve.outputs.sha }}");
    expect(check).toMatch(/if \[ "\$COMMIT" != "\$EXPECTED" \]; then[\s\S]*::error::[\s\S]*exit 1/);
  });

  it("moves the production tag after the deploy, from the one job that may write", () => {
    const tag = jobs.get("tag") ?? "";
    expect(tag).toMatch(/needs: \[resolve, deploy\]/);
    expect(tag).not.toMatch(/^\s+environment:/m);
    expect(tag).toMatch(/permissions:\s+contents: write\s+steps:/);
    expect(tag).toContain('git tag --force production "$SHA"');
    expect(tag).toContain("git push --force origin refs/tags/production");
    // A tag, never a branch.
    expect(tag).not.toMatch(/refs\/heads|git branch|git push[^\n]*HEAD/);
  });

  it("asks for `contents: write` nowhere else, in either workflow", () => {
    const writers: string[] = [];
    for (const file of ["deploy.yml", "deploy-production.yml"]) {
      for (const [name, job] of jobsOf(read(`.github/workflows/${file}`))) {
        // A key, not a comment that names one.
        if (/^\s+contents: write\s*$/m.test(job)) writers.push(`${file}:${name}`);
      }
      expect(read(`.github/workflows/${file}`).split("\njobs:\n")[0]).not.toMatch(/permissions:/);
    }
    expect(writers).toEqual(["deploy-production.yml:tag"]);
  });
});

describe("the promotion summary", () => {
  let repo = "";
  const commits: Record<string, string> = {};
  const script = join(root, "scripts", "promotion-summary.mjs");
  // A repository of its own: no hooks, signing or identity from the machine
  // it runs on, and fixed dates so every run reads the same.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_AUTHOR_DATE: "2026-10-27T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-27T12:00:00Z",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();

  function commit(name: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", name);
    commits[name] = git("rev-parse", "HEAD");
  }

  function summary(...args: string[]) {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return { markdown: r.stdout, warnings: r.stderr };
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "promotion-summary-"));
    git("init", "-q", "-b", "main");
    commit("What production runs", {
      "README.md": "one\n",
      "apps/api/src/a.ts": "export const a = 1;\n",
      "packages/db/prisma/migrations/20261001000000_first/migration.sql": "CREATE TABLE a ();\n",
    });
    commit("The API answers twice", { "apps/api/src/a.ts": "export const a = 2;\n" });
    commit("A table is added", {
      "packages/db/prisma/migrations/20261027000000_added/migration.sql": "CREATE TABLE b ();\n",
    });
    commit("Terraform and the deploy move together", {
      "infra/main.tf": "# a\n",
      ".github/workflows/deploy.yml": "name: x\n",
    });
    commit("A page of prose", { "docs/x.md": "words\n" });
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("lists what ships since the production tag, and the areas it touches", () => {
    const { markdown } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
    );
    expect(markdown).toContain("## Promoting `");
    expect(markdown).toContain("**4 commits ship**, changing 5 files in 5 areas.");
    expect(markdown).toMatch(
      /Production runs:\*\* `[0-9a-f]{7}` What production runs \(2026-10-27\), per the `production` tag/,
    );
    for (const row of [
      "| apps/api | 1 | 1 |",
      "| packages/db | 1 | 1 |",
      "| infra | 1 | 1 |",
      "| .github | 1 | 1 |",
      "| docs | 1 | 1 |",
    ]) {
      expect(markdown).toContain(row);
    }
    const list = markdown.slice(markdown.indexOf("### Commits"));
    for (const subject of [
      "The API answers twice",
      "A table is added",
      "Terraform and the deploy move together",
      "A page of prose",
    ]) {
      expect(list).toContain(subject);
    }
    expect(list).not.toContain("What production runs");
  });

  it("flags a new migration, infra/ and a workflow, in the summary and as annotations", () => {
    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
    );
    expect(markdown).toContain("### Look closely");
    expect(markdown).toContain(
      "**1 new database migration:** `20261027000000_added`. Each must only add",
    );
    expect(markdown).toContain("`infra/main.tf`");
    expect(markdown).toContain("`.github/workflows/deploy.yml`");
    expect(warnings).toContain("::warning title=New database migrations::");
    expect(warnings).toContain("::warning title=Infrastructure changed::");
    expect(warnings).toContain("::warning title=Workflows changed::");
    // The Markdown is stdout's alone: no commit subject reaches the log.
    expect(warnings).not.toContain("A table is added");
  });

  it("says nothing needs a closer look when nothing does", () => {
    const { markdown, warnings } = summary(
      commits["The API answers twice"]!,
      "--production-tag",
      commits["What production runs"]!,
    );
    expect(markdown).toContain("**1 commit ships**");
    expect(markdown).not.toContain("Look closely");
    expect(warnings).toBe("");
  });

  it("caps the list and says how many were cut", () => {
    const { markdown } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
      "--limit",
      "2",
    );
    expect(markdown).toContain("_2 more commits not shown: 2 of 4 are listed._");
  });

  it("measures from what production says it runs before there is a tag, and says so", () => {
    const { markdown } = summary(
      commits["A page of prose"]!,
      "--running",
      commits["What production runs"]!,
      "--running-source",
      "production's /api/health",
    );
    expect(markdown).toMatch(
      /Production runs:\*\* `[0-9a-f]{7}` What production runs \(2026-10-27\), per production's \/api\/health \(there is no `production` tag yet; this promotion sets it\)/,
    );
    expect(markdown).toContain("**4 commits ship**");
  });

  it("says when the tag is not what production runs, and measures from the tag", () => {
    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
      "--running",
      commits["The API answers twice"]!,
      "--running-source",
      "production's /api/health",
    );
    expect(markdown).toMatch(
      /The `production` tag says `[0-9a-f]{7}` What production runs \(2026-10-27\), but production's \/api\/health says `[0-9a-f]{7}` The API answers twice/,
    );
    expect(markdown).toContain("Everything below is measured from the tag.");
    expect(markdown).toContain("**4 commits ship**");
    expect(warnings).toContain("::warning title=The production tag is not what production runs::");
  });

  it("lists the last commits when nothing says what production runs", () => {
    const { markdown, warnings } = summary(commits["A page of prose"]!);
    expect(markdown).toContain(
      "**Production runs:** not known here. There is no `production` tag yet",
    );
    expect(markdown).toContain("### The last 50 commits up to this one");
    expect(markdown).toContain("What production runs");
    expect(warnings).toContain("::warning title=What production runs is not known::");
  });

  it("calls a promotion of what production already runs a redeploy", () => {
    const { markdown } = summary(
      commits["A table is added"]!,
      "--production-tag",
      commits["A table is added"]!,
    );
    expect(markdown).toContain("**Production already runs this commit.**");
  });

  it("calls an older commit a rollback, and says its migrations stay applied", () => {
    const { markdown, warnings } = summary(
      commits["What production runs"]!,
      "--production-tag",
      commits["A page of prose"]!,
    );
    expect(markdown).toContain("**This is a rollback.** 4 commits leave production");
    expect(markdown).toContain(
      "**1 migration production has applied stays applied:** `20261027000000_added`",
    );
    expect(markdown).toContain("### Commits leaving production");
    expect(warnings).toContain("::warning title=Rollback::");
  });

  it("flags a migration production already applied being changed", () => {
    git("checkout", "-q", "-b", "edited", commits["A page of prose"]!);
    commit("The first migration is rewritten", {
      "packages/db/prisma/migrations/20261001000000_first/migration.sql": "CREATE TABLE c ();\n",
    });
    git("checkout", "-q", "main");
    const { markdown, warnings } = summary(
      commits["The first migration is rewritten"]!,
      "--production-tag",
      commits["A page of prose"]!,
    );
    expect(markdown).toContain(
      "**A migration production has already applied was changed or removed:** `20261001000000_first`",
    );
    expect(warnings).toContain("::warning title=Applied migration changed::");
  });

  it("refuses a production tag this repository does not hold", () => {
    const r = spawnSync(
      process.execPath,
      [script, commits["A page of prose"]!, "--production-tag", "f".repeat(40)],
      { cwd: repo, env, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});
