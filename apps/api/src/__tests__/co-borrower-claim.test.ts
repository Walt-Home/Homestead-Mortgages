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
import type { FixtureMailConnector } from "@hm/connectors";
import { authRouter } from "../routes/auth.js";
import { fileRouter } from "../routes/files.js";
import { connectors } from "../services/connectors.js";
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
  const match = /\/claim\/([A-Za-z0-9_-]+)/.exec(last?.text ?? "");
  if (!match) throw new Error("no claim link in the last email");
  return match[1]!;
}

function accept(userId: string, token: string) {
  return callAs<{ loanFileId: string; borrowerId: string }>(
    userId,
    [authRouter],
    "POST",
    `/claims/${token}/accept`,
    {},
    "/api/auth",
  );
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
    expect(res.body.link).toBe(`http://localhost:5173/claim/${tokenInTheEmail()}`);
  });

  it("re-sending kills the last link", async () => {
    const h = await namedHousehold();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const first = tokenInTheEmail();
    await invite(h.user.id, h.fileId, h.borrowerId);
    const second = tokenInTheEmail();
    expect(second).not.toBe(first);

    const dead = await callAs(
      h.user.id,
      [authRouter],
      "GET",
      `/claims/${first}`,
      undefined,
      "/api/auth",
    );
    expect(dead.status).toBe(404);
    const live = await callAs(
      h.user.id,
      [authRouter],
      "GET",
      `/claims/${second}`,
      undefined,
      "/api/auth",
    );
    expect(live.status).toBe(200);
    expect(await prisma.coBorrowerInvitation.count({ where: { borrowerId: h.borrowerId } })).toBe(
      2,
    );
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

    const res = await callAs(
      stranger.id,
      [authRouter],
      "GET",
      `/claims/${token}`,
      undefined,
      "/api/auth",
    );

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
    const look = (t: string) =>
      callAs(stranger.id, [authRouter], "GET", `/claims/${t}`, undefined, "/api/auth");

    expect((await look("a".repeat(43))).status).toBe(404);
    // Eight days ago, so the deadline is in the past and still after the
    // making — the CHECK holds even for a row a test ages by hand.
    await prisma.coBorrowerInvitation.updateMany({
      where: { borrowerId: h.borrowerId },
      data: {
        createdAt: new Date(Date.now() - 8 * 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect((await look(token)).status).toBe(404);
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
