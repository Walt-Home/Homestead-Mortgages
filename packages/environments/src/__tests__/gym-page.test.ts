/**
 * The Gym's page renders whether or not recorded attempts are beside it.
 *
 * The copy served inside the ops console (`apps/api/src/routes/console-gym.ts`)
 * has no `runs.json`: model transcripts are not committed, so its build
 * carries none, and the request for them is a 404. The page has to read that
 * as a build without recorded attempts — and say so, and say where they are —
 * while everything else on it works; and the claude.ai build, which carries
 * them, has to keep showing them.
 *
 * No browser: the page is built as the image builds it
 * (`build-playground.mjs --site-only`), its bundle and its one inline script
 * run in a context holding a small DOM made from the page's own markup, and
 * `fetch` answers `scores.json` with the committed snapshot and `runs.json`
 * as each case says. The DOM is the least the page reaches for at load;
 * anything else it calls is undefined here and throws.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SNAPSHOT = here("../../playground/snapshot/scores.json");
const RUNS_PAGE = "https://claude.ai/artifact/LKEDiyPJyoQ4UwijqwpNw6";

/* ── a small DOM ─────────────────────────────────────────────────────────── */

class Node {
  parent: El | null = null;
  get textContent(): string {
    return "";
  }
}
class Text extends Node {
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
}
const VOID = new Set(["input", "br", "img", "meta", "hr", "link", "path"]);
class El extends Node {
  readonly tagName: string;
  children: Node[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  hidden = false;
  value = "";
  disabled = false;
  checked = false;
  tabIndex = 0;
  scrollTop = 0;
  scrollHeight = 0;
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get id(): string {
    return this.attributes.id ?? "";
  }
  set id(v: string) {
    this.attributes.id = v;
  }
  get className(): string {
    return this.attributes.class ?? "";
  }
  set className(v: string) {
    this.attributes.class = String(v);
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        this.className = [...list().filter((x) => x !== c), ...(on ? [c] : [])].join(" ");
        return on;
      },
    };
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(String(v));
  }
  get firstChild(): Node | null {
    return this.children[0] ?? null;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) {
      if (k instanceof Node) {
        if (k.parent) k.parent.removeChild(k);
        k.parent = this;
        this.children.push(k);
      } else if (typeof k === "string") {
        const t = new Text(k);
        t.parent = this;
        this.children.push(t);
      } else throw new Error(`append of a ${typeof k} on <${this.tagName}>`);
    }
  }
  appendChild(k: Node): Node {
    this.append(k);
    return k;
  }
  removeChild(k: Node): Node {
    const i = this.children.indexOf(k);
    if (i < 0) throw new Error("removeChild of a node that is not a child");
    this.children.splice(i, 1);
    k.parent = null;
    return k;
  }
  replaceChildren(...kids: unknown[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...kids);
  }
  setAttribute(k: string, v: string): void {
    if (typeof v !== "string") throw new Error(`setAttribute(${k}) with a ${typeof v}`);
    this.attributes[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attributes[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attributes[k];
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (typeof fn !== "function") throw new Error(`addEventListener(${type}) without a function`);
    (this.listeners[type] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn({ preventDefault() {}, target: this });
  }
  focus(): void {}
  select(): void {}
  scrollIntoView(): void {}
  *walk(): Generator<El> {
    for (const c of this.children)
      if (c instanceof El) {
        yield c;
        yield* c.walk();
      }
  }
  /** `tag, tag` or `.class`: what the page asks for. */
  querySelectorAll(selector: string): El[] {
    const parts = selector.split(",").map((s) => s.trim());
    return [...this.walk()].filter((el) =>
      parts.some((p) =>
        p.startsWith(".") ? el.classList.contains(p.slice(1)) : el.tagName === p.toUpperCase(),
      ),
    );
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** The page's markup as a tree: its elements, their attributes and their text. */
function parseMarkup(html: string): El {
  const body = new El("body");
  const stack: El[] = [body];
  const tokens =
    /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  for (const m of html.matchAll(tokens)) {
    const top = stack[stack.length - 1]!;
    if (m[1]) {
      if (top.tagName !== m[1].toUpperCase()) throw new Error(`</${m[1]}> closes <${top.tagName}>`);
      stack.pop();
    } else if (m[2]) {
      const el = new El(m[2]);
      for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g))
        el.attributes[a[1]!] = a[2] ?? "";
      if ("hidden" in el.attributes) el.hidden = true;
      top.append(el);
      if (!VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[4] && m[4].trim()) top.append(m[4]);
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1)!.tagName}> is never closed`);
  return body;
}

/* ── the page, loaded ────────────────────────────────────────────────────── */

let dir = "";
let html = "";
let bundle = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gym-page-"));
  const r = spawnSync(
    process.execPath,
    [here("../../scripts/build-playground.mjs"), "--site-only", "--out", dir],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`build-playground.mjs failed:\n${r.stdout}\n${r.stderr}`);
  html = readFileSync(join(dir, "index.html"), "utf8");
  bundle = readFileSync(join(dir, "environments.js"), "utf8");
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type RunsAnswer = { status: 404 } | { status: 500 } | { status: 200; body: unknown };

interface Loaded {
  body: El;
  byId: (id: string) => El;
  state: () => {
    current: string;
    runs: { status: string; records: unknown[]; error: string | null };
  };
  errors: unknown[];
}

/** Load the page as a browser would, with `runs.json` answered as given. */
async function load(runs: RunsAnswer): Promise<Loaded> {
  const markup = html.slice(html.indexOf("</style>") + "</style>".length, html.indexOf("<script"));
  const body = parseMarkup(markup);
  const byId = (id: string) => {
    const el = [...body.walk()].find((e) => e.id === id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  };
  const errors: unknown[] = [];
  const answer = (status: number, json: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => json });
  const fetch = (url: string) => {
    if (url === "scores.json") return answer(200, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    if (url === "runs.json") return answer(runs.status, "body" in runs ? runs.body : null);
    return answer(404, null);
  };
  const storage = new Map<string, string>();
  const window: Record<string, unknown> = {
    location: { hash: "" },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        (window.location as { hash: string }).hash = url;
      },
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  };
  const document = {
    getElementById: (id: string) => [...body.walk()].find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    createRange: () => ({ selectNodeContents() {} }),
    activeElement: null,
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch,
    Node,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    TextEncoder,
    console: { ...console, error: (...a: unknown[]) => errors.push(a) },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(bundle, context, { filename: "environments.js" });
  window.HMEnvironments = context.HMEnvironments;
  const script = /<script>\n?([\s\S]*?)<\/script>/.exec(html)![1]!;
  vm.runInContext(script, context, { filename: "index.html" });
  // The two fetches and their renders.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const gym = window.HMGym as { state: Loaded["state"] };
  return { body, byId, state: gym.state, errors };
}

const links = (el: El) => [...el.walk()].filter((e) => e.tagName === "A");

describe("the Gym's page", () => {
  it("renders without runs.json, and says the build carries no recorded attempts and where they are", async () => {
    const page = await load({ status: 404 });
    expect(page.errors).toEqual([]);
    expect(page.state().runs.status).toBe("absent");
    expect(page.byId("fatal").hidden).toBe(true);

    // Everything else works: the overview, a task drawn, the held-out counts from the snapshot.
    expect(page.byId("sides").children.length).toBeGreaterThan(0);
    expect(page.byId("sides").textContent).toContain("Held-out score");
    expect(page.byId("task-before").textContent.length).toBeGreaterThan(40);
    expect(page.byId("rules-text").textContent.length).toBeGreaterThan(1000);
    expect(page.state().current).toBe("refi-review");

    // Where the attempts would show: the tab, the overview's note and the footer.
    const attempts = page.byId("att-body");
    expect(attempts.textContent).toContain("This build carries no recorded attempts.");
    expect(attempts.textContent).toContain("They are on the Gym's claude.ai page.");
    expect(page.byId("overview-note").textContent).toContain(
      "This build carries no recorded attempts on training tasks.",
    );
    expect(page.byId("foot-runs").textContent).toContain("This build carries no recorded attempts");
    for (const where of ["att-body", "overview-note", "foot-runs"]) {
      const [a] = links(page.byId(where));
      expect(a?.getAttribute("href"), where).toBe(RUNS_PAGE);
      expect(a?.getAttribute("rel"), where).toBe("noopener noreferrer");
    }
    expect(page.byId("tab-attempts-count").textContent).toBe("");
    // Not an error, and no training reads claimed.
    expect(page.body.textContent).not.toMatch(/did not load|could not be loaded|Training reads/);

    // Working the task still works: another environment, and its own attempts tab says the same.
    page.byId("tab-attempts").click();
    expect(page.byId("panel-attempts").hidden).toBe(false);
    expect(page.byId("att-body").textContent).toContain("no recorded attempts");
  });

  it("still says the runs failed to load when runs.json is there and broken", async () => {
    const page = await load({ status: 500 });
    expect(page.state().runs.status).toBe("failed");
    expect(page.byId("att-body").textContent).toContain("The recorded runs did not load");
    expect(page.byId("foot-runs").textContent).toContain("could not be loaded");
    expect(page.body.textContent).not.toContain("This build carries no recorded attempts");
  });

  it("keeps showing recorded attempts where runs.json carries them, as the claude.ai build does", async () => {
    const ctx = vm.createContext({ crypto: { randomUUID: () => "x" }, TextEncoder, console });
    vm.runInContext(bundle, ctx);
    const env = (
      ctx.HMEnvironments as {
        environments: {
          key: string;
          version: string;
          draw(s: string, a: number, b: number): { id: string };
        }[];
      }
    ).environments.find((e) => e.key === "refi-review")!;
    const task = env.draw("train", 1, 0);
    const record = {
      env: { name: "refi-review", version: env.version },
      run_id: "run-1",
      policy: "vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking",
      task: { id: task.id, split: "train", suite_seed: 1, index: 0, rendered: "" },
      result: {
        outcome: "submitted",
        pass: true,
        score: 1,
        turns: 1,
        tool_calls: 1,
        usage: { input_tokens: 10, output_tokens: 10 },
        error: null,
        finished_at: "2026-10-26T12:00:00.000Z",
        fields: [],
      },
      transcript: [],
    };
    const page = await load({
      status: 200,
      body: { built_at: "2026-10-26T12:00:00.000Z", records: [record] },
    });
    expect(page.errors).toEqual([]);
    expect(page.state().runs.status).toBe("ready");
    expect(page.state().runs.records).toHaveLength(1);
    expect(page.byId("tab-attempts-count").textContent).toBe("1");
    expect(page.byId("att-body").textContent).toContain("1 of 1 training tasks passed");
    expect(page.byId("foot-runs").textContent).toContain("Recorded runs: 1 episode");
    expect(page.body.textContent).not.toContain("This build carries no recorded attempts");
    expect(page.byId("task-tried").hidden).toBe(false);
  });
});
