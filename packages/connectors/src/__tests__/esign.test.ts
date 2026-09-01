/**
 * The e-sign adapter, which had two faults worth pinning.
 *
 * It had no caller at all, so INC-008 could never be satisfied and the IRS
 * screen was a terminal dead end with three screens unreachable behind it.
 * And it kept envelopes in a Map on the instance, which works on one process
 * and fails intermittently the moment Cloud Run scales past one — created on
 * instance A, completed against instance B, not found.
 */

import { describe, expect, it } from "vitest";
import type { LoanFile } from "@hm/shared";
import { fixtureEsignConnector } from "../index.js";

const file = { id: "f", consents: [] } as unknown as LoanFile;

describe("e-sign", () => {
  it("completes an envelope created by a DIFFERENT adapter instance", async () => {
    // Two instances stand in for two Cloud Run containers.
    const a = fixtureEsignConnector({ latencyMs: 0 });
    const b = fixtureEsignConnector({ latencyMs: 0 });

    const { envelopeId } = await a.createEnvelope(file, "form_4506c", "borrower-1");
    const consent = await b.getCompletedConsent(envelopeId);

    expect(consent).not.toBeNull();
    expect(consent?.kind).toBe("form_4506c");
    expect(consent?.borrowerId).toBe("borrower-1");
  });

  it("refuses an envelope id it did not mint", async () => {
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    expect(await esign.getCompletedConsent("not-an-envelope")).toBeNull();
    expect(await esign.getCompletedConsent("fixture-envelope.only-two-parts")).toBeNull();
  });

  it("round-trips every signable document", async () => {
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    for (const kind of ["verification_authorization", "econsent", "form_4506c"] as const) {
      const { envelopeId } = await esign.createEnvelope(file, kind, "b1");
      expect((await esign.getCompletedConsent(envelopeId))?.kind).toBe(kind);
    }
  });

  it("claims the three requirements a signature satisfies", () => {
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    expect(esign.capabilities.satisfies).toEqual(
      expect.arrayContaining(["APP-005", "APP-012", "INC-008"]),
    );
  });
});
