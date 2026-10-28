# Webhook Security

A deployed webhook path is **public**: anyone who knows the URL can POST to it. Swizzle can reject bad JSON shapes and generic HMAC-SHA256 signatures before queueing, but external senders still do not use Swizzle bearer tokens. Apply these controls in order. (Trigger field syntax: [Config Reference — webhook](config-reference.md#webhook); SDK helper signatures: [SDK Usage](sdk.md).)

## 1. Unguessable path (always)

Treat the webhook URL as a secret. Put a long random token in `trigger.path` instead of a
guessable word:

```yaml
# weak: anyone can guess /hooks/orders
trigger: { type: webhook, path: /hooks/orders }

# strong — the path itself is the secret
trigger: { type: webhook, path: /hooks/orders-7f3a9c2b8e1d4a6f }
```

Generate one with `openssl rand -hex 12`. A webhook scaffold from `swizzle init` already has such a path and the platform signature of section 3; keep both unless the sender cannot sign. Anyone without the exact path gets an
opaque `404 WEBHOOK_NOT_AVAILABLE` — the ingress never confirms whether a path
exists, so it is not an enumeration oracle. This is the baseline and works today
with zero extra code. The public ingress is also rate-limited per client IP, so a
single source cannot brute-force paths.

## 2. Validate the payload (always)

Never trust the body. Declare the expected shape in `trigger.payload_schema`; reject anything unexpected before the platform creates a run. A valid path is not a valid *request*.

```yaml
trigger:
  type: webhook
  path: /hooks/orders-7f3a9c2b8e1d4a6f
  payload_schema:
    type: object
    required: [event, id]
    properties:
      event: { type: string }
      id: { type: string }
```

Bad payloads return `422 WEBHOOK_PAYLOAD_INVALID` (with the validation errors) before run creation. On a signed endpoint this is only reachable after the signature has already passed, so it never leaks the schema to unsigned callers.

## 3. Platform HMAC signature (when the sender can sign raw bodies)

For senders you control, prefer platform-enforced `trigger.signature` over checking a secret inside user code:

```yaml
trigger:
  type: webhook
  path: /hooks/orders-7f3a9c2b8e1d4a6f
  signature:
    secret: ORDERS_WEBHOOK_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
```

Set `ORDERS_WEBHOOK_SIGNING_SECRET` with `swizzle secret set`. Swizzle verifies `HMAC-SHA256(rawBody)` before payload validation and before creating a run or BullMQ job. A bad or missing signature returns the same opaque `404 WEBHOOK_NOT_AVAILABLE` as an unknown path (a caller without the secret cannot tell a signed endpoint exists) and writes a `webhook_rejected` trigger audit event recording the real `signature-mismatch` reason for operators.

A run started by hand, with `swizzle trigger`, Run now or a local `swizzle run`, skips this check: anyone with run access, such as an operator, may start one with any payload. Such a run has the trigger type `manual` and no webhook headers or raw body. Before code acts on the sender's word, it checks that the run is a delivery:

```ts
if (metadata.triggerType !== "webhook") throw new Error("only a signed delivery may mark an invoice paid");
```

## 4. Shared secret in the body (fallback only)

If the sender is yours (your own service, an internal cron caller, a workflow tool you run), include a secret
field in the JSON body and compare it against a declared platform secret with a
constant-time compare:

```ts
import { timingSafeEqual } from "node:crypto";
const expected = process.env.WEBHOOK_SECRET!;            // declared in config.yaml, set via `swizzle secret set`
const got = String(readPayload()?.secret ?? "");
if (got.length !== expected.length ||
    !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
  throw new Error("bad webhook secret");
}
```

## 5. User-code HMAC signature verification (provider-specific)

Use user-code verification when the provider signs something other than the raw body, or encodes signatures in a provider-specific format. Swizzle forwards a constrained webhook request context to webhook-triggered runs:

- `payload` on stdin stays the parsed JSON body, unchanged for existing automations
- `SWIZZLE_WEBHOOK_HEADERS` contains the request headers as lower-case JSON keys
- `SWIZZLE_WEBHOOK_RAW_BODY_PATH` points to a temporary file with the exact raw request bytes
- `SWIZZLE_WEBHOOK_RAW_BODY_SHA256` contains the SHA-256 of those raw bytes for diagnostics

Every request header is forwarded — `content-type`, `stripe-signature`,
`x-hub-signature-256`, `close-sig-hash`, whatever your provider sends. There is no
provider list to wait for. The only exceptions are the three headers Swizzle
authenticates itself with: `authorization`, `proxy-authorization`, and `cookie` are
never forwarded and are rejected in `trigger.signature.header`.

Treat forwarded headers as caller-controlled input: they are as untrusted as the body
until a signature check passes. Don't log the whole header object into run logs.

### GitHub example

GitHub signs the raw body and sends `X-Hub-Signature-256: sha256=<hex>`, so it can be enforced by `trigger.signature` with `header: x-hub-signature-256` and `prefix: sha256=`. The SDK example below is still useful when you want event-specific checks in user code.

```ts
import { runAutomation, getWebhookHeaders, verifyHmac } from "./swizzle-sdk.ts";

await runAutomation(async ({ payload }) => {
  const headers = getWebhookHeaders();
  const ok = await verifyHmac({
    secret: process.env.GITHUB_WEBHOOK_SECRET!,
    signature: headers["x-hub-signature-256"],
    prefix: "sha256=",
  });

  if (!ok) throw new Error("bad GitHub webhook signature");

  return { status: "ok", event: headers["x-github-event"] ?? null, payload };
});
```

### Stripe example

Stripe signs `timestamp.rawBody` and sends one or more `v1` signatures inside
`Stripe-Signature`.

```ts
import { getRawBody, getWebhookHeaders, runAutomation, verifyHmac } from "./swizzle-sdk.ts";

function parseStripeSignature(header: string | undefined) {
  const parts = Object.fromEntries((header ?? "").split(",").map((part) => part.split("=", 2)));
  return { timestamp: parts.t, signature: parts.v1 };
}

await runAutomation(async ({ payload }) => {
  const headers = getWebhookHeaders();
  const rawBody = await getRawBody();
  const { timestamp, signature } = parseStripeSignature(headers["stripe-signature"]);
  if (!timestamp || !signature) throw new Error("missing Stripe signature");

  const ok = await verifyHmac({
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    signature,
    payload: Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]),
  });

  if (!ok) throw new Error("bad Stripe webhook signature");

  return { status: "ok", payload };
});
```

For Python, use `get_webhook_headers()`, `get_raw_body()`, and `verify_hmac(...)` from
`swizzle_sdk.py` (camelCase aliases also exist).
