#!/usr/bin/env node
/**
 * Build the first demo's page.
 *
 *   npm run env:demo -w @hm/environments            # writes playground/dist/demo.html
 *   node scripts/build-demo.mjs --out <file.html>   # anywhere else
 *
 * One self-contained page, its data inlined, computed from the code on disk
 * and never by hand: `src/demo/page-data.ts` is bundled by esbuild from the
 * workspace's sources (as the playground's bundle is, so no `tsc -b` has to
 * run first), run in this process, and its result filled into
 * `playground/demo/template.html`. The data is the demo loan's two histories
 * (src/life/demo.ts), the m3-v1 tape rows the tape writer writes for it, the
 * three moments as boarding-triage, catchup-posting and escrow-review pose
 * them, two of its calls as the contact center writes them, what the defects
 * cost on the defective twin, and a book of 1,000
 * loans drawn from calibration.json and read against
 * calibration-acceptance.json. The same code gives the same page, byte for
 * byte: nothing reads a clock.
 *
 * Before writing, the page is checked the way a reader would break it:
 * its script must parse, and its rendering must run to the end against a
 * minimal DOM for every view (`playground/demo/check-page.mjs`).
 *
 * The page is written for the Artifact host, which wraps a page in a
 * document; served from disk it gets the same wrapping here, as the
 * playground's index.html does.
 */

import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSyntax, extractDemo, smokeDemoPage } from "../playground/demo/check-page.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = resolve(pkg, "..");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const outPath =
  at >= 0 ? resolve(args[at + 1] ?? "") : join(pkg, "playground", "dist", "demo.html");
if (at >= 0 && !args[at + 1]) throw new Error("--out needs a file");

/* ── the data, computed by the package's own code ──────────────────────── */

/** Every workspace import the page's data reaches, read from source. */
const SOURCES = {
  "@hm/kernel/money": join(packages, "kernel/src/kernel/money/index.ts"),
  "@hm/kernel/calendar": join(packages, "kernel/src/kernel/calendar/index.ts"),
  "@hm/kernel/fsm": join(packages, "kernel/src/kernel/fsm/index.ts"),
  "@hm/kernel/events": join(packages, "kernel/src/kernel/events/index.ts"),
  "@hm/refi-review": join(packages, "refi-review/src/index.ts"),
  "@hm/underwriting": join(packages, "underwriting/src/index.ts"),
  "@hm/shared": join(packages, "shared/src/index.ts"),
};

const workspace = {
  name: "workspace-sources",
  setup(b) {
    b.onResolve({ filter: /^@hm\// }, (a) => {
      const path = SOURCES[a.path];
      if (path) return { path };
      return {
        errors: [
          {
            text: `${a.path} has no source in build-demo.mjs; add one, or keep it out of src/demo`,
          },
        ],
      };
    });
  },
};

const started = Date.now();
const bundled = await build({
  absWorkingDir: pkg,
  entryPoints: [join(pkg, "src/demo/page-data.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "warning",
  plugins: [workspace],
});
const scratch = mkdtempSync(join(tmpdir(), "build-demo-"));
let data;
try {
  const modPath = join(scratch, "page-data.mjs");
  writeFileSync(modPath, bundled.outputFiles[0].text);
  const { demoPageData } = await import(pathToFileURL(modPath).href);
  const calibrationFile = JSON.parse(readFileSync(join(pkg, "src/life/calibration.json"), "utf8"));
  const acceptance = JSON.parse(
    readFileSync(join(pkg, "src/life/calibration-acceptance.json"), "utf8"),
  );
  data = demoPageData({ calibrationFile, acceptance });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/* ── the page ───────────────────────────────────────────────────────────── */

const template = readFileSync(join(pkg, "playground", "demo", "template.html"), "utf8");
const PLACEHOLDER = "__DEMO_DATA__";
if (template.split(PLACEHOLDER).length !== 2)
  throw new Error(`the template must hold ${PLACEHOLDER} exactly once`);
// Inside a script element nothing may close it: every "<" is written as its escape, and so are the two line
// separators JSON allows and older JavaScript does not.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const json = JSON.stringify(data)
  .replace(/</g, "\\u003c")
  .split(LS)
  .join("\\u2028")
  .split(PS)
  .join("\\u2029");
const body = template.replace(PLACEHOLDER, () => json);
const title = /^<title>[^<]*<\/title>\n?/.exec(body);
if (!title) throw new Error("the template must open with its <title>");
const page =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  title[0].trimEnd() +
  "\n</head>\n<body>\n" +
  body.slice(title[0].length) +
  "\n</body>\n</html>\n";

/* ── the checks, then the file ──────────────────────────────────────────── */

const extracted = extractDemo(page);
if (JSON.stringify(extracted.data) !== JSON.stringify(data))
  throw new Error("the page's data does not read back as written");
checkSyntax(extracted.script);
const smoke = smokeDemoPage(page);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, page);
const twin = data.twins.defective;
console.log(
  `${relative(process.cwd(), outPath) || outPath}: ${kb(Buffer.byteLength(page))}, built in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
console.log(
  `  demo loan ${data.loan.servicer_loan_number}: ${twin.months.length} months, ${twin.label_count} labels on the defective twin; moments ${data.moments.map((m) => `${m.id} ${m.on}`).join(", ")}`,
);
console.log(
  `  book: ${data.book.loans} loans, ${data.book.passed} tests within, ${data.book.failed} outside, ${data.book.unmeasured} not a verdict`,
);
console.log(
  `  checked: the script parses; ${smoke.views} views rendered and ${smoke.pressed} buttons pressed against a stub DOM`,
);
