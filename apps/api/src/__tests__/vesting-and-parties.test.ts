/**
 * How title will read, and everybody on the deal who is not a borrower.
 *
 * `DEAL/PARTIES/PARTY` is `1:10` with the note "Each Deal must have at least
 * one party (non-Borrower) and no more than 10 Parties", and a submission made
 * only of borrowers satisfies neither half. All eighteen vendored samples carry
 * a `LoanOriginationCompany` and a `LoanOriginator`, so these two tables are a
 * dependency of the emitter rather than a convenience: without them no document
 * we could assemble would be one DU accepts.
 *
 * They are two tables because the corpus says they are two kinds of thing. All
 * twelve `PropertyOwner` parties are `INDIVIDUAL`s whose `NAME/FullName` holds
 * a vesting sentence, with no taxpayer identifier and no arc pointing at them;
 * the other four roles are institutions and one employee, and they carry a
 * license, which no borrower ever does.
 *
 * The ten is across ALL THREE sources, which is why most of this file is about
 * a count rather than a column: four borrowers, two vestings, an origination
 * company, an originator, a `NotePayTo` and a counseling agency is exactly ten,
 * and it is an ordinary file.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma, type DuDealPartyRole, type Prisma } from "@hm/db";
import { ensureApplicationParty } from "../services/applications.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";

/** A credit request with nobody on it yet. */
async function anApplication(): Promise<{ id: string }> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  return prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
}

/** One more borrowing party, through the only writer that adds one. */
async function aBorrower(applicationId: string, first = false) {
  const party = await createParty();
  return ensureApplicationParty(
    prisma,
    applicationId,
    party.id,
    first ? "PRIMARY_BORROWER" : "CO_BORROWER",
  );
}

/** How title reads after closing, unless a test says otherwise. */
function vesting(
  applicationId: string,
  overrides: Partial<Prisma.DuVestingUncheckedCreateInput> = {},
): Prisma.DuVestingUncheckedCreateInput {
  return {
    applicationId,
    status: "Proposed",
    fullName: "Andy America and Amy America",
    vestingType: "JointTenantsWithRightOfSurvivorship",
    ...overrides,
  };
}

/**
 * A deal party in the shape its role requires — an entity with a name, a
 * license on the two origination roles and none on the other two — so a test
 * about the ceiling does not have to restate the CHECKs it is not about.
 */
function dealParty(
  applicationId: string,
  role: DuDealPartyRole,
  overrides: Partial<Prisma.DuDealPartyUncheckedCreateInput> = {},
): Prisma.DuDealPartyUncheckedCreateInput {
  const licensed = role === "LoanOriginationCompany" || role === "LoanOriginator";
  const person = role === "LoanOriginator";
  return {
    applicationId,
    role,
    ...(person
      ? { firstName: "Mary", lastName: "Lender" }
      : { legalEntityName: `${role} of Record` }),
    ...(licensed
      ? { licenseIdentifier: `NMLS-${randomUUID().slice(0, 8)}`, licenseAuthorityType: "Private" }
      : {}),
    ...overrides,
  };
}

/** Everything that will emit a `PARTY`, counted the way the trigger counts it. */
async function partyCount(applicationId: string): Promise<number> {
  const [borrowing, vestings, deal] = await Promise.all([
    prisma.applicationParty.count({
      where: {
        applicationId,
        role: { in: ["PRIMARY_BORROWER", "CO_BORROWER", "NON_OCCUPANT_CO_BORROWER"] },
      },
    }),
    prisma.duVesting.count({ where: { applicationId } }),
    prisma.duDealParty.count({ where: { applicationId } }),
  ]);
  return borrowing + vestings + deal;
}

describe("the ten-party ceiling", () => {
  it("counts an ordinary full file to exactly ten and refuses the eleventh", async () => {
    // The scenario the cardinality note is about. None of these ten is
    // exotic — a household of four buying with a co-signer's title vesting
    // stated both ways, our own shop and our own officer, the holder of a
    // concurrent second, and the counseling agency a HomeReady borrower saw.
    const app = await anApplication();
    await aBorrower(app.id, true);
    await aBorrower(app.id);
    await aBorrower(app.id);
    await aBorrower(app.id);

    await prisma.duVesting.create({ data: vesting(app.id, { status: "Current" }) });
    await prisma.duVesting.create({ data: vesting(app.id, { status: "Proposed" }) });

    for (const role of [
      "LoanOriginationCompany",
      "LoanOriginator",
      "NotePayTo",
      "HousingCounselingAgency",
    ] as const) {
      await prisma.duDealParty.create({ data: dealParty(app.id, role) });
    }

    expect(await partyCount(app.id)).toBe(10);

    // And the eleventh is refused by a message that says what the document
    // would have held, because "violates check constraint" on a file with ten
    // legitimate parties on it tells whoever is reading the log nothing about
    // which one to drop.
    await expect(
      prisma.duDealParty.create({ data: dealParty(app.id, "HousingCounselingAgency") }),
    ).rejects.toThrow(
      new RegExp(`application ${app.id} would emit 11 parties: 4 borrowing, 2 vesting, 5 other`),
    );
    expect(await partyCount(app.id)).toBe(10);
  });

  it("refuses the eleventh whichever of the two tables it arrives in", async () => {
    // Ten with no vesting yet, so the row that tips it over is a vesting. Both
    // tables carry the constraint trigger; a ceiling enforced on one of the two
    // growable sources is not a ceiling.
    const app = await anApplication();
    await aBorrower(app.id, true);
    await aBorrower(app.id);
    for (const role of [
      "LoanOriginationCompany",
      "LoanOriginator",
      "NotePayTo",
      "NotePayTo",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
    ] as const) {
      await prisma.duDealParty.create({ data: dealParty(app.id, role) });
    }
    expect(await partyCount(app.id)).toBe(10);

    await expect(prisma.duVesting.create({ data: vesting(app.id) })).rejects.toThrow(
      /would emit 11 parties: 2 borrowing, 1 vesting, 8 other/,
    );
  });

  it("counts a row that is moved onto a full application, not just an inserted one", async () => {
    // An UPDATE that changes `application_id` adds a party to the destination
    // as surely as an INSERT does, and the trigger fires on both for that
    // reason. Counted where it lands: the source loses a party in the same
    // statement and nobody checks a file for being too empty.
    const full = await anApplication();
    await aBorrower(full.id, true);
    for (const role of [
      "LoanOriginationCompany",
      "LoanOriginator",
      "NotePayTo",
      "NotePayTo",
      "NotePayTo",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
    ] as const) {
      await prisma.duDealParty.create({ data: dealParty(full.id, role) });
    }
    expect(await partyCount(full.id)).toBe(10);

    const elsewhere = await anApplication();
    const stray = await prisma.duDealParty.create({
      data: dealParty(elsewhere.id, "HousingCounselingAgency"),
    });

    await expect(
      prisma.duDealParty.update({
        where: { id: stray.id },
        data: { applicationId: full.id },
      }),
    ).rejects.toThrow(/would emit 11 parties/);
    expect(await partyCount(full.id)).toBe(10);
  });

  it("still lets an over-ten file be corrected, because an edit adds nobody", async () => {
    // The price of not watching `application_parties` is that a file CAN sit
    // over ten, and a file over ten still has to be editable. An UPDATE that
    // leaves the row where it was cannot be what took the file over — the row
    // is in the count either way — so the trigger returns before it counts.
    //
    // Without that, the vesting sentence becomes uneditable on exactly the
    // files the design says are reachable, which is the one thing
    // `du_vestings` exists to carry. And because Prisma stamps `updated_at` on
    // every save, every save is an UPDATE: both tables would freeze.
    const app = await anApplication();
    await aBorrower(app.id, true);
    const title = await prisma.duVesting.create({ data: vesting(app.id, { status: "Current" }) });
    await prisma.duVesting.create({ data: vesting(app.id, { status: "Proposed" }) });
    const officer = await prisma.duDealParty.create({ data: dealParty(app.id, "LoanOriginator") });
    for (const role of [
      "LoanOriginationCompany",
      "NotePayTo",
      "NotePayTo",
      "NotePayTo",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
    ] as const) {
      await prisma.duDealParty.create({ data: dealParty(app.id, role) });
    }
    expect(await partyCount(app.id)).toBe(10);

    // Over ten, through the only writer the trigger lets do it.
    await aBorrower(app.id);
    await aBorrower(app.id);
    expect(await partyCount(app.id)).toBe(12);

    await expect(
      prisma.duVesting.update({
        where: { id: title.id },
        data: { fullName: "Andy America and Amy S America" },
      }),
    ).resolves.toMatchObject({ fullName: "Andy America and Amy S America" });

    await expect(
      prisma.duDealParty.update({
        where: { id: officer.id },
        data: { contactTelephone: "555-0100" },
      }),
    ).resolves.toMatchObject({ contactTelephone: "555-0100" });
  });

  it("lets one transaction swap a party out for another", async () => {
    // Deferred to COMMIT so a writer replacing the counseling agency does not
    // have to insert before it deletes. An immediate trigger would make the
    // order the writer happened to choose the difference between working and
    // not.
    const app = await anApplication();
    await aBorrower(app.id, true);
    const roles = [
      "LoanOriginationCompany",
      "LoanOriginator",
      "NotePayTo",
      "NotePayTo",
      "NotePayTo",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
    ] as const;
    const written: string[] = [];
    for (const role of roles) {
      const { id } = await prisma.duDealParty.create({ data: dealParty(app.id, role) });
      written.push(id);
    }

    // Insert first, delete second — the order only a deferred trigger
    // survives, because midway through this transaction the file holds eleven.
    await prisma.$transaction(async (tx) => {
      await tx.duDealParty.create({ data: dealParty(app.id, "HousingCounselingAgency") });
      await tx.duDealParty.delete({ where: { id: written[written.length - 1]! } });
    });

    expect(await partyCount(app.id)).toBe(10);
  });

  it("never fires on the borrower flow, whatever the other two tables hold", async () => {
    // The reason the trigger sits on two tables and not three. A count
    // constraint keyed on rows the writer cannot see is a lockout: the only
    // writer that adds a borrowing party is `ensureApplicationParty`, which
    // runs inside every `POST /api/files` and every consent and has never
    // heard of a vesting or a counseling agency. Refusing a co-borrower
    // because somebody recorded a counseling agency would be a failure in the
    // borrower flow caused by a table the borrower flow does not know
    // exists.
    //
    // So the honest over-ten file is reachable, and it is the preflight that
    // catches it before anything reaches DU — the same division of labor the
    // container caps already make.
    const app = await anApplication();
    await aBorrower(app.id, true);
    await prisma.duVesting.create({ data: vesting(app.id, { status: "Current" }) });
    await prisma.duVesting.create({ data: vesting(app.id, { status: "Proposed" }) });
    for (const role of [
      "LoanOriginationCompany",
      "LoanOriginator",
      "NotePayTo",
      "NotePayTo",
      "NotePayTo",
      "HousingCounselingAgency",
      "HousingCounselingAgency",
    ] as const) {
      await prisma.duDealParty.create({ data: dealParty(app.id, role) });
    }
    expect(await partyCount(app.id)).toBe(10);

    await expect(aBorrower(app.id)).resolves.toMatchObject({ borrowerOrdinal: 2 });
    await expect(aBorrower(app.id)).resolves.toMatchObject({ borrowerOrdinal: 3 });
    expect(await partyCount(app.id)).toBe(12);
  });

  it("counts only the parties on its own application", async () => {
    // Two files at five apiece are two files at five, not one at ten.
    const [a, b] = [await anApplication(), await anApplication()];
    for (const app of [a, b]) {
      await aBorrower(app.id, true);
      await prisma.duVesting.create({ data: vesting(app.id) });
      for (const role of ["LoanOriginationCompany", "LoanOriginator", "NotePayTo"] as const) {
        await prisma.duDealParty.create({ data: dealParty(app.id, role) });
      }
    }
    expect(await partyCount(a.id)).toBe(5);
    expect(await partyCount(b.id)).toBe(5);
  });
});

describe("a vesting", () => {
  it("holds the sentence, and one of it per status", async () => {
    // L2.1 is the proposed vesting and L2.2 the current one. Nine of the
    // eighteen samples carry a proposed, three of those also carry a current,
    // and none carries two of either — which is also what caps this table's
    // share of the ceiling at two.
    const app = await anApplication();
    const proposed = await prisma.duVesting.create({
      data: vesting(app.id, { fullName: "Andy America and Amy America and Ken N Customer JR" }),
    });
    expect(proposed.fullName).toBe("Andy America and Amy America and Ken N Customer JR");

    await prisma.duVesting.create({ data: vesting(app.id, { status: "Current" }) });
    await expect(prisma.duVesting.create({ data: vesting(app.id) })).rejects.toThrow(
      /du_vestings_one_per_status/,
    );
  });

  it("refuses a name that is not a name", async () => {
    // The row exists to carry a string that will read on title. Blank, it
    // emits an empty `FullName` and says nothing at all.
    const app = await anApplication();
    await expect(
      prisma.duVesting.create({ data: vesting(app.id, { fullName: "   " }) }),
    ).rejects.toThrow(/du_vestings_name_is_not_blank/);
  });

  it("states no relationship where there is none to state", async () => {
    // Three of the corpus's twelve owners carry no `RelationshipVestingType`,
    // which is what title naming one person looks like.
    const app = await anApplication();
    const solo = await prisma.duVesting.create({
      data: vesting(app.id, { fullName: "Andy America", vestingType: null }),
    });
    expect(solo.vestingType).toBeNull();
  });

  it("cannot be told about community property", async () => {
    // `CommunityProperty` is a real MISMO `RelationshipVestingBase` value and
    // a real way to hold title in nine states. It is not one of DU's six, so a
    // document carrying it validates against the vendored chain and DU rejects
    // the casefile — exactly the class of error schema validation does not
    // catch.
    //
    // Two refusals, because either alone is weak. The `@ts-expect-error` is
    // itself an assertion: `npm run check` fails if the value ever type-checks.
    // And the INSERT below goes around the client entirely, because what makes
    // this a fact about the database rather than about Prisma's validator is
    // that the COLUMN is the enumeration.
    const app = await anApplication();
    await expect(
      prisma.duVesting.create({
        data: vesting(app.id, {
          // @ts-expect-error a vesting outside RelationshipVestingType's six values does not compile
          vestingType: "CommunityProperty",
        }),
      }),
    ).rejects.toThrow(/CommunityProperty|Invalid value|invalid input value/i);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "du_vestings" (id, application_id, status, full_name, vesting_type, updated_at)
        VALUES (gen_random_uuid(), ${app.id}::uuid, 'Proposed', 'Andy America and Amy America',
                'CommunityProperty', now())
      `,
    ).rejects.toThrow(/invalid input value for enum "DuVestingType"/);
  });

  it("goes when the application does", async () => {
    const app = await anApplication();
    await prisma.duVesting.create({ data: vesting(app.id) });
    await prisma.application.delete({ where: { id: app.id } });
    expect(await prisma.duVesting.count({ where: { applicationId: app.id } })).toBe(0);
  });
});

describe("a deal party", () => {
  it("carries the name its role's container has", async () => {
    // A person's name and an entity's name are different elements, and the
    // role decides which one the emitter reaches for. All eighteen samples
    // emit the originator as an `INDIVIDUAL` and the other three as
    // `LEGAL_ENTITY`s, so a row holding both names, or the wrong one, is a row
    // the emitter cannot place.
    const app = await anApplication();
    const originator = await prisma.duDealParty.create({
      data: dealParty(app.id, "LoanOriginator"),
    });
    expect(originator.legalEntityName).toBeNull();
    expect(originator.lastName).toBe("Lender");

    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "LoanOriginator", { legalEntityName: "ABC Mortgage" }),
      }),
    ).rejects.toThrow(/du_deal_parties_name_matches_the_role/);

    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "LoanOriginationCompany", { firstName: "Mary" }),
      }),
    ).rejects.toThrow(/du_deal_parties_name_matches_the_role/);
  });

  it("cannot record a private note holder, and that is a decision", async () => {
    // Pinned so the next person meets the decision rather than the constraint.
    // DU Map 4b.1 "Creditor Name" gives `NotePayTo` BOTH containers, and the
    // Enumerations tab defines the role as "The individual or legal entity
    // whose name appears on a note to whom the repayment of the obligation is
    // due" — so a seller carryback or a private second, the concurrent
    // subordinate financing this role exists for, has a person as the note
    // holder and cannot be recorded here.
    //
    // The narrowing is deliberate: DU's individual slot at 4b.1 is an unparsed
    // `NAME/FullName`, which the parsed columns on this table cannot express,
    // and all nine NotePayTo parties in the corpus are institutions. What a
    // private note holder needs is that unparsed name, not a wider CHECK.
    const app = await anApplication();
    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "NotePayTo", {
          legalEntityName: null,
          firstName: "Ken",
          lastName: "Customer",
        }),
      }),
    ).rejects.toThrow(/du_deal_parties_name_matches_the_role/);
  });

  it("is allowed to have no name at all", async () => {
    // Two of the eighteen origination companies carry no name element. The
    // CHECK says which name a row may have, not that it must have one.
    const app = await anApplication();
    const anonymous = await prisma.duDealParty.create({
      data: dealParty(app.id, "LoanOriginationCompany", { legalEntityName: null }),
    });
    expect(anonymous.legalEntityName).toBeNull();
  });

  it("is licensed on the two origination roles and refused a license on the other two", async () => {
    // Required here, refused there, rather than a nullable column that means
    // nothing in particular. All eighteen samples carry exactly one license on
    // the company and one on the originator, and zero on the nine `NotePayTo`
    // and six counseling agencies — the DU form has no license field for
    // either, so a number stored on one would be emitted nowhere.
    const app = await anApplication();

    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "LoanOriginationCompany", {
          licenseIdentifier: null,
          licenseAuthorityType: null,
        }),
      }),
    ).rejects.toThrow(/du_deal_parties_origination_roles_are_licensed/);

    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "NotePayTo", {
          licenseIdentifier: "NMLS-1",
          licenseAuthorityType: "PublicState",
        }),
      }),
    ).rejects.toThrow(/du_deal_parties_origination_roles_are_licensed/);
  });

  it("says which register its license is from", async () => {
    // A number without an authority level does not say which of the two slots
    // it belongs in. All thirty-six licenses in the corpus carry one.
    const app = await anApplication();
    await expect(
      prisma.duDealParty.create({
        data: dealParty(app.id, "LoanOriginator", { licenseAuthorityType: null }),
      }),
    ).rejects.toThrow(/du_deal_parties_a_license_says_which_register/);

    const state = await prisma.duDealParty.create({
      data: dealParty(app.id, "LoanOriginator", { licenseAuthorityType: "PublicState" }),
    });
    expect(state.licenseAuthorityType).toBe("PublicState");
  });

  it("takes more than one of a role, because nothing says a deal has one", async () => {
    // No unique on the role. `PARTY` is `1:10` and nothing in the
    // specification says a deal has a single counseling agency, so the ceiling
    // is the rule that binds and a unique index would quietly replace it with
    // a different, stricter one.
    const app = await anApplication();
    await prisma.duDealParty.create({ data: dealParty(app.id, "HousingCounselingAgency") });
    await prisma.duDealParty.create({ data: dealParty(app.id, "HousingCounselingAgency") });
    expect(await prisma.duDealParty.count({ where: { applicationId: app.id } })).toBe(2);
  });

  it("is not a borrower and is not a vesting", async () => {
    // `PartyRoleType` has eight values and this table holds four of them.
    // `Borrower` is `application_parties`, with a position and a borrowing
    // role; `PropertyOwner` carries a sentence rather than a person and is
    // `du_vestings`. Neither is nameable here, which is what keeps the "is
    // this a DU Borrower" question from having to be asked by exclusion.
    //
    // Eight and not thirteen: thirteen is the tab's ROW count, and `Borrower`
    // is filed four times, `PropertyOwner` and `HousingCounselingAgency` twice
    // each. Four here plus the four excluded is the whole set, which is why
    // `SubmittingParty` and `Trust` are the only two left to account for.
    const app = await anApplication();
    await expect(
      prisma.duDealParty.create({
        // @ts-expect-error a borrower is not a deal party
        data: dealParty(app.id, "Borrower"),
      }),
    ).rejects.toThrow(/Borrower|Invalid value|invalid input value/i);
    await expect(
      prisma.duDealParty.create({
        // @ts-expect-error a property owner is a vesting, not a deal party
        data: dealParty(app.id, "PropertyOwner"),
      }),
    ).rejects.toThrow(/PropertyOwner|Invalid value|invalid input value/i);
  });

  it("goes when the application does", async () => {
    const app = await anApplication();
    await prisma.duDealParty.create({ data: dealParty(app.id, "LoanOriginator") });
    await prisma.application.delete({ where: { id: app.id } });
    expect(await prisma.duDealParty.count({ where: { applicationId: app.id } })).toBe(0);
  });
});
