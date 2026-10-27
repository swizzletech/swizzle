import { clickupProviderAdapter } from "./clickup.js";
import { createCustomOAuth2Adapter, parseCustomOAuth2ProviderConfig } from "./custom-oauth2.js";
import { ConnectionProviderError } from "./errors.js";
import { githubProviderAdapter } from "./github.js";
import { googleProviderAdapter } from "./google.js";
import { createMicrosoftAdapter, parseMicrosoftProviderConfig } from "./microsoft.js";
import type { ConnectionProviderAdapter, ConnectionProviderId } from "./types.js";
import { isConnectionProviderId } from "./types.js";

/**
 * Resolve the adapter for a provider id. `providerConfig` is the connection's
 * stored endpoint configuration; it is required for `custom-oauth2` and
 * ignored for built-in providers.
 */
export function getConnectionProviderAdapter(
  providerId: string,
  providerConfig?: unknown,
): ConnectionProviderAdapter {
  if (!isConnectionProviderId(providerId)) {
    throw new ConnectionProviderError(`Unknown connection provider: ${providerId}`, {
      kind: "provider-rejected",
    });
  }
  const id: ConnectionProviderId = providerId;
  switch (id) {
    case "google":
      return googleProviderAdapter;
    case "microsoft":
      return createMicrosoftAdapter(parseMicrosoftProviderConfig(providerConfig));
    case "github":
      return githubProviderAdapter;
    case "clickup":
      return clickupProviderAdapter;
    case "custom-oauth2":
      return createCustomOAuth2Adapter(parseCustomOAuth2ProviderConfig(providerConfig));
  }
}
