# agent-pipeline-triage

Join block for the full fan-out recipe. It fires only when both `agent-pipeline-reviewer` and `agent-pipeline-e2e-verifier` have succeeded for the same build-origin run, verifies that both results describe the same workspace, and returns that pointer with a final decision.

## What it demonstrates

- multi-source chain trigger with `sources`
- `on: all-succeeded` and `payload: results`
- final aggregation from independent fresh-stage results
- preservation of the durable work-order/workspace envelope after fan-in

## Local workflow

```bash
swizzle validate infra/examples/agent-pipeline/triage
swizzle run infra/examples/agent-pipeline/triage
swizzle apply infra/examples/agent-pipeline/triage
```

## Secrets

None required.
