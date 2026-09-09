/**
 * Everything runs at the database's default isolation, and nothing says
 * otherwise.
 *
 * The TRID receipt refuses to run under REPEATABLE READ, because a concurrent
 * pin would be invisible to its count and the receipt silently missed
 * (`evidence.test.ts` proves the refusal). A pin can be reached from any route
 * that saves a person or a consent, so the moment one route's transaction
 * named an isolation level, that route would refuse the borrower's save with a
 * message about isolation. The simplest way to keep every transaction at READ
 * COMMITTED is for no production file to mention anything else, and this
 * test reads the source to say so.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "__tests__") continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.[cm]?ts$/.test(name)) out.push(path);
  }
  return out;
}

describe("transactions run at the default isolation", () => {
  it("names no isolation level anywhere in apps/api/src outside the tests", () => {
    const offenders = sources(src)
      .filter((file) => /isolationLevel/.test(readFileSync(file, "utf8")))
      .map((file) => relative(src, file));
    expect(offenders).toEqual([]);
  });

  it("is looking at the source it thinks it is", () => {
    // A test that scans an empty directory passes for the wrong reason.
    const files = sources(src).map((file) => relative(src, file));
    expect(files).toContain(join("services", "transition.ts"));
    expect(files).toContain(join("services", "evidence.ts"));
    expect(files.some((f) => f.startsWith("__tests__"))).toBe(false);
  });
});

describe("the persona seed cannot write a state by hand", () => {
  /**
   * The whole claim the sample borrowers make is that they were walked to
   * their states through the same services the four screens call. One
   * `tx.application.update` in this file would make that false, and nothing
   * downstream could tell: a forged status wears the same pill, and a forged
   * ledger row reads the same in the timeline as one somebody caused.
   *
   * A verb list rather than four literal strings. `updateMany`, `upsert`,
   * `createMany` and raw SQL are all the same forgery under another spelling,
   * and the four-string version this replaced matched none of them.
   *
   * Nested relation writes are the third spelling. A status set through
   * `loanFile.update({ data: { application: { update: … } } })` never names an
   * application delegate at all, so the verb list alone would wave it through.
   */
  const seed = () => readFileSync(join(src, "scripts", "seed-personas.ts"), "utf8");

  const VERBS = "create|createMany|update|updateMany|upsert|delete|deleteMany";
  const DELEGATES = new RegExp(
    `\\.(application|applicationTransition|regulatoryClock|applicationEvidenceLink|loanScenario|applicationParty)\\.(${VERBS})\\b`,
    "g",
  );
  const NESTED = new RegExp(
    `\\b(application|transitions|scenarios|pins|clocks|parties)\\s*:\\s*\\{\\s*(${VERBS}|connectOrCreate|set)\\b`,
    "g",
  );
  const RAW = /\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)\b/g;

  it("touches none of the tables that hold an application's state", () => {
    expect(seed().match(DELEGATES) ?? []).toEqual([]);
  });

  it("reaches none of them through a relation either", () => {
    expect(seed().match(NESTED) ?? []).toEqual([]);
  });

  it("runs no raw SQL", () => {
    expect(seed().match(RAW) ?? []).toEqual([]);
  });

  it("is reading the seed, and the patterns match what they claim to", () => {
    // A regex that matches nothing passes for the wrong reason, and so does a
    // path that reads an empty file.
    const source = seed();
    expect(source).toContain("export async function seedAll");
    expect("await tx.application.update({ where: { id } })").toMatch(DELEGATES);
    expect("await tx.applicationTransition.createMany({})").toMatch(DELEGATES);
    expect("await tx.regulatoryClock.upsert({})").toMatch(DELEGATES);
    expect("await tx.$executeRawUnsafe(sql)").toMatch(RAW);
    expect(
      'tx.loanFile.update({ data: { application: { update: { status: "FUNDED" } } } })',
    ).toMatch(NESTED);
    expect("tx.application.create({ data: { transitions: { createMany: rows } } })").toMatch(
      NESTED,
    );
    // And a read through the same relation is not a write.
    expect("select: { application: { select: { status: true } } }").not.toMatch(NESTED);
  });
});

describe("the signature and the move it causes are one write", () => {
  /**
   * Read out of the source, because a crash between two committed
   * transactions cannot be staged from inside one.
   *
   * `applicationSignedAt` is a latch: no route sets it twice, and nothing
   * un-sets it. So a signature that commits before the ledger row that follows
   * it leaves a file signed with its application still owing us the signature
   * it already has — and no later request can repair that, because every
   * writer of the move reads the latch and finds it already set.
   */
  const route = () => readFileSync(join(src, "routes", "application.ts"), "utf8");

  it("writes the latch inside the transaction that settles the application", () => {
    const source = route();
    const start = source.indexOf("await prisma.$transaction(async (tx) => {");
    expect(start, "the sign route no longer opens a transaction").toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("\n    });", start));

    expect(block).toContain("tx.loanFile.update");
    expect(block).toContain("applicationSignedAt");
    expect(block).toContain("settleBorrowerAct");
    // And nowhere else: a second writer outside the transaction is the bug
    // back again under another name.
    expect(source.match(/applicationSignedAt: new Date\(\)/g)).toHaveLength(1);
    expect(source).not.toContain("prisma.loanFile.update");
  });
});
