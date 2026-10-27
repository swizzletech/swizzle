import { createOAuth2Adapter } from "./oauth2.js";
import type { ConnectionProviderAdapter } from "./types.js";

const oauth2 = createOAuth2Adapter({
  id: "google",
  requiresScopes: true,
  refreshScopes: false,
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  pkce: true,
});

export const googleProviderAdapter: ConnectionProviderAdapter = {
  ...oauth2,
  createAuthorizationUrl(input) {
    const url = oauth2.createAuthorizationUrl(input);
    // Google only issues refresh tokens for offline access, and only on consent.
    url.searchParams.set("access_type", "offline");
    if (input.forceConsent) {
      url.searchParams.set("prompt", "consent");
    }
    return url;
  },
};
