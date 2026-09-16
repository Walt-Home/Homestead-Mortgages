/**
 * The decision as a stored row: a closed set, in the database.
 *
 * `decisions.outcome` and `decisions.aus_recommendation` are `String` columns,
 * and until M9 they were cast straight back to the union on the way out. That
 * made `DecisionOutcome` a TypeScript convention rather than a fact — a
 * misspelled `referred` was a row that inserted happily and then rendered as
 * an ending nobody has copy for.
 *
 * Two halves, and both are needed. The CHECK constraint is the brace: the
 * insert fails. `repository.ts` is the belt, and it reads a row written before
 * the constraint existed differently depending on what is being asked. A read
 * OF ONE FILE throws: the request is about that file and half of it is not an
 * answer. The LIST drops that one decision and keeps going, because the
 * alternative is one bad row taking down every file the user can see — and a
 * demo row, which every user can see, taking down all of theirs too. This file
 * asserts the constraint's own list against the constant the code shares,
 * because a drift between them is invisible from either side, and then asserts
 * the belt from both directions.
 */

import { describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@hm/db";
import {
  AUS_RECOMMENDATIONS,
  DECISION_OUTCOMES,
  UNCOMPUTED_RATIOS,
  UNCOMPUTED_RESERVES,
} from "@hm/shared";
import type { Db } from "../services/db.js";
import { listAccessibleFiles } from "../services/repository.js";
import { createLoanFile, createUser } from "./support/factories.js";

const definitionOf = async (name: string): Promise<string> => {
  const rows = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
  `;
  if (!rows[0]) throw new Error(`no constraint named ${name}`);
  return rows[0].def;
};

/** The quoted literals a CHECK ... IN (...) lists, in the order it lists them. */
const literalsIn = (def: string): string[] => [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe("the database holds the same words the code does", () => {
  it("lists exactly DECISION_OUTCOMES on the outcome column", async () => {
    const listed = literalsIn(await definitionOf("decisions_outcome_known"));
    expect([...listed].sort()).toEqual([...DECISION_OUTCOMES].sort());
  });

  it("lists exactly AUS_RECOMMENDATIONS on the recommendation column", async () => {
    const listed = literalsIn(await definitionOf("decisions_recommendation_known"));
    expect([...listed].sort()).toEqual([...AUS_RECOMMENDATIONS].sort());
  });

  it("refuses a word nobody has copy for", async () => {
    // The observable the constraint exists for. Without it this insert
    // succeeds and the review screen renders a blank ending.
    const user = await createUser();
    const file = await prisma.loanFile.create({
      data: { userId: user.id, purpose: "PURCHASE" },
      select: { id: true },
    });
    await expect(
      prisma.decision.create({
        data: {
          loanFileId: file.id,
          outcome: "refered",
          computedAt: new Date(),
          ausEngine: "shadow",
          ausEngineVersion: "0.1.0",
          ausCasefileId: "c1",
          ausRecommendation: "refer",
          ausFindings: [],
          ratios: { ...UNCOMPUTED_RATIOS },
          reserves: { ...UNCOMPUTED_RESERVES },
          compliance: {},
          pricing: {},
          derivations: [],
        },
      }),
    ).rejects.toThrow();
  });
});

describe("a stored spread names what it was measured against", () => {
  /** One row, with whatever compliance verdicts and provenance the caller wants. */
  const store = (
    loanFileId: string,
    compliance: Prisma.InputJsonObject,
    provenance: {
      aporWeekOf?: Date;
      aporSource?: string;
      feeScheduleVersion?: string;
    } = {},
  ) =>
    prisma.decision.create({
      data: {
        loanFileId,
        outcome: "referred",
        computedAt: new Date(),
        ausEngine: "shadow",
        ausEngineVersion: "0.1.0",
        ausCasefileId: "c1",
        ausRecommendation: "refer",
        ausFindings: [],
        ratios: { ...UNCOMPUTED_RATIOS },
        reserves: { ...UNCOMPUTED_RESERVES },
        compliance,
        pricing: {},
        derivations: [],
        ...provenance,
      },
      select: { id: true },
    });

  const fileFor = async () => {
    const user = await createUser();
    return (
      await prisma.loanFile.create({
        data: { userId: user.id, purpose: "PURCHASE" },
        select: { id: true },
      })
    ).id;
  };

  it("refuses an APR spread with no APOR source behind it", async () => {
    // The row this constraint exists for. A recomputation a year from now runs
    // against a different week of the FFIEC's table and answers differently,
    // and without this there is nothing on the old row to say which week it
    // meant — so two rows disagreeing about one loan look like the loan
    // changed.
    await expect(store(await fileFor(), { hpmlSpread: 0.13, isHpml: false })).rejects.toThrow(
      /decisions_a_spread_names_its_week/,
    );
  });

  it("refuses a points-and-fees ratio with no schedule behind it", async () => {
    await expect(
      store(await fileFor(), { pointsAndFeesRatio: 0.81, pointsAndFeesPass: true }),
    ).rejects.toThrow(/decisions_a_fee_ratio_names_its_schedule/);
  });

  it("refuses a week that does not say which series it came off", async () => {
    await expect(
      store(await fileFor(), {}, { aporWeekOf: new Date("2026-06-15T00:00:00.000Z") }),
    ).rejects.toThrow(/decisions_a_week_has_a_source/);
  });

  it("takes a computation that did not run, which has nothing to name", async () => {
    // Every decision recorded before the engine derived these carries null
    // verdicts, and those rows are truthful records of tests that were blocked.
    // The constraint is an implication rather than a NOT NULL so they stay
    // insertable and stay unbackfilled.
    await expect(
      store(await fileFor(), { hpmlSpread: null, pointsAndFeesRatio: null }),
    ).resolves.toBeDefined();
  });

  it("takes a spread a caller stated, as long as it says so", async () => {
    await expect(
      store(
        await fileFor(),
        { hpmlSpread: 7.05, pointsAndFeesRatio: 1 },
        { aporSource: "stated", feeScheduleVersion: "stated" },
      ),
    ).resolves.toBeDefined();
  });
});

/** One stored decision, with whatever word the caller wants on it. */
const storeDecision = (loanFileId: string, outcome: string, db: Db = prisma) =>
  db.decision.create({
    data: {
      loanFileId,
      outcome,
      computedAt: new Date(),
      ausEngine: "shadow",
      ausEngineVersion: "0.1.0",
      ausCasefileId: "c1",
      ausRecommendation: "refer",
      ausFindings: [],
      ratios: { ...UNCOMPUTED_RATIOS },
      reserves: { ...UNCOMPUTED_RESERVES },
      compliance: {},
      pricing: {},
      derivations: [],
    },
    select: { id: true },
  });

/** The rollback, thrown rather than requested — Prisma has no other verb. */
class RolledBack extends Error {}

/**
 * Do something with the outcome constraint off, and give the schema back.
 *
 * The constraint has to come off to write the row this is about, and a drop
 * that outlives the test poisons the database for every later run: the file
 * then fails on the missing constraint rather than on anything it asserts.
 * Restoring in a `finally` only holds while the process survives to reach it,
 * and vitest's per-test timeout is a kill, not an exception — it has already
 * happened here once.
 *
 * So the drop, the row and the read all happen inside one transaction that
 * ends in a rollback whatever else happens. Postgres rolls DDL back like
 * anything else, so the constraint returns because nothing committed — not
 * because any cleanup code got the chance to run.
 */
async function withOutcomeConstraintOff<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  let value: T | undefined;
  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE "decisions" DROP CONSTRAINT "decisions_outcome_known"`,
      );
      value = await fn(tx);
      throw new RolledBack();
    })
    .catch((err: unknown) => {
      if (!(err instanceof RolledBack)) throw err;
    });
  return value as T;
}

describe("one unreadable row does not take down the file list", () => {
  it("still answers, and still names the file beside it", async () => {
    // The whole shape of the risk: the value is unreachable through the
    // product, so the only way it exists is a build or a hand that predates
    // the constraint — and the list has to survive one anyway.
    const user = await createUser();
    const good = await createLoanFile({ userId: user.id });
    await storeDecision(good.id, "referred");

    // The file with the bad row on it is made inside the transaction too, so
    // the list has to be read on that client to see it at all — a read that
    // went around the transaction would report no such file rather than a
    // file with no outcome, and the assertion below would notice.
    const { rows, badId } = await withOutcomeConstraintOff(async (tx) => {
      const bad = await tx.loanFile.create({ data: { userId: user.id }, select: { id: true } });
      await storeDecision(bad.id, "refered", tx);
      return { rows: await listAccessibleFiles(user.id, tx), badId: bad.id };
    });

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // The good file is listed, with its outcome, rather than the whole
    // request failing on its neighbour.
    expect(byId[good.id]?.decisions).toEqual([{ outcome: "referred", ausRecommendation: "refer" }]);
    // And the unreadable one is listed too, reporting no outcome.
    expect(byId[badId]?.decisions).toEqual([]);
  });

  it("leaves the constraint where it found it", async () => {
    // The reason the drop is inside a transaction at all. Without this, a
    // rewrite that restored the schema in a `finally` — or not at all — reads
    // as green here and fails every later run of this file.
    await withOutcomeConstraintOff(async () => undefined);
    expect(await definitionOf("decisions_outcome_known")).toContain("outcome");
  });
});
