/**
 * The one-time code, against the vectors the RFCs publish.
 *
 * `services/totp.ts` is hand-rolled, and this is the whole of the argument
 * for that being safe: RFC 4226 Appendix D lists ten HOTP codes for a known
 * secret and RFC 6238 Appendix B lists six TOTP codes at six moments, and an
 * implementation that reproduces all sixteen is the algorithm. Nothing here
 * touches the database; the file sits in this suite because the suite is
 * where the API's tests live.
 */

import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  otpauthUri,
  totpAt,
  totpStep,
} from "../services/totp.js";

/** The secret both appendices use: the ASCII digits 1–9, 0, twice over. */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("HOTP, RFC 4226 Appendix D", () => {
  const CODES = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it("reproduces the ten published codes", () => {
    CODES.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });
});

describe("TOTP, RFC 6238 Appendix B (SHA-1)", () => {
  const VECTORS: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it("reproduces the six published codes at eight digits", () => {
    for (const [seconds, code] of VECTORS) {
      expect(totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(code);
    }
  });

  it("keeps a leading zero", () => {
    // 07081804 is in the table for exactly this reason.
    expect(totpAt(RFC_SECRET, 1111111109 * 1000, 8)).toHaveLength(8);
  });
});

describe("base32, RFC 4648", () => {
  it("encodes the published vectors without padding", () => {
    expect(base32Encode(Buffer.from(""))).toBe("");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
    expect(base32Encode(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("decodes what a person types: lowercase, spaces, dashes, padding", () => {
    expect(base32Decode("mzxw 6ytb-oi======").toString()).toBe("foobar");
  });

  it("round-trips a twenty-byte secret", () => {
    const secret = Buffer.from("0123456789abcdef0123", "ascii");
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });
});

describe("matching a code", () => {
  const at = 1_700_000_000_000;
  const step = totpStep(at);

  it("accepts the current step and one either side, and says which", () => {
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), at)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), at)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), at)).toBe(step + 1);
  });

  it("refuses a code two steps away", () => {
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), at)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), at)).toBeNull();
  });

  it("refuses anything that is not six digits, before it compares", () => {
    expect(matchTotp(RFC_SECRET, "12345", at)).toBeNull();
    expect(matchTotp(RFC_SECRET, "1234567", at)).toBeNull();
    expect(matchTotp(RFC_SECRET, "abcdef", at)).toBeNull();
    expect(matchTotp(RFC_SECRET, "", at)).toBeNull();
  });
});

describe("the otpauth URI", () => {
  it("names the issuer twice, because the apps disagree about where to read it", () => {
    const uri = otpauthUri({ issuer: "Supermortgage", account: "a@b.test", secret: "MZXW6YTB" });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(decodeURIComponent(parsed.pathname)).toBe("/Supermortgage:a@b.test");
    expect(parsed.searchParams.get("issuer")).toBe("Supermortgage");
    expect(parsed.searchParams.get("secret")).toBe("MZXW6YTB");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });
});
