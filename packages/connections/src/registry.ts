import { clickupProviderAdapter } from "./clickup.js";
import { createCustomOAuth2Adapter, parseCustomOAuth2ProviderConfig } from "./custom-oauth2.js";
import { ConnectionProviderError } from "./errors.js";
import { githubProviderAdapter } from "./github.js";
import { googleProviderAdapter } from "./google.js";
import { createMicrosoftAdapter, parseMicrosoftProviderConfig } from "./microsoft.js";
import type { ConnectionProviderAdapter, ConnectionProviderId } from "./types.js";
import { isConnectionProviderId } from "./types.js";

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
