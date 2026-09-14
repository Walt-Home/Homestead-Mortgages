/**
 * Four borrowers, in order, and which one is Borrower 1.
 *
 * DU allows BORROWER 1:4 and conveys the position by document order and label
 * ordinal — no element states it. So a position that lives only in whatever
 * order the serializer happened to iterate is a position that can differ
 * between two submissions of the same file, and `LOAN_DETAIL/BorrowerCount`
 * has nothing to agree with. `application_parties.borrower_ordinal` is where
 * it lives, and the database is what keeps it true.
 *
 * The first test here is the dullest one and it is the one that matters:
 * creating an application still works. The CHECK that ties a borrowing role to
 * a number is not satisfiable by the writer that existed before it, so a plan
 * that lands the constraint in one commit and the allocator in another is a
 * plan with four commits in which every `POST /api/files` — and every API test
 * that makes one — fails. That is what this file is here to catch.
 *
 * The allocator is SMALLEST UNUSED rather than `max + 1`, and the difference
 * is not academic. Dropping a borrower before a resubmission is an expected
 * operation; counting instead of allocating hands the replacement a 5 on an
 * application holding three people, and the one-to-four CHECK refuses it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma, type ApplicationPartyRole, type Prisma } from "@hm/db";
import { applicationForFile, ensureApplicationParty } from "../services/applications.js";
import { fileRouter } from "../routes/files.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATION = join(
  repoRoot,
  "packages/db/prisma/migrations/20260914100000_four_borrowers_in_order/migration.sql",
);

/** Screen 1's body, as the web posts it. */
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

/** A credit request on its own file, with no parties on it yet. */
async function anApplication(): Promise<{ id: string }> {
  const file = await createLoanFile({ userId: (await createUser()).id });
  return prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
}

/** One more person on an application, through the only writer that adds one. */
async function append(applicationId: string, role: ApplicationPartyRole = "CO_BORROWER") {
  const party = await createParty();
  return ensureApplicationParty(prisma, applicationId, party.id, role);
}

/** Every borrowing position on an application, in order. */
async function ordinals(applicationId: string): Promise<(number | null)[]> {
  const rows = await prisma.applicationParty.findMany({
    where: { applicationId },
    orderBy: { borrowerOrdinal: "asc" },
    select: { borrowerOrdinal: true },
  });
  return rows.map((r) => r.borrowerOrdinal);
}

describe("creating an application still works", () => {
  it("puts the person asking at Borrower 1", async () => {
    // The test that would have caught the split. Screen 1 is the only
    // production writer of an `applications` row, and the party it puts on
    // that row goes through the same allocator everything else does.
    const user = await createUser();
    const res = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    expect(res.status).toBe(201);

    const app = await applicationForFile(prisma, res.body.id);
    const parties = await prisma.applicationParty.findMany({
      where: { applicationId: app!.id },
      select: { role: true, borrowerOrdinal: true },
    });
    expect(parties).toEqual([{ role: "PRIMARY_BORROWER", borrowerOrdinal: 1 }]);
  });

  it("does not move a party who is already on it", async () => {
    // Every caller is `ensureApplicationParty`, and three of them run on paths
    // a borrower can repeat — a second consent, a corrected surname, a
    // re-signature. A second call that reallocated would renumber a person
    // mid-application.
    const app = await anApplication();
    const party = await createParty();
    const first = await ensureApplicationParty(prisma, app.id, party.id, "PRIMARY_BORROWER");
    const again = await ensureApplicationParty(prisma, app.id, party.id, "PRIMARY_BORROWER");
    expect(again).toEqual(first);
    expect(await ordinals(app.id)).toEqual([1]);
  });
});

describe("the allocator", () => {
  it("gives the primary 1 and everybody after it the next free number", async () => {
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    await append(app.id, "CO_BORROWER");
    await append(app.id, "NON_OCCUPANT_CO_BORROWER");
    expect(await ordinals(app.id)).toEqual([1, 2, 3]);
  });

  it("leaves a role that emits no BORROWER without a position", async () => {
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    const spouse = await append(app.id, "NON_BORROWING_SPOUSE");
    const guarantor = await append(app.id, "GUARANTOR");
    expect(spouse.borrowerOrdinal).toBeNull();
    expect(guarantor.borrowerOrdinal).toBeNull();
    expect(await ordinals(app.id)).toEqual([1, null, null]);
  });

  it("fills a freed position rather than counting past it", async () => {
    // Four borrowers, borrower 3 drops off before the resubmission, and a
    // replacement arrives. `max(borrower_ordinal) + 1` allocates 5 here and
    // the one-to-four CHECK refuses it — a fourth borrower rejected on an
    // application holding three.
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    await append(app.id);
    const leaving = await append(app.id);
    await append(app.id);
    expect(await ordinals(app.id)).toEqual([1, 2, 3, 4]);

    await prisma.applicationParty.delete({ where: { id: leaving.id } });
    const replacement = await append(app.id);

    expect(replacement.borrowerOrdinal).toBe(3);
    // And nobody was renumbered on the way: the ordinal is a position in one
    // document, not an identity, so a borrower who was 4 is still 4.
    expect(await ordinals(app.id)).toEqual([1, 2, 3, 4]);
  });

  it("does not let a co-borrower fill the vacancy at Borrower 1", async () => {
    // A hole at 1 means the application has lost its primary borrower.
    // Appending a co-borrower is not the operation that fixes that, and
    // silently promoting one would make somebody the applicant.
    const app = await anApplication();
    const primary = await append(app.id, "PRIMARY_BORROWER");
    await prisma.applicationParty.delete({ where: { id: primary.id } });

    expect((await append(app.id)).borrowerOrdinal).toBe(2);
    expect(await ordinals(app.id)).toEqual([2]);
  });

  it("refuses a fifth borrower by name rather than by constraint violation", async () => {
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    await append(app.id);
    await append(app.id);
    await append(app.id);

    // The failing operation is a person being added to a household that is
    // already four people. "violates check constraint" names a number nobody
    // chose and no application.
    await expect(append(app.id)).rejects.toThrow(
      new RegExp(`application ${app.id} already holds four borrowers`),
    );
  });

  it("serializes two appends that arrive at once instead of aborting one", async () => {
    // Two writers reading the same vacancy both compute 2, and the unique
    // index gives the loser an error instead of a row —
    // `createMany({ skipDuplicates: true })` absorbed this for free until the
    // ordinal arrived. The `SELECT ... FOR UPDATE` on the application is what
    // replaces it: the second writer queues and sees what the first did.
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    const [one, two] = [await createParty(), await createParty()];

    // Both transactions are open before either allocates, so the read of the
    // free positions genuinely overlaps rather than happening to be ordered.
    let openA = () => {};
    let openB = () => {};
    const a = new Promise<void>((r) => (openA = r));
    const b = new Promise<void>((r) => (openB = r));

    const append1 = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      openA();
      await b;
      return ensureApplicationParty(tx, app.id, one.id, "CO_BORROWER");
    });
    const append2 = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      openB();
      await a;
      return ensureApplicationParty(tx, app.id, two.id, "CO_BORROWER");
    });

    const landed = await Promise.all([append1, append2]);
    expect(landed.map((e) => e.borrowerOrdinal).sort()).toEqual([2, 3]);
    expect(await ordinals(app.id)).toEqual([1, 2, 3]);
  });
});

describe("the database, not the writer", () => {
  /** An edge written straight past `ensureApplicationParty`. */
  const edge = (
    applicationId: string,
    partyId: string,
    role: ApplicationPartyRole,
    borrowerOrdinal: number | null,
  ) => prisma.applicationParty.create({ data: { applicationId, partyId, role, borrowerOrdinal } });

  it("refuses two parties at the same position", async () => {
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    await append(app.id);
    const other = await createParty();
    await expect(edge(app.id, other.id, "CO_BORROWER", 2)).rejects.toThrow(
      /application_parties_one_party_per_ordinal/,
    );
  });

  it("refuses a second Borrower 1, and says that is the rule that broke", async () => {
    const app = await anApplication();
    await append(app.id, "PRIMARY_BORROWER");
    const other = await createParty();
    // Not the general position index: a second Borrower 1 violates both, and
    // the one that names the rule is the one created first.
    await expect(edge(app.id, other.id, "CO_BORROWER", 1)).rejects.toThrow(
      /application_parties_one_first_borrower/,
    );
  });

  it("refuses a borrowing role with no position at all", async () => {
    // The half of the biconditional with teeth. A NULL here is a borrower with
    // no position in the document, which the label allocator and BorrowerCount
    // both read.
    const app = await anApplication();
    const party = await createParty();
    await expect(edge(app.id, party.id, "CO_BORROWER", null)).rejects.toThrow(
      /application_parties_borrowers_are_numbered/,
    );
  });

  it("refuses a non-borrowing role that holds one", async () => {
    // The other half. A guarantor emits no BORROWER element, so a position
    // reserved for one is a position missing from the document.
    const app = await anApplication();
    const party = await createParty();
    await expect(edge(app.id, party.id, "GUARANTOR", 2)).rejects.toThrow(
      /application_parties_borrowers_are_numbered/,
    );
  });

  it("refuses a position outside one to four", async () => {
    const app = await anApplication();
    const party = await createParty();
    await expect(edge(app.id, party.id, "CO_BORROWER", 5)).rejects.toThrow(
      /application_parties_borrower_ordinal_is_one_to_four/,
    );
  });
});

/**
 * The migration's own two statements, replayed against real rows.
 *
 * The backfill ran before the constraints existed and cannot run beside them:
 * its entire input is borrowing edges carrying no ordinal, which is exactly the
 * row the CHECK refuses. So the rehearsal drops the two CHECKs and always rolls
 * back — Postgres keeps DDL transactional, this suite runs one file at a time,
 * and a constraint dropped for real here would be a constraint missing from
 * every test that ran after it.
 */
const ROLLBACK = new Error("the rehearsal keeps the constraints it borrowed");

async function rehearse(body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "application_parties" ' +
          'DROP CONSTRAINT "application_parties_borrowers_are_numbered", ' +
          'DROP CONSTRAINT "application_parties_borrower_ordinal_is_one_to_four"',
      );
      await body(tx);
      throw ROLLBACK;
    })
    .catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
}

/** A statement lifted from the migration file, so the test cannot drift from it. */
function statement(from: string, to: string): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf(from);
  if (start < 0) throw new Error(`the migration no longer contains ${from}`);
  const end = sql.indexOf(to, start);
  if (end < 0) throw new Error(`no ${to} after ${from} in the migration`);
  return sql.slice(start, end + to.length);
}

const BACKFILL = () => statement('UPDATE "application_parties" ap', "WHERE ap.id = o.id;");
const FIVE_BORROWER_GUARD = () => statement("DO $$", "END $$;");

/** Borrowing edges as they stood before the column existed: no ordinal, in a known order. */
async function edgesWithNoOrdinal(
  tx: Prisma.TransactionClient,
  applicationId: string,
  roles: readonly ApplicationPartyRole[],
): Promise<void> {
  for (const [index, role] of roles.entries()) {
    const party = await createParty();
    // `created_at` is the backfill's tiebreaker, so it is stated rather than
    // left to a `now()` every row in one transaction shares.
    await tx.$executeRawUnsafe(
      'INSERT INTO "application_parties" ("id", "application_id", "party_id", "role", "created_at")' +
        ' VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"ApplicationPartyRole", $5::timestamp)',
      randomUUID(),
      applicationId,
      party.id,
      role,
      new Date(Date.UTC(2026, 0, 1 + index)),
    );
  }
}

describe("the backfill", () => {
  it("puts the primary borrower at 1 and the rest in the order they joined", async () => {
    // The primary is inserted LAST, so an ordering that only followed
    // `created_at` would make the co-borrower who arrived first Borrower 1 —
    // and Borrower 1 is who DU reads as the applicant.
    const app = await anApplication();
    let numbered: { role: string; borrowerOrdinal: number | null }[] = [];

    await rehearse(async (tx) => {
      await edgesWithNoOrdinal(tx, app.id, [
        "CO_BORROWER",
        "NON_OCCUPANT_CO_BORROWER",
        "CO_BORROWER",
        "PRIMARY_BORROWER",
      ]);
      await tx.$executeRawUnsafe(BACKFILL());
      numbered = await tx.applicationParty.findMany({
        where: { applicationId: app.id },
        orderBy: { borrowerOrdinal: "asc" },
        select: { role: true, borrowerOrdinal: true },
      });
    });

    expect(numbered).toEqual([
      { role: "PRIMARY_BORROWER", borrowerOrdinal: 1 },
      { role: "CO_BORROWER", borrowerOrdinal: 2 },
      { role: "NON_OCCUPANT_CO_BORROWER", borrowerOrdinal: 3 },
      { role: "CO_BORROWER", borrowerOrdinal: 4 },
    ]);
  });

  it("leaves a non-borrowing role unnumbered", async () => {
    const app = await anApplication();
    let numbered: { role: string; borrowerOrdinal: number | null }[] = [];

    await rehearse(async (tx) => {
      await edgesWithNoOrdinal(tx, app.id, [
        "PRIMARY_BORROWER",
        "NON_BORROWING_SPOUSE",
        "GUARANTOR",
      ]);
      await tx.$executeRawUnsafe(BACKFILL());
      numbered = await tx.applicationParty.findMany({
        where: { applicationId: app.id },
        orderBy: [{ borrowerOrdinal: "asc" }, { createdAt: "asc" }],
        select: { role: true, borrowerOrdinal: true },
      });
    });

    expect(numbered).toEqual([
      { role: "PRIMARY_BORROWER", borrowerOrdinal: 1 },
      { role: "NON_BORROWING_SPOUSE", borrowerOrdinal: null },
      { role: "GUARANTOR", borrowerOrdinal: null },
    ]);
  });

  it("stops the migration, naming the application, when one holds five", async () => {
    // Without the guard the CHECK refuses the 5 with a message that names no
    // row and no application — on a migration, where the message is the only
    // thing there is to act on.
    const app = await anApplication();
    let raised = "the migration walked past five borrowing parties";

    await rehearse(async (tx) => {
      await edgesWithNoOrdinal(tx, app.id, [
        "PRIMARY_BORROWER",
        "CO_BORROWER",
        "CO_BORROWER",
        "CO_BORROWER",
        "NON_OCCUPANT_CO_BORROWER",
      ]);
      await tx.$executeRawUnsafe(BACKFILL());
      await tx.$executeRawUnsafe(FIVE_BORROWER_GUARD()).then(
        () => undefined,
        (error: unknown) => {
          raised = String(error);
        },
      );
    });

    expect(raised).toContain("BORROWER is 1:4 and these applications have more borrowing parties");
    expect(raised).toContain(app.id);
  });
});
