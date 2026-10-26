#!/usr/bin/env node
/**
 * Commit the held-out counts the Gym shows inside the ops console.
 *
 *   npm run env:playground -w @hm/environments     # gathers playground/dist/scores.json from runs/
 *   npm run env:gym-snapshot -w @hm/environments   # copies it to playground/snapshot/scores.json
 *
 * The API image builds the page and the bundle from source and has no
 * `runs/` to count, so the scores it serves beside them are this snapshot,
 * committed. It holds counts and nothing else: for each environment, version
 * and model, how many held-out tasks were scored and passed, how many could
 * not be scored, the tokens spent, and when the newest finished. No task id,
 * prompt, answer or transcript, which is what this script checks before it
 * writes, and what `playground.test.ts` checks of the committed file.
 *
 * It refuses a file with no scores: that is a build from a checkout with no
 * `runs/`, and writing it would wipe the snapshot rather than refresh it.
 * Model transcripts (`runs.json`) are never committed; see docs/decisions.md,
 * "The Gym is in the ops console, without its recorded attempts".
 *
 * `--from <file>` reads another build's scores.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { from: { type: "string" } } });
const from = args.from ? resolve(args.from) : join(pkg, "playground", "dist", "scores.json");
const to = join(pkg, "playground", "snapshot", "scores.json");

/** A score's fields, in the order the build writes them. */
const SCORE_KEYS = [
  "env",
  "version",
  "policy",
  "scored",
  "passed",
  "unscored",
  "usage",
  "last_finished_at",
];
const USAGE_KEYS = [
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens",
  "output_tokens",
];
const same = (a, b) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const count = (n) => Number.isInteger(n) && n >= 0;

function fail(message) {
  console.error(`env:gym-snapshot: ${message}; nothing written`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(from, "utf8");
} catch {
  fail(`${from} could not be read; run npm run env:playground -w @hm/environments first`);
}
// The build's own refusal, again: no held-out or train task id, and no text of a task.
if (/\/heldout\/|\/train\/|"rendered"|"transcript"|"fields"|"id"/.test(text))
  fail(`${from} carries a task id or a task's text`);
let doc;
try {
  doc = JSON.parse(text);
} catch {
  fail(`${from} is not JSON`);
}
if (!doc || typeof doc !== "object" || !Array.isArray(doc.scores))
  fail("there is no list of scores");
if (doc.scores.length === 0)
  fail(
    "the list of scores is empty, as a build with no runs/ writes it, and would wipe the snapshot",
  );
for (const x of doc.scores) {
  const where = `${x?.env} ${x?.version} ${x?.policy}`;
  if (!same(Object.keys(x), SCORE_KEYS)) fail(`${where} has fields other than counts`);
  if (![x.env, x.version, x.policy].every((s) => typeof s === "string"))
    fail(`${where} names itself oddly`);
  if (!count(x.scored) || !count(x.passed) || !count(x.unscored) || x.passed > x.scored)
    fail(`${where} has counts that do not add up`);
  if (!same(Object.keys(x.usage ?? {}), USAGE_KEYS) || !USAGE_KEYS.every((k) => count(x.usage[k])))
    fail(`${where} has a usage that is not four token counts`);
  if (x.last_finished_at !== null && Number.isNaN(Date.parse(x.last_finished_at)))
    fail(`${where} has a finishing time that is not one`);
}

const snapshot = {
  built_at: typeof doc.built_at === "string" ? doc.built_at : null,
  about: typeof doc.about === "string" ? doc.about : "",
  scores: doc.scores.map((x) => Object.fromEntries(SCORE_KEYS.map((k) => [k, x[k]]))),
};
mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `${relative(pkg, to)}: ${snapshot.scores.length} suites, gathered ${snapshot.built_at ?? "at an unknown time"}`,
);
