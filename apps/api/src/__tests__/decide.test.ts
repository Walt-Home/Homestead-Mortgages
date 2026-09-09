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
import { prisma } from "@hm/db";
import { AUS_RECOMMENDATIONS, DECISION_OUTCOMES } from "@hm/shared";
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
          ratios: {},
          reserves: {},
          compliance: {},
          pricing: {},
          derivations: [],
        },
      }),
    ).rejects.toThrow();
  });
});

/** One stored decision, with whatever word the caller wants on it. */
const storeDecision = (loanFileId: string, outcome: string) =>
  prisma.decision.create({
    data: {
      loanFileId,
      outcome,
      computedAt: new Date(),
      ausEngine: "shadow",
      ausEngineVersion: "0.1.0",
      ausCasefileId: "c1",
      ausRecommendation: "refer",
      ausFindings: [],
      ratios: {},
      reserves: {},
      compliance: {},
      pricing: {},
      derivations: [],
    },
    select: { id: true },
  });

describe("one unreadable row does not take down the file list", () => {
  it("still answers, and still names the file beside it", async () => {
    // The row has to be made with the constraint off, which is the whole
    // shape of the risk: the value is unreachable through the product, so the
    // only way it exists is a build or a hand that predates the constraint —
    // and the list has to survive one anyway. The definition is read back
    // rather than retyped, so restoring it cannot drift from the migration.
    const user = await createUser();
    const good = await createLoanFile({ userId: user.id });
    const bad = await createLoanFile({ userId: user.id });
    await storeDecision(good.id, "referred");

    const definition = await definitionOf("decisions_outcome_known");
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "decisions" DROP CONSTRAINT "decisions_outcome_known"`,
    );
    try {
      await storeDecision(bad.id, "refered");

      const rows = await listAccessibleFiles(user.id);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      // The good file is listed, with its outcome, rather than the whole
      // request failing on its neighbour.
      expect(byId[good.id]?.decisions).toEqual([
        { outcome: "referred", ausRecommendation: "refer" },
      ]);
      // And the unreadable one is listed too, reporting no outcome.
      expect(byId[bad.id]?.decisions).toEqual([]);
    } finally {
      await prisma.decision.deleteMany({ where: { loanFileId: bad.id } });
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "decisions" ADD CONSTRAINT "decisions_outcome_known" ${definition}`,
      );
    }
  });
});
