/**
 * The impure half of the autofill, against a real Postgres: what a reader is
 * handed with their file, whose rows it came from, what is recorded about it,
 * and what the save writes.
 *
 * Every promise here is about WHOSE: the owner reads a suggestion from their
 * own snapshot and never from anyone else's; a demo file offers nothing; the
 * snapshot row records the purpose the adapter certified; `autofill_shown` is
 * written once per suggestion and snapshot; a dismissal reported with the save
 * is honored on the next read; an outcome naming a snapshot that is not the
 * reader's own is refused.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { EXTENSION_OF_CREDIT } from "@hm/shared";
import type { Suggestion } from "@hm/shared";
import { connectorRouter } from "../routes/connectors.js";
import { declarationRouter } from "../routes/declarations.js";
import { fileRouter } from "../routes/files.js";
import { loadLoanFile } from "../services/repository.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

const DANA = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: null,
  isMilitary: false,
  demographics: null,
};

const RENTING = {
  declaration: {
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
    bankruptcy: false,
    bankruptcyChapters: [],
  },
  residences: [{ residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2_150 }],
  propertyEstateType: "FeeSimple",
};

type Read = { file: { id: string }; you: string | null; suggestions: Suggestion[] };

/** Screens 1 and 2, the authorization, the credit pull and the bank. */
async function linked() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA)).status).toBe(
    201,
  );
  const dana = (await loadLoanFile(fileId))!.borrowers[0]!;
  for (const kind of ["verification_authorization", "econsent"]) {
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind,
      borrowerId: dana.id,
    });
  }
  await callAs(user.id, [connectorRouter], "POST", `/${fileId}/credit`, {});
  const bank = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`, {});
  expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  return { user, fileId, partyId: dana.partyId };
}

const read = (userId: string, fileId: string) =>
  callAs<Read>(userId, [fileRouter], "GET", `/${fileId}`);

const events = (fileId: string, kind: string) =>
  prisma.fileEvent.findMany({ where: { loanFileId: fileId, kind }, select: { payload: true } });

describe("reading a file", () => {
  it("records what the adapter certified on the snapshot row", async () => {
    const h = await linked();
    const row = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "bank" },
      select: { permissiblePurpose: true, partyId: true },
    });
    expect(row.permissiblePurpose).toBe(EXTENSION_OF_CREDIT);
    expect(row.partyId).toBe(h.partyId);
  });

  it("hands the owner the rent from their own report, and writes that it was shown once", async () => {
    const h = await linked();
    const first = await read(h.user.id, h.fileId);
    expect(first.status).toBe(200);
    const [rent, ...rest] = first.body.suggestions;
    expect(rest).toHaveLength(0);
    expect(rent).toMatchObject({ key: "current_monthly_rent", partyId: h.partyId });
    expect(rent!.value).toBeGreaterThan(0);

    const again = await read(h.user.id, h.fileId);
    expect(again.body.suggestions).toHaveLength(1);
    expect(await events(h.fileId, "autofill_shown")).toHaveLength(1);
  });

  it("offers nothing before the bank is linked, and nothing on a file that is not the reader's own", async () => {
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const bare = await read(user.id, created.body.id);
    expect(bare.body.suggestions).toEqual([]);

    const h = await linked();
    const stranger = await createUser();
    const refused = await read(stranger.id, h.fileId);
    expect(refused.status).toBe(404);
  });

  it("offers nothing on a demo file", async () => {
    const h = await linked();
    await prisma.loanFile.update({ where: { id: h.fileId }, data: { isDemo: true } });
    const maya = await createUser({ personaKey: "maya_okafor" });
    const res = await read(maya.id, h.fileId);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });
});

describe("saving the questions", () => {
  it("writes the outcome the screen reports, and the answers exactly as without it", async () => {
    const h = await linked();
    const [rent] = (await read(h.user.id, h.fileId)).body.suggestions;
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [
        {
          key: "current_monthly_rent",
          snapshotId: rent!.evidence.snapshotId,
          outcome: "accepted",
          proposed: rent!.value,
          given: 2_150,
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const file = (await loadLoanFile(h.fileId))!;
    expect(file.borrowers[0]!.residences[0]).toMatchObject({ basis: "Rent", monthlyRent: 2_150 });
    const accepted = await events(h.fileId, "autofill_accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({
      key: "current_monthly_rent",
      snapshotId: rent!.evidence.snapshotId,
      partyId: h.partyId,
      proposed: rent!.value,
      given: 2_150,
    });
  });

  it("honors a dismissal on the next read, until a newer report", async () => {
    const h = await linked();
    const [rent] = (await read(h.user.id, h.fileId)).body.suggestions;
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [
        {
          key: "current_monthly_rent",
          snapshotId: rent!.evidence.snapshotId,
          outcome: "dismissed",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect((await read(h.user.id, h.fileId)).body.suggestions).toEqual([]);

    // A re-pull is a newer snapshot, and the dismissal was on the old one.
    const again = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(again.status).toBe(201);
    expect((await read(h.user.id, h.fileId)).body.suggestions).toHaveLength(1);
  });

  it("refuses an outcome naming a snapshot that is not the reader's own", async () => {
    const h = await linked();
    const other = await linked();
    const theirs = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: other.fileId, kind: "bank" },
      select: { id: true },
    });
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [{ key: "current_monthly_rent", snapshotId: theirs.id, outcome: "accepted" }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "AUTOFILL_NOT_YOURS" } });
    expect(await events(h.fileId, "autofill_accepted")).toHaveLength(0);
  });
});
