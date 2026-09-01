/**
 * The connector registry this process uses.
 *
 * One place decides which adapters are live, and it reads `CONNECTOR_MODE`
 * rather than assuming. Today only "fixture" is implemented; the switch throws
 * loudly on anything else so a misconfigured deploy fails at boot instead of
 * quietly serving fixture data to a real borrower.
 */

import { fixtureRegistry, type ConnectorRegistry, type PersonaId } from "@hm/connectors";
import { config } from "../config.js";

let registry: ConnectorRegistry | undefined;

export function connectors(): ConnectorRegistry {
  if (registry) return registry;

  switch (config.connectorMode) {
    case "fixture":
      registry = fixtureRegistry({ persona: config.fixturePersona as PersonaId });
      return registry;
    case "sandbox":
    case "production":
      throw new Error(
        `CONNECTOR_MODE=${config.connectorMode} but no vendor adapters are implemented. ` +
          `See docs/decisions.md — V1 ships fixture adapters behind the real ports.`,
      );
  }
}
