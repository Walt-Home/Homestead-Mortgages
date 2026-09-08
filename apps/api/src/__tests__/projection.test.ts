/**
 * The projection: a borrower's identity comes from the person.
 *
 * There is no column to fall back to any more. So the tests are about the
 * three things that matter now: the identity is the party's and follows them
 * across files; what is per-application stays on the row; and a missing
 * required fact is loud rather than a blank name.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import {
  factMapsByParty,
  ProjectionError,
  requireIdentity,
} from "../services/borrower-projection.js";
import { recordBorrowerFacts, type BorrowerInput } from "../services/party.js";
import { loadLoanFile } from "../services/repository.js";
import { addressSchema, identitySchema } from "../routes/files.js";
import { saveBorrower } from "./bridge.test.js";
import { createLoanFile, createUser } from "./support/factories.js";

const dana: BorrowerInput = {
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

describe("identity is the party's", () => {
  it("projects exactly what screen 2 said", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await saveBorrower(file.id, dana);
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b).toMatchObject({
      firstName: "Dana",
      lastName: "Whitfield",
      dateOfBirth: "1988-04-12",
      email: "dana@example.test",
      citizenship: "us_citizen",
      isMilitary: false,
      firstTimeHomebuyer: true,
      currentHousing: "rent",
      monthlyRent: 2150,
    });
    expect(b.ssn.vaultHandle).toBe("vault:dana:1");
    expect(b.ssn.last4).toBe("0000");
    expect(b.currentAddress.line1).toBe("1 Fixture St");
  });

  it("follows the person across files", async () => {
    // A name corrected on file B is corrected on file A: same person, one of
    // them.
    const user = await createUser();
    const a = await createLoanFile({ userId: user.id });
    const b = await createLoanFile({ userId: user.id });
    await saveBorrower(a.id, dana);
    await prisma.$transaction(async (tx) => {
      const partyId = (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).partyId!;
      await recordBorrowerFacts(tx, {
        loanFileId: b.id,
        existingPartyId: partyId,
        input: { ...dana, lastName: "Whitfield-Okafor" },
      });
    });
    expect((await loadLoanFile(a.id))!.borrowers[0]!.lastName).toBe("Whitfield-Okafor");
  });

  it("takes the old column defaults when an optional fact is absent", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, { ...dana, firstTimeHomebuyer: null });
    // Retire the language fact too; the projection defaults it rather than failing.
    const lang = await prisma.fact.findFirstOrThrow({
      where: { partyId: row.partyId, predicate: "preferred_language", supersededById: null },
    });
    await prisma.fact.update({
      where: { id: lang.id },
      data: { retractedAt: new Date(), retractionReason: "test" },
    });
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.firstTimeHomebuyer).toBeNull();
    expect(b.preferredLanguage).toBe("en");
  });
});

describe("what stays on the row", () => {
  it("keeps rent and housing per application", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.borrower.update({
      where: { id: row.id },
      data: { currentHousing: "own", monthlyRent: null },
    });
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.currentHousing).toBe("own");
    expect(b.monthlyRent).toBeUndefined();
  });

  it("keeps the HMDA demographics per application, always", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const demo = {
      ethnicity: "declined",
      race: "declined",
      sex: "declined",
      visualObservationNoted: false,
    };
    await prisma.borrower.update({ where: { id: row.id }, data: { demographics: demo } });
    expect((await loadLoanFile(file.id))!.borrowers[0]!.demographics).toEqual(demo);
  });
});

describe("a missing required fact is loud", () => {
  it("throws, naming the borrower and the predicate, rather than projecting a blank", async () => {
    // With no column to fall back to, a party with no legal_name is an
    // invariant violation. A screen rendering "" as somebody's name would be
    // worse than a request that fails and says why.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const name = await prisma.fact.findFirstOrThrow({
      where: { partyId: row.partyId, predicate: "legal_name", supersededById: null },
    });
    await prisma.fact.update({
      where: { id: name.id },
      data: { retractedAt: new Date(), retractionReason: "test" },
    });
    await expect(loadLoanFile(file.id)).rejects.toThrow(ProjectionError);
    await expect(loadLoanFile(file.id)).rejects.toThrow(/legal_name/);
  });

  it("rejects a malformed fact the same way", () => {
    const good = new Map<string, unknown>([
      ["legal_name", { first: "A", last: "B" }],
      ["date_of_birth", "1990-01-01"],
      ["ssn_token", "vault:x"],
      ["email", "a@b"],
      ["phone", "1"],
      ["current_address", { line1: "1", city: "c", state: "CA", postalCode: "9" }],
      ["marital_status", "married"],
      ["citizenship", "us_citizen"],
    ]);
    expect(requireIdentity("b", good).lastName).toBe("B");
    for (const [predicate, bad] of [
      ["legal_name", "not an object"],
      ["current_address", { line1: "" }],
      ["citizenship", "martian"],
      ["marital_status", 42],
    ] as const) {
      const m = new Map(good);
      m.set(predicate, bad);
      expect(() => requireIdentity("b", m), predicate).toThrow(ProjectionError);
      expect(() => requireIdentity("b", m), predicate).toThrow(predicate);
    }
  });
});

describe("what the route admits, the projection accepts", () => {
  // The route's schema and requireIdentity have to agree on what a blank is.
  // If the schema lets a whitespace name through, party.ts writes it as a
  // fact verbatim, the projection refuses it, and every read of the file
  // throws after the write has already landed.
  const validBody = { ...dana, ssnLast4: "1234", demographics: null };

  it("refuses whitespace where the projection would", () => {
    expect(identitySchema.safeParse({ ...validBody, phone: "       " }).success).toBe(false);
    expect(identitySchema.safeParse({ ...validBody, firstName: " " }).success).toBe(false);
    expect(
      addressSchema.safeParse({ line1: " ", city: "c", state: "  ", postalCode: "94000" }).success,
    ).toBe(false);
    expect(identitySchema.safeParse({ ...validBody, firstName: " Dana " }).data?.firstName).toBe(
      "Dana",
    );
  });

  it("a party with a bad required fact is repaired by saving screen 2 again on the same file", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const phone = await prisma.fact.findFirstOrThrow({
      where: { partyId: row.partyId, predicate: "phone", supersededById: null },
    });
    await prisma.fact.update({
      where: { id: phone.id },
      data: { retractedAt: new Date(), retractionReason: "test" },
    });
    await expect(loadLoanFile(file.id)).rejects.toThrow(ProjectionError);
    await saveBorrower(file.id, dana, row.id);
    expect((await loadLoanFile(file.id))!.borrowers[0]!.phone).toBe("5555550100");
  });
});

describe("the pure parts", () => {
  it("takes the latest observed fact when the query returns several", () => {
    const rows = [
      { partyId: "p", predicate: "email", value: "old@x", observedAt: new Date("2026-01-01") },
      { partyId: "p", predicate: "email", value: "new@x", observedAt: new Date("2026-06-01") },
      { partyId: "p", predicate: "email", value: "mid@x", observedAt: new Date("2026-03-01") },
      { partyId: null, predicate: "email", value: "orphan", observedAt: new Date("2027-01-01") },
    ];
    const byParty = factMapsByParty(rows);
    expect(byParty.get("p")?.get("email")).toBe("new@x");
    expect(byParty.size).toBe(1);
  });
});
