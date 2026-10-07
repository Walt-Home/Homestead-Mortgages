/**
 * The borrower-mail switch, at the port.
 *
 * Joe's rule of 5 October 2026 — nobody who is a borrower or a homeowner is
 * e-mailed until a deployment's switch says so — used to live in one
 * service. Here it lives in the port, so the test is about the port: a
 * message for a borrower is answered "not delivered" while the switch is
 * off, whoever built it; staff and servicer messages pass either way; and
 * the switch is read on every send, not once at build.
 */

import { describe, expect, it } from "vitest";
import { BORROWER_MAIL_OFF_REASON, borrowerMailSwitch, fixtureMailConnector } from "../index.js";

function message(audience: "borrower" | "servicer" | "staff") {
  return { to: `${audience}@example.test`, subject: "hello", text: "hi", audience };
}

describe("the borrower-mail switch", () => {
  it("holds a borrower's message while the switch is off, and says why", async () => {
    const inner = fixtureMailConnector();
    const mail = borrowerMailSwitch(inner, { on: () => false });
    const out = await mail.send(message("borrower"));
    expect(out).toEqual({ status: "not_delivered", reason: BORROWER_MAIL_OFF_REASON });
    expect(inner.outbox).toHaveLength(0);
  });

  it("lets staff and servicer mail through while the switch is off", async () => {
    const inner = fixtureMailConnector();
    const mail = borrowerMailSwitch(inner, { on: () => false });
    expect((await mail.send(message("staff"))).status).toBe("sent");
    expect((await mail.send(message("servicer"))).status).toBe("sent");
    expect(inner.outbox.map((m) => m.audience)).toEqual(["staff", "servicer"]);
  });

  it("reads the switch on every send, so a deployment flipped in place is honored", async () => {
    const inner = fixtureMailConnector();
    let on = false;
    const mail = borrowerMailSwitch(inner, { on: () => on });
    expect((await mail.send(message("borrower"))).status).toBe("not_delivered");
    on = true;
    expect((await mail.send(message("borrower"))).status).toBe("sent");
    expect(inner.outbox).toHaveLength(1);
  });

  it("changes nothing about the mailer it wraps but the one answer", () => {
    const inner = fixtureMailConnector();
    const mail = borrowerMailSwitch(inner, { on: () => true });
    expect(mail.capabilities).toBe(inner.capabilities);
  });
});
