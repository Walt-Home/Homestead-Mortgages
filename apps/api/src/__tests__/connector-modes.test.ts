/**
 * One reading of the deployment, served to two audiences.
 *
 * A borrower's screen may say "a soft pull, this does not affect your score"
 * only where a credit reseller is behind the route, and an operator asking
 * `/api/health` "is this real yet?" is asking the same question. The failure
 * worth ruling out is not that either answer is wrong — it is that they are
 * two answers. A disclosure computed from one copy of the configuration and a
 * health check computed from another can disagree indefinitely without either
 * of them ever looking broken.
 *
 * So both come out of `providerModes()`, and `providerModes()` reads the
 * registry that actually answers requests rather than the variables that were
 * supposed to build it.
 */

import { describe, expect, it } from "vitest";
import { authRouter } from "../routes/auth.js";
import { healthRouter } from "../routes/health.js";
import { connectors, providerModes } from "../services/connectors.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const MODES = new Set(["fixture", "sandbox", "production"]);

describe("what each connector is, said once", () => {
  it("reads every mode off the registry that will serve the request", () => {
    const registry = connectors() as unknown as Record<string, { capabilities: { mode: string } }>;
    const modes = providerModes();

    expect(Object.keys(modes).sort()).toEqual(Object.keys(registry).sort());
    for (const [name, connector] of Object.entries(registry)) {
      expect(modes[name]).toBe(connector.capabilities.mode);
      expect(MODES.has(connector.capabilities.mode)).toBe(true);
    }
  });

  it("hands the client and the health check the same answer", async () => {
    const user = await createUser();
    const config = await callAs<{ connectorModes: Record<string, string> }>(
      user.id,
      [authRouter],
      "GET",
      "/config",
      undefined,
      "/api/auth",
    );
    const health = await callAs<{ connectorModes: Record<string, string> }>(
      user.id,
      [healthRouter],
      "GET",
      "/",
      undefined,
      "/api/health",
    );

    expect(config.status).toBe(200);
    expect(health.status).toBe(200);
    expect(config.body.connectorModes).toEqual(providerModes());
    expect(health.body.connectorModes).toEqual(config.body.connectorModes);
  });

  /**
   * The flag this replaced. `identityRequiresRedirect` was true whenever
   * identity was not a fixture, and screen 2 used it for two things: whether
   * the button leaves the site, which that answers, and whether to warn about
   * Stripe's test mode, which it does not — a live key would have left the
   * warning standing over a real document check. A client cannot recover the
   * second question from a boolean, so the boolean is gone.
   */
  it("no longer answers with a bit that cannot tell sandbox from live", async () => {
    const user = await createUser();
    const config = await callAs<Record<string, unknown>>(
      user.id,
      [authRouter],
      "GET",
      "/config",
      undefined,
      "/api/auth",
    );
    expect(config.body).not.toHaveProperty("identityRequiresRedirect");
    expect(config.body.connectorModes).toHaveProperty("identity");
  });
});
