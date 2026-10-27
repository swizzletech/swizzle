# agent-pipeline-e2e-verifier

Independent verification block. It receives a workspace handoff, appends `{ verdict, checks }`, and preserves the complete work order and workspace pointer.

## What it demonstrates

- a parallel branch from a shared build origin
- checks that do not rely on reviewer or builder context
- a replaceable verifier contract suitable for repository-specific E2E logic
- a join-ready result that remains usable by later stages

## Local workflow

```bash
swizzle validate infra/examples/agent-pipeline/e2e-verifier
swizzle run infra/examples/agent-pipeline/e2e-verifier
swizzle apply infra/examples/agent-pipeline/e2e-verifier
```

## Secrets

None required.
