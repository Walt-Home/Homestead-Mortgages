import { describe, expect, it } from "vitest";
import { defaultVestingSentence, vestingAnswered, vestingBody } from "../vesting.js";

const DANA = { firstName: "Dana", lastName: "Whitfield" };
const THEO = { firstName: "Theo", lastName: "Okafor" };

describe("how title will read", () => {
  it("defaults to every name on the file, joined the way the corpus does", () => {
    expect(defaultVestingSentence([DANA])).toBe("Dana Whitfield");
    expect(defaultVestingSentence([DANA, THEO])).toBe("Dana Whitfield and Theo Okafor");
  });

  it("is answered once the sentence is there, and the manner when two names are", () => {
    const one = { proposedName: "Dana Whitfield", vestingType: "" as const, currentName: "" };
    expect(vestingAnswered(one, 1, false)).toBe(true);
    expect(vestingAnswered(one, 2, false)).toBe(false);
    expect(vestingAnswered({ ...one, vestingType: "TenantsInCommon" }, 2, false)).toBe(true);
    expect(vestingAnswered(one, 1, true)).toBe(false);
    expect(vestingAnswered({ ...one, currentName: "Dana Whitfield" }, 1, true)).toBe(true);
  });

  it("posts an empty manner as null, and a current title only on a refinance", () => {
    const form = {
      proposedName: " Dana Whitfield ",
      vestingType: "" as const,
      currentName: "Dana W",
    };
    expect(vestingBody(form, false)).toEqual({
      proposed: { fullName: "Dana Whitfield", vestingType: null },
      current: null,
    });
    expect(vestingBody(form, true).current).toEqual({ fullName: "Dana W", vestingType: null });
  });
});
