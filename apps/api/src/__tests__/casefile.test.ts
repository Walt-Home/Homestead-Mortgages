/**
 * One loan, one casefile, however many times it is submitted.
 *
 * Desktop Underwriter recognizes a resubmission by its casefile identifier. The
 * same loan going back three to six times carries the same one; a different one
 * opens a different case, with none of the prior findings behind it. The
 * decision route used to mint a fresh UUID on every run, so every recomputation
 * of one loan would have reached DU as a loan DU had never seen — and nothing
 * in the suite noticed, because every test that reaches the engine supplies its
 * own casefile (`decide.test.ts` hardcodes one, `flow.test.ts` passes
 * `"test-casefile"`) and none of them ever compared two runs.
 *
 * So the observable here is agreement across runs, not the shape of the value.
 * The rest is the database's half: the identifier is unique, it is not blank,
 * and recording a decision writes what the engine was actually handed rather
 * than what the application carries now — a decision row is evidence of a
 * submission that happened, and a helpful overwrite would rewrite history.
 *
 * Against the real Postgres, because half of this is a constraint.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { underwrite } from "@hm/underwriting";
import { fileRouter } from "../routes/files.js";
import { decisionRouter } from "../routes/decision.js";
import { casefileIdForFile } from "../services/applications.js";
import { recordDecision } from "../services/decide.js";
import { loadLoanFile } from "../services/repository.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1's body: a $415,000 house with a $332,000 loan. */
const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

const definitionOf = async (name: string): Promise<string> => {
  const rows = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
  `;
  if (!rows[0]) throw new Error(`no constraint named ${name}`);
  return rows[0].def;
};

/** Screen 1, through the route, which is what mints an application at all. */
async function startedFile() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  return { user, fileId: created.body.id };
}

const decide = (userId: string, fileId: string) =>
  callAs(userId, [decisionRouter], "POST", `/${fileId}/decision`, {});

/** Every casefile this file has ever been submitted under, oldest run first. */
const submittedUnder = async (loanFileId: string): Promise<string[]> =>
  (
    await prisma.decision.findMany({
      where: { loanFileId },
      orderBy: { id: "asc" },
      select: { ausCasefileId: true },
    })
  ).map((d) => d.ausCasefileId);

describe("a casefile survives a resubmission", () => {
  it("submits a second decision under the identifier the first one used", async () => {
    // The whole commit, as one observable. Two runs of the engine on one loan
    // are one case at DU, and they were two.
    const { user, fileId } = await startedFile();
    expect((await decide(user.id, fileId)).status).toBe(201);
    expect((await decide(user.id, fileId)).status).toBe(201);

    const casefiles = await submittedUnder(fileId);
    expect(casefiles).toHaveLength(2);
    expect(casefiles[0]).toBe(casefiles[1]);

    // And it is the application's own identifier, not merely a value the two
    // runs happened to agree on.
    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: fileId },
      select: { ausCasefileId: true },
    });
    expect(casefiles[0]).toBe(app.ausCasefileId);
  });

  it("gives a file with no application one that is still stable", async () => {
    // A legacy file, which the route already tolerates. It has no credit
    // request to carry the identifier, so it answers with its own id: stable
    // per file, which is the only property required of it, and not a value
    // minted per run.
    const { user, fileId } = await startedFile();
    await prisma.application.delete({ where: { loanFileId: fileId } });

    expect((await decide(user.id, fileId)).status).toBe(201);
    expect((await decide(user.id, fileId)).status).toBe(201);

    expect(await submittedUnder(fileId)).toEqual([fileId, fileId]);
    expect(await casefileIdForFile(fileId)).toBe(fileId);
  });

  it("refuses two credit requests carrying one casefile", async () => {
    // The confusion in the opposite direction: DU reading one loan as a
    // resubmission of a different one.
    const { fileId } = await startedFile();
    const { fileId: otherId } = await startedFile();
    const mine = await casefileIdForFile(fileId);

    await prisma.application.delete({ where: { loanFileId: otherId } });
    await expect(
      prisma.application.create({ data: { loanFileId: otherId, ausCasefileId: mine } }),
    ).rejects.toThrow();

    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'applications_aus_casefile_id_key'
    `;
    expect(indexes[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
  });

  it("refuses a blank one", async () => {
    // NOT NULL alone admits the empty string, which reaches a vendor as a
    // missing field rather than as a failed insert.
    expect(await definitionOf("applications_casefile_is_not_blank")).toMatch(/btrim/);

    const { fileId } = await startedFile();
    await prisma.application.delete({ where: { loanFileId: fileId } });
    await expect(
      prisma.application.create({ data: { loanFileId: fileId, ausCasefileId: "   " } }),
    ).rejects.toThrow();
  });

  it("records the casefile the engine was handed, not the one the file carries", async () => {
    // `decisions` is append-only and its rows say what was submitted. A future
    // convenience that filled this column from the application would rewrite
    // every pre-existing row's account of itself.
    const { fileId } = await startedFile();
    const file = (await loadLoanFile(fileId))!;
    const handed = randomUUID();
    const decision = underwrite(file, { casefileId: handed, now: new Date().toISOString() });

    await recordDecision(prisma, fileId, decision);

    expect(await submittedUnder(fileId)).toEqual([handed]);
    expect(await casefileIdForFile(fileId)).not.toBe(handed);
  });
});

describe("the casefile DU mints is not the one we mint", () => {
  /** What DU would return on a response, shaped the way DU shapes it. */
  const DU_CASE = "1234567890";

  it("starts empty, because DU has not answered yet", async () => {
    const { fileId } = await startedFile();
    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: fileId },
      select: { duCasefileId: true, ausCasefileId: true },
    });
    expect(app.duCasefileId).toBeNull();
    // And ours, which is what tells two submissions apart before any answer,
    // is still there and still does not fit the field DU would put it in.
    expect(app.ausCasefileId.length).toBeGreaterThan(30);
  });

  it("takes DU's identifier once and then refuses a different one", async () => {
    const { fileId } = await startedFile();
    await prisma.application.update({
      where: { loanFileId: fileId },
      data: { duCasefileId: DU_CASE },
    });

    // A second case at Fannie while our own records still say one.
    await expect(
      prisma.application.update({
        where: { loanFileId: fileId },
        data: { duCasefileId: "9999999999" },
      }),
    ).rejects.toThrow(/already carries DU casefile/);

    // And clearing it, which loses the only handle we have on the first.
    await expect(
      prisma.application.update({ where: { loanFileId: fileId }, data: { duCasefileId: null } }),
    ).rejects.toThrow(/already carries DU casefile/);
  });

  it("lets a retry store the value it already stored", async () => {
    // The refusal is keyed on the value DIFFERING, not on the column being
    // written — a resubmission that reads the response and writes back what is
    // already there is an ordinary retry, and making that an error would turn
    // a duplicate delivery into a failure.
    const { fileId } = await startedFile();
    for (let i = 0; i < 3; i++) {
      await prisma.application.update({
        where: { loanFileId: fileId },
        data: { duCasefileId: DU_CASE },
      });
    }
    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: fileId },
      select: { duCasefileId: true },
    });
    expect(app.duCasefileId).toBe(DU_CASE);
  });

  it("will not let two applications claim one DU case", async () => {
    const a = await startedFile();
    const b = await startedFile();
    await prisma.application.update({
      where: { loanFileId: a.fileId },
      data: { duCasefileId: DU_CASE },
    });
    await expect(
      prisma.application.update({
        where: { loanFileId: b.fileId },
        data: { duCasefileId: DU_CASE },
      }),
    ).rejects.toThrow();
  });
});
