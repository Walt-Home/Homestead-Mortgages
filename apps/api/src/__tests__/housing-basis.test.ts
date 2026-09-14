/**
 * Nobody states a borrower's housing basis but the borrower.
 *
 * `borrowers.current_housing` was `String @default("rent")` NOT NULL and the
 * four screens never asked, so every application in the product carried a
 * sentence about its borrower's own housing that the borrower had never said —
 * bound for a federal submission. Three writers manufactured it: the column
 * default, the route's required enum, and screen 2 posting the literal string.
 *
 * What is left is a nullable column that follows `du_residences`. These are the
 * tests that keep it that way: a save with no basis reads back NULL, the
 * residence row is the only thing that fills it, and the migration that made it
 * nullable maps every basis explicitly rather than lowercasing one.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { BorrowerInput } from "../services/party.js";
import { declarationRouter } from "../routes/declarations.js";
import { ensureApplicationParty } from "../services/applications.js";
import { fileRouter } from "../routes/files.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATION = join(
  repoRoot,
  "packages/db/prisma/migrations/20260912110000_housing_basis_has_one_home/migration.sql",
);

/** Screen 2's body, exactly as the rebuilt screen sends it: no housing basis. */
const screenTwo = {
  firstName: "Ren",
  lastName: "Castellanos",
  email: "ren@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:ren:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: null,
  statedMonthlyIncome: 7400,
};

const ren: BorrowerInput = { ...screenTwo, ssnVaultHandle: "vault:ren:1" };

async function applicationFile() {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, ren);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await ensureApplicationParty(prisma, app.id, borrower.partyId, "PRIMARY_BORROWER");
  return { user, file, borrower };
}

function declarationBody(residences: Record<string, unknown>[]) {
  return {
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
    residences,
  };
}

describe("a borrower who was never asked", () => {
  it("reads back NULL rather than rent", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });

    const res = await callAs(user.id, [fileRouter], "POST", `/${file.id}/borrowers`, screenTwo);
    expect(res.status).toBe(201);

    const row = await prisma.borrower.findFirstOrThrow({
      where: { loanFileId: file.id },
      select: { currentHousing: true },
    });
    expect(row.currentHousing).toBeNull();
  });

  it("asserts no housing fact about the party either", async () => {
    // A fact whose value is a guess is worse than no fact: the pin guard, the
    // projection and the party's own record would all carry it as something
    // the person said.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await callAs(user.id, [fileRouter], "POST", `/${file.id}/borrowers`, screenTwo);

    const facts = await prisma.fact.count({ where: { predicate: "current_housing" } });
    expect(facts).toBe(0);
  });
});

describe("du_residences is the only row that carries the answer", () => {
  it("fills the derived column from the residence the borrower stated", async () => {
    const { user, file, borrower } = await applicationFile();

    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declarationBody([
        { residencyType: "Current", basis: "LivingRentFree", durationMonths: 14 },
        {
          residencyType: "Prior",
          basis: "Rent",
          durationMonths: 40,
          monthlyRent: 1800,
          addressLineText: "88 Willow Lane",
          cityName: "Demo City",
          stateCode: "CA",
          postalCode: "94001",
        },
      ]),
    );

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true, monthlyRent: true },
    });
    // The CURRENT row is what the column follows. A prior tenancy's rent is
    // not what this borrower pays now.
    expect(row.currentHousing).toBe("rent_free");
    expect(row.monthlyRent).toBeNull();
  });

  it("follows the borrower when they change their answer", async () => {
    const { user, file, borrower } = await applicationFile();
    const post = (residence: Record<string, unknown>) =>
      callAs(
        user.id,
        [declarationRouter],
        "POST",
        `/${file.id}/declaration`,
        declarationBody([residence]),
      );

    await post({ residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2150 });
    const renting = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true, monthlyRent: true },
    });
    expect(renting.currentHousing).toBe("rent");
    expect(Number(renting.monthlyRent)).toBe(2150);

    await post({ residencyType: "Current", basis: "Own", durationMonths: 30 });
    const owning = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true, monthlyRent: true },
    });
    expect(owning.currentHousing).toBe("own");
    expect(owning.monthlyRent).toBeNull();
  });

  it("is not overwritten by screen 2 saving again", async () => {
    // The screen that used to manufacture the answer still posts on every
    // revisit. It sends no basis now, and an absent basis has to leave the
    // stated one standing — blanking it would put the two stores back into
    // disagreement, which is the whole reason one of them is derived.
    const { user, file, borrower } = await applicationFile();
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declarationBody([{ residencyType: "Current", basis: "Own", durationMonths: 30 }]),
    );

    await callAs(user.id, [fileRouter], "POST", `/${file.id}/borrowers`, screenTwo);

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true },
    });
    expect(row.currentHousing).toBe("own");
  });
});

/**
 * The derived copy cannot outlive the row it is derived from.
 *
 * Answering again replaces the whole residence set, so a set with no Current
 * row in it deletes the one the column was derived from and leaves the column
 * standing — a basis with no source, which is the drift `du_residences` was
 * added to end, arriving through `du_residences`. The route refuses such a body
 * and the database refuses the write underneath it, and both halves are here
 * because either alone is a promise kept by one caller.
 */
describe("a borrower has somewhere they live now", () => {
  /** The `application_parties` edge a residence hangs off. */
  async function edgeFor(loanFileId: string): Promise<string> {
    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId },
      select: { id: true },
    });
    const edge = await prisma.applicationParty.findFirstOrThrow({
      where: { applicationId: app.id },
      select: { id: true },
    });
    return edge.id;
  }

  const priorOnly = [
    {
      residencyType: "Prior",
      basis: "Rent",
      durationMonths: 40,
      monthlyRent: 1800,
      addressLineText: "88 Willow Lane",
      cityName: "Demo City",
      stateCode: "CA",
      postalCode: "94001",
    },
  ];

  it("refuses a first answer that says only where they used to live", async () => {
    const { user, file, borrower } = await applicationFile();

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declarationBody(priorOnly),
    );

    expect(res.status).toBe(400);
    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true },
    });
    expect(row.currentHousing).toBeNull();
    expect(await prisma.duResidence.count()).toBe(0);
  });

  it("leaves a stated basis and its row standing when the correction is refused", async () => {
    // The dangerous shape: the borrower HAS answered, so the column reads
    // "own". A prior-only correction would delete the Current row and keep the
    // column — the column asserting a basis whose source no longer exists.
    const { user, file, borrower } = await applicationFile();
    await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declarationBody([{ residencyType: "Current", basis: "Own", durationMonths: 30 }]),
    );

    const res = await callAs(
      user.id,
      [declarationRouter],
      "POST",
      `/${file.id}/declaration`,
      declarationBody(priorOnly),
    );

    expect(res.status).toBe(400);
    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true },
    });
    expect(row.currentHousing).toBe("own");
    const residences = await prisma.duResidence.findMany({ select: { residencyType: true } });
    expect(residences.map((r) => r.residencyType)).toEqual(["Current"]);
  });

  it("is refused by the database too, not only by the route", async () => {
    // Past the route entirely. The constraint trigger is DEFERRABLE and fires
    // at COMMIT, which is the only moment the whole set is visible — a
    // row-immediate check would refuse the borrower's correction on its way
    // through rather than the state it lands in.
    const { file } = await applicationFile();
    const applicationPartyId = await edgeFor(file.id);

    await expect(
      prisma.duResidence.create({
        data: {
          applicationPartyId,
          residencyType: "Prior",
          basis: "Rent",
          durationMonths: 40,
          monthlyRentCents: 180_000n,
          addressLineText: "88 Willow Lane",
          cityName: "Demo City",
          stateCode: "CA",
          postalCode: "94001",
        },
      }),
    ).rejects.toThrow(/none is Current/);
  });

  it("refuses deleting the current row out from under the column", async () => {
    const { file } = await applicationFile();
    const applicationPartyId = await edgeFor(file.id);
    await prisma.duResidence.createMany({
      data: [
        { applicationPartyId, residencyType: "Current", basis: "Own", durationMonths: 30 },
        {
          applicationPartyId,
          residencyType: "Prior",
          basis: "Rent",
          durationMonths: 40,
          addressLineText: "88 Willow Lane",
          cityName: "Demo City",
          stateCode: "CA",
          postalCode: "94001",
        },
      ],
    });

    await expect(
      prisma.duResidence.deleteMany({ where: { applicationPartyId, residencyType: "Current" } }),
    ).rejects.toThrow(/none is Current/);
  });

  it("lets a borrower who has answered nothing keep no residences at all", async () => {
    // The state every file in the product is in today. The trigger is about a
    // borrower who HAS residences and no current one; an empty set is not an
    // incomplete answer, it is no answer.
    const { file } = await applicationFile();
    const applicationPartyId = await edgeFor(file.id);

    expect(await prisma.duResidence.count({ where: { applicationPartyId } })).toBe(0);
  });
});

/**
 * The migration's own SQL, run again.
 *
 * Both statements are re-runnable — the guard reads, the backfill is an UPDATE
 * keyed on the residence row — so the test can execute the text that shipped
 * rather than a paraphrase of it. Reading it out of the file is what makes this
 * a test of the migration and not of a copy that drifted from it.
 */
function statement(marker: string, end: string): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const from = sql.indexOf(marker);
  if (from < 0) throw new Error(`the migration no longer contains ${marker}`);
  const to = sql.indexOf(end, from);
  if (to < 0) throw new Error(`no ${end} after ${marker} in the migration`);
  return sql.slice(from, to + end.length);
}

describe("the backfill maps a basis rather than lowercasing one", () => {
  it("writes rent_free for LivingRentFree", async () => {
    const { file, borrower } = await applicationFile();
    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: file.id },
      select: { id: true },
    });
    const edge = await prisma.applicationParty.findFirstOrThrow({
      where: { applicationId: app.id },
      select: { id: true },
    });
    await prisma.duResidence.create({
      data: {
        applicationPartyId: edge.id,
        residencyType: "Current",
        basis: "LivingRentFree",
        durationMonths: 14,
      },
    });
    await prisma.borrower.update({
      where: { id: borrower.id },
      data: { currentHousing: null },
    });

    await prisma.$executeRawUnsafe(statement('UPDATE "borrowers" b', "'Current';"));

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: borrower.id },
      select: { currentHousing: true },
    });
    // Not "livingrentfree", which is in no vocabulary this codebase has: the
    // route enum would reject the borrower's next save and the engine would
    // read them as a renter in the meantime.
    expect(row.currentHousing).toBe("rent_free");
  });

  it("RAISEs on a basis it cannot map", async () => {
    // A temporary table of the same name shadows the real one for the length of
    // this transaction, which is the only way to show the guard a value the
    // enum cannot hold. A future DuResidencyBasis member is exactly that: it
    // must stop the migration rather than have a word invented for it.
    const guard = statement("DO $$", "END $$;");

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "du_residences" (basis text) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO "du_residences" (basis) VALUES ('Cooperative')`);
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow(/cannot map to borrowers.current_housing: Cooperative/);
  });

  it("still maps every basis the enum can hold", async () => {
    // The guard's own list, checked against the type rather than trusted. A
    // member added to DuResidencyBasis without touching the migration is what
    // the RAISE above is waiting for, and this is what says so out loud.
    const guard = statement("DO $$", "END $$;");
    const members = await prisma.$queryRawUnsafe<{ label: string }[]>(
      `SELECT unnest(enum_range(NULL::"DuResidencyBasis"))::text AS label`,
    );

    for (const { label } of members) {
      expect(guard, `${label} is not in the migration's mapping`).toContain(`'${label}'`);
    }
  });
});

/**
 * And nothing still tells the next reader the value is fabricated.
 *
 * A comment that is false of the code beside it is worse than no comment: the
 * three sentences below all described a column that was NOT NULL, defaulted to
 * `'rent'`, and was posted by a screen that never asked. All three were true
 * when they were written and none of them is true now, and the one in CLAUDE.md
 * is the first thing an agent reads — left standing, it invites the fabrication
 * straight back in.
 *
 * The applied migrations are exempt on purpose. An applied migration is history
 * and its checksum is recorded; editing one to fix a sentence breaks the
 * database instead.
 */
describe("the documents agree with the column", () => {
  const STALE = [
    ["packages/db/prisma/schema.prisma", 'is asserted as "rent" by screen 2'],
    ["packages/db/prisma/schema.prisma", "in the same change that asks the question"],
    ["CLAUDE.md", 'so screen 2 sends `"rent"`'],
    ["CLAUDE.md", "The honest fix is making the field nullable"],
    ["docs/du-readiness.md", '`"rent"` is fabricated, and sent'],
    ["docs/du-readiness.md", 'the fabricated `"rent"` this repo already'],
    ["apps/api/src/services/declarations.ts", "Screen 2 still posts a basis"],
  ] as const;

  it.each(STALE)("%s no longer says %s", (file, claim) => {
    expect(readFileSync(join(repoRoot, file), "utf8")).not.toContain(claim);
  });
});
