/**
 * URLA 1b, per job: asked, stored with who said it, refused when partial or
 * about somebody else's job, and outstanding again when a later pull adds a
 * job nobody has answered for.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { assessAll } from "@hm/requirements";
import type { BorrowerInput } from "../services/party.js";
import { ensureApplicationParty } from "../services/applications.js";
import { declarationRouter } from "../routes/declarations.js";
import { loadLoanFile } from "../services/repository.js";
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

async function applicationFile() {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, nadia);
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await ensureApplicationParty(prisma, app.id, borrower.partyId, "PRIMARY_BORROWER");
  return { user, file, borrower };
}

async function aJob(loanFileId: string, partyId: string, name: string) {
  const employer = await prisma.employer.create({
    data: {
      partyId,
      identityKey: `name:${name.toLowerCase()}`,
      derivedFrom: "name",
      nameKey: `name:${name.toLowerCase()}`,
      displayName: name,
    },
    select: { id: true },
  });
  return prisma.employment.create({
    data: {
      loanFileId,
      partyId,
      employerId: employer.id,
      employerName: name,
      position: "Staff",
      status: "active",
      verificationMethod: "payroll_connector",
    },
    select: { id: true },
  });
}

const post = (userId: string, fileId: string, body: unknown) =>
  callAs(userId, [declarationRouter], "POST", `/${fileId}/employment-declarations`, body);

const answer = (
  employmentId: string,
  selfEmployed = false,
  employedByPartyToTransaction = false,
) => ({
  employmentId,
  selfEmployed,
  employedByPartyToTransaction,
});

async function requirement(fileId: string, id: string) {
  const file = (await loadLoanFile(fileId))!;
  return assessAll(file).find((r) => r.requirement.id === id)!;
}

describe("declaring on a job", () => {
  it("is unasked until the borrower answers, and the registry says so by employer", async () => {
    const { file, borrower } = await applicationFile();
    await aJob(file.id, borrower.partyId, "Acme");
    const before = await requirement(file.id, "APP-029");
    expect(before.applies).toBe(true);
    expect(before.satisfaction.status).toBe("unsatisfied");
    expect(JSON.stringify(before.satisfaction)).toContain("Acme");
  });

  it("does not apply before any pull has said whether there is a job, and not at all to a borrower with none", async () => {
    const { file } = await applicationFile();
    expect((await requirement(file.id, "APP-029")).applies).toBeNull();
    await prisma.incomeSource.create({
      data: {
        loanFileId: file.id,
        partyId: (await prisma.borrower.findFirstOrThrow({ where: { loanFileId: file.id } }))
          .partyId,
        employmentIncome: false,
        identityKey: "social_security:1",
        type: "social_security",
        monthlyAmount: 2100,
        historyMonths: 24,
      },
    });
    // A pull has run and found income but no job: nothing to declare on.
    expect((await requirement(file.id, "APP-029")).applies).toBe(false);
  });

  it("records both answers with who said them, and the requirement is met", async () => {
    const { user, file, borrower } = await applicationFile();
    const job = await aJob(file.id, borrower.partyId, "Acme");
    const res = await post(user.id, file.id, { answers: [answer(job.id, true, false)] });
    expect(res.status).toBe(201);
    const row = await prisma.employment.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.selfEmployed).toBe(true);
    expect(row.employedByPartyToTransaction).toBe(false);
    expect(row.declaredAt).not.toBeNull();
    // Asserted by the requester's own principal.
    const principal = await prisma.principal.findUniqueOrThrow({
      where: { id: row.declaredByPrincipalId! },
    });
    expect(principal.partyId).toBe(borrower.partyId);
    const after = await requirement(file.id, "APP-029");
    expect(after.satisfaction.status).toBe("satisfied");
    expect(JSON.stringify(after.satisfaction)).toContain("1 flagged");
    // And the file view carries it.
    const view = (await loadLoanFile(file.id))!;
    expect(view.employment[0]!.declaration).toMatchObject({
      selfEmployed: true,
      employedByPartyToTransaction: false,
    });
  });

  it("refuses a partial set, naming the job left out", async () => {
    const { user, file, borrower } = await applicationFile();
    const first = await aJob(file.id, borrower.partyId, "Acme");
    await aJob(file.id, borrower.partyId, "Globex");
    const res = await post(user.id, file.id, { answers: [answer(first.id)] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("Globex");
    expect(
      (await prisma.employment.findUniqueOrThrow({ where: { id: first.id } })).declaredAt,
    ).toBeNull();
  });

  it("refuses an answer about a job that is not this borrower's on this file", async () => {
    const { user, file, borrower } = await applicationFile();
    const mine = await aJob(file.id, borrower.partyId, "Acme");
    const other = await applicationFile();
    const theirs = await aJob(other.file.id, other.borrower.partyId, "Initech");
    const res = await post(user.id, file.id, { answers: [answer(mine.id), answer(theirs.id)] });
    expect(res.status).toBe(422);
    expect(res.body.code ?? JSON.stringify(res.body)).toContain("EMPLOYMENT_NOT_THEIRS");
    expect(
      (await prisma.employment.findUniqueOrThrow({ where: { id: theirs.id } })).declaredAt,
    ).toBeNull();
  });

  it("is unasked again for a job a later pull adds, and only for that one", async () => {
    const { user, file, borrower } = await applicationFile();
    const first = await aJob(file.id, borrower.partyId, "Acme");
    expect((await post(user.id, file.id, { answers: [answer(first.id)] })).status).toBe(201);
    expect((await requirement(file.id, "APP-029")).satisfaction.status).toBe("satisfied");
    await aJob(file.id, borrower.partyId, "Globex");
    const again = await requirement(file.id, "APP-029");
    expect(again.satisfaction.status).toBe("unsatisfied");
    expect(JSON.stringify(again.satisfaction)).toContain("Globex");
    expect(JSON.stringify(again.satisfaction)).not.toContain("Acme");
  });

  it("holds the three columns together at the database", async () => {
    const { file, borrower } = await applicationFile();
    const job = await aJob(file.id, borrower.partyId, "Acme");
    await expect(
      prisma.employment.update({ where: { id: job.id }, data: { selfEmployed: true } }),
    ).rejects.toThrow(/check constraint|a_declaration_is_whole/);
  });
});
