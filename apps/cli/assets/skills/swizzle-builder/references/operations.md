# Operations

Deploying automations, inspecting runs, diagnosing failures, managing secrets and notifications. The CLI talks to the API (default `http://api.localhost:19826` for the Caddy stack; a dev stack started from a checkout prints its own). Output is TOON on stdout; the global `--json` prints the same data as one line of JSON.

Every command supports `-e <environment>` and `--json`. Without `-e`, the CLI takes the profile's `env`, then `SWIZZLE_ENVIRONMENT`, then for the implicit localhost profile the environment that instance serves. No command prompts: a destructive one fails with `CONFIRMATION_REQUIRED` (exit 2) until you pass `--yes`, and repeating a change that already holds answers with a `(no-op)` state and exit 0.

## Preflight: doctor

On a fresh or remote target, run `swizzle doctor` before anything else. One call verifies the four things that break first sessions and returns per-check pass/fail with fixes. On a remote profile, pass `--profile` and the real `-e <environment>` — the secret/connection checks are environment-scoped:

```bash
swizzle doctor --json
swizzle --profile prod doctor -e prod --json    # remote target, real environment
# checks: api (reachable) · ready (DB + queue) · auth (token accepted) · secrets (encryption key usable)
```

Exit 0 means all checks passed. A failure exits 1, lists the failing check, and puts its fix under `help`.

## Deploy and rollback

```bash
# Deploy (idempotent) with a dry-run preview first
swizzle apply my-automation --dry-run    # shows diff vs. active deployment
swizzle apply my-automation              # actually deploys

# Skip readiness check (no matching worker live yet)
swizzle apply my-automation --force

# Local artifact only, no API call
swizzle apply my-automation --local-only

# Deployment history
swizzle deployments my-automation

# Roll back (requires the exact automation slug — fuzzy matching is disabled)
swizzle rollback my-automation <deployment-id>
```

Use `--dry-run` before every real deploy when iterating — it shows the exact diff against the currently-active deployment without changing state. It asks the API to place the deployment first, so a name taken by an automation in another project fails here with the same `AUTOMATION_PROJECT_MISMATCH` that `apply` gives.

## Deleting an automation

Hard cascade: runs, attempts, deployments, versions, triggers, notification rules/deliveries, chain triggers of other automations that name it as a source, and artifact bundles on the configured backend. Audit events stay. Irreversible.

```bash
# 1. Pause the trigger (precondition; delete rejects with AUTOMATION_NOT_PAUSED otherwise)
swizzle trigger pause my-automation

# 2. Delete — --yes is mandatory, and the name must be the exact slug (no fuzzy matching)
swizzle delete my-automation --yes
swizzle delete my-automation --yes --json    # state: deleted, with deleted counts (deployments, runs) and keptAuditEvents; again: already absent (no-op)
```

Errors: `AUTOMATION_NOT_FOUND` (404, exit 6) if the name doesn't exist, `AUTOMATION_NOT_PAUSED` (409, exit 8) if the trigger is still active, `AUTOMATION_RUNS_ACTIVE` (409) while a run is unfinished, `EXACT_NAME_REQUIRED` (exit 2) if the name only fuzzy-matches. Artifact removal is best-effort post-DB-commit; a soft failure surfaces as `artifactError` in the result but does not roll back the delete.

## Inspecting what's deployed

```bash
swizzle list                      # all automations with trigger + last run state
swizzle inspect my-automation     # full detail: config, trigger, latest deployment

swizzle status                    # platform health: queue pressure, alerts, maintenance state
swizzle doctor                    # preflight: API reachable, ready, auth, secret store
```

## Running and triggering

```bash
# Run locally (uses sample-payload.json if present)
swizzle run my-automation
swizzle run my-automation --payload '{"key":"value"}'
swizzle run my-automation --payload-file sample-payload.json

# Manually trigger a deployed automation
# Webhook triggers accept payloads; cron triggers fire through the same queue/worker path with `{}`.
swizzle trigger my-automation
swizzle trigger my-automation --payload '{"key":"value"}'
swizzle trigger my-automation --payload-file sample-payload.json
```

## Common third-party rate limits

Use these as planning defaults, not eternal truths. Vendor limits change, account tiers matter, and the safe move is always to re-check the linked doc before shipping a high-volume automation. Declare the resulting budget as `runtime.rate_limits` ([Config Reference](config-reference.md#rate-limits)) and pace in-run calls with the SDK helpers ([SDK Usage](sdk.md#rate-limits-in-code)).

| Service | Planning baseline | Notes |
|---|---|---|
| LexOffice | 2 req/sec | Official API cap across endpoints; 429 on exceedance. |
| ClickUp | 100 req/min per token | Applies to Free Forever / Unlimited / Business plans; higher plans are higher. |
| Gemini | Verify in AI Studio | Limits vary by model + tier. `60 RPM` is a rough starter assumption, not a contract. |
| Anthropic | Verify org/model tier | Official limits are tier + model specific. Tier 1 Sonnet 4.x starts at 50 RPM. |
| OpenAI | Verify org/project/model | Limits vary by model, project, and usage tier. |

Official references:
- LexOffice: https://developers.lexoffice.io/docs/
- ClickUp: https://developer.clickup.com/docs/rate-limits
- Gemini: https://ai.google.dev/gemini-api/docs/rate-limits
- Anthropic: https://docs.anthropic.com/en/api/rate-limits
- OpenAI: https://platform.openai.com/docs/guides/rate-limits

## Logs and runs

```bash
# The latest run's stderr and stdout result; long streams are truncated with a --full hint.
# A run that resumed from a wait or retried shows each attempt's stderr under an `--- attempt N (status)` line
swizzle logs my-automation

# One run
swizzle logs --run <run-id>
swizzle logs --run <run-id> --tail 100     # last N lines of each stream
swizzle logs --run <run-id> --head 50      # first N lines
swizzle logs --run <run-id> --full         # no truncation (can be huge)

# Live-follow a running run's stdout/stderr by API polling (Ctrl-C to stop)
swizzle logs --run <run-id> --follow
swizzle logs my-automation --follow        # auto-picks the most recent active run

# One run: status, result, attempts and a log tail
swizzle runs inspect <run-id>
swizzle runs inspect <run-id> --full       # every attempt and both streams whole

# Run lists, newest first; `runs` alone is `runs list`
swizzle runs list my-automation --status failed --limit 20
swizzle runs --status failed,dead-lettered --since 1d --fields trigger,attempts

# Aggregated statistics
swizzle stats my-automation
```

## Waiting runs and durable resumes

`waiting` is non-terminal. The run has intentionally released its worker slot and is waiting on durable sleep, child automation completion, an external event, or human approval. Due sleeps resume from the scheduler sweep; they do not need a worker restart.

```bash
# Resolve a run waiting for waitForEvent / wait_for_event
swizzle runs resolve-event <run-id> <step-key> --payload '{"status":"approved"}'
swizzle runs resolve-event <run-id> <step-key> --payload-file event.json
```

A run waiting for `requestApproval` / `request_approval` is decided in the dashboard by a signed-in person: the assignee, a member of the assigned team, or, for an unassigned approval, anyone who may run the automation. The approval link decides only an unassigned approval. An owner or admin can reassign an open approval with a reason on the run's panel.

`swizzle approvals` lists the runs that wait for an approval. `swizzle runs inspect <run-id>` shows the wait reason and step key. For an approval wait, its help names who decides it and the URL of the run's panel. A token cannot decide, so hand that URL to the person. `swizzle diagnose <run-id>` surfaces approval/event wait hints, including who decides an approval and whether its link works.

The authoring side of these waits (`sleep`, `waitForEvent`, `requestApproval`, `invokeAutomation` and their semantics) is documented in [SDK Usage — durable execution primitives](sdk.md#durable-execution-primitives).

## Cancelling a run / pausing a trigger

Kill a stuck run or stop a noisy trigger without restarting the worker:

```bash
# Cancel a queued or running run — sends SIGTERM to the child (SIGKILL after 5s),
# marks dead-lettered with reason "user-cancelled". Idempotent.
swizzle runs cancel <run-id>
swizzle runs cancel <run-id>                # again: state: already dead-lettered (no-op)

# Pause / resume a trigger (automatic cron skips the slot, webhook ingress rejects with 409)
swizzle trigger pause my-automation
swizzle trigger my-automation --payload '{"test":true}' # manual fire still runs while paused
swizzle trigger resume my-automation
```

Pausing before `swizzle delete ...` is **required** — delete rejects active automations with `AUTOMATION_NOT_PAUSED`. Manual `swizzle trigger <name>` is allowed while paused and returns a warning; automatic cron/webhook firing remains paused.

Worker restart (`docker compose --env-file .env -f infra/docker/compose.yml --profile stack up -d --force-recreate worker`) is a last resort, not a standard debug step. It interrupts in-flight attempts, which the lease mechanism retries, and does not give you cleaner state than the cancel / pause commands.

## Lost worker leases

Workers heartbeat every fifteen seconds and renew accepted execution leases at most every two seconds. The server reconciles ownership every second. If a worker disappears after starting a run, its lease expires, the attempt records `WORKER_LEASE_LOST`, and the platform retries it on the same group within its retry budget. Exhausted retries dead-letter the run. A worker lost before it starts a run returns the run to the queue once without spending an attempt (`WORKER_LOST_BEFORE_START`). Old generations cannot write output, state or a result after reassignment.

A registered group can sleep. Its runs remain queued with no attempt until a worker accepts them. `runtime.queue_timeout` defaults to 24h; expiry fails the run with `PLACEMENT_TIMEOUT`. Cancellation remains available while queued. Restarting the API preserves PostgreSQL work and completion receipts; Valkey is only the delivery mechanism.

## Remote deploys: profiles and auth tokens

Deploy uploads a tar.gz bundle of the automation folder over multipart/form-data — the CLI and the Swizzle API don't need to share a filesystem. Every authenticated instance, including localhost, requires a Bearer token for CLI/agent control-plane requests.

```bash
# In Settings > Agent access: create a token named "laptop".
# The owner copies the plaintext once and provides it through a secure channel.

# On your laptop: register a profile — pin the environment with --env (named profiles require it).
# Prefer env-backed tokens; --env is the target environment inside the prod instance.
swizzle profile add prod \
  --url https://api.swizzle.example.com \
  --token-env SWIZZLE_PROD_TOKEN \
  --env prod
# or for quick setups:
swizzle profile add prod --url https://... --token <token> --env prod

swizzle profile list                  # redacts token values
swizzle profile use prod              # set default

# Then every API command can target prod
export SWIZZLE_PROD_TOKEN=<token>
swizzle --profile prod apply my-automation -e prod
swizzle --profile prod logs my-automation -e prod
```

**`--profile` and `-e` are independent axes — do not confuse them.** `--profile` selects which *instance* (API URL + token); `-e` selects the *environment namespace* inside it (secrets, deployments, triggers, scheduler ticking, worker heartbeats). A remote instance's scheduler ticks whatever `SWIZZLE_ENVIRONMENT` is set to there (often `prod`); a profile named `prod` and an environment named `prod` are not linked. **Pin the environment on the profile with `--env`, or pass `-e <environment>` per command — the CLI refuses to guess for named profiles.** A named profile with neither a pinned env nor `-e` fails fast with `ENVIRONMENT_NOT_PINNED`, unless the shell exports `SWIZZLE_ENVIRONMENT`, which then decides. Precedence: `-e` flag → profile pinned `--env` → `SWIZZLE_ENVIRONMENT`. With none set, the CLI reports `ENVIRONMENT_NOT_PINNED`. Protected API commands without a configured profile exit 4 with `SIGN_IN_REQUIRED` and instructions to sign in and register a token. The symptoms below catch an explicit wrong `-e`.

**Discover an instance's real environments before the first deploy.** The CLI has no command that lists environments. Probe candidate names; the one with a live scheduler is real:

```bash
swizzle --profile prod status -e prod     # healthy → the scheduler heartbeats here
swizzle --profile prod status -e local    # degraded / no heartbeats → dead namespace
swizzle --profile prod list -e prod       # what's actually deployed there
```

The dashboard's environment picker also lists them (it reads `GET /environments`).

**Self-diagnosis — you targeted the wrong environment if** (for example an explicit wrong `-e`):

| Symptom | What actually happened |
|---|---|
| Deploy "succeeds" but the automation isn't running | It landed in another environment on the instance, not the live one |
| Cron never fires, yet a manual `trigger` / `run` goes green | The scheduler only ticks its configured env; queues aren't env-partitioned, so manual runs fire anywhere |
| `status` shows degraded / "no heartbeats" though Docker says the worker is healthy | You queried the wrong env — the workers heartbeat in the real one |
| `list -e <realenv>` is empty, but `inspect <name>` (no `-e`) finds the automation | The deployment is in one env while you're listing another |

Fix: redeploy with the correct `-e`, or set `--env` on the profile and redeploy.

**Auth rules:**
- Localhost requests are authenticated like remote requests. The dashboard owner session or an owner-minted Bearer token is required; source IP and `Host` headers never grant access.
- Every CLI/agent control-plane request requires `Authorization: Bearer <token>`, including localhost; missing → `401 UNAUTHORIZED`, invalid/revoked/expired → `403 FORBIDDEN`.
- Revoke a leaked token under **Settings → Agent access**. An agent token cannot revoke itself or other connection tokens.

The packaged dashboard proxies `/api/*` to the API, including webhooks. A CLI profile at `https://server.example-tailnet.ts.net/api` prints `/api/hello` for a webhook at `/hello`; it keeps the entire profile path. A public install can instead use a separate API hostname. Follow the install guide's local, Tailscale, or public path for the matching origin and Caddy site settings.

**Debug remote calls:** add `--debug` and the CLI logs method, URL, headers (token redacted), and body size to stderr.

**API target precedence** (first match wins): `--api-url` flag → `--profile` flag → `SWIZZLE_PROFILE` env → the config's default profile → `SWIZZLE_API_URL` env → built-in Caddy default. Note that a configured default profile beats `SWIZZLE_API_URL` — relevant when a wrapper script sources a repo `.env`. `--profile` and `--api-url` work both globally (`swizzle --profile prod logs …`) and per-command (`swizzle logs … --profile prod`); a command-level flag wins over the global one.

## Diagnose — the primary debug command

`swizzle diagnose <runId>` is the first command to reach for when a terminal run failed. It aggregates the run, its attempts, the deployment, declared secrets, and related trigger state into a single root-cause report with suggested fixes. For a still-running or hung run, start with `swizzle logs --run <runId> --follow`; it polls the API for incremental stdout/stderr and exits when the run reaches a terminal state.

```bash
swizzle diagnose <run-id>
swizzle diagnose <run-id> --json
```

Much faster than manually correlating `logs`, `inspect`, and `deployments`. Start here, fall back to the individual commands if you need to dig deeper.

## Fuzzy name resolution

Automation names in the CLI fuzzy-match by default. The output names a fuzzy resolution under `warnings` (`resolved "order" -> "order-processor"`), and ambiguous queries fail with the candidate list instead of guessing. Destructive commands (`delete`, `rollback`) refuse fuzzy matches entirely — they fail with `EXACT_NAME_REQUIRED` (exit 2) and name the closest match. To preview matches or disambiguate explicitly:

```bash
swizzle resolve order              # ranked slug matches for "order"
swizzle logs order --exact         # require exact name
```

## CLI self-discovery

For agents: the CLI describes itself so you don't have to remember everything.

```bash
swizzle commands --json                     # full command tree
swizzle schema config --json                # config.yaml schema
swizzle schema enums --json                 # valid values for statuses, modes, trigger types
swizzle schema exit-codes --json            # process exit codes by failure class
swizzle schema runtime-error-codes --json   # runtime error codes and meaning
swizzle schema scaffolds --json             # scaffold catalog
swizzle schema error --json                 # the error shape below
```

Every command also answers `--help` with its flags, defaults and examples.

## Output and errors

Commands print TOON on stdout: keys and values, with lists as tables. Long fields are truncated with a hint to the flag that prints them whole. An empty answer says so, such as `runs: 0 runs with status failed`. Most answers end with `help`, the next commands worth running. The global `--json` prints the same data as one line of JSON. Progress and warnings go to stderr.

A failure prints an error on stdout and exits non-zero:

```text
error: "Refusing without --yes: this deletes my-automation in every environment with its deployments, triggers, state, artifacts and runs; only its audit events stay."
code: CONFIRMATION_REQUIRED
help[1]: Run `swizzle delete my-automation -e staging --yes`
```

Branch on `code`, a stable identifier, and run the first `help` entry when it is a command. `retryable: true` appears only when a retry can succeed. `details` carries structured context such as the missing secret names.

Process exit codes are typed by failure class, so scripts and agents can branch retry-vs-fix without parsing JSON:

| Exit | Class | Typical causes |
|---|---|---|
| 0 | success | — |
| 1 | generic | unexpected errors |
| 2 | usage | unknown command, bad flags, a missing `--yes`, fuzzy name on a destructive command |
| 3 | validation | invalid config.yaml, bad payload JSON, 400/422 |
| 4 | auth | missing/invalid Bearer token, 401/403 |
| 5 | backend | API unreachable, timeout, 5xx |
| 6 | not found | automation/run/deployment/secret, 404 |
| 7 | rate limit | 429 |
| 8 | conflict | `SECRET_ALREADY_EXISTS`, `AUTOMATION_NOT_PAUSED`, `TRIGGER_WEBHOOK_PATH_CONFLICT`, `TRIGGER_WEBHOOK_PATH_RESERVED`, 409 |

## Secret management

Secrets require `SWIZZLE_ENCRYPTION_KEY` set in `.env` **and** loaded by the running API. If you just set or changed the key, recreate containers before using secrets — `restart` does not reload `.env`:

```bash
docker compose --env-file .env -f infra/docker/compose.yml --profile stack up -d --force-recreate api scheduler
```

Then:

```bash
swizzle secret set MY_API_KEY --value-env MY_API_KEY
swizzle secret list
swizzle secret inspect MY_API_KEY        # metadata only, never the value
swizzle secret delete MY_API_KEY --yes   # again: already absent (no-op)
```

**Existing secrets are protected:** `secret set` on an existing name fails with `SECRET_ALREADY_EXISTS` (409, exit 8) unless you pass `--overwrite`. Other automations may share the secret name — inspect before rotating:

```bash
swizzle secret inspect MY_API_KEY
swizzle secret set MY_API_KEY --value-env MY_API_KEY --overwrite
```

All secret commands support `-e <environment>`. Plaintext is never returned by the API or CLI after storage — this is write-only by design. Agents and scripts should use `--value-env`; `--value` may expose plaintext through shell history or process arguments.

**Setting up from scratch** (no encryption key yet):

1. Generate a key: `python3 -c "import secrets; print(secrets.token_hex(16))"`
2. Put it in `.env` as `SWIZZLE_ENCRYPTION_KEY=<key>`
3. Recreate the api and scheduler containers (command above)
4. Now `secret set` works

## Notifications (Telegram)

```bash
# Alert when a run is dead-lettered
swizzle notify create \
  --automation my-automation \
  --event-type dead-lettered \
  --chat-id 123456789

# Alert on repeated failures within a window
swizzle notify create \
  --automation my-automation \
  --event-type repeated-failures \
  --chat-id 123456789 \
  --threshold 3 \
  --window-seconds 300

# Alert on every automation of a project
swizzle notify create --project default --event-type dead-lettered --chat-id 123456789

swizzle notify list
swizzle notify update <rule-id> --disable
swizzle notify deliveries --automation my-automation
swizzle notify delete <rule-id>
```

A rule belongs to the person whose token or session made it; a service account cannot make one. Each person sees and changes only their own rules, and a person who lost read access to the automation gets no further messages. The Telegram bot token is stored centrally as a platform secret (`SWIZZLE_TELEGRAM_BOT_TOKEN`) — not in `config.yaml`, not in env for user code.

Event types:
- `dead-lettered` — a run exhausted all retries
- `repeated-failures` — threshold failures within a time window

## Automation filesystem boundary

Deployed automation code runs in a short-lived, read-only container. Its working
directory is `/automation`, the read-only bundle. Scratch files go under
`$SWIZZLE_RUN_TMP` (`/tmp`), an isolated tmpfs that is destroyed after the run. The
container receives no operator home directory, host path, Docker socket, or
control-plane network access. Persist business data through an external service,
the Swizzle artifact contract, or another explicitly declared integration; do
not rely on `~/` surviving between runs.

## Backup

```bash
# Export database + deployment artifacts into a new directory
swizzle backup export --output-dir ./backups/2026-10-24

# Restore (destructive — requires --yes)
swizzle backup restore --input-dir ./backups/2026-10-24 --yes
```

Requires `pg_dump` / `psql` installed on the host. Export refuses a directory that is not empty (`BACKUP_DESTINATION_EXISTS`), so use a new one per backup. The restore enforces backend-match — a backup from a local-filesystem install won't restore into an S3-backed one and vice versa.
