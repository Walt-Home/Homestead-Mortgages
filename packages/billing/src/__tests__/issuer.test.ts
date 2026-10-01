import { describe, expect, it } from "vitest";
import { ISSUER, invoiceFooter, issuerAddressLine, issuerAgrees } from "../issuer.js";

describe("the issuer", () => {
  it("is Tomorrow OS Inc. doing business as Supermortgage, at the address its terms give", () => {
    expect(ISSUER.name).toBe("Tomorrow OS Inc. dba Supermortgage");
    expect(ISSUER.termsUrl).toMatch(/^https:\/\/supermortgage\.com\//);
    expect(issuerAddressLine()).toBe("2261 Market Street, Suite 86665, San Francisco, CA 94114");
  });

  it("recognizes the names Stripe might print for us, and nobody else's", () => {
    expect(issuerAgrees("Supermortgage")).toBe(true);
    expect(issuerAgrees("Tomorrow OS Inc.")).toBe(true);
    expect(issuerAgrees("Tomorrow OS, Inc.")).toBe(true);
    expect(issuerAgrees("Tomorrow OS Inc. dba Supermortgage")).toBe(true);
    expect(issuerAgrees("SUPERMORTGAGE")).toBe(true);
    expect(issuerAgrees("HMX sandbox")).toBe(false);
    expect(issuerAgrees("Tomorrow")).toBe(false);
    expect(issuerAgrees("")).toBe(false);
    expect(issuerAgrees(null)).toBe(false);
  });

  it("prints a footer naming the issuer, the payment method, the terms and where to write", () => {
    const footer = invoiceFooter({ payable: "ACH debit" });
    expect(footer).toBe(
      "Issued by Tomorrow OS Inc. dba Supermortgage, 2261 Market Street, Suite 86665, " +
        "San Francisco, CA 94114. Payable by ACH debit. " +
        "Governed by the terms at https://supermortgage.com/terms.html. " +
        "Questions: support@supermortgage.com.",
    );
    expect(
      invoiceFooter({ payable: "ACH debit", termsUrl: "https://supermortgage.com/partners.html" }),
    ).toContain("terms at https://supermortgage.com/partners.html.");
  });
});
