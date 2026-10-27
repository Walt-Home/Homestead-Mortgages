#!/usr/bin/env node
/**
 * What a production promotion ships, as Markdown for the run page.
 *
 *   node scripts/promotion-summary.mjs <commit> [--production-tag <commit>]
 *     [--running <commit> --running-source <words>] [--api-image <image>]
 *     [--servicing-image <image>] [--servicing-running <image>]
 *     [--repository <url>] [--limit 300]
 *
 * deploy-production.yml's `resolve` job runs this before the `production`
 * environment's gate and appends what it prints to the run's summary, so the
 * approver reads what ships on the page that asks for the approval. On 26
 * October 2026 the promotion of 4ef79e7 shipped 194 commits — production had
 * last been promoted on 21 October — and nothing showed anyone the list. See
 * docs/decisions.md, "Production says what it runs, and the approver sees
 * what ships".
 *
 * What production runs today is the `production` tag, which every successful
 * promotion moves (`--production-tag`). Beside it the workflow passes what
 * the service itself says (`--running`, and where that came from in
 * `--running-source`): the commit production's /api/health reports, or for
 * an image too old to report one, the commit its image is tagged with.
 * Before the first promotion there is no tag and that stands in; when the
 * two disagree — a revision rolled back by hand, say — the tag still
 * measures the range and the summary says so. With neither, the summary
 * says that nothing here knows what production runs, and lists the last
 * fifty commits instead of a range.
 *
 * Every commit is resolved in the repository this runs in, which needs main's
 * whole history (`fetch-depth: 0`). A risky change — a new migration, a
 * migration production already applied being changed, anything under infra/
 * or .github/workflows/, a rollback — is flagged in the summary and printed
 * as a `::warning::` on stderr, so it is among the run's annotations too.
 * The Markdown goes to stdout and nowhere else: the workflow writes it
 * straight to the summary, so no commit subject is ever echoed into the log,
 * where the runner would read it for commands.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const MIGRATIONS = "packages/db/prisma/migrations";
const FALLBACK_COUNT = 50;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "production-tag": { type: "string", default: "" },
    running: { type: "string", default: "" },
    "running-source": { type: "string", default: "the production service" },
    "api-image": { type: "string", default: "" },
    "servicing-image": { type: "string", default: "" },
    "servicing-running": { type: "string", default: "" },
    repository: { type: "string", default: "" },
    limit: { type: "string", default: "300" },
  },
});

if (positionals.length !== 1) {
  console.error(
    "usage: promotion-summary.mjs <commit> [--production-tag <commit>] [--running <commit>] …",
  );
  process.exit(2);
}
const limit = Number(opt.limit);
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit is '${opt.limit}'; it is a whole number of commits.`);
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).replace(
    /\n+$/,
    "",
  );
}

const lines = (text) => text.split("\n").filter((l) => l !== "");

/** The full id of a commit, or null when this clone holds no such commit. */
function commitOf(ref) {
  if (!ref) return null;
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Whether `a` is `b` or one of its ancestors. */
function isAncestor(a, b) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { encoding: "utf8" });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${a} ${b} failed: ${r.stderr.trim()}`);
}

/** `abc1234` subject (2026-10-26), for a bullet. */
function describe(commit) {
  const [hash, date, ...subject] = git("log", "-1", "--format=%h%x09%cs%x09%s", commit).split("\t");
  return `\`${hash}\` ${subject.join("\t")} (${date})`;
}

const short = (commit) => git("rev-parse", "--short=7", commit);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The verb that agrees with a count: "1 commit ships", "2 commits ship". */
const agree = (n, one, many) => (n === 1 ? one : many);

/** A GitHub workflow command on stderr, escaped the way the runner reads one. */
function warn(title, message) {
  const data = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  process.stderr.write(`::warning title=${prop(title)}::${data(message)}\n`);
}

/** Text in a fence no line of it can close. */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Where a path sits: an app or a package by name, else its top-level folder. */
function area(path) {
  const parts = path.split("/");
  if (parts.length === 1) return "(top level)";
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/** The migration directories a commit holds. */
function migrationsAt(commit) {
  const r = spawnSync("git", ["ls-tree", "-d", "--name-only", `${commit}:${MIGRATIONS}`], {
    encoding: "utf8",
  });
  return new Set(r.status === 0 ? lines(r.stdout) : []);
}

/**
 * Everything between an older commit and a newer one on its line: the
 * commits, the files, the areas they fall in, and the changes worth a second
 * look. `older..newer` is what ships on a promotion forward and what leaves
 * production on a rollback.
 */
function measure(older, newer) {
  const span = `${older}..${newer}`;
  const commits = Number(git("rev-list", "--count", "--no-merges", span));
  const merges = Number(git("rev-list", "--count", "--merges", span));
  const files = lines(git("diff", "--name-only", older, newer));

  const areas = new Map();
  const row = (name) => {
    if (!areas.has(name)) areas.set(name, { commits: 0, files: 0 });
    return areas.get(name);
  };
  for (const chunk of git("log", "--no-merges", "--format=%x00%H", "--name-only", span)
    .split("\0")
    .slice(1)) {
    const touched = new Set(lines(chunk).slice(1).map(area));
    for (const name of touched) row(name).commits += 1;
  }
  for (const file of files) row(area(file)).files += 1;

  const before = migrationsAt(older);
  const after = migrationsAt(newer);
  const changedDirs = new Set(
    files
      .filter((f) => f.startsWith(`${MIGRATIONS}/`))
      .map((f) => f.slice(MIGRATIONS.length + 1).split("/"))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0]),
  );

  const log = git("log", "--no-merges", `--max-count=${limit}`, "--format=%h %s", span);
  return {
    commits,
    merges,
    files,
    areas: [...areas.entries()].sort(
      ([a, x], [b, y]) => y.commits - x.commits || y.files - x.files || a.localeCompare(b),
    ),
    added: [...after].filter((d) => !before.has(d)).sort(),
    removed: [...before].filter((d) => !after.has(d)).sort(),
    edited: [...changedDirs].filter((d) => before.has(d) && after.has(d)).sort(),
    infra: files.filter((f) => f.startsWith("infra/")),
    workflows: files.filter((f) => f.startsWith(".github/workflows/")),
    log,
  };
}

const list = (items) => items.map((i) => `\`${i}\``).join(", ");

function areasTable(m) {
  return [
    "| Area | Commits | Files |",
    "| :-- | --: | --: |",
    ...m.areas.map(([name, { commits, files }]) => `| ${name} | ${commits} | ${files} |`),
  ].join("\n");
}

function commitList(m) {
  const shown = lines(m.log).length;
  const out = [fenced(m.log)];
  if (m.commits > shown) {
    out.push(
      `_${plural(m.commits - shown, "more commit")} not shown: ${shown} of ${m.commits} ${agree(shown, "is", "are")} listed._`,
    );
  }
  return out.join("\n\n");
}

// --- What is being promoted, and what production runs -----------------------

const sha = commitOf(positionals[0]);
if (!sha) {
  console.error(`${positionals[0]} is not a commit in this repository.`);
  process.exit(1);
}

const tag = commitOf(opt["production-tag"]);
if (opt["production-tag"] && !tag) {
  console.error(`--production-tag ${opt["production-tag"]} is not a commit in this repository.`);
  process.exit(1);
}
const running = commitOf(opt.running);
const source = opt["running-source"];

const out = [`## Promoting \`${short(sha)}\` to production`, ""];
const head = [`- **Promoting:** ${describe(sha)}`];
const notes = [];

let previous = null;
if (tag) {
  previous = tag;
  head.push(`- **Production runs:** ${describe(tag)}, per the \`production\` tag`);
  if (running && running !== tag) {
    notes.push(
      `The \`production\` tag says ${describe(tag)}, but ${source} says ${describe(running)}. Everything below is measured from the tag.`,
    );
    warn(
      "The production tag is not what production runs",
      `The production tag is ${short(tag)}, but ${source} says ${short(running)}.`,
    );
  }
} else if (running) {
  previous = running;
  head.push(
    `- **Production runs:** ${describe(running)}, per ${source} (there is no \`production\` tag yet; this promotion sets it)`,
  );
} else {
  const named = opt.running
    ? `, and ${source} names \`${opt.running.slice(0, 12)}\`, which is no commit on main here`
    : "";
  head.push(
    `- **Production runs:** not known here. There is no \`production\` tag yet${named}; this promotion sets it.`,
  );
  warn(
    "What production runs is not known",
    "There is no production tag, so nothing here can say which commits ship. The summary lists the last commits instead.",
  );
}

if (opt["api-image"]) head.push(`- **API image:** \`${opt["api-image"]}\``);
if (opt["servicing-image"]) {
  const now = opt["servicing-running"];
  const versus = !now
    ? ""
    : now === opt["servicing-image"]
      ? ", the one production runs today"
      : `, replacing \`${now}\``;
  head.push(`- **Servicing image:** \`${opt["servicing-image"]}\`${versus}`);
}
if (opt.repository && previous && previous !== sha) {
  // What ships, or on a rollback what leaves: the compare's three dots show
  // the second commit's changes since the two parted.
  const [from, to] = isAncestor(sha, previous) ? [sha, previous] : [previous, sha];
  head.push(`- **Compare:** ${opt.repository}/compare/${short(from)}...${short(to)}`);
}

out.push(...head, "");
for (const note of notes) out.push(`> ${note}`, "");

// --- The range -------------------------------------------------------------

if (!previous) {
  const recent = git("log", "--no-merges", `--max-count=${FALLBACK_COUNT}`, "--format=%h %s", sha);
  out.push(
    `### The last ${FALLBACK_COUNT} commits up to this one`,
    "",
    "Nothing below is measured against production, because nothing here says what production runs.",
    "",
    fenced(recent),
  );
} else if (previous === sha) {
  out.push("**Production already runs this commit.** This is a redeploy, and nothing new ships.");
} else if (isAncestor(previous, sha)) {
  const m = measure(previous, sha);
  const besides = m.merges ? `, besides ${plural(m.merges, "merge")}` : "";
  out.push(
    `**${plural(m.commits, "commit")} ${agree(m.commits, "ships", "ship")}**${besides}, changing ${plural(m.files.length, "file")} in ${plural(m.areas.length, "area")}.`,
    "",
  );

  const look = [];
  if (m.added.length) {
    look.push(
      `- **${plural(m.added.length, "new database migration")}:** ${list(m.added)}. Each must only add — new tables, new columns that are nullable or carry a default — so the revision production runs now still runs against the schema this one leaves, and a rollback stays possible. A removal waits for the release after.`,
    );
    warn(
      "New database migrations",
      `${plural(m.added.length, "new migration")} ${agree(m.added.length, "ships", "ship")}: ${m.added.join(", ")}. Each must only add, so the previous revision still runs against the new schema.`,
    );
  }
  if (m.edited.length || m.removed.length) {
    const which = [...m.edited, ...m.removed];
    look.push(
      `- **A migration production has already applied was changed or removed:** ${list(which)}. Prisma will not apply it again; read the diff before approving.`,
    );
    warn(
      "Applied migration changed",
      `A migration production has already applied was changed or removed: ${which.join(", ")}.`,
    );
  }
  if (m.infra.length) {
    look.push(
      `- **${plural(m.infra.length, "file")} under infra/:** ${list(m.infra)}. Terraform is applied by hand and is not part of this promotion; check whether this release needs an apply first.`,
    );
    warn(
      "Infrastructure changed",
      `${plural(m.infra.length, "file")} under infra/ changed in this range; Terraform is applied by hand.`,
    );
  }
  if (m.workflows.length) {
    look.push(
      `- **${plural(m.workflows.length, "file")} under .github/workflows/:** ${list(m.workflows)}. This run follows main's copy of deploy-production.yml, whatever the commit being promoted holds.`,
    );
    warn(
      "Workflows changed",
      `${plural(m.workflows.length, "file")} under .github/workflows/ changed in this range.`,
    );
  }
  if (look.length) out.push("### Look closely", "", ...look, "");

  out.push("### Areas touched", "", areasTable(m), "", "### Commits", "", commitList(m));
} else if (isAncestor(sha, previous)) {
  const m = measure(sha, previous);
  out.push(
    `**This is a rollback.** ${plural(m.commits, "commit")} ${agree(m.commits, "leaves", "leave")} production, changing ${plural(m.files.length, "file")} in ${plural(m.areas.length, "area")}.`,
    "",
  );
  warn("Rollback", `This promotion takes production back ${plural(m.commits, "commit")}.`);
  if (m.added.length) {
    out.push(
      "### Look closely",
      "",
      `- **${plural(m.added.length, "migration")} production has applied ${agree(m.added.length, "stays", "stay")} applied:** ${list(m.added)}. The database is not rolled back: this older revision runs against the schema as it stands, which holds only if each one only added.`,
      "",
    );
    warn(
      "Migrations stay applied",
      `${plural(m.added.length, "migration")} newer than this commit ${agree(m.added.length, "stays", "stay")} applied: ${m.added.join(", ")}.`,
    );
  }
  out.push(
    "### Areas the rollback undoes",
    "",
    areasTable(m),
    "",
    "### Commits leaving production",
    "",
    commitList(m),
  );
} else {
  const base = git("merge-base", previous, sha);
  const m = measure(base, sha);
  const gone = Number(git("rev-list", "--count", "--no-merges", `${sha}..${previous}`));
  out.push(
    `**Production's commit is not on this commit's line.** They part at ${describe(base)}: ${plural(gone, "commit")} production runs ${agree(gone, "is", "are")} not in this one, and ${plural(m.commits, "commit")} here ${agree(m.commits, "is", "are")} not in production. Below is what this commit adds since they parted.`,
    "",
    "### Areas touched",
    "",
    areasTable(m),
    "",
    "### Commits",
    "",
    commitList(m),
  );
  warn(
    "Production is on another line",
    `Production's commit ${short(previous)} is not an ancestor of ${short(sha)}, nor the other way round.`,
  );
}

process.stdout.write(`${out.join("\n")}\n`);
