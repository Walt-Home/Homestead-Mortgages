/**
 * Who can open whose file.
 *
 * This is the one piece of this codebase where a subtle mistake exposes one
 * person's mortgage file to another, so the rules are pinned rather than
 * assumed — including the one that is easy to "fix" into a vulnerability:
 * a refusal for somebody else's file is a 404, not a 403. A 403 confirms the
 * id exists, which is an enumeration oracle for anyone holding a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("@hm/db", () => ({
  prisma: { loanFile: { findUnique }, fileEvent: { create: vi.fn() } },
}));

const { assertFileAccess } = await import("../services/repository.js");

const ME = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";
const FILE = "33333333-3333-3333-3333-333333333333";

async function outcome(mode: "read" | "write"): Promise<string> {
  try {
    await assertFileAccess(FILE, ME, mode);
    return "allowed";
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    return `${e.statusCode} ${e.code}`;
  }
}

describe("file access", () => {
  beforeEach(() => findUnique.mockReset());

  it("allows reading and writing your own file", async () => {
    findUnique.mockResolvedValue({ userId: ME, isDemo: false });
    expect(await outcome("read")).toBe("allowed");
    expect(await outcome("write")).toBe("allowed");
  });

  it("hides someone else's file behind a 404, never a 403", async () => {
    findUnique.mockResolvedValue({ userId: SOMEONE_ELSE, isDemo: false });
    // A 403 here would confirm the id exists. Both modes must look identical
    // to a file that was never created.
    expect(await outcome("read")).toBe("404 NOT_FOUND");
    expect(await outcome("write")).toBe("404 NOT_FOUND");
  });

  it("is indistinguishable from a file that does not exist", async () => {
    findUnique.mockResolvedValue({ userId: SOMEONE_ELSE, isDemo: false });
    const foreign = await outcome("read");
    findUnique.mockResolvedValue(null);
    const missing = await outcome("read");
    expect(foreign).toBe(missing);
  });

  it("lets everyone read the shared demo files", async () => {
    findUnique.mockResolvedValue({ userId: null, isDemo: true });
    expect(await outcome("read")).toBe("allowed");
  });

  it("refuses writes to a demo file, and says why", async () => {
    findUnique.mockResolvedValue({ userId: null, isDemo: true });
    // 403 is correct here and not an oracle: the file's existence is already
    // public to every signed-in user, so nothing is leaked by admitting it.
    expect(await outcome("write")).toBe("403 DEMO_FILE_READ_ONLY");
  });

  it("treats a demo file owned by someone as still read-only", async () => {
    // isDemo wins over ownership, so a seeded file cannot be edited by whoever
    // happened to run the seed script.
    findUnique.mockResolvedValue({ userId: SOMEONE_ELSE, isDemo: true });
    expect(await outcome("read")).toBe("allowed");
    expect(await outcome("write")).toBe("403 DEMO_FILE_READ_ONLY");
  });
});
