# webhook-transformer

Node.js example that normalizes third-party webhook input into one internal event envelope.

## What it demonstrates

- Node.js authoring workflow without extra SDKs
- mapping inconsistent external payloads into a predictable structure
- keeping stdout machine-readable and logs separate if needed later

## Local workflow

```bash
swizzle validate infra/examples/webhook-transformer
swizzle run infra/examples/webhook-transformer
swizzle run infra/examples/webhook-transformer --payload-file infra/examples/webhook-transformer/sample-payload.json
swizzle apply infra/examples/webhook-transformer
```

## Secrets

None required.
