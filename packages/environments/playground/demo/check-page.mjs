/**
 * Checks on a built demo page, without a browser: its data parses, its script
 * parses, and its rendering runs to the end against a minimal DOM for every
 * view the page offers (each history, each year, each month, the monthly
 * premium shown and hidden), with every button it draws pressed once, and
 * each history's calls show the notes and statement lines their data holds.
 *
 * The DOM is the least the page uses: createElement, createTextNode,
 * getElementById, append, replaceChildren, setAttribute, addEventListener
 * and textContent. Anything else the page reaches for is undefined here and
 * throws, which is the point: a page that needs more fails this check before
 * it fails a reader. `scripts/build-demo.mjs` runs it on every build, and
 * the demo page's test runs it again.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const DATA_TAG = /<script type="application\/json" id="demo-data">([\s\S]*?)<\/script>/;
const SCRIPT_TAG = /<script>\n([\s\S]*?)<\/script>/;

/** The page's inlined data and its script. */
export function extractDemo(html) {
  const data = DATA_TAG.exec(html);
  const script = SCRIPT_TAG.exec(html);
  if (!data) throw new Error("the page has no demo-data block");
  if (!script) throw new Error("the page has no script");
  return { json: data[1], data: JSON.parse(data[1]), script: script[1] };
}

/** `node --check` on the page's script: a syntax error is a build failure, not a blank page. */
export function checkSyntax(script) {
  const dir = mkdtempSync(join(tmpdir(), "demo-page-"));
  try {
    const file = join(dir, "page.js");
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`the page's script does not parse:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this._text = "";
  }
  append(...kids) {
    for (const k of kids) {
      if (k === null || k === undefined) throw new Error(`append(${k}) on <${this.tagName}>`);
      if (typeof k === "string") this.children.push(new Text(k));
      else if (k instanceof Node || k instanceof Text) this.children.push(k);
      else throw new Error(`append of a ${typeof k} on <${this.tagName}>`);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this._text = "";
    this.append(...kids);
  }
  setAttribute(k, v) {
    if (typeof v !== "string") throw new Error(`setAttribute(${k}) with a ${typeof v}`);
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  addEventListener(type, fn) {
    if (typeof fn !== "function") throw new Error(`addEventListener(${type}) without a function`);
    (this.listeners[type] ??= []).push(fn);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  /** Every node under this one, this one first. */
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof Node) yield* c.walk();
  }
}
class Text {
  constructor(t) {
    this.textContent = String(t);
  }
}

/**
 * Run the page's script against the stub, then every view, then every button
 * of the first view. Returns what it did, for a test to read.
 */
export function smokeDemoPage(html) {
  const { json, script } = extractDemo(html);
  const byId = new Map();
  const document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => {
      if (id === "demo-data") return { textContent: json };
      if (!byId.has(id)) byId.set(id, new Node("div"));
      return byId.get(id);
    },
  };
  const context = vm.createContext({ document, console });
  context.globalThis = context;
  vm.runInContext(script, context, { filename: "demo.html script" });
  const page = context.DemoPage;
  if (!page || typeof page.go !== "function")
    throw new Error("the page did not expose DemoPage.go");
  const data = JSON.parse(json);

  let views = 0;
  // The three lanes, and the contact center's calls below them, which follow the history chosen.
  const lanes = ["lane-system", "lane-tape", "lane-moments", "calls"];
  const rendered = () => {
    views += 1;
    for (const id of lanes)
      if (document.getElementById(id).children.length === 0)
        throw new Error(`${id} rendered nothing`);
  };
  for (const twin of page.twins)
    for (const year of page.years) {
      page.go({ twin, year, month: null });
      rendered();
      for (const m of data.twins[twin].months.filter((x) => x.month.startsWith(year))) {
        page.go({ month: m.month });
        rendered();
      }
    }
  for (const quiet of [true, false]) {
    page.go({ quiet });
    rendered();
  }

  // The calls show what their data holds: every statement line the escrow call read, and each call's note.
  for (const twin of page.twins) {
    page.go({ twin });
    const shown = document.getElementById("calls").textContent;
    const c = data.contacts.twins[twin];
    const wanted = [c.promise, c.escrow].flatMap((x) =>
      "id" in x
        ? [
            ...(x.note ? [x.note.text] : []),
            ...(x.statement ? x.statement.lines.map((l) => l.text) : []),
            ...(x.statement?.low ? [x.statement.low.text] : []),
          ]
        : [x.missing],
    );
    for (const w of wanted)
      if (!shown.includes(w)) throw new Error(`the ${twin} calls do not show: ${w}`);
  }

  // Every button and link of the first view, pressed once, then the view put back.
  page.go({ twin: "defective", year: page.years[0], month: null });
  let pressed = 0;
  const roots = ["loan", "controls", ...lanes, "harm", "book"].map((id) =>
    document.getElementById(id),
  );
  const handlers = [];
  for (const root of roots)
    for (const n of root.walk()) for (const fn of n.listeners.click ?? []) handlers.push(fn);
  for (const fn of handlers) {
    fn({ preventDefault() {} });
    pressed += 1;
  }
  return { views, pressed, years: page.years.length };
}
