/**
 * refi-hard: every task can be solved from refi-tape's rulebook and tools,
 * the suite holds each edge on each side equally, and each task sits where
 * its edge says — measured here from the tape as read, apart from the
 * generator's own checks — with the answer turning on it.
 */

import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, endOfMonth, type PlainDate } from "@hm/kernel/calendar";
import {
  buildCandidate,
  cashBackCap,
  defaultSchedule,
  monthsBetween,
  prepaidInterest,
  rateDeltaBps,
} from "@hm/refi-review";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import {
  EDGES,
  HARD_HELDOUT_SUITE,
  generateHardSuite,
  generateHardTask,
  refiHard,
  refiHardPolicy,
  rowOf,
  type HardTask,
} from "../refi-hard/index.js";
import {
  TapeReferencePolicy,
  expectedTapeAnswer,
  renderTapeTask,
  tapePayload,
} from "../refi-tape/index.js";

const heldout = generateHardSuite("heldout", HARD_HELDOUT_SUITE.seed, HARD_HELDOUT_SUITE.n);
const train = generateHardSuite("train", 1, 1000);

const solveAll = async (tasks: readonly HardTask[], env = refiHard) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(env, task, new TapeReferencePolicy());
    if (!r.grade.pass) misses.push(`${task.id} ${task.edge} ${r.outcome} ${r.error ?? ""}`);
  }
  return misses;
};

/** Where a task sits, measured off the tape as read; null when it is where its side says. */
function misplaced(t: HardTask): string | null {
  const row = rowOf(t);
  if (!row) return "unreadable";
  const review = t.review_date;
  const schedule = defaultSchedule(review);
  const c = buildCandidate(row, { as_of: review }).candidate;
  const a = expectedTapeAnswer(t);
  const has = (code: string) => a.reasons.includes(code);
  const ok = (cond: boolean, what: string) => (cond ? null : what);
  switch (t.edge) {
    case "rate_floor": {
      const gap = rateDeltaBps(row.note_rate_pct, t.quote?.note_rate_pct ?? "0");
      return ok(
        gap === (t.side === "25 bps" ? 25 : 12.5) &&
          has("rate_delta_below_floor") === (t.side === "12.5 bps"),
        `gap ${gap}`,
      );
    }
    case "cash_cap": {
      const L = c.rounded_to_thousand
        ? c.loan_amount_cents
        : ((c.loan_amount_cents + 99_999n) / 100_000n) * 100_000n;
      const prepaid = prepaidInterest(L, row.note_rate_pct, schedule.disbursement_date);
      const over = L - c.payoff_estimate_cents - prepaid.prepaid_interest_cents - cashBackCap(L);
      return ok(
        c.rounded_to_thousand === (t.side === "at or under the cap") &&
          over <= 501n &&
          over >= -500n &&
          a.verdict === "candidate",
        `over the cap by ${over}`,
      );
    }
    case "ltv_limit": {
      const at = t.side === "at the limit" ? c.ltv_x10000 : c.ltv_x10000 - 1;
      return ok([9700, 9000, 7500, 8000].includes(at), `ltv ${c.ltv_x10000}`);
    }
    case "value_confidence": {
      const line = addMonths(review, -12);
      const on = t.side === "12 months to the day";
      return ok(
        c.ltv_x10000 > 9000 &&
          c.ltv_x10000 <= 9700 &&
          row.value_estimate.as_of === (on ? line : addDays(line, -1)) &&
          row.value_estimate.confidence === (on ? "medium" : "low") &&
          has("prescreen_failed") === !on,
        `ltv ${c.ltv_x10000}, value ${row.value_estimate.as_of} ${row.value_estimate.confidence}`,
      );
    }
    case "value_stale": {
      const line = addMonths(review, -24);
      const on = t.side === "24 months to the day";
      return ok(
        row.value_estimate.as_of === (on ? line : addDays(line, -1)) && has("value_stale") === !on,
        `value ${row.value_estimate.as_of}`,
      );
    }
    case "ma_window": {
      const months = monthsBetween(row.consummation_date, schedule.consummation_date);
      return ok(
        row.property_state === "MA" &&
          months === (t.side === "60 months to the day" ? 60 : 59) &&
          has("state_rule_failed") === (months === 59),
        `${row.property_state} ${months} months`,
      );
    }
    case "gates": {
      const declined = t.gate_facts.declined_on;
      const first = t.gate_facts.offered_at[0];
      const sides: Record<string, () => boolean> = {
        "declined 90 days ago": () =>
          declined !== null && daysBetween(declined, review) === 90 && !has("cooldown"),
        "declined 89 days ago": () =>
          declined !== null && daysBetween(declined, review) === 89 && has("cooldown"),
        "first offer 12 months ago to the day": () =>
          first === addMonths(review, -12) && !has("frequency_cap"),
        "first offer a day inside 12 months": () =>
          first === addDays(addMonths(review, -12), 1) && has("frequency_cap"),
      };
      return ok(sides[t.side]?.() ?? false, `${declined} ${first}`);
    }
    case "month_end": {
      const d: PlainDate = schedule.disbursement_date;
      const last = t.side === "last day of a month";
      return ok(
        (last ? d === endOfMonth(d) && c.prepaid_days === 1 : d.endsWith("-01")) &&
          a.verdict === "candidate",
        `disbursement ${d}, ${c.prepaid_days} prepaid days`,
      );
    }
    case "paid_ahead":
      return ok(
        (c.payoff_days === 0) === (t.side === "paid ahead of disbursement") &&
          a.verdict === "candidate",
        `${c.payoff_days} payoff days`,
      );
    case "pmi_unit": {
      const raw = Number(t.tape.facts["pmi_rate_pct"]);
      return ok(
        raw >= 4.875 &&
          raw <= 6 &&
          raw <= 5 === (t.side === "5 or under, a percent") &&
          row.mi_monthly_cents > 0n &&
          a.verdict === "candidate",
        `pmi ${raw}`,
      );
    }
  }
}

describe("refi-hard", () => {
  it("can be solved from refi-tape's rulebook and tools: the reference passes the held-out suite", async () => {
    expect(await solveAll(heldout)).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed, and under the policy's wording", async () => {
    expect(await solveAll(generateHardSuite("train", 11, 300))).toEqual([]);
    expect(await solveAll(heldout.slice(0, 20), refiHardPolicy)).toEqual([]);
  }, 120_000);

  it("holds every edge on each side equally, and every edge in any ten tasks", () => {
    for (const edge of EDGES) {
      const sides = new Map<string, number>();
      for (const t of heldout.filter((x) => x.edge === edge))
        sides.set(t.side, (sides.get(t.side) ?? 0) + 1);
      const counts = [...sides.values()];
      expect(
        counts.reduce((s, n) => s + n, 0),
        edge,
      ).toBe(20);
      if (edge === "gates" || edge === "ltv_limit") continue; // their sides depend on a drawn variant
      expect(counts, edge).toEqual([10, 10]);
    }
    expect(new Set(heldout.slice(30, 40).map((t) => t.edge)).size).toBe(EDGES.length);
  });

  it("puts every task where its edge says, with the answer turning on it", () => {
    const wrong = [...heldout, ...train]
      .map((t) => [t, misplaced(t)] as const)
      .filter(([, why]) => why !== null)
      .map(([t, why]) => `${t.id} ${t.edge} (${t.side}): ${why}`);
    expect(wrong).toEqual([]);
  });

  it("draws every limit of the loan-to-value edge, and both gates", () => {
    const limits = new Set(
      train
        .filter((t) => t.edge === "ltv_limit")
        .map((t) => {
          const row = rowOf(t);
          if (!row) return "unreadable";
          const ltv = buildCandidate(row, { as_of: t.review_date }).candidate.ltv_x10000;
          return `${t.side === "at the limit" ? ltv : ltv - 1} ${row.occupancy} ${row.value_estimate.confidence}`;
        }),
    );
    expect([...limits].sort()).toEqual([
      "7500 investment medium",
      "8000 primary medium",
      "9000 primary low",
      "9000 second_home medium",
      "9700 primary medium",
    ]);
    const gates = new Set(train.filter((t) => t.edge === "gates").map((t) => t.side));
    expect(gates.size).toBe(4);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump HARD_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldout.map(toJsonLine).join(""))).toBe(
      "dd443c878f31f8218636a5a372aa3669d08ec95f076ca4d098117af63246ed36",
    );
  });

  it("rebuilds a task from its coordinates, and never draws a held-out tape into training", () => {
    expect(toJsonLine(generateHardTask("train", 7, 17))).toBe(
      toJsonLine(generateHardSuite("train", 7, 30)[17]),
    );
    const fp = (t: HardTask) => toJsonLine(tapePayload(t));
    const held = new Set(heldout.map(fp));
    expect(train.filter((t) => held.has(fp(t)))).toEqual([]);
  });

  it("shows a model refi-tape's task and nothing of where it sits", () => {
    for (const t of heldout) {
      const shown = renderTapeTask(t);
      expect(shown).not.toContain(t.edge);
      expect(shown).not.toContain(t.side);
      expect(shown).not.toContain("refi-hard");
    }
  });
});
