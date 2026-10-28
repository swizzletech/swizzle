# Recipes — Common Automation Patterns

Starter configs for the shapes you'll keep running into. Pair each with the entrypoint patterns in [SDK Usage](sdk.md). Use `apiFetch` or `api_request` for HTTP calls in recipes with passive API checks, so Swizzle records contact and retirement headers. Add retry, rate limits, and timeouts only when the use case needs them. See [Config Reference](config-reference.md) for config fields and advanced options. Every webhook recipe has an unguessable path and a platform signature, as `swizzle init` scaffolds them: replace the random suffix with your own (`openssl rand -hex 12`), set the signing secret with `swizzle secret set`, and add a payload schema ([Webhook Security](webhook-security.md)).

## 1. Basic webhook handler

```yaml
name: my-webhook
version: 1.0.0
trigger:
  type: webhook
  path: /hooks/my-webhook-f6589777ce73793580bea91b
  signature:
    secret: MY_WEBHOOK_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
```

## 2. Webhook that calls an external API

```yaml
name: order-processor
version: 1.0.0
description: Process incoming orders via payment API
trigger:
  type: webhook
  path: /hooks/order-processor-f089d43baa1b7e9291e7d4f3
  signature:
    secret: ORDER_PROCESSOR_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
runtime:
  timeout: 30s
  retry:
    max_attempts: 5
    backoff: exponential
  rate_limits:
    payment_api: "30/min"
secrets:
  - PAYMENT_API_KEY
  - NOTIFICATION_WEBHOOK_URL
api_check:
  mode: passive  # Payment and notification calls happen only when an order arrives.
```

## 3. Webhook transformer (partner event → internal format)

```yaml
name: stripe-normalizer
version: 1.0.0
description: Normalize Stripe webhooks into internal event format
entrypoint: main.ts
trigger:
  type: webhook
  path: /hooks/stripe-normalizer-7016a5e60676135bb41f819a
secrets:
  - STRIPE_WEBHOOK_SECRET
api_check:
  mode: off
  reason: This handler verifies incoming signatures and makes no outbound API calls.
```

Stripe signs `timestamp.rawBody`, not the raw body alone, so the platform signature cannot check it and this recipe has none. Keep the unguessable path and verify in user code with the SDK raw-body helpers; a worked example is in [Webhook Security — Stripe](webhook-security.md#stripe-example).

## 4. Scheduled data sync

```yaml
name: crm-sync
version: 1.0.0
description: Sync contacts between CRM and marketing tool every 6 hours
trigger:
  type: cron
  every: "6h"
runtime:
  timeout: 300s
secrets:
  - CRM_API_KEY
  - MARKETING_API_KEY
api_check:
  mode: passive  # Record CRM and marketing contact during each scheduled sync.
```

## 5. Email checker (IMAP) with auto-reply

```yaml
name: email-auto-reply
version: 1.0.0
description: Check inbox every 5 minutes, auto-reply to matching emails
entrypoint: main.py
trigger:
  type: cron
  every: "5m"
runtime:
  timeout: 120s
  requirements:
    python:
      requirements_file: requirements.txt
secrets:
  - IMAP_HOST
  - IMAP_USER
  - IMAP_PASSWORD
  - SMTP_HOST
  - SMTP_USER
  - SMTP_PASSWORD
api_check:
  mode: off
  reason: IMAP and SMTP use mail protocols rather than an HTTP API.
```

Note: IMAP connections are slow. `timeout: 120s` is realistic for mailbox-sized work. Mark messages processed with the IMAP seen flag or the Swizzle state primitive so they don't reprocess every 5 min. Before writing the loop, read the [IMAP fetch-then-mutate gotcha](integration-gotchas.md#imap-fetch-then-mutate-in-the-same-iteration-deadlocks-with-gmail) — interleaving fetch and store deadlocks with Gmail.

## 6. File watcher (remote inbox polling)

```yaml
name: remote-file-watcher
version: 1.0.0
description: Process new files from a remote inbox API every minute
trigger:
  type: cron
  every: "1m"
runtime:
  timeout: 300s
secrets:
  - FILES_API_URL
  - FILES_API_TOKEN
api_check:
  mode: passive  # The minute-by-minute inbox poll records API contact.
```

List files through `FILES_API_URL`, authenticated with `FILES_API_TOKEN`. The API must be reachable from the deployed run and expose file contents plus a stable ID and version or content hash. Claim each version with `claim(f"{file_id}:{version}")` and process only the versions it returns true for, so a run that starts while the previous one still works skips what that one holds. Each first claim restarts the entrypoint, so process each claimed version inside `run_step(f"process:{file_id}:{version}", …)`; the restart then returns the stored result instead of processing it again. Use `$SWIZZLE_RUN_TMP` for scratch files; keep the source files in the remote service. Make the downstream side effect idempotent with the same key so a retry after a crash inside the step cannot duplicate it.

## 7. AI-powered transformation (Claude / GPT)

```yaml
name: document-summarizer
version: 1.0.0
description: Summarize documents received via webhook
entrypoint: main.py
trigger:
  type: webhook
  path: /hooks/document-summarizer-00741c77ada0dfe27a085f90
  signature:
    secret: DOCUMENT_SUMMARIZER_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
runtime:
  timeout: 180s            # AI calls can be slow
  retry:
    max_attempts: 3
    backoff: exponential
  rate_limits:
    ai: "100/min"
  requirements:
    python:
      requirements_file: requirements.txt
secrets:
  - ANTHROPIC_API_KEY      # or OPENAI_API_KEY
api_check:
  mode: passive  # Synthetic inference would add cost without a document to process.
```

AI outputs are non-deterministic — validate and sanitize before using them as filenames, DB keys, or downstream input. Provider-specific traps (Gemini JSON mode, Anthropic prompt-caching minimums): [Integration Gotchas](integration-gotchas.md). For headless CLI calls (`claude -p`, `codex exec`) instead of direct API calls, read the [headless CLI gotcha](integration-gotchas.md#headless-claude--codex-cli-in-the-worker-blocks-refuses-to-run-or-hides-its-errors) first.

## 8. PDF to image (poppler)

```yaml
name: pdf-to-image
version: 1.0.0
description: Render PDF pages to PNG images
entrypoint: main.py
trigger:
  type: webhook
  path: /hooks/pdf-to-image-bdd015da27db713f71f54403
  signature:
    secret: PDF_TO_IMAGE_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
runtime:
  timeout: 120s
  requirements:
    binaries:
      - name: pdftoppm     # in the runner image; validate checks it
```

The runner image ships poppler-utils and the DejaVu fonts, and no other font ([Execution environment](../SKILL.md#execution-environment-whats-actually-available)). A PDF that embeds its fonts renders as designed; one that only names a font, such as a proprietary one, renders with DejaVu unless the instance operator adds that font to the runner image.

## 9. Polling external API with cursor

```yaml
name: github-issue-sync
version: 1.0.0
description: Pull new GitHub issues every 10 minutes since last cursor
trigger:
  type: cron
  every: "10m"
runtime:
  timeout: 60s
  rate_limits:
    github: "5000/hour"    # GitHub API rate limit
secrets:
  - GITHUB_TOKEN
api_check:
  mode: passive  # Record API contact during actual work.
```

Store the last-seen issue ID or timestamp with the state primitive (`state_get("cursor")` / `state_set("cursor", …)`) so the next run picks up where the last one left off — never in a worker-local file. Persist the cursor only after the downstream side effect succeeds.

## 10. Chained pipeline (process then notify)

Two automations form a pipeline. The first processes data, the second fires on success and sends a notification.

```yaml
# order-processor/config.yaml
name: order-processor
version: 1.0.0
trigger:
  type: webhook
  path: /hooks/order-processor-db3195e5ab6c9445f703d391
  signature:
    secret: ORDER_PROCESSOR_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
secrets:
  - PAYMENT_API_KEY
api_check:
  mode: passive  # Payment and notification calls happen only when an order arrives.
```

```yaml
# order-notifier/config.yaml
name: order-notifier
version: 1.0.0
trigger:
  type: chain
  source: order-processor
  on: succeeded            # only fires if order-processor's run succeeded
  payload: result          # receives order-processor's stdout JSON as input
secrets:
  - SLACK_WEBHOOK_URL
api_check:
  mode: passive  # Record API contact during actual work.
```

To also notify on failure, switch to `on: finished` and check the payload shape in code.

## 11. Webhook with idempotency (dedup by key)

```yaml
name: idempotent-webhook
version: 1.0.0
description: Webhook that skips duplicate deliveries by key
trigger:
  type: webhook
  path: /hooks/idempotent-webhook-97620c5e2fe86ae45e5ffd63
  signature:
    secret: IDEMPOTENT_WEBHOOK_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
runtime:
  timeout: 30s
```

Read an idempotency key from the webhook payload and call `claim(key)` before the side effect. Skip it when `claim` returns false, and run it inside `run_step` when `claim` returns true, so the holder's own retry does not repeat it. A sender that retries can deliver twice within milliseconds, and `claim` lets exactly one of the concurrent runs through. See the [SDK reference](sdk.md#do-a-side-effect-once).

## 12. Cron with cost guard

```yaml
name: expensive-daily-job
version: 1.0.0
description: Run a costly AI batch once a day, with a hard rate cap
trigger:
  type: cron
  schedule: "0 3 * * *"    # 03:00 UTC daily
runtime:
  timeout: 900s            # 15 min
  retry:
    max_attempts: 1        # don't retry — one run per day is the contract
  rate_limits:
    ai: "500/min"          # safety cap
secrets:
  - ANTHROPIC_API_KEY
api_check:
  mode: passive  # Check contact during the real batch, without extra inference cost.
```

`max_attempts: 1` is deliberate — for expensive one-shot jobs, retries can multiply cost if the failure is deterministic (e.g. quota exceeded). Fail loud and let the user decide.

## 13. Webhook with human approval then child invoke

```yaml
name: invoice-approval-router
version: 1.0.0
description: Fetch invoice details, request approval, then invoke a child automation
entrypoint: main.ts
trigger:
  type: webhook
  path: /hooks/invoice-approval-router-0b9e83847ece75a3c4fe9c40
  signature:
    secret: INVOICE_APPROVAL_ROUTER_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
runtime:
  timeout: 60s
secrets:
  - APPROVAL_WEBHOOK_URL
api_check:
  mode: passive  # The notification webhook has no read-only check endpoint.
```

```typescript
#!/usr/bin/env node
import {
  getApprovalUrl,
  invokeAutomation,
  requestApproval,
  runAutomation,
  runStep,
} from "./swizzle-sdk.ts";

type Payload = { invoiceId: string };

await runAutomation<Payload>(async ({ payload, logStep }) => {
  const invoice = await runStep(`fetch-invoice-${payload.invoiceId}`, async () => {
    const response = await fetch(`https://api.example.test/invoices/${payload.invoiceId}`);
    if (!response.ok) throw new Error(`Invoice fetch failed: ${response.status}`);
    return await response.json();
  });

  // Delivery is a step: on resume the entrypoint re-runs from the top, and an
  // unwrapped send would notify the approver again on every resume.
  await runStep("notify-approver", async () => {
    const approvalUrl = getApprovalUrl("approve-invoice");
    const response = await fetch(process.env.APPROVAL_WEBHOOK_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoiceId: payload.invoiceId, invoice, approvalUrl }),
    });
    return { delivered: response.ok };
  });

  const decision = await requestApproval("approve-invoice", {
    // The approver sees only these fields: the title as the heading, then one labelled
    // line each, on the approval page and in the dashboard alike.
    details: {
      title: `Pay ${invoice.total} ${invoice.currency} to ${invoice.supplier} for invoice ${payload.invoiceId}?`,
      due: invoice.dueDate,
    },
    timeoutMs: 24 * 60 * 60 * 1000,
  });

  if (!decision.approved) {
    return {
      status: decision.timedOut ? "approval-timeout" : "rejected",
      comment: decision.comment,
    };
  }

  const child = await invokeAutomation("send-approved-invoice", "invoice-sender", {
    invoice,
    approvedAt: decision.decidedAt,
  });

  if (child.status === "dead-lettered") {
    logStep("child failed", { runId: child.runId, errorCode: child.errorCode });
    return { status: "child-failed", child };
  }

  return { status: "ok", child };
});
```

Approval URLs are only available in deployed worker runs, when the API has `SWIZZLE_LINK_URL` and a valid encryption key. Deliver the URL yourself; Swizzle creates the capability URL, not the notification channel. Primitive semantics and caps: [SDK Usage — durable execution](sdk.md#durable-execution-primitives). Deciding the approval in the dashboard, assigning it to a person or team, and resolving an event with `runs resolve-event`: [Operations — waiting runs](operations.md#waiting-runs-and-durable-resumes).

## 14. Composable agent delivery pipeline (intake → build → verify → triage)

A flat multi-stage delivery pipeline: intake accepts a decision-complete work-order reference, a build stage turns it into code, two independent checks run off the build, and a join stage triages their combined results. Each stage is its own run — its own fresh context. Planner/validator tools can produce the work order upstream; local or external PR review can replace the internal checks. The design layer (why stages, what crosses a boundary, sandbox/clone rules) is [Agent Workflows](agent-workflows.md); this is the wiring.

The chain, as triggers only (each is its own automation folder):

```yaml
# intake/config.yaml — validates and forwards { repoUrl, baseBranch, specRef, options }
trigger:
  type: webhook
  path: /hooks/intake-b7e1bcf5449e7a496732a9bf
  signature:
    secret: INTAKE_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
```

```yaml
# builder/config.yaml — preserves the work order and appends { branch, sha }
trigger:
  type: chain
  source: intake
  on: succeeded
  payload: result
runtime:
  timeout: 900s            # a full agent session is slow; bump well up (ceiling 1h)
  retry:
    max_attempts: 1        # don't silently re-run an agent build; fail loud
secrets:
  - GIT_TOKEN
api_check:
  mode: passive  # Record API contact during actual work.
```

```yaml
# reviewer/config.yaml — one of two independent checks off the build
trigger:
  type: chain
  source: builder
  on: succeeded
  payload: result          # receives the work order plus { branch, sha }
secrets:
  - GIT_TOKEN
api_check:
  mode: passive  # Record API contact during actual work.
```

```yaml
# e2e-verifier/config.yaml — the other check; same source, runs in parallel with reviewer
trigger:
  type: chain
  source: builder
  on: succeeded
  payload: result
secrets:
  - GIT_TOKEN
api_check:
  mode: passive  # Record API contact during actual work.
```

```yaml
# triage/config.yaml — join: fires once when BOTH checks succeed for the same build
trigger:
  type: chain
  sources: [reviewer, e2e-verifier]   # 2+ names; mutually exclusive with `source`
  on: all-succeeded                    # v1: only value allowed with `sources`
  payload: results                     # payload: { origin, results: { reviewer, e2e-verifier } }
```

`reviewer` and `e2e-verifier` both chain off `builder`, so the join correlates their completions back to the same build run. If either dead-letters, `triage` doesn't fire (v1) — pair the checks with dead-letter notification rules. Full contract: [Config Reference — join](config-reference.md#join-fan-in-on-multiple-sources).

The build stage, sketched — clone → agent session → push → handoff:

```typescript
#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAutomation, runStep } from "./swizzle-sdk.ts";

const runTmp = process.env.SWIZZLE_RUN_TMP;
if (!runTmp) throw new Error("SWIZZLE_RUN_TMP is not set");
const repoDir = `${runTmp}/repo`;
const sh = async (cmd: string, cwd = repoDir) =>
  (await promisify(execFile)("bash", ["-lc", cmd], { cwd })).stdout;

type WorkOrder = {
  repoUrl: string;
  baseBranch: string;
  specRef: string;
  options: Record<string, unknown>;
};

await runAutomation<WorkOrder>(async ({ payload, metadata, logStep }) => {
  const { repoUrl, baseBranch, specRef } = payload;
  const branch = `agent/${metadata.runId ?? "local-build"}`;
  const authUrl = repoUrl.replace("https://", `https://x-access-token:${process.env.GIT_TOKEN}@`);

  // Clone into a subdirectory of the scratch dir. The cwd of a deployed run, /automation,
  // is read-only.
  await sh(`git clone --depth 50 ${authUrl} repo`, runTmp);
  await sh(`git fetch --depth 50 origin ${baseBranch}:refs/remotes/origin/${baseBranch}`);
  await sh(`git checkout -b ${branch} origin/${baseBranch}`);

  // Headless agent session, cwd = the checkout. PLAYBOOK.md ships in the bundle
  // next to this entrypoint, so reference it by absolute path.
  // Traps (non-interactive flags, IS_SANDBOX=1) live in Integration Gotchas; read them first.
  await sh(`claude --dangerously-skip-permissions -p "$(cat ${import.meta.dirname}/PLAYBOOK.md)

Build the change described in ${specRef}. When done, stop."`);

  // Push BEFORE returning — the remote is the durable store, the checkout is disposable.
  const workspace = await runStep("push-build-output", async () => {
    await sh(`git add -A && git commit -m "build: ${specRef}"`);
    await sh(`git push ${authUrl} HEAD:${branch}`);
    const sha = (await sh(`git rev-parse HEAD`)).trim();
    return { ...payload, branch, sha };
  });

  logStep("built", workspace);
  return workspace; // handoff artifact — reviewer + e2e-verifier chain off this, never a path
});
```

The handoff preserves `{ repoUrl, baseBranch, specRef, options }` and appends `{ branch, sha }`; it is never a worker-local path. Review and e2e stages re-clone the SHA into their own scratch and return the pointer with their findings. To insert a validator, chain it from intake and change only the builder's `source`; to use external review, stop after builder. The full set of exact compose variants is the runnable [agent-pipeline](https://github.com/swizzletech/swizzle/tree/main/infra/examples/agent-pipeline) example in the Swizzle repository. `gh` is not in the runner image; open PRs via the provider REST API with `GIT_TOKEN` (see [Agent Workflows — sandbox doctrine](agent-workflows.md#sandbox-doctrine--repo-work-inside-stages)).

## Testing chain automations locally

Chains can't auto-trigger without a platform deployment. Workflow:

```bash
# 1. Run upstream, capture stdout (the chain payload)
swizzle run order-processor --payload-file order-processor/sample-payload.json
#    → produces JSON on stdout

# 2. Create order-notifier/sample-payload.json matching that shape
#    (just the `result` JSON if payload: result)
#    (the original input if payload: payload)
#    ({ source: { automationName, payload, result, runId, status } } if payload: full)

# 3. Run the downstream with that payload
swizzle run order-notifier --payload-file order-notifier/sample-payload.json
```
