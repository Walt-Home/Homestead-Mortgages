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

  /**
   * The summary is advisory. A bug in it, an unreadable tag or a history it
   * cannot measure must never hold up a promotion, a rollback least of all;
   * the commit is refused by `pick`, and only there.
   */
  it("never holds a promotion up over its summary, and says when there is none", () => {
    const say = stepNamed(resolveJob, "Say what ships");
    expect(say).toMatch(/^ {8}continue-on-error: true$/m);
    // Whatever stops the step, the approver is told the list is missing.
    expect(say).toMatch(/trap said_nothing EXIT/);
    expect(say).toMatch(/said_nothing\(\) \{[\s\S]*GITHUB_STEP_SUMMARY[\s\S]*::error title=/);
    // The script's Markdown reaches the summary whole or not at all.
    expect(say).toMatch(/> "\$OUT"\n\s+cat "\$OUT" >> "\$GITHUB_STEP_SUMMARY"\n\s+WROTE=yes/);
    const pick = resolveJob.slice(resolveJob.indexOf("- id: pick"));
    expect(pick.slice(0, pick.indexOf("- name: Say what ships"))).not.toMatch(/continue-on-error/);
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
    // Nothing from the repository runs beside the token that can write to it.
    expect(tag).not.toContain("actions/checkout");
    // A tag, never a branch.
    expect(tag).not.toMatch(/refs\/heads|git branch|git push[^\n]*HEAD/);
  });

  /**
   * GitHub refuses a `git push` by the Actions token that moves a ref across
   * a change under .github/workflows/, and that token cannot hold the
   * `workflows` permission, so a pushed tag would stick at the first
   * promotion whose range edits a workflow. The tag moves through the REST
   * API instead, and a refusal warns: production has already changed, and
   * the next summary measures from what health reports, not from the tag.
   */
  it("moves the tag through the API, and a refusal warns rather than failing the deploy", () => {
    const tag = jobs.get("tag") ?? "";
    const move = stepNamed(tag, "Move the production tag to the promoted commit");
    expect(move).not.toMatch(/\bgit (?:tag|push)\b/);
    expect(move).toContain("GH_TOKEN: ${{ github.token }}");
    expect(move).toMatch(
      /gh api -X PATCH "repos\/\$GITHUB_REPOSITORY\/git\/refs\/tags\/production" \\\n\s+-f sha="\$SHA" -F force=true/,
    );
    expect(move).toMatch(
      /gh api -X POST "repos\/\$GITHUB_REPOSITORY\/git\/refs" \\\n\s+-f ref=refs\/tags\/production -f sha="\$SHA"/,
    );
    // It reads the tag back rather than trusting the answer.
    expect(move).toMatch(
      /NOW=\$\(gh api [^\n]*git\/ref\/tags\/production[^\n]*\)\n\s+test "\$NOW" = "\$SHA"/,
    );
    expect(move).toMatch(/^ {8}id: move$/m);
    expect(move).toMatch(/^ {8}continue-on-error: true$/m);
    const said = stepNamed(tag, "Say so when the tag did not move");
    expect(said).toContain("if: steps.move.outcome == 'failure'");
    expect(said).toContain("::warning title=The production tag did not move::");
    expect(said).toContain('>> "$GITHUB_STEP_SUMMARY"');
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
      "**1 new database migration:** `20261027000000_added`. The revision production runs now must still read and write correctly",
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

  it("says when the tag is not what production runs, and measures from what production runs", () => {
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
    expect(markdown).toContain("Everything below is measured from what production says it runs.");
    expect(markdown).toContain("**3 commits ship**");
    expect(markdown.slice(markdown.indexOf("### Commits"))).not.toContain("The API answers twice");
    expect(warnings).toContain("::warning title=The production tag is not what production runs::");
  });

  /**
   * A deploy that fails after its revision took traffic leaves production on
   * the newer commit with the tag where it was. Promoting the tag's commit
   * then is a rollback, and the approver must see what leaves and which
   * migrations stay applied, not "nothing new ships".
   */
  it("calls it a rollback when the tag names the promoted commit but production runs a newer one", () => {
    const { markdown, warnings } = summary(
      commits["The API answers twice"]!,
      "--production-tag",
      commits["The API answers twice"]!,
      "--running",
      commits["A page of prose"]!,
      "--running-source",
      "production's /api/health",
    );
    expect(markdown).not.toContain("Production already runs this commit");
    expect(markdown).toContain("**This is a rollback.** 3 commits leave production");
    expect(markdown).toContain("### Commits leaving production");
    expect(markdown).toContain(
      "**1 migration production has applied stays applied:** `20261027000000_added`",
    );
    expect(warnings).toContain("::warning title=Rollback::");
  });

  it("lists what ships when production runs older than the tag, as after traffic sent back by hand", () => {
    const { markdown } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["A page of prose"]!,
      "--running",
      commits["The API answers twice"]!,
      "--running-source",
      "production's /api/health",
    );
    expect(markdown).not.toContain("Production already runs this commit");
    expect(markdown).toContain("**3 commits ship**");
    expect(markdown).toContain("**1 new database migration:** `20261027000000_added`");
  });

  it("measures from the tag when the service names no commit here, and says so", () => {
    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
      "--running",
      "e".repeat(40),
      "--running-source",
      "production's /api/health",
    );
    expect(markdown).toContain(
      `By production's /api/health, production runs \`${"e".repeat(12)}\`, which is no commit in this repository`,
    );
    expect(markdown).toMatch(
      /Production runs:\*\* `[0-9a-f]{7}` What production runs \(2026-10-27\), per the `production` tag/,
    );
    expect(markdown).toContain("**4 commits ship**");
    expect(warnings).toContain("::warning title=What production runs is not a commit here::");
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

  it("goes on without a production tag this repository does not hold, and says so", () => {
    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      "f".repeat(40),
    );
    expect(markdown).toContain(
      `The \`production\` tag names \`${"f".repeat(12)}\`, which is no commit in this repository`,
    );
    expect(markdown).toContain("### The last 50 commits up to this one");
    expect(warnings).toContain("::warning title=The production tag is not a commit here::");
  });

  it("refuses a commit to promote that this repository does not hold", () => {
    const r = spawnSync(process.execPath, [script, "f".repeat(40)], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("says when a new servicing image is a rebuild with nothing under apps/servicing changed", () => {
    const rebuilt = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["What production runs"]!,
      "--servicing-image",
      "servicing:new",
      "--servicing-running",
      "servicing:old",
    ).markdown;
    expect(rebuilt).toContain("**Servicing image:** `servicing:new`, replacing `servicing:old`");
    expect(rebuilt).toContain(
      "Nothing under apps/servicing differs between production's commit and this one",
    );

    git("checkout", "-q", "-b", "servicing", commits["A page of prose"]!);
    commit("The servicing app changes", { "apps/servicing/src/x.ts": "export {};\n" });
    git("checkout", "-q", "main");
    const changed = summary(
      commits["The servicing app changes"]!,
      "--production-tag",
      commits["What production runs"]!,
      "--servicing-image",
      "servicing:new",
      "--servicing-running",
      "servicing:old",
    ).markdown;
    expect(changed).toContain("replacing `servicing:old`");
    expect(changed).not.toContain("Nothing under apps/servicing differs");
  });

  /**
   * Whether the revision production runs survives a schema is the rule a
   * rollback rests on, and a new enum value or a rule on a table it already
   * writes is an addition that breaks it. The summary names what it reads
   * in the SQL; a table, a column or a constraint the release makes itself
   * is none of that.
   */
  it("names what a new migration's SQL does that a rollback cannot stand", () => {
    git("checkout", "-q", "-b", "risky", commits["A page of prose"]!);
    commit("Three migrations", {
      "packages/db/prisma/migrations/20261028000000_an_enum_grows/migration.sql":
        "-- A comment; with a semicolon and a DROP TABLE in it.\nALTER TYPE \"Stage\" ADD VALUE 'C' BEFORE 'D';\n",
      "packages/db/prisma/migrations/20261028010000_a_rule_on_an_old_table/migration.sql":
        'ALTER TABLE "a" ADD CONSTRAINT "a_x_is_positive" CHECK ("x" > 0);\n',
      "packages/db/prisma/migrations/20261028020000_new_things_only/migration.sql": [
        'CREATE TABLE "d" (\n  "id" UUID NOT NULL,\n  CONSTRAINT "d_pkey" PRIMARY KEY ("id")\n);',
        'ALTER TABLE "d" ADD CONSTRAINT "d_id_is_set" CHECK ("id" IS NOT NULL);',
        'ALTER TABLE "a"\n  ADD COLUMN "y" TEXT,\n  ADD COLUMN "z" TEXT NOT NULL DEFAULT \'\';',
        'ALTER TABLE "a" ADD CONSTRAINT "a_y_and_z" CHECK (("y" IS NULL) = ("z" = \'\'));',
        'CREATE UNIQUE INDEX "d_once" ON "d" ("id");',
        'CREATE UNIQUE INDEX "a_y_once" ON "a" ("y") WHERE "y" IS NOT NULL;',
        'ALTER TABLE "a" DROP CONSTRAINT "a_old_rule";',
        'CREATE TRIGGER "d_guard" BEFORE INSERT ON "d" FOR EACH ROW EXECUTE FUNCTION f();',
        "CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  DROP TABLE x;\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;",
        "",
      ].join("\n"),
    });
    git("checkout", "-q", "main");

    const forward = summary(
      commits["Three migrations"]!,
      "--production-tag",
      commits["A page of prose"]!,
    ).markdown;
    expect(forward).toContain("**3 new database migrations:**");
    expect(forward).toContain(
      "must still read and write correctly against the schema they leave and the rows this release writes",
    );
    expect(forward).toContain("A new enum value lands a release before any code writes it");
    expect(forward).toContain("  - `20261028000000_an_enum_grows` adds an enum value.");
    expect(forward).toContain(
      "  - `20261028010000_a_rule_on_an_old_table` adds a constraint to an existing table.",
    );
    expect(forward).not.toContain("`20261028020000_new_things_only` ");

    const back = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["Three migrations"]!,
    ).markdown;
    expect(back).toContain("**3 migrations production has applied stay applied:**");
    expect(back).toContain("no enum value it was never built for");
    expect(back).toContain("  - `20261028000000_an_enum_grows` adds an enum value.");
  });

  it("flags the risky changes when production's commit is on another line", () => {
    git("checkout", "-q", "-b", "side", commits["The API answers twice"]!);
    commit("Production's own line", { "apps/api/src/side.ts": "export {};\n" });
    git("checkout", "-q", "main");
    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["Production's own line"]!,
    );
    expect(markdown).toContain("**Production's commit is not on this commit's line.**");
    expect(markdown).toContain("### Look closely");
    expect(markdown).toContain("**1 new database migration:** `20261027000000_added`");
    expect(markdown).toContain("`infra/main.tf`");
    expect(markdown).toContain("`.github/workflows/deploy.yml`");
    for (const title of [
      "New database migrations",
      "Infrastructure changed",
      "Workflows changed",
      "Production is on another line",
    ]) {
      expect(warnings).toContain(`::warning title=${title}::`);
    }
  });

  /**
   * After main's history is rewritten, a tag left on the old history shares
   * no commit with anything promoted from the new one. That must not stop a
   * promotion: the risky changes are read off the two commits' files.
   */
  it("goes on when production's commit shares no history with this one", () => {
    git("checkout", "-q", "--orphan", "rewritten");
    git("rm", "-rq", "--cached", ".");
    rmSync(join(repo, "infra"), { recursive: true, force: true });
    rmSync(join(repo, ".github"), { recursive: true, force: true });
    rmSync(join(repo, "packages/db/prisma/migrations/20261027000000_added"), {
      recursive: true,
      force: true,
    });
    git("add", "-A");
    git("commit", "-q", "-m", "An old history");
    commits["An old history"] = git("rev-parse", "HEAD");
    git("checkout", "-q", "-f", "main");

    const { markdown, warnings } = summary(
      commits["A page of prose"]!,
      "--production-tag",
      commits["An old history"]!,
    );
    expect(markdown).toContain("**Production's commit shares no history with this one.**");
    expect(markdown).toContain("**1 new database migration:** `20261027000000_added`");
    expect(markdown).toContain("`infra/main.tf`");
    expect(markdown).toContain("### The last 50 commits up to this one");
    expect(warnings).toContain("::warning title=Production shares no history with this commit::");
  });
});
