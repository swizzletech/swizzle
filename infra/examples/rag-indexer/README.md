# rag-indexer

Advanced-but-runnable Python example for preparing retrieval chunks during a scheduled indexing pass.
It stays dry-run friendly locally: no vector database, no paid API, no extra dependency required.

## What it demonstrates

- cron-triggered automation shape
- larger payloads with multiple documents
- deterministic chunk planning for later embedding/indexing work

## Local workflow

```bash
swizzle validate infra/examples/rag-indexer
swizzle run infra/examples/rag-indexer
swizzle run infra/examples/rag-indexer --payload-file infra/examples/rag-indexer/sample-payload.json
swizzle apply infra/examples/rag-indexer
```

Even though the configured trigger is cron, local `swizzle run` still works with a JSON payload for development.

## Secrets

None required for the dry-run path.
