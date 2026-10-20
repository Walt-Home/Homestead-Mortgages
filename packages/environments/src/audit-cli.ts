/**
 * Audit a run, to direct the hand read.
 *
 *   npm run env:audit -w @hm/environments -- runs/refi-review/x.jsonl [more.jsonl ...] [--read INDEX ...]
 *
 * One line per episode, then totals. `--read` prints those episodes' turns;
 * it refuses a held-out task.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { auditEpisode, summarize, transcriptOf, type AuditRecord } from "./audit.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { read: { type: "string", multiple: true } },
});
if (!positionals.length) {
  console.error("usage: env:audit <run.jsonl> [...] [--read INDEX ...]");
  process.exit(1);
}

const records = positionals.flatMap((p) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditRecord),
);
const rows = records.map(auditEpisode).sort((a, b) => a.index - b.index);
const usd = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

for (const r of rows) {
  const flags = [
    r.mental.length ? `mental:${r.mental.join(",")}` : "",
    r.passWithout.length ? `pass-without:${r.passWithout.join(",")}` : "",
    r.toolErrors ? `tool-errors:${r.toolErrors}` : "",
    r.missed.length ? `missed:${r.missed.join(",")}` : "",
    r.error ? `error:${r.error.slice(0, 80)}` : "",
  ].filter(Boolean);
  console.log(
    `${String(r.index).padStart(3)} ${r.verdict.padEnd(9)} ${r.pass ? "PASS" : "MISS"} ${r.outcome.padEnd(14)} ` +
      `turns ${String(r.turns).padStart(2)} calls ${String(r.calls).padStart(3)} ${usd(r.cost)} slowest ${r.slowestTurnS} s  ${flags.join(" ")}`,
  );
}

const s = summarize(rows);
console.log(
  `\n${s.episodes} episodes, ${s.passed} passed, ${usd(s.cost)} in all (${usd(s.cost === null ? null : s.cost / Math.max(1, s.episodes))} each)`,
);
console.log(`outcomes: ${JSON.stringify(s.outcomes)}`);
console.log(
  `by verdict: ${Object.entries(s.byVerdict)
    .map(([v, x]) => `${v} ${x.passed}/${x.n}`)
    .join(", ")}`,
);
console.log(
  `flagged: ${s.flagged.mental} with head arithmetic, ${s.flagged.passWithout} passes skipping a needed tool, ${s.flagged.toolErrors} with tool errors`,
);
if (Object.keys(s.missedFields).length)
  console.log(`missed fields: ${JSON.stringify(s.missedFields)}`);

for (const i of values.read ?? []) {
  const record = records.find((r) => r.task.index === Number(i));
  if (!record) {
    console.error(`no episode with index ${i}`);
    continue;
  }
  console.log(`\n===== ${record.task.id}`);
  try {
    console.log(transcriptOf(record));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  }
}
