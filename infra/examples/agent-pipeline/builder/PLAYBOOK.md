# Build Agent Playbook

This file is versioned with the automation bundle so a real build agent can run from a fresh stage context.

## Mission

Implement the decision-complete spec referenced by the work-order envelope and return a durable workspace handoff for downstream checks.

## Inputs

- `repoUrl`: repository to clone
- `baseBranch`: branch the change starts from and will eventually target
- `specRef`: durable reference to the free-form spec artifact
- `options`: workflow-specific, non-secret build options

The spec need not follow a fixed section schema. Extract the checkable requirements from whatever prose format it uses.

## Procedure For A Real Agent Stage

1. Clone `repoUrl` into a subdirectory of `SWIZZLE_RUN_TMP`.
2. Create or reset a dedicated work branch from `baseBranch`.
3. Read `specRef`, derive the checkable requirements, and implement the smallest defensible solution.
4. Run the smallest relevant project checks.
5. Commit early and often; never push with agent-held credentials.
6. Let the deterministic entrypoint push checkpoints and the final branch.
7. Return the original envelope plus `{ branch, sha, summary }`.

## Guardrails

- Do not make a known product decision that the work order left unresolved; escalate it explicitly.
- Engineering choices and newly discovered unknowns are normal. Choose conservatively and record them in `summary` for the pull request.
- Do not return a local checkout path. The next stage may run on a different worker.
- Do not return a chat transcript as the contract. Keep useful notes in `summary`.
- Push before any durable wait or stage boundary.

## Prompt Skeleton

```text
You are the build stage in a Swizzle agent pipeline.

Read the free-form spec at <specRef>. Work in the repository at <repoUrl>, based
on <baseBranch>. Derive its checkable requirements, implement the smallest
defensible solution, run focused checks, and leave clear summary notes for the
pull request. Commit early and often, but never push.

Never hand off a worker-local path, credentials, or session state.
```
