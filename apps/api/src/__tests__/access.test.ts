/**
 * Who can open whose file.
 *
 * This is the one piece of this codebase where a subtle mistake exposes one
 * person's mortgage file to another, so the rules are pinned rather than
 * assumed — including the one that is easy to "fix" into a vulnerability:
 * a refusal for somebody else's file is a 404, not a 403. A 403 confirms the
 * id exists, which is an enumeration oracle for anyone holding a session.
 *
 * These run against a real database. They used to mock `@hm/db` and assert
 * that `findUnique` had been called with what the author expected — which
 * cannot fail when the schema changes underneath it, and would have passed
 * just as happily if `isDemo` had been dropped from the select.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { connectorRouter } from "../routes/connectors.js";
import { assertFileAccess } from "../services/repository.js";
import type { BorrowerInput } from "../services/party.js";
import { createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const MISSING = "33333333-3333-3333-3333-333333333333";

async function outcome(fileId: string, userId: string, mode: "read" | "write"): Promise<string> {
  try {
    await assertFileAccess(fileId, userId, mode);
    return "allowed";
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    return `${e.statusCode} ${e.code}`;
  }
}

describe("file access", () => {
  it("allows reading and writing your own file", async () => {
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    expect(await outcome(file.id, me.id, "read")).toBe("allowed");
    expect(await outcome(file.id, me.id, "write")).toBe("allowed");
  });

  it("hides someone else's file behind a 404, never a 403", async () => {
    const me = await createUser();
    const them = await createUser();
    const theirs = await createLoanFile({ userId: them.id });
    // A 403 here would confirm the id exists. Both modes must look identical
    // to a file that was never created.
    expect(await outcome(theirs.id, me.id, "read")).toBe("404 NOT_FOUND");
    expect(await outcome(theirs.id, me.id, "write")).toBe("404 NOT_FOUND");
  });

  it("is indistinguishable from a file that does not exist", async () => {
    const me = await createUser();
    const them = await createUser();
    const theirs = await createLoanFile({ userId: them.id });
    const foreign = await outcome(theirs.id, me.id, "read");
    const missing = await outcome(MISSING, me.id, "read");
    expect(foreign).toBe(missing);
  });

  it("lets everyone read the shared demo files", async () => {
    const me = await createUser();
    const demo = await createLoanFile({ userId: null, isDemo: true });
    expect(await outcome(demo.id, me.id, "read")).toBe("allowed");
  });

  it("refuses writes to a demo file, and says why", async () => {
    const me = await createUser();
    const demo = await createLoanFile({ userId: null, isDemo: true });
    // 403 is correct here and not an oracle: the file's existence is already
    // public to every signed-in user, so nothing is leaked by admitting it.
    expect(await outcome(demo.id, me.id, "write")).toBe("403 DEMO_FILE_READ_ONLY");
  });

  it("treats a demo file owned by someone as still read-only", async () => {
    // isDemo wins over ownership, so a seeded file cannot be edited by whoever
    // happened to run the seed script.
    const me = await createUser();
    const them = await createUser();
    const demo = await createLoanFile({ userId: them.id, isDemo: true });
    expect(await outcome(demo.id, me.id, "read")).toBe("allowed");
    expect(await outcome(demo.id, me.id, "write")).toBe("403 DEMO_FILE_READ_ONLY");
  });

  it("treats a sample borrower's own file as read-only, for them too", async () => {
    // A persona file is a demo file that belongs to somebody: the persona sees
    // it under "Yours" and every tester can read it. What nobody may do —
    // including the persona whose file it is — is change it.
    const maya = await createUser({ personaKey: "maya_okafor" });
    const stranger = await createUser();
    const hers = await createLoanFile({ userId: maya.id, isDemo: true });

    expect(await outcome(hers.id, maya.id, "read")).toBe("allowed");
    expect(await outcome(hers.id, stranger.id, "read")).toBe("allowed");
    expect(await outcome(hers.id, maya.id, "write")).toBe("403 DEMO_FILE_READ_ONLY");
    expect(await outcome(hers.id, stranger.id, "write")).toBe("403 DEMO_FILE_READ_ONLY");
  });

  it("still hides a real person's file from a sample borrower", async () => {
    // The persona is an ordinary user as far as this rule is concerned, and
    // "readable by all" is a property of demo files, not of persona sessions.
    const maya = await createUser({ personaKey: "maya_okafor" });
    const them = await createUser();
    const theirs = await createLoanFile({ userId: them.id });
    expect(await outcome(theirs.id, maya.id, "read")).toBe("404 NOT_FOUND");
    expect(await outcome(theirs.id, maya.id, "write")).toBe("404 NOT_FOUND");
  });

  it("refuses a file that was deleted out from under the session", async () => {
    // Only reachable with a real database: the mocked version could not
    // distinguish "never existed" from "existed a moment ago".
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    expect(await outcome(file.id, me.id, "read")).toBe("allowed");
    const { prisma } = await import("@hm/db");
    await prisma.loanFile.delete({ where: { id: file.id } });
    expect(await outcome(file.id, me.id, "read")).toBe("404 NOT_FOUND");
  });
});

/** Screen 2's answers, for a person on somebody else's file. */
const someone: BorrowerInput = {
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
  statedMonthlyIncome: 8_500,
};

describe("a consent names a borrower on the file it is posted to", () => {
  it("refuses one from somebody else's file, as a 404", async () => {
    // The consent's trigger mirrors a grant onto whatever party the named
    // borrower points at, and the pins that follow borrow that person's facts
    // into this application. Without the check, a caller with a file of their
    // own could authorize verifications against a stranger by guessing an id —
    // and a 404 rather than a 403 keeps the id from being confirmed.
    const me = await createUser();
    const mine = await createLoanFile({ userId: me.id });
    const stranger = await createUser();
    const theirs = await createLoanFile({ userId: stranger.id });
    const theirBorrower = await saveBorrower(theirs.id, someone);

    const res = await callAs(me.id, [connectorRouter], "POST", `/${mine.id}/consents`, {
      kind: "verification_authorization",
      borrowerId: theirBorrower.id,
    });
    expect(res.status).toBe(404);
    expect(await prisma.consent.count()).toBe(0);
    expect(await prisma.authorization.count()).toBe(0);
  });
});
