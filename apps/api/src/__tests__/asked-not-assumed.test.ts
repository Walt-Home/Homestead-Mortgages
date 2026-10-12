/**
 * Screen 2 records what a person said, and nothing for what they were not
 * asked.
 *
 * `identitySchema` carried `.default("us_citizen")`, `.default("en")` and
 * `.default(false)`, and the projection read a missing language as "en" and
 * a missing military fact as false. So a body that said nothing about any of
 * them wrote three facts under the borrower's principal, and a party nobody
 * had asked projected as a U.S. citizen, English-speaking, civilian. The
 * first-time-buyer flag came off the county record on screen 2 and was sent
 * `true` when there was no record, then `?? true` again at signing.
 *
 * Citizenship is required and never filled in; language and military service
 * are three-state like `firstTimeHomebuyer` and `currentHousing` already were;
 * and the first-time flag reads off the person's own answer to URLA 5a.1.1.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { fileRouter } from "../routes/files.js";
import { firstTimeHomebuyerOf, loadLoanFile } from "../services/repository.js";
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

/** Screen 2 with the three questions this test is about left out. */
const UNASKED = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "6789",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  firstTimeHomebuyer: null,
  demographics: null,
};

async function startFile() {
  const user = await createUser();
  const res = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(res.status).toBe(201);
  return { user, fileId: res.body.id };
}

const factsOn = (partyId: string, predicates: string[]) =>
  prisma.fact.findMany({
    where: { partyId, predicate: { in: predicates }, retractedAt: null },
    select: { predicate: true, value: true },
  });

describe("citizenship", () => {
  it("is refused when absent, never filled in", async () => {
    const { user, fileId } = await startFile();
    const { citizenship: _dropped, ...body } = UNASKED;
    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, body);
    expect(res.status).toBe(400);
    expect(await prisma.borrower.count({ where: { loanFileId: fileId } })).toBe(0);
  });
});

describe("language and military service", () => {
  it("are null until asked, and write no fact", async () => {
    const { user, fileId } = await startFile();
    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, UNASKED);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const file = (await loadLoanFile(fileId))!;
    const me = file.borrowers[0]!;
    expect(me.preferredLanguage).toBeNull();
    expect(me.isMilitary).toBeNull();
    expect(me.firstTimeHomebuyer).toBeNull();
    expect(
      await factsOn(me.partyId, ["preferred_language", "is_military", "first_time_homebuyer"]),
    ).toEqual([]);
  });

  it("record the answer given, and a later save that does not carry them leaves it standing", async () => {
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, {
      ...UNASKED,
      preferredLanguage: "es",
      isMilitary: true,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    let me = (await loadLoanFile(fileId))!.borrowers[0]!;
    expect(me.preferredLanguage).toBe("es");
    expect(me.isMilitary).toBe(true);

    // The review screen's revisit: the row re-sent without the two.
    const again = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, UNASKED);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    me = (await loadLoanFile(fileId))!.borrowers[0]!;
    expect(me.preferredLanguage).toBe("es");
    expect(me.isMilitary).toBe(true);
    expect(await factsOn(me.partyId, ["preferred_language", "is_military"])).toHaveLength(2);
  });
});

describe("the first-time-buyer flag", () => {
  it("is the person's own answer to 5a.1.1 when they were asked it", () => {
    expect(firstTimeHomebuyerOf("purchase", null, { homeownerPastThreeYears: "No" })).toBe(true);
    expect(firstTimeHomebuyerOf("purchase", null, { homeownerPastThreeYears: "Yes" })).toBe(false);
    // The asked answer wins over whatever fact the party carries.
    expect(firstTimeHomebuyerOf("purchase", true, { homeownerPastThreeYears: "Yes" })).toBe(false);
  });

  it("is false on a refinance, which is of a home the person owns", () => {
    expect(firstTimeHomebuyerOf("rate_term_refinance", null, null)).toBe(false);
    expect(firstTimeHomebuyerOf("cash_out_refinance", true, null)).toBe(false);
  });

  it("is otherwise the party's own fact, or nothing", () => {
    expect(firstTimeHomebuyerOf("purchase", true, null)).toBe(true);
    expect(firstTimeHomebuyerOf("purchase", null, null)).toBeNull();
    expect(firstTimeHomebuyerOf("purchase", null, { homeownerPastThreeYears: null })).toBeNull();
    expect(firstTimeHomebuyerOf(null, null, null)).toBeNull();
  });
});
