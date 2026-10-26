/**
 * The rail's sections: the Gym is offered to a staff session as a page of
 * its own, and the partner portal never offers it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GYM_HREF, isPage, navGroups } from "../nav.js";

const groups = navGroups({ queue: 3, kind: () => 1 });
const items = groups.flatMap((g) => g.items);

/** Every source file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the ops console's sections", () => {
  it("offers the Gym once, as a full page at its own address on this host", () => {
    const gym = items.filter((i) => i.label === "Gym");
    expect(gym).toHaveLength(1);
    expect(isPage(gym[0]!)).toBe(true);
    expect(gym[0]).toMatchObject({ href: "/console/hm/gym/" });
    expect(GYM_HREF).toBe("/console/hm/gym/");
    // Not a route of the console's router, which would draw the console's own fallback instead.
    for (const i of items) if (!isPage(i)) expect(i.to).not.toMatch(/gym/);
  });

  it("keeps every other section a route of the console, with its counts", () => {
    const pages = items.filter(isPage);
    expect(pages.map((p) => p.label)).toEqual(["Gym"]);
    expect(items.find((i) => i.label === "Queue")).toMatchObject({ to: "/", count: 3 });
  });

  it("is never in the partner portal", () => {
    const portal = fileURLToPath(new URL("../../partners", import.meta.url));
    const files = sources(portal);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/hm\/gym|GYM_HREF|lib\/nav/);
    }
  });
});
