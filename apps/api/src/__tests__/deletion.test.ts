/**
 * Deletion has to actually delete.
 *
 * The privacy page tells a person their data is removed "for good — there is
 * no archive and no undo." That sentence is a promise, and the thing that
 * makes it true is the cascade: every child of a loan file, and every loan
 * file of a user, has onDelete: Cascade. Identity is on the party, and
 * users.party_id cannot cascade upward, so the users_delete_takes_party
 * trigger removes the person — and only the real-database test at the bottom
 * can see it. The schema-text tests fail at review time; the database test
 * fails before a stranger has asked to be forgotten.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { BorrowerInput } from "../services/party.js";
import { saveBorrower } from "./bridge.test.js";
import { createLoanFile, createUser } from "./support/factories.js";

const schema = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/prisma/schema.prisma"),
  "utf8",
);

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

describe("deletion cascades", () => {
  it("removes every child of a loan file", () => {
    const relations = [...schema.matchAll(/^\s*loanFile\s+LoanFile.*$/gm)].map((m) => m[0]);
    // If this drops to zero the regex has rotted, not the schema.
    expect(relations.length).toBeGreaterThan(8);
    const notCascading = relations.filter((r) => !r.includes("onDelete: Cascade"));
    expect(notCascading).toEqual([]);
  });

  it("removes every loan file of a deleted user", () => {
    const relation = /user\s+User\?\s+@relation\([^)]*\)/.exec(schema)?.[0] ?? "";
    expect(relation).toContain("onDelete: Cascade");
  });

  it("ties borrower rows to the file, and every record about a person to the party", () => {
    const borrower = schema.slice(schema.indexOf("model Borrower"));
    expect(borrower.slice(0, borrower.indexOf("@@map"))).toMatch(
      /loanFile\s+LoanFile\s+@relation\([^)]*onDelete: Cascade/,
    );
    for (const model of [
      "model Fact ",
      "model Principal ",
      "model Authorization ",
      "model ApplicationParty ",
    ]) {
      const block = schema.slice(schema.indexOf(model));
      expect(block.slice(0, block.indexOf("@@map"))).toMatch(
        /party\s+Party\??\s+@relation\([^)]*onDelete: Cascade/,
      );
    }
  });
});

describe("deleting the account deletes the person", () => {
  it("leaves no party, no fact, no principal and no authorization behind", async () => {
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "203.0.113.9",
        userAgent: "t",
      },
    });
    await prisma.user.delete({ where: { id: me.id } });
    expect(await prisma.party.count({ where: { id: row.partyId } })).toBe(0);
    expect(await prisma.fact.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.principal.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.authorization.count({ where: { partyId: row.partyId } })).toBe(0);
  });
});
