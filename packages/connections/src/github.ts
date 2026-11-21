import { createOAuth2Adapter } from "./oauth2.js";
import type { ConnectionProviderAdapter } from "./types.js";

export const githubProviderAdapter: ConnectionProviderAdapter = createOAuth2Adapter({
  id: "github",
  requiresScopes: false,
  refreshScopes: false,
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  pkce: false,
});
