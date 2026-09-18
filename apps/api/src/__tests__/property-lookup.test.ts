/**
 * The lookup on a GET, for the vendor demo page.
 *
 * The same retrieval as the POST screen 1 makes, on the method a sample
 * borrower's read-only session is allowed. Each part of the answer names the
 * adapter that gave it, so a page cannot say a vendor answered when the
 * fixture did.
 */
import { describe, expect, it } from "vitest";
import { FloodNotDeterminedError, ValuationUnavailableError } from "@hm/connectors";
import { AppError } from "../middleware/error-handler.js";
import { propertyRouter, settleLookup } from "../routes/property.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const OAK = { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78704" };

const lookup = (userId: string, address: Record<string, string>) =>
  callAs<{
    record: { apn: string; propertyType: string };
    valuation: { value: number };
    flood: { zone: string };
    provider: string;
    providers: { record: string; valuation: string; flood: string };
  }>(
    userId,
    [propertyRouter],
    "GET",
    `/lookup?${new URLSearchParams(address)}`,
    undefined,
    "/api/property",
  );

describe("GET /property/lookup", () => {
  it("answers the same three things the POST does, naming who gave each", async () => {
    const user = await createUser();
    const res = await lookup(user.id, OAK);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.apn).toBe("0114230209");
    expect(res.body.valuation.value).toBeGreaterThan(0);
    expect(res.body.flood.zone).toBe("X");
    expect(res.body.provider).toBe("fixture-property");
    expect(res.body.providers).toEqual({
      record: "fixture-property",
      valuation: "fixture-avm",
      flood: "fixture-flood",
    });
    const posted = await callAs<{ providers: unknown }>(
      user.id,
      [propertyRouter],
      "POST",
      "/lookup",
      OAK,
      "/api/property",
    );
    expect(posted.body.providers).toEqual(res.body.providers);
  });

  it("is a not-found the page can explain when no record exists, and a 400 when the address is short", async () => {
    const user = await createUser();
    const missing = await lookup(user.id, { ...OAK, line1: "1 Nowhere Lane", postalCode: "00000" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "ADDRESS_NOT_FOUND" } });
    const short = await lookup(user.id, { line1: "x" });
    expect(short.status).toBe(400);
  });

  it("is a read, so a sample borrower's session may make it", async () => {
    const maya = await createUser({ personaKey: "maya_okafor" });
    const res = await lookup(maya.id, OAK);
    expect(res.status).toBe(200);
  });
});

describe("settling the three answers", () => {
  const ok = <T>(
    data: T,
    provider: string,
  ): PromiseFulfilledResult<{
    data: T;
    provider: string;
    retrievedAt: string;
    externalId: string;
  }> => ({
    status: "fulfilled",
    value: { data, provider, retrievedAt: "2026-09-18T00:00:00.000Z", externalId: "x" },
  });
  const failed = (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason });
  const record = ok({ apn: "1" } as never, "corelogic");

  it("keeps the record and reads an absent valuation or flood as null", () => {
    const settled = settleLookup([
      record,
      failed(new ValuationUnavailableError("1 W 72nd St")),
      failed(new FloodNotDeterminedError("1 W 72nd St")),
    ] as never);
    expect(settled.record.provider).toBe("corelogic");
    expect(settled.valuation).toBeNull();
    expect(settled.flood).toBeNull();
  });

  it("is the manual path only when the record itself is missing", () => {
    expect(() =>
      settleLookup([
        failed(new Error("no record")),
        ok(null as never, "x"),
        ok(null as never, "x"),
      ] as never),
    ).toThrow("no record");
    try {
      settleLookup([
        failed(
          Object.assign(new Error("No public record found for 1 Nowhere Ln."), {
            name: "AddressNotFoundError",
          }),
        ),
        ok(null as never, "x"),
        ok(null as never, "x"),
      ] as never);
    } catch (err) {
      // An AddressNotFoundError by class, not by name, is what maps to 404.
      expect(err).not.toBeInstanceOf(AppError);
    }
  });

  it("does not swallow a real failure behind an absence", () => {
    expect(() =>
      settleLookup([
        record,
        failed(new Error("the vendor is down")),
        ok(null as never, "x"),
      ] as never),
    ).toThrow("the vendor is down");
  });
});
