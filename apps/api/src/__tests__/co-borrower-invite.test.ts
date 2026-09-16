/**
 * A second person, named before they arrive.
 *
 * The applicant names a co-borrower by name and email and nothing else. The
 * co-borrower completes their own profile and gives their own permissions in
 * their own session — a separate, private application — so the applicant is
 * never asked for somebody else's date of birth or Social Security number,
 * and never types one. Until the named person arrives the file lists them as
 * invited rather than as a borrower, and the three things that would read an
 * application as finished — signing it, deciding it, assembling a casefile
 * from it — wait, in the product's words: "Your co-borrower needs to finish."
 *
 * Two of these tests are about what the naming does NOT do. It asserts two
 * facts under the applicant's principal and mints the named person no
 * principal of their own; a person who has never signed in must not acquire
 * an identity the ledger can attribute statements to. And it refuses an
 * identity posted to it, rather than quietly keeping the parts it recognizes:
 * a client still sending screen 2's fields about somebody else is the shape
 * this route exists to end.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { assembleSubmission, PLACEHOLDER_INSTITUTION } from "@hm/du";
import { applicationRouter } from "../routes/application.js";
import { decisionRouter } from "../routes/decision.js";
import { fileRouter } from "../routes/files.js";
import { loadLoanFile } from "../services/repository.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1, as the web posts it. */
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

/** Screen 2, as the web posts it: the applicant. */
const SCREEN_TWO = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: { ethnicity: "declined", race: "declined", sex: "declined" },
  statedMonthlyIncome: 7_400,
};

/** What the applicant says about the person they are applying with. */
const THEO = {
  firstName: "Theo",
  lastName: "Okafor",
  email: "theo@example.test",
  occupiesProperty: true,
};

type Named = {
  borrowerId: string;
  partyId: string;
  borrowerOrdinal: number | null;
  role: string;
  error?: { code?: string; message?: string };
};

/** Screens 1 and 2, through the real routes, leaving one borrower on a file. */
async function anApplication() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  const fileId = created.body.id;
  const saved = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
  expect(saved.status).toBe(201);
  return { user, fileId };
}

function name(userId: string, fileId: string, over: Record<string, unknown> = {}) {
  return callAs<Named>(userId, [fileRouter], "POST", `/${fileId}/co-borrowers`, {
    ...THEO,
    ...over,
  });
}

function remove(userId: string, fileId: string, borrowerId: string) {
  return callAs(userId, [fileRouter], "DELETE", `/${fileId}/co-borrowers/${borrowerId}`);
}

/** Every borrowing position on this file's application, in order. */
async function ordinals(fileId: string): Promise<(number | null)[]> {
  const rows = await prisma.applicationParty.findMany({
    where: { application: { loanFileId: fileId } },
    orderBy: { borrowerOrdinal: "asc" },
    select: { borrowerOrdinal: true },
  });
  return rows.map((r) => r.borrowerOrdinal);
}

const assembling = () => ({
  createdAt: new Date("2026-02-01T09:00:00.000Z"),
  institution: PLACEHOLDER_INSTITUTION,
  taxpayerIdentifiers: async () => "000000000",
});

describe("naming a co-borrower", () => {
  it("puts them on the application as invited, not as a borrower", async () => {
    const { user, fileId } = await anApplication();
    const res = await name(user.id, fileId);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ borrowerOrdinal: 2, role: "CO_BORROWER" });
    expect(await ordinals(fileId)).toEqual([1, 2]);

    const file = (await loadLoanFile(fileId))!;
    expect(file.borrowers.map((b) => b.firstName)).toEqual(["Dana"]);
    expect(file.invitedBorrowers).toEqual([
      {
        id: res.body.borrowerId,
        partyId: res.body.partyId,
        firstName: "Theo",
        lastName: "Okafor",
        email: "theo@example.test",
        occupiesProperty: true,
        status: "named",
      },
    ]);

    // No last four, because nobody typed a number.
    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: res.body.borrowerId },
      select: { ssnLast4: true },
    });
    expect(row.ssnLast4).toBeNull();
  });

  it("records only what the applicant can say about somebody else", async () => {
    const { user, fileId } = await anApplication();
    const res = await name(user.id, fileId);

    const party = await prisma.party.findUniqueOrThrow({
      where: { id: res.body.partyId },
      select: { claimStatus: true, sourceFirstSeen: true },
    });
    expect(party).toEqual({
      claimStatus: "PROVISIONAL",
      sourceFirstSeen: "co_borrower_named_by_applicant",
    });

    const facts = await prisma.fact.findMany({
      where: { partyId: res.body.partyId, supersededById: null },
      select: { predicate: true, assertedByPrincipalId: true },
      orderBy: { predicate: "asc" },
    });
    expect(facts.map((f) => f.predicate)).toEqual(["email", "legal_name"]);

    // Under the applicant's principal — they said it — and the named person
    // has no principal to say anything with.
    const applicant = await prisma.borrower.findFirstOrThrow({
      where: { loanFileId: fileId, id: { not: res.body.borrowerId } },
      select: { partyId: true },
    });
    const applicantPrincipal = await prisma.principal.findFirstOrThrow({
      where: { kind: "BORROWER", partyId: applicant.partyId },
      select: { id: true },
    });
    expect(new Set(facts.map((f) => f.assertedByPrincipalId))).toEqual(
      new Set([applicantPrincipal.id]),
    );
    expect(await prisma.principal.count({ where: { partyId: res.body.partyId } })).toBe(0);
  });

  it("takes a co-signer as a non-occupant", async () => {
    // Somebody lending their income and credit who will not live in the home
    // is on the request in a different role, and DU has no guarantor.
    const { user, fileId } = await anApplication();
    const res = await name(user.id, fileId, { occupiesProperty: false });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe("NON_OCCUPANT_CO_BORROWER");
    const file = (await loadLoanFile(fileId))!;
    expect(file.invitedBorrowers[0]!.occupiesProperty).toBe(false);
  });

  it("refuses an identity the applicant has no business stating", async () => {
    // Screen 2's fields about somebody else. Not stripped down to the name
    // and email inside them: a client still sending this is sending a date of
    // birth and a Social Security number for a person who has not agreed to
    // be here, and quietly keeping the parts we recognize would hide that.
    const { user, fileId } = await anApplication();
    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/co-borrowers`, {
      ...SCREEN_TWO,
      firstName: "Theo",
      lastName: "Okafor",
      email: "theo@example.test",
      ssnVaultHandle: "vault:theo:1",
      ssnLast4: "8765",
      occupiesProperty: true,
    });

    expect(res.status).toBe(400);
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(1);
  });

  it("refuses a file nobody has said who they are on", async () => {
    // Screen 1 saved and screen 2 not: the file has a credit request, so the
    // refusal has to come from the missing applicant.
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const res = await name(user.id, created.body.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "NO_BORROWER" } });
    expect(await prisma.borrower.count({ where: { loanFileId: created.body.id } })).toBe(0);
  });

  it("refuses a file that is not a credit request yet", async () => {
    // A bare file has neither an applicant nor a request, and the applicant
    // is asked for first — so this is the same sentence as above, about a
    // file that is further from ready.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const res = await name(user.id, file.id);

    expect(res.status).toBe(409);
    expect(await prisma.borrower.count({ where: { loanFileId: file.id } })).toBe(0);
  });

  it("names them in the list beside the applicant", async () => {
    // The list is where a file gets its name, and a joint application is
    // named after both people on it from the moment the second is named.
    const { user, fileId } = await anApplication();
    await name(user.id, fileId);

    const res = await callAs<{ files: { id: string; borrowers: unknown[] }[] }>(
      user.id,
      [fileRouter],
      "GET",
      "/",
    );
    const row = res.body.files.find((f) => f.id === fileId);
    expect(row!.borrowers).toEqual([
      { firstName: "Dana", lastName: "Whitfield" },
      { firstName: "Theo", lastName: "Okafor" },
    ]);
  });
});

describe("while they have not finished", () => {
  it("cannot be signed", async () => {
    const { user, fileId } = await anApplication();
    await name(user.id, fileId);

    const res = await callAs(user.id, [applicationRouter], "POST", `/${fileId}/sign-application`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: "CO_BORROWER_PENDING", message: "Your co-borrower needs to finish." },
    });
    const row = await prisma.loanFile.findUniqueOrThrow({
      where: { id: fileId },
      select: { applicationSignedAt: true },
    });
    expect(row.applicationSignedAt).toBeNull();
  });

  it("cannot be decided", async () => {
    const { user, fileId } = await anApplication();
    await name(user.id, fileId);

    const res = await callAs(user.id, [decisionRouter], "POST", `/${fileId}/decision`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "CO_BORROWER_PENDING" } });
    expect(await prisma.decision.count({ where: { loanFileId: fileId } })).toBe(0);
  });

  it("cannot be assembled into a casefile, and says who is missing", async () => {
    // Refused by name, before a generic "no date of birth" could say it
    // worse. A submission that left them out would be a different loan.
    const { user, fileId } = await anApplication();
    await name(user.id, fileId);
    const app = await prisma.application.findFirstOrThrow({
      where: { loanFileId: fileId },
      select: { id: true },
    });

    await expect(assembleSubmission(prisma, app.id, assembling())).rejects.toThrow(
      /Theo Okafor is named on this application and has not completed their profile/,
    );
  });

  it("names everybody who has not, when there is more than one", async () => {
    const { user, fileId } = await anApplication();
    await name(user.id, fileId);
    await name(user.id, fileId, {
      firstName: "Marisol",
      lastName: "Vega",
      email: "marisol@example.test",
    });

    const res = await callAs(user.id, [applicationRouter], "POST", `/${fileId}/sign-application`);

    expect(res.body).toMatchObject({
      error: {
        message: "Theo Okafor and Marisol Vega need to finish their part before this can go on.",
      },
    });
  });
});

describe("taking a named person off", () => {
  it("frees their position and forgets what was typed about them", async () => {
    const { user, fileId } = await anApplication();
    const named = await name(user.id, fileId);

    const res = await remove(user.id, fileId, named.body.borrowerId);

    expect(res.status).toBe(204);
    expect(await ordinals(fileId)).toEqual([1]);
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(1);
    expect(await prisma.party.count({ where: { id: named.body.partyId } })).toBe(0);
    expect((await loadLoanFile(fileId))!.invitedBorrowers).toEqual([]);
  });

  it("refuses the applicant", async () => {
    const { user, fileId } = await anApplication();
    const applicant = (await loadLoanFile(fileId))!.borrowers[0]!;

    const res = await remove(user.id, fileId, applicant.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "APPLICANT_STAYS" } });
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(1);
  });

  it("is theirs to do once they have signed in", async () => {
    // Arriving is a merge, not a flip: the trigger lets a PROVISIONAL party
    // go to CLAIM_PENDING or MERGED and nowhere else, so the person's own
    // sign-in creates their party and the named one merges into it. A merged
    // party is a person who agreed to be here, and leaving is theirs.
    const { user, fileId } = await anApplication();
    const named = await name(user.id, fileId);
    const theirOwn = await createParty({ claimStatus: "CLAIMED" });
    await prisma.party.update({
      where: { id: named.body.partyId },
      data: { claimStatus: "MERGED", mergedIntoPartyId: theirOwn.id },
    });

    const res = await remove(user.id, fileId, named.body.borrowerId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "CO_BORROWER_ARRIVED" } });
    expect(await prisma.borrower.count({ where: { id: named.body.borrowerId } })).toBe(1);
  });

  it("is not reachable from somebody else's session", async () => {
    // 404, not 403: a 403 confirms the id exists.
    const { user, fileId } = await anApplication();
    const named = await name(user.id, fileId);
    const stranger = await createUser();

    const res = await remove(stranger.id, fileId, named.body.borrowerId);

    expect(res.status).toBe(404);
    expect(await prisma.borrower.count({ where: { id: named.body.borrowerId } })).toBe(1);
  });

  it("says so for a person who is not on this file", async () => {
    const mine = await anApplication();
    const theirs = await anApplication();
    const elsewhere = await name(theirs.user.id, theirs.fileId);

    const res = await remove(mine.user.id, mine.fileId, elsewhere.body.borrowerId);

    expect(res.status).toBe(404);
    expect(await prisma.borrower.count({ where: { id: elsewhere.body.borrowerId } })).toBe(1);
  });
});
