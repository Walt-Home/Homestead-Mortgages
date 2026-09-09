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
import { createDraftApplication } from "../services/applications.js";
import { pinTridPieces } from "../services/evidence.js";
import { consent, createLoanFile, createUser, saveBorrower } from "./support/factories.js";

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

describe("APP-002's input comes from the ledger", () => {
  /** Screen 1 and screen 2, through the services, up to the receipt. */
  async function receivedApplication() {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const borrower = await saveBorrower(file.id, dana);
    const applicationId = await prisma.$transaction(async (tx) => {
      const made = await createDraftApplication(tx, {
        loanFileId: file.id,
        partyId: borrower.partyId,
        terms: {
          objective: "PURCHASE",
          occupancy: "PRIMARY_RESIDENCE",
          loanAmountCents: 33_200_000n,
          valueEstimateCents: 41_500_000n,
          termMonths: 360,
          propertyAddress: "88 Foster Lane, Austin, TX 78745",
        },
      });
      return made.applicationId;
    });
    // The consent mirrors to the grant the pins borrow under; the third pin
    // stamps the receipt.
    await consent(file.id, borrower.id, "verification_authorization");
    await pinTridPieces(prisma, { applicationId, partyId: borrower.partyId });
    return { file, applicationId, borrower };
  }

  it("reads the receipt from the row the trigger wrote", async () => {
    // The column this used to read was stamped by a second judgment in the
    // API, so two things could both claim to know when an application began.
    // The ledger row is the one that opened the Loan Estimate clock.
    const { file, applicationId } = await receivedApplication();
    const received = await prisma.applicationTransition.findFirstOrThrow({
      where: { applicationId, event: "intake_completed" },
      select: { occurredAt: true },
    });

    const projected = (await loadLoanFile(file.id))!.application;
    expect(projected?.receivedAt).toBe(received.occurredAt.toISOString());
  });

  it("answers the engine in the engine's six words", async () => {
    // The pins and the scenario speak predicates and column names; APP-002
    // reads name, income, ssn, propertyAddress, valueEstimate, loanAmount. The
    // mapping is the whole of it, and a missed key would read as a piece the
    // application does not hold.
    const { file } = await receivedApplication();
    const pieces = (await loadLoanFile(file.id))!.application!.sixPieces;
    expect(pieces).toEqual({
      name: true,
      income: true,
      ssn: true,
      propertyAddress: true,
      valueEstimate: true,
      loanAmount: true,
    });
  });

  it("is null for a file with no application, and for one still at draft", async () => {
    // Null means APP-002 is outstanding, which is the truthful reading for a
    // file created before the join existed — and for a draft, which by
    // definition has not been received.
    const user = await createUser();
    const legacy = await createLoanFile({ userId: user.id });
    await saveBorrower(legacy.id, dana);
    expect((await loadLoanFile(legacy.id))!.application).toBeNull();

    const drafted = await createLoanFile({ userId: user.id });
    const borrower = await saveBorrower(drafted.id, dana);
    await prisma.$transaction((tx) =>
      createDraftApplication(tx, {
        loanFileId: drafted.id,
        partyId: borrower.partyId,
        terms: {
          objective: "PURCHASE",
          occupancy: "PRIMARY_RESIDENCE",
          loanAmountCents: 33_200_000n,
          valueEstimateCents: 41_500_000n,
          termMonths: 360,
          propertyAddress: "88 Foster Lane, Austin, TX 78745",
        },
      }),
    );
    expect((await loadLoanFile(drafted.id))!.application).toBeNull();
  });
});

describe("who a file is about", () => {
  /** A second person on a file, with their own party and their own facts. */
  async function addBorrower(
    loanFileId: string,
    firstName: string,
    createdAt: Date,
    id?: string,
  ): Promise<string> {
    const party = await prisma.party.create({ data: { kind: "PERSON" }, select: { id: true } });
    return prisma.$transaction(async (tx) => {
      await recordBorrowerFacts(tx, {
        loanFileId,
        existingPartyId: party.id,
        input: { ...dana, firstName, ssnVaultHandle: `vault:${firstName.toLowerCase()}:1` },
      });
      const row = await tx.borrower.create({
        data: {
          ...(id ? { id } : {}),
          loanFileId,
          partyId: party.id,
          ssnLast4: "1111",
          currentHousing: "rent",
          createdAt,
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  it("is the borrower recorded first, not the one the heap returns first", async () => {
    // Every route reads `borrowers[0]` and means the person whose request this
    // is. Unordered, that is the physical order of the rows, which has nothing
    // to do with who applied — here the later person was inserted first.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await addBorrower(file.id, "Dev", new Date("2026-06-02T10:00:00Z"));
    await addBorrower(file.id, "Dana", new Date("2026-06-01T10:00:00Z"));

    expect((await loadLoanFile(file.id))!.borrowers.map((b) => b.firstName)).toEqual([
      "Dana",
      "Dev",
    ]);
  });

  it("breaks a tie on the id, so two rows a millisecond apart are still ordered", async () => {
    // Two borrowers created in one transaction share `now()`, and at
    // TIMESTAMP(3) they can share the millisecond outright. Without a second
    // key that is a coin toss over which person a file is about.
    //
    // The ids are fixed rather than generated, and deliberately out of step
    // with the insertion order: Dev goes in first holding the HIGHER one. A
    // random pair would leave this agreeing with the heap order about half the
    // time, which is a test that cannot fail on the bug it is here for.
    const DEV = "dddddddd-dddd-4ddd-8ddd-ddddddd00002";
    const DANA = "dddddddd-dddd-4ddd-8ddd-ddddddd00001";
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const sameInstant = new Date("2026-06-01T10:00:00.000Z");
    await addBorrower(file.id, "Dev", sameInstant, DEV);
    await addBorrower(file.id, "Dana", sameInstant, DANA);

    const projected = (await loadLoanFile(file.id))!.borrowers;
    expect(projected.map((b) => b.id)).toEqual([DANA, DEV]);
  });
});
