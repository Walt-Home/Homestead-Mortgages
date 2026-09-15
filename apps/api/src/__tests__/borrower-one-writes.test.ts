/**
 * The screens write onto the person they are showing.
 *
 * Four writers resolve "Borrower 1" for themselves — screen 2's save, screen
 * 3's Section 5 post, the append that names a co-borrower, and the upload that
 * credits one — and every reader resolves it through
 * `application_parties.borrower_ordinal`. While the writers used creation
 * order instead, the two agreed on every file that had only ever grown and
 * disagreed on exactly one shape: an applicant dropped and replaced, whose
 * successor fills the freed ordinal 1 and is the NEWEST borrower row on the
 * file.
 *
 * On that file the screens read one person and saved onto another. Screen 3
 * prefills from Borrower 1 and posts without naming anybody, so the signer's
 * bankruptcy landed on the person they replaced: the review screen then showed
 * it under her name and told him he had not answered yet. Screen 2 prefills
 * from Borrower 1 too, so a corrected surname was written over hers, with a
 * 201. And the append stamps the new party's facts with Borrower 1's
 * principal, so the co-borrower's date of birth was recorded as asserted by
 * somebody who is not the applicant. And the upload put the wrong person's
 * name in the ledger as the one who acted.
 *
 * Against a real Postgres, because the ordinal, its vacancy rule and the
 * one-primary constraint are the database's and a mock would prove none of
 * them.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { fileRouter } from "../routes/files.js";
import { documentRouter } from "../routes/documents.js";
import { loadLoanFile } from "../services/repository.js";
import { loadDeclaration, recordDeclaration } from "../services/declarations.js";
import { primaryBorrowerRow } from "../services/borrower-order.js";
import { principalForParty, staffPrincipal } from "../services/party.js";
import { ensureApplicationParty } from "../services/applications.js";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "12 Curtner Ave", city: "San Jose", state: "ca", postalCode: "95125" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 900_000,
  loanAmount: 720_000,
  downPayment: 180_000,
  statedMonthlyIncome: 9_200,
};

/** Screen 2, as the web posts it: the applicant who later withdraws. */
const PRIYA = {
  firstName: "Priya",
  lastName: "Raman",
  email: "priya@example.test",
  phone: "5555550111",
  dateOfBirth: "1990-03-02",
  ssnVaultHandle: "vault:priya:1",
  ssnLast4: "1122",
  currentAddress: { line1: "12 Curtner Ave", city: "San Jose", state: "CA", postalCode: "95125" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: null,
  statedMonthlyIncome: 9_200,
};

/** The person who ends up holding position 1, on the newer row. */
const DEV = {
  firstName: "Dev",
  lastName: "Raman",
  email: "dev@example.test",
  phone: "5555550112",
  dateOfBirth: "1989-07-19",
  ssnVaultHandle: "vault:dev:1",
  ssnLast4: "7788",
  currentAddress: { line1: "12 Curtner Ave", city: "San Jose", state: "CA", postalCode: "95125" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: false,
  isMilitary: false,
  demographics: null,
};

/** A third person, appended once the household has been rearranged. */
const NOOR = {
  ...DEV,
  firstName: "Noor",
  lastName: "Haddad",
  email: "noor@example.test",
  phone: "5555550133",
  dateOfBirth: "1992-05-08",
  ssnVaultHandle: "vault:noor:1",
  ssnLast4: "3344",
};

/** Section 5 with one yes, so a misfiled answer is visible rather than uniform. */
const DECLARED_BANKRUPTCY = {
  intentToOccupy: "Yes",
  homeownerPastThreeYears: "No",
  specialBorrowerSellerRelationship: false,
  undisclosedBorrowedFunds: false,
  undisclosedMortgageApplication: false,
  undisclosedCreditApplication: false,
  propertyProposedCleanEnergyLien: false,
  undisclosedComakerOfNote: false,
  outstandingJudgments: false,
  presentlyDelinquent: false,
  partyToLawsuit: false,
  priorPropertyDeedInLieuConveyed: false,
  priorPropertyShortSaleCompleted: false,
  priorPropertyForeclosureCompleted: false,
  bankruptcy: true,
  bankruptcyChapters: ["ChapterSeven"],
} as const;

/**
 * Long enough at the current address that no previous one is owed. A Current
 * residence carries no address of its own — it reads the pinned
 * `current_address` fact, and the database refuses a row that stores one.
 */
const SETTLED = [
  { residencyType: "Current", basis: "Rent", durationMonths: 72, monthlyRent: 3_400 },
] as const;

/**
 * The applicant dropped and replaced at position 1.
 *
 * Priya asks and takes ordinal 1; Dev is appended onto a newer row and takes
 * 2. She withdraws, both memberships come off, and Dev is put back on as the
 * primary — the schema refills a vacancy rather than renumbering the
 * survivors, so he takes the freed 1 and she comes back at 2.
 *
 * So the document says Dev is Borrower 1 and the creation clock says Priya is
 * first, and they are not the same person. It is the only shape in which a
 * reader sorted by ordinal and a writer sorted by creation can be told apart.
 */
async function replacedApplicant() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  const fileId = created.body.id;

  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, PRIYA)).status).toBe(
    201,
  );
  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/co-borrowers`, DEV)).status).toBe(
    201,
  );

  const rows = await prisma.borrower.findMany({
    where: { loanFileId: fileId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, partyId: true },
  });
  const [her, him] = rows as [{ id: string; partyId: string }, { id: string; partyId: string }];

  const app = await prisma.application.findFirstOrThrow({
    where: { loanFileId: fileId },
    select: { id: true },
  });
  await prisma.applicationParty.deleteMany({ where: { applicationId: app.id } });
  const primaryEdge = await prisma.$transaction(async (tx) => {
    const edge = await ensureApplicationParty(tx, app.id, him.partyId, "PRIMARY_BORROWER");
    await ensureApplicationParty(tx, app.id, her.partyId, "CO_BORROWER");
    return edge;
  });
  expect(primaryEdge.borrowerOrdinal).toBe(1);

  return { user, fileId, her, him };
}

describe("a file whose ordinal 1 was refilled", () => {
  it("resolves Borrower 1 to the replacement, not the older row", async () => {
    const { fileId, him } = await replacedApplicant();

    expect((await primaryBorrowerRow(prisma, fileId))!.id).toBe(him.id);
    expect((await loadLoanFile(fileId))!.borrowers[0]!.firstName).toBe("Dev");
  });

  it("records Section 5 against the borrower who is answering", async () => {
    // Screen 3 posts no borrower id, so this is the whole of the default.
    const { fileId, her, him } = await replacedApplicant();
    await recordDeclaration(fileId, {
      declaration: DECLARED_BANKRUPTCY,
      residences: SETTLED,
      propertyEstateType: "FeeSimple",
      assertedByPrincipalId: await staffPrincipal(prisma, `ops-${fileId}`),
    });

    const file = (await loadLoanFile(fileId))!;
    const dev = file.borrowers.find((b) => b.id === him.id)!;
    const priya = file.borrowers.find((b) => b.id === her.id)!;
    expect(dev.declaration?.bankruptcy).toBe(true);
    // Not merely absent from him: hers has to stay unasked, because a review
    // screen that shows a bankruptcy under her name is the defect itself.
    expect(priya.declaration).toBeNull();
  });

  it("reads Section 5 back off the same edge it wrote", async () => {
    const { fileId, him } = await replacedApplicant();
    const written = await recordDeclaration(fileId, {
      declaration: DECLARED_BANKRUPTCY,
      residences: SETTLED,
      propertyEstateType: "FeeSimple",
      assertedByPrincipalId: await staffPrincipal(prisma, `ops-${fileId}`),
    });

    const read = await loadDeclaration(fileId);
    expect(read!.applicationPartyId).toBe(written.applicationPartyId);
    const edge = await prisma.applicationParty.findUniqueOrThrow({
      where: { id: read!.applicationPartyId },
      select: { partyId: true, borrowerOrdinal: true },
    });
    expect(edge.partyId).toBe(him.partyId);
    expect(edge.borrowerOrdinal).toBe(1);
  });

  it("corrects the borrower screen 2 is showing", async () => {
    const { user, fileId, her, him } = await replacedApplicant();
    const revisit = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, {
      ...DEV,
      lastName: "Ramanathan",
    });
    expect(revisit.status).toBe(201);

    const file = (await loadLoanFile(fileId))!;
    expect(file.borrowers.find((b) => b.id === him.id)!.lastName).toBe("Ramanathan");
    // And the person he replaced is untouched. A save that renamed her would
    // have been one borrower's identity written over another's.
    expect(file.borrowers.find((b) => b.id === her.id)!.firstName).toBe("Priya");
    expect(file.borrowers.find((b) => b.id === her.id)!.lastName).toBe("Raman");
  });

  it("names an appended co-borrower under Borrower 1's principal", async () => {
    const { user, fileId, her, him } = await replacedApplicant();
    const appended = await callAs<{ borrowerId: string }>(
      user.id,
      [fileRouter],
      "POST",
      `/${fileId}/co-borrowers`,
      NOOR,
    );
    expect(appended.status).toBe(201);

    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: appended.body.borrowerId },
      select: { partyId: true },
    });
    const stated = await prisma.fact.findFirstOrThrow({
      where: { partyId: row.partyId, predicate: "legal_name" },
      select: { assertedByPrincipalId: true },
    });
    const [hisPrincipal, hersPrincipal] = await prisma.$transaction(async (tx) => [
      await principalForParty(tx, him.partyId),
      await principalForParty(tx, her.partyId),
    ]);
    expect(stated.assertedByPrincipalId).toBe(hisPrincipal);
    expect(stated.assertedByPrincipalId).not.toBe(hersPrincipal);
  });

  it("credits an upload to Borrower 1", async () => {
    // The upload screen sends no borrower id either, so whoever this route
    // decides Borrower 1 is becomes the actor the ledger settles under.
    // Naming the person he replaced would be a record of the wrong person
    // having acted.
    //
    // The principal is the evidence. A co-borrower named by the applicant has
    // asserted nothing and has none of their own; `settleBorrowerAct` mints
    // one for the party it is handed, so the act of crediting the upload to
    // Dev is what brings his into existence.
    const { user, fileId, him } = await replacedApplicant();
    const borrowerPrincipal = (partyId: string) =>
      prisma.principal.findFirst({ where: { kind: "BORROWER", partyId }, select: { id: true } });
    expect(await borrowerPrincipal(him.partyId)).toBeNull();

    const uploaded = await callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
      satisfiesRequirementId: "CRD-008",
      filename: "discharge.pdf",
      contentType: "application/pdf",
      bytes: 40_000,
    });
    expect(uploaded.status).toBe(201);

    expect(await borrowerPrincipal(him.partyId)).not.toBeNull();
  });
});

describe("a file with nobody on it", () => {
  it("has no Borrower 1 to resolve", async () => {
    // The fallback still has to answer honestly: each writer owes a different
    // sentence for an empty file, so this returns null rather than throwing
    // one of them.
    const file = await createLoanFile({ userId: (await createUser()).id });
    expect(await primaryBorrowerRow(prisma, file.id)).toBeNull();
  });
});
