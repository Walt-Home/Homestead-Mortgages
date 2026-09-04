/**
 * Reading one value out of the ledger.
 *
 * These are the rules most likely to be got subtly wrong, and they are pure, so
 * they are tested without a database. The constraints that need Postgres to
 * mean anything — append-only, and the ceiling on what an AI may assert — are
 * in apps/api/src/__tests__/facts.test.ts.
 */

import { describe, expect, it } from "vitest";
import { atLeast, meetsFloor, standingOf, type Fact } from "../facts.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function fact(over: Partial<Fact> & { id: string }): Fact {
  return {
    predicate: "annual_income",
    subjectKey: "",
    value: 120_000,
    sourceKind: "self_attested",
    confidence: "attested",
    observedAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    supersededById: null,
    retractedAt: null,
    ...over,
  };
}

describe("confidence ordering", () => {
  it("runs weakest to strongest", () => {
    expect(atLeast("verified", "corroborated")).toBe(true);
    expect(atLeast("corroborated", "verified")).toBe(false);
    expect(atLeast("attested", "attested")).toBe(true);
  });

  it("puts validated_d1c at the top and attested at the bottom", () => {
    expect(atLeast("validated_d1c", "verified")).toBe(true);
    expect(atLeast("attested", "unverified")).toBe(false);
  });

  it("does not treat inferred as verified, however clean the pattern", () => {
    // Income read off deposits is an inference. It can be a very good one and
    // it is still not a consumer report.
    expect(atLeast("inferred", "verified")).toBe(false);
  });
});

describe("standingOf", () => {
  it("says absent when nobody has ever asserted it", () => {
    const s = standingOf([], "annual_income", NOW);
    expect(s.status).toBe("absent");
    expect(s.fact).toBeNull();
  });

  it("does not confuse absent with a value of false", () => {
    // The distinction the rest of the product keeps losing: "we have not asked"
    // is a different answer from "we asked and it is false".
    const asserted = standingOf([fact({ id: "a", value: false })], "annual_income", NOW);
    expect(asserted.status).toBe("live");
    expect(asserted.fact?.value).toBe(false);
  });

  it("prefers the most recently OBSERVED, not the most recently recorded", () => {
    // A January paystub entered today does not outrank a March one entered
    // last week.
    const january = fact({
      id: "jan",
      observedAt: "2026-01-15T00:00:00.000Z",
      recordedAt: "2026-09-03T00:00:00.000Z",
    });
    const march = fact({
      id: "mar",
      observedAt: "2026-03-15T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(standingOf([january, march], "annual_income", NOW).fact?.id).toBe("mar");
  });

  it("ignores retracted and superseded rows", () => {
    const retracted = fact({ id: "r", retractedAt: "2026-02-01T00:00:00.000Z" });
    const superseded = fact({ id: "s", supersededById: "t" });
    expect(standingOf([retracted, superseded], "annual_income", NOW).status).toBe("absent");
  });

  it("reports expired rather than absent when what we hold has aged out", () => {
    // A stale credit pull is not the same as never having pulled credit: one is
    // a re-pull, the other is a first ask.
    const stale = fact({ id: "e", expiresAt: "2026-08-01T00:00:00.000Z" });
    const s = standingOf([stale], "annual_income", NOW);
    expect(s.status).toBe("expired");
    expect(s.fact?.id).toBe("e");
  });

  it("keeps facts of one predicate apart by subject key", () => {
    // Two employers are two facts, not one fact that keeps changing.
    const acme = fact({ id: "a", subjectKey: "employer:acme", value: 90_000 });
    const globex = fact({ id: "g", subjectKey: "employer:globex", value: 30_000 });
    expect(standingOf([acme, globex], "annual_income", NOW, "employer:globex").fact?.value).toBe(
      30_000,
    );
  });

  it("is stable when two rows tie on both timestamps", () => {
    const a = fact({ id: "aaa" });
    const b = fact({ id: "bbb" });
    expect(standingOf([a, b], "annual_income", NOW).fact?.id).toBe(
      standingOf([b, a], "annual_income", NOW).fact?.id,
    );
  });
});

describe("meetsFloor", () => {
  it("separates 'we never asked' from 'it does not clear the bar'", () => {
    expect(meetsFloor(standingOf([], "annual_income", NOW), "verified")).toBe("unknown");
    expect(
      meetsFloor(
        standingOf([fact({ id: "a", confidence: "inferred" })], "annual_income", NOW),
        "verified",
      ),
    ).toBe("not_met");
  });

  it("treats expired evidence as not meeting the floor, whatever its tier", () => {
    const stale = fact({
      id: "e",
      confidence: "validated_d1c",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(meetsFloor(standingOf([stale], "annual_income", NOW), "attested")).toBe("not_met");
  });

  it("is met when a live fact clears the bar", () => {
    const good = fact({ id: "v", confidence: "verified" });
    expect(meetsFloor(standingOf([good], "annual_income", NOW), "corroborated")).toBe("met");
  });
});
