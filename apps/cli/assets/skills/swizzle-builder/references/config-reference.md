# Config Reference

The main skill file covers common cases. The generated [config reference](../../../../../../docs/reference/config.md) lists every field. This page explains advanced triggers, profile routing, binary requirements, and container mode.

The rule for each field (type, default, allowed values, and constraints) lives in the config schema. Print it with its descriptions:

```bash
swizzle schema config --json
swizzle schema enums --json
```

The same schema generates the Swizzle config reference page (`docs/reference/config.md` in the Swizzle repository). If this page disagrees with the schema, the schema wins.

## Vars

`vars` is for non-secret configuration that belongs in source control with the automation.

```yaml
vars:
  PROCESSING_MODE: dry-run
  MAX_ITEMS: 25
  ENABLE_CREATE: false
```

- Keys must match `^[A-Z][A-Z0-9_]*$`.
- Keys must not start with `SWIZZLE_` and must not duplicate any declared secret name.
- Values can be strings, numbers, or booleans; the runtime injects them as strings.
- Use vars for anything you would be comfortable printing in a log line: modes, dry-run flags, thresholds, delays, batch sizes, and feature toggles.
- Use secrets only for credentials and sensitive values. For automation-specific secrets, prefer `<AUTOMATION>_<NAME>` to avoid accidental coupling through the environment-wide secret namespace.

## Connections (OAuth)

`connections` lists OAuth connection names the automation needs. A connection is a stored, environment-scoped credential the platform holds for a service (Google Workspace today, plus a generic `custom-oauth2` provider). Use this when a service needs OAuth and there is no plain API key to drop into `secrets` — e.g. "read my Google Drive".

```yaml
connections:
  - google-jan
```

- Names must be lowercase kebab-case (`^[a-z][a-z0-9-]*[a-z0-9]$`, ≤60 chars).
- A **connection** is one object holding the client credentials (client id/secret, and for `custom-oauth2` the endpoints) plus its own scopes and user tokens. Several connections (e.g. multiple Google accounts) can reuse the same client credentials. Built-in providers: `google`, `microsoft` (optional `--tenant`), `github` and `clickup` (non-expiring tokens, no refresh), and `custom-oauth2` (supply `--authorize-url`/`--token-url`).
- Create it before deploy: `swizzle connections authorize google-jan --provider google --client-id … --client-secret-env GOOGLE_CLIENT_SECRET --scopes https://www.googleapis.com/auth/drive.readonly`. Add another account reusing the same credentials with `swizzle connections authorize google-work --reuse-from google-jan --scopes …`. Deploy/trigger enable fail with `PLATFORM_REQUIRED_CONNECTIONS_MISSING` if a referenced connection is missing or not `active`.
- The client secret is stored encrypted on the connection and never displayed again — there are no reserved secret names to manage.
- At run time the current access token is injected as `SWIZZLE_CONNECTION_<NAME>` (e.g. `google-jan` → `SWIZZLE_CONNECTION_GOOGLE_JAN`); read it with `getConnectionToken("google-jan")` / `get_connection_token("google-jan")`. Refresh tokens and client secrets never reach automation code; the platform refreshes access tokens automatically.
- Connections are platform-side only; local `swizzle run` does not resolve them. For a one-off private script, a manually obtained token stored as a normal secret is still fine.

## Triggers

### Webhook

```yaml
trigger:
  type: webhook
  path: /incoming/orders
  payload_schema:
    type: object
    required:
      - order_id
    properties:
      order_id:
        type: string
      total_cents:
        type: integer
        minimum: 0
```

Webhook deployment requires `trigger.path`. Deployment without it fails with `TRIGGER_CONFIGURATION_INVALID`. Local `swizzle run` works without a path.

Paths must be unique per environment. Deployment fails with `TRIGGER_WEBHOOK_PATH_CONFLICT` if another automation uses the path. Deployment also fails with `TRIGGER_WEBHOOK_PATH_RESERVED` if the API serves the path itself, such as `/auth/sign-in/email` or `/runs/<id>/cancel`.

`payload_schema` is a standard JSON Schema object. The config parser compiles it with AJV, `swizzle run` validates local payloads before executing the entrypoint, and public webhook ingress rejects bad payloads with `WEBHOOK_PAYLOAD_INVALID` before creating a run or BullMQ job. Use it whenever the upstream event shape is known.

`signature` verifies generic `HMAC-SHA256(rawBody)` before public webhook ingress creates a run or BullMQ job. The `secret` is a platform secret name resolved from the encrypted secret store and is not injected into user code unless it is also listed under top-level `secrets`. Use SDK raw-body helpers for provider-specific schemes such as Stripe that sign `timestamp.rawBody`. The full layered hardening model (path secrecy, schema, HMAC, user-code verification with GitHub/Stripe examples) is in [Webhook Security](webhook-security.md).

### Cron — expression or interval

```yaml
trigger:
  type: cron
  schedule: "0 */6 * * *"    # every 6 hours, UTC
  # every: "6h"              # equivalent
```

Cron evaluates in UTC. There's no timezone field yet — ask the user's timezone and convert when it matters. `every` formats: `30s`, `5m`, `1h`, `2h30m`, `1d`. Minimum interval 30 seconds.

### Chain

```yaml
trigger:
  type: chain
  source: order-processor
  on: succeeded              # succeeded | failed | dead-lettered | finished
  payload: result            # result | payload | full
```

- `on: finished` fires on any terminal state (success or failure)
- `payload: result` passes the upstream's stdout JSON as this run's payload
- `payload: payload` passes the upstream's original input instead
- `payload: full` passes `{ source: { automationName, payload, result, runId, status } }`
- Circular dependencies are rejected at deployment time

Testing chain automations locally: create a `sample-payload.json` that mimics the upstream's output shape, then run with `--payload-file`. Chains can't auto-fire locally — they need a platform deployment to wire up.

#### Join: fan-in on multiple sources

A chain trigger can fan **in** instead of following a single source. Use `sources` (plural) to fire one stage only when several upstreams have all succeeded for the same origin run — the join half of a static fan-out.

```yaml
trigger:
  type: chain
  sources: [reviewer, e2e-verifier]   # 2+ distinct automation names; mutually exclusive with `source`
  on: all-succeeded                    # v1: only allowed value with `sources`
  payload: results                     # v1: only allowed value with `sources`
```

- `sources` is **mutually exclusive with `source`.** Provide one or the other, never both. Single-`source` chains (above) are unchanged.
- `sources` needs **2+ distinct** automation names.
- With `sources`, `on` must be `all-succeeded` and `payload` must be `results`. These are the only v1 values and the defaults, so both lines are optional.
- **Correlation:** the join fires once per **origin** run — the shared upstream that chain-triggered every source. All listed sources must themselves be chain-triggered from that common origin, or their completions can't be tied together and the join never fires.
- **Payload shape:** `{ origin: { automation, runId }, results: { <sourceName>: <result>, ... } }`, where each `results[name]` is that source run's stdout JSON.
- **Dead-letter blocks the join (v1):** if any source dead-letters, `all-succeeded` does not fire and the join stage does not run. Pair the sources with dead-letter notification rules ([Operations](operations.md)) so a failed branch stays visible.
- **First success wins:** the first `succeeded` run per source per origin is the one that counts; later reruns of a source for the same origin don't re-fire the join.

Design guidance for pipelines that use this (fan-out shapes, handoffs, when to prefer a join over dynamic `invokeAutomation`): [Agent Workflows — the join trigger](agent-workflows.md#the-join-trigger).

## Runtime profiles: worker groups

`runtime.profile` names the worker group a run goes to. An owner or admin grants each machine its groups for a project and environment; `swizzle worker groups` lists the groups that serve yours. The default `host-default` is the stack's own worker.

```yaml
runtime:
  profile: gpu-home
  queue_timeout: 2h      # default 24h
  permissions:
    services: [local-llm]  # only on a group whose worker offers the local LLM
```

A run waits for a live worker granted its group, project and environment, and never runs in another group. While every such worker is offline, busy or reports the requested service unhealthy, the run stays `queued` without spending an attempt; at `queue_timeout` it fails with `PLACEMENT_TIMEOUT`. `swizzle diagnose <runId>` names the reason and the deadline. Deploy refuses a group no worker serves here and warns when all its workers are offline.

## Binary requirements

Declare host binaries the automation needs. Workers heartbeat which binaries they have; deployment readiness checks enforce this.

```yaml
runtime:
  requirements:
    binaries:
      - name: ffmpeg
      - name: imagemagick
        version: "7"
```

If a binary isn't in the worker image (`infra/docker/Dockerfile`, target `service`), you have to add it there before the deployment will pass readiness.

## Rate limits

Dispatch pacing declarations. Format `"<max>/<unit>"` where unit is `sec`, `min`, or `hour`.

```yaml
runtime:
  rate_limits:
    api_calls: "60/min"
    database_queries: "100/sec"
    batch_ops: "1000/hour"
```

The platform consumes one token per run dispatch. Inside a run, call SDK helpers against these groups for local pacing and usage visibility:

- TypeScript: `await pace("api_calls")`; `recordRateLimitUsage("api_calls", 1)`
- Python: `pace("api_calls")`; `record_rate_limit_usage("api_calls", count=1)`

There is no V1 cross-run per-call limiter. `record_rate_limit_usage()` only records stats.

See [SDK Usage](sdk.md) for details.

## Retry

```yaml
runtime:
  retry:
    max_attempts: 5
    backoff: exponential   # exponential (default) | fixed
```

- `exponential`: base 1s, capped, grows per attempt
- `fixed`: constant 1s between attempts
- When attempts are exhausted, the run lands in dead-letter state
- Dead-lettered runs can trigger Telegram notifications — see [Operations](operations.md)

## Overlap policy (`on_overlap`)

```yaml
runtime:
  on_overlap: skip   # skip | queue
```

Controls what happens when a new run is due while a previous one for the same automation is still `queued` or `running`:

- `skip` — the new run is **not enqueued**; the scheduler records a `cron_skipped` audit event with `reason: overlap`.
- `queue` — the new run is enqueued regardless; BullMQ and `WORKER_CONCURRENCY` determine parallelism.

Defaults by trigger type: **`skip` for cron**, **`queue` for webhook and chain**. Cron default prevents pile-ups when a run takes longer than its interval (e.g. a 2m job on a 1m schedule); webhook default preserves "every incoming request runs" semantics.

Set `on_overlap: queue` on a cron only if you know each run is independent and you actually want concurrent executions.

## Permissions

```yaml
runtime:
  permissions:
    network: true          # default true
    writable_dirs:
      - ./work
      - /tmp/tool-cache
```

Production workers enforce these permissions in the container sandbox. Trusted local host-process runs treat them as advisory settings.

Relative directories resolve under `/automation`. A path that starts with `~` fails validation with `AUTOMATION_CONFIG_INVALID`, because the sandbox does not expand it: write `data` for `/automation/data`, or an absolute path. Each declared directory is an ephemeral tmpfs. Paths cannot traverse parents or contain `:` or `,`. Absolute paths cannot lie under `/dev`, `/proc`, `/sys`, `/home/swizzle`, or `/run/swizzle`. The sandbox home is already writable and ephemeral.

## Container mode

```yaml
runtime:
  execution_mode: container
  container:
    base_image: "python:3.12-alpine"
    cpus: "0.5"
    memory_mb: 512
```

`execution_mode` only changes a trusted local `swizzle run`: `host` and `profile` run a host process, `container` runs the sandbox. Production workers run every deployed run in the container sandbox, whatever the mode. A custom `base_image` is operator-trusted and must provide the declared runtime and any required tools.
