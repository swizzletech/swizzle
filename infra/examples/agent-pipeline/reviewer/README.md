# agent-pipeline-reviewer

Independent review block. It receives a workspace handoff, appends `{ verdict, findings }`, and preserves `repoUrl`, `baseBranch`, `specRef`, `options`, `branch`, and `sha` for whatever consumes the result next.

## What it demonstrates

- a cold review context that does not inherit the builder session
- an input contract that is indifferent to which builder produced the workspace
- a join-ready result that still carries the durable workspace pointer

To use an external PR bot or a local human review instead, omit this block and point the next internal block at the stage whose artifact that external process consumes.

## Local workflow

```bash
swizzle validate infra/examples/agent-pipeline/reviewer
swizzle run infra/examples/agent-pipeline/reviewer
swizzle apply infra/examples/agent-pipeline/reviewer
```

## Secrets

None required.
