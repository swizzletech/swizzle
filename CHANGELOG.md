# Changelog

Each release lists changes for people who run Swizzle and write automations.
Versions follow Semantic Versioning. Tags use `vX.Y.Z`; pre-releases use `X.Y.Z-rc.N`.

## 1.0.5

### Added

- Releases publish signed images for `linux/amd64` and `linux/arm64` to `ghcr.io/swizzletech`. On a release checkout, `just stack`, `just backup`, `just restore` and `just upgrade` pull these images instead of compiling the stack on the server. Releases 1.0.4 and earlier have no images and still build from source, one service at a time. [Verify release images](docs/how-to/upgrade.md#verify-release-images) shows how to check a signature.

### Changed

- `just upgrade` prepares the target release's images while the installed services keep running. Before it stops anything, it checks `just`, `mise`, the pinned Node toolchain, Docker Compose and free space in Docker's data directory. A missing tool, too little space, a failed pull or an incomplete image publication leaves the installed services running. The first upgrade from 1.0.4 or earlier runs the target release's upgrade script, as [Upgrade a server](docs/how-to/upgrade.md#if-your-installed-release-predates-image-preparation) describes.
- Cron no longer catches up occurrences missed while the scheduler was stopped. The latest due occurrence still runs if it is at most 30 seconds late. A `cron_missed` audit event records how many occurrences were skipped, and the automation's Change history shows it.
- Deleting an automation that other automations chain from names the dependent chains in every environment before asking for `--yes`. The dependents keep an invalid trigger, and `swizzle inspect` and the dashboard mark them not ready and name the deleted source. If the API cannot preview the deletion, the CLI refuses to delete.
- A version rule in `requirements.binaries` accepts a bare numeric version, which matches a dotted prefix, or a comparison with `>=`, `<=`, `>`, `<` or `=`. `swizzle validate` refuses other forms, such as `^25`. Deployments saved by an earlier 1.x release keep their rules, such as `v25.03.0` or `latest`, and match workers as they did before.
- `swizzle inspect` shows the active deployment's execution mode, `host` or `sandbox (container)`.

### Fixed

- `swizzle logs --run <id> --full` prints stderr with real line breaks when stdout is piped, as it already did in a terminal.
- An API check whose last API call returned 401 or 403 reports `credentials`, even if the check exits with a bare `1`. A check that cannot start locally keeps its own error code and recovery hint, such as exporting a missing secret.
- In the run panel, **Run again** no longer appears where **Open automation** or **Cancel run** was a moment earlier, so a click aimed at one cannot start a second run. Approval buttons wrap together under the comment field on a narrow screen, and stay inside the run panel when even one row is too wide.
- Dashboard readiness labels name the broken trigger.
- Resuming a paused chain cannot reactivate it while its source is being deleted.
- The install and upgrade guides show how to run recipes in a plain SSH shell with mise in `~/.local/bin`, and require the Docker Buildx plugin.

## 1.0.4

### Changed

- The README leads with how Swizzle is meant to be used: a coding agent writes an automation once as ordinary code, and Swizzle runs it the same way every time. It also says why Swizzle exists.

## 1.0.3

### Added

- `just upgrade [release tag]` moves an installed server to a newer release. It refuses a checkout with uncommitted changes, takes a backup, keeps `.env`, checks out the release, restarts the stack, waits for `/health` to report the new version, and prints the command that restores the previous release. [Upgrade a server](docs/how-to/upgrade.md) covers the first upgrade from a release without the recipe, recovery, and CLI updates.
- A private instance can receive webhooks from the internet without exposing its dashboard or API. The public listener that a tunnel forwards to serves `/hooks/*` alongside approval links, event links and OAuth callbacks, and answers nothing else. The install guide has steps for Tailscale Funnel and for a public links hostname.
- `swizzle runs replay <runId>` and **Run again** in the dashboard start a new manual run with an earlier run's original payload on the active deployment, including a dead-lettered run. `swizzle runs inspect <runId>` shows the payload.
- `swizzle diagnose`, the dashboard's failing-run card and **Hand to agent** name the exception and the file and line it was raised at, for Python and Node runs.
- `swizzle inspect` shows the last API check outcome and its time.

### Changed

- One scheduler serves every environment of an instance. A cron deployed to production and one deployed to staging both run on schedule, and a cron deployed to both runs in both. Fresh installs default to production. A server upgraded from 1.0.x keeps the environment its `.env` names.
- `swizzle init` writes webhook trigger paths under `/hooks/`. Webhooks deployed with other paths keep answering at the URL they had before, on the API's origin.
- `requirements.binaries` is checked against the runner image that deployed runs use. A binary the runner image lacks fails `swizzle validate` with a message that the instance operator adds it to the runner image, and a version rule refuses a binary whose version is unknown.
- The stack sizes its CPU limits to the Docker host, so a fresh stack starts on a 1-vCPU host. An explicit `SWIZZLE_WORKER_CPUS` larger than the host stops `just stack` before any image build and names the key and the host's CPU count.
- An API check that fails with an authentication error reports an error or credentials outcome instead of drift.
- `swizzle validate` and `swizzle inspect` describe a deployed runtime as the sandbox container.

### Fixed

- Webhooks deployed on 1.0.x keep starting runs at their original URLs after an upgrade and after redeploying unchanged source. `/health` and `/ready` report the version of the code that runs, not a version left in `.env`.
- Revoking an agent token and other dashboard confirmations work in browsers that suppress `window.confirm`. The Agent access copy button selects the command for manual copy when the clipboard is unavailable.
- The setup form says at the password field that 15 characters are needed. An invalid field is marked in the fail colour.
- Approval details show as labelled fields in Overview > Needs you, the run panel and the approval page, instead of raw JSON.
- `swizzle logs --run <id> --full` prints stderr with real line breaks.
- The `document-scanner` example's email search no longer retries at every character of a long word, and documents over 65,536 characters fail with a clear error.
- The README, the tutorial and the guides that `swizzle workspace init` writes store a webhook's signing secret before `swizzle validate`, and connect the CLI with one `swizzle profile add`.
- The builder skill links public documentation instead of paths in a source checkout, names `just init-env` for credentials and `SWIZZLE_LINK_URL` for approval links, and lists the tools the runner image installs.
- The install guide names `libatomic1` for Debian and Ubuntu, links Docker's install guide with the Compose version check, shows `mise x -- just` for a shell without mise activated, and says the first build takes minutes on a small host.
- `just init-env` prints failures without a stack trace. It refuses a `SWIZZLE_LOCAL_WORKER_TOKEN` in the format of checkouts older than 1.0.0, which the API refuses, before any image build, and says how to replace it.

## 1.0.2

### Changed

- The dashboard, its sign-in pages and the README show the Swizzle logo from the project website.
- The `document-scanner` example runs as durable steps, so its page shows each step on the flowchart and in the code while a run moves through it.

### Fixed

- A run image whose size cannot be measured appears as unmeasured in the worker disk warning, instead of as an invented byte count. A failed or timed-out image history export no longer stops the worker from pruning other images.
- A link to a section of Settings scrolls there once that section's data has loaded, instead of waiting until every request in the dashboard has finished.

## 1.0.1

### Fixed

- The runner image disk budget counts each unpacked image layer once, on Docker's containerd image store and on the classic overlay2 storage driver. Before, a worker on the containerd store could report its active images at more than twice their size and remove retained images sooner than `SWIZZLE_RUNNER_IMAGE_DISK_MB` required. On the classic driver, it could undercount images that share layers and keep more than the budget. The budget covers unpacked layers only, so reserve extra host disk for packed image blobs and metadata.
- One runner image whose layers cannot be mapped no longer stops the worker from pruning the others. The worker logs that image and counts it as larger than `SWIZZLE_RUNNER_IMAGE_DISK_MB`, so an inactive one is removed after the ten-minute grace period.
- Two deployments that claim the same webhook path at the same moment: the one that loses now gets `TRIGGER_WEBHOOK_PATH_CONFLICT` instead of a raw database error.
- The health strip on the Overview reads "Last run did not fail" or "Last run failed" for an automation with one run, instead of "Last 1 runs".
- The README's first deployment stores the webhook signing secret before `swizzle apply hello`, which otherwise stops with `PLATFORM_REQUIRED_SECRETS_MISSING`.

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
