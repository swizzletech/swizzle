# Upgrade an installed server

Upgrade any server from an earlier 1.x release with this procedure. The upgrade keeps its data, configuration, and credentials. Run it on the server, in the checkout used by `just stack`. Expect downtime while the services stop, the stack rebuilds, and database migrations run. Read the target release's [changelog](../../CHANGELOG.md) before upgrading, especially for a major version.

## Upgrade the server

Keep your checkout clean. Commit any tracked configuration changes and remove untracked files before upgrading. `.env` is ignored by Git and stays with the installed stack. Keep a separate copy of it, especially `SWIZZLE_ENCRYPTION_KEY`.

```bash
cd /opt/swizzle
just upgrade v1.0.3
```

Omit the tag to select the newest stable release tag from `origin`:

```bash
just upgrade
```

The recipe refuses uncommitted changes before contacting `origin` or stopping anything. Select a tag advertised by `origin`. The recipe rejects local-only tags.

Before backup, the recipe stops the API, scheduler, and worker so the database and artifacts are captured together. It stores the backup and a copy of `.env` in a private directory under the checkout's Git directory. Keep that directory until you have checked the upgraded instance.

After backup, the recipe checks out the release and runs `just stack`. Compose applies migrations through its `migrate` service before starting the API. The recipe waits for `/health` to report the version from the new code, then prints the old and new commits and the backup path. The checkout stays detached at the release commit.

### If your installed release has no upgrade recipe

For the first upgrade from v1.0.2, run the target release's script from the Git directory. This leaves the installed code in place until the script has made its backup:

```bash
git fetch --no-tags origin refs/tags/v1.0.3
git show FETCH_HEAD:scripts/upgrade.ts > "$(git rev-parse --git-path swizzle-upgrade.ts)"
node "$(git rev-parse --git-path swizzle-upgrade.ts)" v1.0.3
```

Use the tag you intend to install in both places. Subsequent upgrades use `just upgrade`.

## Check the result

Sign in with the existing owner's account, open a project's automation and check its earlier runs. Trigger an automation that uses a secret and confirm it succeeds. Run `swizzle doctor` with the profile for this instance. Settings > Instance and `/health` show the server version compiled into the running code. An old `SWIZZLE_IMAGE_TAG` in `.env` cannot override it; `just init-env`, also run by `just stack`, removes that line while keeping credentials and other settings.

The upgrade preserves 1.0.x webhook URLs, including scaffold paths under `/hooks/` and author-written root paths such as `/orders`. Senders need no change, and you do not need to redeploy. Redeploying unchanged source keeps each URL. Root paths remain on the API origin. The public listener forwards only approval, event, `/hooks/`, and OAuth callback routes. API, CLI, and dashboard use `SWIZZLE_API_ORIGIN` when they display a root-path webhook URL, even if `SWIZZLE_PUBLIC_URL` names the restricted listener.

## Recover after a failed upgrade

A failed migration, build or version check prints the backup path and a restore command. Keep the output. The command returns to the previous code, puts its `.env` back, rebuilds the previous release's images, and runs `just restore` against the pre-upgrade backup. Restore asks for confirmation because it replaces the database and artifacts. Any data written after the backup is lost.

If the backup itself fails, the checkout stays at the original commit and the recipe prints `just stack` to restart it. Fix the backup error before trying the upgrade again. [Back up and restore an instance](back-up-and-restore.md) explains the backup's contents and the restore procedure. Do not use `just stack-down` during an upgrade or recovery; it deletes the volumes.

## Update the CLI

The CLI updates separately on each machine that uses it. Run the newest published CLI without a global installation:

```bash
npx @swizzletech/cli@latest doctor
```

Or update the global installation:

```bash
npm i -g @swizzletech/cli@latest
swizzle doctor
```

Compare `swizzle --version` with `serverVersion` from `swizzle doctor --json`. The CLI and server use the same release number. When they differ, install the CLI version that matches the server, for example `npx @swizzletech/cli@1.0.3 doctor`, or upgrade the server before using the latest CLI. A major version can change API requests, CLI output and automation configuration; do not assume mismatched versions work together. Updating the CLI preserves its saved profiles.
