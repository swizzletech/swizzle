# Connections

A connection is an OAuth credential the platform holds for one account at one provider, so that an automation can call that provider's API without implementing OAuth. The automation names the connection in `config.yaml` and receives a short-lived access token at run time. Connections are credential infrastructure, not a connector catalog: provider API calls and business logic stay in automation code.

## One row holds the client and the grant

A connection ([`environmentConnections`](../../packages/db/src/schema.ts)) belongs to one project and one environment, and is unique there by name. It holds the provider, the OAuth client id and secret, the scopes, the encrypted token set and, while an authorization is in flight, the pending state. Three Google accounts are three connections. They may carry copies of the same client credentials (`--reuse-from` on the CLI, from a connection the person manages in the same project), but nothing links them after the copy.

A connection is a credential, as a secret is: authorizing a new one needs editor, re-authorizing or deleting one needs `manage`, testing one needs `use`, and a deployment binds it when it is published. [The security model](security-model.md#credentials-need-use-and-manage-rights) describes the rights, the bindings and shares to other projects.

Keeping the client on the connection, instead of in a global provider registry, means one decision lives in one place: rotating a client secret is a re-authorization of the connections that use it, and no `config.yaml` names a provider, an endpoint or a scope.

Provider differences live in adapters ([`packages/connections`](../../packages/connections/src/index.ts)): Google, Microsoft, GitHub, ClickUp, and a generic authorization-code flow with PKCE for any other provider. The API uses these adapters during authorization and refresh. Token sets and client secrets use the same `SWIZZLE_ENCRYPTION_KEY` envelope as platform secrets.

Google, Microsoft, GitHub, and custom OAuth2 share a [fetch transport](../../packages/connections/src/oauth2.ts). The transport builds authorization URLs, exchanges codes, refreshes tokens, and maps provider errors. It adds PKCE for Google, Microsoft, and custom OAuth2. GitHub does not use PKCE, and ClickUp keeps its separate token request format. Code exchange, refresh, and revocation send form-encoded bodies with HTTP Basic client authentication, following [RFC 6749 section 2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1). The request and response read share a ten-second timeout. OAuth error bodies map `invalid_grant` and `invalid_token` to permanent errors, even when the provider responds with HTTP 200. HTTP 5xx and 429 responses stay transient without reading an error body.

Refresh scope handling is provider-specific. Each OAuth2 adapter sets `refreshScopes`; Google and GitHub omit the original scopes, while Microsoft and custom OAuth2 include them.

## The API refreshes tokens under a row lock

Before a run or API check starts, [`resolveRequiredConnections`](../../packages/runtime/src/platform-connections.ts) resolves each connection its deployment bound, by id. A token that is still valid returns without a transaction. A token near expiry takes the slow path in [`resolveConnectionToken`](../../packages/db/src/control-plane-connections.ts): it locks the connection row with `SELECT ... FOR UPDATE` and checks the expiry again after the lock, because another API operation may have refreshed while this one waited. Concurrent runs of the same connection therefore call the provider once, which matters for providers that rotate the refresh token on every use and invalidate the old one.

A refresh that the provider rejects as permanent (`invalid_grant`, `invalid_token`) sets the connection to `error`, and runs fail with `PLATFORM_CONNECTION_UNAUTHORIZED` until someone re-authorizes. A transient failure leaves the connection `active` and fails the run as retryable.

Only the access token and its expiry reach the run, as `SWIZZLE_CONNECTION_<NAME>` and `SWIZZLE_CONNECTION_<NAME>_EXPIRES_AT` ([`platform-secrets.ts`](../../packages/runtime/src/platform-secrets.ts)). The refresh token and the client secret never leave the platform.

## The OAuth callback is the second public door

The provider sends the user's browser back to `GET /oauth/callback/<provider>`, a request with no session or bearer token. The callback is public, like webhook ingress ([`ROUTE_ACCESS`](../../packages/runtime/src/http-contract.ts)). An authenticated authorize call mints the `state` value, stores its SHA-256 hash with a 10-minute expiry, and the callback consumes it once ([`platform-connections.ts`](../../packages/runtime/src/platform-connections.ts)). The route is rate-limited per client address. It uses the helper shared with the approval page, so the visitor sees the Swizzle logo, a heading, and a message in their light or dark setting. The helper escapes the connection name. The page includes neither access tokens nor provider error text ([`connection-routes.ts`](../../apps/api/src/connection-routes.ts), [`approval-page.ts`](../../apps/api/src/approval-page.ts)).

## The redirect origin comes only from configuration

The provider checks that the redirect URI equals the one registered in its console. The platform builds it as `${SWIZZLE_PUBLIC_URL}/oauth/callback/<provider>` ([`resolveConnectionPublicUrl`](../../apps/api/src/connection-routes.ts)). It never derives the origin from `Host` or `X-Forwarded-*`, which a misconfigured proxy lets a client choose, except on localhost, where the request comes from the operator's own machine. On any other host, an unset `SWIZZLE_PUBLIC_URL` fails the authorization with `CONNECTION_PUBLIC_URL_NOT_CONFIGURED`. The Compose stack sets it to `SWIZZLE_API_ORIGIN`.

To set up a connection, follow [Connect an OAuth account](../how-to/connect-an-oauth-account.md).
