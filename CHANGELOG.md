# Changelog

Each release lists changes for people who run Swizzle and write automations.
Versions follow Semantic Versioning. Tags use `vX.Y.Z`; pre-releases use `X.Y.Z-rc.N`.

## 1.0.0

The first public release of Swizzle, a self-hosted runtime for automations written as ordinary code.

### Added

- A Docker Compose stack with a dashboard, HTTP API, and CLI. The server builds from a checkout and needs no Node.js packages of its own.
- The `swizzle` CLI as the npm package `@swizzletech/cli`. `swizzle workspace init` sets up a folder for automations with the builder skill for coding agents.
- Python, JavaScript, and TypeScript automations with scaffolding, local runs, and validation.
- Manual, webhook, cron, and chain triggers, with queued execution, retries, dead letters, and run logs. `SWIZZLE_TRIGGER_TYPE` tells a manual run apart from a webhook delivery.
- The Overview, the automation page, and `swizzle inspect` say when no scheduler serves a cron trigger's environment, instead of showing a next run that never comes. The Overview names the environments a running scheduler serves.
- Versioned deployments, rollback, environment-specific configuration, and protected production access. `swizzle apply --dry-run` and `swizzle validate` run every deploy check without registering a deployment.
- Durable state, steps, child runs, approval links, and external event waits through the Python and TypeScript SDKs.
- `claim(key)` in both SDKs, so exactly one run acts on a webhook that a sender delivers twice, even when both deliveries run at once.
- API checks: a script beside an automation that tests the external API it uses on a schedule and after each deploy, with failures and drift under Overview > Needs you.
- A dashboard that shows each person the actions their role allows. **Hand to agent** turns a failed run into instructions for a coding agent.
- Projects, teams, service accounts, scoped API tokens, and remote workers with explicit project and environment grants.
- Encrypted secrets, OAuth connections, failure notifications, backups, and restore commands.
- Per-automation run timeout grants, S3-compatible artifact storage, and OpenTelemetry tracing.

### Changed

- No changes from an earlier public release. This is the initial release.

### Fixed

- No fixes relative to an earlier public release.

### Removed

- No removals from an earlier public release.

### Security

- Deployed automations run as unprivileged processes in restricted Docker containers with resource limits and explicit permissions.
- Secrets are encrypted at rest and write-only through the API. Logs and run results redact injected secret values and link capabilities.
- The dashboard requires authenticated sessions. The API accepts authenticated sessions or scoped, expiring tokens.
- Two-factor sign-in, persistent sign-in budgets, and audit records protect instance and project administration.
- The CLI refuses a malformed token with `PROFILE_TOKEN_MALFORMED` before it sends a request, and never prints the token's value.
