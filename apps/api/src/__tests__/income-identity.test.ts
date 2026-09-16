/**
 * The same income, across a re-pull.
 *
 * `income_sources` and `employments` were keyed to the loan file and nothing
 * else, and every pull deleted every row for the file and recreated them. So
 * one loan's five submissions carried five sets of primary keys, no income item
 * could be matched to the item it was last time, and nothing linked an income
 * item to an employer as an entity. Desktop Underwriter expects all three.
 *
 * The first test here is the one that has to be true whatever the writer does:
 * the projection every consumer reads is unchanged. Everything after it is the
 * new machinery — identity that survives, an employer that survives the
 * bank-to-payroll upgrade, rows retired instead of deleted, revival, party
 * scoping, and provenance back to the vendor's own report id.
 *
 * Against the real Postgres, because the matching is a unique index and the
 * scoping is a foreign key.
 */

import { describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";
import type { EmploymentRecord, FileEmployment } from "@hm/shared";

// Same reason as `standing.test.ts`: the deployed bank provider hands the
// borrower to a widget and answers 202, so the branch of the route that writes
// anything is unreachable against it. Hoisted because `config` reads the
// environment at import.
vi.hoisted(() => {
  process.env.BANK_PROVIDER = "fixture";
});

import { fileRouter } from "../routes/files.js";
import { connectorRouter } from "../routes/connectors.js";
import {
  employerFor,
  reconcileIncomeAndEmployment,
  type ReportedIncome,
} from "../services/income.js";
import { loadLoanFile, recordSnapshot } from "../services/repository.js";
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

const SCREEN_TWO = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "6789",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  firstTimeHomebuyer: true,
  currentHousing: "rent" as const,
  demographics: null,
};

/** Screens 1 and 2, through the routes, leaving the file able to pull. */
async function throughScreenTwo() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  const fileId = created.body.id;

  expect(
    (await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO)).status,
  ).toBe(201);
  const borrower = await prisma.borrower.findFirstOrThrow({
    where: { loanFileId: fileId },
    select: { id: true, partyId: true },
  });
  expect(
    (
      await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
        kind: "verification_authorization",
        borrowerId: borrower.id,
      })
    ).status,
  ).toBe(201);
  return { user, fileId, partyId: borrower.partyId };
}

interface PullBody {
  readonly report?: { readonly incomeSources: unknown[]; readonly employments: unknown[] };
  readonly payroll?: { readonly incomeSources: unknown[]; readonly employments: unknown[] };
}

const pull = async (userId: string, fileId: string, kind: "bank" | "payroll") => {
  const res = await callAs<PullBody>(userId, [connectorRouter], "POST", `/${fileId}/${kind}`, {});
  expect(res.status).toBe(201);
  return (kind === "bank" ? res.body.report : res.body.payroll)!;
};

/**
 * Vendor array order carries no meaning: two same-type streams from one
 * employer are told apart only by where they sat in the report, so they can
 * swap places between pulls. Compare content, sorted by something the report
 * itself fixes.
 */
const byKey = <T>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const rowsFor = (loanFileId: string) =>
  prisma.incomeSource.findMany({
    where: { loanFileId },
    select: {
      id: true,
      identityKey: true,
      employerId: true,
      retiredAt: true,
      retiredBySnapshotId: true,
      firstSeenSnapshotId: true,
      lastSeenSnapshotId: true,
      monthlyAmount: true,
      type: true,
    },
    orderBy: { identityKey: "asc" },
  });

/**
 * The file's employment carries what a report cannot — whose it is, and what
 * the borrower has said about it. Strip that to compare with what the adapter
 * returned; the invariant is about the vendor's fields.
 */
const asRecords = (employment: readonly FileEmployment[]) =>
  employment.map(
    ({
      id: _id,
      partyId: _partyId,
      employerId: _employerId,
      declaration: _declaration,
      ...record
    }) => record,
  );

describe("what every consumer above the projection sees", () => {
  it("is what the adapter returned, before and after a second pull", async () => {
    // The invariant this commit must not move. `loadLoanFile` drops the
    // primary key and every column outside the domain type, so no consumer has
    // ever seen a row id and none of the new columns reach one — which is why
    // replacing delete-and-recreate with matching can be behavior-preserving
    // at all. The claim is about the projection, not about the writers, and it
    // is equally true of both.
    const { user, fileId } = await throughScreenTwo();

    const first = await pull(user.id, fileId, "bank");
    const afterFirst = (await loadLoanFile(fileId))!;
    expect(byKey(afterFirst.incomeSources)).toEqual(byKey(first.incomeSources));
    expect(byKey(asRecords(afterFirst.employment))).toEqual(byKey(first.employments));

    const second = await pull(user.id, fileId, "bank");
    const afterSecond = (await loadLoanFile(fileId))!;
    expect(byKey(afterSecond.incomeSources)).toEqual(byKey(second.incomeSources));
    expect(byKey(asRecords(afterSecond.employment))).toEqual(byKey(second.employments));

    const payroll = await pull(user.id, fileId, "payroll");
    const afterPayroll = (await loadLoanFile(fileId))!;
    expect(byKey(afterPayroll.incomeSources)).toEqual(byKey(payroll.incomeSources));
    expect(byKey(asRecords(afterPayroll.employment))).toEqual(byKey(payroll.employments));
  });
});

describe("identity across a re-pull", () => {
  it("keeps the primary key an income source already had", async () => {
    // The bug, as an observable: under delete-and-recreate these two sets are
    // disjoint, and a resubmission reaches DU as income DU has never seen.
    const { user, fileId } = await throughScreenTwo();

    await pull(user.id, fileId, "bank");
    const before = (await rowsFor(fileId)).map((r) => r.id);
    expect(before.length).toBeGreaterThan(0);

    await pull(user.id, fileId, "bank");
    const after = (await rowsFor(fileId)).map((r) => r.id);

    expect(after).toEqual(before);
  });

  it("keeps the employment's primary key too", async () => {
    const { user, fileId } = await throughScreenTwo();
    await pull(user.id, fileId, "bank");
    const before = await prisma.employment.findMany({
      where: { loanFileId: fileId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await pull(user.id, fileId, "bank");
    const after = await prisma.employment.findMany({
      where: { loanFileId: fileId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });
});

describe("the employer, across the step that improves it", () => {
  it("is promoted to its EIN rather than twinned", async () => {
    // The bank never carries an EIN and payroll does, so without promotion the
    // one step whose entire purpose is better data about this employer would
    // be the step that loses the employer's identity.
    const { user, fileId, partyId } = await throughScreenTwo();

    await pull(user.id, fileId, "bank");
    const fromBank = await prisma.employer.findMany({ where: { partyId } });
    expect(fromBank).toHaveLength(1);
    expect(fromBank[0]!.derivedFrom).toBe("name");
    expect(fromBank[0]!.identityKey).toMatch(/^name:/);

    await pull(user.id, fileId, "payroll");
    const fromPayroll = await prisma.employer.findMany({ where: { partyId } });
    expect(fromPayroll).toHaveLength(1);
    expect(fromPayroll[0]!.id).toBe(fromBank[0]!.id);
    expect(fromPayroll[0]!.derivedFrom).toBe("ein");
    expect(fromPayroll[0]!.identityKey).toMatch(/^ein:/);
    expect(fromPayroll[0]!.ein).toMatch(/^\d+$/);

    const employments = await prisma.employment.findMany({
      where: { loanFileId: fileId, retiredAt: null },
      select: { employerId: true },
    });
    expect(employments.map((e) => e.employerId)).toEqual([fromBank[0]!.id]);
  });

  it("is still recognized by the bank pull that follows the payroll one", async () => {
    // The other direction, and the one that decides whether the promotion is
    // an upgrade or a fork. Payroll rewrites the employer's key to `ein:`; a
    // bank pull afterwards derives `name:` and has to land on that same row,
    // or one job becomes two employers and the income and employment rows
    // pointing at the second take new primary keys — the exact loss this whole
    // commit exists to stop. A borrower re-runs the bank step whenever the
    // connection lapses, so nothing about this ordering is exotic.
    const { user, fileId, partyId } = await throughScreenTwo();

    await pull(user.id, fileId, "bank");
    await pull(user.id, fileId, "payroll");
    const promoted = await prisma.employer.findMany({ where: { partyId } });
    expect(promoted).toHaveLength(1);
    const incomeBefore = (await rowsFor(fileId)).map((r) => r.id);
    const employmentBefore = await prisma.employment.findMany({
      where: { loanFileId: fileId },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    await pull(user.id, fileId, "bank");

    const afterBank = await prisma.employer.findMany({ where: { partyId } });
    expect(afterBank).toHaveLength(1);
    expect(afterBank[0]!.id).toBe(promoted[0]!.id);
    // The EIN is the better key and a report that lacks one does not undo it.
    expect(afterBank[0]!.identityKey).toBe(promoted[0]!.identityKey);
    expect(afterBank[0]!.derivedFrom).toBe("ein");

    expect((await rowsFor(fileId)).map((r) => r.id)).toEqual(incomeBefore);
    expect(
      await prisma.employment.findMany({
        where: { loanFileId: fileId },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(employmentBefore);
  });

  it("does not swallow a second EIN reported under the same trade name", async () => {
    // The limit of the name fallback, pinned so it stays a limit. Two EINs
    // under one name are two employers, and promoting a row that already holds
    // somebody else's EIN would merge two jobs into one — a worse error than
    // the split it avoids, because it would sum two incomes onto one entity.
    // No fixture reports this; a real payroll aggregator covering a borrower
    // with two related employers would.
    const { fileId, partyId } = await throughScreenTwo();
    const snapshot = await snapshotFor(fileId, partyId, "report-1");
    const record = (ein?: string): EmploymentRecord => ({
      employerName: "Acme, Inc.",
      employerEin: ein,
      position: "Analyst",
      startDate: "2019-06-01",
      status: "active",
      isMilitary: false,
      verificationMethod: "payroll_connector",
    });

    const [byName, first, second, again] = await prisma.$transaction(async (tx) => [
      // Bank first: no EIN at all, so the row starts name-derived.
      await employerFor(tx, { partyId, record: record(), snapshotId: snapshot.id }),
      await employerFor(tx, { partyId, record: record("00-0000111"), snapshotId: snapshot.id }),
      await employerFor(tx, { partyId, record: record("00-0000222"), snapshotId: snapshot.id }),
      await employerFor(tx, { partyId, record: record(), snapshotId: snapshot.id }),
    ]);

    // The first EIN promotes the name row; the second cannot, so it opens its
    // own — and the name row is gone, so there is nothing left to promote.
    expect(first.id).toBe(byName.id);
    expect(first.promoted).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(second.promoted).toBe(false);

    const rows = await prisma.employer.findMany({
      where: { partyId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows.map((e) => e.ein)).toEqual(["000000111", "000000222"]);
    expect(new Set(rows.map((e) => e.nameKey))).toEqual(new Set(["name:acmeinc"]));

    // A later report with no EIN can only take the older of the two. That is
    // the cost of the fallback, and it is stable rather than arbitrary.
    expect(again.id).toBe(first.id);
  });
});

/** A report written by hand, so a test can decide what a pull stops naming. */
const REPORTED = (types: readonly string[]): ReportedIncome => ({
  employments: [
    {
      employerName: "Fixture Health Systems",
      position: "Registered Nurse",
      startDate: "2020-01-01",
      status: "active",
      isMilitary: false,
      verificationMethod: "bank_inference",
    },
  ],
  incomeSources: types.map((type) => ({
    type: type as never,
    monthlyAmount: 1_000,
    historyMonths: 12,
    continuanceEstablished: true,
    evidenceDocumentIds: [],
  })),
});

const snapshotFor = (fileId: string, partyId: string, externalId: string) =>
  recordSnapshot(fileId, "bank", "fixture", externalId, {}, new Date().toISOString(), partyId);

describe("a source the next report stops naming", () => {
  it("is retired, names the report that retired it, and leaves the projection", async () => {
    const { fileId, partyId } = await throughScreenTwo();
    const first = await snapshotFor(fileId, partyId, "report-1");
    await prisma.$transaction((tx) =>
      reconcileIncomeAndEmployment(tx, {
        loanFileId: fileId,
        partyId,
        snapshotId: first.id,
        reported: REPORTED(["base_wage", "retirement"]),
        now: new Date(),
      }),
    );
    expect((await loadLoanFile(fileId))!.incomeSources).toHaveLength(2);

    const second = await snapshotFor(fileId, partyId, "report-2");
    await prisma.$transaction((tx) =>
      reconcileIncomeAndEmployment(tx, {
        loanFileId: fileId,
        partyId,
        snapshotId: second.id,
        reported: REPORTED(["base_wage"]),
        now: new Date(),
      }),
    );

    const retired = (await rowsFor(fileId)).filter((r) => r.retiredAt !== null);
    expect(retired.map((r) => r.type)).toEqual(["retirement"]);
    // The retirement and its cause are one statement, so a retired row always
    // says which report retired it.
    expect(retired[0]!.retiredBySnapshotId).toBe(second.id);

    // Kept, not deleted — you cannot diff against a row you deleted — and the
    // filter is in the query, because an applicability predicate shaped
    // `length === 0 ? null : some(...)` reads a retired row as a definite yes.
    const live = (await loadLoanFile(fileId))!.incomeSources;
    expect(live.map((s) => s.type)).toEqual(["base_wage"]);
  });

  it("is revived on the same row when a later report names it again", async () => {
    const { fileId, partyId } = await throughScreenTwo();
    const reconcile = async (types: readonly string[], externalId: string) => {
      const snapshot = await snapshotFor(fileId, partyId, externalId);
      await prisma.$transaction((tx) =>
        reconcileIncomeAndEmployment(tx, {
          loanFileId: fileId,
          partyId,
          snapshotId: snapshot.id,
          reported: REPORTED(types),
          now: new Date(),
        }),
      );
      return snapshot;
    };

    await reconcile(["base_wage", "retirement"], "report-1");
    const original = (await rowsFor(fileId)).find((r) => r.type === "retirement")!;
    await reconcile(["base_wage"], "report-2");
    const third = await reconcile(["base_wage", "retirement"], "report-3");

    const revived = (await rowsFor(fileId)).filter((r) => r.type === "retirement");
    // One income that went away and came back, not two incomes.
    expect(revived).toHaveLength(1);
    expect(revived[0]!.id).toBe(original.id);
    expect(revived[0]!.retiredAt).toBeNull();
    expect(revived[0]!.retiredBySnapshotId).toBeNull();
    expect(revived[0]!.lastSeenSnapshotId).toBe(third.id);
    // Where the numbers come from now moved; when we first saw this income did
    // not. One column would have answered half the question.
    expect(revived[0]!.firstSeenSnapshotId).toBe(original.firstSeenSnapshotId);
  });
});

describe("whose income it is", () => {
  it("leaves the other borrower's rows alone", async () => {
    // The co-borrower bug the delete had: `deleteMany({ where: { loanFileId } })`
    // has no party filter, so the second borrower's pull took the first
    // borrower's income with it. No shipped flow reaches two borrowers today;
    // the scoping is here before one does.
    const { fileId, partyId } = await throughScreenTwo();
    // A second person, as the column sees one. Screen 2 collects one borrower
    // and resolves the party from the file's owner, so a co-borrower cannot be
    // made through the routes yet — which is exactly why the scoping is worth
    // pinning before one can.
    const second = await prisma.party.create({ data: {}, select: { id: true } });

    const first = await snapshotFor(fileId, partyId, "report-1");
    await prisma.$transaction((tx) =>
      reconcileIncomeAndEmployment(tx, {
        loanFileId: fileId,
        partyId,
        snapshotId: first.id,
        reported: REPORTED(["base_wage"]),
        now: new Date(),
      }),
    );

    const theirs = await snapshotFor(fileId, partyId, "report-2");
    await prisma.$transaction((tx) =>
      reconcileIncomeAndEmployment(tx, {
        loanFileId: fileId,
        partyId: second.id,
        snapshotId: theirs.id,
        reported: REPORTED(["base_wage"]),
        now: new Date(),
      }),
    );

    const live = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId, retiredAt: null },
      select: { partyId: true },
    });
    expect(live).toHaveLength(2);
    expect(new Set(live.map((r) => r.partyId))).toEqual(new Set([partyId, second.id]));
  });
});

describe("which report a number came from", () => {
  it("is on every row a pull route writes, and names the vendor's own report id", async () => {
    // `connector_snapshots.external_id` had one writer and no reader at all
    // until now. This is its first: a figure on a decision names the report
    // behind it in one join, which is what an underwriter needs the day a
    // vendor issues a correction.
    const { user, fileId } = await throughScreenTwo();
    const report = await pull(user.id, fileId, "bank");
    expect(report.incomeSources.length).toBeGreaterThan(0);

    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: fileId, kind: "bank" },
      orderBy: { retrievedAt: "desc" },
    });

    const traced = await prisma.incomeSource.findMany({
      where: { loanFileId: fileId },
      select: { lastSeenSnapshotId: true, lastSeenSnapshot: { select: { externalId: true } } },
    });
    expect(traced.length).toBeGreaterThan(0);
    for (const row of traced) {
      expect(row.lastSeenSnapshotId).toBe(snapshot.id);
      expect(row.lastSeenSnapshot!.externalId).toBe(snapshot.externalId);
    }

    const employments = await prisma.employment.findMany({
      where: { loanFileId: fileId },
      select: { firstSeenSnapshotId: true, lastSeenSnapshotId: true },
    });
    expect(employments.length).toBeGreaterThan(0);
    for (const row of employments) {
      expect(row.firstSeenSnapshotId).toBe(snapshot.id);
      expect(row.lastSeenSnapshotId).toBe(snapshot.id);
    }
  });
});

const definitionOf = async (name: string): Promise<string> => {
  const rows = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
  `;
  if (!rows[0]) throw new Error(`no constraint named ${name}`);
  return rows[0].def;
};

const indexDefinitionOf = async (name: string): Promise<string> => {
  const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE indexname = ${name}
  `;
  if (!rows[0]) throw new Error(`no index named ${name}`);
  return rows[0].indexdef;
};

describe("the database holds the matching, not just the writer", () => {
  it("makes each match key unique", async () => {
    // A second row under one key is a twin, and a twin is double income.
    for (const name of [
      "employers_party_identity_key",
      "income_sources_file_party_identity_key",
      "employments_file_party_employer_key",
    ]) {
      expect(await indexDefinitionOf(name)).toMatch(/CREATE UNIQUE INDEX/);
    }
  });

  it("refuses an employer whose key does not match its own evidence", async () => {
    expect(await definitionOf("employers_derived_from_known")).toContain("'ein'");
    expect(await definitionOf("employers_key_matches_its_rule")).toContain("ein:%");

    const { partyId } = await throughScreenTwo();
    await expect(
      prisma.employer.create({
        data: {
          partyId,
          identityKey: "ein:000000009",
          nameKey: "name:mislabeled",
          derivedFrom: "name",
          displayName: "Mislabeled",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses an unpromoted employer whose two keys disagree", async () => {
    // What makes `name_key` usable as the fallback: on a row no EIN has
    // reached, it IS the identity key, so a lookup by either finds the same
    // row. Promotion is the only thing allowed to separate them.
    expect(await definitionOf("employers_name_key_survives_promotion")).toContain("name:%");

    const { partyId } = await throughScreenTwo();
    await expect(
      prisma.employer.create({
        data: {
          partyId,
          identityKey: "name:acme",
          nameKey: "name:acmetwo",
          derivedFrom: "name",
          displayName: "Acme",
        },
      }),
    ).rejects.toThrow();
  });
});
