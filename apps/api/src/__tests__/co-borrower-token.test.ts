/**
 * Two people on one file, and two authorizations that never stand in for
 * each other.
 *
 * `seed-personas.ts` states the hazard in the seed's own words: mint this
 * household's purpose token for the co-borrower and it is "somebody else's
 * authorization for Priya's credit". The seed guards its own ordering; this
 * guards the thing the ordering was protecting, so a file whose two rows ever
 * do come back the other way round refuses the pull rather than making it
 * under the wrong name.
 *
 * Against a real Postgres, because the grant a consent produces is written by
 * a trigger and a mock would prove the trigger nothing.
 *
 * Two households, and the second is the one that can fail. With no application
 * on the file the borrowers come back in creation order, which agrees with
 * document order by accident — so a `primaryBorrower` that read either one
 * would pass. `replacedApplicant` makes them disagree.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { AuthorizationError } from "@hm/connectors";
import { primaryBorrower, tokenFor } from "../services/authorization.js";
import { assertFacts, principalForParty, type BorrowerInput } from "../services/party.js";
import { createDraftApplication, ensureApplicationParty } from "../services/applications.js";
import { loadLoanFile } from "../services/repository.js";
import {
  consent,
  createLoanFile,
  createParty,
  createUser,
  saveBorrower,
} from "./support/factories.js";

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

/**
 * A household: the person who asked, and the person who asked with them.
 *
 * The co-borrower's row is created a second later so that document order is
 * settled by daylight rather than by a uuid — the same second of separation
 * the persona seed insists on, and for the same reason.
 */
async function household(): Promise<{ fileId: string; primaryId: string; coId: string }> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const first = await saveBorrower(file.id, priya);
  const firstRow = await prisma.borrower.findUniqueOrThrow({
    where: { id: first.id },
    select: { createdAt: true },
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
    ]),
  );
  const co = await prisma.borrower.create({
    data: {
      loanFileId: file.id,
      partyId: party.id,
      ssnLast4: "7788",
      createdAt: new Date(firstRow.createdAt.getTime() + 1_000),
    },
    select: { id: true },
  });

  return { fileId: file.id, primaryId: first.id, coId: co.id };
}

/**
 * The same two people, with the applicant dropped and replaced at position 1.
 *
 * Priya asks, and is Borrower 1. She withdraws, her membership is deleted, and
 * the ordinal is freed — the schema says a vacancy is refilled and the
 * survivors are never renumbered. Dev, whose borrower row is the NEWER of the
 * two, is put on as the primary and takes the freed 1.
 *
 * So the document says Dev is Borrower 1 and the creation clock says Priya is
 * first, and they are not the same person. That is the only shape in which
 * `loadLoanFile`'s sort and `primaryBorrower` can be told apart.
 */
async function replacedApplicant(): Promise<{
  fileId: string;
  primaryId: string;
  coId: string;
  devPartyId: string;
}> {
  const { fileId, primaryId, coId } = await household();
  const her = await prisma.borrower.findUniqueOrThrow({
    where: { id: primaryId },
    select: { partyId: true },
  });
  const him = await prisma.borrower.findUniqueOrThrow({
    where: { id: coId },
    select: { partyId: true },
  });

  const { applicationId } = await prisma.$transaction(async (tx) =>
    createDraftApplication(tx, {
      loanFileId: fileId,
      partyId: her.partyId,
      terms: {
        objective: "PURCHASE",
        occupancy: "PRIMARY_RESIDENCE",
        loanAmountCents: 40_000_000n,
        termMonths: 360,
      },
    }),
  );
  await prisma.applicationParty.delete({
    where: { applicationId_partyId: { applicationId, partyId: her.partyId } },
  });
  const filled = await prisma.$transaction(async (tx) =>
    ensureApplicationParty(tx, applicationId, him.partyId, "PRIMARY_BORROWER"),
  );
  expect(filled.borrowerOrdinal).toBe(1);

  return { fileId, primaryId, coId, devPartyId: him.partyId };
}

describe("a file with a co-borrower", () => {
  it("mints one token per borrower, each naming its own party", async () => {
    const { fileId, primaryId, coId } = await household();
    await consent(fileId, primaryId, "verification_authorization");
    await consent(fileId, coId, "verification_authorization");

    const file = (await loadLoanFile(fileId))!;
    const [her, him] = file.borrowers;
    const hers = await tokenFor(file, her!, "credit_report");
    const his = await tokenFor(file, him!, "credit_report");

    expect(hers.partyId).toBe(her!.partyId);
    expect(his.partyId).toBe(him!.partyId);
    expect(hers.partyId).not.toBe(his.partyId);
    // Two permissions, not one shared between them. Same authorization id on
    // both would mean one person's signature covering two people's data.
    expect(hers.authorizationId).not.toBe(his.authorizationId);
  });

  it("will not pull the co-borrower on the primary's authorization", async () => {
    const { fileId, primaryId } = await household();
    await consent(fileId, primaryId, "verification_authorization");

    const file = (await loadLoanFile(fileId))!;
    await expect(tokenFor(file, file.borrowers[1]!, "credit_report")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(tokenFor(file, file.borrowers[1]!, "credit_report")).rejects.toMatchObject({
      requirementId: "APP-005",
    });
    // And hers still works, so the refusal is about whose it is rather than
    // about the file having nothing on it.
    expect((await tokenFor(file, file.borrowers[0]!, "credit_report")).partyId).toBe(
      file.borrowers[0]!.partyId,
    );
  });

  it("will not pull the primary on the co-borrower's authorization", async () => {
    // The direction the seed's comment names. Only Dev has signed; a mint that
    // reached for the file instead of the person would hand back a token and
    // pull Priya's credit under it.
    const { fileId, coId } = await household();
    await consent(fileId, coId, "verification_authorization");

    const file = (await loadLoanFile(fileId))!;
    await expect(tokenFor(file, primaryBorrower(file), "credit_report")).rejects.toThrow(
      /No authorization to retrieve credit_report/,
    );
    expect((await tokenFor(file, file.borrowers[1]!, "credit_report")).partyId).toBe(
      file.borrowers[1]!.partyId,
    );
  });

  it("hands `primaryBorrower` the person whose request it is", async () => {
    const { fileId, primaryId } = await household();
    const file = (await loadLoanFile(fileId))!;
    expect(primaryBorrower(file).id).toBe(primaryId);
    expect(primaryBorrower(file).firstName).toBe("Priya");
  });

  it("follows the freed ordinal to the replacement, not the older row", async () => {
    const { fileId, coId, devPartyId } = await replacedApplicant();
    const file = (await loadLoanFile(fileId))!;

    // Document order, which is the reverse of creation order here.
    expect(file.borrowers.map((b) => b.firstName)).toEqual(["Dev", "Priya"]);
    expect(primaryBorrower(file).id).toBe(coId);

    // And the token names Dev's party. Reading the older row would mint one
    // for Priya, who is no longer on this credit request at all.
    await consent(fileId, coId, "verification_authorization");
    expect((await tokenFor(file, primaryBorrower(file), "credit_report")).partyId).toBe(devPartyId);
  });

  it("refuses the primary's pull when only the person she replaced has signed", async () => {
    // The failure the ordinal exists to stop, stated as a refusal. Priya signed
    // and Dev did not, so there is nothing to pull the primary's credit on —
    // and a `primaryBorrower` that fell back to creation order would hand back
    // Priya's token and pull HER credit as the primary's.
    const { fileId, primaryId } = await replacedApplicant();
    await consent(fileId, primaryId, "verification_authorization");

    const file = (await loadLoanFile(fileId))!;
    await expect(tokenFor(file, primaryBorrower(file), "credit_report")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
