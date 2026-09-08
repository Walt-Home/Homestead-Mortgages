/**
 * The read-flip.
 *
 * Since the bridge, every identity field is written twice — a column on
 * `borrowers` and a fact on the party. This is where a screen starts reading
 * the fact, and these tests are about what that means when the two DISAGREE,
 * because when they agree nobody can tell which one is being read.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { factMapsByParty, identityFromFacts } from "../services/borrower-projection.js";
import { recordBorrowerFacts, type BorrowerInput } from "../services/party.js";
import { loadLoanFile } from "../services/repository.js";
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

/** Screen 2, both ways, as the route does it. */
async function saveBorrower(loanFileId: string, input: BorrowerInput) {
  return prisma.$transaction(async (tx) => {
    const partyId = await recordBorrowerFacts(tx, { loanFileId, existingPartyId: null, input });
    return tx.borrower.create({
      data: {
        loanFileId,
        partyId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        dateOfBirth: new Date(input.dateOfBirth),
        ssnVaultHandle: input.ssnVaultHandle!,
        ssnLast4: "0000",
        addressLine1: input.currentAddress.line1,
        addressCity: input.currentAddress.city,
        addressState: input.currentAddress.state,
        addressPostalCode: input.currentAddress.postalCode,
        maritalStatus: input.maritalStatus,
        citizenship: input.citizenship,
        preferredLanguage: input.preferredLanguage,
        firstTimeHomebuyer: input.firstTimeHomebuyer ?? null,
        isMilitary: input.isMilitary,
        currentHousing: input.currentHousing,
        monthlyRent: input.monthlyRent ?? null,
      },
      select: { id: true, partyId: true },
    });
  });
}

describe("when the row and the party agree", () => {
  it("projects exactly what screen 2 wrote", async () => {
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
    expect(b.currentAddress.line1).toBe("1 Fixture St");
  });
});

describe("when they disagree, identity is the party's", () => {
  it("reads the name, contact and citizenship from the fact, not the column", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    // Corrupt the row behind the projection's back. If the flip is real, none
    // of this reaches a screen.
    await prisma.borrower.update({
      where: { id: row.id },
      data: {
        firstName: "WRONG",
        lastName: "WRONG",
        email: "wrong@example.test",
        phone: "0000000000",
        citizenship: "non_permanent_resident",
        maritalStatus: "separated",
        isMilitary: true,
        dateOfBirth: new Date("1970-01-01"),
        ssnVaultHandle: "vault:wrong",
        addressLine1: "99 Wrong Way",
      },
    });
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.firstName).toBe("Dana");
    expect(b.lastName).toBe("Whitfield");
    expect(b.email).toBe("dana@example.test");
    expect(b.phone).toBe("5555550100");
    expect(b.citizenship).toBe("us_citizen");
    expect(b.maritalStatus).toBe("unmarried");
    expect(b.isMilitary).toBe(false);
    expect(b.dateOfBirth).toBe("1988-04-12");
    expect(b.ssn.vaultHandle).toBe("vault:dana:1");
    expect(b.currentAddress.line1).toBe("1 Fixture St");
  });

  it("keeps the situational fields on the row", async () => {
    // What they pay now, on this file, is not a fact about the person.
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

  it("keeps the HMDA demographics on the row, always", async () => {
    // Collected per application by law. Even a party with every other fact
    // never supplies these.
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
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.demographics).toEqual(demo);
  });

  it("follows the person across files", async () => {
    // The point of a party. A name corrected on file B is corrected on file A,
    // because it is the same person and there is one of them.
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
    const onA = (await loadLoanFile(a.id))!.borrowers[0]!;
    expect(onA.lastName).toBe("Whitfield-Okafor");
  });
});

describe("when there is nothing to read from", () => {
  it("projects a legacy row entirely from its columns", async () => {
    const file = await createLoanFile({ userId: null, isDemo: true });
    await prisma.borrower.create({
      data: {
        loanFileId: file.id,
        firstName: "Old",
        lastName: "Row",
        email: "old@example.test",
        phone: "5555550100",
        dateOfBirth: new Date("1980-01-01"),
        ssnLast4: "0000",
        ssnVaultHandle: "vault:old",
        addressLine1: "1 Old St",
        addressCity: "X",
        addressState: "CA",
        addressPostalCode: "90000",
        maritalStatus: "married",
      },
    });
    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.partyId).toBeNull();
    expect(b.firstName).toBe("Old");
    expect(b.maritalStatus).toBe("married");
  });

  it("falls back per field, never per borrower", async () => {
    // A party with SOME facts. The ones it has win; the ones it lacks come
    // from the row. A malformed fact counts as absent.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const partyId = row.partyId!;
    const principal = await prisma.principal.findFirstOrThrow({ where: { partyId } });
    // Retract the email fact and assert a malformed marital status.
    const emailFact = await prisma.fact.findFirstOrThrow({
      where: { partyId, predicate: "email", supersededById: null },
    });
    await prisma.fact.update({
      where: { id: emailFact.id },
      data: { retractedAt: new Date(), retractionReason: "test" },
    });
    const bad = await prisma.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: partyId,
        partyId,
        predicate: "marital_status",
        value: "confused",
        sourceKind: "SELF_ATTESTED",
        confidence: "ATTESTED",
        assertedByPrincipalId: principal.id,
        observedAt: new Date(),
      },
    });
    const prior = await prisma.fact.findFirstOrThrow({
      where: { partyId, predicate: "marital_status", supersededById: null, id: { not: bad.id } },
    });
    await prisma.fact.update({ where: { id: prior.id }, data: { supersededById: bad.id } });
    await prisma.borrower.update({
      where: { id: row.id },
      data: { email: "column@example.test", maritalStatus: "separated" },
    });

    const b = (await loadLoanFile(file.id))!.borrowers[0]!;
    expect(b.email).toBe("column@example.test");
    expect(b.maritalStatus).toBe("separated");
    expect(b.firstName).toBe("Dana");
  });
});

describe("the pure parts", () => {
  it("treats a malformed fact as absent rather than crashing the projection", () => {
    const m = new Map<string, unknown>([
      ["legal_name", "not an object"],
      ["current_address", { line1: "" }],
      ["is_military", "yes"],
      ["citizenship", "martian"],
      ["email", "   "],
    ]);
    expect(identityFromFacts(m)).toEqual({});
  });

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
