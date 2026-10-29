# Runtime contract

The process contract between the worker and an automation entrypoint. It is the same for every language. The SDKs ([`packages/sdk-ts`](../../packages/sdk-ts/src/index.ts), [`packages/sdk-py`](../../packages/sdk-py/swizzle_sdk.py)) provide helpers for the contract, including API contact and contract-change events. Why the contract has this shape is in [the durability boundary](../explanation/durability.md). The `config.yaml` fields are in the [config reference](config.md).

## Process

| Channel | Contract |
|---|---|
| stdin | The trigger payload as one JSON document, then end of file. |
| stdout | Exactly one JSON document: the run result, or one suspend sentinel. Nothing else. |
| stderr | Logs and structured events, one JSON object per line for events. |
| Exit code | `0` with valid JSON on stdout succeeds. Any other code fails the attempt. |
| Working directory | A host run (`swizzle run`, or a worker without the sandbox) starts in a fresh scratch directory. A container run starts in `/automation`, the deployed bundle on a read-only file system. |
| Scratch files | `SWIZZLE_RUN_TMP` names a writable directory in both: the host scratch directory, or `/tmp` in a container, a 64 MiB tmpfs. In a container, a relative path is writable only under a directory that `runtime.permissions.writable_dirs` declares ([`sandboxSpec`](../../packages/runtime/src/sandbox.ts)). Both scratch directories are deleted when the run ends. |

stdout and stderr are each limited to 1 MiB. For deployed runs, the API replaces exact injected secret and connection-token values with `[REDACTED]` in stored stdout and stderr, parsed JSON results, and streamed logs. It also replaces approval and event link tokens by their shape in those outputs. The API redacts link tokens in responses to people and tokens, including step values, state, child payloads, and approval details, while worker routes return the stored values for execution. The [security model](../explanation/security-model.md) describes the limits of this redaction.

For container runs, image preparation logs and process stderr share that limit. A run that exceeds its preparation log allowance stops waiting and fails on its own. Other runs and background preparation can finish the shared assembly. The assembly itself stops at its shared 1 MiB log limit. Process overflow stops the process. Captured output keeps the longest complete UTF-8 prefix that fits, including an initial byte order mark; stdout keeps its separate 1 MiB allowance.

| Failure code | Cause |
|---|---|
| `PROCESS_EXIT_NON_ZERO` | The process exited with a code other than `0`. |
| `PROCESS_STDOUT_EMPTY` | Exit code `0`, but stdout was empty after trimming. |
| `PROCESS_STDOUT_INVALID_JSON` | Exit code `0`, but stdout was not one JSON document. |
| `DOCKER_CONTROL_TIMEOUT` | A Docker control command exceeded its five-second deadline. Cleanup uses separate deadlines. See [Docker lifecycle limits](../explanation/security-model.md#docker-lifecycle-limits). |
| `DOCKER_TRANSFER_TIMEOUT` | A Docker copy, commit, or image export exceeded its sixty-second deadline. See [Docker lifecycle limits](../explanation/security-model.md#docker-lifecycle-limits). |
| `CONTAINER_RUNTIME_UNAVAILABLE` | Docker failed the platform: the CLI or daemon is unreachable, or a step of the run image assembly, such as the commit, failed twice. |
| `PLATFORM_CONFIG_INVALID` | An operator setting the worker reads before the run is invalid, such as a `SWIZZLE_MAX_RUN_MEMORY_MB` that is not a positive number. Every attempt would meet the same setting, so the run fails at once. |
| `CONTAINER_BUILD_FAILED` | The automation's dependency install failed, ran past the assembly deadline, or wrote more than `SWIZZLE_MAX_INSTALL_DISK_MB`. |
| `CONTAINER_IMAGE_PRUNE_INTERRUPTED` | Image assembly lost its containerd lease on its second try, likely because another process ran `docker image prune` on the worker's daemon. The run fails after that reassembly. See [worker host cleanup](../how-to/install.md#clean-up-a-worker-host). |
| `PROCESS_TIMEOUT` | The run exceeded `runtime.timeout`. The worker sends `SIGTERM`, then `SIGKILL`. |
| `PROCESS_SIGNAL` | A signal terminated the process. |
| `PROCESS_OUTPUT_LIMIT_EXCEEDED` | stdout or stderr exceeded 1 MiB. |
| `RUN_CANCELLED` | Someone cancelled the run (`swizzle runs cancel`, the API or the dashboard). The API refuses further lease renewals and output after cancellation. The worker stops on its next renewal, normally within two seconds, or before its last acknowledged expiry if the network is unavailable. |
| `AUTOMATION_STATE_LIMIT_EXCEEDED` | A state event broke a state limit. |
| `AUTOMATION_STEP_LIMIT_EXCEEDED` | A step event broke a step limit. |
| `UPSTREAM_CONTRACT_CHANGED` | The process exited with a code other than `0` after a `contract_changed` event. The message names the API and the field. The run is not retried, because the next attempt meets the same answer. |

A deployed run retries these codes up to `runtime.retry.max_attempts` ([`classifyFailure`](../../packages/runtime/src/run-lifecycle/failure.ts)): `PROCESS_EXIT_NON_ZERO`, `PROCESS_SIGNAL`, `PROCESS_TIMEOUT`, `DOCKER_CONTROL_TIMEOUT`, `DOCKER_TRANSFER_TIMEOUT`, `CONTAINER_RUNTIME_UNAVAILABLE` and `UNEXPECTED_RUNTIME_ERROR`. The run fails on its first attempt for every other code.

## Environment variables

A deployed run receives only these variables, the declared `secrets`, the declared `vars`, and a short allowlist of the executing machine's variables such as `PATH`, `HOME` and `LANG` ([`platformBaseEnvironment`](../../packages/runtime/src/platform-secrets.ts)).

| Variable | Value |
|---|---|
| `SWIZZLE_RUN_ID` | The run id. |
| `SWIZZLE_ATTEMPT` | The retry attempt this execution spends against `runtime.retry.max_attempts`. A resume from a wait starts again at 1. |
| `SWIZZLE_EXECUTION` | Which execution of the run this is, counting every resume and retry. |
| `SWIZZLE_AUTOMATION_ID` | The automation id. Local runs use `local-<name>`. |
| `SWIZZLE_AUTOMATION_NAME` | `name` from `config.yaml`. |
| `SWIZZLE_AUTOMATION_VERSION` | `version` from `config.yaml`. |
| `SWIZZLE_VERSION_ID` | The stored version id. Local runs use `local-<name>-<version>`. |
| `SWIZZLE_ENV` | The environment name. Local runs use `local`. |
| `SWIZZLE_TRIGGER_TYPE` | `webhook`, `cron` or `chain` when the trigger fired, `manual` when someone started the run with `swizzle trigger`, **Run now** or a local `swizzle run`, or `check` in an API check. Automation code uses this value to distinguish a manual run from a webhook delivery. |
| `SWIZZLE_PARENT_RUN_ID` | The parent run id. Set only for a child run. |
| `SWIZZLE_RUN_TMP` | The scratch directory. |
| `SWIZZLE_STATE_FILE` | Path of the JSON state snapshot. Deployed runs only: a local `swizzle run` holds no platform state. |
| `SWIZZLE_STEPS_FILE` | Path of the JSON snapshot of stored step results. Deployed runs only. |
| `SWIZZLE_RATE_LIMITS` | `runtime.rate_limits` as a JSON object. |
| `SWIZZLE_WEBHOOK_HEADERS` | Webhook request headers as a JSON object, without `authorization`, `proxy-authorization` and `cookie`. Webhook runs only, so a `manual` run has none. |
| `SWIZZLE_WEBHOOK_RAW_BODY_PATH` | Path of the raw request body. Webhook runs only. |
| `SWIZZLE_WEBHOOK_RAW_BODY_SHA256` | SHA-256 of the raw request body. Webhook runs only. |
| `SWIZZLE_LOCAL_LLM_URL` | Named inference endpoint. Set only for a sandbox attempt declaring `runtime.permissions.services: [local-llm]` on an approved worker. |
| `SWIZZLE_LOCAL_LLM_TOKEN` | Attempt-scoped bearer token for that endpoint. Expires without renewal and is revoked when execution ends. |
| `SWIZZLE_LINK_URL` | The public base of approval and event links. Deployed runs only, when the API has `SWIZZLE_LINK_URL` and a valid encryption key. |
| `SWIZZLE_LINK_KEY` | The run's key for signing its approval and event links ([approval and event links](../explanation/approvals.md)). Set together with `SWIZZLE_LINK_URL`. |
| `SWIZZLE_CONNECTION_<NAME>` | Access token of each declared connection. The name is upper-cased, and every character other than `A-Z` and `0-9` becomes `_` ([`connectionEnvVarName`](../../packages/runtime/src/platform-connections.ts)). |
| `SWIZZLE_CONNECTION_<NAME>_EXPIRES_AT` | ISO expiry of that token, when the provider reports one. |

A run with `permissions.network` also receives the egress proxy settings.

No variable carries a Swizzle token. A run acts with the credentials its deployment bound, not as the person who deployed it. Code that must call the Swizzle API needs a [project service account](../explanation/security-model.md#tokens-act-within-a-fixed-scope) token stored as a declared secret, and acts within that token's scope.

## State snapshot and steps snapshot

`SWIZZLE_STATE_FILE` holds the automation's state in the run's environment as one JSON object, read before the attempt. `SWIZZLE_STEPS_FILE` holds the stored step results of the run as one JSON object keyed by step name. Neither file changes during the attempt, so two runs that start together read the same state. A value read from the snapshot cannot tell a run whether another run already acted on a key. Use a [claim](#claims) for that.

## stderr events

The worker reads stderr line by line for each process. A line that parses as a JSON object with one of these `type` values is an event. The worker forwards output through its lease; for a run, the API applies state and step events to PostgreSQL in order. Every other line is log text.

| `type` | Fields | Effect |
|---|---|---|
| `state_set` | `key`, `value` | Stores `value` under `key` in the automation's state. |
| `state_delete` | `key` | Deletes `key` from the automation's state. |
| `step_start` | `key` | Marks step `key` as running for the dashboard's live track and replay. If an attempt started the step but did not finish it, a later attempt updates its start time. The worker ignores this event after the step has a result. |
| `step_result` | `key`, `value` | Stores the result of step `key` for this run and marks it finished. A second event for a finished key is ignored. |
| `rate_limit_usage` | `group`, `count` (default `1`) | Adds `count` to the usage of a `runtime.rate_limits` group for this attempt. |
| `api_contact` | `host`, `status`, optional `method`, `path`, `deprecation`, `sunset`, `link`, `timestamp` | Records the host's response status and any Deprecation or Sunset date. The SDK helpers emit one event per distinct host, status and retirement notice in a process. Deprecation accepts an RFC 9745 timestamp such as `@1688169599`, an HTTP date, or the legacy value `true`. Sunset accepts an RFC 8594 HTTP date. The worker keeps only a Link URL with `rel="deprecation"` or `rel="sunset"`. It removes the path query and redacts the path and URL. At attempt end, it stores one row per host. This write is best effort and does not change the run or check outcome. |
| `contract_changed` | `api`, `field`, `expected`, `got` | Marks that the code's own parser found an API answer changed. When the process then exits non-zero, the run fails with `UPSTREAM_CONTRACT_CHANGED`. |

`step`, the event `logStep` writes, is log text with structure. The worker does not interpret it.

The API publishes each `step_start` and `step_result` it stores as a `step` event on `GET /runs/:runId/logs/stream`. The event includes `key`, `status` (`started` or `done`), `attempt`, `executionNumber` and `timestamp`. A `chunk` event also includes `executionNumber`. A `status` event includes `status` and `terminal`. A terminal run sends `end` with the run status, then closes the stream. Only finished steps reach `SWIZZLE_STEPS_FILE`, so a step whose execution ended before its result was stored runs again.

## Diagnosis and replay

`GET /runs/:runId` and `swizzle runs inspect <runId>` include the original payload, with the same read permission as the dashboard's Payload tab. `swizzle diagnose <runId>` names the last Python exception or Node exception in stderr. When stderr includes a traceback or stack with a source frame, the diagnosis includes its source file and line. Overview's Failing card uses the stored error message without loading the run's stdout or stderr on each poll. The run panel's **Hand to agent** text preserves the stored error and adds the diagnosis summary when the two differ. Both handoffs give advice for the run's trigger. They tell the agent to start a chain run through its source because replay cannot start a chain run. They also say that webhook replay has no signed delivery and tell the agent to ask the sender to redeliver if the automation checks the signature. `swizzle logs --run <runId> --full` writes stderr and stdout as text blocks after its TOON response, preserving line breaks when stdout is piped. With `--json`, it keeps each stream as a JSON string.

`swizzle runs replay <runId>`, `POST /runs/:runId/replay`, and **Run again** in the dashboard start a new manual run with the original payload on the active deployment. Replay requires read permission on the source run and run permission for its automation in the source environment. Code that requires a signed webhook delivery rejects a manual replay. Request redelivery from the sender for those runs. The audit event names the source run and does not contain its payload. Start a chain run through its source rather than replaying it manually.

`validate` labels the configured runtime as `sandbox (container)` and reports its local execution mode as `localRun`. `inspect` shows the active deployment's execution mode: `host` or `sandbox (container)`.

## API checks

An automation with `api_check.mode: active` ships a check script beside its entrypoint, `check.ts` by default. The platform runs it every `api_check.every` (default `7d`) and once after each deploy. The platform stores one `automation_checks` record per automation and environment. A check creates no run row and counts toward no run statistic. The record stores a parsed [`ApiCheckReport`](../../packages/db/src/check-report.ts) with `ok`, `checked`, and `change`, alongside raw output. Dashboard reads use the report fields. Raw output remains available for diagnostics and Hand to agent text.

| Channel | Contract |
|---|---|
| stdin | `{}` |
| stdout | `{"ok": true, "checked": [...]}` when the API answers as the code expects. `checked` lists the calls made, which the About tab shows. On drift, stdout may be empty; the `contract_changed` stderr event names the change. |
| Exit code | `0` with `"ok": true` is green. `contract_changed` signals drift. A bare exit `1` also signals drift for checks that use the exit convention. A Python traceback, Node exception, or credential failure is an error even with exit `1`. A standalone Node frame counts as an execution error only when spaces or tabs indent `at` on the same line. HTTP 401/403 in the status position and recognizable IMAP login failures report a credentials error. Any other ending is undecided, such as a 503, a timeout or `0` without `"ok": true`. |
| Environment | As a run of the same deployment, with `SWIZZLE_TRIGGER_TYPE=check`. It receives the automation's secrets, or only `api_check.secrets` when set, and its connections. `SWIZZLE_STATE_FILE` and `SWIZZLE_STEPS_FILE` are not set. |
| Events | `api_contact` events are recorded as in a run. State and step events are ignored, and the check record says so. |
| Limits | The automation's image, timeout and `runtime.rate_limits`. The record keeps up to 8,192 characters of stdout and the last 4,096 characters of stderr, both redacted. Diagnostic messages and stored warnings keep their first 4,096 characters. |
| Secret and connection usage | The record keeps the name and version of each secret and the name and token version of each connection the latest check received, never a value, as a run execution records its own. |

The last structured `api_contact` status of `401` or `403` makes a failing check report `credentials`, including a bare exit `1`. This takes precedence over drift. A check that reports drift after its latest successful API call stays `drift`.

When no structured `api_contact` event appears, numeric credential statuses in stderr must follow a status marker, as in `HTTP 401`, `HTTPError: 403`, `HTTP/1.1 401`, `status code: 403`, or `response: 401`. The marker starts the line or follows a space or tab. A code inside a request URL, such as `HTTP 200 GET /orders/401`, does not identify a credential failure. Explicit `401 Unauthorized` and `403 Forbidden` messages also count as credential failures. A later successful SDK contact supersedes earlier authentication diagnostics, so a recovered check can still report drift.

`swizzle inspect <name>` shows the last check status, its check time, and any warning. `swizzle run --check <dir>` runs the check locally ([`checkOutcome`](../../packages/runtime/src/check-contract.ts)). Credential failures report `API_CHECK_CREDENTIALS`. Other runtime failures keep their runtime code, recovery hint, and retryability. For example, `MISSING_REQUIRED_SECRETS` tells you to export the missing secrets in your shell. A successful process whose output lacks `"ok": true` reports `API_CHECK_ERROR`.

Drift and credential failures show under Overview > Needs you at once. An undecided check shows after 3 consecutive failures. A deploy resets the count and runs the check again.

TypeScript `contractChanged` and Python `contract_changed` always write a `contract_changed` event to stderr and exit with code `1`. Checks and runs read the change from that event. Stdout carries only the check's `ok` and `checked` report.

Overview > Needs you lists API check failures, retirement notices and untested passive APIs as warnings separate from failed runs. The Hand to agent text for a failed check includes its latest output and the last green output. It reports when the failure streak began separately from how the latest check ended. A later credentials failure therefore does not make an earlier drift look like a credentials failure.

## Suspend sentinel

To wait, print exactly one sentinel on stdout and exit with code `0`:

```json
{ "$swizzle": { "suspend": { "reason": "sleep", "stepKey": "wait-1", "until": "2030-01-01T00:00:00.000Z" } } }
```

| `reason` | Fields | Resumes when |
|---|---|---|
| `sleep` | `stepKey`, `until` (ISO timestamp) | `until` has passed. |
| `child` | `stepKey`, `automation`, `payload` | The child run reaches `succeeded` or `dead-lettered`. |
| `event` | `stepKey`, `until` (ISO or `null`), `approval` (boolean), `details` (JSON, at most 8 KB), `assignee` (approvals only: `{ "user": "<email>" }` or `{ "team": "<name>" }` of 1 to 320 characters, or `null`) | `POST /runs/:runId/events/:stepKey`, `swizzle runs resolve-event`, `POST /events/:token`, an approval decision, or `until` passes. |
| `claim` | `stepKey` | At once, when the API has claimed the state key `stepKey` for the run ([claims](#claims)). |

`stepKey` is 1 to 255 characters. Child invocation nests at most 8 levels deep. An invalid sentinel fails the attempt. An `assignee` that names no person's email or team fails the run with `APPROVAL_ASSIGNEE_NOT_FOUND`.

## Resume values

On resume, the entrypoint runs again from the top. `SWIZZLE_STEPS_FILE` then holds the resume value under `stepKey`:

| Wait | Value |
|---|---|
| Sleep | `{ "sleptUntil": "<ISO>" }` |
| Child | `{ "automation", "runId", "status", "result", "errorCode" }`. `status` is `succeeded` or `dead-lettered`. |
| Claim | `{ "claimed": <boolean> }` |
| Event | `{ "timedOut": false, "value": <JSON> }`, or `{ "timedOut": true, "value": null }` |
| Approval | `{ "approved": <boolean>, "assignee": <assignee or null>, "decidedBy": <decider>, "comment": <string or null>, "decidedAt": "<ISO>", "timedOut": false }`. An assignee is `{ "kind": "user", "userId", "label" }` or `{ "kind": "team", "teamId", "label" }`. A decider is `{ "kind": "person", "userId", "label" }` or `{ "kind": "link" }`. On timeout: `approved` is `false`, `decidedBy` is `null` and `timedOut` is `true`. |

## Claims

A claim decides which run acts on a key, such as an order id, when several runs may hold the same one. The API checks and writes the key in PostgreSQL under the state namespace lock ([`claimAutomationStateKey`](../../packages/db/src/control-plane-state.ts)):

1. The process prints `{"$swizzle": {"suspend": {"reason": "claim", "stepKey": "claim:A-1001"}}}` and exits with code `0`.
2. When the automation's state has no value under `stepKey`, the API stores `{ "runId": "<this run>" }` there. The run holds the claim when that value names it.
3. The API stores `{ "claimed": true }` or `{ "claimed": false }` as the result of step `stepKey` and queues the run again.

Concurrent claims of one key in one environment wait on the same lock, so exactly one run holds it. The holder's retries and resumes read the stored step result, so they keep the claim. The claim stays in state after the run ends. Delete the state key to let a later run claim it.

The SDK `claim(key)` uses the step key `claim:<key>`, and its step helpers refuse names that start with `claim:`, so no step can answer a claim. In a local `swizzle run` it returns true without suspending, because that run has no state file. A claim that the 5 MB state limit refuses fails the run with `AUTOMATION_STATE_LIMIT_EXCEEDED`. A claim sentinel for a step that already has a result fails it with `SUSPEND_PAYLOAD_INVALID`.

## Limits

| Limit | Value |
|---|---|
| State key, step key, `stepKey` | 1 to 255 characters |
| One state value, one step result | 64 KB |
| All state of an automation in one environment | 5 MB |
| All step results of one run | 5 MB |
| Steps of one run | 2000 |
| `details` of an event wait | 8 KB |
| Child nesting depth | 8 |
| stdout, stderr | 1 MiB each |

## SDK helpers

| Purpose | TypeScript | Python |
|---|---|---|
| Read the payload | `readPayload` | `read_payload` |
| Run a handler and write its result | `runAutomation` | `run_automation` |
| Write the result | `writeResult` | `write_result` |
| Run metadata | `getAutomationMetadata` | `get_automation_metadata` |
| State | `stateGet`, `stateSet`, `stateDelete` | `state_get`, `state_set`, `state_delete` |
| Claim a key once across runs | `claim` | `claim` |
| Durable step | `runStep` | `run_step` |
| Sleep | `sleep` (milliseconds), `sleepUntil` | `sleep` (seconds), `sleep_until` |
| Child invocation | `invokeAutomation` | `invoke_automation` |
| Event wait | `waitForEvent`, `getEventCallbackUrl` | `wait_for_event`, `get_event_callback_url` |
| Approval wait | `requestApproval`, `getApprovalUrl` | `request_approval`, `get_approval_url` |
| Connection token | `getConnectionToken`, `getConnectionTokenExpiry` | `get_connection_token`, `get_connection_token_expiry` |
| Webhook request | `getWebhookHeaders`, `getRawBody`, `verifyHmac` | `get_webhook_headers`, `get_raw_body`, `verify_hmac` |
| Rate limits | `recordRateLimitUsage`, `pace` | `record_rate_limit_usage`, `pace` |
| Structured log line | `logStep` | `log_step` |
| HTTP call that records `api_contact` | `apiFetch` | `api_request` |
| Report an API change and exit | `contractChanged` | `contract_changed` |
