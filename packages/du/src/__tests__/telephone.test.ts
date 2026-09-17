/**
 * A telephone number reaches the wire as ten digits, however a person typed
 * it. Every seeded file was refused at the gate over `512-555-0134` — twelve
 * characters at a destination that takes ten — before this existed.
 */
import { describe, expect, it } from "vitest";
import { telephoneDigits } from "../assemble/parties.js";

describe("a telephone number on the wire", () => {
  it("is the ten digits a person typed, whatever they typed around them", () => {
    expect(telephoneDigits("512-555-0134")).toBe("5125550134");
    expect(telephoneDigits("(512) 555-0134")).toBe("5125550134");
    expect(telephoneDigits("512.555.0134")).toBe("5125550134");
    expect(telephoneDigits("+1 512 555 0134")).toBe("5125550134");
    expect(telephoneDigits("5125550134")).toBe("5125550134");
  });

  it("does not invent a number that fits", () => {
    // Nine digits stay nine; the preflight refuses them by length.
    expect(telephoneDigits("555-0134")).toBe("5550134");
    expect(telephoneDigits(null)).toBeNull();
  });
});
