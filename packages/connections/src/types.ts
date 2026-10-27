export const CONNECTION_PROVIDER_IDS = [
  "google",
  "microsoft",
  "github",
  "clickup",
  "custom-oauth2",
] as const;

export type ConnectionProviderId = (typeof CONNECTION_PROVIDER_IDS)[number];

export function isConnectionProviderId(value: string): value is ConnectionProviderId {
  return (CONNECTION_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Endpoint configuration for providers without a built-in adapter.
 * Stored on the connection record, not in automation config.
 */
export interface CustomOAuth2ProviderConfig {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
}

/**
 * Optional configuration for the Microsoft (Entra ID) adapter. `tenant`
 * selects the sign-in audience: `common` (default), `organizations`,
 * `consumers`, or a specific tenant id/domain.
 */
export interface MicrosoftProviderConfig {
  readonly tenant: string;
}

export interface ConnectionTokenSet {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshToken: string | null;
  readonly tokenType: string;
}

export interface CreateAuthorizationUrlInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly scopes: readonly string[];
  /** Force the provider consent screen so a fresh refresh token is issued. */
  readonly forceConsent: boolean;
}

export interface ExchangeAuthorizationCodeInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
}

export interface RefreshAccessTokenInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
}

export interface RevokeTokenInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly token: string;
}

export interface ConnectionProviderAdapter {
  readonly id: ConnectionProviderId;
  readonly requiresScopes: boolean;
  createAuthorizationUrl(input: CreateAuthorizationUrlInput): URL;
  exchangeAuthorizationCode(input: ExchangeAuthorizationCodeInput): Promise<ConnectionTokenSet>;
  refreshAccessToken(input: RefreshAccessTokenInput): Promise<ConnectionTokenSet>;
  revokeToken?(input: RevokeTokenInput): Promise<void>;
}
