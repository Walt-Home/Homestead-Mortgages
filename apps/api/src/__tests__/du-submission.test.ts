/**
 * Rows to a DU submission: the first thing in this repository that produces
 * one.
 *
 * These live here rather than beside `packages/du` because this is where a real
 * Postgres is wired, and the reason is written in `support/exclusive.ts`: two
 * suites truncating one database is 235 failures out of 511, every one of them
 * reading like a real bug. A second suite needing a second database, to test
 * code whose whole subject is what the database holds, is a worse trade than a
 * test file that sits one package over from the code it exercises.
 *
 * The round trip in `packages/du` proves the emitter against Fannie Mae's own
 * eighteen files. It cannot prove which row becomes which element, because no
 * shipped sample is a database state. That is what everything below is: the
 * four shapes, the four gaps the model had before the emitter was specified,
 * and the two claims about labels that only a re-pull can make.
 *
 * **Those tests serialize through `@hm/du/test-support` and not through
 * `emitSubmission`, because no application this model can assemble is emittable
 * yet.** Eight data points the specification requires on the loan being applied
 * for and on the subject property have no column anywhere, so the gate refuses
 * every casefile and would leave "which row becomes which element" untestable
 * until those columns exist. The last test in this file names all eight and
 * asserts them exactly, so the list shortens when a column lands; the door is
 * out of the package's `exports` map so nothing shipped can take it.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Prisma, prisma, type ApplicationPartyRole } from "@hm/db";
import {
  assembleSubmission,
  DuPreflightRefusal,
  emitSubmission,
  preflightSubmission,
  writeAsset,
  writeExpense,
  writeLiability,
  type AssembleOptions,
} from "@hm/du";
import { emitDocument } from "@hm/du/test-support";
import { ensureApplicationParty } from "../services/applications.js";
import { recordBorrowerFacts } from "../services/party.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";

/** The moment the document was made, fixed so two emissions can be compared. */
const MADE_AT = new Date("2026-02-01T09:00:00.000Z");

/**
 * What every test emits with.
 *
 * A taxpayer identifier is required on every borrower party and the preflight
 * refuses a casefile without one, so a fixture that emits has to reach a vault
 * that is not here. Nine zeros rather than something that looks like a number
 * somebody has: this file is committed, and a plausible social security number
 * in a committed fixture is the thing the vault exists to prevent.
 */
const emitting = (extra: Partial<AssembleOptions> = {}): AssembleOptions => ({
  createdAt: MADE_AT,
  taxpayerIdentifiers: async () => "000000000",
  ...extra,
});

interface Application {
  readonly id: string;
  readonly loanFileId: string;
  /** `application_parties` rows, which are what an owner arc points at. */
  readonly borrowers: string[];
  /** The durable parties behind them, which is what income and facts are keyed on. */
  readonly parties: string[];
}

function borrowerInput(first: string, last: string) {
  return {
    firstName: first,
    lastName: last,
    email: `${first.toLowerCase()}@example.test`,
    phone: "5155555555",
    dateOfBirth: "1992-03-07",
    currentAddress: {
      line1: "1234 Ocean Pines",
      city: "Rehobeth",
      state: "MD",
      postalCode: "21857",
    },
    maritalStatus: "married",
    citizenship: "us_citizen",
    preferredLanguage: "en",
    isMilitary: false,
  };
}

/**
 * What every borrower has to have answered before a casefile is emittable.
 *
 * Section 5, and where they live now. The preflight refuses a borrower with
 * neither, so a fixture that leaves them out is testing the gate rather than
 * the thing it was written for — and the two tests that are ABOUT these two
 * containers say so by asking for them not to be written.
 */
type BorrowerAnswers = "standard" | "declarationOnly" | "none";

async function aDeclaration(applicationPartyId: string, partyId: string) {
  const principal = await prisma.principal.findFirstOrThrow({
    where: { partyId },
    select: { id: true },
  });
  return prisma.duDeclaration.create({
    data: {
      applicationPartyId,
      assertedByPrincipalId: principal.id,
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
  });
}

async function anApplication(
  roles: readonly ApplicationPartyRole[] = ["PRIMARY_BORROWER"],
  answers: BorrowerAnswers = "standard",
): Promise<Application> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  await prisma.loanFile.update({
    where: { id: file.id },
    data: {
      purpose: "CASH_OUT_REFINANCE",
      amortization: "fixed",
      propertyLine1: "1234 Ocean Pines",
      propertyLine2: "823",
      propertyCity: "Rehobeth",
      propertyState: "MD",
      propertyPostalCode: "21857",
    },
  });
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await prisma.loanScenario.create({
    data: {
      applicationId: app.id,
      seq: 1,
      objective: "CASH_OUT_REFINANCE",
      occupancy: "SECOND_HOME",
      loanAmountCents: 30_000_000n,
      termMonths: 360,
      noteRateBps: 625,
      valueEstimateCents: 42_000_000n,
    },
  });

  const borrowers: string[] = [];
  const parties: string[] = [];
  const names = [
    ["Andy", "America"],
    ["Amy", "America"],
    ["Alex", "America"],
    ["Ada", "America"],
  ];
  for (const [position, role] of roles.entries()) {
    const [first, last] = names[position]!;
    // A party each, and the facts written onto it through the same function
    // screen 2 uses. Saving twice against one file would give every borrower
    // the file owner's party, which is one person wearing four ordinals.
    const party = await createParty();
    await prisma.$transaction((tx) =>
      recordBorrowerFacts(tx, {
        loanFileId: file.id,
        existingPartyId: party.id,
        input: borrowerInput(first!, last!),
      }),
    );
    const edge = await ensureApplicationParty(prisma, app.id, party.id, role);
    borrowers.push(edge.id);
    parties.push(party.id);
    if (answers !== "none") await aDeclaration(edge.id, party.id);
    if (answers === "standard") {
      // A Current residence stores no address of its own: it reads the pinned
      // `current_address` fact, and a CHECK says so.
      await prisma.duResidence.create({
        data: {
          applicationPartyId: edge.id,
          residencyType: "Current",
          basis: "Rent",
          durationMonths: 30,
          monthlyRentCents: 185_000n,
        },
      });
    }
  }
  await anOriginationCompany(app.id);
  return { id: app.id, loanFileId: file.id, borrowers, parties };
}

/** The non-borrower party without which `DEAL/PARTIES` has no minimum satisfied. */
async function anOriginationCompany(applicationId: string) {
  return prisma.duDealParty.create({
    data: {
      applicationId,
      role: "LoanOriginationCompany",
      legalEntityName: "ABC Mortgage",
      licenseIdentifier: "123456789111",
      licenseAuthorityType: "Private",
    },
  });
}

function assetFor(
  applicationId: string,
  overrides: Partial<Prisma.DuAssetUncheckedCreateInput> = {},
): Prisma.DuAssetUncheckedCreateInput {
  return {
    applicationId,
    kind: "DEPOSIT_ACCOUNT",
    assetType: "CheckingAccount",
    cashOrMarketValueCents: 1_250_000n,
    holderName: "First Federal",
    accountIdentifier: "4455",
    identityKey: `manual:${randomUUID()}`,
    ...overrides,
  };
}

function liabilityFor(
  applicationId: string,
  overrides: Partial<Prisma.DuLiabilityUncheckedCreateInput> = {},
): Prisma.DuLiabilityUncheckedCreateInput {
  return {
    applicationId,
    liabilityType: "MortgageLoan",
    holderName: "Callable Mortgage",
    unpaidBalanceCents: 21_002_700n,
    monthlyPaymentCents: 147_900n,
    payoffStatus: false,
    identityKey: `manual:${randomUUID()}`,
    ...overrides,
  };
}

/** The subject property, as an REO asset with no address of its own. */
async function aSubjectReo(
  app: Application,
  owners: readonly string[],
  overrides: Partial<Prisma.DuOwnedPropertyUncheckedCreateInput> = {},
): Promise<{ assetId: string; ownedPropertyId: string }> {
  const assetId = await prisma.$transaction(async (tx) =>
    writeAsset(tx, {
      asset: assetFor(app.id, {
        kind: "OWNED_PROPERTY",
        assetType: null,
        cashOrMarketValueCents: null,
        holderName: null,
        accountIdentifier: null,
      }),
      owners: owners.map((applicationPartyId) => ({ applicationPartyId })) as [
        { applicationPartyId: string },
        ...{ applicationPartyId: string }[],
      ],
    }),
  );
  const property = await prisma.duOwnedProperty.create({
    data: {
      assetId,
      applicationId: app.id,
      dispositionStatus: "Retain",
      isSubject: true,
      currentUsage: "SecondHome",
      intendedUsage: "SecondHome",
      estimatedValueCents: 42_000_000n,
      maintenanceExpenseCents: 70_000n,
      ...overrides,
    },
    select: { id: true },
  });
  return { assetId, ownedPropertyId: property.id };
}

/**
 * The entry point of the vendored chain: the wrapper, not `MISMO_3.4.0_B324`.
 *
 * The wrapper is what redefines fourteen MISMO extension types into their DU
 * forms, and validating against MISMO alone accepts a document DU would reject.
 */
const DU_WRAPPER_XSD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/du-schema/xsd/DU_Wrapper_3.4.0_B324.xsd",
);

/**
 * What libxml2 says about a document we assembled.
 *
 * It THROWS when `xmllint` is missing rather than reporting success, the same
 * way the vendored package's own validator does: a green tick for a check that
 * did not run is worse than no check at all. And a green tick here is a lint
 * rather than a gate — the XSD enforces element order and enumerated values and
 * essentially nothing about the graph.
 */
function xmllintErrors(xml: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "hm-du-"));
  const file = join(directory, "emitted.xml");
  try {
    writeFileSync(file, xml);
    const run = spawnSync("xmllint", ["--noout", "--schema", DU_WRAPPER_XSD, file], {
      encoding: "utf8",
    });
    if (run.error) {
      throw new Error(
        `xmllint could not be run (${run.error.message}). Install libxml2 rather than ` +
          "letting this check pass by not happening.",
      );
    }
    if (run.status === 0) return [];
    return (run.stderr ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(file, "emitted.xml"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every element of `name`, as text, in document order. */
function valuesOf(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => m[1]!);
}

describe("the four shapes, assembled and emitted", () => {
  it("emits one asset with two owners, one property with two liens, and the arcs for both", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const both = app.borrowers.map((applicationPartyId) => ({ applicationPartyId })) as [
      { applicationPartyId: string },
      ...{ applicationPartyId: string }[],
    ];

    await prisma.$transaction(async (tx) => {
      await writeAsset(tx, {
        asset: assetFor(app.id),
        owners: [{ applicationPartyId: app.borrowers[0]! }],
      });
    });
    const reo = await aSubjectReo(app, app.borrowers);

    await prisma.$transaction(async (tx) => {
      await writeLiability(tx, {
        liability: liabilityFor(app.id, {
          securedByOwnedPropertyId: reo.ownedPropertyId,
          paymentIncludesTaxesInsurance: false,
        }),
        obligors: both,
      });
      await writeLiability(tx, {
        liability: liabilityFor(app.id, {
          liabilityType: "HELOC",
          holderName: "Shoreline CU",
          unpaidBalanceCents: 3_500_000n,
          monthlyPaymentCents: 28_000n,
          helocMaximumBalanceCents: 5_000_000n,
          securedByOwnedPropertyId: reo.ownedPropertyId,
        }),
        obligors: both,
      });
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    // SHAPE 4: the REO asset carries no ASSET_DETAIL and no AssetType.
    expect(valuesOf(xml, "AssetType")).toEqual(["CheckingAccount"]);

    // The lien total is the SUM. 210,027.00 plus 35,000.00, derived in the
    // database by the trigger and never added up here.
    expect(valuesOf(xml, "OwnedPropertyLienUPBAmount")).toEqual(["245027.00"]);

    // SHAPE 1, SHAPE 2 and SHAPE 3, in the fold's fixed source order.
    expect([...xml.matchAll(/<RELATIONSHIP ([^>]*?)\s*\/>/g)].map((m) => m[1]!)).toEqual([
      'SequenceNumber="1" xlink:from="ASSET_1" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_ROLE"',
      'SequenceNumber="2" xlink:from="ASSET_2" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_ROLE"',
      'SequenceNumber="3" xlink:from="ASSET_2" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_ROLE"',
      'SequenceNumber="4" xlink:from="LIABILITY_1" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/LIABILITY_IsAssociatedWith_ROLE"',
      'SequenceNumber="5" xlink:from="LIABILITY_1" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/LIABILITY_IsAssociatedWith_ROLE"',
      'SequenceNumber="6" xlink:from="LIABILITY_2" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/LIABILITY_IsAssociatedWith_ROLE"',
      'SequenceNumber="7" xlink:from="LIABILITY_2" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/LIABILITY_IsAssociatedWith_ROLE"',
      'SequenceNumber="8" xlink:from="ASSET_2" xlink:to="LIABILITY_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_LIABILITY"',
      'SequenceNumber="9" xlink:from="ASSET_2" xlink:to="LIABILITY_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_LIABILITY"',
    ]);

    // The label is on the ROLE, never on the PARTY and never on the BORROWER.
    expect(xml).toContain('<ROLE SequenceNumber="1" xlink:label="BORROWER_1">');
    expect(xml).not.toContain("<PARTY xlink:label");
    expect(xml).not.toContain("<BORROWER xlink:label");

    // And the whole document is at least what the vendored chain accepts.
    expect(xmllintErrors(xml)).toEqual([]);
  });

  it("emits an expense and its payer arc", async () => {
    const app = await anApplication();
    await prisma.$transaction(async (tx) => {
      await writeExpense(tx, {
        expense: {
          applicationId: app.id,
          expenseType: "ChildSupport",
          monthlyPaymentCents: 45_000n,
          remainingTermMonths: 24,
        },
        payers: [{ applicationPartyId: app.borrowers[0]! }],
      });
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(xml).toContain('<EXPENSE SequenceNumber="1" xlink:label="EXPENSE_1">');
    expect(valuesOf(xml, "ExpenseMonthlyPaymentAmount")).toEqual(["450.00"]);
    expect(xml).toContain(
      'xlink:from="EXPENSE_1" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/EXPENSE_IsAssociatedWith_ROLE"',
    );
  });
});

describe("the four gaps the model had, now emitted", () => {
  it("renders the subject property's address into the REO twin, and an override instead of it", async () => {
    const app = await anApplication();
    const reo = await aSubjectReo(app, [app.borrowers[0]!]);
    const borrowed = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    // Two renderings, one function: the REO twin with no address of its own
    // reads back the subject property.
    expect(valuesOf(borrowed, "AddressLineText")).toContain("1234 Ocean Pines");
    expect(valuesOf(borrowed, "AddressUnitIdentifier")).toEqual(["823", "823"]);

    // DI-C04's shape: a borrower's REO record and the county's subject record
    // are two different strings about one house. Filling one of the four fills
    // all four.
    await prisma.duOwnedProperty.update({
      where: { id: reo.ownedPropertyId },
      data: {
        addressLineText: "1234 Main St",
        cityName: "Baltimore",
        stateCode: "MD",
        postalCode: "206001234",
      },
    });
    const diverged = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(diverged, "AddressLineText")).toEqual(
      expect.arrayContaining(["1234 Main St", "1234 Ocean Pines"]),
    );
  });

  it("puts MortgageType on the liability and nowhere else", async () => {
    const app = await anApplication();
    await prisma.$transaction(async (tx) => {
      await writeLiability(tx, {
        liability: liabilityFor(app.id, { mortgageType: "FHA" }),
        obligors: [{ applicationPartyId: app.borrowers[0]! }],
      });
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    // One occurrence, inside LIABILITY_DETAIL. The TERMS_OF_LOAN MortgageType
    // that DI-FHA02 also carries is a different statement about a different
    // loan, and nothing in this model holds it.
    expect(valuesOf(xml, "MortgageType")).toEqual(["FHA"]);
    expect(xml).toMatch(
      /<LIABILITY_DETAIL>[\s\S]*<MortgageType>FHA<\/MortgageType>[\s\S]*<\/LIABILITY_DETAIL>/,
    );
    expect(xml).not.toMatch(/<TERMS_OF_LOAN>[\s\S]*?<MortgageType>/);
  });

  it("renders a negative net rental with its sign", async () => {
    const app = await anApplication();
    await aSubjectReo(app, [app.borrowers[0]!], { rentalIncomeNetCents: -67_800n });
    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "OwnedPropertyRentalIncomeNetAmount")).toEqual(["-678.00"]);
  });

  it("renders CountryCode on an REO address that carries one", async () => {
    const app = await anApplication();
    const reo = await aSubjectReo(app, [app.borrowers[0]!]);
    await prisma.duOwnedProperty.update({
      where: { id: reo.ownedPropertyId },
      data: {
        addressLineText: "4420 Douglas Ave. E.",
        cityName: "Higley",
        stateCode: "AZ",
        postalCode: "85236",
        countryCode: "US",
      },
    });
    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "CountryCode")).toEqual(["US"]);
    // After CityName and before PostalCode, which is the ADDRESS sequence and
    // not alphabetical luck.
    expect(xml).toMatch(
      /<CityName>Higley<\/CityName>\s*<CountryCode>US<\/CountryCode>\s*<PostalCode>85236<\/PostalCode>/,
    );
  });
});

describe("amounts, and what two emissions of unchanged data are", () => {
  it("renders every amount from bigint cents with exactly two decimals", async () => {
    const app = await anApplication();
    await prisma.$transaction(async (tx) => {
      await writeAsset(tx, {
        asset: assetFor(app.id, { cashOrMarketValueCents: 5n }),
        owners: [{ applicationPartyId: app.borrowers[0]! }],
      });
      await writeLiability(tx, {
        liability: liabilityFor(app.id, {
          unpaidBalanceCents: 100_000n,
          monthlyPaymentCents: 0n,
        }),
        obligors: [{ applicationPartyId: app.borrowers[0]! }],
      });
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "AssetCashOrMarketValueAmount")).toEqual(["0.05"]);
    expect(valuesOf(xml, "LiabilityUnpaidBalanceAmount")).toEqual(["1000.00"]);
    expect(valuesOf(xml, "LiabilityMonthlyPaymentAmount")).toEqual(["0.00"]);
    expect(valuesOf(xml, "BaseLoanAmount")).toEqual(["300000.00"]);
    expect(valuesOf(xml, "NoteRatePercent")).toEqual(["6.250"]);
  });

  it("is byte-identical when no row was created, retired or revived between them", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await aSubjectReo(app, app.borrowers);
    await prisma.$transaction(async (tx) => {
      await writeAsset(tx, {
        asset: assetFor(app.id),
        owners: [{ applicationPartyId: app.borrowers[1]! }],
      });
    });

    const first = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    const second = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(second).toBe(first);

    // And the moment really is the argument rather than a clock, which the
    // comparison above cannot show on its own: two emissions inside one second
    // are identical either way.
    const strip = (xml: string) => xml.replace(/<CreatedDatetime>[^<]*</, "<CreatedDatetime><");
    const later = emitDocument(
      await assembleSubmission(
        prisma,
        app.id,
        emitting({ createdAt: new Date("2026-03-04T17:45:31.000Z") }),
      ),
    );
    expect(later).toContain("<CreatedDatetime>2026-03-04T17:45:31Z</CreatedDatetime>");
    expect(strip(later)).toBe(strip(first));
  });
});

describe("labels across a re-pull", () => {
  /** Three accounts at one bank, written the way an ingest writes them. */
  async function threeAccounts(app: Application, snapshotId: string): Promise<void> {
    for (const [position, account] of ["1111", "2222", "3333"].entries()) {
      await prisma.$transaction(async (tx) => {
        await writeAsset(tx, {
          matchOnIdentity: true,
          asset: assetFor(app.id, {
            accountIdentifier: account,
            cashOrMarketValueCents: BigInt((position + 1) * 100_000),
            identityKey: `p:${app.parties[0]!}:acct:firstfederal:checking:${account}:`,
            sourceSnapshotId: snapshotId,
            lastSeenSnapshotId: snapshotId,
          }),
          owners: [{ applicationPartyId: app.borrowers[0]! }],
        });
      });
    }
  }

  async function aSnapshot(loanFileId: string, partyId: string): Promise<string> {
    const snapshot = await prisma.connectorSnapshot.create({
      data: {
        loanFileId,
        partyId,
        kind: "bank",
        provider: "fixture",
        externalId: randomUUID(),
        payload: {},
        retrievedAt: new Date(),
      },
      select: { id: true },
    });
    return snapshot.id;
  }

  it("leaves every label unchanged when a re-pull reports the same accounts", async () => {
    const app = await anApplication();
    await threeAccounts(app, await aSnapshot(app.loanFileId, app.parties[0]!));
    const before = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    await threeAccounts(app, await aSnapshot(app.loanFileId, app.parties[0]!));
    const after = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(after).toBe(before);
    expect(before).toContain('xlink:label="ASSET_3"');
    expect(before).not.toContain('xlink:label="ASSET_4"');
  });

  it("leaves the survivors' labels and owner arcs alone when a re-pull drops one", async () => {
    const app = await anApplication();
    await threeAccounts(app, await aSnapshot(app.loanFileId, app.parties[0]!));

    const dropped = await prisma.duAsset.findFirstOrThrow({
      where: { applicationId: app.id, accountIdentifier: "3333" },
      select: { id: true },
    });
    await prisma.duAsset.update({ where: { id: dropped.id }, data: { retiredAt: new Date() } });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "AssetAccountIdentifier")).toEqual(["1111", "2222"]);
    expect(xml).toContain('xlink:label="ASSET_1"');
    expect(xml).toContain('xlink:label="ASSET_2"');
    expect(xml).not.toContain('xlink:label="ASSET_3"');
    expect(
      [...xml.matchAll(/xlink:from="(ASSET_\d+)" xlink:to="(BORROWER_\d+)"/g)].map(
        (m) => `${m[1]}->${m[2]}`,
      ),
    ).toEqual(["ASSET_1->BORROWER_1", "ASSET_2->BORROWER_1"]);
  });
});

describe("the taxpayer identifier boundary", () => {
  it("writes the nine digits the resolver hands it, and nothing about them otherwise", async () => {
    const app = await anApplication();
    const xml = emitDocument(
      await assembleSubmission(
        prisma,
        app.id,
        emitting({ taxpayerIdentifiers: async () => "123456789" }),
      ),
    );
    expect(xml).toContain("<TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType>");
    expect(xml).toContain("<TaxpayerIdentifierValue>123456789</TaxpayerIdentifierValue>");
  });

  it("omits the element entirely when the number cannot be reached, and refuses to send it", async () => {
    const app = await anApplication();
    // No resolver at all, and a resolver that has nothing, are the same answer:
    // DU wants nine digits and we have none. `ssn_last4` is display only, and
    // the alternative to omission is five fabricated digits on a federal
    // submission that nothing downstream could tell from a real number.
    //
    // So the assembler omits it and the preflight is what stops the casefile:
    // omitting a required element is the honest shape of "we cannot reach the
    // vault", and emitting one anyway is not.
    for (const options of [
      { createdAt: MADE_AT },
      { createdAt: MADE_AT, taxpayerIdentifiers: async () => null },
    ]) {
      const xml = emitDocument(await assembleSubmission(prisma, app.id, options));
      expect(xml).not.toContain("TAXPAYER_IDENTIFIER");
      expect(xml).not.toContain("TaxpayerIdentifierValue");

      const refusal = await emitSubmission(prisma, app.id, options).catch((error) => error);
      expect(refusal).toBeInstanceOf(DuPreflightRefusal);
      expect(refusal.findings.map((finding: { where: string }) => finding.where)).toContain(
        "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY -> " +
          "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER",
      );
      // The refusal is a string somebody pastes into a ticket, and it carries
      // no part of what it is about.
      expect(refusal.message).not.toContain("000000000");
    }
  });

  it("refuses a value that is not nine digits, without repeating it", async () => {
    const app = await anApplication();
    await expect(
      emitSubmission(prisma, app.id, emitting({ taxpayerIdentifiers: async () => "123-45-6789" })),
    ).rejects.toThrow(/nine digits/);
  });
});

describe("the borrower's own block", () => {
  it("emits the declaration, the residence and the income item with its employer arc", async () => {
    // Its own answers rather than the fixture's, because this is the test that
    // is about them.
    const app = await anApplication(["PRIMARY_BORROWER"], "none");
    const principal = await prisma.principal.findFirstOrThrow({
      where: { partyId: app.parties[0]! },
      select: { id: true },
    });

    await prisma.duDeclaration.create({
      data: {
        applicationPartyId: app.borrowers[0]!,
        assertedByPrincipalId: principal.id,
        intentToOccupy: "No",
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
    });
    // A Current residence stores no address of its own — it reads the pinned
    // `current_address` fact, and a CHECK says so. A Prior one has no predicate
    // to read from and carries its own.
    await prisma.duResidence.create({
      data: {
        applicationPartyId: app.borrowers[0]!,
        residencyType: "Current",
        basis: "Rent",
        durationMonths: 30,
        monthlyRentCents: 185_000n,
      },
    });
    await prisma.duResidence.create({
      data: {
        applicationPartyId: app.borrowers[0]!,
        residencyType: "Prior",
        basis: "Own",
        durationMonths: 48,
        addressLineText: "567 Elm St",
        cityName: "Baltimore",
        stateCode: "MD",
        postalCode: "20600",
      },
    });

    const employer = await prisma.employer.create({
      data: {
        partyId: app.parties[0]!,
        identityKey: "name:childrenshospital",
        derivedFrom: "name",
        nameKey: "name:childrenshospital",
        displayName: "Childrens Hospital",
      },
      select: { id: true },
    });
    await prisma.employment.create({
      data: {
        loanFileId: app.loanFileId,
        partyId: app.parties[0]!,
        employerId: employer.id,
        employerName: "Childrens Hospital",
        position: "Nurse",
        startDate: new Date("2019-04-01T00:00:00.000Z"),
        status: "active",
        verificationMethod: "payroll",
      },
    });
    await prisma.incomeSource.create({
      data: {
        loanFileId: app.loanFileId,
        partyId: app.parties[0]!,
        employerId: employer.id,
        employmentIncome: true,
        identityKey: "base_wage:1",
        type: "base_wage",
        monthlyAmount: new Prisma.Decimal("6250.00"),
        historyMonths: 24,
      },
    });

    // Assembled rather than emitted, because a borrower with a current
    // employer is not an emittable casefile yet and the assertion below is what
    // says so: three data points the specification requires on an EMPLOYMENT
    // have no column anywhere, so the preflight refuses every file with a job
    // on it. What this test can still prove is that every element the model
    // DOES hold comes out where it belongs.
    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(valuesOf(xml, "IntentToOccupyType")).toEqual(["No"]);
    expect(valuesOf(xml, "CitizenshipResidencyType")).toEqual(["USCitizen"]);
    expect(valuesOf(xml, "MaritalStatusType")).toEqual(["Married"]);
    expect(valuesOf(xml, "BorrowerBirthDate")).toEqual(["1992-03-07"]);
    expect(valuesOf(xml, "BorrowerResidencyBasisType")).toEqual(["Rent", "Own"]);
    expect(valuesOf(xml, "BorrowerResidencyType")).toEqual(["Current", "Prior"]);
    // The Prior residence is the only one with an address of its own.
    expect(valuesOf(xml, "AddressLineText")).toContain("567 Elm St");
    expect(valuesOf(xml, "MonthlyRentAmount")).toEqual(["1850.00"]);
    expect(valuesOf(xml, "EmploymentStatusType")).toEqual(["Current"]);
    expect(valuesOf(xml, "EmploymentStartDate")).toEqual(["2019-04-01"]);
    expect(valuesOf(xml, "IncomeType")).toEqual(["Base"]);
    expect(valuesOf(xml, "CurrentIncomeMonthlyTotalAmount")).toEqual(["6250.00"]);
    expect(xml).toContain(
      'xlink:from="CURRENT_INCOME_ITEM_1" xlink:to="EMPLOYER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER"',
    );

    // And the gap this test is about, named: `employments` carries a name, a
    // position, a start date and a status, and Desktop Underwriter wants three
    // more things about a current job that no column holds. Read off the
    // EMPLOYMENT container alone, because the eight columns the whole model is
    // missing are the last test in this file's subject and would drown these.
    const refusal = await emitSubmission(prisma, app.id, emitting()).catch((error) => error);
    expect(refusal).toBeInstanceOf(DuPreflightRefusal);
    expect(
      refusal.findings
        .filter((finding: { where: string }) => finding.where.includes("/EMPLOYMENT#"))
        .map((finding: { where: string }) => finding.where.split("#")[1])
        .sort(),
    ).toEqual([
      "EmploymentBorrowerSelfEmployedIndicator",
      "EmploymentClassificationType",
      "SpecialBorrowerEmployerRelationshipIndicator",
    ]);
  });

  it("writes Current before Prior even when both the row age and the id say otherwise", async () => {
    // The residence history is the one container kind NOT emitted in
    // `(created_at, id)` order, and this is what that costs and what makes it
    // safe. Both rows are written in one transaction — `recordDeclaration`
    // replaces the whole set at once — so their `created_at` would be the
    // transaction's own clock either way; here the Prior row is given an older
    // one AND a lower id, so both halves of the usual tuple point the wrong
    // way. `residency_type` still decides, and the unique constraint below is
    // why it can decide alone.
    const app = await anApplication(["PRIMARY_BORROWER"], "declarationOnly");
    const edge = app.borrowers[0]!;
    await prisma.$transaction(async (tx) => {
      await tx.duResidence.create({
        data: {
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          applicationPartyId: edge,
          residencyType: "Prior",
          basis: "Own",
          durationMonths: 48,
          addressLineText: "567 Elm St",
          cityName: "Baltimore",
          stateCode: "MD",
          postalCode: "20600",
        },
      });
      await tx.duResidence.create({
        data: {
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          applicationPartyId: edge,
          residencyType: "Current",
          basis: "Rent",
          durationMonths: 30,
          monthlyRentCents: 185_000n,
        },
      });
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "BorrowerResidencyType")).toEqual(["Current", "Prior"]);
    expect(valuesOf(xml, "BorrowerResidencyDurationMonthsCount")).toEqual(["30", "48"]);

    await expect(
      prisma.duResidence.create({
        data: {
          applicationPartyId: edge,
          residencyType: "Prior",
          basis: "Rent",
          durationMonths: 12,
          addressLineText: "9 Oak Ct",
          cityName: "Baltimore",
          stateCode: "MD",
          postalCode: "20600",
        },
      }),
    ).rejects.toThrow(/du_residences_application_party_id_residency_type_key/);
  });

  it("emits the joint credit arc from the additional borrower to the group's primary", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await prisma.duJointCreditReportLink.create({
      data: {
        applicationId: app.id,
        fromApplicationPartyId: app.borrowers[1]!,
        toApplicationPartyId: app.borrowers[0]!,
      },
    });
    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(xml).toContain(
      'xlink:from="BORROWER_2" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/ROLE_SharesJointCreditReportWith_ROLE"',
    );
  });

  it("emits BorrowerCount from the edges, and no LOAN_IDENTIFIER", async () => {
    const app = await anApplication([
      "PRIMARY_BORROWER",
      "CO_BORROWER",
      "NON_OCCUPANT_CO_BORROWER",
    ]);
    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "BorrowerCount")).toEqual(["3"]);
    // `LenderLoan` is conditional on one existing, so a conventional submission
    // that carries none is legal — and minting one decides a contractual
    // question by choosing a format.
    expect(xml).not.toContain("LOAN_IDENTIFIER");
    // Nor a submitting party, which is the other half of the same question.
    expect(xml).not.toContain("SubmittingParty");
  });

  it("emits the non-borrowing parties a submission cannot do without", async () => {
    const app = await anApplication();
    await prisma.duVesting.create({
      data: {
        applicationId: app.id,
        status: "Proposed",
        fullName: "Andy America and Amy America",
        vestingType: "JointTenantsWithRightOfSurvivorship",
      },
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));
    expect(valuesOf(xml, "PartyRoleType")).toEqual([
      "Borrower",
      "PropertyOwner",
      "LoanOriginationCompany",
    ]);
    expect(valuesOf(xml, "RelationshipVestingType")).toEqual([
      "JointTenantsWithRightOfSurvivorship",
    ]);
    expect(valuesOf(xml, "LicenseIdentifier")).toEqual(["123456789111"]);
    expect(xml).toContain('xlink:label="PROPERTY_OWNER_1"');
    expect(xml).toContain('xlink:label="LOAN_ORIGINATION_COMPANY_1"');
  });
});

describe("the gate, over rows rather than over bytes", () => {
  it("names the eight columns between this model and a casefile it could send", async () => {
    // Every shipped sample passes the preflight in `packages/du`, which proves
    // the checks are not wrong about Fannie Mae's files. This is what they say
    // about ours, and it is the whole answer rather than a sample of it: an
    // application answered as completely as this model allows — a borrower, a
    // co-borrower, a declaration, a current residence, a taxpayer identifier
    // from the vault, an owned property and the company originating the
    // loan — still carries none of these eight, because no column holds them.
    //
    // Asserted exactly, so the list shortens in the commit that adds a column
    // and cannot quietly grow. `docs/du-readiness.md` carries the same eight.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await aSubjectReo(app, app.borrowers);
    const report = await preflightSubmission(prisma, app.id, emitting());
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.where.split("#")[1]).sort()).toEqual([
      "BalloonIndicator",
      "ConstructionLoanIndicator",
      "FinancedUnitCount",
      "InterestOnlyIndicator",
      "MortgageType",
      "NegativeAmortizationIndicator",
      "PrepaymentPenaltyIndicator",
      "PropertyEstateType",
    ]);
    expect(new Set(report.findings.map((finding) => finding.check))).toEqual(
      new Set(["required-data-point-absent"]),
    );
  });

  it("refuses a live row the matcher could not tell from another", async () => {
    // The one check whose subject is not in the document. An ambiguous pair is
    // written unmatchable rather than guessed at, and emitting both would state
    // two accounts where there may be one — so the casefile stops here, with
    // the row named, for somebody to resolve.
    const app = await anApplication();
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await writeAsset(tx, {
        asset: assetFor(app.id, { id, identityKey: `unmatched:${id}` }),
        owners: [{ applicationPartyId: app.borrowers[0]! }],
      });
    });

    const report = await preflightSubmission(prisma, app.id, emitting());
    expect(report.findings).toContainEqual({
      check: "identity-unmatched",
      where: `du_assets ${id}`,
      message: expect.stringContaining("Emitting both would state two accounts"),
    });
    await expect(emitSubmission(prisma, app.id, emitting())).rejects.toBeInstanceOf(
      DuPreflightRefusal,
    );
  });
});

/**
 * One pull, appended.
 *
 * `connector_snapshots` is append-only and nothing here pretends otherwise: a
 * re-pull is another row, and every row written by these tests stays in the
 * table for the selection to be made over.
 */
function aPull(
  app: Application,
  partyIndex: number,
  kind: "bank" | "payroll" | "irs",
  retrievedAt: string,
  overrides: { provider?: string; externalId?: string; payload?: unknown } = {},
) {
  return prisma.connectorSnapshot.create({
    data: {
      loanFileId: app.loanFileId,
      partyId: app.parties[partyIndex]!,
      kind,
      provider: overrides.provider ?? `fixture-${kind}`,
      externalId: overrides.externalId ?? `${kind}-${retrievedAt}`,
      payload: (overrides.payload ?? {}) as Prisma.InputJsonValue,
      retrievedAt: new Date(retrievedAt),
    },
    select: { id: true },
  });
}

describe("the verification a submission may rely on", () => {
  it("emits one verification and one arc for a report that stands", async () => {
    const app = await anApplication();
    await anOriginationCompany(app.id);
    await aPull(app, 0, "bank", "2026-01-04T00:00:00.000Z", { externalId: "assets-0f3a" });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(valuesOf(xml, "DU:VerificationReportType")).toEqual(["VOD"]);
    expect(valuesOf(xml, "DU:VerificationReportIdentifier")).toEqual(["assets-0f3a"]);
    // Required the moment an identifier exists, which is why a vendor with no
    // name to write emits no verification at all.
    expect(valuesOf(xml, "DU:VerificationReportSupplierType")).toEqual(["Fixture"]);
    expect(xml).toContain(
      '<DU:UNDERWRITING_VERIFICATION SequenceNumber="1" xlink:label="VERIFICATION_1">',
    );
    expect(xml).toContain(
      'xlink:from="VERIFICATION_1" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
    );
    expect(xmllintErrors(xml)).toEqual([]);
  });

  it("emits one verification across six re-pulls, and it is the latest", async () => {
    const app = await anApplication();
    for (const day of [4, 5, 6, 7, 8, 9]) {
      await aPull(app, 0, "bank", `2026-01-0${day}T00:00:00.000Z`, {
        externalId: `assets-day-${day}`,
      });
    }

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    // Six rows in the table, one element on the wire. A verification is what DU
    // may rely on now, and the five superseded reports are history.
    expect(await prisma.connectorSnapshot.count({ where: { loanFileId: app.loanFileId } })).toBe(6);
    expect(valuesOf(xml, "DU:VerificationReportIdentifier")).toEqual(["assets-day-9"]);
    expect(xml.match(/<DU:UNDERWRITING_VERIFICATION /g)).toHaveLength(1);
  });

  it("names the pull written second when the vendor stamped both with one moment", async () => {
    const app = await anApplication();
    // `retrieved_at` is the vendor's moment and two pulls can carry the same
    // one. What settles it is `write_seq`, which the database hands out in the
    // order rows arrive — so the answer is the later report rather than
    // whichever of two random uuids sorts higher.
    const first = await aPull(app, 0, "bank", "2026-01-04T00:00:00.000Z", {
      externalId: "assets-written-first",
    });
    const second = await aPull(app, 0, "bank", "2026-01-04T00:00:00.000Z", {
      externalId: "assets-written-second",
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    const rows = await prisma.connectorSnapshot.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, retrievedAt: true, writeSeq: true },
    });
    // The tie is real rather than accidental: both rows carry the same moment,
    // and the later write carries the larger sequence.
    expect(new Set(rows.map((row) => row.retrievedAt.toISOString())).size).toBe(1);
    const seqOf = new Map(rows.map((row) => [row.id, row.writeSeq]));
    expect(seqOf.get(second.id)!).toBeGreaterThan(seqOf.get(first.id)!);
    expect(valuesOf(xml, "DU:VerificationReportIdentifier")).toEqual(["assets-written-second"]);
  });

  it("emits six verifications and not thirty-six when two borrowers resubmit six times", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    for (const round of [1, 2, 3, 4, 5, 6]) {
      for (const partyIndex of [0, 1]) {
        for (const kind of ["bank", "payroll", "irs"] as const) {
          await aPull(app, partyIndex, kind, `2026-01-0${round}T00:00:00.000Z`, {
            externalId: `${kind}-b${partyIndex + 1}-r${round}`,
          });
        }
      }
    }

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(await prisma.connectorSnapshot.count({ where: { loanFileId: app.loanFileId } })).toBe(
      36,
    );
    // Report type, then the borrower's position on the file — the order the
    // labels are minted in and the order the arcs are folded in.
    expect(valuesOf(xml, "DU:VerificationReportIdentifier")).toEqual([
      "irs-b1-r6",
      "irs-b2-r6",
      "bank-b1-r6",
      "bank-b2-r6",
      "payroll-b1-r6",
      "payroll-b2-r6",
    ]);
    expect(valuesOf(xml, "DU:VerificationReportType")).toEqual([
      "TAXTRANSCRIPT",
      "TAXTRANSCRIPT",
      "VOD",
      "VOD",
      "VOE",
      "VOE",
    ]);
    expect(
      [...xml.matchAll(/<RELATIONSHIP ([^>]*?)\s*\/>/g)]
        .map((m) => m[1]!)
        .filter((attributes) => attributes.includes("VERIFICATION")),
    ).toEqual([
      'SequenceNumber="1" xlink:from="VERIFICATION_1" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
      'SequenceNumber="2" xlink:from="VERIFICATION_2" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
      'SequenceNumber="3" xlink:from="VERIFICATION_3" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
      'SequenceNumber="4" xlink:from="VERIFICATION_4" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
      'SequenceNumber="5" xlink:from="VERIFICATION_5" xlink:to="BORROWER_1" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
      'SequenceNumber="6" xlink:from="VERIFICATION_6" xlink:to="BORROWER_2" xlink:arcrole="urn:fdc:mismo.org:2009:residential/UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"',
    ]);
  });

  it("emits nothing for a vendor DU has not authorized", async () => {
    const app = await anApplication();
    // A report with nothing to say about its own standing, from a supplier the
    // emitter has no name for. The gate is the vendor and nothing else here.
    await aPull(app, 0, "payroll", "2026-01-04T00:00:00.000Z", {
      provider: "streamline-voe (production)",
      externalId: "voe-7781",
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(xml).not.toContain("UNDERWRITING_VERIFICATION");
    expect(xml).not.toContain("voe-7781");
  });

  it("emits nothing when the latest report disclaims the authorization its vendor has", async () => {
    const app = await anApplication();
    // Plaid's assets product is this same client on the same account, and it
    // says so in the report: an authorized vendor, an unauthorized report.
    // An authorized vendor's own statement about THIS report. The older pull is
    // not promoted in its place: the pair is closed by the newest row, so a
    // borrower whose latest bank report is unauthorized has no verification
    // rather than a superseded one dressed up as current.
    await aPull(app, 0, "bank", "2026-01-04T00:00:00.000Z", {
      provider: "plaid-cra (production)",
      payload: { vendorAuthorizedForDu: true },
      externalId: "cra-good",
    });
    await aPull(app, 0, "bank", "2026-01-05T00:00:00.000Z", {
      provider: "plaid-cra (production)",
      payload: { vendorAuthorizedForDu: false },
      externalId: "cra-withdrawn",
    });

    const xml = emitDocument(await assembleSubmission(prisma, app.id, emitting()));

    expect(xml).not.toContain("UNDERWRITING_VERIFICATION");
    expect(xml).not.toContain("cra-good");
  });
});
