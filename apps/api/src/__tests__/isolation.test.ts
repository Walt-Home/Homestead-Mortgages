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
