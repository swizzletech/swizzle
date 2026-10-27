# agent-pipeline-intake

Webhook entry block for the composable agent-pipeline example. It accepts a decision-complete work order and forwards the normalized envelope unchanged:

```json
{
  "repoUrl": "https://example.invalid/acme/service.git",
  "baseBranch": "main",
  "specRef": "docs/specs/healthcheck.md",
  "options": {}
}
```

The spec can be written by a human, a planner, a validator, or another system. Intake does not make product decisions and does not prescribe the spec's prose format; it only validates the routing envelope.

## What it demonstrates

- a stable webhook front door for different upstream planning tools
- a small structured envelope around a free-form spec artifact
- an independently runnable stage with no network calls or secrets

## Local workflow

```bash
swizzle validate infra/examples/agent-pipeline/intake
swizzle run infra/examples/agent-pipeline/intake
swizzle apply infra/examples/agent-pipeline/intake
```

## Secrets

None required.
