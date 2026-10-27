# SDK Usage

The runtime contract is tiny: read JSON from stdin, write one JSON object to stdout, log to stderr, exit 0. The SDKs wrap that so you don't have to reimplement it every time. Both are **vendored** into the automation folder by `swizzle init` — no package install, no dependency on an external registry.

## When to use which

| Language | SDK available | Recommended? |
|---|---|---|
| TypeScript | `swizzle-sdk.ts` | Yes — best agent experience, typed payloads |
| Python | `swizzle_sdk.py` | Yes — useful for structured step logs |
| Node.js (plain JS) | none | Raw contract is fine — fewer moving parts |
| Shell | none | Raw contract only |

If you're authoring by hand instead of scaffolding, copy the helper from the repo:

```bash
cp packages/sdk-ts/src/index.ts  my-automation/swizzle-sdk.ts
cp packages/sdk-py/swizzle_sdk.py  my-automation/swizzle_sdk.py
```

## TypeScript with SDK

```typescript
#!/usr/bin/env node
import { runAutomation } from "./swizzle-sdk.ts";

await runAutomation(async ({ payload, metadata, logStep }) => {
  logStep("processing", { keys: Object.keys(payload) });
  const apiKey = process.env.MY_API_KEY;
  const result = await doTheThing(payload, apiKey);
  return { status: "ok", data: result };
});
```

Node runs the entrypoint by stripping its types, as an ES module, so top-level `await` works unless a `package.json` sets `"type": "commonjs"`. Node does not check types, and it rejects `enum`, `namespace` and constructor parameter properties. Import local files with their `.ts` extension.

Typed payloads and typed results:

```typescript
type Input = { url: string };
type Output = { title: string; wordCount: number };

await runAutomation<Input, Output>(async ({ payload }) => {
  // payload is typed as Input; return value must match Output
  return { title: "...", wordCount: 42 };
});
```

**What the SDK gives you:**
- `payload` — parsed JSON from stdin
- `metadata` — `{ runId, automationName, automationVersion, versionId, automationId, attempt, executionNumber, triggerType, environment }`
- `logStep(message, details?)` — structured log line on stderr
- `getWebhookHeaders()` — the request headers for webhook-triggered runs (all of them except `authorization`, `proxy-authorization`, `cookie`)
- `getRawBody()` — exact raw webhook body bytes for signature verification
- `verifyHmac(...)` — timing-safe HMAC comparison helper
- Return value is auto-JSON-stringified to stdout

## Python with SDK

```python
#!/usr/bin/env python3
import os
from swizzle_sdk import AutomationContext, run_automation

def handle(context: AutomationContext) -> dict:
    context.log_step("processing", {"input_keys": list(context.payload.keys())})
    api_key = os.getenv("MY_API_KEY")
    result = do_the_thing(context.payload, api_key)
    return {"status": "ok", "data": result}

raise SystemExit(run_automation(handle))
```

`context` carries:
- `context.payload` — parsed JSON
- `context.metadata.run_id`, `.automation_name`, `.automation_version`, `.version_id`, `.automation_id`, `.attempt`, `.execution_number`, `.trigger_type`, `.environment`
- `context.log_step(message, details)` — stderr log

For webhook signature checks, import `get_webhook_headers()`, `get_raw_body()`, and
`verify_hmac(...)` from `swizzle_sdk.py`. CamelCase aliases also exist for parity with
the TypeScript helper.

## Node.js raw (no SDK)

```javascript
#!/usr/bin/env node
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const payload = JSON.parse(chunks.join(""));
  const result = { status: "ok", echo: payload };
  process.stdout.write(JSON.stringify(result) + "\n");
});
```

## Python raw (no SDK)

```python
#!/usr/bin/env python3
import json, sys

def main() -> int:
    payload = json.load(sys.stdin)
    result = {"status": "ok", "echo": payload}
    print(json.dumps(result))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

## Durable state in code

Use SDK state helpers instead of worker-local JSON ledgers.

**TypeScript:**

```typescript
import { stateGet, stateSet } from "./swizzle-sdk.ts";

const cursor = await stateGet<string | null>("cursor", null);
stateSet("cursor", "next-page-token");
```

**Python:**

```python
from swizzle_sdk import state_get, state_set

cursor = state_get("cursor")
state_set("cursor", "next-page-token")
```

A run reads state as it was when the run started. Two runs that start together read the same values, and a `stateSet` reaches the other run only on its next start. State cannot deduplicate concurrent runs; use `claim`.

State values must be plain JSON: strings, finite numbers, booleans, null, arrays and plain objects. A Date, Map, Set, class instance, `undefined` field, NaN or Infinity fails the call by name, so convert it first (`date.toISOString()`). Single values are capped at 64KB; total state per automation is capped at 5MB.

## Do a side effect once

`claim(key)` returns true for exactly one run per key and environment, also when two runs claim at the same time. The platform decides with one insert in PostgreSQL. The holder's retries and resumes get true again. Every other run gets false.

**TypeScript:**

```typescript
import { claim, readPayload, runStep } from "./swizzle-sdk.ts";

const order = await readPayload<{ id: string }>();
if (await claim(`order:${order.id}`)) {
  await runStep(`send:${order.id}`, () => sendConfirmation(order));
}
```

**Python:**

```python
from swizzle_sdk import claim, read_payload, run_step

order = read_payload()
if claim(f"order:{order['id']}"):
    run_step(f"send:{order['id']}", lambda: send_confirmation(order))
```

- The first `claim` call for a key suspends the run for a moment, then the entrypoint starts again from the top with the answer. Code before the claim runs again, so keep it free of side effects.
- `claim` keeps other runs out, not the holder's own retries: they get true again. Put the side effect in a step named for the item, so a retry after the send returns the stored result instead of sending again. In a loop, the same step keeps the restart after the next claim from repeating earlier items.
- A crash inside the step, after the send and before its result is stored, still sends twice. Pass the item's key to the receiving system as its idempotency key when it accepts one.
- The claim stays under the state key `claim:<key>` after the run ends. If the holder dead-lettered before its side effect, run `swizzle state delete <name> claim:<key>`, then replay.
- A local `swizzle run` holds no platform state, so `claim` returns true there.

## Durable execution primitives

Use durable primitives when retrying the whole process would otherwise repeat expensive work, duplicate side effects, or hold a worker slot idle. For choosing the right primitive per durability boundary, see [Best Practices — durable execution](best-practices.md#3a-durable-execution); for a full worked example (approval gate + child invoke), see [Recipes #13](recipes.md#13-webhook-with-human-approval-then-child-invoke).

| Need | TypeScript | Python |
|---|---|---|
| Memoized work | `await runStep(name, fn)` | `run_step(name, fn)` |
| A side effect once per key across runs | `await claim(key)` | `claim(key)` |
| Wait without a worker slot | `await sleepUntil(name, until)` / `await sleep(name, durationMs)` | `sleep_until(name, until)` / `sleep(name, duration_seconds)` |
| Run a child automation | `await invokeAutomation(name, automation, payload)` | `invoke_automation(name, automation, payload)` |
| Wait for a resolver payload | `await waitForEvent(name, { timeoutMs, until })` | `wait_for_event(name, *, timeout_ms=None, until=None)` |
| Human approve/reject gate | `await requestApproval(name, { assignee, details, timeoutMs, until })` | `request_approval(name, *, details=None, assignee=None, timeout_ms=None, until=None)` |
| Approval link | `getApprovalUrl(step)` | `get_approval_url(step)` |
| Event callback URL for a third-party system | `getEventCallbackUrl(step)` | `get_event_callback_url(step)` |

### Durable steps

`runStep` / `run_step` stores a successful JSON-serializable result for the current run. If the attempt later fails and the run retries, the entrypoint starts from the top, but the helper returns the stored result without calling `fn`. A second call with the same name in the same process also returns the cached result. TypeScript stores `undefined` as `null`.

Steps are transaction boundaries. Work inside a step re-runs when that step fails before returning, so side effects inside a step still need to be idempotent or split into their own named step. Step names are unique per run; in loops, include the index or stable item id. Each step result is capped at 64KB, total step results per run are capped at 5MB, and results must be plain JSON, as for state values: a result that JSON would change on replay fails the step.

```typescript
const invoice = await runStep("fetch-invoice-123", async () => {
  const response = await fetch("https://api.example.test/invoices/123");
  return await response.json();
});
```

```python
invoice = run_step("fetch-invoice-123", fetch_invoice)
```

### Sleep and child invocation

`sleepUntil` / `sleep_until` and `sleep` suspend the run instead of blocking. If the named sleep is already memoized, the helper returns immediately. Otherwise it writes Swizzle's suspend sentinel to stdout, exits code `0`, moves the run to `waiting`, and releases the worker slot. The scheduler re-enqueues due sleeps. On resume, the whole entrypoint runs again from the top and memoized step names skip.

TypeScript `sleep(name, durationMs)` takes milliseconds. Python `sleep(name, duration_seconds)` takes seconds.

`invokeAutomation` / `invoke_automation` works the same way: the first call suspends, the platform creates a child run in the same environment, waits for it to reach `succeeded` or `dead-lettered`, stores the child envelope as the parent's step result, and resumes the parent. The returned envelope is `{ automation, runId, status, result, errorCode }`. A child failure is data (`status: "dead-lettered"`), not an exception; branch on `status`. Child invoke depth is capped at 8.

```typescript
await sleepUntil("wait-for-rate-window", "2030-01-01T00:00:00.000Z");

const child = await invokeAutomation("normalize-customer", "customer-normalizer", {
  customerId: "cus_123",
});
if (child.status === "dead-lettered") {
  return { status: "child-failed", code: child.errorCode };
}
```

```python
sleep_until("wait-for-rate-window", "2030-01-01T00:00:00.000Z")

child = invoke_automation("normalize-customer", "customer-normalizer", {"customerId": "cus_123"})
if child["status"] == "dead-lettered":
    return {"status": "child-failed", "code": child["errorCode"]}
```

### Events and approvals

`waitForEvent` / `wait_for_event` pauses until an operator or external system posts a JSON value back to the run. A third-party system posts to the URL from `getEventCallbackUrl(step)` / `get_event_callback_url(step)` without a Swizzle credential; the request body (at most 64 KiB) becomes the value. The operator resolves it through `POST /runs/:runId/events/:stepKey` or:

```bash
swizzle runs resolve-event <runId> <stepKey> --payload '{"status":"approved"}'
swizzle runs resolve-event <runId> <stepKey> --payload-file event.json
```

The helper returns `{ timedOut: false, value }`. If `timeoutMs` / `timeout_ms` or `until` expires first, the scheduler stores `{ timedOut: true, value: null }` and resumes the run. No timeout means wait indefinitely.

`requestApproval` / `request_approval` is the approve/reject variant. Pass `assignee` to name who decides: `{ user: "<email>" }` for a Swizzle person or `{ team: "<name>" }` for any member of a Swizzle team. An assignee decides signed in to the dashboard, and an owner or admin can reassign the approval with a reason. Without an assignee, the approval link or anyone who may run the automation decides. An assignee that names no account fails the run with `APPROVAL_ASSIGNEE_NOT_FOUND`. It returns `{ approved, assignee, decidedBy, comment, decidedAt, timedOut }`; `decidedBy` is `{ kind: "person", userId, label }`, `{ kind: "link" }` for a decision through the approval page, and `null` after a timeout. A token never decides, so the CLI has no approve command.

The operator side — finding a waiting run's step key and resolving it — is in [Operations — waiting runs](operations.md#waiting-runs-and-durable-resumes).

Python event and approval helpers are keyword-only after `name`. The link helpers sign a URL for one step with `SWIZZLE_LINK_KEY`, which deployed worker runs receive with `SWIZZLE_LINK_URL`; local `swizzle run` has neither, so the helpers raise there. A link works only while the run waits at that step, at most until the wait's timeout or seven days after a wait without one began, and stops working after the decision. Send it inside `runStep` / `run_step`, so a resume does not send it again. Opening an approval link shows a page; only its Approve or Reject button decides.

## Rate limits in code

If `config.yaml` declares `runtime.rate_limits` ([Config Reference](config-reference.md#rate-limits)), use SDK `pace(name)` before in-run API calls that should be spaced out. The group names in code must match the keys in config. Vendor planning baselines: [Operations — third-party rate limits](operations.md#common-third-party-rate-limits).

**TypeScript:**

```typescript
import { pace, recordRateLimitUsage } from "./swizzle-sdk.ts";

await pace("api_calls");
await callExternalApi();
recordRateLimitUsage("api_calls");        // +1
recordRateLimitUsage("batch_ops", 5);     // +5
```

**Python:**

```python
from swizzle_sdk import pace, record_rate_limit_usage

pace("api_calls")
call_external_api()
record_rate_limit_usage("api_calls")          # +1
record_rate_limit_usage("batch_ops", count=5) # +5
```

`rate_limits` consumes one token at run dispatch. `pace(name)` is process-local spacing inside a single run; it is not a cross-run global limiter. `recordRateLimitUsage` / `record_rate_limit_usage` makes counts visible in run stats and logs.

## Keep stdout clean — the #1 mistake

The platform parses stdout as the run result. Anything else on stdout corrupts it and the run fails.

- Never `print(...)` in Python without `file=sys.stderr`
- Never `console.log(...)` in Node — use `process.stderr.write(...)` or `logStep(...)`
- Never let library logs leak to stdout (some libraries default there — check)

If a run succeeds but reports "no result" or "invalid JSON", this is almost always the cause.

## Environment variables available at runtime

Set automatically — you read them, the platform populates them:

| Name | Meaning |
|---|---|
| `SWIZZLE_RUN_ID` | Unique per-run identifier |
| `SWIZZLE_AUTOMATION_ID` | Stable automation ID |
| `SWIZZLE_AUTOMATION_NAME` | The `name` from config.yaml |
| `SWIZZLE_AUTOMATION_VERSION` | The `version` from config.yaml |
| `SWIZZLE_VERSION_ID` | Deployment-version DB ID |
| `SWIZZLE_ATTEMPT` | Retry attempt number (1-based); a resume from a wait starts again at 1 |
| `SWIZZLE_EXECUTION` | Which execution of the run this is (1-based), counting every resume and retry |
| `SWIZZLE_TRIGGER_TYPE` | `webhook` / `cron` / `chain` when the trigger fired; `manual` for `swizzle trigger`, Run now and a local `swizzle run`, which skip the signature check and carry no webhook headers; `check` in an API check |
| `SWIZZLE_ENV` | `local` / `production` / ... |
| `SWIZZLE_WEBHOOK_HEADERS` | JSON object with the request headers, minus `authorization` / `proxy-authorization` / `cookie`; webhook runs only |
| `SWIZZLE_WEBHOOK_RAW_BODY_PATH` | Path to exact raw webhook body bytes; webhook runs only |
| `SWIZZLE_WEBHOOK_RAW_BODY_SHA256` | SHA-256 of the raw webhook body; webhook runs only |
| `SWIZZLE_LINK_URL`, `SWIZZLE_LINK_KEY` | Public base and per-run signing key of approval and event links; deployed worker runs only. The SDK link helpers read them |

Plus anything declared under `secrets:` — those arrive as plain env vars (`process.env.API_KEY`, `os.getenv("API_KEY")`).

Nothing else leaks in. The worker sanitizes the child environment — infrastructure variables (DB URL, queue URL, encryption key) do **not** reach your code.
