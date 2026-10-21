/**
 * Seasoning is a count of calendar months, and it must be the same count on
 * every machine, in every order the bureaus list the records, and for the
 * record that actually decides.
 *
 * Three defects, all found mapping the engine for a grader: the months were
 * counted with local-time getters (a server said 48 where a laptop in New York
 * said 47); two records on one date were picked by a comparator that was not
 * a comparator, so the list's order chose the chapter; and only the most
 * recent record was tested, so an older chapter 7 short of its 48 months
 * passed behind a later chapter 13 past its 24.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { LoanFile, PublicRecord } from "@hm/shared";
import { APOR_TABLE } from "../apor-yield.js";
import { underwrite } from "../aus.js";
import { REFERENCE, connectedThrough } from "./support/in-memory-file.js";

const withRecords = (file: LoanFile, publicRecords: PublicRecord[]): LoanFile => ({
  ...file,
  credit: { ...file.credit!, publicRecords },
});
const decide = (file: LoanFile, now = REFERENCE.toISOString()) =>
  underwrite(file, { aporTable: APOR_TABLE, casefileId: "seasoning-test", now });
const derivation = (d: ReturnType<typeof decide>, id: string) =>
  d.derivations.find((x) => x.requirementId === id);
const codes = (d: ReturnType<typeof decide>) => (d.aus?.findings ?? []).map((f) => f.code);

const bankruptcy = (chapter: string, dischargeDate: string): PublicRecord => ({
  type: "bankruptcy",
  date: "2019-01-15",
  status: "discharged",
  chapter,
  dischargeDate,
});

describe("seasoning", () => {
  const zone = process.env["TZ"];
  afterEach(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  it("counts the same months in New York as on a server", async () => {
    const file = withRecords(await connectedThrough("clean_w2", "irs"), [
      bankruptcy("7", "2022-07-15"),
    ]);
    const now = "2026-07-01T02:00:00.000Z";
    process.env["TZ"] = "America/New_York";
    // The precondition: this instant is still June in New York.
    expect(new Date(now).getMonth()).toBe(5);
    const there = decide(file, now);
    process.env["TZ"] = "UTC";
    const here = decide(file, now);
    expect(derivation(there, "CRD-006")?.value).toBe(48);
    expect(derivation(here, "CRD-006")?.value).toBe(48);
    expect(codes(there)).not.toContain("BANKRUPTCY_SEASONING");
  });

  it("refuses a decision instant with no zone, which every machine would read differently", async () => {
    const file = await connectedThrough("clean_w2", "irs");
    expect(() => decide(file, "2026-07-01T02:00:00")).toThrow(RangeError);
    expect(() => decide(file, "2026-07-01T02:00:00-04:00")).not.toThrow();
  });

  it("gives two records on one date the same answer in either order: the stricter decides", async () => {
    const base = await connectedThrough("clean_w2", "irs");
    const seven = bankruptcy("7", "2023-06-15");
    const thirteen = bankruptcy("13", "2023-06-15");
    for (const order of [
      [seven, thirteen],
      [thirteen, seven],
    ]) {
      const d = decide(withRecords(base, order));
      expect(derivation(d, "CRD-006")?.inputs["chapter_type"]).toBe("7");
      expect(codes(d)).toContain("BANKRUPTCY_SEASONING");
    }
    const foreclosure: PublicRecord = {
      type: "foreclosure",
      date: "2021-06-15",
      status: "completed",
    };
    const shortSale: PublicRecord = { type: "short_sale", date: "2021-06-15", status: "completed" };
    for (const order of [
      [foreclosure, shortSale],
      [shortSale, foreclosure],
    ]) {
      const d = decide(withRecords(base, order));
      expect(derivation(d, "CRD-007")?.inputs["event_type"]).toBe("foreclosure");
      expect(codes(d)).toContain("DEROGATORY_SEASONING");
    }
  });

  it("tests an older record against its own minimum, not only the most recent", async () => {
    // A chapter 7 discharged 44 months back is short of 48, though the chapter 13
    // discharged 30 months back is past its 24.
    const d = decide(
      withRecords(await connectedThrough("clean_w2", "irs"), [
        bankruptcy("13", "2023-12-15"),
        bankruptcy("7", "2022-10-15"),
      ]),
    );
    expect(derivation(d, "CRD-006")).toMatchObject({
      value: 44,
      inputs: { chapter_type: "7", minimum_months: 48 },
    });
    expect(codes(d)).toContain("BANKRUPTCY_SEASONING");
  });

  it("reports the closest call when every record passes", async () => {
    const d = decide(
      withRecords(await connectedThrough("clean_w2", "irs"), [
        bankruptcy("7", "2020-01-15"),
        bankruptcy("13", "2023-12-15"),
      ]),
    );
    // 77 months against 48 is 29 past; 30 against 24 is 6 past, and is the one reported.
    expect(derivation(d, "CRD-006")).toMatchObject({ value: 30, inputs: { chapter_type: "13" } });
    expect(codes(d)).not.toContain("BANKRUPTCY_SEASONING");
  });
});
