#!/usr/bin/env node
/**
 * Build the environments for a browser.
 *
 *   npm run env:playground -w @hm/environments
 *
 * Three files land in `playground/dist/`, which git ignores, and together
 * they are the site: `index.html` copied from `playground/`, and these two.
 * `npm run env:gym` builds it and serves it at http://localhost:8765.
 *
 * - `environments.js`: `playground/entry.ts` bundled by esbuild as one
 *   minified IIFE that sets `globalThis.HMEnvironments`. The workspace
 *   packages are read from their source, so no `tsc -b` has to run first,
 *   and `node:crypto`, `node:fs` and `node:path` are `playground/shims/`.
 *   Any other `node:` import, or any module only the CLI needs (the model
 *   clients, the archive, the comparison, the audit's command line), stops
 *   the build: a page that loads it would break where nobody is watching.
 *
 * - `runs.json`: the model episodes recorded under `runs/`, on the TRAIN
 *   split only. A held-out record is what a reported score rests on and a
 *   spec record is not a model's training material, so neither is ever
 *   read past its split; the reference policy's own runs are left out too.
 *   A split label is not enough: a train id whose stream a held-out task
 *   draws from is that task (`src/heldout-guard.ts`), so every record is
 *   held to the bundle's own guard, and one that fails it is left out.
 *   For each environment and policy only the newest version that was run is
 *   kept, one episode per task, the newest; the file is held under 6 MB.
 *
 * The bundle is loaded once, in a context holding only the browser globals
 * it uses, before any run is read: a bundle that needs Node fails here.
 */

import { build } from "esbuild";
import { webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = resolve(pkg, "..");
const out = join(pkg, "playground", "dist");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/* ── the bundle ─────────────────────────────────────────────────────────── */

/** Every bare import the environments make, read from source. */
const SOURCES = {
  "@hm/kernel/money": join(packages, "kernel/src/kernel/money/index.ts"),
  "@hm/kernel/calendar": join(packages, "kernel/src/kernel/calendar/index.ts"),
  "@hm/kernel/fsm": join(packages, "kernel/src/kernel/fsm/index.ts"),
  "@hm/kernel/events": join(packages, "kernel/src/kernel/events/index.ts"),
  "@hm/refi-review": join(packages, "refi-review/src/index.ts"),
  "@hm/underwriting": join(packages, "underwriting/src/index.ts"),
  "@hm/shared": join(packages, "shared/src/index.ts"),
  "node:crypto": join(pkg, "playground/shims/node-crypto.ts"),
  "node:fs": join(pkg, "playground/shims/node-fs.ts"),
  "node:path": join(pkg, "playground/shims/node-path.ts"),
};

/**
 * What only the CLI imports, as the metafile names it (relative to this
 * package), and anything from node_modules: the environments need none of
 * it, and reaching any of it from the entry is a defect.
 */
const NODE_ONLY = [
  /^src\/cli\.ts$/,
  /^src\/anthropic\.ts$/,
  /^src\/vertex\.ts$/,
  /^src\/anthropic-vertex\.ts$/,
  /^src\/archive[^/]*\.ts$/,
  /^src\/compare[^/]*\.ts$/,
  /^src\/audit-cli\.ts$/,
  /^src\/index\.ts$/,
  /node_modules\//,
];

const sources = {
  name: "workspace-sources",
  setup(b) {
    b.onResolve({ filter: /^(@hm\/|node:)/ }, (args) => {
      const path = SOURCES[args.path];
      if (path) return { path };
      return {
        errors: [
          {
            text: `${args.path} has no browser source or shim; add one to build-playground.mjs, or keep it out of the playground's imports`,
          },
        ],
      };
    });
  },
};

mkdirSync(out, { recursive: true });
const bundlePath = join(out, "environments.js");
const result = await build({
  absWorkingDir: pkg,
  entryPoints: [join(pkg, "playground/entry.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  charset: "utf8",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [sources],
});

const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((p) => NODE_ONLY.some((re) => re.test(p)));
if (forbidden.length > 0) {
  console.error(`the bundle reached modules only the CLI may load:\n  ${forbidden.join("\n  ")}`);
  process.exit(1);
}
const bundle = readFileSync(bundlePath);
console.log(
  `${relative(pkg, bundlePath)}: ${kb(bundle.length)} (${kb(gzipSync(bundle).length)} gzipped), ${inputs.length} modules`,
);

/** The bundle as a page loads it: the browser globals it reaches for, and nothing of Node's. */
const page = vm.createContext({
  crypto: { randomUUID: () => webcrypto.randomUUID() },
  TextEncoder,
  console,
  setTimeout,
  clearTimeout,
});
vm.runInContext(bundle.toString("utf8"), page, { filename: "environments.js" });
const HM = page.HMEnvironments;
if (!HM?.environments?.length || typeof HM.drawsHeldoutStream !== "function")
  throw new Error("environments.js did not set HMEnvironments in a browser-like context");

/* ── the runs ───────────────────────────────────────────────────────────── */

const MAX_BYTES = 6 * 1024 * 1024;
const MODEL_POLICY = /^(anthropic|anthropic-vertex|vertex):/;

const jsonlFiles = (dir) => {
  let found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found = found.concat(jsonlFiles(path));
    else if (name.endsWith(".jsonl")) found.push(path);
  }
  return found;
};

/** A record's task is on the train split by every field it carries, or it is not kept. */
const onTrain = (r) =>
  r?.task?.split === "train" &&
  typeof r.task.id === "string" &&
  r.task.id.split("/")[2] === "train" &&
  !/heldout|\/spec\//.test(r.task.id);

/** A held-out task under a train label: its stream is one a held-out task draws from. */
const heldoutStream = (r) => HM.drawsHeldoutStream(r.task.id);

const compareVersions = (a, b) => {
  const pa = a.split(/[.+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
};

/** What the page reads of a record: the task, the outcome and the transcript, nothing it does not show. */
const slim = (r) => ({
  env: { name: r.environment.name, version: r.environment.version },
  run_id: r.run_id,
  policy: r.policy.id,
  task: {
    id: r.task.id,
    split: r.task.split,
    suite_seed: r.task.suite_seed,
    index: r.task.index,
    rendered: r.task.rendered,
  },
  result: {
    outcome: r.result.outcome,
    pass: r.result.grade.pass,
    score: r.result.grade.score,
    turns: r.result.turns,
    tool_calls: r.result.tool_calls,
    usage: r.result.usage,
    error: r.result.error,
    finished_at: r.result.finished_at,
    fields: r.result.grade.fields,
  },
  transcript: r.result.transcript.map((e) =>
    e.kind === "turn"
      ? {
          kind: "turn",
          turn: e.turn,
          text: e.text,
          stop: e.stop,
          ms: e.ms,
          calls: e.calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
        }
      : {
          kind: "observations",
          turn: e.turn,
          observations: e.observations.map((o) => ({
            call_id: o.call_id,
            content: o.content,
            is_error: o.is_error,
          })),
        },
  ),
});

let read = 0;
let unreadable = 0;
const skipped = { heldout: 0, spec: 0, stream: 0, reference: 0, other: 0 };
/** env → policy → { version, byTask: task id → record } */
const kept = new Map();
for (const file of jsonlFiles(join(pkg, "runs")).sort()) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      unreadable += 1; // a run still being written ends mid-line
      continue;
    }
    read += 1;
    const split = r?.task?.split;
    if (split === "heldout" || split === "spec") {
      skipped[split] += 1;
      continue;
    }
    if (!onTrain(r) || !r.environment || !r.result?.grade) {
      skipped.other += 1;
      continue;
    }
    if (heldoutStream(r)) {
      skipped.stream += 1;
      continue;
    }
    if (!MODEL_POLICY.test(r.policy?.id ?? "")) {
      skipped.reference += 1;
      continue;
    }
    const env = r.environment.name;
    const byPolicy = kept.get(env) ?? new Map();
    kept.set(env, byPolicy);
    const now = byPolicy.get(r.policy.id);
    const order = now ? compareVersions(r.environment.version, now.version) : 1;
    if (order < 0) continue;
    const slot = order > 0 ? { version: r.environment.version, byTask: new Map() } : now;
    byPolicy.set(r.policy.id, slot);
    const was = slot.byTask.get(r.task.id);
    if (!was || r.result.finished_at >= was.result.finished_at) slot.byTask.set(r.task.id, slim(r));
  }
}

let records = [];
for (const [, byPolicy] of [...kept].sort(([a], [b]) => a.localeCompare(b)))
  for (const [, slot] of [...byPolicy].sort(([a], [b]) => a.localeCompare(b)))
    records.push(
      ...[...slot.byTask.values()].sort(
        (a, b) => a.task.suite_seed - b.task.suite_seed || a.task.index - b.task.index,
      ),
    );

const document = (rs) => ({
  built_at: new Date().toISOString(),
  about:
    "Model episodes on the train split, from packages/environments/runs. Held-out and spec records are never included, nor the reference policy's, nor a train record whose task draws from a held-out task's stream. For each environment and policy, the newest version run, one episode per task (the newest).",
  records: rs,
});
let text = JSON.stringify(document(records));
let dropped = 0;
while (Buffer.byteLength(text) > MAX_BYTES && records.length > 0) {
  // Over the cap: the oldest episode goes first.
  const oldest = records.reduce(
    (o, r, i) => (r.result.finished_at < records[o].result.finished_at ? i : o),
    0,
  );
  records = records.filter((_, i) => i !== oldest);
  dropped += 1;
  text = JSON.stringify(document(records));
}
if (records.some((r) => r.task.split !== "train" || !onTrain(r) || heldoutStream(r)))
  throw new Error("a record that is not a training task reached runs.json");
const runsPath = join(out, "runs.json");
writeFileSync(runsPath, text);

const counts = new Map();
for (const r of records) {
  const k = `${r.env.name} ${r.env.version}  ${r.policy}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
console.log(
  `${relative(pkg, runsPath)}: ${kb(Buffer.byteLength(text))}, ${records.length} episodes of ${read} read (left out: ${skipped.heldout} held-out, ${skipped.spec} spec, ${skipped.stream} on a held-out stream, ${skipped.reference} reference, ${skipped.other} other, ${unreadable} unreadable lines${dropped ? `, ${dropped} over the cap` : ""})`,
);
for (const [k, n] of counts) console.log(`  ${k}: ${n}`);

// The page beside the two files it loads, so dist/ is the whole site. The
// source is written for the Artifact host, which wraps it in a document with
// a charset and a viewport; served from disk it gets the same wrapping here,
// or every middle dot and ≤ reads as mojibake.
const SKELETON =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  "</head>\n<body>\n";
writeFileSync(
  join(out, "index.html"),
  SKELETON + readFileSync(join(pkg, "playground", "index.html"), "utf8") + "\n</body>\n</html>\n",
);
console.log(`${relative(pkg, join(out, "index.html"))}: copied`);
