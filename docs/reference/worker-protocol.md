# Worker protocol

This page records the shared local and remote worker contract.
The API owns queues, admission, orchestration and durable leases. Every worker, including the packaged local worker, pulls source and execution inputs through the same protocol.

## Worker identity

A worker has a stable ID, display name, owner-approved profiles, and explicit Project and environment grants.
Profiles are exact names, including `host-default`; enrollment grants no implicit default membership.
The stack's local worker is the one exception to explicit grants: it serves every project and environment of the instance, including ones created later ([`workerReach`](../../packages/db/src/workers.ts)).
Labels and host capabilities do not grant authority. Only an instance owner or admin administers workers through the central access policy.

Enrollment exchanges a single-use code, valid for ten minutes, for an opaque worker token.
PostgreSQL holds only hashes of codes and tokens. Worker credentials use the same `swz_` token format and `api_tokens` lifecycle as personal and service-account tokens. The token holder identifies the worker actor; the prefix grants no authority.
Every protected worker request rechecks revocation and token expiry. Worker credentials never authorize owner or project routes. Public routes and direct-loopback readiness ignore bearer headers. Public enrollment still requires its single-use code.
A worker may renew only while its existing identity and token are live. Revocation is final for that identity. Remote tokens last 90 days. The file-backed worker checks expiry before requests and renews during the last seven days, including its first request after time offline. The configured local identity is provisioned centrally and does not rotate through this endpoint.

`POST /worker/token/renew` takes `{ "token": "<next opaque worker token>" }` and returns the new credential and worker record. The client generates the next token with 32 random bytes and saves it as a pending token before sending the request. Rotation atomically revokes the old API token, creates its replacement, and increments the worker's credential generation. A pending token that authenticates after a lost response is promoted locally; otherwise the client retries renewal using its old credential and the same candidate. Revocation refuses both. Requests refused during a concurrent rotation retry with the replacement credential. A caller can cancel its own wait for shared rotation without interrupting other callers. Worker shutdown cancels the shared credential requests and stops new rotations, so executions can drain using the current token.

The worker atomically writes and syncs its private credential file and its containing directory. The worker-only stack keeps it in a named volume, so container recreation reads the renewed token. The enrollment env file is the initial copy, not the live credential. Expiry while offline requires owner re-enrollment.

## Execution and lease data

The server owns dispatch. Remote executors use HTTPS. The configured local identity uses the same routes on a separate listener bound to the private Compose worker network; public ingress rejects its credential on authenticated routes.
Neither executor receives PostgreSQL, Valkey, storage, or encryption credentials.
Local and remote workers run the same [`executeAssignment`](../../packages/runtime/src/execution-wire.ts); only the API address differs.
Workers use the same concurrency default in the dev stack, packaged stack and remote worker. `WORKER_CONCURRENCY` overrides it; an empty value uses [`worker-settings.ts`](../../packages/core/src/worker-settings.ts). The local identity's server admission budget uses the same value. The worker's loopback `/health` response reports its execution slots as `concurrency`.

Every heartbeat reports the host's measured capabilities: languages, binaries, execution modes and dependency packaging. The API stores them on the worker's row, the one record of a worker's state, beside its grants, liveness, service health and image disk. A worker pulls only when it has a local slot and its required Docker broker is reachable, and checks the broker again after the pull, leaving the assignment unstarted if it became unreachable while the pull waited. Its readiness endpoint returns 503 when the broker is unavailable. The server checks approved profiles, project/environment grants, and one concurrency budget across all profiles.
Preparation receives only its assigned immutable bundle, with a digest and bounded extraction. It receives no secrets. Each machine assembles run images on its own Docker engine from a runner base it built itself ([`execution.yml`](../../infra/docker/execution.yml)), so an arm64 and an amd64 worker of one group each run images of their own architecture. Before assembly, the worker reports the tag for that deployment to `POST /worker/run-images`. PostgreSQL stores one tag per deployment and worker.

An accepted execution records its worker ID, run or check target, execution number, generation, expiry and absolute deadline in PostgreSQL. The target retains its project and environment; protocol routes define the allowed actions. The claim also stores the worker's name on the run's execution row. `GET /runs/:runId`, `swizzle runs inspect` (`worker`, and per execution in `attemptHistory`) and the run panel's "Ran on" then name the machine for each execution, even after the worker is renamed or revoked.
The authenticated worker identity and stored lease bind those values together. Every execution request names its lease as `{taskId, generation}` and the server reads the rest from the lease row. It checks worker revocation, ownership, generation, expiry, and action.
[`worker-wire.ts`](../../packages/runtime/src/worker-wire.ts) defines each route's request and reply schema and the limits below. The API checks request bodies against it and answers a mismatch, including an unknown field, with HTTP 400. The worker parses every reply with it.
The starting heartbeat interval is 15 seconds, the offline threshold 60 seconds, and the renewable execution lease 90 seconds.
Renewal runs at most every two seconds. Replies include `remainingMs`, a server-relative duration. Before execution the worker renews, subtracts the full renewal round trip and a safety margin, and starts a monotonic deadline. It does not compare its wall clock with the server's expiry. A delayed renewal cannot revive an expired local deadline. An absolute execution deadline is runtime.timeout plus fifteen minutes for source staging and the existing ten-minute image assembly. Renewal cannot extend that deadline.

## Run events and delivery

A run event identifies its execution generation and increasing sequence number. Repeated writes converge on the accepted result.
The server validates event size, sequence, action, and lifecycle transition before persisting it.
Old generations cannot append logs, complete a run, change state, or fetch secrets after reassignment.
Logs, results, steps, waits, approvals, pacing, timeouts, state, and child runs use execution-scoped operations.
State remains bound to the automation and environment. Child runs receive their own declared credentials.
OAuth refresh stays central. Only declared secrets, link variables and connection access tokens reach an accepted execution over TLS, just before execution. The executing machine adds its own allowlisted base environment, such as `PATH` and `HOME`; the server sends none of its own.

## Queue wait and recovery

An omitted `runtime.profile` selects `host-default`. Unknown profiles are rejected; a registered profile remains deployable while its machines sleep.
A runnable execution segment receives a server-clock placement deadline, defaulting to 24 hours and configurable per automation.
Offline requeues retain that deadline. Waiting consumes no execution attempt and never falls back to another group.
A retry or resumed segment receives a fresh placement budget. Set `runtime.queue_timeout`, for example `30m`, to change the default.
While a run waits, `GET /runs/:runId` and the dashboard run page include `placement`. It names the group, requested services, deadline, and each eligible machine. Each machine has a reason: `offline`, `service-unhealthy`, `busy`, or `ready` before a claim. The run's `wait` names the reason closest to a claim, or `no-worker` when no machine is eligible. [`placementInWords`](../../packages/db/src/worker-words.ts) turns it into the sentence and fixes that `swizzle diagnose` prints, and `placement.words` carries them, so the run panel shows them with each poll of the run. The Overview's Needs you lists each automation whose queued runs wait as `no-worker`, `offline` or `service-unhealthy`, with that sentence and the earliest deadline.

`workerFit` in [`workers.ts`](../../packages/db/src/workers.ts) reads each worker's grants, liveness, drain state, free slots, and recent service health. Pull, run claims, check claims, and placement use this decision. A claim checks it again under the worker's row lock. `swizzle diagnose` reports the run as `WAITING_FOR_WORKER`.

Deploy readiness first lists workers whose grants reach the project and environment through [`workerReaches`](../../packages/db/src/workers.ts), with the capabilities each reported while it is online ([`listRegisteredReadinessWorkers`](../../packages/runtime/src/deployment-admin.ts)). [`workerGaps`](../../packages/runtime/src/runtime-requirements.ts) reports each worker's group, service grant, liveness, execution mode, language, and required binary gaps. Groups and services are grants, as placement reads them, so an automation whose `runtime.permissions.services` names a service no worker of its group is granted is refused even while that worker is offline. A deployment is ready when one worker has no gaps, regardless of worker order. A refusal names each worker of the group and its gaps. With no worker in the group, it names only the group.
At expiry the run is dead-lettered with `PLACEMENT_TIMEOUT` and the dead-letter reason `placement-timeout`, so it notifies and resumes a waiting parent as any dead letter does. Its error names the project, the environment and the group, and says how an owner or admin grants a worker. Cancellation remains available during the wait.

A worker renews its lease through transport errors, HTTP 429 and HTTP 5xx until its local deadline, each renewal bounded to ten seconds, so a short API outage or reconnect keeps the execution. Only a refusal, any other HTTP 4xx, stops it at once. An honest executor stops before lease expiry and checks the lease after waking before accepting output.
After detecting sleep, a worker waits until it has stayed awake for 90 seconds before pulling another assignment. macOS can wake a closed laptop for about 45 seconds at a time, and Docker Desktop's VM clock can stop during sleep. The worker detects a pause when an API reply's `Date` header puts the server clock more than three seconds further ahead of the worker's monotonic clock than the largest lead recorded from earlier replies. If the worker detects a pause during lease renewal before an assignment starts, it leaves the assignment unstarted. The server requeues it when the lease expires under the rule below.
A lease that expires before `POST /worker/start` returns its run to the queue without spending an attempt, with a fresh placement budget: the machine never received secrets or began the run. Its execution row records `WORKER_LOST_BEFORE_START`. Only one delivery per attempt is free; when the next delivery is lost before start too, it spends the attempt like a started one.
The server marks an expired started execution lost and retries on the same profile under the run's retry policy.
The API reconciles PostgreSQL every second and reconstructs queued BullMQ jobs, including retry jobs after their backoff. It derives the remaining retry budget from `runs.attempts_made`, so a delivery lost before start does not spend an attempt. A BullMQ job ends when a worker claims its run. The execution then belongs to its PostgreSQL lease.

Each execution request reads its sealed state from the lease row and writes the next state under the lease lock. That state holds the delivered secrets, redaction values, output sequence and byte counts, and the unfinished stderr line. It also holds API contacts and rate-limit usage. The server records contacts and usage however the execution ends. Any API process can answer the next request, so the worker can renew, send output, and complete the same execution after an API restart.

Unclaimed offers yield their BullMQ slot so unavailable grants cannot starve other work. Terminal outcomes persist follow-up intents for chains, parent resumption, and notifications. The API loop applies those intents. Final state and the accepted result digest commit atomically. A repeated completion is accepted after a restart; stale or conflicting results are rejected.
Execution is at least once. A lost connection cannot prove that external effects stopped; provider idempotency keys remain necessary.
Graceful shutdown drains work. Revocation refuses further requests and requests cancellation, but cannot erase delivered values or stop a hostile host.

## Registry operations

The dashboard lists registered machines under **Settings > Workers**, with their groups, project and environment grants, connectivity state, slots in use, current runs, and local LLM health. Only owners and instance admins can list workers there.
`GET /projects/:project/worker-groups` and `swizzle worker groups` list the groups that serve one project and environment. Each entry includes machine names and state, but no address or credential. Anyone who can read the project may list its groups and choose a `runtime.profile` without worker administration access.
A heartbeat makes a live token's worker online for 60 seconds. Enrollment alone leaves it offline until its first heartbeat.
Changing dashboard scope clears the enrollment code and form. An answer from the abandoned scope never appears under the new scope's instructions.
Revoked workers remain listed for provenance. Expired enrollment codes require a new enrollment; revocation never restores an identity.

`swizzle worker create` issues the code. `swizzle worker enroll` reads it from stdin and creates a private credential file without overwriting an existing file.
The file is an env file with `SWIZZLE_WORKER_API_URL`, `SWIZZLE_WORKER_ID`, `SWIZZLE_WORKER_TOKEN` and `SWIZZLE_WORKER_TOKEN_EXPIRES_AT`. The worker reads it from `SWIZZLE_WORKER_CREDENTIAL_FILE`, and `infra/docker/compose.worker.yml` takes it with `--env-file` ([add a remote worker](../how-to/add-a-remote-worker.md)).
Enrollment requires HTTPS, with HTTP allowed only on loopback for local testing, including the packaged `api.localhost` endpoint.
Store that file outside automation bundles. The registry never injects its token into automation processes.
The [CLI reference](cli.md) lists the command options; the [API reference](api.md) lists the HTTP routes.

`GET /worker/session` checks the requested profile and project/environment pair against the worker's stored grants.
It returns no assignments, secrets, or environment data.
All identity mutations lock the worker row, so a request authenticated before revocation or rotation cannot later renew or heartbeat with its stale generation.

Enrollment allows ten exchanges per client address per minute, including invalid codes. This budget lives in PostgreSQL and survives API restarts. A depleted budget returns HTTP 429 with `Retry-After: 60`.
Worker bearer authentication reads the current credential without a row lock. It updates `api_tokens.last_used_at` at most once per minute, using the same throttled touch as personal and service-account tokens. Authentication does not maintain a per-request worker counter.
Creation, enrollment, renewal, revocation, and scope refusals produce audit records without credential values.
An owner or instance admin reads them through `GET /workers/:workerId/audit`.

## Execution routes

| Route | Result |
|---|---|
| `POST /worker/runtime` | Receives `{capabilities, services, runImageDisk}` and stores all three on the worker's row with the time it was seen. Deploy readiness reads `capabilities`; grants and capacity come from the registry. `services` is the health of each service the worker runs, such as `local-llm`, which claims read. `runImageDisk` is the last image prune pass's measurement, `{activeBytes, budgetBytes}`, or null before the first pass: `activeBytes` is the size of images kept for active deployments, and `budgetBytes` is the worker's configured disk budget in bytes. The API stores it on the worker's row. `GET /workers` returns it as `runImageDisk`, and as `runImageDiskOverBudget` while the worker is unrevoked and active images alone exceed the budget; otherwise that field is null. `runImageDiskWarning` is the overage in words from [`runImageDiskWarning`](../../packages/db/src/worker-words.ts), which Settings > Workers, the Overview and `swizzle worker list` print. |
| `POST /worker/preparations` | Active deployment IDs and at most one unknown source bundle for the worker's grants, without secrets. |
| `POST /worker/run-images` | Records `{deploymentId, tag}` after checking the worker's deployment scope. Repeatable. |
| `POST /worker/run-images/keep` | Receives `{}` and returns `{keep: string[]}`: the newest tag this worker reported for each active deployment version in each environment. The worker's next prune pass keeps those images. The authenticated request is the proof that the worker is live, so no heartbeat age applies. |
| `POST /worker/pull` | Long-polls for up to fifteen seconds; returns an assignment or null. |
| `POST /worker/source` | The accepted execution's immutable bundle files. The lease is checked again after the bundle is read, so a worker revoked or a run cancelled meanwhile gets HTTP 409. |
| `POST /worker/start` | Records that the execution started and returns its secrets. |
| `POST /worker/ready` | Records `phase: "executing"` on the active run execution after image, dependency, and sandbox preparation. Until then, the execution reports `phase: "preparing"`. Repeatable under the live lease. |
| `POST /worker/lease/renew` | Renews current ownership, capped by the execution deadline. |
| `POST /worker/output` | Applies ordered stdout/stderr chunks. Repeating the last acknowledged sequence and content is idempotent. A chunk past the output limit, or a state or step event that fails, ends the execution with that failure in the same transaction that found it; that reply and every later request of the execution get HTTP 409, and the worker stops the sandbox. |
| `POST /worker/complete` | Validates exit status and JSON stdout, then commits the execution and receipt together. |
| `POST /worker/drain` | Stops new admissions while current leases may finish. |

Assignments contain a run or check lease, script kind, input, state/step snapshots, trace context and the SHA-256 digest of the bundle's manifest; they carry no secrets and no source. The worker fetches the source with `POST /worker/source`, refuses a bundle whose digest differs, stages it, and only then calls `POST /worker/start` for the secrets. Both routes answer only the current owner of the live lease; another worker, an older generation or a finished lease gets HTTP 409. A transfer broken off before start is fetched again under the same lease or, after expiry, by the next owner. Transfer allows 4,096 files and 32 MiB total, checks SHA-256, preserves executable bits, and rejects links, traversal and duplicate paths. Each output stream is limited to 1 MiB. Chunks have increasing sequence numbers within one generation. Logs, state and step writes are acknowledged after their durable processing. Final completion is a single immutable report. Workers retry transport failures, HTTP 429 and HTTP 5xx with the identical output sequence/chunk or report while their lease remains valid. Executors await output acknowledgements before reporting completion.

Checks consume the same worker capacity as runs. They retain their own check record and due time, without creating a run or receiving state. Source, secret resolution, OAuth refresh, redaction, state, steps, waits, retries and child orchestration remain in the API.

The packaged stack provisions one local identity from `SWIZZLE_LOCAL_WORKER_TOKEN`, scoped to `host-default` and serving every project and environment of the instance; its row stores no grants. It is marked **Local** in Settings and can be revoked there. The configured credential lasts until revocation; restarting with the same configuration never recreates a revoked identity. Its private listener exposes execution routes only, with no enrollment or worker administration. Additional machines require owner/admin enrollment.
