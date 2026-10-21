/**
 * flexmod-terms: the grader is the servicing app's waterfall and no other
 * (the port is its file byte for byte but the imports); it gives §12.8's
 * worked example to the cent; every generated loan can be solved from the
 * rulebook and the tools; and each outcome and edge turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import {
  FLEX_HELDOUT_SUITE,
  FlexReferencePolicy,
  annuityPrincipal,
  drawFlexTask,
  expectedFlex,
  flexPayload,
  flexSpecTasks,
  flexmodTerms,
  generateFlexSuite,
  generateFlexTask,
  gradeFlexAgainst,
  mirFor,
  parseFlexSubmission,
  shortageMonthly,
  type FlexTask,
} from "../flexmod/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");

const solveAll = async (tasks: readonly FlexTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(flexmodTerms, task, new FlexReferencePolicy());
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return misses;
};

describe("flexmod-terms", () => {
  it("grades with the servicing app's waterfall: the port is its file but for the imports", () => {
    const original = readFileSync(
      here("../../../../apps/servicing/src/domain/lossmit/flexmod.ts"),
      "utf8",
    );
    const port = readFileSync(here("../flexmod/ported/flexmod.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(original));
    expect(
      port
        .split("\n")
        .filter((l) => l.startsWith("import "))
        .join("\n"),
    ).toMatch(/^(import .* from "@hm\/kernel\/(money|calendar)";\n?){4}$/);
  });

  it("gives §12.8's worked example to the cent", () => {
    expect(expectedFlex(flexSpecTasks()[0]!)).toEqual({
      decision: "offer",
      denial_reason: null,
      mir_pct: "6.625",
      gross_upb_cents: "25140531",
      mtmltv_pct: "86.69",
      target_pi_cents: "126413",
      rate_pct: "6.500",
      term_months: 480,
      forborne_cents: "3548332",
      ib_upb_cents: "21592199",
      pi_cents: "126413",
      reduction_pct: "20.0004",
      post_mod_ib_mtmltv_pct: "74.46",
      exhaustion_offer: false,
      trial_months: 3,
      first_trial_due_on: "2026-10-01",
      last_trial_due_on: "2026-12-01",
      trial_payment_cents: "181513",
      effective_on: "2027-01-01",
      capitalization_on: "2026-12-01",
      maturity_on: "2066-12-01",
      incentive_deadline: "2027-02-28",
    });
  });

  it("restates the service's conventions as the service has them", () => {
    const [spec] = flexSpecTasks();
    // The rate-table row effective on the evaluation date counts; the next one does not.
    expect(mirFor({ ...spec!, evaluation_on: "2026-09-15" as never })).toBe("6.750");
    expect(mirFor({ ...spec!, evaluation_on: "2026-09-14" as never })).toBe("6.625");
    // A failed trial 365 days back no longer bars the loan; 364 does.
    const failed = (days: number) =>
      expectedFlex({
        ...spec!,
        last_trial_failed_on: addDaysIso(spec!.evaluation_on, -days) as never,
      });
    expect(failed(364).denial_reason).toBe("FNMA_D23206_TRIAL_FAILED_12M");
    expect(failed(365).decision).toBe("offer");
    expect(expectedFlex({ ...spec!, prior_modifications: 3 }).denial_reason).toBe(
      "FNMA_D23206_THREE_PRIOR_MODS",
    );
    expect(expectedFlex({ ...spec!, prior_modifications: 2 }).decision).toBe("offer");
    // $1,860.00 over 60 months is $31.00; half a cent rounds up.
    expect(shortageMonthly(186_000n)).toBe(3_100n);
    expect(shortageMonthly(30n)).toBe(1n);
    // The closed-form principal is the engine's solve before its verify loop: $215,921.99 here.
    expect(annuityPrincipal(126_413n, "6.500", 480)).toBe(21_592_199n);
  });

  it("fails an answer one cent off on exactly that field, and reads a submission strictly", () => {
    const want = expectedFlex(flexSpecTasks()[0]!);
    const g = gradeFlexAgainst(want, { ...want, forborne_cents: "3548333" });
    expect(g.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["forborne_cents"]);
    expect(parseFlexSubmission(want).ok).toBe(true);
    expect(parseFlexSubmission({ ...want, decision: "approved" }).ok).toBe(false);
    expect(parseFlexSubmission({ ...want, mtmltv_pct: "86.7" }).ok).toBe(false);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    expect(
      await solveAll([
        ...flexSpecTasks(),
        ...generateFlexSuite("heldout", FLEX_HELDOUT_SUITE.seed, FLEX_HELDOUT_SUITE.n),
      ]),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    expect(await solveAll(generateFlexSuite("train", 11, 300))).toEqual([]);
  }, 120_000);

  it("is fair to grade on every first draw", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawFlexTask("train", 3, i));
    expect(draws.filter((d) => d.attempts > 1).length).toBeLessThan(6);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump FLEX_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateFlexSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"b4985e1d6dff9d032e54fba85948c026deffa31c6a9da53544a5afaa1b36e87f"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out loan into training", () => {
    expect(toJsonLine(generateFlexTask("train", 7, 17))).toBe(
      toJsonLine(generateFlexSuite("train", 7, 30)[17]),
    );
    const fp = (t: FlexTask) => toJsonLine(flexPayload(t));
    const held = new Set(generateFlexSuite("heldout", 1, 200).map(fp));
    expect(generateFlexSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each outcome and edge turns up", () => {
    const runs = generateFlexSuite("train", 1, 1500).map((t) => ({ t, a: expectedFlex(t) }));
    const count = (f: (x: (typeof runs)[number]) => boolean) => runs.filter(f).length;

    it("draws an offer and every denial", () => {
      expect(new Set(runs.map(({ a }) => a.denial_reason ?? "offer"))).toEqual(
        new Set([
          "offer",
          "FNMA_D23206_TRIAL_FAILED_12M",
          "FNMA_D23206_THREE_PRIOR_MODS",
          "INV_FNMA_F127_PI_RULE",
        ]),
      );
    });

    it("draws each waterfall step, alone and together, and an exhausted offer", () => {
      const rateCut = ({ t, a }: (typeof runs)[number]) =>
        a.rate_pct !== null &&
        a.rate_pct !== Number(t.loan.contract_rate_pct).toFixed(3) &&
        !t.loan.is_arm_not_final;
      expect(count(rateCut)).toBeGreaterThan(100);
      expect(
        count(({ t, a }) => a.term_months !== null && a.term_months > t.loan.remaining_term_months),
      ).toBeGreaterThan(300);
      expect(
        count(({ a }) => a.forborne_cents !== null && a.forborne_cents !== "0"),
      ).toBeGreaterThan(200);
      expect(count(({ a }) => a.exhaustion_offer === true)).toBeGreaterThan(100);
      expect(
        count(
          ({ a, t }) =>
            a.decision === "offer" &&
            a.term_months === t.loan.remaining_term_months &&
            a.forborne_cents === "0",
        ),
      ).toBeGreaterThan(5);
    });

    it("draws MTMLTV printing 50.00 and 50.01, an ARM lifted to the MIR, and a target that is not 80% exactly", () => {
      expect(count(({ a }) => a.mtmltv_pct === "50.00")).toBeGreaterThan(50);
      expect(count(({ a }) => a.mtmltv_pct === "50.01")).toBeGreaterThan(5);
      expect(
        count(
          ({ t, a }) =>
            t.loan.is_arm_not_final &&
            a.rate_pct === a.mir_pct &&
            Number(t.loan.contract_rate_pct) < Number(a.mir_pct),
        ),
      ).toBeGreaterThan(10);
      expect(count(({ t }) => (t.loan.pre_mod_pi_cents * 80n) % 100n === 0n)).toBeGreaterThan(50);
    });

    it("draws a rate-table row effective on the evaluation date, notices on the 15th and 16th, and December notices", () => {
      expect(
        count(({ t }) => t.mir_table.some((r) => r.effective === t.evaluation_on)),
      ).toBeGreaterThan(150);
      expect(count(({ t }) => t.trial.notice_sent_on.endsWith("-15"))).toBeGreaterThan(30);
      expect(count(({ t }) => t.trial.notice_sent_on.endsWith("-16"))).toBeGreaterThan(30);
      expect(count(({ t }) => t.trial.notice_sent_on.slice(5, 7) === "12")).toBeGreaterThan(100);
    });
  });
});

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
