/**
 * A vendor report says whose it is, or says it is about an address.
 *
 * `connector_snapshots` was keyed to the loan file and nothing else, which was
 * enough while every file had one borrower. Desktop Underwriter links a
 * verification to a borrower by arc, so a submission cannot be assembled from
 * rows that cannot answer "about whom" — and on a two-person file the answer is
 * not recoverable after the fact.
 *
 * The split it enforces is the one the connector ports already draw: a pull
 * keyed on a person is guarded and names a party; a pull keyed on an address is
 * unguarded and names none. Screen 1 runs before a borrower exists, so demanding
 * a party of a property lookup would make the flow unreachable from its own
 * first step.
 *
 * Against the real Postgres, because all of it is a trigger.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { BorrowerInput } from "../services/party.js";
import { recordSnapshot } from "../services/repository.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";

const BORROWER: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 2150,
  statedMonthlyIncome: 8500,
};

/** A file with a borrower on it, and the party that borrower is a record about. */
async function fileWithParty(): Promise<{ fileId: string; partyId: string }> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, BORROWER);
  return { fileId: file.id, partyId: borrower.partyId };
}

const now = () => new Date().toISOString();

describe("a snapshot about a person", () => {
  it("is written with the party it is about", async () => {
    const { fileId, partyId } = await fileWithParty();
    const { id } = await recordSnapshot(fileId, "credit", "fixture", "ext", {}, now(), partyId);

    const row = await prisma.connectorSnapshot.findUniqueOrThrow({
      where: { id },
      select: { partyId: true },
    });
    expect(row.partyId).toBe(partyId);
  });

  it("is refused when it names nobody", async () => {
    // The row this migration exists to make impossible: evidence about a
    // borrower, on a file that may one day have two, with nothing saying which.
    const { fileId } = await fileWithParty();
    for (const kind of ["credit", "bank", "payroll", "irs", "sanctions"]) {
      await expect(
        recordSnapshot(fileId, kind, "fixture", "ext", {}, now(), null),
        kind,
      ).rejects.toThrow(/must name the party/);
    }
  });
});

describe("a snapshot about an address", () => {
  it("is written with no party, because screen 1 has none to give", async () => {
    const { fileId } = await fileWithParty();
    for (const kind of ["property_record", "valuation", "flood", "lien_search"]) {
      const { id } = await recordSnapshot(fileId, kind, "fixture", "ext", {}, now(), null);
      const row = await prisma.connectorSnapshot.findUniqueOrThrow({
        where: { id },
        select: { partyId: true },
      });
      expect(row.partyId, kind).toBeNull();
    }
  });

  it("is refused when it claims one", async () => {
    // Not pedantry. A lookup keyed on an address is the one class of retrieval
    // this product makes before anybody has authorized anything, and a row
    // saying it was about a person is the record asserting a permission that
    // was never given.
    const { fileId, partyId } = await fileWithParty();
    await expect(
      recordSnapshot(fileId, "valuation", "fixture", "ext", {}, now(), partyId),
    ).rejects.toThrow(/must not name a party/);
  });
});

describe("a kind the database has never heard of", () => {
  it("is refused rather than defaulted to nobody", async () => {
    // How this table came to hold five kinds of evidence about a borrower with
    // no borrower on it: each arrived without anybody deciding. A new kind now
    // costs a migration, which is the decision being made rather than skipped.
    const { fileId, partyId } = await fileWithParty();
    for (const party of [null, partyId]) {
      await expect(
        recordSnapshot(fileId, "employment_verification", "fixture", "ext", {}, now(), party),
      ).rejects.toThrow(/unrecognized snapshot kind/);
    }
  });
});
