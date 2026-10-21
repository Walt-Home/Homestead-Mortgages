/**
 * The guard every train draw goes through: a train id whose stream a
 * held-out task draws from is that task, and is never drawn.
 */

import { describe, expect, it } from "vitest";
import { HELDOUT_SUITES, drawsHeldoutStream, namespaceOf, trainIndexes } from "../heldout-guard.js";
import { escrowTaskId } from "../escrow/index.js";
import { hash32 } from "../rng.js";

describe("the held-out guard", () => {
  it("names the four held-out escrow tasks at ordinary train coordinates", () => {
    const { kept, left_out } = trainIndexes((i) => escrowTaskId("train", 5920, i), 9600);
    expect(left_out).toEqual(expect.arrayContaining([9554, 9555, 9558, 9559]));
    expect(kept).toContain(9556);
    for (const i of [9554, 9555, 9558, 9559])
      expect(drawsHeldoutStream(escrowTaskId("train", 5920, i))).toBe(true);
    // Very few honest coordinates are turned away with them.
    expect(left_out.length).toBeLessThan(15);
  });

  it("refuses every held-out id itself", () => {
    for (const s of HELDOUT_SUITES) {
      expect(drawsHeldoutStream(`${s.namespace}/heldout/${s.seed}/0`)).toBe(true);
      expect(drawsHeldoutStream(`${s.namespace}/heldout/${s.seed}/${s.n - 1}`)).toBe(true);
    }
    expect(hash32("refi-review/1.0.0/train/862396/158")).toBe(
      hash32("refi-review/1.0.0/heldout/1/0"),
    );
    expect(drawsHeldoutStream("refi-review/1.0.0/train/862396/158")).toBe(true);
  });

  it("knows every namespace it guards, and refuses to guess at one it does not", () => {
    expect(new Set(HELDOUT_SUITES.map((s) => s.namespace)).size).toBe(HELDOUT_SUITES.length);
    expect(namespaceOf("refi-hard/1.1.0/train/3/17")).toBe("refi-hard/1.1.0");
    expect(() => namespaceOf("refi-hard/1.1.0")).toThrow(/not a task id/);
    expect(() => drawsHeldoutStream("refi-review/9.9.9/train/1/0")).toThrow(/no held-out suite/);
  });
});
