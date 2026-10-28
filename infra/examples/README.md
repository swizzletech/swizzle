# Example Automations

These examples are product surfaces, not filler.
Each folder is a runnable automation that follows the same local runtime contract as user-created projects.

## Common local workflow

```bash
swizzle validate infra/examples/<example-name>
swizzle run infra/examples/<example-name>
swizzle apply infra/examples/<example-name>
```

When `sample-payload.json` is present, `swizzle run <dir>` automatically uses it.
You can still override that with `--payload` or `--payload-file`.

## Examples

| Example | Runtime | Trigger | Secrets | Helper style | What it demonstrates |
| --- | --- | --- | --- | --- | --- |
| `hello-webhook` | Python | webhook `/hooks/hello` | none | raw contract | Smallest believable happy-path webhook with Mermaid flow and sample payload |
| `document-scanner` | Python | webhook `/hooks/document-scan` | none | vendored Python helper | Durable steps that match its flowchart: parse, detect topics, extract fields, ask a person when no topic matches, and route to a team |
| `webhook-transformer` | Node.js | webhook `/hooks/transform-webhook` | none | raw contract | Normalizing inbound partner webhooks into a stable internal event shape |
| `typescript-webhook` | TypeScript | webhook `/hooks/typescript-webhook` | none | vendored TS helper | Typed webhook normalization on top of the existing stdin/stdout runtime contract |
| `rag-indexer` | Python | cron `0 * * * *` | none | raw contract | Dry-run-friendly chunking and indexing preparation for later retrieval pipelines |
| `agent-pipeline/intake` | TypeScript | webhook `/hooks/agent-pipeline` | none | vendored TS helper | Stable front door for decision-complete work orders from any planning tool |
| `agent-pipeline/builder` | TypeScript | chain from `agent-pipeline-intake` | none | vendored TS helper | Replaceable build block with a memoized durable workspace handoff |
| `agent-pipeline/reviewer` | TypeScript | chain from `agent-pipeline-builder` | none | vendored TS helper | Parallel review block that preserves the workspace pointer |
| `agent-pipeline/e2e-verifier` | TypeScript | chain from `agent-pipeline-builder` | none | vendored TS helper | Parallel e2e branch that checks the synthetic workspace artifact |
| `agent-pipeline/triage` | TypeScript | join from reviewer + e2e verifier | none | vendored TS helper | Multi-source chain join that produces the final decision |

## Notes per example

### `hello-webhook`
- Best first smoke test for the runtime.
- Keeps the minimal stdin -> stdout JSON contract visible with no helper layer.

### `document-scanner`
- Demonstrates the Python helper SDK path without introducing external dependencies.
- Good reference for durable steps: each `run_step` and `request_approval` name is a node id in `flow.mermaid`, so the dashboard's track and Play follow the run.

### `webhook-transformer`
- Demonstrates the low-friction Node.js authoring path.
- Good reference when an agent should stay close to raw JavaScript and avoid extra helper files.

### `typescript-webhook`
- Demonstrates the TypeScript helper SDK path.
- Good reference for typed agent-generated automations: Node runs `main.ts` directly, top-level `await` included.

### `rag-indexer`
- Demonstrates a more advanced automation shape without requiring a real vector database.
- Safe to run locally as a dry run.

### `agent-pipeline`
- Demonstrates five independently usable blocks with minimal, standard, full, validator-inserted, and external-review compose recipes.
- Shows the stage/handoff doctrine with fresh contexts, a stable work-order envelope, durable workspace pointers, fan-out, and a multi-source chain join.
- The builder stage is deterministic and credential-free, with `PLAYBOOK.md` marking the one-edit swap point for a real headless agent.
