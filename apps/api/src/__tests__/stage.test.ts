/**
 * Stage is a high-water mark, not a cursor.
 *
 * Every connector route used to write the stage directly, so going back to
 * look at your credit report and pulling again dragged the whole flow back to
 * the bank step — you would lose your place by revisiting a screen you had
 * already finished. Where you are is the URL; how far you got is the stage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@hm/db", () => ({ prisma: { loanFile: { findUnique, update } } }));

const { advanceStage, stageIndex, STAGE_ORDER } = await import("../services/stage.js");

const FILE = "11111111-1111-1111-1111-111111111111";

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

  it("covers every stage the schema defines", () => {
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length);
    expect(STAGE_ORDER).toContain("PERSISTENT_CONSENT");
  });
});

describe("advanceStage", () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it("moves the file forward", async () => {
    findUnique.mockResolvedValue({ stage: "CREDIT" });
    update.mockResolvedValue({ stage: "BANK" });
    expect(await advanceStage(FILE, "BANK")).toBe("BANK");
    expect(update).toHaveBeenCalledOnce();
  });

  it("REFUSES to move it backwards", async () => {
    // The regression this exists for: re-pulling credit on a file that had
    // already reached the decision screen used to rewind it to BANK.
    findUnique.mockResolvedValue({ stage: "DECISION" });
    expect(await advanceStage(FILE, "BANK")).toBe("DECISION");
    expect(update).not.toHaveBeenCalled();
  });

  it("is a no-op when already at that stage", async () => {
    findUnique.mockResolvedValue({ stage: "PAYROLL" });
    expect(await advanceStage(FILE, "PAYROLL")).toBe("PAYROLL");
    expect(update).not.toHaveBeenCalled();
  });

  it("never writes when the file has vanished", async () => {
    findUnique.mockResolvedValue(null);
    await advanceStage(FILE, "BANK");
    expect(update).not.toHaveBeenCalled();
  });
});
