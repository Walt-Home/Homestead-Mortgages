/**
 * regz-price-tests: hand-worked quotes at the rules' edges get the answers
 * the regulation gives, every generated task can be solved from the
 * rulebook and the tools, almost every draw is fair to grade first time, and
 * each test's three answers — yes, no, cannot decide — turn up.
 */

import { describe, expect, it } from "vitest";
import { APOR_TABLE } from "@hm/underwriting";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import {
  REGZ_HELDOUT_SUITE,
  RegzReferencePolicy,
  drawRegzTask,
  executeRegzTool,
  expectedRegz,
  fairToGrade,
  generateRegzSuite,
  generateRegzTask,
  gradeRegzAgainst,
  parseRegzSubmission,
  regzPayload,
  regzPriceTests,
  type RegzTask,
} from "../regz/index.js";

/** A plain $300,000 purchase at 70% of value: the base the edge cases below change one thing of. */
const base: RegzTask = {
  id: "regz-price-tests/hand/0/0",
  split: "spec",
  suite_seed: 0,
  index: 0,
  rate_quoted_at: "2026-06-10T15:00:00.000Z",
  loan: {
    purpose: "purchase",
    amount_cents: 30_000_000,
    note_rate_pct: "6.500",
    term_months: 360,
    amortization: "Fixed",
    prepayment_penalty: false,
  },
  property: {
    value_cents: 42_857_200,
    property_type: "single_family",
    occupancy: "primary_residence",
  },
  fees: [
    { name: "Origination fee", payee: "lender", percent_of_loan_amount: "1" },
    { name: "Underwriting fee", payee: "lender", amount_cents: 109_500 },
    { name: "Appraisal fee", payee: "third_party", amount_cents: 65_000 },
    { name: "Recording fees", payee: "government", amount_cents: 14_500 },
  ],
  atr_documented: true,
  existing_loan: null,
};
const withLoan = (t: RegzTask, l: Partial<RegzTask["loan"]>): RegzTask => ({
  ...t,
  loan: { ...t.loan, ...l },
});
const withProperty = (t: RegzTask, p: Partial<RegzTask["property"]>): RegzTask => ({
  ...t,
  property: { ...t.property, ...p },
});
const aporFor = (weekOf: string, years: number) => {
  const week = APOR_TABLE.weeks.find((w) => w.weekOf === weekOf)!;
  return week.fixed[APOR_TABLE.termYears.indexOf(years)]!.toFixed(2);
};

const solveAll = async (tasks: readonly RegzTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(regzPriceTests, task, new RegzReferencePolicy());
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return misses;
};

describe("regz-price-tests", () => {
  describe("hand-worked quotes give the regulation's answers", () => {
    it("prices the fees by who keeps them, and measures percentages against the total loan amount", () => {
      const a = expectedRegz(base);
      // 1% of $300,000 + $1,095 kept; $650 appraisal and $145 recording paid on.
      expect(a.points_and_fees_cents).toBe("409500");
      expect(a.prepaid_finance_charges_cents).toBe("409500");
      expect(a.closing_cost_total_cents).toBe("489000");
      expect(a.total_loan_amount_cents).toBe("29590500");
      // $137,958 or more: 3% of the total loan amount, $8,877.15.
      expect(a.points_and_fees_limit_cents).toBe("887715");
      expect(a.apor_pct).toBe(aporFor("2026-06-08", 30));
    });

    it("moves a tier a dollar either side of its bound", () => {
      const at = expectedRegz(withLoan(base, { amount_cents: 13_795_800 }));
      const under = expectedRegz(withLoan(base, { amount_cents: 13_795_700 }));
      expect(Number(at.points_and_fees_limit_cents)).toBe(
        Math.round((Number(at.total_loan_amount_cents) * 3) / 100),
      );
      expect(under.points_and_fees_limit_cents).toBe("413900");
    });

    it("reads a Sunday-night quote on New York's calendar, in the week before", () => {
      // 02:30 UTC on Monday 16 March is 22:30 on Sunday 15 March in New York (daylight time since the 8th).
      const sunday = withLoan(base, {});
      const t = { ...sunday, rate_quoted_at: "2026-03-16T02:30:00.000Z" };
      expect(JSON.parse(executeRegzTool("new_york_date", { instant: t.rate_quoted_at })).date).toBe(
        "2026-03-15",
      );
      expect(expectedRegz(t).apor_pct).toBe(aporFor("2026-03-09", 30));
    });

    it("refuses an APR above 80% of value and for an adjustable rate, and decides nothing on it", () => {
      const at80 = expectedRegz(withProperty(base, { value_cents: 37_500_000 }));
      expect(at80.apr_pct).not.toBeNull();
      const over = expectedRegz(withProperty(base, { value_cents: 37_499_900 }));
      expect(over).toMatchObject({
        apr_pct: null,
        qm_status: null,
        is_hpml: null,
        hoepa_apr_trigger: null,
      });
      const arm = expectedRegz(withLoan(base, { amortization: "AdjustableRate" }));
      expect(arm).toMatchObject({ apr_pct: null, apor_pct: null, qm_status: null, is_hpml: null });
      // No rate trigger to read, so not high-cost cannot be concluded unless a fee fires.
      expect(arm.is_high_cost).toBeNull();
    });

    it("keeps HPML and HOEPA off a second home while still pricing its fee trigger", () => {
      const a = expectedRegz(withProperty(base, { occupancy: "second_home" }));
      expect(a).toMatchObject({ is_hpml: null, hoepa_apr_trigger: null, is_high_cost: null });
      expect(a.qm_status).not.toBeNull();
      expect(typeof a.hoepa_fee_trigger).toBe("boolean");
    });

    it("cannot decide HOEPA on a prepayment penalty whose terms are not on file", () => {
      const a = expectedRegz(withLoan(base, { prepayment_penalty: true }));
      expect(a.hoepa_prepayment_penalty_trigger).toBeNull();
      expect(a.is_high_cost).toBeNull();
    });

    it("measures a refinance's benefit on principal and interest only", () => {
      const refi = (basis: "principal_and_interest" | "scheduled_payment", paymentCents: number) =>
        expectedRegz({
          ...withLoan(base, { purpose: "rate_term_refinance" }),
          existing_loan: {
            monthly_payment_cents: paymentCents,
            payment_basis: basis,
            rate_pct: "7.500",
          },
        });
      // The new payment on $300,000 at 6.5% over 360 months is $1,896.20.
      const saving = refi("principal_and_interest", 199_620);
      expect(saving).toMatchObject({ ntb_recoup_months: "48.9", ntb_satisfied: true });
      expect(refi("principal_and_interest", 189_620)).toMatchObject({
        ntb_recoup_months: null,
        ntb_satisfied: false,
      });
      expect(refi("scheduled_payment", 250_000)).toMatchObject({
        ntb_recoup_months: null,
        ntb_satisfied: null,
      });
    });

    it("gives no benefit test on a purchase, and calls an undocumented ability to repay non-QM", () => {
      expect(expectedRegz(base)).toMatchObject({ ntb_recoup_months: null, ntb_satisfied: null });
      expect(expectedRegz({ ...base, atr_documented: false }).qm_status).toBe("non_qm");
    });
  });

  it("fails an answer one cent off on exactly that field, and reads a submission strictly", () => {
    const want = expectedRegz(base);
    const g = gradeRegzAgainst(want, { ...want, points_and_fees_limit_cents: "887716" });
    expect(g.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual([
      "points_and_fees_limit_cents",
    ]);
    expect(parseRegzSubmission(want).ok).toBe(true);
    expect(parseRegzSubmission({ ...want, apr_pct: "6.6" }).ok).toBe(false);
    expect(parseRegzSubmission({ ...want, points_and_fees_pass: null }).ok).toBe(false);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the hand-worked quotes", async () => {
    expect(
      await solveAll([
        base,
        ...generateRegzSuite("heldout", REGZ_HELDOUT_SUITE.seed, REGZ_HELDOUT_SUITE.n),
      ]),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    expect(await solveAll(generateRegzSuite("train", 11, 300))).toEqual([]);
  }, 120_000);

  it("is fair to grade on almost every first draw", () => {
    const draws = Array.from({ length: 1000 }, (_, i) => drawRegzTask("train", 3, i));
    expect(draws.filter((d) => d.attempts > 1).length).toBeLessThan(30);
    expect(fairToGrade(base)).toBe(true);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump REGZ_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateRegzSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"1d31284a726c0a8b0a3068e3bfcc9158abaaf50dcf8eec7608b2935ff48a9640"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out quote into training", () => {
    expect(toJsonLine(generateRegzTask("train", 7, 17))).toBe(
      toJsonLine(generateRegzSuite("train", 7, 30)[17]),
    );
    const fp = (t: RegzTask) => toJsonLine(regzPayload(t));
    const held = new Set(generateRegzSuite("heldout", 1, 200).map(fp));
    expect(generateRegzSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each test's answers all turn up", () => {
    const answers = generateRegzSuite("train", 1, 1500).map((t) => ({ t, a: expectedRegz(t) }));
    const seen = (f: (x: (typeof answers)[number]) => unknown) =>
      new Set(answers.map((x) => String(f(x))));
    const count = (f: (x: (typeof answers)[number]) => boolean) => answers.filter(f).length;

    it("draws yes, no and cannot-decide for QM, HPML and high-cost", () => {
      expect(seen(({ a }) => a.qm_status)).toEqual(new Set(["qm", "non_qm", "null"]));
      expect(seen(({ a }) => a.is_hpml)).toEqual(new Set(["true", "false", "null"]));
      expect(seen(({ a }) => a.is_high_cost)).toEqual(new Set(["true", "false", "null"]));
      expect(seen(({ a }) => a.ntb_satisfied)).toEqual(new Set(["true", "false", "null"]));
    });

    it("draws the edges: tier bounds, the jumbo line, 80% of value, Sunday nights, manufactured homes", () => {
      const bounds = [1_724_500, 2_759_200, 8_277_500, 13_795_800, 83_275_000];
      expect(
        count(({ t }) => bounds.some((b) => Math.abs(t.loan.amount_cents - b) <= 100)),
      ).toBeGreaterThan(300);
      expect(
        count(({ t }) => t.loan.amount_cents * 100 === t.property.value_cents * 80),
      ).toBeGreaterThan(0);
      expect(
        count(({ t }) => {
          const d = JSON.parse(
            executeRegzTool("new_york_date", { instant: t.rate_quoted_at }),
          ).date;
          return d !== t.rate_quoted_at.slice(0, 10);
        }),
      ).toBeGreaterThan(200);
      expect(
        count(({ t, a }) => t.property.property_type === "manufactured" && a.qm_status === "qm"),
      ).toBeGreaterThan(20);
      expect(count(({ a }) => a.hoepa_fee_trigger)).toBeGreaterThan(100);
      expect(count(({ a }) => !a.points_and_fees_pass)).toBeGreaterThan(100);
    });

    it("draws spreads within a tenth of a point of each bright line", () => {
      const near = (line: number) =>
        count(
          ({ a }) =>
            a.apr_pct !== null &&
            a.apor_pct !== null &&
            Math.abs(Number(a.apr_pct) - Number(a.apor_pct) - line) <= 0.1,
        );
      expect(near(1.5)).toBeGreaterThan(100);
      expect(near(2.25)).toBeGreaterThan(60);
      expect(near(6.5)).toBeGreaterThan(30);
    });
  });
});
