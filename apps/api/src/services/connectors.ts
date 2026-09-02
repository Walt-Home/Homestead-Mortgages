/**
 * Which adapter serves each connector.
 *
 * This used to be one `CONNECTOR_MODE` switch: everything fixture, or
 * everything real. That was fine while everything was a fixture and becomes
 * wrong the moment the first vendor lands, because they land one at a time and
 * over months — address autocomplete needs an API key and an afternoon,
 * a credit reseller needs a licence and a site inspection. An all-or-nothing
 * switch would force the whole registry to wait for the slowest member.
 *
 * So each connector reads its own variable and falls back to the fixture. The
 * boot log prints the resulting mix, because "which of these is real right
 * now?" is a question somebody will ask at the worst possible moment.
 */

import {
  fixtureRegistry,
  googlePlacesConnector,
  type ConnectorRegistry,
  type PersonaId,
} from "@hm/connectors";
import { config } from "../config.js";

let registry: ConnectorRegistry | undefined;

/** What each connector ended up using. Logged at boot and served by /health. */
export interface ProviderMix {
  readonly [connector: string]: string;
}

let mix: ProviderMix = {};

export function providerMix(): ProviderMix {
  connectors();
  return mix;
}

export function connectors(): ConnectorRegistry {
  if (registry) return registry;

  const fixtures = fixtureRegistry({ persona: config.fixturePersona as PersonaId });
  const chosen: Record<string, string> = Object.fromEntries(
    Object.entries(fixtures).map(([k, v]) => [k, (v as { capabilities: { provider: string } }).capabilities.provider]),
  );

  let propertyData = fixtures.propertyData;
  if (config.providers.propertyData === "google_places") {
    if (!config.googlePlacesApiKey) {
      // Failing at boot rather than at the first keystroke: an autocomplete
      // that silently returns nothing looks like a product with no addresses
      // in it.
      throw new Error(
        "PROPERTY_DATA_PROVIDER=google_places but GOOGLE_PLACES_API_KEY is not set.",
      );
    }
    propertyData = googlePlacesConnector({
      apiKey: config.googlePlacesApiKey,
      // Places knows which addresses exist and nothing else. The assessor
      // record, the valuation and the flood zone stay with the fixture until a
      // property-data vendor is wired.
      fallback: fixtures.propertyData,
    });
    chosen.propertyData = "google-places (+ fixture for records)";
  }

  registry = { ...fixtures, propertyData };
  mix = chosen;
  return registry;
}
