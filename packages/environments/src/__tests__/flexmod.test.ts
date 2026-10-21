/**
 * flexmod-terms: the grader is the servicing app's waterfall and no other
 * (the port is its file byte for byte but the imports' paths), and the
 * conventions it restates are held to the service's own lines; it gives
 * §12.8's worked example to the cent, and settles the rounding ties the
 * rulebook specifies as the engine does; the rulebook followed through the
 * tools lands where the engine does on every generated loan and on
 * unfiltered draws the generator's guard never saw; and each outcome, edge
 * and configuration that decides an answer turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daysBetween } from "@hm/kernel/calendar";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  FLEX_HELDOUT_SUITE,
  FlexReferencePolicy,
  analyzeFlex,
  annuityPrincipal,
  drawFlexCandidate,
  drawFlexTask,
  executeFlexTool,
  expectedFlex,
  flexPayload,
  flexInScope,
  flexSpecTasks,
  flexSteps,
  flexTaskId,
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
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));

const lossmit = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/src/domain/lossmit/${file}`), "utf8").split("\n");
/** A service function, whole, with the lines the grader cites it by. */
const serviceFunction = (file: string, name: string) => {
  const lines = lossmit(file);
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (start < 0 || end < 0) return `${file}: no function ${name}`;
  return [`${file}:${start + 1}-${end + 1}`, ...lines.slice(start, end + 1)].join("\n");
};
/** A run of service lines, found by how the first begins, with the lines the grader cites them by. */
const serviceLines = (file: string, first: string, n: number) => {
  const lines = lossmit(file);
  const start = lines.findIndex((l) => l.trimStart().startsWith(first));
  if (start < 0) return `${file}: no line beginning ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...lines.slice(start, start + n)].join("\n");
};

/** The fields where the rulebook, followed through the tools, lands somewhere other than the engine. */
const byRulesMisses = (task: FlexTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(flexSteps, JSON.parse(JSON.stringify(flexPayload(task))), executeFlexTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseFlexSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeFlexAgainst(expectedFlex(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const [SPEC] = flexSpecTasks() as [FlexTask];
/** The worked example with some of its loan changed. */
const specWith = (loan: Partial<FlexTask["loan"]>, rest: Partial<FlexTask> = {}): FlexTask => ({
  ...SPEC,
  ...rest,
  loan: { ...SPEC.loan, ...loan },
});

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
  it("grades with the servicing app's waterfall: the port is its file but for the imports' paths", () => {
    const original = readFileSync(
      here("../../../../apps/servicing/src/domain/lossmit/flexmod.ts"),
      "utf8",
    );
    const port = readFileSync(here("../flexmod/ported/flexmod.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(original));
    // The same names, imported the same way, from the kernel the servicing app's copy is.
    expect(importHeads(port)).toEqual(importHeads(original));
    expect(importHeads(port)).toHaveLength(4);
    expect(imports(port).join("\n")).toMatch(
      /^(import .* from "@hm\/kernel\/(money|calendar)";\n?){4}$/,
    );
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
    // Both at once: the failed trial is checked first (ops-12-8.ts:153, before :154-155), and ends it.
    const both = {
      ...spec!,
      prior_modifications: 3,
      last_trial_failed_on: addDaysIso(spec!.evaluation_on, -364) as never,
    };
    expect(expectedFlex(both).denial_reason).toBe("FNMA_D23206_TRIAL_FAILED_12M");
    expect(byRulesMisses(both)).toEqual([]);
    // $1,860.00 over 60 months is $31.00; half a cent rounds up.
    expect(shortageMonthly(186_000n)).toBe(3_100n);
    expect(shortageMonthly(30n)).toBe(1n);
    // The closed-form principal is the engine's solve before its verify loop: $215,921.99 here.
    expect(annuityPrincipal(126_413n, "6.500", 480)).toBe(21_592_199n);
  });

  it("holds the conventions it restates to the service's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(serviceLines("ops-12-8.ts", "if (i.last_trial_failed_on && daysBetween(", 3))
      .toMatchInlineSnapshot(`
      "ops-12-8.ts:153-155
          if (i.last_trial_failed_on && daysBetween(i.last_trial_failed_on, i.evaluation_on) < 365) return deny(\`no failed Flex Modification Trial Period Plan within the last 12 months (failed \${i.last_trial_failed_on})\`, "FNMA_D23206_TRIAL_FAILED_12M");
          const three = flexEligibilityDenial({ prior_modifications: i.prior_modifications, reviewer_approval_id: i.reviewer_approval_id ?? null, tier: i.tier ?? "ge_90", first_filing_made: i.first_filing_made === true });
          if (three.denied) return deny(three.criterion, "FNMA_D23206_THREE_PRIOR_MODS", { reviewer_approval_id: i.reviewer_approval_id ?? null });"
    `);
    expect(serviceFunction("ops.ts", "flexEligibilityDenial")).toMatchInlineSnapshot(`
      "ops.ts:633-637
      export function flexEligibilityDenial(i: { prior_modifications: number; reviewer_approval_id?: string | null; tier: "ge_90" | "lt_90" | "le_37"; first_filing_made: boolean; rendered_text?: string | null }): { denied: boolean; criterion: string; notice: ReturnType<typeof denialNoticeContent> | null; reviewer_required: boolean; appeal_rights: boolean } {
        if (i.prior_modifications < 3) return { denied: false, criterion: "", notice: null, reviewer_required: false, appeal_rights: false };
        const criterion = "the mortgage loan has not been modified three or more times previously";
        return { denied: true, criterion, notice: denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, reviewer_approval_id: i.reviewer_approval_id ?? null, rendered_text: i.rendered_text ?? null }), reviewer_required: true, appeal_rights: appealEligible(i.tier, i.first_filing_made, true) };
      }"
    `);
    expect(serviceFunction("ops.ts", "mirLookup")).toMatchInlineSnapshot(`
      "ops.ts:640-644
      export function mirLookup(table: readonly { effective: PlainDate; rate_pct: string }[], evaluationOn: PlainDate): { rate_pct: string | null; effective: PlainDate | null; refusal: string | null; escalation: Escalation | null } {
        const rows = table.filter((r) => r.effective <= evaluationOn).sort((a, b) => (a.effective < b.effective ? 1 : -1));
        if (!rows.length) return { rate_pct: null, effective: null, refusal: \`waterfall refused: no Modification Interest Rate effective on \${evaluationOn}\`, escalation: { kind: "officer", severity: "sev2", reason: \`MIR feed has no rate for \${evaluationOn}\` } };
        return { rate_pct: rows[0]!.rate_pct, effective: rows[0]!.effective, refusal: null, escalation: null };
      }"
    `);
    expect(serviceFunction("ops.ts", "escrowShortageSpread")).toMatchInlineSnapshot(`
      "ops.ts:535-540
      export function escrowShortageSpread(shortageCents: Cents, election: { kind: "default_60" } | { kind: "lump_sum" } | { kind: "shorter"; months: number }): { months: number; monthly_cents: Cents; lump_sum_cents: Cents; basis: string } {
        if (election.kind === "lump_sum") return { months: 0, monthly_cents: 0n, lump_sum_cents: shortageCents, basis: "B-1-01: borrower elected to pay the escrow shortage in a lump sum up-front" };
        const months = election.kind === "default_60" ? 60 : election.months;
        if (!Number.isInteger(months) || months < 12 || months > 60) throw new RangeError(\`B-1-01: a shorter escrow shortage repayment period must be not less than 12 months and not more than 60 (got \${months})\`);
        return { months, monthly_cents: divRound(shortageCents, BigInt(months), "HALF_UP"), lump_sum_cents: 0n, basis: months === 60 ? "B-1-01: equal monthly payments over 60 months" : \`B-1-01: borrower elected a shorter period of \${months} months (not less than 12)\` };
      }"
    `);
  });

  it("settles the rounding ties the rulebook specifies as the engine does", () => {
    // MTMLTV exactly 50.005 (gross 10,001 × 2,514, value 20,000 × 2,514) rounds up to 50.01, so step 5
    // runs and b binds; half even would print 50.00 and forbear nothing.
    const over = specWith({ servicing_advances_cents: 19_983n, value_cents: 50_280_000n });
    expect(expectedFlex(over)).toMatchObject({
      gross_upb_cents: "25142514",
      mtmltv_pct: "50.01",
      forborne_cents: "2514",
      post_mod_ib_mtmltv_pct: "50.00",
      exhaustion_offer: true,
    });
    // MTMLTV exactly 49.995 rounds up to 50.00, so step 3 lowers a rate above the MIR to it; cut to
    // 49.99, it would not.
    const under = specWith({
      servicing_advances_cents: 14_955n,
      value_cents: 50_280_000n,
      contract_rate_pct: "7.000",
    });
    expect(expectedFlex(under)).toMatchObject({
      gross_upb_cents: "25137486",
      mtmltv_pct: "50.00",
      rate_pct: "6.625",
      forborne_cents: "0",
    });
    // c at exactly half a cent: 30% of 25,140,535 is 7,542,160.5, which rounds up, and binds.
    const half = specWith({ pre_mod_pi_cents: 100_000n, servicing_advances_cents: 18_004n });
    expect((25_140_535n * 30n) % 100n).toBe(50n);
    expect(expectedFlex(half)).toMatchObject({
      gross_upb_cents: "25140535",
      forborne_cents: "7542161",
    });
    expect(analyzeFlex(half).waterfall?.forbearance_caps).toEqual({
      a: 11_476_163n,
      b: 10_640_535n,
      c: 7_542_161n,
    });
    // reduction_pct at an exact half: (126,080 − 103,031) × 100 ÷ 126,080 is 18.28125, which rounds up;
    // (66,944 − 103,031) × 100 ÷ 66,944 is −53.90625, which rounds away from zero.
    const reduced = specWith({ pre_mod_pi_cents: 126_080n });
    expect(expectedFlex(reduced)).toMatchObject({ pi_cents: "103031", reduction_pct: "18.2813" });
    const raised = specWith({ pre_mod_pi_cents: 66_944n });
    expect(expectedFlex(raised)).toMatchObject({
      denial_reason: "INV_FNMA_F127_PI_RULE",
      pi_cents: "103031",
      reduction_pct: "-53.9063",
    });
    // And the rulebook, followed through the tools, lands on every one of them.
    expect([over, under, half, reduced, raised].flatMap(byRulesMisses)).toEqual([]);
  });

  it("decides a P&I equal to the pre-mod by delinquency: offered at 31+ days, denied below", () => {
    // Exhausted at $1,030.31 (c binds, 480 months, 6.500%), with the pre-mod at exactly that.
    const delinquent = specWith({ pre_mod_pi_cents: 103_031n });
    expect(expectedFlex(delinquent)).toMatchObject({
      decision: "offer",
      target_pi_cents: "82424",
      forborne_cents: "7542159",
      pi_cents: "103031",
      reduction_pct: "0.0000",
      exhaustion_offer: true,
      trial_months: 3,
    });
    const current = specWith({ pre_mod_pi_cents: 103_031n, delinquent_31_plus: false });
    expect(expectedFlex(current)).toMatchObject({
      decision: "denied",
      denial_reason: "INV_FNMA_F127_PI_RULE",
      pi_cents: "103031",
      reduction_pct: "0.0000",
      exhaustion_offer: null,
      trial_months: null,
    });
    expect([delinquent, current].flatMap(byRulesMisses)).toEqual([]);
  });

  it("keeps out a remaining term over 480 (flexmod-1), and only that", () => {
    // §12.8's worked example at 500 months left: the engine keeps 500, where F-1-27 step 4 ends
    // the term at 480 months from the effective date.
    const long = specWith({ remaining_term_months: 500 });
    expect(expectedFlex(long).term_months).toBe(500);
    expect(flexInScope(long)).toBe(false);
    expect(flexInScope(specWith({ remaining_term_months: 481 }))).toBe(false);
    // At 480 the engine and F-1-27 agree: nothing to extend.
    const full = specWith({ remaining_term_months: 480 });
    expect(expectedFlex(full).term_months).toBe(480);
    expect(flexInScope(full)).toBe(true);
    expect(byRulesMisses(full)).toEqual([]);
  });

  it("keeps out an ARM's rate above its cap (flexmod-2), and only that", () => {
    // A step-rate loan at 3.000% whose final step is 4.250%, with the MIR at 6.625%: the engine
    // takes the MIR; F-1-27 step 2 caps the rate at the final step.
    const stepRate = (rate_cap_pct: string | null) =>
      specWith({
        ib_upb_cents: 18_000_000n,
        accrued_interest_cents: 0n,
        escrow_advances_cents: 0n,
        servicing_advances_cents: 0n,
        contract_rate_pct: "3.000",
        is_arm_not_final: true,
        rate_cap_pct,
        remaining_term_months: 300,
        pre_mod_pi_cents: 85_358n,
      });
    expect(analyzeFlex(stepRate("4.250")).waterfall?.trace[1]).toBe("step2 rate=6.625");
    expect(flexInScope(stepRate("4.250"))).toBe(false);
    expect(flexInScope(stepRate("6.624"))).toBe(false);
    // An ARM must carry its cap to be evaluated at all.
    expect(flexInScope(stepRate(null))).toBe(false);
    // A cap on the MIR, or above it, does not bind: the engine and F-1-27 agree, and so does the
    // rulebook, followed through the tools.
    for (const cap of ["6.625", "9.000"]) {
      expect(flexInScope(stepRate(cap))).toBe(true);
      expect(byRulesMisses(stepRate(cap))).toEqual([]);
    }
    // A fixed rate carries no cap.
    expect(flexInScope(SPEC)).toBe(true);
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

  it("is fair to grade on every first draw, and stays out of the waterfall's departures from F-1-27", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawFlexTask("train", 3, i));
    expect(draws.filter((d) => d.attempts > 1).map((d) => d.task.id)).toEqual([]);
    expect(draws.filter((d) => !flexInScope(d.task)).map((d) => d.task.id)).toEqual([]);
  });

  it("agrees with the engine on unfiltered draws: the rulebook, not the guard, makes the suites fair", () => {
    // Candidates exactly as the generator draws them, before its guard has kept or redrawn any.
    const candidates = Array.from({ length: 2000 }, (_, i) => {
      const id = flexTaskId("train", 5, i);
      return drawFlexCandidate(rngFor(id), id, "train", 5, i);
    });
    expect(candidates.filter((t) => !flexInScope(t)).map((t) => t.id)).toEqual([]);
    expect(candidates.flatMap(byRulesMisses)).toEqual([]);
  }, 120_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump FLEX_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateFlexSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"59518c8bea391723e13802c163ba2f578c5cb9d441ae85df74d0fd5db5df0807"`);
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
    const runs = generateFlexSuite("train", 1, 1500).map((t) => ({
      t,
      a: expectedFlex(t),
      w: analyzeFlex(t).waterfall,
    }));
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
      // An ARM whose rate step 2 sets is exactly its cap, lifted to the MIR or its own rate.
      const onCap = ({ t, w }: (typeof runs)[number]) =>
        t.loan.is_arm_not_final && w?.trace[1] === `step2 rate=${t.loan.rate_cap_pct}`;
      const lifted = ({ t, a }: (typeof runs)[number]) =>
        Number(t.loan.contract_rate_pct) < Number(a.mir_pct);
      expect(count((x) => onCap(x) && lifted(x))).toBeGreaterThan(10);
      expect(count((x) => onCap(x) && !lifted(x))).toBeGreaterThan(5);
      expect(count(({ t }) => t.loan.is_arm_not_final !== (t.loan.rate_cap_pct !== null))).toBe(0);
    });

    it("draws a rate-table row effective on the evaluation date, notices on the 15th and 16th, and December notices", () => {
      expect(
        count(({ t }) => t.mir_table.some((r) => r.effective === t.evaluation_on)),
      ).toBeGreaterThan(150);
      expect(count(({ t }) => t.trial.notice_sent_on.endsWith("-15"))).toBeGreaterThan(30);
      expect(count(({ t }) => t.trial.notice_sent_on.endsWith("-16"))).toBeGreaterThan(30);
      expect(count(({ t }) => t.trial.notice_sent_on.slice(5, 7) === "12")).toBeGreaterThan(60);
      // The service sends the notice only once the evaluation has made the loan eligible.
      expect(count(({ t }) => t.trial.notice_sent_on < t.evaluation_on)).toBe(0);
    });

    it("draws a P&I equal to the pre-mod after the waterfall is exhausted, delinquent and not", () => {
      const tie = ({ t, a }: (typeof runs)[number]) =>
        a.pi_cents === String(t.loan.pre_mod_pi_cents) && a.pi_cents !== a.target_pi_cents;
      expect(count((x) => tie(x) && x.a.decision === "offer")).toBeGreaterThan(5);
      expect(count((x) => tie(x) && x.a.denial_reason === "INV_FNMA_F127_PI_RULE")).toBeGreaterThan(
        5,
      );
    });

    it("draws the configurations that decide an answer", () => {
      type Run = (typeof runs)[number];
      // Exact MTMLTV against 50: positive above, negative below.
      const exact = ({ t, w }: Run) => (w ? w.gross_upb_cents * 2n - t.loan.value_cents : 0n);
      const daysBack = ({ t }: Run) =>
        t.last_trial_failed_on && daysBetween(t.last_trial_failed_on, t.evaluation_on);
      const binds =
        (cap: "a" | "b" | "c") =>
        ({ w }: Run) => {
          const caps = w?.forbearance_caps;
          if (!caps) return false;
          const others = (["a", "b", "c"] as const).filter((k) => k !== cap).map((k) => caps[k]);
          return w.forborne_cents === caps[cap] && others.every((o) => caps[cap] < o);
        };
      // Below 50 exactly, 50.00 printed, so step 3 lowers the rate.
      expect(
        count(
          (x) =>
            x.a.mtmltv_pct === "50.00" &&
            exact(x) < 0n &&
            x.a.rate_pct !== null &&
            Number(x.a.rate_pct) < Number(x.t.loan.contract_rate_pct),
        ),
      ).toBeGreaterThan(4);
      // Above 50 exactly, 50.00 printed, still above the target after step 4: nothing is forborne.
      expect(
        count(
          (x) =>
            x.a.mtmltv_pct === "50.00" &&
            exact(x) > 0n &&
            x.w !== null &&
            x.w.pi_cents > x.w.target_pi_cents &&
            x.a.forborne_cents === "0",
        ),
      ).toBeGreaterThan(8);
      // The rate alone reaches the target and stops above the MIR.
      expect(
        count(
          ({ t, a }) =>
            a.decision === "offer" &&
            a.exhaustion_offer === false &&
            Number(a.rate_pct) < Number(t.loan.contract_rate_pct) &&
            Number(a.rate_pct) > Number(a.mir_pct) &&
            a.term_months === t.loan.remaining_term_months &&
            a.forborne_cents === "0",
        ),
      ).toBeGreaterThan(30);
      // A failed trial 364 days back bars the loan; 365 days back, the evaluation goes on.
      expect(
        count((x) => daysBack(x) === 364 && x.a.denial_reason === "FNMA_D23206_TRIAL_FAILED_12M"),
      ).toBeGreaterThan(10);
      expect(count((x) => daysBack(x) === 365 && x.a.mir_pct !== null)).toBeGreaterThan(10);
      // Fewer than 31 days delinquent: four trial months.
      expect(count(({ a }) => a.decision === "offer" && a.trial_months === 4)).toBeGreaterThan(80);
      // A loan modified to 480 months before, more than 360 left, which step 4 extends to 480 at
      // most; never more than 480 left, and never without the earlier modification.
      const modified = ({ t }: Run) => t.loan.remaining_term_months > 360;
      expect(count((x) => modified(x) && x.a.mir_pct !== null)).toBeGreaterThan(10);
      expect(count((x) => modified(x) && x.a.term_months === 480)).toBeGreaterThan(5);
      expect(count(({ t }) => t.loan.remaining_term_months > 480)).toBe(0);
      expect(count((x) => modified(x) && x.t.prior_modifications === 0)).toBe(0);
      // Each forbearance cap binding alone.
      expect(count(binds("a"))).toBeGreaterThan(100);
      expect(count(binds("b"))).toBeGreaterThan(30);
      expect(count(binds("c"))).toBeGreaterThan(30);
      // A shortage 60 months spreads into exactly half a cent over.
      expect(
        count(({ t, a }) => a.decision === "offer" && t.trial.escrow_shortage_cents % 60n === 30n),
      ).toBeGreaterThan(40);
    });
  });
});

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
