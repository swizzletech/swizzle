import { ConnectionProviderError } from "./errors.js";
import { createOAuth2Adapter } from "./oauth2.js";
import type { ConnectionProviderAdapter, MicrosoftProviderConfig } from "./types.js";

const DEFAULT_TENANT = "common";
// The tenant must stay within one endpoint path segment.
const TENANT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseMicrosoftProviderConfig(value: unknown): MicrosoftProviderConfig {
  if (value === undefined || value === null) {
    return { tenant: DEFAULT_TENANT };
  }
  if (typeof value !== "object") {
    throw new ConnectionProviderError("microsoft providerConfig must be an object", {
      kind: "provider-rejected",
    });
  }
  const record = value as Record<string, unknown>;
  if (record.tenant === undefined || record.tenant === null || record.tenant === "") {
    return { tenant: DEFAULT_TENANT };
  }
  if (typeof record.tenant !== "string" || !TENANT_PATTERN.test(record.tenant)) {
    throw new ConnectionProviderError(
      "microsoft tenant must be 'common', 'organizations', 'consumers', or a tenant id/domain",
      { kind: "provider-rejected" },
    );
  }
  return { tenant: record.tenant };
}

// Microsoft only returns a refresh token when `offline_access` is requested.
function withOfflineAccess(scopes: readonly string[]): string[] {
  return scopes.includes("offline_access") ? [...scopes] : [...scopes, "offline_access"];
}

export function createMicrosoftAdapter(
  providerConfig: MicrosoftProviderConfig,
): ConnectionProviderAdapter {
  const baseUrl = `https://login.microsoftonline.com/${providerConfig.tenant}/oauth2/v2.0`;
  const oauth2 = createOAuth2Adapter({
    id: "microsoft",
    requiresScopes: true,
    refreshScopes: true,
    authorizeUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/token`,
    pkce: true,
  });
  return {
    ...oauth2,
    createAuthorizationUrl(input) {
      const url = oauth2.createAuthorizationUrl({
        ...input,
        scopes: withOfflineAccess(input.scopes),
      });
      if (input.forceConsent) {
        url.searchParams.set("prompt", "consent");
      }
      return url;
    },
    refreshAccessToken: (input) =>
      oauth2.refreshAccessToken({ ...input, scopes: withOfflineAccess(input.scopes) }),
  };
}
