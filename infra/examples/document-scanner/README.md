# document-scanner

Python example that turns raw document text into a structured scan.
It intentionally stays local-first, uses only the standard library, and shows the vendored Python helper path.

## What it demonstrates

- Python authoring workflow with the vendored `swizzle_sdk.py` helper
- durable steps whose names are the node ids in `flow.mermaid`: `parse`, `classify`, `extract`, `review` and `route`, so the dashboard lights each station during a run
- a human approval (`review`) only when no known topic matches the text
- transforming unstructured text into a stable JSON result with topics, amounts, dates, email addresses and the team it is routed to

## Local workflow

```bash
swizzle validate infra/examples/document-scanner
swizzle run infra/examples/document-scanner
swizzle run infra/examples/document-scanner --payload-file infra/examples/document-scanner/sample-payload.json
swizzle apply infra/examples/document-scanner
```

The default `swizzle run` command uses `sample-payload.json` automatically.
That payload names an invoice, so the run skips the review and routes the document to `finance`.
A payload whose text matches no topic stops at `review` until someone approves or rejects it; an approved document goes to the shared `inbox`.

## Secrets

None required.
