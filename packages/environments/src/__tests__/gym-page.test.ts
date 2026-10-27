/**
 * The Gym's page: a list of jobs in plain words, and a page for each job.
 *
 * The copy served inside the ops console (`apps/api/src/routes/console-gym.ts`)
 * has no `runs.json`: model transcripts are not committed, so its build
 * carries none, and the request for them is a 404. The page has to read that
 * as a build without recorded attempts — and say so, and say where they are —
 * while everything else on it works; and the claude.ai build, which carries
 * them, has to keep showing them. Its figures are the held-out scores at each
 * environment's own output budget, and a score at another budget is named by
 * its budget wherever it is shown.
 *
 * No browser: the page is built as the image builds it
 * (`build-playground.mjs --site-only`), its bundle and its one inline script
 * run in a context holding a small DOM made from the page's own markup, and
 * `fetch` answers `scores.json` with the committed snapshot and `runs.json`
 * as each case says. The DOM is the least the page reaches for; anything
 * else it calls is undefined here and throws.
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
      if (!VOID.has(m[2].toLowerCase()) && !m[0].endsWith("/>")) stack.push(el);
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

interface Gym {
  go(key: string): void;
  jobs: Record<string, { name: string; sentence: string; of?: string; group?: string }>;
  state: () => {
    current: string | null;
    runs: { status: string; records: unknown[]; error: string | null };
    scores: { status: string };
  };
}
interface Loaded {
  body: El;
  byId: (id: string) => El;
  text: (id: string) => string;
  gym: Gym;
  errors: unknown[];
  /** Wait for the page's timers and promises until `ready` holds. */
  until: (ready: () => boolean, what: string) => Promise<void>;
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
  const window: Record<string, unknown> = {
    location: { hash: "" },
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
    title: "",
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
  const scripts = [...html.matchAll(/<script>\n?([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  vm.runInContext(scripts[0]![1]!, context, { filename: "index.html" });
  const until = async (ready: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (ready()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`the page never got to: ${what}`);
  };
  const gym = window.HMGym as Gym;
  // The two fetches and their renders.
  await until(
    () => gym.state().runs.status !== "loading" && gym.state().scores.status !== "loading",
    "runs and scores read",
  );
  return { body, byId, text: (id) => byId(id).textContent, gym, errors, until };
}

const links = (el: El) => [...el.walk()].filter((e) => e.tagName === "A");
const buttonNamed = (root: El, name: string) => {
  const b = [...root.walk()].find((e) => e.tagName === "BUTTON" && e.textContent.trim() === name);
  if (!b) throw new Error(`no button "${name}"`);
  return b;
};

/** Open a job as a link would, and wait for its case and its right answer. */
async function open(page: Loaded, key: string) {
  page.gym.go(key);
  await page.until(
    () =>
      page.text("case-body").length > 40 &&
      !page.text("answer-body").includes("Working it out") &&
      page.text("answer-body").length > 0,
    `${key}'s case and its right answer`,
  );
}

describe("the Gym's page", () => {
  it("opens on the jobs in plain words, each with how often the AI gets it right", async () => {
    const page = await load({ status: 404 });
    expect(page.errors).toEqual([]);
    expect(page.byId("fatal").hidden).toBe(true);
    expect(page.byId("home").hidden).toBe(false);
    expect(page.byId("job").hidden).toBe(true);
    expect(page.gym.state().current).toBe(null);

    const home = page.byId("home");
    for (const group of ["Refinance", "Servicing", "Lending"])
      expect(page.text("jobs")).toContain(group);
    // No engineering words on the home screen.
    expect(home.textContent).not.toMatch(
      /held-out|heldout|training|\bseed|budget|token|version \d|\b\d+\.\d+\.\d+\b|policy id|rulebook|spec case/i,
    );

    // One row per job; the versions of a job fold under it.
    const rows = [...home.walk()].filter((e) => e.classList.contains("job-row"));
    const jobs = page.gym.jobs;
    const mains = Object.keys(jobs).filter((k) => !jobs[k]!.of);
    expect(rows.map((r) => r.getAttribute("href")).sort()).toEqual(
      mains.map((k) => `#${k}`).sort(),
    );
    expect(rows.length).toBe(19);
    expect(page.text("jobs")).not.toContain("from the tape");

    // The figure is the newest DeepSeek score at the job's own output budget, Claude's beside it.
    expect(page.text("fig-refi-review")).toBe("AI right 97% of the time  ·  Claude 99.5%");
    expect(page.text("fig-escrow-analysis")).toBe("AI right 96% of the time");
    // Boarding triage's own budget is 32,000: its 95 of 200 there, not its 28 of 200 at 16,000.
    expect(page.text("fig-boarding-triage")).toBe("AI right 48% of the time");
    expect(page.text("fig-contact-audit")).toBe("AI right 95% of the time");

    // Without runs.json, the home screen says where the recorded attempts are.
    expect(page.gym.state().runs.status).toBe("absent");
    expect(page.text("home-runs")).toContain("This copy carries no recorded attempts by the AI.");
    const [a] = links(page.byId("home-runs"));
    expect(a?.getAttribute("href")).toBe(RUNS_PAGE);
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("is one document with one inline script, no inline handlers and nothing fetched from elsewhere", () => {
    // The ops console admits the page's one inline script by its hash, and no handler attribute at all.
    expect([...html.matchAll(/<script>/g)]).toHaveLength(1);
    expect(html).toContain('<script src="environments.js"></script>');
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toMatch(
      /<link\b|@import|url\(\s*["']?https?:|src="https?:|\beval\(|new Function\(/,
    );
  });

  it("names every job in plain words, briefly", async () => {
    const page = await load({ status: 404 });
    const ctx = vm.createContext({ crypto: { randomUUID: () => "x" }, TextEncoder, console });
    vm.runInContext(bundle, ctx);
    const keys = (ctx.HMEnvironments as { environments: { key: string }[] }).environments.map(
      (e) => e.key,
    );
    const jobs = page.gym.jobs;
    expect(Object.keys(jobs).sort()).toEqual([...keys].sort());
    const names = new Set<string>();
    for (const key of keys) {
      const j = jobs[key]!;
      expect(j.name.length, key).toBeGreaterThan(3);
      expect(names.has(j.name), key).toBe(false);
      names.add(j.name);
      expect(j.sentence.split(/\s+/).length, key).toBeLessThanOrEqual(16);
      expect(j.sentence, key).toMatch(/\.$/);
      expect(j.sentence, key).not.toMatch(/[a-z]_[a-z]|held-out|training|rulebook|§/);
      if (j.of) expect(jobs[j.of], key).toBeDefined();
    }
  });

  it("opens a job by its link: the case for a person, the right answer, and where the attempts are", async () => {
    const page = await load({ status: 404 });
    await open(page, "refi-review");
    expect(page.errors).toEqual([]);
    expect(page.byId("home").hidden).toBe(true);
    expect(page.byId("job").hidden).toBe(false);
    expect(page.text("job-title")).toBe("Refinance review");
    expect(page.text("job-score")).toContain("The AI gets this right 193 times in 200.");
    expect(page.text("job-score")).toContain("Claude gets it right 199 times in 200.");

    // The case, humanized: no raw keys, cents as dollars, dates as dates.
    expect(page.text("case-intro")).toBe("Review this loan on Jan 14, 2027.");
    const kase = page.text("case-body");
    expect(kase).toContain("Original balance");
    expect(kase).toContain("$972,000.00");
    expect(kase).toContain("Note rate6.375%");
    expect(kase).toContain("Jul 4, 2021");
    expect(kase).not.toMatch(/original_upb_cents|97200000|_cents|_pct/);

    // The right answer, and how it is worked out, line by line.
    expect(page.text("answer-body")).toContain("Watching");
    expect(page.text("answer-body")).toContain("6.125%");
    expect(page.byId("steps-panel").hidden).toBe(true);
    page.byId("steps-toggle").click();
    expect(page.byId("steps-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(page.text("steps-panel")).toContain("Daily interest on $721,503.20 at 6.375%: $126.02");

    // How the AI did: the score, and where its recorded attempts are.
    expect(page.text("ai-body")).toContain("193 of 200 test cases");
    expect(page.text("ai-elsewhere")).toBe(
      "The AI's recorded attempts are not in this copy. They are on the Gym's claude.ai page.",
    );
    const [a] = links(page.byId("ai-elsewhere"));
    expect(a?.getAttribute("href")).toBe(RUNS_PAGE);
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");

    // The other versions of the job, by their links.
    expect(page.byId("versions").hidden).toBe(false);
    const versions = links(page.byId("versions-list")).map((l) => l.getAttribute("href"));
    expect(versions).toEqual(["#refi-tape", "#refi-policy", "#refi-hard", "#refi-hard-policy"]);

    // The two folded sections start folded.
    for (const id of ["try", "eng"]) {
      expect(page.byId(`${id}-toggle`).getAttribute("aria-expanded")).toBe("false");
      expect(page.byId(`${id}-panel`).hidden).toBe(true);
    }

    // A version's page says what it is a version of.
    await open(page, "refi-tape");
    expect(page.text("job-title")).toBe("Refinance review from the tape");
    expect(page.text("job-variant-of")).toBe("A version of Refinance review.");
  });

  it("keeps everything technical under For engineers, with scores labeled by budget", async () => {
    const page = await load({ status: 404 });
    await open(page, "boarding-triage");
    expect(page.text("job-score")).toContain("The AI gets this right 95 times in 200.");
    page.byId("eng-toggle").click();
    expect(page.byId("eng-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(page.byId("eng-panel").hidden).toBe(false);
    const eng = page.text("eng-panel");
    expect(eng).toContain("Held-out scores");
    expect(eng).toContain("boarding-triage");
    expect(eng).toContain("output budget 32,000 tokens a turn");
    expect(page.text("eng-scores")).toContain("DeepSeek: 95 of 200");
    expect(page.text("eng-scores")).toContain("DeepSeek, 16k budget: 28 of 200");
    expect(page.text("eng-rulebook").length).toBeGreaterThan(1000);
    expect(page.text("eng-prompt")).toContain("submit_triage");
    expect(page.text("eng-attempts")).toContain(
      "This build carries no recorded attempts by a model on training tasks. They are on the Gym's claude.ai page.",
    );
    const [a] = links(page.byId("eng-attempts"));
    expect(a?.getAttribute("href")).toBe(RUNS_PAGE);
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(page.errors).toEqual([]);
  });

  it("grades an answer made in the form, item by item", async () => {
    const page = await load({ status: 404 });
    await open(page, "escrow-analysis");
    page.byId("try-toggle").click();
    expect(page.byId("try-panel").hidden).toBe(false);
    const panel = page.byId("try-panel");
    // An empty form is not graded: it says what to fill in.
    buttonNamed(panel, "Grade my answer").click();
    expect(page.text("try-result")).toContain("A few answers need fixing first.");
    expect(page.text("try-result")).toContain("Annual: fill this in.");
    // The right answer, put in the form and graded, passes.
    buttonNamed(panel, "Fill in the right answer").click();
    buttonNamed(panel, "Grade my answer").click();
    expect(page.text("try-result")).toContain("24 of 24 right");
    expect(page.text("try-result")).toContain("That answer passes.");
    // One figure changed is one item wrong, with the right value beside it.
    const amount = [...page.byId("try-form").walk()].find(
      (e) => e.tagName === "LABEL" && e.textContent === "Annual",
    )!;
    const input = page.byId(amount.getAttribute("for")!);
    input.value = "1.00";
    buttonNamed(panel, "Grade my answer").click();
    expect(page.text("try-result")).toContain("23 of 24 right");
    expect(page.text("try-result")).toMatch(/You said \$1\.00\. Right answer: \$[\d,]+\.\d\d\./);
    expect(page.errors).toEqual([]);
  });

  it("still says the runs failed to load when runs.json is there and broken", async () => {
    const page = await load({ status: 500 });
    expect(page.gym.state().runs.status).toBe("failed");
    await open(page, "refi-review");
    expect(page.text("ai-body")).toContain("The AI's recorded attempts could not be loaded.");
    page.byId("eng-toggle").click();
    expect(page.text("eng-attempts")).toContain("The recorded runs did not load");
    expect(page.body.textContent).not.toMatch(/not in this copy|carries no recorded attempts/);
  });

  it("shows a recorded attempt beside the right answer where runs.json carries them, as the claude.ai build does", async () => {
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
    const task = env.draw("train", 1, 5);
    const record = {
      env: { name: "refi-review", version: env.version },
      run_id: "run-1",
      policy: "vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking",
      task: { id: task.id, split: "train", suite_seed: 1, index: 5, rendered: "" },
      result: {
        outcome: "submitted",
        pass: false,
        score: 0.333,
        turns: 1,
        tool_calls: 1,
        usage: { input_tokens: 10, output_tokens: 10 },
        error: null,
        finished_at: "2026-10-26T12:00:00.000Z",
        fields: [
          { field: "verdict", expected: "watching", got: "candidate", ok: false },
          {
            field: "reasons",
            expected: "seven_year_not_lower",
            got: "seven_year_not_lower",
            ok: true,
          },
          { field: "watch_rate_pct", expected: "6.125", got: null, ok: false },
        ],
      },
      transcript: [],
    };
    const page = await load({
      status: 200,
      body: { built_at: "2026-10-26T12:00:00.000Z", records: [record] },
    });
    expect(page.errors).toEqual([]);
    expect(page.gym.state().runs.status).toBe("ready");
    expect(page.gym.state().runs.records).toHaveLength(1);
    expect(page.text("home-runs")).toBe("");
    await open(page, "refi-review");
    const example = page.text("ai-example");
    expect(example).toContain("One case it got wrong");
    expect(example).toContain("It missed 2 items of 3.");
    expect(example).toContain("Candidate");
    expect(example).toContain("Watching");
    expect(example).toContain("6.125%");
    expect(page.body.textContent).not.toMatch(/not in this copy|carries no recorded attempts/);
    // The case it got wrong can be opened above.
    page.byId("ai-open-case").click();
    await page.until(
      () => !page.text("answer-body").includes("Working it out"),
      "the new case solved",
    );
    expect(page.gym.state().current).toBe("refi-review");
    page.byId("eng-toggle").click();
    expect(page.text("eng-panel")).toContain("Training task, seed 1, index 5");
    expect(page.text("eng-reads")).toContain("0 of 1 training tasks passed");
  });
});
