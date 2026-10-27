# Connect an OAuth account

A connection lets an automation call a provider's API with an access token the platform refreshes. Each connection holds one account in one environment. How connections work, and why the callback is public, is in [connections](../explanation/connections.md).

## Set the public callback URL

The provider redirects the browser to `${SWIZZLE_PUBLIC_URL}/oauth/callback/<provider>`.

- On the Compose stack, `SWIZZLE_PUBLIC_URL` defaults to `SWIZZLE_API_ORIGIN`, so the callback is on your API host. Set it in `.env` only when the public origin differs from the Caddy host, for example behind a tunnel.
- On `just dev`, leave it unset. The API takes the origin from the request when the host is localhost.

On any other host, an unset `SWIZZLE_PUBLIC_URL` fails the authorization with `CONNECTION_PUBLIC_URL_NOT_CONFIGURED`.

## Register an OAuth client with the provider

1. Create an OAuth client of type web application in the provider's console.
2. Add the redirect URI exactly: `${SWIZZLE_PUBLIC_URL}/oauth/callback/<provider>`, for example `https://api.swizzle.example.com/oauth/callback/google`.
3. Allow the scopes your automation needs.

If a Google consent screen stays in the testing publishing status, Google expires its refresh tokens after 7 days, and runs then fail with `PLATFORM_CONNECTION_UNAUTHORIZED`. Publish the app for a connection that must last.

For laptop CLI installation and the remote HTTPS profile, follow [Write an automation](write-an-automation.md#install-the-cli-on-your-laptop).

## Authorize the connection

Pass the client credentials once. The client secret comes from an environment variable, so it stays out of shell history and process lists. `authorize` answers at once with the `authorizationUrl` the account owner opens:

```bash
export GOOGLE_CLIENT_SECRET="<client-secret>"
swizzle connections authorize google-sales --provider google \
  --client-id "<client-id>" --client-secret-env GOOGLE_CLIENT_SECRET \
  --scopes https://www.googleapis.com/auth/drive.readonly
```

Add `--open` to open the URL in this machine's browser and `--wait` to wait until the connection is active. `--wait` prints the URL to stderr meanwhile and gives up after `--timeout` seconds (default 300).

`--provider` is `google`, `microsoft`, `github`, `clickup` or `custom-oauth2`. Connection lists, detail views, and suggested commands name projects by slug. A connection belongs to one project and environment, as a secret does; for an automation outside the `default` project, add `--project <slug>` to every `connections` command. In the dashboard, **Connect an account** on **Credentials** has a **Project** field that starts at the project in view. Creating a connection needs editor there and lets you manage it.

On **Credentials**, **Connect** and **Reconnect** start the provider consent flow. The sign-in window opens with the click and goes to the provider's consent page once the API answers. While authorization is pending, the page keeps an **Open the sign-in page** link above the account list. When the browser blocks the window, the page says so; open the link to finish.

- For Microsoft, add `--tenant` if the app is not multi-tenant. The platform adds `offline_access`, so Microsoft issues a refresh token.
- For a `custom-oauth2` provider, add `--authorize-url` and `--token-url`. The provider must support the authorization-code flow with PKCE.
- GitHub OAuth-app tokens and ClickUp tokens do not expire and cannot be refreshed. If the provider revokes one, authorize again.

To connect a second account with the same client, copy the credentials from a connection you manage in the same project:

```bash
swizzle connections authorize google-support --reuse-from google-sales \
  --scopes https://www.googleapis.com/auth/drive.readonly
```

## Use it in an automation

Declare the connection in `config.yaml`:

```yaml
connections:
  - google-sales
```

Read the token in code with `get_connection_token("google-sales")` in Python or `getConnectionToken("google-sales")` in TypeScript. The API refreshes the token before each run, so read it at run time and do not store it. A local `swizzle run` does not resolve connections, and a deploy fails while a declared connection is missing or not active.

## Check, rotate or repair a connection

```bash
swizzle connections list
swizzle connections test google-sales
```

`test` forces a refresh and proves the stored credentials still work.

To rotate the client secret, run `authorize` again with the new `--client-id` and `--client-secret-env`. To repair a connection in the `error` status, for example after the account revoked access, run `authorize` with only the name. It reuses the stored client credentials and shows the consent screen again:

```bash
swizzle connections authorize google-sales
```
