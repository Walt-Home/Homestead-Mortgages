/**
 * The commit under the staff member's name: a short id linking to the commit
 * on GitHub, and nothing at all where the build named no commit.
 */

import { describe, expect, it } from "vitest";
import { BUILD_COMMIT, commitLink } from "../build.js";

describe("the commit the console was built from", () => {
  it("is the build's BUILD_COMMIT, and null when that names no full commit", () => {
    // Only the image's build sets it, so a test run reads null: the footer
    // shows nothing rather than a guess.
    const named = process.env.BUILD_COMMIT?.trim() ?? "";
    expect(BUILD_COMMIT).toBe(/^[0-9a-f]{40}$/.test(named) ? named : null);
  });

  it("reads as seven characters and links to the commit", () => {
    const commit = "4ef79e7cf019d78673dca626f3cde293e0073b9b";
    expect(commitLink(commit)).toEqual({
      label: "4ef79e7",
      href: "https://github.com/Walt-Home/Homestead-Mortgages/commit/4ef79e7cf019d78673dca626f3cde293e0073b9b",
    });
  });
});
