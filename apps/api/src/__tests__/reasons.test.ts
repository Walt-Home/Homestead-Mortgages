/**
 * Every reason the API writes is a reason the vocabulary knows.
 *
 * `application_transitions.reason_code` is free text in the database, so what
 * keeps a report's buckets from filling with one-offs is `TRANSITION_REASONS`
 * and the signature that takes it. TypeScript already refuses an unlisted
 * spelling at a typed call site — which is exactly why this is worth reading
 * out of the source instead: a raw query, a cast, or a literal assembled from
 * a string would slip past the compiler, and the first sign of it would be a
 * ledger row nobody can group.
 *
 * It also fails the other way, on purpose. A scan that matched nothing would
 * pass silently, so the count is asserted too.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRANSITION_REASONS } from "@hm/shared";

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

/** Every string literal on a line that sets a reason code, in either spelling. */
function reasonsWritten(): string[] {
  const found = new Set<string>();
  for (const file of sources(src)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!/reasonCode|reason_code/.test(line)) continue;
      for (const match of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

describe("the reasons the API writes", () => {
  it("are all in the closed set", () => {
    for (const reason of reasonsWritten()) {
      expect(TRANSITION_REASONS, reason).toContain(reason);
    }
  });

  it("found the ones this slice writes, so the scan is not looking at nothing", () => {
    // The intake pair: what the receipt stamped, and what follows it.
    expect(reasonsWritten()).toEqual(
      expect.arrayContaining(["bank_already_connected", "bank_connection_needed"]),
    );
  });
});
