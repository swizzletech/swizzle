# hello-webhook

Minimal webhook automation example for Swizzle.

## What it demonstrates

- Python automation entrypoint
- webhook trigger configuration
- stdin payload ingestion
- JSON result output on stdout
- optional Mermaid diagram support

## Local workflow

```bash
swizzle validate infra/examples/hello-webhook
swizzle run infra/examples/hello-webhook
swizzle run infra/examples/hello-webhook --payload '{"hello":"world"}'
swizzle apply infra/examples/hello-webhook
```

`swizzle run infra/examples/hello-webhook` automatically uses `sample-payload.json`.

## Secrets

None.
