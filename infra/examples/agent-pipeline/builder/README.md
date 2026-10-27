# agent-pipeline-builder

Chain block that receives a normalized work order and emits a synthetic workspace artifact:

```json
{
  "repoUrl": "https://example.invalid/acme/service.git",
  "baseBranch": "main",
  "specRef": "docs/specs/healthcheck.md",
  "options": {},
  "branch": "agent/work-...",
  "sha": "sha256-of-the-synthetic-build",
  "summary": {}
}
```

## What it demonstrates

- a replaceable chain block; only `trigger.source` chooses its upstream producer
- `runStep("build-workspace", ...)` around the expensive build transformation
- preservation of the complete work-order envelope while advancing the workspace pointer
- the exact edit point for replacing the deterministic simulation with a real headless agent

See `PLAYBOOK.md` for the vendored build-agent playbook.

## Local workflow

```bash
swizzle validate infra/examples/agent-pipeline/builder
swizzle run infra/examples/agent-pipeline/builder
swizzle apply infra/examples/agent-pipeline/builder
```

## Secrets

None required for the runnable simulation. A real repository-backed version would typically declare a Git provider token.
