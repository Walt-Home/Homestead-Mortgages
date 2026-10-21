/**
 * The browser playground (`playground/entry.ts`) is every environment the
 * CLI runs, through each environment's own modules, and nothing of the
 * held-out suite: that suite is what every reported score is measured on,
 * so the playground draws the train split and the spec's own tasks only,
 * and the run records it ships hold model episodes on the train split alone.
 * A split label is not the test of that. Task streams are seeded with a
 * 32-bit hash, so train coordinates can name a held-out task's stream; the
 * playground refuses them, and the run records are held to the same guard.
 *
 * The entry and the shims sit outside `src`, so they are imported by path
 * rather than by name; the build that bundles them is
 * `scripts/build-playground.mjs`.
 */

import { createHash as nodeCreateHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { HELDOUT_SUITES, namespaceOf } from "../heldout-guard.js";
import { payloadOf } from "../refi/task.js";
import { hash32 } from "../rng.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

interface TaskRef {
  readonly env: string;
  readonly id: string;
  readonly split: string;
  readonly suite_seed: number;
  readonly index: number;
  readonly name?: string;
}
interface Grade {
  readonly pass: boolean;
  readonly score: number;
  readonly fields: readonly { field: string; expected: string; got: string | null; ok: boolean }[];
}
interface PlaygroundEnvironment {
  readonly key: string;
  readonly title: string;
  readonly side: string;
  readonly summary: string;
  readonly version: string;
  readonly rulebook: string;
  readonly tools: readonly { name: string }[];
  readonly submitTool: string;
  draw(split: string, seed: number, index: number): TaskRef;
  spec(): TaskRef[];
  render(task: TaskRef): string;
  payload(task: TaskRef): Record<string, unknown>;
  expected(task: TaskRef): unknown;
  grade(task: TaskRef, answer: unknown): Grade;
  verdictOf(task: TaskRef): string;
  solve(task: TaskRef): Promise<{
    answer: unknown;
    outcome: string;
    grade: Grade;
    steps: { turn: number; calls: { name: string; output: string | null; is_error: boolean }[] }[];
  }>;
}

/** cli.ts's registry, read from its source: importing it would run it. */
const benchKeys = (): string[] => {
  const cli = readFileSync(here("../cli.ts"), "utf8");
  const start = cli.indexOf("const BENCHES = {");
  const block = cli.slice(start, cli.indexOf("\n};", start));
  return [...block.matchAll(/^ {2}"([a-z0-9-]+)": \{/gm)].map((m) => m[1] as string);
};

/** A value that survives JSON unchanged: what may cross to a page. */
const isPlain = (v: unknown): boolean => {
  try {
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    return true;
  } catch {
    return false;
  }
};

/* FNV-1a run backward: train coordinates whose key hashes to a given seed, by meeting in the middle. */
const FNV_PRIME = 0x01000193;
let FNV_INVERSE = FNV_PRIME;
for (let k = 0; k < 6; k++)
  FNV_INVERSE = Math.imul(FNV_INVERSE, (2 - Math.imul(FNV_PRIME, FNV_INVERSE)) >>> 0) >>> 0;
const fold = (h: number, text: string): number => {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  return h;
};
const unfold = (h: number, text: string): number => {
  for (let i = text.length - 1; i >= 0; i--)
    h = ((Math.imul(h, FNV_INVERSE) >>> 0) ^ text.charCodeAt(i)) >>> 0;
  return h;
};
const seedTables = new Map<string, Map<number, number>>();
/** Train seed and index under `namespace` whose key, plus `suffix`, hashes to `target`. */
function collidingTrain(namespace: string, target: number, suffix = ""): [number, number] {
  let bySeed = seedTables.get(namespace);
  if (!bySeed) {
    const base = hash32(`${namespace}/train/`);
    bySeed = new Map<number, number>();
    for (let seed = 0; seed < 1 << 18; seed++) bySeed.set(fold(base, `${seed}/`), seed);
    seedTables.set(namespace, bySeed);
  }
  for (let index = 0; index < 1 << 24; index++) {
    const seed = bySeed.get(unfold(target, `${index}${suffix}`));
    if (seed !== undefined) return [seed, index];
  }
  throw new Error(`no train key under ${namespace} reaches ${target}`);
}
const heldoutKey = (namespace: string, index: number, suffix = "") =>
  hash32(`${namespace}/heldout/1/${index}${suffix}`);

let environments: readonly PlaygroundEnvironment[] = [];
let drawsHeldoutStream: (id: string) => boolean = () => true;

beforeAll(async () => {
  await import(here("../../playground/entry.ts"));
  const playground = (
    globalThis as {
      HMEnvironments?: {
        environments: readonly PlaygroundEnvironment[];
        drawsHeldoutStream: (id: string) => boolean;
      };
    }
  ).HMEnvironments;
  environments = playground?.environments ?? [];
  if (playground) drawsHeldoutStream = playground.drawsHeldoutStream;
});

describe("the playground", () => {
  it("offers every environment in cli.ts's registry, in its order", () => {
    const keys = benchKeys();
    expect(keys.length).toBeGreaterThanOrEqual(13);
    expect(environments.map((e) => e.key)).toEqual(keys);
    for (const e of environments) {
      expect(["refinance", "servicing", "origination"]).toContain(e.side);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.summary.length).toBeGreaterThan(40);
      expect(e.rulebook.length).toBeGreaterThan(1000);
      expect(e.tools.map((t) => t.name)).toContain(e.submitTool);
      expect(isPlain(e.tools)).toBe(true);
    }
  });

  it("solves three train tasks per environment with the reference, through the episode loop", async () => {
    for (const e of environments) {
      for (let index = 0; index < 3; index++) {
        const task = e.draw("train", 1, index);
        expect(task).toMatchObject({ env: e.key, split: "train", suite_seed: 1, index });
        expect(isPlain(task)).toBe(true);
        expect(e.payload(task)).toEqual(payloadOf(e.render(task)));
        const solved = await e.solve(task);
        expect(solved.outcome, task.id).toBe("submitted");
        expect(solved.grade.pass, task.id).toBe(true);
        expect(e.grade(task, solved.answer).pass, task.id).toBe(true);
        expect(e.grade(task, null).pass).toBe(false);
        expect(solved.steps.at(-1)?.calls.at(-1)?.name).toBe(e.submitTool);
        for (const step of solved.steps.slice(0, -1))
          for (const call of step.calls) expect(typeof call.output).toBe("string");
        expect(typeof e.verdictOf(task)).toBe("string");
        for (const v of [solved, e.expected(task), e.payload(task)]) expect(isPlain(v)).toBe(true);
      }
    }
  });

  it("draws the train split only, and refuses a task from any other split", async () => {
    for (const e of environments) {
      for (const split of ["heldout", "spec", "test"])
        expect(() => e.draw(split, 1, 0), `${e.key} ${split}`).toThrow(/train split/);
      const heldout: TaskRef = {
        env: e.key,
        id: `${e.key}/${e.version}/heldout/1/0`,
        split: "heldout",
        suite_seed: 1,
        index: 0,
      };
      expect(() => e.render(heldout)).toThrow(/train split/);
      expect(() => e.payload(heldout)).toThrow(/train split/);
      expect(() => e.expected(heldout)).toThrow(/train split/);
      expect(() => e.grade(heldout, null)).toThrow(/train split/);
      expect(() => e.verdictOf(heldout)).toThrow(/train split/);
      await expect(e.solve(heldout)).rejects.toThrow(/train split/);
      // A train task renamed to its held-out twin is not that task either.
      const train = e.draw("train", 1, 0);
      expect(() => e.render({ ...train, id: train.id.replace("/train/", "/heldout/") })).toThrow();
      for (const spec of e.spec()) expect(spec.split).toBe("spec");
    }
  });

  it("refuses the train coordinates that already name held-out tasks", () => {
    const at = (key: string) => environments.find((e) => e.key === key)!;
    // refi-review held-out 0 and 1, found by search; escrow's four sit at ordinary coordinates.
    expect(hash32("refi-review/1.0.0/train/862396/158")).toBe(heldoutKey("refi-review/1.0.0", 0));
    expect(() => at("refi-review").draw("train", 862396, 158)).toThrow(/held-out task/);
    expect(() => at("refi-review").draw("train", 862396, 159)).toThrow(/held-out task/);
    for (const [index, held] of [
      [9554, 29],
      [9555, 28],
      [9558, 25],
      [9559, 24],
    ] as const) {
      expect(hash32(`escrow-analysis/1.0.0/train/5920/${index}`)).toBe(
        heldoutKey("escrow-analysis/1.0.0", held),
      );
      for (const key of ["escrow-analysis", "escrow-policy"]) {
        expect(() => at(key).draw("train", 5920, index), `${key} ${index}`).toThrow(
          /held-out task/,
        );
        const ref = {
          ...at(key).draw("train", 5920, 9556),
          index,
          id: `escrow-analysis/1.0.0/train/5920/${index}`,
        };
        expect(() => at(key).render(ref)).toThrow(/held-out task/);
      }
    }
  });

  it("refuses train coordinates found to share any held-out task's stream, in every environment", () => {
    for (const e of environments) {
      const namespace = namespaceOf(e.draw("train", 1, 0).id);
      // Its own held-out task, at its first draw.
      const [seed, index] = collidingTrain(namespace, heldoutKey(namespace, 7));
      expect(() => e.draw("train", seed, index), `${e.key} ${seed}/${index}`).toThrow(
        /held-out task/,
      );
      const ref = {
        env: e.key,
        id: `${namespace}/train/${seed}/${index}`,
        split: "train",
        suite_seed: seed,
        index,
      };
      expect(() => e.payload(ref)).toThrow(/held-out task/);
      expect(() => e.expected(ref)).toThrow(/held-out task/);
      // A redraw on either side: the train key's first redraw, and the held-out task's.
      const [s1, i1] = collidingTrain(namespace, heldoutKey(namespace, 3), "#1");
      expect(() => e.draw("train", s1, i1), `${e.key} ${s1}/${i1}#1`).toThrow(/held-out task/);
      const [s2, i2] = collidingTrain(namespace, heldoutKey(namespace, 3, "#2"));
      expect(() => e.draw("train", s2, i2), `${e.key} ${s2}/${i2}`).toThrow(/held-out task/);
    }
    // Another environment that draws the same loans, and a retired version's suite.
    const review = environments.find((e) => e.key === "refi-review")!;
    const [s3, i3] = collidingTrain("refi-review/1.0.0", heldoutKey("refi-tape/1.1.0", 0));
    expect(() => review.draw("train", s3, i3)).toThrow(/held-out task/);
    const tape = environments.find((e) => e.key === "refi-tape")!;
    const [s4, i4] = collidingTrain("refi-tape/1.1.0", heldoutKey("refi-tape/1.0.0", 0));
    expect(() => tape.draw("train", s4, i4)).toThrow(/held-out task/);
  }, 60_000);

  it("lists a held-out suite under every namespace it draws, and names every spec case", () => {
    const listed = HELDOUT_SUITES.map((s) => s.namespace);
    for (const e of environments) {
      expect(listed).toContain(namespaceOf(e.draw("train", 1, 0).id));
      const specs = e.spec();
      for (const t of specs) expect(t.name, `${e.key} spec ${t.index}`).toMatch(/\S/);
      expect(new Set(specs.map((t) => t.name)).size).toBe(specs.length);
    }
  });

  it("hashes as node:crypto does, so every fingerprint matches the CLI's", async () => {
    const shim = (await import(here("../../playground/shims/node-crypto.ts"))) as {
      createHash: (a: string) => { update: (s: string) => { digest: (e: "hex") => string } };
    };
    const node = (s: string) => nodeCreateHash("sha256").update(s).digest("hex");
    const ours = (s: string) => shim.createHash("sha256").update(s).digest("hex");
    const texts = [
      "",
      "abc",
      "÷ × − ≤ § 😀",
      "\ud800 a lone surrogate",
      ...Array.from({ length: 130 }, (_, n) => "x".repeat(n)),
    ];
    for (const e of environments) texts.push(e.rulebook, JSON.stringify(e.tools));
    for (const t of texts) expect(ours(t)).toBe(node(t));
  });

  const RUNS = here("../../playground/dist/runs.json");
  it.skipIf(!existsSync(RUNS))(
    "ships no held-out or spec run record, by label or by stream",
    () => {
      const runs = JSON.parse(readFileSync(RUNS, "utf8")) as {
        records: { policy: string; task: { id: string; split: string } }[];
      };
      const listed = HELDOUT_SUITES.map((s) => s.namespace);
      for (const r of runs.records) {
        expect(r.task.split).toBe("train");
        expect(r.task.id.split("/")[2]).toBe("train");
        expect(r.policy).not.toMatch(/^reference/);
        expect(listed).toContain(namespaceOf(r.task.id));
        expect(drawsHeldoutStream(r.task.id), r.task.id).toBe(false);
      }
      expect(readFileSync(RUNS, "utf8")).not.toMatch(/\/heldout\/|"split":"(heldout|spec)"/);
    },
  );
});
