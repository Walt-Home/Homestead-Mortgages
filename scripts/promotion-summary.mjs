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
 * What production runs is what the service itself says (`--running`, and
 * where that came from in `--running-source`): the commit production's
 * /api/health reports, or for an image too old to report one, the commit its
 * image is tagged with. That is what serves, so the range is measured from
 * it. The `production` tag, which every promotion moves once health has
 * reported its commit (`--production-tag`), stands in only when the service
 * names no commit this repository holds; when the two disagree the summary
 * says so, because a tag that is not what production runs means a deploy
 * that failed after it took traffic, a tag the last promotion could not
 * move, or traffic sent back by hand. Measuring from such a tag would call a
 * rollback a redeploy, and list commits that already shipped. With neither,
 * the summary says that nothing here knows what production runs, and lists
 * the last fifty commits instead of a range.
 *
 * Every commit is resolved in the repository this runs in, which needs main's
 * whole history (`fetch-depth: 0`). A risky change — a new migration, a
 * migration production already applied being changed, anything under infra/
 * or .github/workflows/, a rollback — is flagged in the summary and printed
 * as a `::warning::` on stderr, so it is among the run's annotations too. A
 * new migration's SQL is read for what a rollback cannot stand (a new enum
 * value, a constraint or trigger on a table that already exists, a drop, a
 * rename), and what is found is named beside it; the reading is a pointer to
 * the migration, never a verdict on it. When production's commit is not on
 * the promoted commit's line, or shares no history with it at all (main
 * rewritten under the tag), the risky changes are read off the two commits'
 * files directly, which needs no common history.
 *
 * The Markdown goes to stdout and nowhere else: the workflow writes it
 * straight to the summary, so no commit subject is ever echoed into the log,
 * where the runner would read it for commands. The summary is advisory, and
 * the workflow says so in the summary rather than failing when this does.
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

/** Where two lines part, or null when they share no history at all. */
function mergeBase(a, b) {
  const r = spawnSync("git", ["merge-base", a, b], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  if (r.status === 1) return null;
  throw new Error(`git merge-base ${a} ${b} failed: ${r.stderr.trim()}`);
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

// --- What a migration's SQL does that a rollback cannot stand ---------------

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?: ?\. ?${IDENT})?`;
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QUALIFIED}) (.*)$`,
  "i",
);

/** The identifiers in a piece of SQL, unquoted; a bare one folds to lower case as Postgres does. */
function identifiers(sql) {
  return [...sql.matchAll(new RegExp(IDENT, "g"))].map(([name]) =>
    name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name.toLowerCase(),
  );
}
const unqualified = (name) => identifiers(name).at(-1) ?? name;

/** The text inside the first parentheses at or after `from`, balanced. */
function parenthesized(sql, from = 0) {
  const open = sql.indexOf("(", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

/** An ALTER TABLE's actions, split at the commas between them and not inside them. */
function actions(sql) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")") depth -= 1;
    if (sql[i] === "," && depth === 0) {
      out.push(sql.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(sql.slice(start).trim());
  return out.filter(Boolean);
}

const CONSTRAINT_ACTION = new RegExp(
  String.raw`^ADD (?:CONSTRAINT ${IDENT} )?(CHECK|UNIQUE|PRIMARY KEY|FOREIGN KEY|EXCLUDE)\b(.*)$`,
  "i",
);

const CREATE_TABLE = new RegExp(
  String.raw`^CREATE (?:(?:GLOBAL |LOCAL )?(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE (?:IF NOT EXISTS )?(${QUALIFIED})`,
  "i",
);
const ADD_COLUMN = new RegExp(String.raw`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${IDENT})`, "i");
const NOT_A_COLUMN = /^ADD (?:CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN|EXCLUDE)\b/i;

/**
 * A migration's statements, read lexically: function bodies, comments and
 * strings set aside, whitespace folded, split at semicolons.
 */
function statementsOf(sql) {
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " $$$$ ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * What a release makes new: the tables its migrations create and the columns
 * they add, as `table` and `table.column`. Nothing the revision before it
 * runs can depend on either.
 */
function madeBy(statements) {
  const created = new Set();
  const added = new Set();
  for (const s of statements) {
    const made = s.match(CREATE_TABLE);
    if (made) created.add(unqualified(made[1]));
    const alter = s.match(ALTER_TABLE);
    if (!alter) continue;
    const table = unqualified(alter[1]);
    for (const action of actions(alter[2])) {
      const column = action.match(ADD_COLUMN);
      if (column && !NOT_A_COLUMN.test(action)) added.add(`${table}.${unqualified(column[1])}`);
    }
  }
  return { created, added };
}

/**
 * What a migration does that the revision before it may not stand: a value
 * it cannot read, a write it once made that is now refused, something it
 * reads that is gone. A new table, a new nullable or defaulted column, a
 * dropped constraint, and a constraint, index or trigger on a table the
 * release makes, or over only the columns it adds, are none of these. It
 * names what it sees; it is not a parser, and it is never a reason to skip
 * reading the migration.
 */
function sqlRisks(statements, { created, added }) {
  /** Whether every column named is one the release adds to the table. */
  const onlyNew = (table, columns) =>
    columns.length > 0 && columns.every((c) => added.has(`${table}.${c}`));

  const found = new Set();
  for (const s of statements) {
    if (/^ALTER TYPE .* ADD VALUE\b/i.test(s)) found.add("adds an enum value");
    if (/^ALTER TYPE .* RENAME\b/i.test(s)) found.add("renames something");
    if (/^DROP (?:TABLE|TYPE|VIEW|MATERIALIZED VIEW|SCHEMA)\b/i.test(s))
      found.add("drops something");

    const alter = s.match(ALTER_TABLE);
    if (alter) {
      const table = unqualified(alter[1]);
      const existing = !created.has(table);
      for (const action of actions(alter[2])) {
        if (/^DROP\b(?! CONSTRAINT\b)/i.test(action)) found.add("drops something");
        if (/^RENAME\b/i.test(action)) found.add("renames something");
        if (
          new RegExp(String.raw`^ALTER (?:COLUMN )?${IDENT} (?:SET DATA )?TYPE\b`, "i").test(action)
        ) {
          found.add("changes a column's type");
        }
        if (!existing) continue;
        if (new RegExp(String.raw`^ALTER (?:COLUMN )?${IDENT} SET NOT NULL\b`, "i").test(action)) {
          found.add("makes a column of an existing table NOT NULL");
        }
        if (
          ADD_COLUMN.test(action) &&
          !NOT_A_COLUMN.test(action) &&
          /\bNOT NULL\b/i.test(action) &&
          !/\bDEFAULT\b/i.test(action)
        ) {
          found.add("adds a NOT NULL column with no default to an existing table");
        }
        const constraint = action.match(CONSTRAINT_ACTION);
        if (constraint) {
          const kind = constraint[1].toUpperCase();
          const over =
            kind === "CHECK"
              ? [...constraint[2].matchAll(/"((?:[^"]|"")+)"/g)].map((m) => m[1])
              : identifiers(parenthesized(constraint[2]));
          if (!onlyNew(table, over)) found.add("adds a constraint to an existing table");
        }
      }
    }

    const index = s.match(
      new RegExp(
        String.raw`^CREATE UNIQUE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${IDENT} )?ON (?:ONLY )?(${QUALIFIED})`,
        "i",
      ),
    );
    if (index) {
      const table = unqualified(index[1]);
      const over = identifiers(parenthesized(s, index[0].length));
      if (!created.has(table) && !onlyNew(table, over)) {
        found.add("adds a unique index to an existing table");
      }
    }

    const trigger = s.match(
      new RegExp(
        String.raw`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER ${IDENT} .*? ON (?:ONLY )?(${QUALIFIED})`,
        "i",
      ),
    );
    if (trigger && !created.has(unqualified(trigger[1]))) {
      found.add("adds a trigger to an existing table");
    }
  }
  return [...found];
}

/** A migration directory's statements at a commit; none when it holds no migration.sql. */
function migrationAt(commit, dir) {
  const r = spawnSync("git", ["show", `${commit}:${MIGRATIONS}/${dir}/migration.sql`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? statementsOf(r.stdout) : [];
}

/**
 * A sub-list naming, for each of a release's new migrations, what its SQL was
 * seen to do that a rollback cannot stand. A table or column one of them
 * makes is new to the whole release, so the others may lean on it.
 */
function risksList(commit, dirs) {
  const read = dirs.map((dir) => [dir, migrationAt(commit, dir)]);
  const made = madeBy(read.flatMap(([, statements]) => statements));
  return read
    .map(([dir, statements]) => [dir, sqlRisks(statements, made)])
    .filter(([, risks]) => risks.length)
    .map(([dir, risks]) => `  - \`${dir}\` ${risks.join("; ")}.`);
}

// --- Measuring --------------------------------------------------------------

/**
 * How production's commit and the promoted one differ where it is risky:
 * migrations one has and the other does not, migrations both have whose
 * files differ, and anything under infra/ or .github/workflows/. Read off the
 * two commits' files, so it needs no history in common.
 */
function compare(from, to) {
  const files = lines(git("diff", "--name-only", from, to));
  const before = migrationsAt(from);
  const after = migrationsAt(to);
  const changedDirs = new Set(
    files
      .filter((f) => f.startsWith(`${MIGRATIONS}/`))
      .map((f) => f.slice(MIGRATIONS.length + 1).split("/"))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0]),
  );
  return {
    files,
    added: [...after].filter((d) => !before.has(d)).sort(),
    removed: [...before].filter((d) => !after.has(d)).sort(),
    edited: [...changedDirs].filter((d) => before.has(d) && after.has(d)).sort(),
    infra: files.filter((f) => f.startsWith("infra/")),
    workflows: files.filter((f) => f.startsWith(".github/workflows/")),
  };
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
  const changes = compare(older, newer);

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
  for (const file of changes.files) row(area(file)).files += 1;

  const log = git("log", "--no-merges", `--max-count=${limit}`, "--format=%h %s", span);
  return {
    ...changes,
    commits,
    merges,
    areas: [...areas.entries()].sort(
      ([a, x], [b, y]) => y.commits - x.commits || y.files - x.files || a.localeCompare(b),
    ),
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

/**
 * The "Look closely" section for a promotion that brings `to` where `from`
 * ran: every new migration with the rule a rollback depends on and what its
 * SQL was seen to do, any migration production applied that differs, and
 * infra/ and the workflows. Each is an annotation too.
 */
function lookClosely(c, to) {
  const look = [];
  if (c.added.length) {
    look.push(
      `- **${plural(c.added.length, "new database migration")}:** ${list(c.added)}. The revision production runs now must still read and write correctly against the schema ${agree(c.added.length, "it leaves", "they leave")} and the rows this release writes, or a rollback is not possible: a new table, or a new column that is nullable or carries a default, is safe in the release that brings it. A new enum value lands a release before any code writes it; a new constraint, NOT NULL, unique index or trigger on a table that already exists lands a release after the code that obeys it; a drop or a rename waits a release.`,
      ...risksList(to, c.added),
    );
    warn(
      "New database migrations",
      `${plural(c.added.length, "new migration")} ${agree(c.added.length, "ships", "ship")}: ${c.added.join(", ")}. The revision production runs now must still read and write correctly against the new schema.`,
    );
  }
  if (c.edited.length || c.removed.length) {
    const which = [...c.edited, ...c.removed];
    look.push(
      `- **A migration production has already applied was changed or removed:** ${list(which)}. Prisma will not apply it again; read the diff before approving.`,
    );
    warn(
      "Applied migration changed",
      `A migration production has already applied was changed or removed: ${which.join(", ")}.`,
    );
  }
  if (c.infra.length) {
    look.push(
      `- **${plural(c.infra.length, "file")} under infra/:** ${list(c.infra)}. Terraform is applied by hand and is not part of this promotion; check whether this release needs an apply first.`,
    );
    warn(
      "Infrastructure changed",
      `${plural(c.infra.length, "file")} under infra/ changed in this range; Terraform is applied by hand.`,
    );
  }
  if (c.workflows.length) {
    look.push(
      `- **${plural(c.workflows.length, "file")} under .github/workflows/:** ${list(c.workflows)}. This run follows main's copy of deploy-production.yml, whatever the commit being promoted holds.`,
    );
    warn(
      "Workflows changed",
      `${plural(c.workflows.length, "file")} under .github/workflows/ changed in this range.`,
    );
  }
  return look.length ? ["### Look closely", "", ...look, ""] : [];
}

// --- What is being promoted, and what production runs -----------------------

const sha = commitOf(positionals[0]);
if (!sha) {
  console.error(`${positionals[0]} is not a commit in this repository.`);
  process.exit(1);
}

const source = opt["running-source"];
const tag = commitOf(opt["production-tag"]);
const running = commitOf(opt.running);

const out = [`## Promoting \`${short(sha)}\` to production`, ""];
const head = [`- **Promoting:** ${describe(sha)}`];
const notes = [];

if (opt["production-tag"] && !tag) {
  notes.push(
    `The \`production\` tag names \`${opt["production-tag"].slice(0, 12)}\`, which is no commit in this repository, so nothing below is measured from it.`,
  );
  warn(
    "The production tag is not a commit here",
    `The production tag names ${opt["production-tag"].slice(0, 12)}, which this repository does not hold.`,
  );
}
if (opt.running && !running) {
  notes.push(
    `By ${source}, production runs \`${opt.running.slice(0, 12)}\`, which is no commit in this repository, so nothing below is measured from it.`,
  );
  warn(
    "What production runs is not a commit here",
    `By ${source}, production runs ${opt.running.slice(0, 12)}, which this repository does not hold.`,
  );
}

// What serves is what is measured from; the tag only when the service names
// no commit here.
let previous = null;
if (running) {
  previous = running;
  const besides = !opt["production-tag"]
    ? " (there is no `production` tag yet; this promotion sets it)"
    : tag === running
      ? ", which the `production` tag names too"
      : "";
  head.push(`- **Production runs:** ${describe(running)}, per ${source}${besides}`);
  if (tag && tag !== running) {
    head.push(`- **The \`production\` tag:** ${describe(tag)}`);
    notes.push(
      `The \`production\` tag says ${describe(tag)}, but ${source} says ${describe(running)}. Everything below is measured from what production says it runs. A tag that is not what production runs means a deploy that failed after it took traffic, a tag the last promotion could not move, or traffic sent back by hand; this promotion moves it when it succeeds.`,
    );
    warn(
      "The production tag is not what production runs",
      `The production tag is ${short(tag)}, but ${source} says ${short(running)}; the summary measures from ${short(running)}.`,
    );
  }
} else if (tag) {
  previous = tag;
  head.push(
    `- **Production runs:** ${describe(tag)}, per the \`production\` tag; the service named no commit here to check it against`,
  );
} else {
  const why = opt["production-tag"]
    ? "The `production` tag is no commit here, and the service named none"
    : "There is no `production` tag yet, and the service named no commit here";
  head.push(`- **Production runs:** not known here. ${why}; this promotion sets the tag.`);
  warn(
    "What production runs is not known",
    "Nothing here says what production runs, so nothing can say which commits ship. The summary lists the last commits instead.",
  );
}

if (opt["api-image"]) head.push(`- **API image:** \`${opt["api-image"]}\``);
if (opt["servicing-image"]) {
  const now = opt["servicing-running"];
  let versus = "";
  if (now === opt["servicing-image"]) versus = ", the one production runs today";
  else if (now) {
    versus = `, replacing \`${now}\``;
    // A new servicing image is not by itself a change to the servicing app: a
    // staging push rebuilds it when the lockfile, deploy.yml or the test
    // database script changes too.
    if (
      previous &&
      previous !== sha &&
      !lines(git("diff", "--name-only", previous, sha, "--", "apps/servicing")).length
    ) {
      versus +=
        ". Nothing under apps/servicing differs between production's commit and this one: a staging push rebuilds that image when the lockfile, deploy.yml or scripts/test-database-url.mjs changes too.";
    }
  }
  head.push(`- **Servicing image:** \`${opt["servicing-image"]}\`${versus}`);
}

const base = previous && previous !== sha ? mergeBase(previous, sha) : null;
if (opt.repository && base) {
  // What ships, or on a rollback what leaves: the compare's three dots show
  // the second commit's changes since the two parted.
  const [from, to] = isAncestor(sha, previous) ? [sha, previous] : [previous, sha];
  head.push(`- **Compare:** ${opt.repository}/compare/${short(from)}...${short(to)}`);
}

out.push(...head, "");
for (const note of notes) out.push(`> ${note}`, "");

// --- The range -------------------------------------------------------------

const lastCommits = () => [
  `### The last ${FALLBACK_COUNT} commits up to this one`,
  "",
  fenced(git("log", "--no-merges", `--max-count=${FALLBACK_COUNT}`, "--format=%h %s", sha)),
];

if (!previous) {
  out.push(
    "Nothing below is measured against production, because nothing here says what production runs.",
    "",
    ...lastCommits(),
  );
} else if (previous === sha) {
  out.push("**Production already runs this commit.** This is a redeploy, and nothing new ships.");
} else if (base === previous) {
  const m = measure(previous, sha);
  const besides = m.merges ? `, besides ${plural(m.merges, "merge")}` : "";
  out.push(
    `**${plural(m.commits, "commit")} ${agree(m.commits, "ships", "ship")}**${besides}, changing ${plural(m.files.length, "file")} in ${plural(m.areas.length, "area")}.`,
    "",
    ...lookClosely(m, sha),
    "### Areas touched",
    "",
    areasTable(m),
    "",
    "### Commits",
    "",
    commitList(m),
  );
} else if (base === sha) {
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
      `- **${plural(m.added.length, "migration")} production has applied ${agree(m.added.length, "stays", "stay")} applied:** ${list(m.added)}. The database is not rolled back: this older revision runs against the schema as it stands and the rows the newer release wrote. That holds only if each one let the revision before it read and write correctly: no enum value it was never built for, no constraint, NOT NULL or trigger it does not obey, nothing it reads dropped or renamed.`,
      ...risksList(previous, m.added),
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
} else if (base) {
  const m = measure(base, sha);
  const gone = Number(git("rev-list", "--count", "--no-merges", `${sha}..${previous}`));
  out.push(
    `**Production's commit is not on this commit's line.** They part at ${describe(base)}: ${plural(gone, "commit")} production runs ${agree(gone, "is", "are")} not in this one, and ${plural(m.commits, "commit")} here ${agree(m.commits, "is", "are")} not in production. "Look closely" compares production's commit with this one directly; the areas and commits below are what this commit adds since they parted.`,
    "",
    ...lookClosely(compare(previous, sha), sha),
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
} else {
  out.push(
    `**Production's commit shares no history with this one.** ${describe(previous)} is not on main's line at all, as after main's history is rewritten. No range can be measured; "Look closely" compares production's commit with this one directly, and the last ${FALLBACK_COUNT} commits up to this one are listed.`,
    "",
    ...lookClosely(compare(previous, sha), sha),
    ...lastCommits(),
  );
  warn(
    "Production shares no history with this commit",
    `Production's commit ${short(previous)} and ${short(sha)} have no common ancestor.`,
  );
}

process.stdout.write(`${out.join("\n")}\n`);
