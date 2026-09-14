/**
 * Which income is employment income, and what that costs to undo.
 *
 * CURRENT_INCOME_ITEM carries two kinds of thing under one element name, told
 * apart by EmploymentIncomeIndicator, and only the employment kind is
 * associated with an EMPLOYER. The row now writes both halves and the database
 * holds them to each other, so the indicator DU reads is derivable from the arc
 * rather than stored beside it and free to contradict it.
 *
 * The price is a narrower foreign key. SET NULL cannot survive the
 * biconditional — a referential action is an UPDATE, and that UPDATE would
 * break the CHECK from inside somebody else's DELETE — so the edge is RESTRICT,
 * and an employer with income pointing at it cannot be removed until the income
 * points somewhere else. The tests below are mostly about that: what RESTRICT
 * refuses, what it does NOT accept as an answer, and what the operation that
 * actually gets past it looks like.
 *
 * Against the real Postgres, because every claim here is a constraint.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { EmploymentRecord, IncomeSourceType } from "@hm/shared";
import { reconcileIncomeAndEmployment, type ReportedIncome } from "../services/income.js";
import { recordSnapshot } from "../services/repository.js";
import { type BorrowerInput } from "../services/party.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";

const dana: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 2150,
  statedMonthlyIncome: 8500,
};

/** A file with one borrower on it, and the report a pull would have written. */
async function person() {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const borrower = await saveBorrower(file.id, dana);
  const snapshot = await recordSnapshot(
    file.id,
    "bank",
    "fixture",
    `report-${file.id}`,
    {},
    new Date().toISOString(),
    borrower.partyId,
  );
  return { fileId: file.id, partyId: borrower.partyId, snapshotId: snapshot.id };
}

/** An employer the way a bank pull leaves one: keyed by name, no EIN. */
async function employerNamed(partyId: string, displayName: string) {
  const key = `name:${displayName.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  return prisma.employer.create({
    data: { partyId, identityKey: key, nameKey: key, derivedFrom: "name", displayName },
    select: { id: true },
  });
}

function incomeRow(args: {
  readonly fileId: string;
  readonly partyId: string;
  readonly type?: IncomeSourceType;
  readonly employerId?: string | null;
  readonly employmentIncome: boolean;
}) {
  const type = args.type ?? "base_wage";
  return prisma.incomeSource.create({
    data: {
      loanFileId: args.fileId,
      partyId: args.partyId,
      identityKey: args.employerId ? `emp:${args.employerId}|${type}` : `self:${type}`,
      employerId: args.employerId ?? null,
      employmentIncome: args.employmentIncome,
      type,
      monthlyAmount: 6_250,
      historyMonths: 24,
    },
    select: { id: true },
  });
}

const EMPLOYMENT: EmploymentRecord = {
  employerName: "Fixture Health Systems",
  position: "Registered Nurse",
  startDate: "2020-01-01",
  status: "active",
  isMilitary: false,
  verificationMethod: "bank_inference",
};

/** A report written by hand, so a test can choose what it says twice. */
const REPORTED = (types: readonly IncomeSourceType[]): ReportedIncome => ({
  employments: [EMPLOYMENT],
  incomeSources: types.map((type) => ({
    type,
    monthlyAmount: 1_000,
    historyMonths: 12,
    continuanceEstablished: true,
    evidenceDocumentIds: [],
  })),
});

const reconcile = (fileId: string, partyId: string, snapshotId: string, reported: ReportedIncome) =>
  prisma.$transaction((tx) =>
    reconcileIncomeAndEmployment(tx, {
      loanFileId: fileId,
      partyId,
      snapshotId,
      reported,
      now: new Date(),
    }),
  );

describe("the discriminator and the arc are one fact", () => {
  it("refuses employment income with no employer to point at", async () => {
    const { fileId, partyId } = await person();
    await expect(incomeRow({ fileId, partyId, employmentIncome: true })).rejects.toThrow(
      /income_sources_employment_income_has_an_employer/,
    );
  });

  it("refuses an employer on income that says it is not employment income", async () => {
    // The half a one-directional CHECK would have let through, and the half
    // that makes the association derivable: a row pointing at an employer
    // cannot also say DU should read no employment from it.
    const { fileId, partyId } = await person();
    const employer = await employerNamed(partyId, "Fixture Health Systems");
    await expect(
      incomeRow({ fileId, partyId, employerId: employer.id, employmentIncome: false }),
    ).rejects.toThrow(/income_sources_employment_income_has_an_employer/);
  });

  it("is set by the writer from the employer the report could be matched to", async () => {
    const { fileId, partyId, snapshotId } = await person();
    await reconcile(fileId, partyId, snapshotId, REPORTED(["base_wage", "retirement"]));

    const rows = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId },
      select: { type: true, employerId: true, employmentIncome: true },
      orderBy: { type: "asc" },
    });
    expect(rows).toHaveLength(2);
    // A job pays wages and does not pay a pension, so only one of these two
    // ever had an employer to name.
    expect(rows.map((r) => [r.type, r.employmentIncome])).toEqual([
      ["base_wage", true],
      ["retirement", false],
    ]);
    expect(rows.every((r) => r.employmentIncome === (r.employerId !== null))).toBe(true);
  });
});

describe("two items of one type, on one borrower", () => {
  it("accepts two Base employment items", async () => {
    // Two Base employment items on ONE borrower are ordinary rather than a
    // duplicate, which is what DI-C04 shows and what is being accepted here.
    // The ordinal in the identity key is what keeps them two rows across a
    // re-pull rather than one.
    //
    // The two streams below come from ONE employer, because one active
    // employer is the only shape this writer can attach income to. DI-C04's
    // own two Base items come from two employers, and what that does here is
    // the test underneath.
    const { fileId, partyId, snapshotId } = await person();
    await reconcile(fileId, partyId, snapshotId, REPORTED(["base_wage", "base_wage"]));

    const rows = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId, type: "base_wage" },
      select: { identityKey: true, employerId: true, employmentIncome: true },
      orderBy: { identityKey: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.identityKey)).size).toBe(2);
    expect(rows.every((r) => r.employmentIncome && r.employerId !== null)).toBe(true);
  });

  it("accepts them, and calls them non-employment income, when two employers are active", async () => {
    // DI-C04's own shape, pinned rather than fixed. Two CURRENT employers and
    // two Base items, with no link between them anywhere in the payload — the
    // ports hand over a list of employments and a list of income and say
    // nothing about which pays which — so `employerForIncome` attaches
    // neither, and the biconditional then has to record wage income as NON-
    // employment income rather than let a row claim an employer it cannot
    // name. DU would read EmploymentIncomeIndicator false on the two items the
    // corpus emits as true with an arc each.
    //
    // Understating a row beats inventing an arc, and beats refusing a pull
    // over a shape the vendor chose; the fix is a per-income employer link
    // that no port carries. Until one does, this is what a second job costs.
    const { fileId, partyId, snapshotId } = await person();
    await reconcile(fileId, partyId, snapshotId, {
      employments: [
        EMPLOYMENT,
        { ...EMPLOYMENT, employerName: "Fixture Urgent Care", position: "Nurse Practitioner" },
      ],
      incomeSources: REPORTED(["base_wage", "base_wage"]).incomeSources,
    });

    expect(await prisma.employer.count({ where: { partyId } })).toBe(2);
    const rows = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId, type: "base_wage" },
      select: { identityKey: true, employerId: true, employmentIncome: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.employerId === null && !r.employmentIncome)).toBe(true);
    // And they are still two rows a re-pull can match, keyed on nothing but
    // the type and the ordinal.
    expect(new Set(rows.map((r) => r.identityKey))).toEqual(
      new Set(["self:base_wage", "self:base_wage#2"]),
    );
  });

  it("accepts two non-employment items of one type", async () => {
    // Deliberately NOT refused. DU supports one instance of an IncomeType per
    // borrower, but that is a rule about the type it is handed AFTER mapping,
    // and two rental properties or two brokerage accounts are two ordinary
    // rows of one ingest type from a payload we do not choose. An index here
    // would refuse the second one at the pull.
    const { fileId, partyId, snapshotId } = await person();
    await reconcile(fileId, partyId, snapshotId, REPORTED(["rental", "rental"]));

    const rows = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId, type: "rental" },
      select: { identityKey: true, employmentIncome: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.identityKey)).size).toBe(2);
    // Rent is not paid by a job, so neither row names an employer.
    expect(rows.every((r) => !r.employmentIncome)).toBe(true);
  });
});

describe("removing an employer somebody's income names", () => {
  it("is refused by the foreign key, not aborted by the check", async () => {
    // Under SET NULL this same delete failed — the referential UPDATE broke
    // the CHECK — but it failed as a check-constraint violation naming neither
    // the employer nor a way forward. The error has to say what is in the way.
    const { fileId, partyId } = await person();
    const employer = await employerNamed(partyId, "Fixture Health Systems");
    await incomeRow({ fileId, partyId, employerId: employer.id, employmentIncome: true });

    const attempt = prisma.employer.delete({ where: { id: employer.id } });
    await expect(attempt).rejects.toThrow(/income_sources_employer_id_fkey/);
    await expect(prisma.employer.count({ where: { id: employer.id } })).resolves.toBe(1);
  });

  it("is still refused after the income is retired", async () => {
    // The sentence this test exists to keep out of the codebase. RESTRICT
    // tests for the EXISTENCE of a referencing row, and `retiredAt` does not
    // clear `employerId` — a retired income points at its employer exactly as
    // hard as a live one. Believing otherwise would leave employer dedup,
    // party merge and vendor corrections impossible forever for any employer a
    // pull had ever attached income to.
    const { fileId, partyId, snapshotId } = await person();
    const employer = await employerNamed(partyId, "Fixture Health Systems");
    const row = await incomeRow({
      fileId,
      partyId,
      employerId: employer.id,
      employmentIncome: true,
    });
    await prisma.incomeSource.update({
      where: { id: row.id },
      data: { retiredAt: new Date(), retiredBySnapshotId: snapshotId },
    });

    await expect(prisma.employer.delete({ where: { id: employer.id } })).rejects.toThrow(
      /income_sources_employer_id_fkey/,
    );
  });

  it("succeeds once both tables are repointed onto the survivor", async () => {
    // The operation the migration documents, which is the only way past
    // RESTRICT: move every row naming the loser — LIVE AND RETIRED ALIKE,
    // because RESTRICT does not care which — onto the survivor first, in one
    // transaction, and only then delete.
    //
    // `employments.employer_id` is in the list even though its own edge is SET
    // NULL and would not raise. That is exactly why: left to referential
    // integrity the delete would succeed and quietly blank the employer on
    // every employment row that named the loser.
    const { fileId, partyId, snapshotId } = await person();
    const loser = await employerNamed(partyId, "Fixture Health");
    const survivor = await employerNamed(partyId, "Fixture Health Systems");

    const live = await incomeRow({ fileId, partyId, employerId: loser.id, employmentIncome: true });
    const retired = await incomeRow({
      fileId,
      partyId,
      type: "bonus",
      employerId: loser.id,
      employmentIncome: true,
    });
    await prisma.incomeSource.update({
      where: { id: retired.id },
      data: { retiredAt: new Date(), retiredBySnapshotId: snapshotId },
    });
    // One person with two employment rows for what turns out to be one job:
    // the collision `employments_file_party_employer_key` makes possible, and
    // the reason the repoint merges rather than updating both.
    for (const employerId of [loser.id, survivor.id]) {
      await prisma.employment.create({
        data: {
          loanFileId: fileId,
          partyId,
          employerId,
          employerName: "Fixture Health Systems",
          position: "Registered Nurse",
          status: "active",
          isMilitary: false,
          verificationMethod: "bank_inference",
        },
      });
    }

    // And the naive repoint — move every row naming the loser and be done — is
    // what that key refuses. This is why the loop below merges.
    await expect(
      prisma.$transaction((tx) =>
        tx.employment.updateMany({
          where: { employerId: loser.id },
          data: { employerId: survivor.id },
        }),
      ),
    ).rejects.toThrow(/employments_file_party_employer_key/);

    await prisma.$transaction(async (tx) => {
      const already = await tx.employment.findMany({
        where: { loanFileId: fileId, partyId, employerId: survivor.id },
        select: { loanFileId: true, partyId: true },
      });
      const held = new Set(already.map((e) => `${e.loanFileId}:${e.partyId}`));
      const moving = await tx.employment.findMany({
        where: { employerId: loser.id },
        select: { id: true, loanFileId: true, partyId: true },
      });
      for (const e of moving) {
        if (held.has(`${e.loanFileId}:${e.partyId}`)) {
          await tx.employment.delete({ where: { id: e.id } });
        } else {
          await tx.employment.update({ where: { id: e.id }, data: { employerId: survivor.id } });
        }
      }
      // The identity key is derived from the employer and is the writer's to
      // rebuild; RESTRICT is about the column, and this is the column.
      await tx.incomeSource.updateMany({
        where: { employerId: loser.id },
        data: { employerId: survivor.id },
      });
      await tx.employer.delete({ where: { id: loser.id } });
    });

    expect(await prisma.employer.count({ where: { id: loser.id } })).toBe(0);
    const moved = await prisma.incomeSource.findMany({
      where: { id: { in: [live.id, retired.id] } },
      select: { employerId: true, employmentIncome: true },
    });
    // Retired rows move too: a retired income is still evidence about a job.
    expect(moved.every((r) => r.employerId === survivor.id && r.employmentIncome)).toBe(true);
    // Merged, not twinned, and not silently unemployered either.
    const employments = await prisma.employment.findMany({
      where: { loanFileId: fileId, partyId },
      select: { employerId: true },
    });
    expect(employments).toEqual([{ employerId: survivor.id }]);
  });
});
