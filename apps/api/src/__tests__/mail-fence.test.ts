/**
 * The fence around a real mailer on a deployment that must not write to
 * strangers: our domains go through, every other address is answered "not
 * delivered" with the reason and never reaches the adapter.
 */

import { describe, expect, it } from "vitest";
import { domainOf, fencedMailConnector, fixtureMailConnector } from "@hm/connectors";

const message = (to: string) => ({
  to,
  subject: "Hello",
  text: "A line.",
  audience: "staff" as const,
});

describe("the mail fence", () => {
  it("lets our domains through, tagged addresses included, and refuses the rest without sending", async () => {
    const inner = fixtureMailConnector();
    const mail = fencedMailConnector(inner, {
      allowedDomains: ["supermortgage.com", "trywalt.ai"],
    });

    expect((await mail.send(message("joe+northlight@supermortgage.com"))).status).toBe("sent");
    expect((await mail.send(message("Drew@TryWalt.ai"))).status).toBe("sent");
    expect(inner.outbox).toHaveLength(2);

    const tester = fencedMailConnector(inner, {
      allowedDomains: ["supermortgage.com"],
      allowedAddresses: ["JBaki91@yahoo.com"],
    });
    expect((await tester.send(message("jbaki91@yahoo.com"))).status).toBe("sent");
    expect((await tester.send(message("someone.else@yahoo.com"))).status).toBe("not_delivered");
    expect(inner.outbox).toHaveLength(3);

    const refused = await mail.send(message("maria.garcia@example.com"));
    expect(refused.status).toBe("not_delivered");
    expect(refused).toMatchObject({
      reason: expect.stringContaining("supermortgage.com, trywalt.ai"),
    });
    expect(inner.outbox).toHaveLength(3);
  });

  it("names the fence in what the deployment discloses, and refuses to be built with nothing allowed", () => {
    const mail = fencedMailConnector(fixtureMailConnector(), {
      allowedDomains: ["supermortgage.com"],
    });
    expect(mail.capabilities.provider).toBe("fixture-mail (supermortgage.com only)");
    expect(mail.capabilities.mode).toBe("fixture");
    expect(() => fencedMailConnector(fixtureMailConnector(), { allowedDomains: [] })).toThrow();
  });

  it("reads the domain after the last @, without case", () => {
    expect(domainOf("a@b@Example.COM")).toBe("example.com");
    expect(domainOf("nobody")).toBe("");
  });
});
