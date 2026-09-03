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
import { assertFileAccess } from "../services/repository.js";
import { createLoanFile, createUser } from "./support/factories.js";

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
