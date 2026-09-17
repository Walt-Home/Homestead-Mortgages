/**
 * The invitation, and the arrival.
 *
 * A named co-borrower is reached by a link and arrives by signing in. Three
 * things this file holds that a reader should be able to check quickly:
 *
 *   - The token is in the email and nowhere else. The table holds its
 *     SHA-256, the events hold its id, the response holds where it went —
 *     and, only where developer sign-in is available, the link itself,
 *     which is the one environment with no inbox to open.
 *   - Arriving is a merge. The named PROVISIONAL party folds into the party
 *     the person's sign-in created; the borrower row and the membership
 *     move with it; the two facts the applicant stated are restated on the
 *     survivor; and the person is still "invited" — claimed, not finished —
 *     until they have said who they are on their own screen 2.
 *   - Every way a link can be bad is the same 404, and the applicant taking
 *     their own co-borrower's link is a 409, because one person holds one
 *     role on one mortgage.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { FixtureMailConnector, MailConnector } from "@hm/connectors";
import { applicationRouter } from "../routes/application.js";
import { authRouter } from "../routes/auth.js";
import { connectorRouter } from "../routes/connectors.js";
import { decisionRouter } from "../routes/decision.js";
import { declarationRouter } from "../routes/declarations.js";
import { fileRouter } from "../routes/files.js";
import { connectors } from "../services/connectors.js";
import { loadLoanFile } from "../services/repository.js";
import { outstanding } from "@hm/requirements";
import { underwrite, APOR_TABLE } from "@hm/underwriting";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";
import { inviteCoBorrower } from "../services/invitations.js";
import { appendCoBorrowerWithFacts } from "../services/co-borrowers.js";

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
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: null,
  statedMonthlyIncome: 7_400,
};

/** Theo's own screen 2, as he would post it. No income: he never saw screen 1. */
const THEO_HIMSELF = {
  firstName: "Theo",
  lastName: "Okafor",
  email: "theo@example.test",
  phone: "5555550188",
  dateOfBirth: "1984-02-19",
  ssnVaultHandle: "vault:theo:1",
  ssnLast4: "8765",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: false,
  isMilitary: false,
  demographics: null,
};

/** Section 5, all no, and a residence he owns. */
const SECTION_FIVE = {
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
};
const OWNING = { residencyType: "Current", basis: "Own", durationMonths: 90 };

const outbox = () => (connectors().mail as FixtureMailConnector).outbox;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Dana's file with Theo named on it. */
async function namedHousehold() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA);
  const named = await callAs<{ borrowerId: string; partyId: string }>(
    user.id,
    [fileRouter],
    "POST",
    `/${fileId}/co-borrowers`,
    { firstName: "Theo", lastName: "Okafor", email: "theo@example.test", occupiesProperty: true },
  );
  expect(named.status).toBe(201);
  return { user, fileId, borrowerId: named.body.borrowerId, partyId: named.body.partyId };
}

type Invited = { invitationId: string; sentTo: string; expiresAt: string; link?: string };

function invite(userId: string, fileId: string, borrowerId: string) {
  return callAs<Invited>(
    userId,
    [fileRouter],
    "POST",
    `/${fileId}/co-borrowers/${borrowerId}/invitations`,
  );
}

/** The token, read off the email — the only place it is. */
function tokenInTheEmail(): string {
  const last = outbox().at(-1);
  const match = /\/claim#([A-Za-z0-9_-]+)/.exec(last?.text ?? "");
  if (!match) throw new Error("no claim link in the last email");
  return match[1]!;
}

function accept(userId: string, token: string) {
  return callAs<{ loanFileId: string; borrowerId: string }>(
    userId,
    [authRouter],
    "POST",
    "/claims/accept",
    { token },
    "/api/auth",
  );
}

/** What a holder of the link is shown before signing in. */
function look(userId: string, token: string) {
  return callAs(userId, [authRouter], "POST", "/claims/preview", { token }, "/api/auth");
}

describe("sending the invitation", () => {
  it("emails the named person a link, and keeps only the hash", async () => {
    const h = await namedHousehold();
    const before = outbox().length;

    const res = await invite(h.user.id, h.fileId, h.borrowerId);

    expect(res.status).toBe(201);
    expect(res.body.sentTo).toBe("theo@example.test");
    expect(outbox().length).toBe(before + 1);
    const email = outbox().at(-1)!;
    expect(email.to).toBe("theo@example.test");
    expect(email.subject).toContain("Dana Whitfield");
    const token = tokenInTheEmail();

    const row = await prisma.coBorrowerInvitation.findUniqueOrThrow({
      where: { id: res.body.invitationId },
    });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const events = await prisma.fileEvent.findMany({ where: { loanFileId: h.fileId } });
    expect(JSON.stringify(events)).not.toContain(token);

    // The party is now "invited" rather than merely "named".
    const file = (await loadLoanFile(h.fileId))!;
    expect(file.invitedBorrowers[0]).toMatchObject({ id: h.borrowerId, status: "invited" });
  });

  it("echoes the link only where developer sign-in is available", async () => {
    // The test process has no OAuth client and is not production, which is
    // exactly the gate `/auth/developer` sits behind — so here the link is
    // echoed, and it is the same link that went out.
    const h = await namedHousehold();
    const res = await invite(h.user.id, h.fileId, h.borrowerId);
    expect(res.body.link).toBe(`http://localhost:5173/claim#${tokenInTheEmail()}`);
  });

  it("re-sending kills the last link", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const first = tokenInTheEmail();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const second = tokenInTheEmail();
    expect(second).not.toBe(first);

    const dead = await look(h.user.id, first);
    expect(dead.status).toBe(404);
    const live = await look(h.user.id, second);
    expect(live.status).toBe(200);
    expect(await prisma.coBorrowerInvitation.count({ where: { borrowerId: h.borrowerId } })).toBe(
      2,
    );
  });

  it("leaves them named, not invited, when the email does not go", async () => {
    // The party moves to invited only once the link has actually gone. A
    // mailer that answers not_delivered leaves the person named, and the
    // review screen keeps saying so rather than "invited".
    const h = await namedHousehold();
    const silent: MailConnector = {
      capabilities: { provider: "test-silence", mode: "fixture", satisfies: [] },
      send: async () => ({ status: "not_delivered", reason: "the wire is down" }),
    };
    await expect(inviteCoBorrower(h.fileId, h.borrowerId, silent)).rejects.toMatchObject({
      code: "MAIL_NOT_DELIVERED",
    });
    const party = await prisma.party.findUniqueOrThrow({ where: { id: h.partyId } });
    expect(party.claimStatus).toBe("PROVISIONAL");
    expect((await loadLoanFile(h.fileId))!.invitedBorrowers[0]!.status).toBe("named");
  });

  it("refuses to invite a person whose identity was stated for them", async () => {
    // The paper joint URLA: a co-borrower appended with every fact. A claim
    // would merge that identity into a party carrying none of it.
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    await callAs(user.id, [fileRouter], "POST", `/${created.body.id}/borrowers`, DANA);
    const stated = await appendCoBorrowerWithFacts(created.body.id, {
      ...THEO_HIMSELF,
      ssnLast4: "8765",
      ssnVaultHandle: "vault:theo:1",
    });
    const res = await invite(user.id, created.body.id, stated.borrowerId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "IDENTITY_ALREADY_STATED" } });
  });

  it("is the applicant's to send", async () => {
    const h = await namedHousehold();
    const stranger = await createUser();
    const res = await invite(stranger.id, h.fileId, h.borrowerId);
    expect(res.status).toBe(404);
    expect(await prisma.coBorrowerInvitation.count({ where: { borrowerId: h.borrowerId } })).toBe(
      0,
    );
  });

  it("refuses to invite the applicant", async () => {
    const h = await namedHousehold();
    const applicant = (await loadLoanFile(h.fileId))!.borrowers[0]!;
    const res = await invite(h.user.id, h.fileId, applicant.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "APPLICANT_STAYS" } });
  });
});

describe("looking at the link", () => {
  it("says what the email said, and names no file", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const token = tokenInTheEmail();
    const stranger = await createUser();

    const res = await look(stranger.id, token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      coBorrowerFirstName: "Theo",
      applicantFirstName: "Dana",
      propertyCity: "Austin",
    });
    expect(JSON.stringify(res.body)).not.toContain(h.fileId);
    expect(JSON.stringify(res.body)).not.toContain(h.borrowerId);
  });

  it("answers every bad link the same way", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const token = tokenInTheEmail();
    const stranger = await createUser();

    expect((await look(stranger.id, "a".repeat(43))).status).toBe(404);
    // Eight days ago, so the deadline is in the past and still after the
    // making — the CHECK holds even for a row a test ages by hand.
    await prisma.coBorrowerInvitation.updateMany({
      where: { borrowerId: h.borrowerId },
      data: {
        createdAt: new Date(Date.now() - 8 * 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect((await look(stranger.id, token)).status).toBe(404);
  });
});

describe("taking the invitation", () => {
  it("merges the named party into the person who signed in", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const token = tokenInTheEmail();
    const theo = await createUser();

    const res = await accept(theo.id, token);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ loanFileId: h.fileId, borrowerId: h.borrowerId });

    const his = await prisma.user.findUniqueOrThrow({
      where: { id: theo.id },
      select: { partyId: true },
    });
    const row = await prisma.borrower.findUniqueOrThrow({
      where: { id: h.borrowerId },
      select: { partyId: true, ssnLast4: true },
    });
    expect(row.partyId).toBe(his.partyId);
    expect(row.ssnLast4).toBeNull();
    const named = await prisma.party.findUniqueOrThrow({ where: { id: h.partyId } });
    expect(named.claimStatus).toBe("MERGED");
    expect(named.mergedIntoPartyId).toBe(his.partyId);
    const membership = await prisma.applicationParty.findFirst({
      where: { application: { loanFileId: h.fileId }, partyId: his.partyId! },
      select: { role: true, borrowerOrdinal: true },
    });
    expect(membership).toEqual({ role: "CO_BORROWER", borrowerOrdinal: 2 });

    // Still waiting on him — claimed, and not yet a person the engine can read.
    const file = (await loadLoanFile(h.fileId))!;
    expect(file.borrowers.map((b) => b.firstName)).toEqual(["Dana"]);
    expect(file.invitedBorrowers[0]).toMatchObject({
      id: h.borrowerId,
      partyId: his.partyId,
      firstName: "Theo",
      lastName: "Okafor",
      status: "claimed",
    });
    const invitation = await prisma.coBorrowerInvitation.findFirstOrThrow({
      where: { borrowerId: h.borrowerId },
    });
    expect(invitation.acceptedAt).not.toBeNull();
    expect(invitation.acceptedByPartyId).toBe(his.partyId);
  });

  it("works once", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const token = tokenInTheEmail();
    const theo = await createUser();
    await accept(theo.id, token);

    const again = await accept((await createUser()).id, token);
    expect(again.status).toBe(404);
  });

  it("refuses the applicant taking their own co-borrower's link", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const res = await accept(h.user.id, tokenInTheEmail());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "ALREADY_ON_FILE" } });
    const named = await prisma.party.findUniqueOrThrow({ where: { id: h.partyId } });
    expect(named.claimStatus).toBe("CLAIM_PENDING");
  });
});

describe("once they have arrived", () => {
  async function claimed() {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const theo = await createUser();
    const res = await accept(theo.id, tokenInTheEmail());
    expect(res.status).toBe(201);
    return { ...h, theo };
  }

  it("can read the file, and is told which row is theirs", async () => {
    const h = await claimed();
    const res = await callAs<{ you: string | null }>(
      h.theo.id,
      [fileRouter],
      "GET",
      `/${h.fileId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.you).toBe(h.borrowerId);
  });

  it("sees the household and nothing private about the applicant", async () => {
    // The file a member reads back has the applicant's name on it — they
    // were told who they are applying with — and none of her person: no
    // date of birth, no number, no address, no answers, no reports. The
    // applicant's own read is untouched.
    const h = await claimed();
    type Seen = {
      file: { borrowers: Record<string, unknown>[]; credit: unknown; consents: unknown[] };
    };
    const his = await callAs<Seen>(h.theo.id, [fileRouter], "GET", `/${h.fileId}`);
    const dana = his.body.file.borrowers[0]!;
    expect(dana.firstName).toBe("Dana");
    expect(dana.dateOfBirth).toBe("");
    expect(dana.ssn).toEqual({ last4: "", vaultHandle: "" });
    expect(dana.phone).toBe("");
    expect(dana.email).toBe("");
    expect(dana.currentAddress).toMatchObject({ line1: "" });
    expect(his.body.file.credit).toBeNull();
    expect(his.body.file.consents).toEqual([]);
    expect(JSON.stringify(his.body)).not.toContain("4321");
    expect(JSON.stringify(his.body)).not.toContain("1986-11-03");

    const hers = await callAs<Seen>(h.user.id, [fileRouter], "GET", `/${h.fileId}`);
    expect(hers.body.file.borrowers[0]!.dateOfBirth).toBe("1986-11-03");
    expect((hers.body.file.borrowers[0]!.ssn as { last4: string }).last4).toBe("4321");
  });

  it("is still nobody to a stranger, and not the owner", async () => {
    const h = await claimed();
    const stranger = await createUser();
    expect((await callAs(stranger.id, [fileRouter], "GET", `/${h.fileId}`)).status).toBe(404);
    // Owner-only things stay owner-only: the terms, the household, the file.
    expect(
      (await callAs(h.theo.id, [fileRouter], "PATCH", `/${h.fileId}`, { loanAmount: 300_000 }))
        .status,
    ).toBe(404);
    expect(
      (
        await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/co-borrowers`, {
          firstName: "Marisol",
          lastName: "Vega",
          email: "marisol@example.test",
          occupiesProperty: true,
        })
      ).status,
    ).toBe(404);
    expect((await callAs(h.theo.id, [fileRouter], "DELETE", `/${h.fileId}`)).status).toBe(404);
  });

  it("cannot be removed by the applicant any more", async () => {
    const h = await claimed();
    const res = await callAs(
      h.user.id,
      [fileRouter],
      "DELETE",
      `/${h.fileId}/co-borrowers/${h.borrowerId}`,
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "CO_BORROWER_ARRIVED" } });
  });

  it("says who they are on their own screen 2, and becomes a borrower", async () => {
    const h = await claimed();

    const saved = await callAs(
      h.theo.id,
      [fileRouter],
      "POST",
      `/${h.fileId}/borrowers`,
      THEO_HIMSELF,
    );

    expect(saved.status).toBe(201);
    const file = (await loadLoanFile(h.fileId))!;
    expect(file.invitedBorrowers).toEqual([]);
    expect(file.borrowers.map((b) => `${b.firstName} ${b.lastName}`)).toEqual([
      "Dana Whitfield",
      "Theo Okafor",
    ]);
    const theo = file.borrowers[1]!;
    expect(theo.id).toBe(h.borrowerId);
    expect(theo.dateOfBirth).toBe("1984-02-19");
    expect(theo.ssn.last4).toBe("8765");
    // The applicant is untouched, in position 1, and the co-borrower kept
    // his place and his role.
    const dana = file.borrowers[0]!;
    expect(dana.ssn.last4).toBe("4321");
    expect(dana.dateOfBirth).toBe("1986-11-03");
    const roles = await prisma.applicationParty.findMany({
      where: { application: { loanFileId: h.fileId } },
      orderBy: { borrowerOrdinal: "asc" },
      select: { role: true, borrowerOrdinal: true },
    });
    expect(roles).toEqual([
      { role: "PRIMARY_BORROWER", borrowerOrdinal: 1 },
      { role: "CO_BORROWER", borrowerOrdinal: 2 },
    ]);
    // His facts are his own: asserted under his party's principal, not Dana's.
    const dob = await prisma.fact.findFirstOrThrow({
      where: { partyId: theo.partyId, predicate: "date_of_birth", supersededById: null },
      select: { assertedBy: { select: { partyId: true } } },
    });
    expect(dob.assertedBy.partyId).toBe(theo.partyId);
  });

  it("answers Section 5 about themselves, without naming a row", async () => {
    // Screen 3 posts no borrowerId. Read as Borrower 1 that put Theo's
    // answers onto Dana's edge, which the principal rule then refused — so
    // a co-borrower could not answer at all. The row is the person asking.
    const h = await claimed();
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, THEO_HIMSELF);

    const res = await callAs(h.theo.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      declaration: { ...SECTION_FIVE, bankruptcy: true, bankruptcyChapters: ["ChapterSeven"] },
      residences: [OWNING],
      propertyEstateType: "FeeSimple",
    });

    expect(res.status).toBe(201);
    const file = (await loadLoanFile(h.fileId))!;
    const theo = file.borrowers.find((b) => b.id === h.borrowerId)!;
    expect(theo.declaration?.bankruptcy).toBe(true);
    expect(theo.residences.map((r) => r.basis)).toEqual(["Own"]);
    expect(file.borrowers[0]!.declaration).toBeNull();
    // Attested by him: the row carries his own principal.
    const stored = await prisma.duDeclaration.findFirstOrThrow({
      where: { applicationParty: { partyId: theo.partyId } },
      select: { assertedBy: { select: { partyId: true } } },
    });
    expect(stored.assertedBy.partyId).toBe(theo.partyId);
    // And reads back as theirs, without naming a row — and the applicant's
    // row, named, answers 404: a member reads nobody's answers but their own.
    const read = await callAs<{ declaration: { declaration: { bankruptcy: boolean } } | null }>(
      h.theo.id,
      [declarationRouter],
      "GET",
      `/${h.fileId}/declaration`,
    );
    expect(read.body.declaration?.declaration.bankruptcy).toBe(true);
    const dana = (await loadLoanFile(h.fileId))!.borrowers[0]!;
    const hers = await callAs(
      h.theo.id,
      [declarationRouter],
      "GET",
      `/${h.fileId}/declaration?borrowerId=${dana.id}`,
    );
    expect(hers.status).toBe(404);
  });

  it("signs for themselves, and the file's own signature stays the applicant's", async () => {
    const h = await claimed();
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, {
      ...THEO_HIMSELF,
      demographics: { ethnicity: "declined", race: "declined", sex: "declined" },
    });
    for (const kind of ["verification_authorization", "econsent"]) {
      const consent = await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: h.borrowerId,
      });
      expect(consent.status, kind).toBe(201);
    }

    const signed = await callAs<{ signedBy: string; signed: string[] }>(
      h.theo.id,
      [applicationRouter],
      "POST",
      `/${h.fileId}/sign-application`,
    );

    expect(signed.status).toBe(201);
    expect(signed.body.signedBy).toBe(h.borrowerId);
    expect(signed.body.signed).toEqual(["form_4506c"]);
    const row = await prisma.loanFile.findUniqueOrThrow({
      where: { id: h.fileId },
      select: { applicationSignedAt: true, stage: true },
    });
    expect(row.applicationSignedAt).toBeNull();
    expect(row.stage).not.toBe("DECISION");
    const his = await prisma.consent.findMany({
      where: { loanFileId: h.fileId, borrowerId: h.borrowerId, revokedAt: null },
      select: { kind: true },
      orderBy: { kind: "asc" },
    });
    expect(his.map((c) => c.kind)).toEqual([
      "application_signature",
      "econsent",
      "form_4506c",
      "verification_authorization",
    ]);
    // Once: signing again adds no row.
    await callAs(h.theo.id, [applicationRouter], "POST", `/${h.fileId}/sign-application`);
    expect(
      await prisma.consent.count({
        where: { borrowerId: h.borrowerId, kind: "application_signature" },
      }),
    ).toBe(1);
    // His signature reached the applicant's read as one line of his, and
    // nothing else of his did.
    const hers = await callAs<{ file: { consents: { kind: string; borrowerId: string }[] } }>(
      h.user.id,
      [fileRouter],
      "GET",
      `/${h.fileId}`,
    );
    expect(
      hers.body.file.consents.some(
        (c) => c.kind === "application_signature" && c.borrowerId === h.borrowerId,
      ),
    ).toBe(true);
  });

  it("is told it is not the owner, and may not decide or invite", async () => {
    const h = await claimed();
    const res = await callAs<{ owner: boolean }>(h.theo.id, [fileRouter], "GET", `/${h.fileId}`);
    expect(res.body.owner).toBe(false);
    const hers = await callAs<{ owner: boolean }>(h.user.id, [fileRouter], "GET", `/${h.fileId}`);
    expect(hers.body.owner).toBe(true);
    expect(
      (await callAs(h.theo.id, [decisionRouter], "POST", `/${h.fileId}/decision`)).status,
    ).toBe(404);
    expect(
      (
        await callAs(
          h.theo.id,
          [fileRouter],
          "POST",
          `/${h.fileId}/co-borrowers/${h.borrowerId}/invitations`,
        )
      ).status,
    ).toBe(404);
  });

  it("links a bank of their own, beside the applicant's, and reads back only theirs", async () => {
    // Two `bank` links on one file, one per person. The file's own report
    // stays the applicant's — it is what the screens read; the engine reads
    // both, through `reports` — and a co-borrower's read carries theirs in
    // its place.
    const h = await claimed();
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, THEO_HIMSELF);
    for (const kind of ["verification_authorization", "econsent"]) {
      await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: h.borrowerId,
      });
    }
    const dana = (await loadLoanFile(h.fileId))!.borrowers[0]!;
    for (const kind of ["verification_authorization", "econsent"]) {
      await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: dana.id,
      });
    }

    const hers = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(hers.status, JSON.stringify(hers.body)).toBe(201);
    const his = await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(his.status, JSON.stringify(his.body)).toBe(201);

    const links = await prisma.connectorLink.findMany({
      where: { loanFileId: h.fileId, kind: "bank" },
      select: { partyId: true },
    });
    expect(new Set(links.map((l) => l.partyId))).toEqual(
      new Set([
        dana.partyId,
        (await prisma.borrower.findUniqueOrThrow({ where: { id: h.borrowerId } })).partyId,
      ]),
    );

    // The file's report is the applicant's, whoever pulled last.
    const file = (await loadLoanFile(h.fileId))!;
    const snapshots = await prisma.connectorSnapshot.findMany({
      where: { loanFileId: h.fileId, kind: "bank" },
      select: { partyId: true, externalId: true },
    });
    const herSnapshot = snapshots.find((s) => s.partyId === dana.partyId)!;
    expect(file.assets).not.toBeNull();
    expect(file.links.filter((l) => l.kind === "bank").map((l) => l.partyId)).toContain(
      dana.partyId,
    );
    expect(snapshots).toHaveLength(2);
    expect(herSnapshot).toBeDefined();

    // And his read carries his, not hers.
    const theirs = await callAs<{
      file: { assets: unknown; links: { kind: string; partyId: string }[] };
    }>(h.theo.id, [fileRouter], "GET", `/${h.fileId}`);
    expect(theirs.body.file.assets).not.toBeNull();
    expect(theirs.body.file.links.map((l) => l.partyId)).toEqual(
      theirs.body.file.links.map(() => links.find((l) => l.partyId !== dana.partyId)!.partyId),
    );
  });

  /*
   * The engine reads everybody. Two people's application carries two credit
   * reports and two asset reports, and the loan's numbers are computed from
   * both: the score is blocked until his report is in, and names him; the
   * reserves count both banks. And each person's read of the file carries
   * their own reports and nobody else's — the applicant's read of a
   * co-borrower's tradelines is the co-borrower's whole financial life, under
   * a screen that promised it stays theirs.
   */
  async function authorized() {
    const h = await claimed();
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, THEO_HIMSELF);
    const dana = (await loadLoanFile(h.fileId))!.borrowers[0]!;
    for (const kind of ["verification_authorization", "econsent"]) {
      await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: h.borrowerId,
      });
      await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: dana.id,
      });
    }
    const theoParty = (await prisma.borrower.findUniqueOrThrow({ where: { id: h.borrowerId } }))
      .partyId;
    return { ...h, dana, theoParty };
  }
  const decide = async (fileId: string) =>
    underwrite((await loadLoanFile(fileId))!, {
      aporTable: APOR_TABLE,
      casefileId: "household-test",
      now: new Date().toISOString(),
    });

  it("carries each person's reports by party, and hands each reader only their own", async () => {
    const h = await authorized();
    expect(
      (await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {})).status,
    ).toBe(201);
    expect(
      (await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {})).status,
    ).toBe(201);

    const file = (await loadLoanFile(h.fileId))!;
    expect(file.reports?.map((r) => [r.partyId, r.assets !== null])).toEqual([
      [h.dana.partyId, true],
      [h.theoParty, true],
    ]);
    // The file-level report is still hers, by party, for the screens.
    expect(file.assets?.reportId).toBe(file.reports![0]!.assets?.reportId);

    const hers = await callAs<{ file: { reports: { partyId: string }[] } }>(
      h.user.id,
      [fileRouter],
      "GET",
      `/${h.fileId}`,
    );
    expect(hers.body.file.reports.map((r) => r.partyId)).toEqual([h.dana.partyId]);
    const his = await callAs<{ file: { reports: { partyId: string }[] } }>(
      h.theo.id,
      [fileRouter],
      "GET",
      `/${h.fileId}`,
    );
    expect(his.body.file.reports.map((r) => r.partyId)).toEqual([h.theoParty]);

    // And the engine counts both banks, which no reader can see together.
    const reserves = decide(h.fileId).then((d) =>
      d.derivations.find((x) => x.label === "Eligible post-close assets"),
    );
    expect((await reserves)?.inputs).toMatchObject({ borrowers_with_assets: 2 });
  });

  it("blocks the loan's score until his credit is in, and names him", async () => {
    const h = await authorized();
    expect(
      (await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/credit`, {})).status,
    ).toBe(201);

    const before = await decide(h.fileId);
    const blocked = before.derivations.find((d) => d.label === "Representative FICO");
    expect(blocked?.blockedBy).toEqual(["credit report for Theo Okafor"]);
    expect(before.aus?.recommendation).toBe("refer");
    // The outstanding list says the same thing, in the same name.
    const crd001 = outstanding((await loadLoanFile(h.fileId))!).find(
      (i) => i.requirement.id === "CRD-001",
    );
    expect(crd001?.satisfaction).toMatchObject({
      status: "unsatisfied",
      missing: expect.stringContaining("Theo Okafor: credit has not been pulled"),
    });

    expect(
      (await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/credit`, {})).status,
    ).toBe(201);
    const after = await decide(h.fileId);
    const labels = after.derivations.map((d) => d.label);
    expect(labels).toContain("Representative FICO (Dana Whitfield)");
    expect(labels).toContain("Representative FICO (Theo Okafor)");
    expect(labels).toContain("Average median credit score");
    const liabilities = after.derivations.find((d) => d.label === "Monthly liabilities");
    expect(liabilities?.blockedBy).toBeUndefined();
    expect(liabilities?.inputs).toMatchObject({ borrowers_with_credit: 2 });
    // Two pulls of one fixture return one person's tradelines twice; the
    // household counts each once.
    expect(liabilities?.inputs.joint_tradelines_deduplicated).toBeGreaterThan(0);
  });

  it("sees the household on their own home page", async () => {
    const h = await claimed();
    const res = await callAs<{ files: { id: string }[] }>(h.theo.id, [fileRouter], "GET", "/");
    expect(res.body.files.some((f) => f.id === h.fileId)).toBe(true);
  });

  it("cannot delete their account while on somebody else's application", async () => {
    const h = await claimed();
    const res = await callAs(h.theo.id, [authRouter], "DELETE", "/me", undefined, "/api/auth");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "ON_ANOTHER_APPLICATION" } });
    expect(await prisma.user.count({ where: { id: h.theo.id } })).toBe(1);
  });

  it("is shown to the applicant as a name and a status, never as answers", async () => {
    const h = await claimed();
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, THEO_HIMSELF);
    await callAs(h.theo.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      declaration: { ...SECTION_FIVE, bankruptcy: true, bankruptcyChapters: ["ChapterSeven"] },
      residences: [OWNING],
      propertyEstateType: "FeeSimple",
    });
    type Seen = { file: { borrowers: Record<string, unknown>[] } };
    const hers = await callAs<Seen>(h.user.id, [fileRouter], "GET", `/${h.fileId}`);
    const theo = hers.body.file.borrowers.find((b) => b.id === h.borrowerId)!;
    expect(theo.firstName).toBe("Theo");
    expect(theo.declared).toBe(true);
    expect(theo.declaration).toBeNull();
    expect(theo.dateOfBirth).toBe("");
    expect(theo.ssn).toEqual({ last4: "", vaultHandle: "" });
    expect(JSON.stringify(hers.body)).not.toContain("8765");
    expect(JSON.stringify(hers.body)).not.toContain("1984-02-19");
  });

  it("signs their own part while a third person is still pending, and moves nothing of the applicant's", async () => {
    const h = await claimed();
    await callAs(h.user.id, [fileRouter], "POST", `/${h.fileId}/co-borrowers`, {
      firstName: "Marisol",
      lastName: "Vega",
      email: "marisol@example.test",
      occupiesProperty: true,
    });
    await callAs(h.theo.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, {
      ...THEO_HIMSELF,
      demographics: { ethnicity: "declined", race: "declined", sex: "declined" },
    });
    for (const kind of ["verification_authorization", "econsent"]) {
      await callAs(h.theo.id, [connectorRouter], "POST", `/${h.fileId}/consents`, {
        kind,
        borrowerId: h.borrowerId,
      });
    }
    const before = await prisma.loanFile.findUniqueOrThrow({
      where: { id: h.fileId },
      select: { stage: true },
    });
    const signed = await callAs(
      h.theo.id,
      [applicationRouter],
      "POST",
      `/${h.fileId}/sign-application`,
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    const after = await prisma.loanFile.findUniqueOrThrow({
      where: { id: h.fileId },
      select: { stage: true, applicationSignedAt: true },
    });
    expect(after.stage).toBe(before.stage);
    expect(after.applicationSignedAt).toBeNull();
  });

  it("does not let the applicant's screen 2 land on the co-borrower", async () => {
    // The applicant revisiting screen 2 after the claim still edits her own
    // row. Resolved by party, so the newest row on the file is not "hers".
    const h = await claimed();
    const revisit = await callAs(h.user.id, [fileRouter], "POST", `/${h.fileId}/borrowers`, {
      ...DANA,
      phone: "5555550199",
    });
    expect(revisit.status).toBe(201);
    const file = (await loadLoanFile(h.fileId))!;
    expect(file.borrowers[0]!.phone).toBe("5555550199");
    expect(file.invitedBorrowers[0]).toMatchObject({ id: h.borrowerId, status: "claimed" });
  });
});
