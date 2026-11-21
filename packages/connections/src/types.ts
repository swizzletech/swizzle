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

export interface CustomOAuth2ProviderConfig {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
}

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
