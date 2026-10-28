# Upgrade an installed server

Upgrade any server from an earlier 1.x release with this procedure. The upgrade keeps its data, configuration, and credentials. Run it on the server, in the checkout used by `just stack`. Image preparation runs while the installed services keep running. Expect downtime during backup, database migrations, and service startup. Read the target release's [changelog](../../CHANGELOG.md) before upgrading, especially for a major version.

## Upgrade the server

Keep your checkout clean. Commit any tracked configuration changes and remove untracked files before upgrading. `.env` is ignored by Git and stays with the installed stack. Keep a separate copy of it, especially `SWIZZLE_ENCRYPTION_KEY`.

```bash
cd /opt/swizzle
export PATH="$HOME/.local/bin:$PATH"
mise x -- just upgrade v1.0.5
```

Omit the tag to select the newest stable release tag from `origin`:

```bash
mise x -- just upgrade
```

The PATH line makes the default mise installation available in a plain SSH shell. If mise is installed elsewhere, add that directory instead. `mise x` supplies Node.js and `just`, but the recipe also needs mise itself on PATH. With mise already activated, `just upgrade` is equivalent.

The recipe refuses uncommitted changes before contacting `origin` or stopping anything. Select a tag advertised by `origin`. The recipe rejects local-only tags.

Before stopping anything, the recipe checks `just`, `mise`, the pinned Node toolchain, Docker Compose, shell tools, and free space in Docker's data directory. It stages the target release and prepares all its images while the API, scheduler, and worker keep running. Dependency images such as Postgres and Valkey are pulled only when missing locally. Published releases pull service images. Releases without images, 1.0.4 and earlier, build one service at a time, with Turbo limited to one workspace at a time. It needs 5 GiB free for pulls or 12 GiB for source builds, including a reserve for backup. A missing tool, insufficient space, or a failed pull leaves the installed services running. The recipe also refuses a service whose containers use different image IDs. Remove or reconcile its obsolete containers before retrying so recovery has one installed image per service.

After image preparation, the recipe stops the API, scheduler, and worker so the database and artifacts are captured together. It stores the backup and a copy of `.env` in a private directory under the checkout's Git directory. Keep that directory until you have checked the upgraded instance.

After backup, the recipe checks out the release, updates `.env`, and starts the prepared images without pulling or building. Compose applies migrations through its `migrate` service before starting the API. The recipe waits for `/health` to report the version from the new code, then prints the old and new commits and the backup path. The checkout stays detached at the release commit. Use `just stack` to apply later configuration changes with that release's image selection.

### If your installed release predates image preparation

For the first upgrade to a release with image preparation, run the target release's scripts from the Git directory. Put `mise` and `just` on PATH first. This leaves the installed code in place until its backup completes:

```bash
export PATH="$HOME/.local/bin:$PATH"
git fetch --no-tags origin refs/tags/v1.0.5
mkdir -p "$(git rev-parse --git-path swizzle-upgrade)"
git show FETCH_HEAD:scripts/upgrade.ts > "$(git rev-parse --git-path swizzle-upgrade/upgrade.ts)"
git show FETCH_HEAD:scripts/stack-images.ts > "$(git rev-parse --git-path swizzle-upgrade/stack-images.ts)"
mise x -- node "$(git rev-parse --git-path swizzle-upgrade/upgrade.ts)" v1.0.5
```

In both places, use `v1.0.5`, the first release with image preparation, or a later release. Subsequent upgrades use `just upgrade`.

## Verify release images

Install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/) on the machine where you verify releases. The public tag workflow signs each multi-platform image digest with its GitHub identity and attaches BuildKit provenance. Verify the API image for your chosen version:

```bash
VERSION=1.0.5
cosign verify "ghcr.io/swizzletech/swizzle-api:$VERSION" \
  --certificate-identity "https://github.com/swizzletech/swizzle/.github/workflows/images.yml@refs/tags/v$VERSION" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Use a version with published images. Repeat the command for each `swizzle-<service>` image listed by `just image-plan "$VERSION" images.json`. The plan derives the list from the packaged Compose stack, including the backup and runner images. A successful verification reports the signed digest. Inspect the attached provenance with `docker buildx imagetools inspect "ghcr.io/swizzletech/swizzle-api:$VERSION" --format '{{json .Provenance.SLSA}}'`.

## Check the result

Sign in with the existing owner's account, open a project's automation and check its earlier runs. Trigger an automation that uses a secret and confirm it succeeds. Run `swizzle doctor` with the profile for this instance. Settings > Instance and `/health` show the server version compiled into the running code. An old `SWIZZLE_IMAGE_TAG` in `.env` cannot override it; `just init-env`, also run by `just stack`, removes that line while keeping credentials and other settings.

Existing deployments keep their binary version matching behavior. In a deployment saved by 1.0.4, `latest` accepts a known worker version and bare `25` matches only `25.0.0`, so it rejects `25.3`. Runs, API checks, and worker image preparation keep reading those artifacts after an upgrade. New source validation rejects `latest` and treats bare `25` as a numeric prefix. New deployments record that matching revision in their configuration and artifacts.

The upgrade preserves 1.0.x webhook URLs, including scaffold paths under `/hooks/` and author-written root paths such as `/orders`. Senders need no change, and you do not need to redeploy. Redeploying unchanged source keeps each URL. Root paths remain on the API origin. The public listener forwards only approval, event, `/hooks/`, and OAuth callback routes. API, CLI, and dashboard use `SWIZZLE_API_ORIGIN` when they display a root-path webhook URL, even if `SWIZZLE_PUBLIC_URL` names the restricted listener.

## Recover after a failed upgrade

A failed migration or version check prints the backup path and a restore command. Keep the output. The command returns to the previous code, puts its `.env` back, restores the pre-upgrade backup, and starts the previous image IDs retained on the host. Recovery works whether those images were pulled or built and needs no registry or compiler. The printed command authorizes overwriting the database and artifacts without another prompt. The command stops the writers before restoring. Any data written after the backup is lost.

If the backup itself fails, the checkout stays at the original commit and the recipe prints a Docker Compose command to restart the retained images. Fix the backup error before trying the upgrade again. [Back up and restore an instance](back-up-and-restore.md) explains the backup's contents and the restore procedure. Do not use `just stack-down` during an upgrade or recovery; it deletes the volumes.

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
