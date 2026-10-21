/**
 * refi-tape: the worked example read off a tape gives the spec's figures,
 * every generated task can be solved from the rulebook and the tools, a
 * task is a function of its name, and each of the tape's traps turns up
 * often enough to be measured.
 */

import { describe, expect, it } from "vitest";
import { universeLoanOf } from "@hm/refi-review";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { expectedAnswer, expectedReview, specTasks } from "../refi/index.js";
import {
  TAPE_HELDOUT_SUITE,
  TapeReferencePolicy,
  expectedTapeAnswer,
  generateTapeSuite,
  generateTapeTask,
  parseTapeSubmission,
  refiTape,
  tapePayload,
  tapeSpecTasks,
  type RefiTapeTask,
} from "../refi-tape/index.js";

const solveAll = async (tasks: readonly RefiTapeTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(refiTape, task, new TapeReferencePolicy());
    if (!r.grade.pass) misses.push(`${task.id} ${r.outcome} ${r.error ?? ""}`);
  }
  return misses;
};

describe("refi-tape", () => {
  it("reads worked example 1 off a clean tape and gives the spec's figures", () => {
    const [onTape] = tapeSpecTasks();
    const [asRow] = specTasks();
    if (!onTape || !asRow) throw new Error("no spec tasks");
    expect(expectedTapeAnswer(onTape)).toEqual(expectedAnswer(expectedReview(asRow)));
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite", async () => {
    expect(
      await solveAll(generateTapeSuite("heldout", TAPE_HELDOUT_SUITE.seed, TAPE_HELDOUT_SUITE.n)),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed, and on the spec", async () => {
    expect(await solveAll([...tapeSpecTasks(), ...generateTapeSuite("train", 11, 300)])).toEqual(
      [],
    );
  }, 120_000);

  it("rebuilds a task from its coordinates, and never draws a held-out tape into training", () => {
    expect(toJsonLine(generateTapeTask("train", 7, 17))).toBe(
      toJsonLine(generateTapeSuite("train", 7, 30)[17]),
    );
    const fp = (t: RefiTapeTask) => toJsonLine(tapePayload(t));
    const heldout = new Set(generateTapeSuite("heldout", 1, 200).map(fp));
    expect(generateTapeSuite("train", 1, 1000).filter((t) => heldout.has(fp(t)))).toEqual([]);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump TAPE_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(generateTapeSuite("heldout", 1, 200).map(toJsonLine).join(""))).toBe(
      "170e7ecc3c4553457940d88077108e78eb370a07dc009e3aba51cae60e97972e",
    );
  });

  it("takes a not_reviewable answer, and grades it", () => {
    const parsed = parseTapeSubmission({
      verdict: "not_reviewable",
      reasons: ["no_value"],
      offer: null,
      watch_rate_pct: null,
    });
    expect(parsed.ok && parsed.answer.verdict).toBe("not_reviewable");
  });

  describe("every trap of the tape turns up", () => {
    const tasks = generateTapeSuite("train", 1, 2000);
    const rows = tasks.map((t) => ({
      t,
      read: universeLoanOf(t.loan_record, t.tape, t.review_date),
    }));
    const ok = rows.flatMap(({ t, read }) => ("row" in read ? [{ t, row: read.row }] : []));
    const count = (pred: (x: (typeof ok)[number]) => boolean) => ok.filter(pred).length;
    const F = (t: RefiTapeTask) => t.tape.facts;

    it("draws every verdict, the fifth included", () => {
      const seen = new Set(tasks.map((t) => expectedTapeAnswer(t).verdict));
      expect([...seen].sort()).toEqual([
        "candidate",
        "excluded",
        "not_now",
        "not_reviewable",
        "watching",
      ]);
    });

    it("draws each reason a tape cannot be read", () => {
      const reasons = new Set(
        tasks
          .map((t) => expectedTapeAnswer(t))
          .filter((a) => a.verdict === "not_reviewable")
          .flatMap((a) => a.reasons),
      );
      expect([...reasons].sort()).toEqual(["no_first_payment_date", "no_upb", "no_value"]);
    });

    it("draws a loan late by its pay string or status alone", () => {
      expect(
        count(
          ({ t, row }) =>
            row.regx_days_delinquent === 30 &&
            !!t.tape.next_payment_due_on &&
            t.tape.next_payment_due_on >= t.tape.as_of,
        ),
      ).toBeGreaterThan(20);
    });

    it("draws a PMI rate in basis points, and a note rate known only in basis points", () => {
      expect(
        count(({ t, row }) => row.mi_monthly_cents > 0n && Number(F(t)["pmi_rate_pct"]) > 5),
      ).toBeGreaterThan(10);
      // 100 basis points and up, as text: absent under 1.0.0, a premium since 1.1.0.
      expect(
        count(
          ({ t, row }) => row.mi_monthly_cents > 0n && /^\d{3}$/.test(String(F(t)["pmi_rate_pct"])),
        ),
      ).toBeGreaterThan(3);
      expect(
        count(({ t }) => F(t)["note_rate_pct"] === undefined && t.tape.current_rate_pct === null),
      ).toBeGreaterThan(50);
    });

    it("draws a next due date the tape does not give, and two valuations to choose from", () => {
      expect(
        count(({ t }) => !t.tape.next_payment_due_on && !F(t)["next_due_date"]),
      ).toBeGreaterThan(50);
      expect(
        count(({ t }) => F(t)["fmv_cents"] !== undefined && F(t)["bpo_value_cents"] !== undefined),
      ).toBeGreaterThan(100);
    });

    it("draws a bankruptcy filed and then discharged or dismissed, which is not active", () => {
      expect(
        count(({ t, row }) => F(t)["bk_filed_date"] !== undefined && !row.bankruptcy_active),
      ).toBeGreaterThan(20);
    });
  });
});
