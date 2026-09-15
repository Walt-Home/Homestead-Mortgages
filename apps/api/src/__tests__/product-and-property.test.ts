/**
 * The three columns that describe the subject property, and where each answer
 * is allowed to come from.
 *
 * Desktop Underwriter requires a unit count and an estate type on every
 * casefile with no condition in front of either, and an attachment type the
 * moment the unit count exists. They do not all come from the same place, and
 * that split is the thing these tests hold: the county knows how many units a
 * building has and whether it shares a wall, and nobody but the borrower knows
 * whether the land comes with the house.
 *
 * **Nothing here defaults.** An address no property-data vendor answers for
 * leaves both retrieved columns null, and a borrower who has not reached screen
 * 3 leaves the third one null. That is what makes the preflight's refusal
 * meaningful — `du-submission.test.ts` is where it refuses — and it is the
 * mistake `borrowers.current_housing` already made once, when a NOT NULL column
 * with a default of `'rent'` had every borrower renting because no screen ever
 * asked.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { PropertyRecord } from "@hm/shared";
import { ensureApplicationParty } from "../services/applications.js";
import { declarationRouter } from "../routes/declarations.js";
import { fileRouter } from "../routes/files.js";
import { buildingFacts, propertyFileRouter } from "../routes/property.js";
import type { BorrowerInput } from "../services/party.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const nadia: BorrowerInput = {
  firstName: "Nadia",
  lastName: "Okonkwo",
  email: "nadia@example.test",
  phone: "5555550188",
  dateOfBirth: "1990-02-02",
  ssnVaultHandle: "vault:nadia:1",
  currentAddress: { line1: "5 Fixture Ave", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  statedMonthlyIncome: 9000,
};

/**
 * The product every file in this repository is quoted against, seeded by the
 * migration that created the table. Named here rather than read off `config`,
 * because a test that reads an environment variable passes or fails on
 * somebody's shell.
 */
const PRODUCT_CODE = "CONF-30-FIXED";

/** The three addresses the property fixture holds a record for, and one it does not. */
const AUSTIN_HOUSE = {
  propertyLine1: "1247 Oak Street",
  propertyCity: "Austin",
  propertyState: "TX",
  propertyPostalCode: "78704",
};
const ATLANTA_CONDO = {
  propertyLine1: "540 Ponce De Leon Ave NE",
  propertyLine2: "Unit 312",
  propertyCity: "Atlanta",
  propertyState: "GA",
  propertyPostalCode: "30308",
};
const NOWHERE_ON_RECORD = {
  propertyLine1: "9 Unmapped Lane",
  propertyCity: "Elsewhere",
  propertyState: "MT",
  propertyPostalCode: "59001",
};

/** A file that has become an application, on a given address. */
async function applicationOn(address: Record<string, string>) {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  await prisma.loanFile.update({ where: { id: file.id }, data: address });
  const borrower = await saveBorrower(file.id, nadia);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await ensureApplicationParty(prisma, app.id, borrower.partyId, "PRIMARY_BORROWER");
  return { user, file };
}

function buildingOf(fileId: string) {
  return prisma.loanFile.findUniqueOrThrow({
    where: { id: fileId },
    select: {
      financedUnitCount: true,
      propertyAttachmentType: true,
      propertyEstateType: true,
    },
  });
}

/** Every answer no, one current residence, and the estate the screen asks for. */
function declaration(overrides: Record<string, unknown> = {}) {
  return {
    propertyEstateType: "FeeSimple",
    declaration: {
      intentToOccupy: "Yes",
      homeownerPastThreeYears: "No",
      undisclosedBorrowedFunds: false,
      undisclosedMortgageApplication: false,
      undisclosedCreditApplication: false,
      propertyProposedCleanEnergyLien: false,
      undisclosedComakerOfNote: false,
      outstandingJudgments: false,
      presentlyDelinquent: false,
      priorPropertyDeedInLieuConveyed: false,
      priorPropertyShortSaleCompleted: false,
      priorPropertyForeclosureCompleted: false,
      bankruptcy: false,
    },
    residences: [
      { residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2150 },
    ],
    ...overrides,
  };
}

describe("what the county answers", () => {
  it("writes the unit count and the attachment off the assessor record", async () => {
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: null,
      propertyAttachmentType: null,
      propertyEstateType: null,
    });

    const res = await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);
    expect(res.status).toBe(201);

    // Written from the connector result, not from anything the client sent —
    // screen 1 echoes a property type back to us on create, and a column DU
    // reads should not be a value a browser could have edited on its way past.
    const building = await buildingOf(file.id);
    expect(building.financedUnitCount).toBe(1);
    expect(building.propertyAttachmentType).toBe("Detached");
    // The estate is not the county's to answer and this retrieval leaves it
    // alone, which is the whole of the split.
    expect(building.propertyEstateType).toBeNull();
  });

  it("says Attached for a condominium and Detached for a house", async () => {
    // Two of the fixture's three addresses, and the only pair that could show
    // the value is read rather than assumed. `AttachmentType` is not derivable
    // from a property type either way — six of the eighteen shipped DU samples
    // say Attached on files whose type says nothing of the kind — so the
    // assessor record is where it comes from.
    const house = await applicationOn(AUSTIN_HOUSE);
    const condo = await applicationOn(ATLANTA_CONDO);
    await callAs(house.user.id, [propertyFileRouter], "POST", `/${house.file.id}/property-data`);
    await callAs(condo.user.id, [propertyFileRouter], "POST", `/${condo.file.id}/property-data`);

    expect((await buildingOf(house.file.id)).propertyAttachmentType).toBe("Detached");
    expect((await buildingOf(condo.file.id)).propertyAttachmentType).toBe("Attached");
  });

  it("writes neither for an address no vendor holds a record for", async () => {
    // A legitimate file — new construction, a bad parse, a county we do not
    // cover — and the honest state for it is two nulls. A 1 and a Detached
    // here would be a fact about a building nobody has looked at, on a federal
    // submission.
    const { user, file } = await applicationOn(NOWHERE_ON_RECORD);

    const res = await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);
    expect(res.status).toBe(404);
    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: null,
      propertyAttachmentType: null,
      propertyEstateType: null,
    });
  });
});

describe("what only the borrower can answer", () => {
  it("writes the estate type screen 3 asks for", async () => {
    const { user, file } = await applicationOn(AUSTIN_HOUSE);

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declaration({ propertyEstateType: "Leasehold" }),
    );
    expect(res.status).toBe(201);

    // On the FILE and not on the declaration: one house is held on one estate,
    // and a per-borrower row would let two people on one application state two.
    expect((await buildingOf(file.id)).propertyEstateType).toBe("Leasehold");
  });

  it("refuses a declaration that leaves it out, by name", async () => {
    // The same rule as every other required field on this route. There is no
    // way to say "unanswered" on the wire, so a screen that let this through
    // would become a casefile refused after the borrower had gone.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    const body = declaration();
    delete (body as Record<string, unknown>).propertyEstateType;

    const res = await callAs(user.id, [declarationRouter], "POST", `/${file.id}/declaration`, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("propertyEstateType");
    expect((await buildingOf(file.id)).propertyEstateType).toBeNull();
  });

  it("takes a second borrower's answer as the same fact about the same house", async () => {
    // A co-borrower's save restates the estate rather than owing one of their
    // own, so the last answer stands and nothing is left half-written.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declaration({ propertyEstateType: "Leasehold" }),
    );
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declaration({ propertyEstateType: "FeeSimple" }),
    );

    expect((await buildingOf(file.id)).propertyEstateType).toBe("FeeSimple");
  });
});

describe("what a moved address forgets", () => {
  /** Screen 1's own save, which is where a corrected address comes from. */
  function screenOne(address: { line1: string; city: string; state: string; postalCode: string }) {
    return {
      purpose: "purchase" as const,
      address,
      propertyType: "single_family" as const,
      occupancy: "primary_residence" as const,
      valueOrPrice: 500_000,
      loanAmount: 400_000,
      downPayment: 100_000,
      statedMonthlyIncome: 9_000,
    };
  }

  it("drops the county's answer and the borrower's when the borrower moves the address", async () => {
    // The mistyped address, corrected after the lookup card rendered. All three
    // columns describe one building, and two of them were answered by a county
    // asked about a different one — so leaving them is a casefile that pairs
    // the new address with the old PROPERTY_DETAIL, with nothing null for the
    // preflight to refuse.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declaration({ propertyEstateType: "Leasehold" }),
    );
    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: 1,
      propertyAttachmentType: "Detached",
      propertyEstateType: "Leasehold",
    });

    const res = await callAs(
      user.id,
      [fileRouter],
      "PATCH",
      `/${file.id}`,
      screenOne({
        line1: NOWHERE_ON_RECORD.propertyLine1,
        city: NOWHERE_ON_RECORD.propertyCity,
        state: NOWHERE_ON_RECORD.propertyState,
        postalCode: NOWHERE_ON_RECORD.propertyPostalCode,
      }),
    );
    expect(res.status).toBe(200);

    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: null,
      propertyAttachmentType: null,
      propertyEstateType: null,
    });
  });

  it("drops them for any door onto the address, not only the screen's", async () => {
    // The rule is in the database rather than in the route, for the reason the
    // unit-count CHECK is: these arrive from a vendor as well as from a person,
    // and the route that moves an address today is not the only one there will
    // ever be.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);

    await prisma.loanFile.update({ where: { id: file.id }, data: { propertyCity: "Round Rock" } });

    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: null,
      propertyAttachmentType: null,
      propertyEstateType: null,
    });
  });

  it("keeps a building fact the same write restates", async () => {
    // Forgetting the old building is not refusing to describe the new one. A
    // move that arrives with the new county record attached is one write, and
    // only the columns it left alone belong to the address that just went.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declaration({ propertyEstateType: "Leasehold" }),
    );

    await prisma.loanFile.update({
      where: { id: file.id },
      data: { ...ATLANTA_CONDO, financedUnitCount: 4, propertyAttachmentType: "Attached" },
    });

    expect(await buildingOf(file.id)).toEqual({
      financedUnitCount: 4,
      propertyAttachmentType: "Attached",
      // Not restated by that write, and the county cannot restate it anyway.
      propertyEstateType: null,
    });
  });

  it("leaves the building alone when the address did not move", async () => {
    // Screen 1 sends the address on every save, changed or not. A borrower who
    // came back to fix the price must not lose the county's answer.
    const { user, file } = await applicationOn(AUSTIN_HOUSE);
    await callAs(user.id, [propertyFileRouter], "POST", `/${file.id}/property-data`);

    const res = await callAs(user.id, [fileRouter], "PATCH", `/${file.id}`, {
      ...screenOne({
        line1: AUSTIN_HOUSE.propertyLine1,
        city: AUSTIN_HOUSE.propertyCity,
        state: AUSTIN_HOUSE.propertyState,
        postalCode: AUSTIN_HOUSE.propertyPostalCode,
      }),
      valueOrPrice: 525_000,
    });
    expect(res.status).toBe(200);

    const building = await buildingOf(file.id);
    expect(building.financedUnitCount).toBe(1);
    expect(building.propertyAttachmentType).toBe("Detached");
  });
});

describe("what the route refuses to write", () => {
  it("stops the pull on an attachment nobody mapped", async () => {
    // `undefined` is what an unmapped vendor string would produce, and Prisma
    // reads `undefined` as "leave this column alone" — so the column would keep
    // whatever it held, which is the one outcome worse than either answer. The
    // fixture's union holds today; the field is documented as the one a real
    // Places, Smarty or ATTOM adapter fills from parsed vendor JSON.
    const record = {
      attachment: "semi-detached",
      units: 1,
    } as unknown as PropertyRecord;

    expect(() => buildingFacts(record)).toThrow(/not an attachment this route can name/);
  });
});

describe("what the database refuses", () => {
  it("will not hold a unit count this product does not underwrite", async () => {
    // One to four dwelling units is the whole of what DU underwrites here:
    // five is a commercial loan and zero is not a house. The CHECK is on the
    // column rather than in the route because a unit count arrives from a
    // vendor as well as from a person, and the route is only one of the doors.
    const { file } = await applicationOn(AUSTIN_HOUSE);

    for (const units of [0, 5, 12]) {
      await expect(
        prisma.loanFile.update({
          where: { id: file.id },
          data: { financedUnitCount: units },
        }),
      ).rejects.toThrow(/loan_files_financed_unit_count_is_one_to_four/);
    }
    expect((await buildingOf(file.id)).financedUnitCount).toBeNull();
  });

  it("will not quote a file against a product whose characteristics nobody holds", async () => {
    // The argument for the table being a table. Seven data points DU requires
    // on the loan being applied for come off the product row, and there is no
    // honest way to invent them for a code nothing defines — so the foreign key
    // refuses the quote rather than the emitter refusing the casefile later.
    const { file } = await applicationOn(AUSTIN_HOUSE);

    await expect(
      prisma.loanFile.update({
        where: { id: file.id },
        // A whole quote, because `loan_files_quote_a_whole_product_or_none`
        // refuses a code beside a null rate — this test is about the code
        // having nothing behind it, not about a half-written quote.
        data: { productCode: "CONF-30-IMAGINARY", termMonths: 360, noteRate: 6.25 },
      }),
    ).rejects.toThrow(/loan_files_product_code_fkey/);
  });

  it("will not move a quoted file onto a renamed product", async () => {
    // A cascading rename re-points every historical file at whatever the new
    // code means, which is the same loss as deleting the row with a different
    // spelling on it. RESTRICT on both sides, so the rename is refused while
    // anybody is quoted under it.
    const { file } = await applicationOn(AUSTIN_HOUSE);
    await prisma.loanFile.update({
      where: { id: file.id },
      data: { productCode: PRODUCT_CODE, termMonths: 360, noteRate: 6.25 },
    });

    await expect(
      prisma.loanProduct.update({
        where: { code: PRODUCT_CODE },
        data: { code: "CONF-30-RENAMED" },
      }),
    ).rejects.toThrow(/loan_files_product_code_fkey/);
  });

  it("will not restate what a quoted product says about itself", async () => {
    // The loss neither key closes. Flipping an indicator on a row somebody was
    // quoted under retroactively changes what every casefile sent under it told
    // Desktop Underwriter, with nothing appended and nothing to diff against —
    // which is why `connector_snapshots` and `decisions` are append-only, and
    // why the migration's own prose, a product on different terms is another
    // row, is a trigger rather than advice.
    const { file } = await applicationOn(AUSTIN_HOUSE);
    await prisma.loanFile.update({
      where: { id: file.id },
      data: { productCode: PRODUCT_CODE, termMonths: 360, noteRate: 6.25 },
    });

    for (const data of [
      { prepaymentPenalty: true },
      { balloon: true },
      { amortization: "AdjustableRate" as const },
      { mortgageType: "FHA" as const },
    ]) {
      await expect(
        prisma.loanProduct.update({ where: { code: PRODUCT_CODE }, data }),
      ).rejects.toThrow(/loan_products_is_not_restated/);
    }

    // And the row is what it always was, which is the point of refusing.
    const product = await prisma.loanProduct.findUniqueOrThrow({ where: { code: PRODUCT_CODE } });
    expect(product).toMatchObject({
      mortgageType: "Conventional",
      amortization: "Fixed",
      balloon: false,
      prepaymentPenalty: false,
    });
  });
});
