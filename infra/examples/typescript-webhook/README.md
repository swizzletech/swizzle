# typescript-webhook

TypeScript example that normalizes third-party webhook input into one internal event envelope using the vendored helper SDK.

## What it demonstrates

- TypeScript authoring workflow with the vendored `swizzle-sdk.ts` helper
- typed payload handling on top of the existing stdin/stdout runtime contract
- stderr step logging plus JSON-only stdout results

## Local workflow

```bash
swizzle validate infra/examples/typescript-webhook
swizzle run infra/examples/typescript-webhook
swizzle run infra/examples/typescript-webhook --payload-file infra/examples/typescript-webhook/sample-payload.json
swizzle apply infra/examples/typescript-webhook
```

`swizzle run` automatically uses `sample-payload.json` when present.

## Secrets

None required.
