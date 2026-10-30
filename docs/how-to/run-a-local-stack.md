# Run a local stack

Use `just dev-fresh` to start a clean dev stack for a dashboard check. Use `just dev` to keep this worktree's database and artifact data between sessions. The two are separate stacks, so a fresh one never touches the data `just dev` keeps.

## Start a stack for a UI check

1. Run the stack:

   ```bash
   just dev-fresh
   ```

   The recipe installs the project dependencies, starts PostgreSQL and Valkey in Docker, applies migrations, seeds a first account and four webhook examples, and starts the API, scheduler, worker, and dashboard. Its local worker serves every project and environment, including ones you create later in the dashboard or through the API. The recipe prints the dashboard URL, API URL, and login.

   When Tailscale runs on the host, the recipe also publishes the dashboard with `tailscale serve` on the same port of the host's tailnet name and prints it as `tailnet`, such as `https://host.tailnet.ts.net:5173/`. A browser on another device of the tailnet signs in there. The dashboard listens on 127.0.0.1 only, and the API allows sign-in from exactly the printed dashboard origins.

2. Open the printed dashboard URL and sign in with the printed login. The email is `owner@swizzle.test`. The password is generated on first use and stored in `~/.config/swizzle/dev.env`.

   The stack runs its own mail server on 127.0.0.1, so invitations and password resets work without a real one. Each mail it sends appears in the recipe's output and in the printed `mailbox` file, with its link. The links open the tailnet dashboard when it is published, else the local one. Webhook URLs and OAuth callbacks use the dashboard's `/api` proxy at the same address.

3. Stop the recipe with Ctrl-C or SIGTERM. It stops the services, removes the tailnet publication, and deletes the fresh stack's database, containers, and artifact data.

   If the recipe was killed, run `just dev-down`. The command stops either dev stack, removes the fresh stack's data, and keeps the data of `just dev`.

   Before it signals an orchestrator or cleans a stack, `just dev-down` checks the recorded PID's worktree and process start identity. The `just smoke` and `just perf` sweepers use the same check. If the PID has been reused or the live process belongs to another worktree, `just dev-down` exits without cleanup.

   Each process group has a supervisor with a recorded PID and start identity. The supervisor stays alive after the services command exits, so cleanup can still verify ownership and kill descendants that ignore SIGTERM. A supervisor also stops its group if the orchestrator dies. A stop sends SIGTERM to the supervisor, which passes it once to its command, so turbo lets the API, scheduler and worker shut down; the worker then removes its standby sandboxes. A second SIGTERM would make turbo kill them at once. The supervisor signals the whole group only after its command has exited. Cleanup skips a group whose supervisor no longer matches. Tests set `SWIZZLE_DEV_STOP_TIMEOUT_MS` to shorten the 15-second SIGTERM grace for stubborn fixtures. The orchestrator still has 30 seconds to finish cleanup.

## Keep development data

Run `just dev` to start the same services while keeping this worktree's database and artifact data when you stop it. The command prints the current dashboard URL and login. Stop it with Ctrl-C or SIGTERM. The API, scheduler, and worker load workspace code from source. They restart when an imported file under `apps/` or `packages/` changes. You do not need to rebuild packages.

To change the number of simultaneous runs in a dev stack, set `WORKER_CONCURRENCY` before `just dev` or `just dev-fresh`. Both recipes use the same default and setting as packaged and remote workers. See [the worker protocol](../reference/worker-protocol.md#execution-and-lease-data).

The dev stack uses PostgreSQL 18. Remove an existing dev PostgreSQL volume before starting `just dev` with this version. The stack does not migrate data between PostgreSQL major versions.

Each worktree gets a separate Compose project, database, Valkey instance, and ports for `just dev` and `just dev-fresh`. The recipes record the ports and URLs in `stack.json` under `git rev-parse --git-path swizzle-dev` and `swizzle-dev-fresh`. All worktrees for this user share the secrets in `~/.config/swizzle/dev.env`; the stack creates that file with private permissions on first use. Set `XDG_CONFIG_HOME` to use another config directory.

The `dev.env` file accepts other `KEY=value` settings too. The API, scheduler, worker, and dashboard receive them when `just dev` starts.

If a required secret in `dev.env` is missing or blank, startup fails and names the key without changing the file. Restore the value, then rerun `just dev` or `just dev-fresh`. To generate new credentials, delete `dev.env` and rerun the same recipe.

## Check the dashboard in a browser

Run `just e2e` for all dashboard browser flows, or `just e2e needs-you.spec.ts` for one spec. The recipe builds the dashboard first. Playwright serves the built assets through Vite preview ([`playwright.config.ts`](../../playwright.config.ts)), and the flows mock the API. Follow [the deterministic test guide](write-deterministic-tests.md) when you add or change a flow.

## Check a change

Run `just verify-fast` during a worker round. It runs the static and generated-reference checks, then selects tests that import changed code. The comparison includes staged, unstaged, and untracked files against the merge base of local `main`. Pass `--base HEAD` to compare with the current commit, or add `--list` to `just test-affected` to print the selection.

Tests that run code in child processes declare those source files in [`test/inputs.json`](../../test/inputs.json). That file also selects `agent-reference-drift.test.ts` when the shipped skill assets change. Changes to public Markdown pages select the documentation test used by `just docs-check`. Shared test configuration or support, lockfiles, deleted files, and changed files with no detected test consumer select the whole suite. An unavailable comparison also selects every test.

The affected-test cache reuses green results only when repository contents, selected files, runtime, and relevant environment match. Static checks still run. Failed runs and edits during a run do not save results. Delete `node_modules/.cache/affected-tests` to force a fresh run.

Run `just verify` before landing. It runs every test without using the affected-test cache. CI runs every test in three shards. The required `Verify` check depends on all three shard jobs, so a failure outside the affected-test selection fails CI too.

## Check PostgreSQL behavior

Run `just verify-state-machine` to run the Vitest `postgres` project. The project starts a disposable PostgreSQL container and migrates a template database. Each test file gets a database clone, and the fixture resets its rows before each test. Store, auth, and route tests use the production PostgreSQL implementations.

`just verify` runs the whole PostgreSQL project. To run one file, use `just test packages/db/src/api-tokens.postgres.test.ts`. The fixture removes the container on normal exit, SIGINT, or SIGTERM. See [`test/postgres-global.ts`](../../test/postgres-global.ts). The runner configurations set the hang limits. Tests do not set their own timeouts or retries. See [the deterministic test guide](write-deterministic-tests.md) for waiting and resource ownership rules. `test/warnings.ts` fails the test run on listener warnings or PostgreSQL concurrent-query deprecations.

Run `just verify-multi-worker` to check two workers against this worktree's dev databases. See [`verify-multi-worker.ts`](../../scripts/verify-multi-worker.ts). Run `just verify-dispatch` for offline placement, simultaneous claims, shared capacity, rate admission, cancellation, drain, lease loss, stale replies, queue loss, and API restart against a throwaway migrated database ([`verify-dispatch.ts`](../../scripts/verify-dispatch.ts)). It also checks durable image ownership and concurrent registration and pruning. Run `just verify-run-images` to check those image behaviors on their own.

Sources: [`justfile`](../../justfile), [`playwright.config.ts`](../../playwright.config.ts), [`dev-stack.mts`](../../scripts/dev-stack.mts), [`process-identity.ts`](../../scripts/process-identity.ts), [`dev-stack-supervisor.mts`](../../scripts/dev-stack-supervisor.mts), [`dev-stack-timeout.ts`](../../scripts/dev-stack-timeout.ts), [`dev-stack-seed.mts`](../../scripts/dev-stack-seed.mts), [`vitest.config.ts`](../../vitest.config.ts), [`test/warnings.ts`](../../test/warnings.ts), [`infra/docker/compose.test.yml`](../../infra/docker/compose.test.yml), [`test/postgres-global.ts`](../../test/postgres-global.ts), [`test/postgres-setup.ts`](../../test/postgres-setup.ts), [`test/postgres.ts`](../../test/postgres.ts), [`scripts/test-sequencer.ts`](../../scripts/test-sequencer.ts), [`affected-tests.mts`](../../scripts/affected-tests.mts), [`affected-tests.ts`](../../scripts/affected-tests.ts), [`agent-reference-drift.test.ts`](../../scripts/agent-reference-drift.test.ts), [`test/inputs.json`](../../test/inputs.json), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`verify-multi-worker.ts`](../../scripts/verify-multi-worker.ts), [`verify-run-images.ts`](../../scripts/verify-run-images.ts), [`env-file.ts`](../../scripts/env-file.ts), [`compose.dev.yml`](../../infra/docker/compose.dev.yml), [`databases.yml`](../../infra/docker/databases.yml).
