/**
 * Whose mortgage this is, and what a stranger learns by asking.
 *
 * `assertFileAccess` answers the same question about a file and cannot be
 * reused: it is keyed on `loan_files.user_id`, and a mortgage belongs to the
 * PARTY behind a session — which is how a co-borrower reaches the same loan
 * through a row of their own, and how one person's second application reaches
 * the party they already are.
 *
 * The property that matters is not that a stranger is refused. It is that a
 * stranger cannot tell a mortgage that exists from one that does not, because a
 * refusal that names the reason is an enumeration oracle for anybody holding a
 * session. So the two outcomes are asserted equal to each other rather than
 * each asserted to be a 404.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { assertLoanAccess } from "../services/loans.js";
import { partyForUser } from "../services/party.js";
import { createParty, createUser, importedLoan } from "./support/factories.js";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The service with its prose taken out.
 *
 * Both assertions below are about what the code does, and the file explains at
 * length what it deliberately does NOT do — so a grep over the raw text finds
 * the words in the paragraph arguing against them and reports the argument as
 * the offense.
 */
const service = readFileSync(resolve(src, "services/loans.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

/** What the caller actually sees: the status, the code and the words. */
async function refusal(loanId: string, userId: string) {
  try {
    await assertLoanAccess(prisma, loanId, userId);
    return { threw: false };
  } catch (err) {
    const e = err as AppError;
    return { threw: true, statusCode: e.statusCode, code: e.code, message: e.message };
  }
}

describe("a loan belongs to the party behind the session", () => {
  it("gives a party's own loan to the person that party signed in as", async () => {
    const me = await createUser();
    const partyId = await partyForUser(prisma, me.id);
    const made = await importedLoan([{ partyId }]);

    const loan = await assertLoanAccess(prisma, made.id, me.id);
    expect(loan.id).toBe(made.id);
    expect(loan.status).toBe("IMPORTED_UNCLAIMED");
  });

  it("gives a two-party mortgage to both of them", async () => {
    // The reason there is no `loans.party_id`. A co-borrower is not a guest on
    // somebody else's record; they reach it through a row of their own.
    const one = await createUser();
    const two = await createUser();
    const made = await importedLoan([
      { partyId: await partyForUser(prisma, one.id) },
      { partyId: await partyForUser(prisma, two.id), role: "CO_BORROWER" },
    ]);

    expect((await assertLoanAccess(prisma, made.id, one.id)).id).toBe(made.id);
    expect((await assertLoanAccess(prisma, made.id, two.id)).id).toBe(made.id);
  });

  it("answers a stranger exactly as it answers a loan that does not exist", async () => {
    const owner = await createUser();
    const made = await importedLoan([{ partyId: await partyForUser(prisma, owner.id) }]);
    const stranger = await createUser();
    await partyForUser(prisma, stranger.id);

    const someoneElses = await refusal(made.id, stranger.id);
    const nothingAtAll = await refusal(randomUUID(), stranger.id);

    expect(someoneElses.threw).toBe(true);
    // Equal to EACH OTHER, which is the assertion. Two refusals that are both
    // 404s can still differ in a word and tell an enumerator the id is real.
    expect(someoneElses).toEqual(nothingAtAll);
    expect(someoneElses).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("answers a person with no party the same way", async () => {
    // Nobody's party is on the loan, so nobody's session reaches it — and a
    // person who has never had anything written about them is refused by the
    // same statement rather than by a branch above it.
    const owner = await createUser();
    const made = await importedLoan([{ partyId: await partyForUser(prisma, owner.id) }]);
    const fresh = await createUser();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({
      partyId: null,
    });

    expect(await refusal(made.id, fresh.id)).toEqual(await refusal(randomUUID(), fresh.id));
  });

  it("does not hand a loan to a party nobody has signed in as", async () => {
    // An imported mortgage sits on a provisional party for as long as nobody
    // claims it. Until a user row points at that party there is no session
    // that reaches the loan, which is what makes the record inert.
    const provisional = await createParty({ sourceFirstSeen: "grander_import" });
    const made = await importedLoan([{ partyId: provisional.id }]);
    const anybody = await createUser();

    expect(await refusal(made.id, anybody.id)).toMatchObject({ statusCode: 404 });
    expect(await prisma.loanParty.count({ where: { loanId: made.id } })).toBe(1);
  });
});

describe("what the access primitive did not copy", () => {
  it("has no demo carve-out", async () => {
    // `assertFileAccess` checks isDemo BEFORE ownership, which is right for a
    // sample file everybody is meant to read and would be catastrophic here: a
    // demo mortgage would be a mortgage readable by every signed-in user.
    expect(service).not.toMatch(/isDemo/);
  });

  it("never answers 403", async () => {
    // A 403 says "this exists and is not yours", which is the sentence this
    // whole file is about not saying.
    expect(service).not.toMatch(/\b403\b/);
  });
});

describe("nothing about a loan is reachable without a session", () => {
  it("keeps sign-in the only way in for a person, with three routers above the gate", async () => {
    // Health, auth and partner, and nothing else, sit above `app.use("/api",
    // requireAuth)`. Whatever a loan route a PERSON reaches eventually is, it
    // goes below it — and this is the line that has to move for that to stop
    // being true. The partner router is above it because a servicer's key is
    // not a session; it carries a gate of its own that reads the bearer
    // header and never the session, so it hands nothing to a person, signed
    // in or not — `partner-credential.test.ts` walks both refusals.
    const index = readFileSync(resolve(src, "index.ts"), "utf8");
    const above = index.slice(0, index.indexOf('app.use("/api", requireAuth)'));
    const routers = [...above.matchAll(/app\.use\([^)]*?(\w+Router)\)/g)].map((m) => m[1]);
    expect(routers).toEqual(["partnerRouter", "healthRouter", "authRouter"]);
  });
});
