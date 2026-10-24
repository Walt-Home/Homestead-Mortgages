/**
 * catchup-posting: the grader is the servicing app's cashiering and its
 * late-charge function and no other; it gives the spec's worked examples to
 * the cent; each clean moment posts as the history posted it, and each
 * twin's charges are the clean history's once held to the note; the receipts
 * stay on the pay-in-full route and off the engine's logged defects; every
 * task can be posted from the rulebook and the tool; and each arm and
 * outcome turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addMonths } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import {
  CATCHUP_ARMS,
  CATCHUP_HELDOUT_SUITE,
  CATCHUP_RULEBOOK,
  CATCHUP_SPEC_CASES,
  CATCHUP_TOOLS,
  CatchupReferencePolicy,
  capBreached,
  catchupArmOf,
  catchupFairToGrade,
  catchupInScope,
  catchupPayload,
  catchupPosting,
  catchupSpecTasks,
  catchupTaskId,
  catchupVerdict,
  drawCatchupCandidate,
  drawCatchupTask,
  expectedCatchup,
  generateCatchupSuite,
  generateCatchupTask,
  gradeCatchupAgainst,
  heldToNote,
  historyInScope,
  parseCatchupSubmission,
  postCatchup,
  type CatchupAnswer,
  type CatchupDraw,
  type CatchupTask,
} from "../catchup/index.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const solveAll = async (tasks: readonly CatchupTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(catchupPosting, task, new CatchupReferencePolicy());
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

/** The posting a model would make that took the system's late charges as they stand. */
const trustingTheSystem = (task: CatchupTask): CatchupAnswer =>
  expectedCatchup({ ...task, note: { ...task.note, late_charge: task.servicing.late_charge } });

let heldout: CatchupTask[] | null = null;
const heldoutSuite = () =>
  (heldout ??= generateCatchupSuite(
    "heldout",
    CATCHUP_HELDOUT_SUITE.seed,
    CATCHUP_HELDOUT_SUITE.n,
  ));
let train: CatchupTask[] | null = null;
const trainSuite = () => (train ??= generateCatchupSuite("train", 11, 300));

/** First draws under unfiltered coordinates, the history beside each. */
const candidates = (seed: number, n: number): CatchupDraw[] => {
  const out: CatchupDraw[] = [];
  for (let i = 0; i < n; i++) {
    const id = catchupTaskId("train", seed, i);
    const d = drawCatchupCandidate(rngFor(id), id, "train", seed, i);
    if (d) out.push(d);
  }
  return out;
};

describe("catchup-posting", () => {
  it("grades with the servicing app's late-charge function and allocation engine, ported", () => {
    // The ports payments-posting holds byte for byte to apps/servicing; this grader imports them and nothing else.
    const grader = readFileSync(here("../catchup/grader.ts"), "utf8");
    expect(grader).toContain('from "../payments/ported/allocation.js"');
    expect(grader).toContain('from "../payments/ported/latecharges.js"');
    const original = readFileSync(
      here("../../../../apps/servicing/src/domain/cashiering/latecharges.ts"),
      "utf8",
    ).split("\n");
    expect(original[39]).toMatch(
      /^export function lateChargeAmount\(basisCents: Cents, pct: string, cap: Cents \| null\)/,
    );
    // Step 1 is lateChargeAmount on each charge's basis, the note's percent and the note's cap.
    for (const task of trainSuite().slice(0, 60))
      for (const c of heldToNote(task).charges)
        expect(c.allowed).toBe(
          lateChargeAmount(
            c.installment_pi_cents,
            task.note.late_charge.pct,
            task.note.late_charge.cap_cents,
          ),
        );
    expect(CATCHUP_TOOLS.map((t) => t.name)).toEqual(["calculate", "submit_posting"]);
  });

  describe("gives the spec's worked examples to the cent", () => {
    const [k, d03, boarded, refund, alone] = catchupSpecTasks().map(expectedCatchup);

    it("K then caught up: §2.1 example A's split for September, October's on the smaller balance, K's $79.01", () => {
      expect(k!.installments).toEqual([
        {
          due_date: "2026-09-01",
          kind: "contractual",
          interest_cents: "135294",
          principal_cents: "22723",
          escrow_cents: "61240",
        },
        {
          due_date: "2026-10-01",
          kind: "contractual",
          interest_cents: "135171",
          principal_cents: "22846",
          escrow_cents: "61240",
        },
      ]);
      expect(k).toMatchObject({
        late_charge_paid_cents: "7901",
        to_suspense_cents: "0",
        refund_due_cents: "0",
        late_charges_due_after_cents: "0",
        upb_after_cents: "24931831",
        current_after_posting: true,
        lpi_after: "2026-10-01",
      });
    });

    it("D-03: K's $79.01 held to the note's $50.00; the $29.01 sent for the rest goes to suspense", () => {
      expect(d03).toMatchObject({
        installments: k!.installments,
        late_charges: [{ installment_due_date: "2026-09-01", allowed_cents: "5000" }],
        late_charge_paid_cents: "5000",
        to_suspense_cents: "2901",
        refund_due_cents: "0",
        late_charges_due_after_cents: "0",
      });
      // With the cap boarded, the system billed $50.00 and nothing is left over.
      expect(boarded).toMatchObject({ late_charge_paid_cents: "5000", to_suspense_cents: "0" });
    });

    it("a charge already collected above the cap is owed back; the new one is held to it", () => {
      expect(refund).toMatchObject({
        late_charges: [
          { installment_due_date: "2026-09-01", allowed_cents: "5000" },
          { installment_due_date: "2026-11-01", allowed_cents: "5000" },
        ],
        refund_due_cents: "2901",
        late_charge_paid_cents: "5000",
        to_suspense_cents: "2901",
        upb_after_cents: "24885767",
        lpi_after: "2026-12-01",
      });
      expect(refund!.installments.map((x) => [x.interest_cents, x.principal_cents])).toEqual([
        ["135047", "22970"],
        ["134923", "23094"],
      ]);
    });

    it("September's installment alone leaves the loan behind, and K's charge owed", () => {
      expect(alone).toMatchObject({
        installments: [k!.installments[0]],
        late_charge_paid_cents: "0",
        to_suspense_cents: "0",
        late_charges_due_after_cents: "7901",
        current_after_posting: false,
        lpi_after: "2026-09-01",
      });
    });

    it("names every case, and reads the five as the outcomes they are", () => {
      expect(CATCHUP_SPEC_CASES.length).toBe(5);
      expect(catchupSpecTasks().map(catchupVerdict)).toEqual([
        "within the note, nothing to refund, current",
        "above the note's cap, nothing to refund, current",
        "within the note, nothing to refund, current",
        "above the note's cap, refund due, current",
        "within the note, nothing to refund, still behind",
      ]);
    });
  });

  it("fails an answer one cent off on exactly that field", () => {
    const want = expectedCatchup(catchupSpecTasks()[3]!);
    const wrong = (answer: unknown) =>
      gradeCatchupAgainst(want, answer as CatchupAnswer)
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    expect(wrong(want)).toEqual([]);
    expect(wrong({ ...want, refund_due_cents: "2900" })).toEqual(["refund_due_cents"]);
    expect(
      wrong({
        ...want,
        late_charges: [want.late_charges[0], { ...want.late_charges[1]!, allowed_cents: "5001" }],
      }),
    ).toEqual(["late_charges"]);
    const [first, second] = want.installments;
    expect(
      wrong({ ...want, installments: [first, { ...second!, interest_cents: "134924" }] }),
    ).toEqual(["installments"]);
    expect(wrong({ ...want, current_after_posting: false })).toEqual(["current_after_posting"]);
    expect(gradeCatchupAgainst(want, null).fields.every((f) => !f.ok)).toBe(true);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedCatchup(catchupSpecTasks()[3]!);
    const ok = (x: unknown) => parseCatchupSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok({ ...want, late_charges: undefined })).toBe(false);
    expect(ok({ ...want, refund_due_cents: "29.01" })).toBe(false);
    expect(ok({ ...want, current_after_posting: "yes" })).toBe(false);
    expect(ok({ ...want, lpi_after: "January" })).toBe(false);
    expect(ok({ ...want, installments: [want.installments[0], want.installments[0]] })).toBe(false);
    expect(ok({ ...want, installments: [{ ...want.installments[0]!, kind: "late" }] })).toBe(false);
    expect(ok({ ...want, late_charges: [want.late_charges[0], want.late_charges[0]] })).toBe(false);
    // The order of the lists is not graded.
    const reversed = parseCatchupSubmission({
      ...want,
      installments: [...want.installments].reverse(),
      late_charges: [...want.late_charges].reverse(),
    });
    expect(reversed.ok && gradeCatchupAgainst(want, reversed.answer).pass).toBe(true);
  });

  it("can be solved from the rulebook and the tool: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([...catchupSpecTasks(), ...heldoutSuite()]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn.
    expect(r.calls).toBeLessThan(80);
  }, 300_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(trainSuite());
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(80);
  }, 300_000);

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the first draws it would see show none.
    const unfair = candidates(99, 600)
      .filter((d) => catchupInScope(d.task) && !catchupFairToGrade(d.task))
      .map((d) => d.task.id);
    expect(unfair).toEqual([]);
  }, 300_000);

  it("posts each clean moment as the history did, and holds each twin's charges to the clean history's", () => {
    let clean = 0;
    let twins = 0;
    for (const d of candidates(41, 600)) {
      const want = expectedCatchup(d.task);
      const row = d.life.receipts.find((r) => r.id === d.task.receipt.payment_id)!;
      // Both postings apply the same installments, split the same way.
      expect(
        want.installments.map((x) => [
          x.due_date,
          x.interest_cents,
          x.principal_cents,
          x.escrow_cents,
        ]),
      ).toEqual(
        row.installments.map((x) => [
          x.due,
          String(x.interest),
          String(x.principal),
          String(x.escrow),
        ]),
      );
      if (d.life === d.clean) {
        clean++;
        expect([want.late_charge_paid_cents, want.to_suspense_cents, want.upb_after_cents]).toEqual(
          [String(row.late_charge), String(row.to_suspense), String(row.upb_after)],
        );
        expect(capBreached(d.task)).toBe(false);
        expect(want.refund_due_cents).toBe("0");
      } else {
        twins++;
        // The twin charged the full percent since boarding; held to the note, each charge is the clean history's.
        const fees = new Map(d.clean.fees.map((f) => [f.due, f.amount]));
        for (const c of heldToNote(d.task).charges)
          expect(c.allowed, `${d.task.id} ${c.installment_due_date}`).toBe(
            fees.get(c.installment_due_date),
          );
        expect(BigInt(want.upb_after_cents)).toBe(row.upb_after);
      }
    }
    expect(clean).toBeGreaterThan(150);
    expect(twins).toBeGreaterThan(150);
  }, 300_000);

  it("keeps the receipts on the pay-in-full route, off the partial paths with logged engine defects", () => {
    for (const task of trainSuite()) {
      const { plan, state } = postCatchup(task);
      expect(catchupInScope(task)).toBe(true);
      // No suspense is pooled (cashiering-4, cashiering-7), and no hold, trial or plan is on the loan (cashiering-13).
      expect(task.loan.suspense_cents).toBe(0n);
      expect(plan.suspense_used_cents).toBe(0n);
      expect([state.holds.length, state.trial_active, state.plan_active]).toEqual([
        0,
        false,
        false,
      ]);
      // At least the oldest installment is paid whole: no $50 rule (cashiering-10) and no partial hold.
      expect(plan.installments.length).toBeGreaterThan(0);
      expect(plan.partial_hold).toBe(false);
      expect(plan.installments.every((i) => i.fifty_rule_shortfall_cents === undefined)).toBe(true);
      // Late charges are paid only once every installment due is paid (cashiering-7).
      const a = expectedCatchup(task);
      if (a.late_charge_paid_cents !== "0") expect(a.current_after_posting).toBe(true);
      if (!a.current_after_posting) expect(a.to_suspense_cents).toBe("0");
    }
  }, 300_000);

  it("keeps out a history in which the engine paid late charges ahead of the arrears (cashiering-7)", () => {
    const d = candidates(5, 120).find((x) => {
      const at = x.life.receipts.findIndex((r) => r.id === x.task.receipt.payment_id);
      return x.life.receipts.slice(0, at).some((r) => r.late_charge > 0n);
    })!;
    const at = d.life.receipts.findIndex((r) => r.id === d.task.receipt.payment_id);
    expect(historyInScope(d.life, at)).toBe(true);
    const k = d.life.receipts.findIndex((r) => r.late_charge > 0n);
    const r = d.life.receipts[k]!;
    // The receipt that paid a charge, had the next installment been due and still unpaid after it.
    const next = d.life.installments.find((i) => i.due > r.on)!;
    const unpaid = {
      ...d.life,
      installments: d.life.installments.map((i) =>
        i.due === next.due ? { ...i, due: r.on, satisfied_on: addMonths(r.on, 1) } : i,
      ),
    };
    expect(historyInScope(unpaid, at)).toBe(false);
    // The same charge, paid out of suspense held from before.
    const pooled = {
      ...d.life,
      receipts: d.life.receipts.map((x, j) => (j === k ? { ...x, suspense_used: 1n } : x)),
    };
    expect(historyInScope(pooled, at)).toBe(false);
  }, 60_000);

  it("passes no breached task on the system's own late charges, and every clean one", () => {
    const tasks = heldoutSuite();
    let breached = 0;
    for (const t of tasks) {
      const trusted = gradeCatchupAgainst(expectedCatchup(t), trustingTheSystem(t));
      if (capBreached(t)) {
        breached++;
        expect(trusted.pass, t.id).toBe(false);
        expect(trusted.fields.find((f) => f.field === "late_charges")!.ok).toBe(false);
      } else expect(trusted.pass, t.id).toBe(true);
    }
    // The four breached arms, and only they.
    expect(breached).toBe(tasks.filter((t) => catchupArmOf(t.index).startsWith("breached")).length);
  }, 300_000);

  it("carries the loan's history up to the moment, as the servicer's screen shows it", () => {
    for (const t of trainSuite()) {
      const on = t.receipt.received_on;
      const year = addMonths(on, -12);
      for (const r of t.history.receipts)
        expect(r.received_on >= year && r.received_on <= on).toBe(true);
      for (const m of t.history.month_ends) expect(m.month < on.slice(0, 7)).toBe(true);
      expect(t.history.month_ends.length).toBeLessThanOrEqual(12);
      for (const c of t.late_charges) expect(c.assessed_on <= on).toBe(true);
      // The system's balance is what its charges leave owed.
      expect(t.loan.late_charges_due_cents).toBe(
        t.late_charges.reduce((s, c) => s + c.amount_cents - c.collected_cents, 0n),
      );
      expect(catchupPayload(t)).toEqual(JSON.parse(JSON.stringify(catchupPayload(t))));
    }
    expect(trainSuite().filter((t) => t.history.receipts.length >= 10).length).toBeGreaterThan(200);
    expect(trainSuite().filter((t) => t.servicing.transfer_in_on !== null).length).toBeGreaterThan(
      60,
    );
  }, 300_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump CATCHUP_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldoutSuite().map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"9291c1f29db451ef92a92896e67d1d4935e22b0c1d76c9b7d4b38b403b150a78"`,
    );
  }, 300_000);

  it("rebuilds a task from its coordinates, and never draws a held-out task into training", () => {
    expect(toJsonLine(generateCatchupTask("train", 11, 17))).toBe(toJsonLine(trainSuite()[17]));
    const fp = (t: CatchupTask) => toJsonLine(catchupPayload(t));
    const held = new Set(heldoutSuite().map(fp));
    expect(trainSuite().filter((t) => held.has(fp(t)))).toEqual([]);
    expect(drawCatchupTask("heldout", 1, 0).task.id).toBe(catchupTaskId("heldout", 1, 0));
  }, 300_000);

  describe("each arm and outcome turns up", () => {
    const runs = () =>
      trainSuite().map((t, i) => ({ t, a: expectedCatchup(t), arm: catchupArmOf(i) }));
    const share = (f: (x: ReturnType<typeof runs>[number]) => boolean) =>
      runs().filter(f).length / runs().length;

    it("cycles through every arm, a seventh of the tasks each", () => {
      const arms = new Map<string, number>();
      for (const { arm } of runs()) arms.set(arm, (arms.get(arm) ?? 0) + 1);
      expect(new Set(arms.keys())).toEqual(new Set(CATCHUP_ARMS));
      for (const n of arms.values()) expect([42, 43]).toContain(n);
    }, 300_000);

    it("draws every verdict the runner tallies at more than 12 %", () => {
      const verdicts = new Map<string, number>();
      for (const { t } of runs()) {
        const v = catchupVerdict(t);
        verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
      }
      // Above the cap, each of refund due or not and current or not; within the note, current or not.
      expect(verdicts.size).toBe(6);
      for (const [v, n] of verdicts) expect(n / runs().length, v).toBeGreaterThan(0.12);
    }, 300_000);

    it("draws every outcome at more than 12 %", () => {
      const above = (f: (x: ReturnType<typeof runs>[number]) => boolean) =>
        expect(share(f)).toBeGreaterThan(0.12);
      above((x) => capBreached(x.t) && x.a.current_after_posting);
      above((x) => capBreached(x.t) && !x.a.current_after_posting);
      above((x) => !capBreached(x.t) && x.a.current_after_posting);
      above((x) => !capBreached(x.t) && !x.a.current_after_posting);
      above((x) => x.a.refund_due_cents !== "0");
      above((x) => x.a.refund_due_cents === "0");
      above((x) => x.a.to_suspense_cents !== "0");
      above((x) => x.a.late_charge_paid_cents !== "0");
      above((x) => x.a.late_charge_paid_cents === "0");
      above((x) => x.t.note.late_charge.cap_cents === null);
    }, 300_000);

    it("draws prepaid installments, long arrears and every state's percent", () => {
      expect(runs().some((x) => x.a.installments.some((i) => i.kind === "prepaid"))).toBe(true);
      expect(runs().some((x) => x.a.installments.length >= 3)).toBe(true);
      expect(new Set(runs().map((x) => x.t.note.late_charge.pct))).toEqual(
        new Set(["2", "4", "5"]),
      );
    }, 300_000);
  });

  it("says in the rulebook what it grades, and nothing the history decides", () => {
    for (const f of [
      "allowed",
      "still owed",
      "collected above the note",
      "late_charge_paid",
      "to_suspense",
      "current_after_posting",
      "lpi_after",
    ])
      expect(CATCHUP_RULEBOOK).toContain(f);
    expect(CATCHUP_RULEBOOK).toContain("Nothing in it is to be posted again");
  });
});
