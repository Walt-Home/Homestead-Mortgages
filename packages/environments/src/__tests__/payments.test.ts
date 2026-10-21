/**
 * payments-posting: the grader is the servicing app's cashiering and no
 * other (each port is its file byte for byte but the imports); it gives
 * spec §2's worked examples to the cent; every generated month can be posted
 * from the rulebook and the tools; and each outcome and edge turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import {
  PAYMENTS_HELDOUT_SUITE,
  PAYMENT_EDGES,
  PaymentsReferencePolicy,
  drawPaymentsCandidate,
  drawPaymentsTask,
  expectedPayments,
  generatePaymentsSuite,
  generatePaymentsTask,
  gradePaymentsAgainst,
  parsePaymentsSubmission,
  paymentEdgeOf,
  paymentsFairToGrade,
  paymentsInScope,
  paymentsPayload,
  paymentsPosting,
  paymentsSpecTasks,
  paymentsTaskId,
  type PaymentsTask,
} from "../payments/index.js";
import { rngFor } from "../rng.js";
import { graceEndFor } from "../payments/ported/latecharges.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const lines = (text: string, imports: boolean) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("import ") === imports)
    .join("\n");
/** The one rewrite a port may carry: the kernel's paths become the package's, a sibling's .ts its .js. */
const rewritten = (imports: string) =>
  imports
    .replace(/"\.\.\/\.\.\/kernel\/(calendar|money|fsm|events)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
    .replace(/"\.\/([a-z-]+)\.ts"/g, '"./$1.js"');

const solveAll = async (tasks: readonly PaymentsTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(paymentsPosting, task, new PaymentsReferencePolicy());
    turns = Math.max(turns, r.turns);
    calls = Math.max(calls, r.tool_calls);
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return { misses, turns, calls };
};

describe("payments-posting", () => {
  it("grades with the servicing app's cashiering: each port is its file but for the imports", () => {
    for (const file of ["types", "biweekly", "allocation", "latecharges"]) {
      const original = readFileSync(
        here(`../../../../apps/servicing/src/domain/cashiering/${file}.ts`),
        "utf8",
      );
      const port = readFileSync(here(`../payments/ported/${file}.ts`), "utf8");
      expect(lines(port, false), file).toBe(lines(original, false));
      expect(lines(port, true), file).toBe(rewritten(lines(original, true)));
    }
  });

  describe("gives spec §2's worked examples to the cent", () => {
    const [a, km, d, f, g, l, n] = paymentsSpecTasks().map(expectedPayments);

    it("A: a full payment is interest, principal and escrow, and no late charge", () => {
      expect(a!.receipts[0]).toMatchObject({
        outcome: "applied",
        installments: [
          {
            due_date: "2026-09-01",
            kind: "contractual",
            interest_cents: "135294",
            principal_cents: "22723",
            escrow_cents: "61240",
          },
        ],
      });
      expect(a!.final).toMatchObject({ upb_cents: "24954677", lpi_date: "2026-09-01" });
      expect(a!.late_charge_runs).toEqual([
        {
          installment_due_date: "2026-09-01",
          run_on: "2026-09-17",
          outcome: "not_assessed",
          amount_cents: null,
        },
      ]);
    });

    it("K and M: unpaid at the grace end is $79.01, and an on-time October earns nothing more", () => {
      expect(km!.late_charge_runs.map((r) => [r.run_on, r.outcome, r.amount_cents])).toEqual([
        ["2026-09-17", "assessed", "7901"],
        ["2026-10-17", "not_assessed", null],
      ]);
      expect(km!.receipts.map((r) => r.late_charge_paid_cents)).toEqual(["0", "0"]);
      expect(km!.receipts[1]!.installments[0]!.principal_cents).toBe("22846");
      expect(km!.final.late_charges_due_cents).toBe("7901");
    });

    it("D: $42.57 short is the $50 rule, out of escrow, and the counter rises", () => {
      expect(d!.receipts[0]).toMatchObject({
        outcome: "applied_with_50_rule",
        installments: [{ escrow_cents: "56983", interest_cents: "135294" }],
      });
      expect(d!.final.partial_count_12m).toBe(2);
    });

    it("F: $1,000.00 marked principal curtails after the installment, and October's interest falls", () => {
      expect(f!.receipts[0]).toMatchObject({ outcome: "applied", curtailment_cents: "100000" });
      expect(f!.receipts[1]!.installments[0]).toMatchObject({
        interest_cents: "134630",
        principal_cents: "23387",
      });
    });

    it("G: principal only on a delinquent loan cures September and holds the rest", () => {
      expect(g!.receipts[0]).toMatchObject({
        outcome: "applied",
        redirected_curtailment: true,
        curtailment_cents: "0",
        to_suspense_cents: "80743",
      });
      expect(g!.late_charge_runs.map((r) => r.amount_cents)).toEqual(["7901", "7901"]);
    });

    it("L: the transfer shield; N: forbearance until the default", () => {
      expect(l!.late_charge_runs[0]!.outcome).toBe("not_assessed");
      expect(n!.late_charge_runs.map((r) => [r.installment_due_date, r.outcome])).toEqual([
        ["2026-10-01", "not_assessed"],
        ["2026-11-01", "not_assessed"],
        ["2026-12-01", "assessed"],
      ]);
    });
  });

  it("restates the engine where it departs from its spec, and the conventions it runs on", () => {
    const [a] = paymentsSpecTasks();
    // Example C: $2,000.00 held on 09-10, then the run. The spec assesses $79.01; the engine counts
    // what is in suspense toward the installment (its 2.7-Q1 reading), and the rulebook says so.
    const c = expectedPayments({
      ...a!,
      receipts: [
        {
          payment_id: "C",
          amount_cents: 200_000n,
          received_on: "2026-09-10" as never,
          designation: "unspecified",
        },
      ],
    });
    expect(c.receipts[0]).toMatchObject({ outcome: "unapplied", partial_hold: true });
    expect(c.late_charge_runs[0]!.outcome).toBe("not_assessed");
    // A grace end on a Sunday rolls to Monday: August 1 + 15 is Sunday the 16th.
    expect(graceEndFor(a!.loan, "2026-08-01" as never)).toBe("2026-08-17");
    // A refused instruction that also says principal curtails nothing.
    const refused = expectedPayments({
      ...a!,
      receipts: [
        {
          payment_id: "R",
          amount_cents: 229_257n,
          received_on: "2026-09-03" as never,
          designation: "unspecified",
          instruction_text: "apply the extra to principal on my second mortgage",
        },
      ],
    });
    expect(refused.receipts[0]).toMatchObject({
      refused_instruction: true,
      curtailment_cents: "0",
      to_suspense_cents: "10000",
    });
    // Designated principal on a current loan is applied apart: the whole payment curtails.
    const separate = expectedPayments({
      ...a!,
      window: { from: "2026-08-20" as never, through: "2026-08-31" as never },
      receipts: [
        {
          payment_id: "S",
          amount_cents: 219_257n,
          received_on: "2026-08-25" as never,
          designation: "curtailment",
        },
      ],
    });
    expect(separate.receipts[0]).toMatchObject({
      outcome: "curtailment",
      installments: [],
      curtailment_cents: "219257",
    });
  });

  it("fails an answer one cent off on exactly that field, and charges for what is missing or extra", () => {
    const want = expectedPayments(paymentsSpecTasks()[1]!);
    const wrong = (answer: unknown) =>
      gradePaymentsAgainst(want, answer as typeof want)
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    expect(wrong({ ...want, final: { ...want.final, late_charges_due_cents: "7902" } })).toEqual([
      "final.late_charges_due_cents",
    ]);
    expect(wrong({ ...want, late_charge_runs: want.late_charge_runs.slice(1) })).toEqual([
      "late_charge_runs",
      "late_charge[2026-09-01@2026-09-17]",
    ]);
    // A run reported on a day it did not happen is a field of its own, so hedging costs more.
    const hedge = { ...want.late_charge_runs[1]!, run_on: "2026-10-16" };
    expect(wrong({ ...want, late_charge_runs: [...want.late_charge_runs, hedge] })).toEqual([
      "late_charge_runs",
      "late_charge[2026-10-01@2026-10-16]",
    ]);
    // A receipt that never arrived fails the list of receipts.
    const invented = { ...want.receipts[0]!, payment_id: "X" };
    expect(wrong({ ...want, receipts: [...want.receipts, invented] })).toEqual(["receipts"]);
    // One wrong flag is one wrong field: the receipt's remainder.
    const flagged = { ...want.receipts[0]!, partial_hold: true };
    expect(wrong({ ...want, receipts: [flagged, want.receipts[1]!] })).toEqual([
      "receipt[K].remainder",
    ]);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedPayments(paymentsSpecTasks()[1]!);
    const ok = (x: unknown) => parsePaymentsSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok({ ...want, late_charge_runs: undefined })).toBe(false);
    const [k, m] = want.receipts;
    expect(ok({ ...want, receipts: [{ ...k!, curtailment_cents: "12.50" }, m] })).toBe(false);
    expect(ok({ ...want, receipts: [{ ...k!, outcome: "posted" }, m] })).toBe(false);
    expect(ok({ ...want, receipts: [{ ...k!, payment_id: undefined }, m] })).toBe(false);
    expect(ok({ ...want, receipts: [k, k] })).toBe(false);
    expect(ok({ ...want, final: { ...want.final, partial_count_12m: 0.5 } })).toBe(false);
    expect(
      ok({
        ...want,
        final: { ...want.final, installments: [{ due_date: "2026-09-01", status: "paid" }] },
      }),
    ).toBe(false);
    const [assessed, quiet] = want.late_charge_runs;
    expect(ok({ ...want, late_charge_runs: [{ ...assessed!, amount_cents: null }, quiet] })).toBe(
      false,
    );
    expect(ok({ ...want, late_charge_runs: [assessed, { ...quiet!, amount_cents: "0" }] })).toBe(
      false,
    );
    // The order of a receipt's installments is the engine's, and is not graded.
    const two = expectedPayments(paymentsSpecTasks()[4]!);
    const parsed = parsePaymentsSubmission(two);
    expect(parsed.ok && gradePaymentsAgainst(two, parsed.answer).pass).toBe(true);
  });

  it("gives an answer that posts nothing little credit", () => {
    const tasks = generatePaymentsSuite("heldout", 1, 200);
    const scores = tasks.map((t) => {
      const want = expectedPayments(t);
      const nothing = {
        receipts: want.receipts.map((r) => ({
          ...r,
          outcome: "unapplied",
          installments: [],
          late_charge_paid_cents: "0",
          curtailment_cents: "0",
          to_suspense_cents: "0",
          suspense_used_cents: "0",
          partial_hold: false,
          redirected_curtailment: false,
          refused_instruction: false,
        })),
        late_charge_runs: [],
        final: {
          upb_cents: String(t.loan.upb_cents),
          lpi_date: t.loan.lpi_date,
          suspense_cents: String(t.loan.suspense_unapplied_cents),
          late_charges_due_cents: String(t.loan.late_charges_due_cents),
          partial_count_12m: t.loan.partial_count_12m,
          installments: t.loan.installments.map((i) => ({
            due_date: i.due_date,
            status: i.status,
          })),
        },
      };
      return gradePaymentsAgainst(want, nothing as typeof want).score;
    });
    expect(scores.reduce((a, b) => a + b, 0) / scores.length).toBeLessThan(0.45);
  });

  it("puts prepaid ahead of the $50 rule: a short payment before the due date is prepaid", () => {
    const [, , d] = paymentsSpecTasks();
    const early = expectedPayments({
      ...d!,
      window: { from: "2026-08-20" as never, through: "2026-08-31" as never },
      receipts: [{ ...d!.receipts[0]!, received_on: "2026-08-25" as never }],
    });
    expect(early.receipts[0]).toMatchObject({
      outcome: "prepaid",
      installments: [{ kind: "prepaid", escrow_cents: "56983" }],
    });
    expect(early.final.partial_count_12m).toBe(2);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...paymentsSpecTasks(),
      ...generatePaymentsSuite("heldout", PAYMENTS_HELDOUT_SUITE.seed, PAYMENTS_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generatePaymentsSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawPaymentsTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) {
      expect(paymentsInScope(task)).toBe(true);
      expect(task.receipts.every((x) => x.designation !== ("payoff" as never))).toBe(true);
      expect(task.loan.deferred_principal_cents ?? 0n).toBe(0n);
      expect(task.loan.nsf_fees_due_cents + task.loan.other_fees_due_cents).toBe(0n);
    }
  });

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the candidates it would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = paymentsTaskId("train", 99, i);
      const task = drawPaymentsCandidate(rngFor(id), id, "train", 99, i);
      if (!paymentsInScope(task) || !paymentsFairToGrade(task)) unfair.push(id);
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  it("keeps out a month in which the engine does what its spec calls wrong", () => {
    const [a, , d] = paymentsSpecTasks();
    const L = a!.loan;
    const rc = (
      amount: bigint,
      on: string,
      extra: Partial<PaymentsTask["receipts"][number]> = {},
    ) => ({
      payment_id: "R",
      amount_cents: amount,
      received_on: on as never,
      designation: "unspecified" as const,
      ...extra,
    });
    const sept = { from: "2026-09-01" as never, through: "2026-10-31" as never };
    const month = (loan: typeof L, receipts: PaymentsTask["receipts"][number][]) => ({
      ...a!,
      window: sept,
      loan,
      receipts,
    });
    // The months this guard admits: the spec's own examples.
    expect(paymentsSpecTasks().every(paymentsInScope)).toBe(true);
    // A charge assessed under a bankruptcy hold with no suspension.
    expect(paymentsInScope(month({ ...L, holds: ["bankruptcy"] }, []))).toBe(false);
    // Late charges paid while October is still due: September plus $100, received in October.
    const lateLoan = { ...L, late_charges_due_cents: 7_901n };
    expect(paymentsInScope(month(lateLoan, [rc(229_257n, "2026-10-05")]))).toBe(false);
    expect(paymentsInScope(month(lateLoan, [rc(219_257n * 2n + 7_901n, "2026-10-05")]))).toBe(true);
    // The $50 rule ahead of the due date.
    expect(
      paymentsInScope({
        ...d!,
        window: { from: "2026-08-20" as never, through: "2026-08-31" as never },
        receipts: [{ ...d!.receipts[0]!, received_on: "2026-08-25" as never }],
      }),
    ).toBe(false);
    // A partial during a forbearance plan.
    const forbearing = {
      ...L,
      overlays: [{ kind: "forbearance_active" as const, from: "2026-09-01" as never, to: null }],
    };
    expect(paymentsInScope(month(forbearing, [rc(100_000n, "2026-09-10")]))).toBe(false);
    // The shield over an installment nobody paid; and over one the forwarded payment satisfies.
    const shielded = { ...L, transfer_shield_until: "2026-10-30" as never };
    expect(paymentsInScope(month(shielded, []))).toBe(false);
    expect(
      paymentsInScope(
        month(shielded, [
          rc(219_257n, "2026-09-22"),
          { ...rc(219_257n, "2026-10-01"), payment_id: "S" },
        ]),
      ),
    ).toBe(true);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump PAYMENTS_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generatePaymentsSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"3f36154ff44c03c1c417e56e91a96c6a27fe7201b843ce9ab71fab73928f787a"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out month into training", () => {
    expect(toJsonLine(generatePaymentsTask("train", 7, 17))).toBe(
      toJsonLine(generatePaymentsSuite("train", 7, 30)[17]),
    );
    const fp = (t: PaymentsTask) => toJsonLine(paymentsPayload(t));
    const held = new Set(generatePaymentsSuite("heldout", 1, 200).map(fp));
    expect(generatePaymentsSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each outcome and edge turns up", () => {
    const runs = generatePaymentsSuite("train", 1, 1100).map((t, i) => ({
      t,
      a: expectedPayments(t),
      edge: paymentEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (x: Run) => boolean) => runs.filter(f).length;
    const receipts = runs.flatMap(({ t, a }) =>
      a.receipts.map((x) => ({ x, t, r: t.receipts.find((y) => y.payment_id === x.payment_id)! })),
    );
    const lateRuns = runs.flatMap(({ t, a }) => a.late_charge_runs.map((x) => ({ x, t })));

    it("cycles through every edge, a hundred months each", () => {
      expect(new Set(runs.map((x) => x.edge))).toEqual(new Set(PAYMENT_EDGES));
    });

    it("draws every outcome the rulebook names", () => {
      expect(new Set(receipts.map(({ x }) => x.outcome))).toEqual(
        new Set([
          "applied",
          "applied_with_50_rule",
          "curtailment",
          "prepaid",
          "unapplied",
          "held_bk",
          "held_fc",
          "held_dispute",
          "held_other",
        ]),
      );
      expect(new Set(lateRuns.map(({ x }) => x.outcome))).toEqual(
        new Set(["assessed", "accrued_suspended", "not_assessed"]),
      );
    });

    it("draws the remainder each way: curtailed, redirected, refused, late charges, suspense", () => {
      expect(receipts.filter(({ x }) => x.curtailment_cents !== "0").length).toBeGreaterThan(60);
      expect(receipts.filter(({ x }) => x.redirected_curtailment).length).toBeGreaterThan(20);
      expect(receipts.filter(({ x }) => x.refused_instruction).length).toBeGreaterThan(15);
      expect(receipts.filter(({ x }) => x.late_charge_paid_cents !== "0").length).toBeGreaterThan(
        40,
      );
      expect(receipts.filter(({ x }) => x.partial_hold).length).toBeGreaterThan(60);
      expect(receipts.filter(({ x }) => x.suspense_used_cents !== "0").length).toBeGreaterThan(40);
      expect(receipts.filter(({ x }) => x.installments.length >= 2).length).toBeGreaterThan(80);
    });

    it("draws the $50 rule at $50.00 and refused at $50.01, and each loan it does not reach", () => {
      const partials = receipts.filter(
        ({ x }) => x.outcome === "applied_with_50_rule" || x.partial_hold,
      );
      expect(
        partials.filter(({ x }) => x.outcome === "applied_with_50_rule").length,
      ).toBeGreaterThan(20);
      expect(count(({ t }) => t.loan.instrument_date < "1999-03-01")).toBeGreaterThan(5);
      expect(count(({ t }) => t.loan.instrument_date === "1999-03-01")).toBeGreaterThan(2);
      expect(count(({ t }) => t.loan.lien === "second")).toBeGreaterThan(3);
      expect(count(({ t }) => t.loan.opted_out_of_50_rule)).toBeGreaterThan(5);
      expect(count(({ t }) => t.loan.partial_count_12m === 3)).toBeGreaterThan(10);
      const shortBy = (cents: bigint) =>
        receipts.filter(({ t, r }) => {
          const open = t.loan.installments.find((i) => i.status === "due");
          return open && open.pi_cents + open.escrow_cents - r.amount_cents === cents;
        }).length;
      expect(shortBy(5_000n)).toBeGreaterThan(5);
      expect(shortBy(5_001n)).toBeGreaterThan(3);
    });

    it("draws a payment on the grace end and on the day after it, and grace ends that roll", () => {
      const onGraceEnd = receipts.filter(({ t, r }) =>
        t.loan.installments.some((i) => graceEndFor(t.loan, i.due_date) === r.received_on),
      );
      expect(onGraceEnd.length).toBeGreaterThan(40);
      expect(
        lateRuns.filter(
          ({ x, t }) =>
            x.outcome === "assessed" && t.receipts.some((r) => r.received_on === x.run_on),
        ).length,
      ).toBeGreaterThan(20);
      const rolled = lateRuns.filter(({ x, t }) => {
        const plain = new Date(`${x.installment_due_date}T00:00:00Z`);
        plain.setUTCDate(plain.getUTCDate() + (t.loan.late_charge_grace_days ?? 15));
        return (
          graceEndFor(t.loan, x.installment_due_date as never) !== plain.toISOString().slice(0, 10)
        );
      });
      expect(rolled.length).toBeGreaterThan(100);
    });

    it("draws holds and overlays as a servicer would hold them", () => {
      for (const { t, a } of runs) {
        const kinds = (t.loan.overlays ?? []).map((o) => o.kind);
        if (t.loan.holds.includes("bankruptcy")) expect(kinds).toContain("bankruptcy_active");
        if (
          kinds.includes("foreclosure_referred") ||
          t.loan.holds.includes("foreclosure_post_referral")
        ) {
          const oldest = t.loan.installments.find((i) => i.status === "due")!.due_date;
          const days = (Date.parse(t.window.from) - Date.parse(oldest)) / 86_400_000;
          expect(days).toBeGreaterThan(120);
        }
        for (const o of t.loan.overlays ?? [])
          if (o.defaulted_on) {
            expect(o.defaulted_on > o.from).toBe(true);
            if (o.to) expect(o.defaulted_on < o.to).toBe(true);
          }
        expect(t.loan.trial_active).toBe(false);
        expect(a.final.installments.some((i) => i.status === "due")).toBe(true);
      }
    });

    it("draws suspense counted toward a late charge, each overlay, a cap and a PITI basis", () => {
      expect(
        lateRuns.filter(({ x, t }) => {
          const i = t.loan.installments.find((y) => y.due_date === x.installment_due_date)!;
          return (
            x.outcome === "not_assessed" &&
            i.status === "due" &&
            t.loan.suspense_unapplied_cents >= i.pi_cents
          );
        }).length,
      ).toBeGreaterThan(5);
      for (const kind of ["forbearance_active", "bankruptcy_active", "foreclosure_referred"])
        expect(
          count(({ t }) => (t.loan.overlays ?? []).some((o) => o.kind === kind)),
        ).toBeGreaterThan(8);
      expect(count(({ t }) => (t.loan.overlays ?? []).some((o) => o.defaulted_on))).toBeGreaterThan(
        5,
      );
      expect(count(({ t }) => t.loan.transfer_shield_until != null)).toBeGreaterThan(8);
      expect(
        lateRuns.filter(
          ({ x, t }) =>
            t.loan.late_charge_cap_cents != null &&
            x.amount_cents === String(t.loan.late_charge_cap_cents),
        ).length,
      ).toBeGreaterThan(10);
      expect(count(({ t }) => t.loan.late_charge_basis === "piti")).toBeGreaterThan(20);
      expect(count(({ a }) => a.late_charge_runs.length === 0)).toBeGreaterThan(5);
      expect(count(({ a }) => a.late_charge_runs.length >= 2)).toBeGreaterThan(100);
      expect(count(({ t }) => t.receipts.length === 0)).toBeGreaterThan(20);
    });
  });
});
