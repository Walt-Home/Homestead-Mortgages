/**
 * Who signs, and what one signature does not authorize.
 *
 * IRS Form 4506-C names a single taxpayer. So each borrower signs their own,
 * and the boundary around a tax-transcript pull is the same boundary the
 * verification authorization already keeps around credit: one person's
 * signature, one person's records. The alternative — a counter-signature, or
 * the applicant's signature covering the household — would have meant a
 * co-borrower who never finished having their tax records pulled on their
 * partner's signature, and there is no form that says that.
 *
 * Against a real Postgres, because both halves of "already signed" are in the
 * database: the consent row is one table and the grant a trigger mirrors it to
 * is another, and a mock proves neither.
 *
 * The end state this holds is honest rather than finished. A co-borrower is
 * appended by the applicant and has never signed in, so there is no surface on
 * which they can sign today; what these assert is that nothing of theirs is
 * retrieved until they do, not that they have a way to. Their signatures below
 * are written the only way one can exist right now — a row, the way the seed
 * writes one — and the routes refuse to take one on their behalf.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { AuthorizationError } from "@hm/connectors";
import { applicationRouter } from "../routes/application.js";
import { connectorRouter } from "../routes/connectors.js";
import { esignRouter } from "../routes/esign.js";
import { fileRouter } from "../routes/files.js";
import { tokenFor } from "../services/authorization.js";
import { loadLoanFile } from "../services/repository.js";
import { REQUIREMENTS, evaluateSatisfaction } from "@hm/requirements";
import { signedOn } from "../services/signature.js";
import { assertFacts, principalForParty, type BorrowerInput } from "../services/party.js";
import { createDraftApplication, ensureApplicationParty } from "../services/applications.js";
import { pinTridPieces } from "../services/evidence.js";
import {
  consent,
  createLoanFile,
  createParty,
  createUser,
  saveBorrower,
} from "./support/factories.js";
import { callAs } from "./support/http.js";
import { connectors } from "../services/connectors.js";

const ROUTES = [fileRouter, connectorRouter, applicationRouter, esignRouter];

const priya: BorrowerInput = {
  firstName: "Priya",
  lastName: "Raman",
  email: "priya@example.test",
  phone: "5555550111",
  dateOfBirth: "1990-03-02",
  ssnVaultHandle: "vault:priya:1",
  currentAddress: { line1: "12 Curtner Ave", city: "San Jose", state: "CA", postalCode: "95125" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 3400,
  statedMonthlyIncome: 9200,
};

interface Household {
  readonly userId: string;
  readonly fileId: string;
  readonly applicationId: string;
  readonly primaryId: string;
  readonly primaryPartyId: string;
  readonly coId: string;
  readonly coPartyId: string;
}

/**
 * A file with two people on it, and an application the applicant is on.
 *
 * The co-borrower's row is created a second later so document order is settled
 * by daylight rather than by a uuid, the same separation the persona seed
 * insists on.
 *
 * `coOnApplication` is which of two real states the second person is in.
 * `appendCoBorrowerWithFacts` appends them to the file AND puts them on the
 * credit request in one transaction, which is the default here. Being on the
 * file without being on the request is the other, and `borrowerOrdinals` says
 * so in its own words — it is the state a borrower is in before anything has
 * given them a position, and the first thing they sign is what does.
 */
async function household({
  coOnApplication = true,
}: { coOnApplication?: boolean } = {}): Promise<Household> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const primary = await saveBorrower(file.id, priya);
  const primaryRow = await prisma.borrower.findUniqueOrThrow({
    where: { id: primary.id },
    select: { createdAt: true, partyId: true },
  });

  const party = await createParty({ claimStatus: "CLAIMED" });
  await prisma.$transaction(async (tx) =>
    assertFacts(tx, party.id, await principalForParty(tx, party.id), [
      { predicate: "legal_name", value: { first: "Dev", last: "Raman" } },
      { predicate: "date_of_birth", value: "1989-07-19" },
      { predicate: "email", value: "dev@example.test" },
      { predicate: "phone", value: "5555550112" },
      { predicate: "current_address", value: { ...priya.currentAddress } },
      { predicate: "marital_status", value: "unmarried" },
      { predicate: "citizenship", value: "us_citizen" },
      { predicate: "preferred_language", value: "en" },
      { predicate: "is_military", value: false },
      { predicate: "ssn_token", value: "vault:dev:1" },
      { predicate: "monthly_income", value: 7100 },
    ]),
  );
  const co = await prisma.borrower.create({
    data: {
      loanFileId: file.id,
      partyId: party.id,
      ssnLast4: "7788",
      createdAt: new Date(primaryRow.createdAt.getTime() + 1_000),
    },
    select: { id: true },
  });

  const { applicationId } = await prisma.$transaction(async (tx) =>
    createDraftApplication(tx, {
      loanFileId: file.id,
      partyId: primaryRow.partyId,
      terms: {
        objective: "PURCHASE",
        occupancy: "PRIMARY_RESIDENCE",
        loanAmountCents: 40_000_000n,
        termMonths: 360,
        propertyAddress: "42 Oak Street, Demo City CA 94000",
        valueEstimateCents: 52_000_000n,
      },
    }),
  );
  if (coOnApplication) {
    await prisma.$transaction(async (tx) =>
      ensureApplicationParty(tx, applicationId, party.id, "CO_BORROWER"),
    );
  }

  return {
    userId: user.id,
    fileId: file.id,
    applicationId,
    primaryId: primary.id,
    primaryPartyId: primaryRow.partyId,
    coId: co.id,
    coPartyId: party.id,
  };
}

/**
 * The same two people, with the applicant dropped and replaced at position 1.
 *
 * Priya asks and owns the file. Her membership is deleted, the ordinal is
 * freed, and Dev — whose borrower row is the NEWER of the two — takes it. So
 * the document says Dev is Borrower 1 and the session belongs to Priya, and
 * they are not the same person. It is the only shape in which "the person
 * signed in" and `borrowers[0]` can be told apart.
 */
async function replacedApplicant(): Promise<Household> {
  const h = await household({ coOnApplication: false });
  await prisma.applicationParty.delete({
    where: {
      applicationId_partyId: { applicationId: h.applicationId, partyId: h.primaryPartyId },
    },
  });
  const filled = await prisma.$transaction(async (tx) =>
    ensureApplicationParty(tx, h.applicationId, h.coPartyId, "PRIMARY_BORROWER"),
  );
  expect(filled.borrowerOrdinal).toBe(1);
  return h;
}

/**
 * Start an envelope and complete it, which is what a signing screen does.
 *
 * It does not say who: the signer is the person signed in, and there is no
 * parameter for anybody else.
 */
async function sign(userId: string, fileId: string, kind: string) {
  const started = await callAs<{ envelopeId: string; alreadySigned: boolean; borrowerId: string }>(
    userId,
    ROUTES,
    "POST",
    `/${fileId}/esign`,
    { kind },
  );
  if (started.body.alreadySigned) return started;
  return callAs<{ kind: string; borrowerId: string; alreadySigned: boolean }>(
    userId,
    ROUTES,
    "POST",
    `/${fileId}/esign/complete`,
    { envelopeId: started.body.envelopeId },
  );
}

describe("a signature is one person's", () => {
  it("signs as the person signed in, and offers no way to say otherwise", async () => {
    const h = await household();
    const started = await callAs<{ borrowerId: string }>(
      h.userId,
      ROUTES,
      "POST",
      `/${h.fileId}/esign`,
      // The applicant owns this file and holds the only session on it, so a
      // request naming the co-borrower is the forgery this route must not be
      // able to commit. The field is not in the schema; zod drops it, and the
      // signer is still the person who sent the request.
      { kind: "form_4506c", borrowerId: h.coId },
    );
    expect(started.status).toBe(201);
    expect(started.body.borrowerId).toBe(h.primaryId);
  });

  it("refuses to complete an envelope minted for somebody else", async () => {
    // The fixture's envelope ids are guessable by construction — the adapter
    // says so — so the completion is a second door to the same room. Without
    // the check the applicant puts their press of a button on the
    // co-borrower's Form 4506-C, which is a federal tax authorization executed
    // by somebody who is not the taxpayer.
    const h = await household();
    const envelope = await connectors().esign.createEnvelope(
      (await loadLoanFile(h.fileId))!,
      "form_4506c",
      h.coId,
    );
    const completed = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/esign/complete`, {
      envelopeId: envelope.envelopeId,
    });
    expect(completed.status).toBe(403);
    expect(
      await prisma.consent.count({ where: { loanFileId: h.fileId, borrowerId: h.coId } }),
    ).toBe(0);
  });

  it("refuses to record a consent in the co-borrower's name", async () => {
    // The same act through the other door. Screen 2 posts this route for the
    // person filling it in; nothing posts it for anybody else, and the refusal
    // is what keeps that true.
    const h = await household();
    const refused = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/consents`, {
      kind: "verification_authorization",
      borrowerId: h.coId,
    });
    expect(refused.status).toBe(403);

    // And the applicant's own goes through, so the refusal is about whose it
    // is rather than about the route being shut.
    const mine = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/consents`, {
      kind: "verification_authorization",
      borrowerId: h.primaryId,
    });
    expect(mine.status).toBe(201);
  });

  it("signs as the person signed in even when they are not Borrower 1", async () => {
    // Priya owns the file and Dev has taken the freed ordinal 1, so document
    // order and the session name different people. `borrowers[0]` would take
    // her press of the button and file it under his name — the same shape as
    // the four writers that resolved a borrower by creation order, with the
    // position doing the misnaming instead.
    const h = await replacedApplicant();
    const signed = await sign(h.userId, h.fileId, "form_4506c");
    expect(signed.status).toBe(201);

    const rows = await prisma.consent.findMany({
      where: { loanFileId: h.fileId, kind: "form_4506c" },
      select: { borrowerId: true },
    });
    expect(rows.map((r) => r.borrowerId)).toEqual([h.primaryId]);
  });

  it("does not complete the applicant's authorization when the co-borrower signs", async () => {
    // The whole question, from the side that matters most: the co-borrower's
    // signature must not stand in for the applicant's. Judged from the
    // authorization rather than from the consent row, because the grant is
    // what a pull is minted from.
    const h = await household();
    await consent(h.fileId, h.coId, "verification_authorization");

    expect(await signedOn(h.fileId, h.coPartyId, "verification_authorization")).not.toBeNull();
    expect(await signedOn(h.fileId, h.primaryPartyId, "verification_authorization")).toBeNull();

    const file = (await loadLoanFile(h.fileId))!;
    await expect(tokenFor(file, file.borrowers[0]!, "credit_report")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect((await tokenFor(file, file.borrowers[1]!, "credit_report")).partyId).toBe(h.coPartyId);
  });

  it("does not complete the co-borrower's authorization when the applicant signs", async () => {
    const h = await household();
    await sign(h.userId, h.fileId, "verification_authorization");

    expect(await signedOn(h.fileId, h.primaryPartyId, "verification_authorization")).not.toBeNull();
    expect(await signedOn(h.fileId, h.coPartyId, "verification_authorization")).toBeNull();

    const file = (await loadLoanFile(h.fileId))!;
    await expect(tokenFor(file, file.borrowers[1]!, "credit_report")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("still asks the applicant to sign when only the co-borrower has", async () => {
    // The shape that makes "already signed" a question about a person rather
    // than about a file. Priya holds a live grant from a file she signed last
    // month, and on THIS file only Dev has signed. Asking whether the file
    // holds a row of the kind finds his, finds her grant beside it, and tells
    // her she has already signed here — so no row of hers is ever written, the
    // engine goes on reporting APP-005 outstanding, and the one control that
    // would fix it reports success every time it is pressed.
    const h = await household();
    const earlier = await createLoanFile({ userId: h.userId });
    const hers = await prisma.borrower.create({
      data: { loanFileId: earlier.id, partyId: h.primaryPartyId, ssnLast4: "0000" },
      select: { id: true },
    });
    await consent(earlier.id, hers.id, "verification_authorization");
    await consent(h.fileId, h.coId, "verification_authorization");

    const started = await callAs<{ alreadySigned: boolean; borrowerId: string }>(
      h.userId,
      ROUTES,
      "POST",
      `/${h.fileId}/esign`,
      { kind: "verification_authorization" },
    );
    expect(started.status).toBe(201);
    expect(started.body.alreadySigned).toBe(false);
    expect(started.body.borrowerId).toBe(h.primaryId);
  });

  it("writes one consent row per signer, never one for the file", async () => {
    const h = await household();
    await consent(h.fileId, h.coId, "form_4506c");
    await sign(h.userId, h.fileId, "form_4506c");

    const rows = await prisma.consent.findMany({
      where: { loanFileId: h.fileId, kind: "form_4506c" },
      select: { borrowerId: true },
    });
    expect(rows.map((r) => r.borrowerId).sort()).toEqual([h.primaryId, h.coId].sort());
  });

  it("puts a signer who is not Borrower 1 on the application as a co-borrower", async () => {
    // Priya owns the file and Dev holds ordinal 1, so the person signing is not
    // the applicant the document names. `ensureApplicationParty` was called
    // with PRIMARY_BORROWER outright here, and the ordinal allocator does not
    // refuse a second primary — it hands them the next free position, because
    // the index that says there is one Borrower 1 is over the position and not
    // over the role. The receipt then counts the party-side pieces of ANY
    // primary, so this is the difference between a second borrower and a second
    // applicant whose three pieces can open the Loan Estimate clock.
    const h = await replacedApplicant();
    await sign(h.userId, h.fileId, "verification_authorization");

    const parties = await prisma.applicationParty.findMany({
      where: { applicationId: h.applicationId },
      select: { partyId: true, role: true, borrowerOrdinal: true },
    });
    const her = parties.find((p) => p.partyId === h.primaryPartyId);
    expect(her?.role).toBe("CO_BORROWER");
    expect(her?.borrowerOrdinal).toBe(2);
    expect(parties.filter((p) => p.role === "PRIMARY_BORROWER")).toHaveLength(1);
  });
});

describe("a transcript pull is one taxpayer's", () => {
  it("refuses the co-borrower's transcripts on the applicant's signature", async () => {
    const h = await household();
    await consent(h.fileId, h.primaryId, "verification_authorization");
    await consent(h.fileId, h.primaryId, "form_4506c");

    const mine = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, {
      borrowerId: h.primaryId,
    });
    expect(mine.status).toBe(201);

    const theirs = await callAs<{ error?: { requirementId?: string } }>(
      h.userId,
      ROUTES,
      "POST",
      `/${h.fileId}/irs`,
      { borrowerId: h.coId },
    );
    expect(theirs.status).toBe(403);
  });

  it("refuses the applicant's transcripts on the co-borrower's signature", async () => {
    // The other direction, which is the one a subscript would have got wrong:
    // only Dev has signed, and a pull that reached for the file rather than
    // the person would have pulled Priya's transcripts under his 4506-C.
    const h = await household();
    await consent(h.fileId, h.coId, "verification_authorization");
    await consent(h.fileId, h.coId, "form_4506c");

    const mine = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, {
      borrowerId: h.primaryId,
    });
    expect(mine.status).toBe(403);

    const theirs = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, {
      borrowerId: h.coId,
    });
    expect(theirs.status).toBe(201);
  });

  it("records the snapshot against the person whose token it was pulled on", async () => {
    const h = await household();
    await consent(h.fileId, h.coId, "verification_authorization");
    await consent(h.fileId, h.coId, "form_4506c");
    await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, { borrowerId: h.coId });

    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "irs" },
      select: { partyId: true },
    });
    expect(snapshot.partyId).toBe(h.coPartyId);
  });

  it("signs the applicant's 4506-C and pulls nothing of the co-borrower's", async () => {
    // Screen 5. One signature, one taxpayer: the applicant's transcripts
    // arrive and the co-borrower is named as still owing a signature rather
    // than left to be inferred from a response that only says what was done.
    const h = await household();
    await consent(h.fileId, h.primaryId, "verification_authorization");
    await prisma.borrower.update({
      where: { id: h.primaryId },
      data: { demographics: { ethnicity: ["declined"], race: ["declined"], sex: "declined" } },
    });

    const signed = await callAs<{ signedBy: string; transcripts: unknown }>(
      h.userId,
      ROUTES,
      "POST",
      `/${h.fileId}/sign-application`,
      {},
    );
    expect(signed.status).toBe(201);
    expect(signed.body.signedBy).toBe(h.primaryId);
    expect(signed.body.transcripts).not.toBeNull();

    // And the co-borrower is named as still owing one, on the receipt the
    // screens read rather than in a response body nothing keeps. The pin is
    // what stamps a receipt to read: her consent was written as a row here
    // rather than through the route that pins her three pieces.
    await prisma.$transaction(async (tx) =>
      pinTridPieces(tx, { applicationId: h.applicationId, partyId: h.primaryPartyId }),
    );
    const receipt = (await loadLoanFile(h.fileId))!.application!;
    const him = receipt.signers.find((x) => x.borrowerId === h.coId)!;
    expect(him.name).toBe("Dev Raman");
    expect(him.taxRecordsAt).toBeNull();

    // And the file holds one 4506-C, the applicant's.
    const rows = await prisma.consent.findMany({
      where: { loanFileId: h.fileId, kind: "form_4506c" },
      select: { borrowerId: true },
    });
    expect(rows.map((r) => r.borrowerId)).toEqual([h.primaryId]);

    // Every transcript snapshot on the file is about the person who signed.
    const snapshots = await prisma.connectorSnapshot.findMany({
      where: { loanFileId: h.fileId, kind: "irs" },
      select: { partyId: true },
    });
    expect(snapshots).not.toHaveLength(0);
    for (const s of snapshots) expect(s.partyId).toBe(h.primaryPartyId);
  });
});

describe("the engine", () => {
  it("leaves INC-008 outstanding while one borrower has not signed their 4506-C", async () => {
    // The requirement follows the retrieval. It read a file-level `some()` for
    // as long as the transcripts were pulled under the first borrower's token
    // and nobody else's — so on a joint file it said "4506-C executed" while
    // the second person's tax records were not requestable at all, and nothing
    // on the outstanding list ever asked them to sign.
    const h = await household();
    await consent(h.fileId, h.primaryId, "form_4506c");

    const requirement = REQUIREMENTS.find((r) => r.id === "INC-008")!;
    const file = (await loadLoanFile(h.fileId))!;
    const outstanding = evaluateSatisfaction(requirement, file);
    expect(outstanding.status).toBe("unsatisfied");
    expect(outstanding.status === "unsatisfied" && outstanding.missing).toContain("Dev Raman");

    await consent(h.fileId, h.coId, "form_4506c");
    expect(evaluateSatisfaction(requirement, (await loadLoanFile(h.fileId))!).status).toBe(
      "satisfied",
    );
  });
});

describe("the receipt", () => {
  /** Pin one person's three pieces, which is what their own consent licenses. */
  async function pinFor(applicationId: string, partyId: string) {
    await prisma.$transaction(async (tx) => pinTridPieces(tx, { applicationId, partyId }));
  }

  it("counts the six pieces per borrower, and a second borrower's do not stamp it", async () => {
    // Priya owns the file, Dev holds ordinal 1, and Priya is the only one who
    // can sign. Her signature puts her on the request and pins her three in the
    // same transaction — so if she went on as a second applicant, this file
    // would be received, with a TRID clock running, on the pieces of somebody
    // the document does not call the applicant.
    const h = await replacedApplicant();
    await sign(h.userId, h.fileId, "verification_authorization");

    const hers = await prisma.applicationEvidenceLink.count({
      where: {
        applicationId: h.applicationId,
        releasedAt: null,
        fact: { partyId: h.primaryPartyId },
      },
    });
    expect(hers, "her own three pieces are pinned").toBe(3);

    const draft = await prisma.application.findUniqueOrThrow({ where: { id: h.applicationId } });
    expect(draft.status).toBe("DRAFT");
    expect(await prisma.regulatoryClock.count({ where: { applicationId: h.applicationId } })).toBe(
      0,
    );

    // Borrower 1's own three are what receive it, and the clock opens there.
    // His signature cannot be taken through any route — he has never signed in
    // — so it is written the way the seed writes one.
    await consent(h.fileId, h.coId, "verification_authorization");
    await pinFor(h.applicationId, h.coPartyId);
    const intake = await prisma.applicationTransition.findFirst({
      where: { applicationId: h.applicationId, event: "intake_completed" },
      select: { reasonCode: true },
    });
    expect(intake?.reasonCode).toBe("six_pieces_received");
    expect(
      await prisma.regulatoryClock.count({
        where: { applicationId: h.applicationId, kind: "TRID_LE_DELIVERY" },
      }),
    ).toBe(1);
  });

  it("names each signer, with their own pieces and their own signatures", async () => {
    const h = await household();
    // He has stated no income, so the two of them hold DIFFERENT sets and the
    // receipt has to keep them apart. Merged, his three read complete off her
    // pins — which is the same arithmetic that made a co-borrower's SSN beside
    // the applicant's name and income into somebody's application.
    await prisma.fact.updateMany({
      where: { partyId: h.coPartyId, predicate: "monthly_income" },
      data: { retractedAt: new Date() },
    });

    await consent(h.fileId, h.primaryId, "verification_authorization");
    await consent(h.fileId, h.primaryId, "form_4506c");
    await pinFor(h.applicationId, h.primaryPartyId);
    await consent(h.fileId, h.coId, "verification_authorization");
    await pinFor(h.applicationId, h.coPartyId);

    const receipt = (await loadLoanFile(h.fileId))!.application!;
    expect(receipt.signers.map((s) => s.name)).toEqual(["Priya Raman", "Dev Raman"]);
    expect(receipt.signers.map((s) => s.ordinal)).toEqual([1, 2]);

    const [her, him] = receipt.signers;
    expect(her!.pieces).toEqual({ name: true, income: true, ssn: true });
    expect(her!.authorizedAt).not.toBeNull();
    expect(her!.taxRecordsAt).not.toBeNull();

    // His are his own: no income stated, and no 4506-C signed — which is why
    // nothing of his has been requested.
    expect(him!.pieces).toEqual({ name: true, income: false, ssn: true });
    expect(him!.authorizedAt).not.toBeNull();
    expect(him!.taxRecordsAt).toBeNull();
  });

  it("gives a co-borrower who has signed nothing no pieces and no signatures", async () => {
    const h = await household();
    await consent(h.fileId, h.primaryId, "verification_authorization");
    await pinFor(h.applicationId, h.primaryPartyId);

    const receipt = (await loadLoanFile(h.fileId))!.application!;
    const him = receipt.signers.find((s) => s.borrowerId === h.coId)!;
    expect(him.pieces).toEqual({ name: false, income: false, ssn: false });
    expect(him.authorizedAt).toBeNull();
    expect(him.taxRecordsAt).toBeNull();
  });
});

describe("a signature made on another application authorizes nothing here", () => {
  it("refuses a named co-borrower's transcripts on a 4506-C signed elsewhere", async () => {
    // The applicant holds the only session on a joint file, and the transcript
    // route takes a borrower id. The grant a consent mirrors to carries no
    // loan file and lives 120 days, so read by party alone it is one person's
    // permission everywhere: Dev signs a 4506-C on an application of his own,
    // and Priya pulls his federal tax records onto hers.
    const h = await household();
    const elsewhere = await createLoanFile({ userId: h.userId });
    const hisRowThere = await prisma.borrower.create({
      data: { loanFileId: elsewhere.id, partyId: h.coPartyId, ssnLast4: "7788" },
      select: { id: true },
    });
    await consent(elsewhere.id, hisRowThere.id, "form_4506c");

    // The grant is live, and it is his.
    expect(
      await prisma.authorization.count({
        where: { partyId: h.coPartyId, purpose: "IRS_4506C", revokedAt: null },
      }),
    ).toBe(1);
    // On THIS file he has signed nothing.
    expect(
      await prisma.consent.count({ where: { loanFileId: h.fileId, borrowerId: h.coId } }),
    ).toBe(0);

    const pulled = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, {
      borrowerId: h.coId,
    });
    expect(pulled.status).toBe(403);
    expect(
      await prisma.connectorSnapshot.count({ where: { loanFileId: h.fileId, kind: "irs" } }),
    ).toBe(0);
  });

  it("refuses a borrower's own transcripts on a file they have not signed", async () => {
    // The same hole with nobody else in it: one person, two of her own files.
    // The engine reads this file's rows, so it says INC-008 is outstanding —
    // and the route read the party's grants, so it answered 201. A requirement
    // and a guard disagreeing out loud about one file is the shape this is.
    const h = await household();
    const other = await createLoanFile({ userId: h.userId });
    const hers = await prisma.borrower.create({
      data: { loanFileId: other.id, partyId: h.primaryPartyId, ssnLast4: "0001" },
      select: { id: true },
    });
    await consent(other.id, hers.id, "form_4506c");

    const requirement = REQUIREMENTS.find((r) => r.id === "INC-008")!;
    expect(evaluateSatisfaction(requirement, (await loadLoanFile(h.fileId))!).status).toBe(
      "unsatisfied",
    );

    const pulled = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/irs`, {
      borrowerId: h.primaryId,
    });
    expect(pulled.status).toBe(403);
  });

  it("still says how it failed when the signature is here and has lapsed", async () => {
    // Two refusals live in the minter, and collapsing them would be the cheap
    // fix: a borrower whose own grant has expired must be told that rather
    // than told they never signed here, because the screen that renews it is
    // the one that sentence sends them away from.
    const h = await household();
    await consent(h.fileId, h.primaryId, "form_4506c", new Date(Date.now() - 121 * 24 * 3600_000));
    const file = (await loadLoanFile(h.fileId))!;
    await expect(tokenFor(file, file.borrowers[0]!, "tax_transcript")).rejects.toThrow(/expired/);
  });
});

describe("a retrieval is about the person who asked for it", () => {
  it("pulls credit and payroll about the signer, not about Borrower 1", async () => {
    // Priya owns the file and Dev holds ordinal 1. The connector screens post
    // no borrower id at all, so a subject read as `borrowers[0]` made her one
    // press of Connect pull a credit report and a payroll record about HIM —
    // and refused her, whose signature is the only one on this file.
    const h = await replacedApplicant();
    await sign(h.userId, h.fileId, "verification_authorization");

    const credit = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/credit`, {});
    expect(credit.status).toBe(201);
    const payroll = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/payroll`, {});
    expect(payroll.status).toBe(201);
    // The bank route mints its token before any report exists — on a
    // deployment whose aggregator wants the borrower in its own widget, the
    // link session is as far as a test can drive it. Whether that call is
    // refused is already the answer about whose grant was read, and the
    // refusal is pinned from the other side below.
    const bank = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/bank`, {});
    expect(bank.status).not.toBe(403);

    const snapshots = await prisma.connectorSnapshot.findMany({
      where: { loanFileId: h.fileId, kind: { in: ["credit", "payroll"] } },
      select: { kind: true, partyId: true },
    });
    expect(snapshots.map((s) => s.kind).sort()).toEqual(["credit", "payroll"]);
    for (const s of snapshots) expect(s.partyId, s.kind).toBe(h.primaryPartyId);
  });

  it("refuses all three when the person asking has not signed here, whoever has", async () => {
    // The other half, and the one a grant read by party alone got wrong: Dev
    // holds a live verification authorization signed on an application of his
    // own, Priya has signed nothing here, and she is the one pressing the
    // button. Nothing of his may be pulled onto her file on it.
    const h = await replacedApplicant();
    const elsewhere = await createLoanFile({ userId: h.userId });
    const hisRowThere = await prisma.borrower.create({
      data: { loanFileId: elsewhere.id, partyId: h.coPartyId, ssnLast4: "7788" },
      select: { id: true },
    });
    await consent(elsewhere.id, hisRowThere.id, "verification_authorization");

    for (const endpoint of ["credit", "bank", "payroll"]) {
      const refused = await callAs(h.userId, ROUTES, "POST", `/${h.fileId}/${endpoint}`, {});
      expect(refused.status, endpoint).toBe(403);
    }
    expect(await prisma.connectorSnapshot.count({ where: { loanFileId: h.fileId } })).toBe(0);
  });
});

describe("the file tells the screens which borrower is the reader", () => {
  it("names the reader's own row rather than the first one", async () => {
    // The web half of the same rule. `borrowers` is in document order, so a
    // screen reading the first row on a file whose ordinal 1 has been refilled
    // asks about somebody who is not there — which is how the transcript step
    // told the borrower who had signed her 4506-C that we still needed it.
    const h = await replacedApplicant();
    const read = await callAs<{ you: string | null; file: { borrowers: { id: string }[] } }>(
      h.userId,
      ROUTES,
      "GET",
      `/${h.fileId}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.file.borrowers[0]!.id).toBe(h.coId);
    expect(read.body.you).toBe(h.primaryId);
  });

  it("is null for somebody who is not a borrower on the file", async () => {
    // A demo file is readable by everybody and is nobody else's own, and a
    // reader with no row here has signed nothing here.
    const h = await household();
    await prisma.loanFile.update({ where: { id: h.fileId }, data: { isDemo: true } });
    const stranger = await createUser();
    const read = await callAs<{ you: string | null }>(stranger.id, ROUTES, "GET", `/${h.fileId}`);
    expect(read.status).toBe(200);
    expect(read.body.you).toBeNull();
  });
});
