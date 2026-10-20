/**
 * Compare two policies' runs on the same tasks.
 *
 *   npm run env:compare -w @hm/environments -- --a runs/x.jsonl --b runs/y.jsonl [--b runs/y-rerun.jsonl]
 *
 * Either side may be several files (a run and its re-runs); each task's
 * newest scored episode counts.
 */

import { parseArgs } from "node:util";
import { compare, readRun, scoreSide } from "./compare.js";

const { values } = parseArgs({
  options: {
    a: { type: "string", multiple: true },
    b: { type: "string", multiple: true },
  },
});
if (!values.a?.length || !values.b?.length) {
  console.error("usage: --a <run.jsonl> [--a ...] --b <run.jsonl> [--b ...]");
  process.exit(1);
}

const A = scoreSide(readRun(values.a));
const B = scoreSide(readRun(values.b));
const c = compare(A, B);
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
const usd = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

console.log(`A: ${A.policies.join(", ")}`);
console.log(`B: ${B.policies.join(", ")}`);
console.log(
  `${c.tasks} tasks scored on both sides${c.unpaired.length ? `; ${c.unpaired.length} left out (not scored on both): ${c.unpaired.join(", ")}` : ""}`,
);
console.log(
  `A passed ${c.a.passed}/${c.tasks} = ${pct(c.a.passed / Math.max(1, c.tasks))} (95 % ${pct(c.a.low)} to ${pct(c.a.high)}), ${usd(c.costA)} an episode`,
);
console.log(
  `B passed ${c.b.passed}/${c.tasks} = ${pct(c.b.passed / Math.max(1, c.tasks))} (95 % ${pct(c.b.low)} to ${pct(c.b.high)}), ${usd(c.costB)} an episode`,
);
console.log(
  `disagreements: A only ${c.onlyA}, B only ${c.onlyB}; McNemar exact p = ${c.p.toFixed(4)}`,
);
for (const [v, x] of [...c.byVerdict].sort())
  console.log(`  ${v}: A ${x.a}/${x.n}, B ${x.b}/${x.n}`);
for (const m of c.sharedMisses) {
  console.log(
    `  both missed ${m.id} on ${m.fields.join(", ")}: check the wording before counting it`,
  );
}
console.log(
  c.p < 0.05
    ? `${c.onlyA > c.onlyB ? "A" : "B"} scores higher, and the difference is unlikely to be chance.`
    : "No difference these tasks can tell apart from chance.",
);
