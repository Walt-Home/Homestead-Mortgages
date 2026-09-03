/**
 * Stage is a high-water mark, not a cursor.
 *
 * Every connector route used to write the stage directly, so going back to
 * look at your credit report and pulling again dragged the whole flow back to
 * the bank step — you would lose your place by revisiting a screen you had
 * already finished. Where you are is the URL; how far you got is the stage.
 *
 * The ordering tests are pure. The `advanceStage` tests run against a real
 * database, because what they are actually asserting is that a row did or did
 * not change — which a mocked `update` cannot tell you.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { advanceStage, stageIndex, STAGE_ORDER } from "../services/stage.js";
import { createLoanFile } from "./support/factories.js";

const MISSING = "11111111-1111-1111-1111-111111111111";

const stageOf = (id: string) =>
  prisma.loanFile.findUnique({ where: { id }, select: { stage: true } }).then((f) => f?.stage);

describe("stage ordering", () => {
  it("orders the flow as the screens run", () => {
    expect(stageIndex("PROPERTY_LOAN")).toBeLessThan(stageIndex("IDENTITY"));
    expect(stageIndex("IRS_TRANSCRIPT")).toBeLessThan(stageIndex("DECISION"));
    expect(stageIndex("DECISION")).toBeLessThan(stageIndex("COMPLETE"));
  });

  it("sorts an unknown stage first, so it can only ever be advanced past", () => {
    // Sorting it LAST would mark a file complete and lock the borrower out of
    // every remaining screen.
    expect(stageIndex("NOT_A_STAGE" as never)).toBe(0);
  });

  it("covers every stage the schema defines", async () => {
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length);
    // Read the enum out of Postgres rather than restating it here, so a stage
    // added to the schema and forgotten in STAGE_ORDER fails this test instead
    // of silently sorting first and being advanced past.
    const rows = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'FlowStage'
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect([...STAGE_ORDER].sort()).toEqual(rows.map((r) => r.label).sort());
  });
});

describe("advanceStage", () => {
  it("moves the file forward", async () => {
    const file = await createLoanFile({ stage: "CREDIT" });
    expect(await advanceStage(file.id, "BANK")).toBe("BANK");
    expect(await stageOf(file.id)).toBe("BANK");
  });

  it("REFUSES to move it backwards", async () => {
    // The regression this exists for: re-pulling credit on a file that had
    // already reached the decision screen used to rewind it to BANK.
    const file = await createLoanFile({ stage: "DECISION" });
    expect(await advanceStage(file.id, "BANK")).toBe("DECISION");
    expect(await stageOf(file.id)).toBe("DECISION");
  });

  it("is a no-op when already at that stage", async () => {
    const file = await createLoanFile({ stage: "PAYROLL" });
    expect(await advanceStage(file.id, "PAYROLL")).toBe("PAYROLL");
    expect(await stageOf(file.id)).toBe("PAYROLL");
  });

  it("never writes when the file has vanished", async () => {
    // Returns the requested stage without persisting anything — the caller is
    // mid-request on a file that was deleted, and inventing a row here would
    // resurrect it.
    expect(await advanceStage(MISSING, "BANK")).toBe("BANK");
    expect(await prisma.loanFile.findUnique({ where: { id: MISSING } })).toBeNull();
  });

  it("holds under concurrent advances", async () => {
    // Only expressible against a real database, and the reason the high-water
    // mark exists: two connector callbacks landing together must not leave the
    // file behind the further of the two.
    const file = await createLoanFile({ stage: "IDENTITY" });
    await Promise.all([advanceStage(file.id, "DECISION"), advanceStage(file.id, "BANK")]);
    expect(await stageOf(file.id)).toBe("DECISION");
  });
});
