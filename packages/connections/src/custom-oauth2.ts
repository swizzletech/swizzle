import { ConnectionProviderError } from "./errors.js";
import { createOAuth2Adapter } from "./oauth2.js";
import type { ConnectionProviderAdapter, CustomOAuth2ProviderConfig } from "./types.js";

function assertHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConnectionProviderError(`custom-oauth2 ${field} is not a valid URL`, {
      kind: "provider-rejected",
    });
  }
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      process.env.SWIZZLE_ALLOW_INSECURE_OAUTH_ENDPOINTS?.trim().toLowerCase() === "true"
    )
  ) {
    throw new ConnectionProviderError(
      `custom-oauth2 ${field} must use https (set SWIZZLE_ALLOW_INSECURE_OAUTH_ENDPOINTS=true only for isolated local development)`,
      {
        kind: "provider-rejected",
      },
    );
  }
  if (parsed.username || parsed.password) {
    throw new ConnectionProviderError(`custom-oauth2 ${field} must not contain URL credentials`, {
      kind: "provider-rejected",
    });
  }
  return parsed.toString();
}

export function parseCustomOAuth2ProviderConfig(value: unknown): CustomOAuth2ProviderConfig {
  if (typeof value !== "object" || value === null) {
    throw new ConnectionProviderError(
      "custom-oauth2 requires providerConfig with authorizeUrl and tokenUrl",
      { kind: "provider-rejected" },
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.authorizeUrl !== "string" || typeof record.tokenUrl !== "string") {
    throw new ConnectionProviderError(
      "custom-oauth2 requires providerConfig with authorizeUrl and tokenUrl",
      { kind: "provider-rejected" },
    );
  }
  const config: {
    authorizeUrl: string;
    tokenUrl: string;
    revokeUrl?: string;
  } = {
    authorizeUrl: assertHttpUrl(record.authorizeUrl, "authorizeUrl"),
    tokenUrl: assertHttpUrl(record.tokenUrl, "tokenUrl"),
  };
  if (typeof record.revokeUrl === "string" && record.revokeUrl.length > 0) {
    config.revokeUrl = assertHttpUrl(record.revokeUrl, "revokeUrl");
  }
  return config;
}

export function createCustomOAuth2Adapter(
  providerConfig: CustomOAuth2ProviderConfig,
): ConnectionProviderAdapter {
  return createOAuth2Adapter({
    id: "custom-oauth2",
    requiresScopes: true,
    refreshScopes: true,
    ...providerConfig,
    pkce: true,
  });
}
