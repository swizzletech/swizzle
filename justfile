# The only way to run anything in this repository. `just` lists the recipes.
# Every recipe line runs from the repository root under the Node and pnpm that mise.toml pins;
# mise installs them on first use.

set shell := ["mise", "exec", "--", "bash", "-euo", "pipefail", "-c"]

# .env configures the packaged stack alone and names its compose project; the dev stack
# (scripts/dev-stack.mts) reads per-user secrets.
compose := "docker compose --env-file .env -f infra/docker/compose.yml"
# Runs a command against the Postgres and Valkey of this worktree's `just dev`, starting them first.
dev_db := "node scripts/dev-stack.mts run --"
# Runs a TypeScript file with every @swizzle/* import resolved to the package's src through the
# swizzle-source export condition: how the repository runs its own code, so no recipe builds first.
tsx := "pnpm exec tsx --conditions=swizzle-source"

# Only GitHub's runners may install the browser's OS packages: they have passwordless sudo and apt.
# CI alone does not grant that: other runners set it on hosts where sudo asks for a password.
browser_deps := if env("GITHUB_ACTIONS", "") == "true" { "--with-deps" } else { "" }

_default:
    @{{ just_executable() }} --justfile {{ justfile() }} --list --unsorted

# Write the packaged stack's .env with fresh credentials and a compose project of its own; keeps an existing one.
init-env:
    node scripts/init-env.ts

# Write .env, then install a contributor's dependencies, the git hooks and the e2e browser; safe to rerun.
setup: init-env
    pnpm install --frozen-lockfile
    lefthook install
    pnpm exec playwright install {{ browser_deps }} chromium

# The dev recipes give each worktree, and in it `dev` and `dev-fresh`, a compose project, free
# ports and data of their own, so they run side by side. `exec` makes scripts/dev-stack.mts the
# process just signals, so SIGTERM or Ctrl-C reaches it, and it stops every process and container
# it started.

# Run this worktree's api, scheduler, worker and web with hot reload; prints the URL and test login, keeps the data.
dev: setup
    exec node scripts/dev-stack.mts dev

# Run this worktree's dev stack from the seed for a UI check; prints the URL and test login, deletes its data on stop.
dev-fresh: setup
    exec node scripts/dev-stack.mts fresh

# Stop this worktree's dev stacks, also after their recipe was killed; `dev-fresh` data goes, `dev` data stays.
dev-down:
    node scripts/dev-stack.mts down

# Run the tests whose file path matches the arguments (all without), as the gate runs them.
[positional-arguments]
test *args:
    @pnpm exec vitest run "$@"

# Lint, conventions, dependency direction, migration drift, types and dead code: the static gate, in seconds.
check:
    @# Report release version drift before pnpm checks workspace metadata.
    @node --import tsx --conditions=swizzle-source scripts/conventions/main.ts
    pnpm exec biome check .
    @# conventions-allow no-private-paths: the private repository's own checks; the export has none.
    @if test -f .agents/checks/main.ts; then {{ tsx }} .agents/checks/main.ts; fi
    @# These two name themselves in their one green line, so the recipe does not echo them.
    @pnpm exec depcruise --output-type err-long apps packages scripts | sed '/^$/d'
    @{{ tsx }} packages/db/check-migrations.ts
    @echo "pnpm exec turbo run typecheck"
    @# turbo prints a banner and a summary even when every task is cached; show them only on failure.
    @out=$(pnpm exec turbo run typecheck --output-logs=errors-only 2>&1) || { printf '%s\n' "$out"; exit 1; }
    pnpm exec tsc -p tsconfig.test.json
    pnpm exec knip

# Apply formatting and safe lint fixes in place.
format:
    pnpm exec biome check --write .

# The static gate, every unit and integration test and the generated-reference check: all docs-check proves, without the stack.
verify-fast: check test _reference-current

# The full gate a commit must pass; runs setup first, so a fresh clone needs nothing else.
verify: setup verify-fast verify-dispatch build e2e
    {{ compose }} --profile stack config --quiet
    POSTGRES_PASSWORD=x VALKEY_PASSWORD=x docker compose -p swizzle-dev-check -f infra/docker/compose.dev.yml config --quiet

# Prove a prose-only change: links and linked symbols resolve, the skill teaches real commands, docs/reference is current, the docs follow the conventions.
docs-check: _reference-current
    pnpm exec vitest run scripts/agent-reference-drift.test.ts
    @{{ tsx }} scripts/conventions/main.ts
    @# conventions-allow no-private-paths: the private repository's own checks; the export has none.
    @if test -f .agents/checks/main.ts; then {{ tsx }} .agents/checks/main.ts; fi

# Regenerate docs/reference from the config schema, the CLI command tree and the API routes.
gen:
    {{ tsx }} scripts/gen-reference.mts

_reference-current:
    @{{ tsx }} scripts/gen-reference.mts --check

# Build every package and app; turbo replays unchanged outputs from its cache.
build:
    pnpm exec turbo run build

# Delete every build output, so nothing stale survives a branch switch.
clean:
    pnpm exec turbo run clean

# Linux runs the flows in a private network namespace: Chromium aborts every in-flight request,
# loopback included, when a host interface changes address, as it does whenever another
# checkout starts or stops a container. Hosts that forbid user namespaces (Ubuntu 24.04 by
# default, so CI) run one checkout per machine and fall back to the plain command.

# Build, then run the Playwright dashboard flows against the built assets; paths narrow the flows.
[linux]
[positional-arguments]
e2e *args: build
    @if unshare --user --map-root-user --net ip link set lo up 2>/dev/null; then \
        unshare --user --map-root-user --net bash -c 'ip link set lo up && exec pnpm exec playwright test "$@"' e2e "$@"; \
    else \
        echo "e2e: this host forbids user namespaces, so the run has no network isolation" >&2; \
        pnpm exec playwright test "$@"; \
    fi

# Build, then run the Playwright dashboard flows against the built assets; paths narrow the flows.
[macos]
[windows]
[positional-arguments]
e2e *args: build
    pnpm exec playwright test "$@"

# Fail on moderate or worse advisories in all dependencies (reads the live advisory feed).
audit:
    pnpm audit --audit-level=moderate

# Raise every dependency to the newest release its range allows, so no major changes, and rewrite the lockfile (reads the live registry).
deps-update:
    pnpm update -r

# List every dependency with a newer release, holds included; the catalog in pnpm-workspace.yaml says why each is held (reads the live registry, exits 1 while it lists one).
deps-outdated:
    pnpm outdated -r

# Write the migration for a change to packages/db/src/schema.ts, named for what it changes (`just db-generate run_wait_details`); commit it with that change.
db-generate name:
    pnpm --dir packages/db exec drizzle-kit generate --name {{ name }}

# Renumber this branch's migrations after main's when both added one; run it where `git rebase main` stops on the journal, then continue.
db-migration-rebase:
    @{{ tsx }} packages/db/rebase-migrations.ts

# Apply the Drizzle migrations to this worktree's dev database; `just dev` applies them on start too.
db-migrate:
    {{ dev_db }} {{ tsx }} packages/db/src/migrate.ts

# Rewrite every stored credential under the current SWIZZLE_ENCRYPTION_KEY after a key rotation.
db-reencrypt:
    {{ dev_db }} {{ tsx }} packages/db/src/reencrypt-credentials.ts

# The archive lists metadata.json last, so an extraction cut short leaves a staged directory that
# restore refuses. The export's own answer names its path inside the container, so it is shown
# only when the export fails; the recipe names the host directory instead, quoted for the shell.

# Write an owner-only backup of the stack to <dir>, a new or empty directory: its database and its artifact store.
backup dir:
    node packages/runtime/src/backup.ts check {{ quote(dir) }}
    {{ compose }} --profile tools build backup >&2
    output={{ quote(dir) }}; parent=$(dirname -- "$output"); name=$(basename -- "$output"); \
        mkdir -p "$parent"; \
        staging=$(mktemp -d "$parent/.$name-XXXXXX"); trap 'rm -rf "$staging"' EXIT; \
        {{ compose }} --profile tools run --rm -T --volume /backup --entrypoint sh backup -ec 'answer=$(node dist/bin.js backup export --output-dir /backup/export) || { echo "$answer" >&2; exit 1; }; tar -cf - -C /backup/export database.sql artifacts metadata.json' >"$staging/backup.tar"; \
        mkdir -m 700 "$staging/backup"; tar -xf "$staging/backup.tar" -C "$staging/backup"; \
        node packages/runtime/src/backup.ts publish "$staging/backup" "$output"; \
        rm -rf "$staging" || echo "Backup published; remove staging directory $staging manually." >&2; \
        trap - EXIT; \
        shown={{ quote(quote(dir)) }}; echo "Backup written to $output. Run \`just restore $shown\` to restore it."

# Stream the private backup into a disposable volume owned by the image user, which can write
# the artifact store. The host backup never needs group read access.

# Overwrite the stack's database and artifact store with the backup in <dir>, with api, scheduler and worker stopped.
[confirm("Restore overwrites the stack's database and artifact store. Continue?")]
restore dir:
    {{ compose }} --profile stack stop api scheduler worker
    tar -C {{ quote(dir) }} -cf - . | {{ compose }} --profile tools run --rm --build -T --volume /backup --entrypoint sh backup -ec 'tar -xf - -C /backup; exec node dist/bin.js backup restore --input-dir /backup --yes'
    {{ compose }} --profile stack up -d --wait

# Restore a locked-out owner's access to the running stack: prints a one-time link that sets a new password.
recover-owner email:
    {{ compose }} --profile stack exec -T api node dist/recover-owner.js {{ quote(email) }}

# Build and start the full hardened stack behind Caddy, as production runs it; the images build in Docker, so the host needs only .env.
stack: init-env
    {{ compose }} --profile stack up --build -d --wait

# Cleanup removes owned image IDs: the service images Compose built for the project and the run images
# the worker labelled with it. Pulled images such as postgres stay, since other stacks share them.
# `docker image prune` deletes the containerd leases of every import and commit on the daemon, so it
# would fail other stacks' image loads and run image assembly.

# Stop the packaged stack of `just stack` and delete its volumes, its service images and its run images.
stack-down:
    project=$({{ compose }} config --format json | node -e 'let data=""; for await (const chunk of process.stdin) data += chunk; console.log(JSON.parse(data).name)'); \
    {{ compose }} --profile stack stop worker; \
    containers=$(docker ps --all --quiet --filter "label=swizzle.stack=$project"); \
    if [ -n "$containers" ]; then docker rm --force $containers; fi; \
    {{ compose }} --profile stack down -v; \
    images=$( { docker image ls --all --quiet --filter "label=com.docker.compose.project=$project"; \
        docker image ls --all --quiet --filter "label=swizzle.stack=$project"; } | sort -u); \
    if [ -n "$images" ]; then docker image rm --force $images; fi

# Check PostgreSQL stores, authentication and API routes in isolated databases.
verify-state-machine:
    pnpm exec vitest run --project postgres

# Exercise HTTP worker claims, offline placement, lease loss, stale results and restart receipts.
verify-dispatch:
    {{ dev_db }} {{ tsx }} scripts/verify-dispatch.ts

# Exercise durable image ownership, same-source replacement and concurrent registration/pruning.
verify-run-images:
    {{ dev_db }} {{ tsx }} -e 'import { withVerificationDatabase } from "./scripts/verification-database.ts"; import { verifyRunImages } from "./scripts/verify-run-images.ts"; withVerificationDatabase(verifyRunImages).catch(error => { console.error(error); process.exitCode = 1; });'

# Two workers on one queue finish every run exactly once, against dev Postgres and Valkey.
verify-multi-worker:
    {{ dev_db }} {{ tsx }} scripts/verify-multi-worker.ts

# Boot the packaged stack as a throwaway project, deploy and trigger an example through it, then remove it with its volumes.
smoke: setup
    exec {{ tsx }} scripts/smoke.mts

# Measure api latency, the run lifecycle, CPU and memory per service and dashboard page loads on a throwaway packaged stack; `api` or `web` narrows it, `--against <git ref>` measures that commit alongside and prints the delta, `--base <result.json>` prints the delta to an earlier run.
[positional-arguments]
perf *args: setup
    exec {{ tsx }} scripts/perf.mts "$@"

# Build and start a worker-only stack on the selected native Docker engine.
[positional-arguments]
worker credential_file *args:
    node scripts/worker-stack.mts "$@"

# Prove named LLM inference and private-network denial against a verify-swizzle stack and a local model.
verify-local-llm:
    {{ tsx }} scripts/verify-local-llm.mts

# Install and exercise a CLI tarball outside the checkout; optionally target an HTTPS API with SWIZZLE_TOKEN.
[positional-arguments]
verify-cli-package tarball *args:
    node scripts/verify-cli-package.mts "$@"

# Export one commit without private guides or history into a new directory; never writes to a remote.
export-public directory commit="HEAD":
    node scripts/export-public.mts {{ quote(directory) }} {{ quote(commit) }}

# Scan the files tracked in this checkout with the repository's secret policy; generated files stay out.
secret-scan:
    @archive=$(mktemp -d); trap 'rm -rf "$archive"' EXIT; \
        git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$archive"; \
        gitleaks dir "$archive" --config .gitleaks.toml --redact --no-banner

# Build and pack the publishable CLI into a named artifact directory; never publishes it.
pack-cli directory: build
    pnpm --dir apps/cli/build/npm pack --pack-destination {{ quote(absolute_path(directory)) }}
