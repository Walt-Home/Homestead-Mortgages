/**
 * The guesses, asserted.
 *
 * Nothing a vendor hands us identifies an employer or an income stream across
 * two pulls, so both keys are derived — and a derived key merges things that
 * are not the same and splits things that are. The point of this file is that
 * those cases are written down as expected behavior rather than found in
 * production: "Acme, Inc." and "ACME INC" ARE one employer here, deliberately,
 * and if that ever stops being true somebody chose it.
 *
 * No database. The lookups are tested in `income-identity.test.ts`; what is
 * tested here is the rule the lookups use.
 */

import { describe, expect, it } from "vitest";
import {
  employerForIncome,
  employerIdentityKey,
  employerNameKey,
  incomeIdentityKey,
} from "../employer-identity.js";

describe("which employer two pulls think they are talking about", () => {
  it("prefers the EIN, because a name is the fallback and not the answer", () => {
    const named = employerIdentityKey({ employerName: "Fixture Health Systems" });
    const withEin = employerIdentityKey({
      employerName: "Fixture Health Systems",
      employerEin: "00-0000001",
    });

    expect(named.derivedFrom).toBe("name");
    expect(withEin.derivedFrom).toBe("ein");
    expect(withEin.key).not.toBe(named.key);
    // Only the digits, so a vendor that punctuates its EINs differently from
    // the last one is still describing the same employer.
    expect(withEin.key).toBe(
      employerIdentityKey({ employerName: "x", employerEin: "000000001" }).key,
    );
  });

  it("falls back to the name when the EIN is absent or is punctuation only", () => {
    expect(employerIdentityKey({ employerName: "Acme", employerEin: null }).derivedFrom).toBe(
      "name",
    );
    expect(employerIdentityKey({ employerName: "Acme", employerEin: "--" }).derivedFrom).toBe(
      "name",
    );
  });

  it("ignores case, spacing and punctuation in a name", () => {
    expect(employerNameKey("Fixture Health Systems")).toBe(
      employerNameKey("  fixture-health   systems  "),
    );
  });

  it("merges two employers whose names normalize alike, and that is the cost", () => {
    // Not a bug to be fixed here: with a name key there is nothing else to
    // compare. A bank pull that reports "Acme, Inc." and a later one that
    // reports "ACME INC" must land on one employer row, and the price is that
    // two genuinely different Acmes under one party would too.
    expect(employerNameKey("Acme, Inc.")).toBe(employerNameKey("ACME INC"));
    expect(employerNameKey("Acme")).not.toBe(employerNameKey("Acme Two"));
  });
});

describe("which employer an income source belongs to, given that no vendor says", () => {
  it("attaches wage-shaped income to the one active employer a report names", () => {
    expect(employerForIncome("base_wage", ["e1"])).toBe("e1");
    expect(employerForIncome("commission", ["e1"])).toBe("e1");
  });

  it("attaches nothing when the report names several and cannot say which", () => {
    expect(employerForIncome("base_wage", ["e1", "e2"])).toBeNull();
    expect(employerForIncome("base_wage", [])).toBeNull();
  });

  it("never attaches income a job does not pay", () => {
    // Attaching a pension to the employer the report happens to name would be
    // an invention, and it would move with that employer's identity.
    expect(employerForIncome("retirement", ["e1"])).toBeNull();
    expect(employerForIncome("rental", ["e1"])).toBeNull();
    expect(employerForIncome("social_security", ["e1"])).toBeNull();
  });
});

describe("which income two pulls think they are talking about", () => {
  it("keys employer income by its employer and self-standing income by type", () => {
    expect(incomeIdentityKey({ type: "base_wage", employerId: "e1", ordinal: 1 })).toBe(
      "emp:e1|base_wage",
    );
    expect(incomeIdentityKey({ type: "retirement", employerId: null, ordinal: 1 })).toBe(
      "self:retirement",
    );
  });

  it("tells two same-type streams apart only by where they sat in the report", () => {
    // The weakest link, on purpose and in the open: vendor ordering is not
    // guaranteed, so these two can swap identities between pulls. Every sum
    // survives that; a per-row continuance judgment follows the wrong twin.
    const first = incomeIdentityKey({ type: "bonus", employerId: "e1", ordinal: 1 });
    const second = incomeIdentityKey({ type: "bonus", employerId: "e1", ordinal: 2 });
    expect(second).toBe(`${first}#2`);
    expect(second).not.toBe(first);
  });
});
