# document-scanner

Python example that turns raw document text into a structured summary.
It intentionally stays local-first, uses only the standard library, and shows the vendored Python helper path.

## What it demonstrates

- Python authoring workflow with the vendored `swizzle_sdk.py` helper
- richer payload parsing than the hello-world example
- stderr step logging without polluting stdout JSON
- transforming unstructured text into a stable JSON result

## Local workflow

```bash
swizzle validate infra/examples/document-scanner
swizzle run infra/examples/document-scanner
swizzle run infra/examples/document-scanner --payload-file infra/examples/document-scanner/sample-payload.json
swizzle apply infra/examples/document-scanner
```

The default `swizzle run` command uses `sample-payload.json` automatically.

## Secrets

None required.
