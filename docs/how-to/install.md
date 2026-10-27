# Install Swizzle on a server

Swizzle runs from a checkout of this repository. `just stack` builds the images from the checkout in Docker and starts the Compose stack in [`infra/docker/compose.yml`](../../infra/docker/compose.yml) behind Caddy. The server needs no Node.js package dependencies of its own. The `swizzle` CLI installs from npm on any machine that reaches the API. Caddy's image contains [`infra/docker/Caddyfile`](../../infra/docker/Caddyfile), so after you edit that file, `just stack` rebuilds the image and replaces the Caddy container. What the stack defends against, and how, is in [the security model](../explanation/security-model.md).

You need:

- Docker Engine with Docker Compose v2 on the server.
- `git` and [mise](https://mise.jdx.dev), activated in your shell. `mise install` in the checkout installs the pinned toolchain from [`mise.toml`](../../mise.toml), so you install no `just` of your own. The stack recipes use its `just` and Node.js.

You need neither a domain nor a mail server. Without a mail server, you copy each invitation link from the dashboard and send it to the person yourself.

## Get the code

Clone the repository and write `.env`:

```bash
git clone https://github.com/swizzletech/swizzle.git /opt/swizzle
cd /opt/swizzle
mise trust && mise install
just init-env
```

`just init-env` writes `.env` with unique credentials for Postgres, Valkey, encryption and the first account's setup. The file has mode 0600. It also sets a unique `COMPOSE_PROJECT_NAME` for the stack's containers, networks and volumes. A rerun keeps the file unchanged. If a required credential or project name is missing or blank, the recipe fails and names the key. Restore its value, or delete `.env` and rerun `just init-env` to generate fresh credentials. `just stack` runs `just init-env` first, so a stack never starts without `.env`.

## Choose who can reach the dashboard

Pick one of three paths. A dashboard that other devices reach must use HTTPS, because sign-in cookies and agent tokens would otherwise cross the network unencrypted. The API refuses to start with a non-local `http://` origin.

### On this host only

Keep the defaults in `.env`, and start the stack:

```bash
just stack
```

Open `http://localhost:19826` in a browser on the server. From your own computer, forward the port over SSH first, then open the same address there:

```bash
ssh -L 19826:localhost:19826 you@server
```

The API and webhooks answer at `http://api.localhost:19826` on the server. All three published ports (HTTP, HTTPS, and the links listener) bind to `127.0.0.1`, so another device cannot reach them through the server's LAN address.

### On a private network over Tailscale

[Tailscale](https://tailscale.com) gives the server a name on your tailnet, such as `server.example-tailnet.ts.net`, and `tailscale serve` answers it over HTTPS with a certificate for that name. Only devices on your tailnet reach the dashboard and its sign-in. Turn on HTTPS certificates for the tailnet in its admin console under **DNS** first.

1. Publish Caddy's HTTP port on the tailnet. The command prints the address, with the server's tailnet name:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:19826
   ```

2. Set these values in `.env`, with that name:

   ```env
   SWIZZLE_HTTP_BIND=127.0.0.1
   SWIZZLE_DASHBOARD_ORIGIN=https://server.example-tailnet.ts.net
   SWIZZLE_DASHBOARD_SITE=http://server.example-tailnet.ts.net:19826
   SWIZZLE_API_ORIGIN=https://server.example-tailnet.ts.net/api
   SWIZZLE_API_SITE=http://api.localhost:19826
   ```

   `SWIZZLE_DASHBOARD_ORIGIN` is the address people open. `SWIZZLE_API_ORIGIN` is the externally reachable API base, including `/api`. The two `SITE` settings are where Caddy listens locally on `SWIZZLE_HTTP_PORT`. `tailscale serve` forwards to that port, and `SWIZZLE_HTTP_BIND` keeps plain HTTP off the LAN.

3. Start the stack:

   ```bash
   just stack
   ```

4. Open `https://server.example-tailnet.ts.net` on another device of the tailnet.

If port 443 of the name already serves something else, pick another port, such as `--https=8443`, and include it in both origins: `SWIZZLE_DASHBOARD_ORIGIN=https://server.example-tailnet.ts.net:8443` and `SWIZZLE_API_ORIGIN=https://server.example-tailnet.ts.net:8443/api`. `tailscale serve status` lists what the name serves. `tailscale serve --https=443 off` takes the dashboard off the tailnet again.

Register the CLI profile with `--url https://server.example-tailnet.ts.net/api`. The dashboard's **About** tab, `swizzle apply`, and `swizzle inspect` show webhook URLs from `SWIZZLE_PUBLIC_URL`. Compose defaults that setting to `SWIZZLE_API_ORIGIN`, so the URL looks like `https://server.example-tailnet.ts.net/api/hello?environment=staging`. Senders on the tailnet can post to those URLs. Approvers outside the tailnet need only their links; to publish those alone, [share only the links](#share-approval-and-event-links-from-a-private-instance).

### Public with a domain

1. Point two IPv4 DNS records (A records) at the server, one for the dashboard (`swizzle.example.com`) and one for the API and webhooks (`api.swizzle.example.com`). Ports 80 and 443 must be reachable from the internet, so Caddy can get Let's Encrypt certificates.
2. Set these values in `.env`:

   ```env
   SWIZZLE_ENVIRONMENT=production
   SWIZZLE_DASHBOARD_ORIGIN=https://swizzle.example.com
   SWIZZLE_API_ORIGIN=https://api.swizzle.example.com
   SWIZZLE_CORS_ORIGINS=https://swizzle.example.com
   SWIZZLE_HTTP_BIND=0.0.0.0
   SWIZZLE_HTTP_PORT=80
   SWIZZLE_HTTPS_PORT=443
   SWIZZLE_ACME_EMAIL=ops@example.com
   ```

   Both HTTP and HTTPS bind to the IPv4 address in `SWIZZLE_HTTP_BIND`. The stack publishes no IPv6 ports. Do not add AAAA records or set an IPv6 bind: Docker can translate IPv6 peers into a private gateway address and bypass the private-range gate.

   The scheduler fires cron triggers only for its `SWIZZLE_ENVIRONMENT`. See [environments](../explanation/environments.md).

3. Start the stack, and check the API:

   ```bash
   just stack
   curl https://api.swizzle.example.com/health
   ```

Webhook senders and OAuth providers may need the API from the internet. The sign-in route `POST /auth/sign-in/email` is on the API too, so a public API also accepts sign-in attempts from anyone. Turn on two-factor sign-in after you claim the instance. The sign-in budgets slow down guessing, but they do not stop someone who already has the password. Before the instance goes public, [harden it](#harden-a-public-instance).

## Configure the instance

1. To send invitations and automatic password reset emails, give the instance a mail server:

   ```env
   SWIZZLE_SMTP_URL=smtps://swizzle%40example.com:<password>@mail.example.com:465
   SWIZZLE_MAIL_FROM=Swizzle <swizzle@example.com>
   ```

   Percent-encode a reserved character in the user name or password, such as `@` as `%40`. `smtps://` connects with TLS, usually on port 465; `smtp://` upgrades with STARTTLS, usually on port 587, and fails against a server that does not offer it. The API reaches the server through the control egress proxy, which allows only these two ports. The links in the mails open `SWIZZLE_DASHBOARD_ORIGIN`. Without a mail server, the dashboard and the CLI show invitation and reset links for you to send, and nobody can ask for a reset link by mail.

2. Back up `.env` apart from the database backups. Without `SWIZZLE_ENCRYPTION_KEY`, nobody can decrypt the stored secrets.

3. Set `WORKER_CONCURRENCY` in `.env` to the number of parallel local runs. The server admits that many leases across all groups of this identity. Start conservatively, for example 2 on four cores, and increase it for I/O-bound automations as memory permits. On a 1-vCPU server with about 4 GB of RAM, start with 1; concurrent dependency installs can exhaust memory.

   The stack has one configured local worker, shown as **Local** under Settings > Workers. It serves every project and environment, including ones created later. `just init-env` creates its private credential. Additional machines enroll with their own worker identity, grants and capacity ([add a remote worker](add-a-remote-worker.md)). Give CPU-bound work its own explicit group; a sleeping group's runs wait for it rather than falling back to the local worker.

Run `just stack` again after a change to `.env`.

## Run the stack

Only `docker-broker` mounts the Docker socket, and only Caddy binds host ports. Caddy stores certificates in the `caddy-data` and `caddy-config` volumes.

Run `just stack-down` to stop the packaged stack and remove its volumes, the service images `just stack` built and the run images its worker built. Pulled images such as Postgres and Valkey stay, because other stacks on the host may share them.

Compose allows the API and scheduler 45 seconds to stop, covering their default 30-second drain. If you increase `SWIZZLE_SHUTDOWN_TIMEOUT_MS`, keep `stop_grace_period` in [`compose.yml`](../../infra/docker/compose.yml) longer than that timeout so Docker does not kill them mid-drain.

A webhook with a generated path such as `/hooks/hello-<random>` answers at `<SWIZZLE_API_ORIGIN>/hooks/hello-<random>`, by default `http://api.localhost:19826/hooks/hello-<random>`. The scaffold adds a random suffix and verifies the request signature. See [check webhook input](write-an-automation.md#check-webhook-input) for the signature setup.

Run `just smoke` on a development machine to check the full path. The recipe runs `just setup` first, which installs development dependencies, git hooks, and Playwright Chromium. Do not run it on the server. The recipe starts a throwaway stack with its own credentials, Compose project, and free ports. It deploys `infra/examples/hello-webhook`, posts to its webhook URL, and checks the successful run and exported trace. Then it removes the project's labelled containers, networks, volumes, and images, including resources left by a failed start. At startup, `just smoke` and `just perf` remove old throwaways when their recorded process identity no longer matches. [The local stack guide](run-a-local-stack.md) explains how cleanup checks process ownership.

If another service uses a default host port, change that port to a free value. Set `SWIZZLE_HTTP_PORT` for HTTP, `SWIZZLE_HTTPS_PORT` for HTTPS, and `SWIZZLE_LINK_PORT` for the links listener. Keep all three ports distinct. When you change HTTP or HTTPS, put the new port in `SWIZZLE_DASHBOARD_SITE` and `SWIZZLE_API_SITE`. If a site setting is empty, put its port in the matching origin instead. The CLI's default API URL is `http://api.localhost:19826`, so also set `SWIZZLE_API_URL` to the new address, or register a profile with `swizzle profile add <name> --url <api origin>`.

## Clean up a worker host

While image assembly can run on a worker's Docker daemon, do not run `docker image prune` or `docker system prune` on that daemon. Scheduled cleanup and cleanup from other stacks can interrupt assembly too. With Docker's containerd image store, image pruning can remove leases held by image assembly in flight, even when a label filter excludes every image. The commit can report `lease does not exist` or a missing containerd ingest file.

Let Swizzle remove unused run images through its [retention and disk budget](../explanation/deployments-and-rollback.md). To remove another image, inspect `docker image ls` and run `docker image rm <image-id>`. To clear build cache, run `docker builder prune`. Neither command invalidates assembly leases. Run `just stack-down` to remove this stack and its owned images.

Swizzle reassembles once after a lost lease and records the reassembly in the run's logs. If that assembly also loses its lease, the run fails with `CONTAINER_IMAGE_PRUNE_INTERRUPTED`. Stop the competing cleanup before retrying the run. Run daemon-wide image pruning only when no image assembly is in flight on that daemon.

## Claim the instance

1. Open the dashboard. A fresh instance shows the setup form, "Set up your instance".
2. Enter your name, `SWIZZLE_SETUP_TOKEN` from `.env`, an email address and a password of 15 to 128 characters, and select **Create account**.
3. The dashboard then offers two-factor sign-in. For a public instance, scan the QR code with your authenticator app, enter the code it shows, and select **Turn on**. Store the ten recovery codes in your password manager. The dashboard shows them once, and each code signs you in once without the app. Select **Skip** to leave two-factor sign-in off. You can set it up later in **Settings → Two-factor sign-in**.
4. Open **Settings → Agent access**, create a token for your workstation with an expiry, and copy it. The dashboard shows the token once in a command block that you can give to your agent. Agent tokens do not need the second factor.

## Invite people

1. Open **Settings → People**. Enter the person's email address. Choose an instance role and the projects to grant. A `member` sees only granted projects. An `admin` or `owner` manages the instance. Only an owner can invite someone as an owner.
2. Select **Create link**, or **Send invitation** when the instance has a mail server. The page shows the invitation link once, with **Copy link**. With a mail server, the page says the link went out by mail as well.
3. Without a mail server, send the link to the person yourself, for example in a chat. `swizzle people invite anna@example.com --role member --project billing=editor` creates the same invitation and prints its link.
4. The person opens the link within 7 days. They set a name and password, then receive the same two-factor sign-in offer. The invitation grants access to its selected projects. The link creates one account, for the invited address only.

An owner or admin can change a person's role, suspend or reactivate them, turn off a lost second factor, or remove them in **Settings → People**. Suspension ends the person's sessions and stops their agent tokens: each answers `403 AUTH_ACCOUNT_SUSPENDED` until the suspension is lifted, so a replacement token would not help. The last active owner cannot be demoted, suspended, or removed, so add a second owner before the first one leaves.

To help someone who forgot their password, select **Reset link** in their row. Copy the link and send it to them. The page shows the link once. It works once and expires after one hour. The `swizzle people reset-link <email>` command creates the same link. Both methods work without mail. To give people projects, teams, and production access, follow [Give people access to projects and production](give-people-access.md).

## Recover a locked-out owner

An owner who lost the password while the instance has no mail server, or lost both the authenticator and the recovery codes, cannot sign in. Another owner can create a reset link and turn off the lost second factor in **Settings → People**. If no other owner can sign in, recover the account from the server:

1. In the checkout on the server, with the stack running, run:

   ```bash
   just recover-owner owner@example.com
   ```

   The recipe runs `node dist/recover-owner.js <email>` in the API container. It needs the same shell access as `docker compose`, and no HTTP request can start it. It turns the owner's two-factor sign-in off, ends every session, and prints a `reset-link` that works once and expires after one hour. If the address does not belong to an active owner, the command lists the active owners' addresses and exits with code 1.

2. Open the link and choose a new password. The new password also revokes the owner's agent tokens, so create new ones under **Settings → Agent access**.
3. Sign in, and turn two-factor sign-in on again under **Settings → Two-factor sign-in**.

The instance audit records each run with the actor `host`; `GET /audit` lists it as `recover-owner`. Treat the printed link as a password until it is used or expires.

## Connect the CLI

On your workstation, install Node.js 22.18 or later and the CLI package of the same version as the server:

```bash
npm install --global @swizzletech/cli
swizzle --version
```

Then register the instance and check it:

Protected API commands require a CLI profile, even when you pass `--api-url`. Without one, they print `SIGN_IN_REQUIRED` and the steps to sign in and register a token. Local commands and worker enrollment with a one-use code can run without a profile.

```bash
export SWIZZLE_TOKEN='<token>'
swizzle profile add staging \
  --url https://server.example-tailnet.ts.net/api \
  --env staging \
  --token-env SWIZZLE_TOKEN \
  --default
swizzle doctor
swizzle security audit
```

Use the API address from the path you configured above. `--env` must match the stack's `SWIZZLE_ENVIRONMENT`: it defaults to `staging`, while the public setup sets it to `production`. **Settings → Agent access** shows a profile command with the current API address and environment. The scheduler starts cron runs only in its configured environment. See [environments](../explanation/environments.md).

`doctor` prints the CLI and server versions and probes the artifact store. `security audit` checks the whole instance without selecting an environment and exits non-zero when a critical check fails. Run it again after every proxy or `.env` change.

`swizzle profile list --json` reports `hasToken:true` when a profile has a non-empty inline token or its token environment variable has a non-empty value in the current shell. The value stays redacted. Use `doctor` to check whether the instance accepts it. If the token is malformed, API commands stop with `PROFILE_TOKEN_MALFORMED`. The error names the profile and explains how to set the token again without printing its value. When the profile reads the token from an environment variable, the error names that variable.

To set up a folder for your automations with the agent skill the CLI ships, run `swizzle workspace init .` in a new, empty folder. It writes the skill to `.agents/skills/swizzle-builder/` there. Continue with [write an automation](write-an-automation.md).

## Share approval and event links from a private instance

Caddy serves [approval and event links](../explanation/approvals.md) on an origin of their own, `SWIZZLE_LINK_ORIGIN`. It answers `/approvals/*` and `/events/*` and a bare 404 for every other path. Runs build their links from `SWIZZLE_LINK_URL`, which defaults to `SWIZZLE_LINK_ORIGIN`. The production API refuses a non-local `SWIZZLE_LINK_URL` without HTTPS. Without either value, links start with `http://links.localhost:<SWIZZLE_HTTP_PORT>` and work only on the server itself.

If you change `SWIZZLE_LINK_URL` or `SWIZZLE_ENCRYPTION_KEY`, links sent before the change stop working.

### Through Caddy on a public server

1. Point a third IPv4 DNS record (A record), such as `links.swizzle.example.com`, at the server.
2. Set these values in `.env`:

   ```env
   SWIZZLE_LINK_ORIGIN=https://links.swizzle.example.com
   SWIZZLE_PRIVATE_RANGES=private_ranges 100.64.0.0/10
   ```

3. Run `just stack`.

`SWIZZLE_PRIVATE_RANGES` lists the client addresses that the dashboard and the API answer. Every other client gets a bare 404 there. `private_ranges` covers local networks, and `100.64.0.0/10` covers Tailscale. The default answers every address. Keep the IPv4 bind from the public install path: an IPv6 connection must not be translated to a private Docker gateway. This gate uses the connecting address, so it cannot distinguish clients behind a tunnel on the server.

### Through Tailscale Funnel on a private server

Funnel publishes a port of the machine's `ts.net` name on the internet. Forward it to Caddy's dedicated links listener, which serves only `/approvals/*` and `/events/*` regardless of the client's `Host` header.

1. Set these values in `.env`, with your machine's name:

   ```env
   SWIZZLE_HTTP_BIND=127.0.0.1
   SWIZZLE_LINK_PORT=19828
   SWIZZLE_LINK_ORIGIN=http://links.localhost:19826
   SWIZZLE_LINK_URL=https://server.example-tailnet.ts.net:10000
   ```

   Keep `SWIZZLE_LINK_PORT` distinct from `SWIZZLE_HTTP_PORT` and `SWIZZLE_HTTPS_PORT`. The links listener always binds to `127.0.0.1`, including on a public server. `SWIZZLE_LINK_ORIGIN` is Caddy's local site, so HTTP is allowed there. `SWIZZLE_LINK_URL` is the HTTPS address sent to approvers and event senders. If you changed `SWIZZLE_HTTP_PORT`, use that port in `SWIZZLE_LINK_ORIGIN` too.

2. Run `just stack`.
3. Publish the links listener on Funnel port 10000. Funnel also offers ports 443 and 8443.

   ```bash
   tailscale funnel --bg --https=10000 http://127.0.0.1:19828
   ```

Use this dedicated listener for any public tunnel. The shared HTTP and HTTPS ports also serve the dashboard and API, which a caller can select with a `Host` header. `SWIZZLE_PRIVATE_RANGES` cannot separate tunnel clients because Caddy sees the Docker gateway. The dashboard can keep its localhost or private tailnet origin from the earlier install path.

To take these links off the internet, run `tailscale funnel --https=10000 off`. To test on the tailnet without public exposure, use `tailscale serve` with the same arguments instead of `tailscale funnel`.

### Give each tunnel client its own rate-limit budget

The approval and event rate limits count clients by address. A tunnel on the server, such as Tailscale Funnel or Cloudflare Tunnel, connects to Caddy from the Docker gateway, so every link holder behind it shares one budget by default. Caddy trusts no proxy by default and replaces a caller-supplied `X-Forwarded-For` with the connecting address.

If the tunnel sends each client's address in `X-Forwarded-For`, set `SWIZZLE_LINK_TRUSTED_PROXY` to the address or CIDR from which the tunnel connects. Caddy then uses that header for the links origin only. The dashboard and API origins continue to use the connecting address. Cloudflare sends the visitor address in both `X-Forwarded-For` and `CF-Connecting-IP` ([Cloudflare's header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). This Caddy config reads `X-Forwarded-For` and ignores `CF-Connecting-IP`.

1. Read the gateway of the stack's `outbound` network, which carries the `COMPOSE_PROJECT_NAME` from `.env` in front:

   ```bash
   docker network inspect "$(grep '^COMPOSE_PROJECT_NAME=' .env | cut -d= -f2)_outbound" \
     --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}'
   ```

2. Set it in `.env`, and run `just stack`:

   ```env
   SWIZZLE_LINK_TRUSTED_PROXY=172.18.0.1
   ```

This trusts `X-Forwarded-For` from every connection that arrives from the configured address. That includes every process on the server and, when Docker forwards a published port through its userland proxy, some outside connections too. Set it only when the tunnel is the only way from the internet to Caddy's ports.

To check either setup, request `/` on the URL in `SWIZZLE_LINK_URL` from outside your network. It answers 404 with an empty body. For a tunnel, also check the dashboard and API Host headers, using your own dashboard host and port:

```bash
curl -i -H 'Host: api.localhost' https://server.example-tailnet.ts.net:10000/health
curl -i -H 'Host: localhost:19826' https://server.example-tailnet.ts.net:10000/
```

Both answer 404 with an empty body. A valid `/approvals/<token>` link still opens its approval page.

## Harden a public instance

Before the instance is reachable from the internet, check each item:

- Turn on two-factor sign-in if the dashboard or API is reachable from the public internet.
- If only approvers and third-party systems need the internet, make only the links origin public and narrow `SWIZZLE_PRIVATE_RANGES`.
- Keep `SWIZZLE_AUTH_COOKIE_SECURE` unset or `true` when you configure a public HTTPS origin. The production API refuses to start if the setting is false.
- Use HTTPS origins, and keep the API behind Caddy or another trusted proxy.
- Set `SWIZZLE_TRUSTED_PROXY` to the proxy's address or CIDR, never to `true` or a hop count. The packaged stack's default, `uniquelocal`, trusts Caddy on its private compose networks.
- Keep `SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT` on, unless the proxy in front already limits webhook traffic.
- Mount the Docker socket into no service except `docker-broker`.
- Use rootless Docker or user-namespace remapping where you can, plus a host firewall and DDoS protection upstream.
- Keep the Docker Engine patched, and pin a custom `runtime.container.base_image` to a reviewed digest.

With `NODE_ENV=production`, which the stack sets, the API refuses to start with several of these mistakes.

If a service exits during configuration, read its `FATAL` line in `docker compose logs`. The API, worker, and scheduler log configuration failures with a diagnostic code. For `EGRESS_PROXY_INVALID`, set `SWIZZLE_CONTROL_EGRESS_PROXY` to an HTTP proxy URL without credentials, such as `http://control-egress-proxy:3128`.
