# Back up and restore an instance

PostgreSQL holds deployments, triggers, runs, state, encrypted secrets, connections, account and invitation records, API tokens, and sessions. The artifact store holds each deployment's source tree. `swizzle backup export` writes both stores to one directory ([`apps/cli/src/backup.ts`](../../apps/cli/src/backup.ts), [`packages/runtime/src/backup.ts`](../../packages/runtime/src/backup.ts)):

- `metadata.json` names the artifact backend, the format version, and the time of the export.
- `database.sql` is a `pg_dump` of the database.
- `artifacts/` is a copy of the artifact store.

The backup does not hold `.env`. Back up `.env` separately. Without its `SWIZZLE_ENCRYPTION_KEY`, the restored secrets and connections cannot be decrypted. Caddy's certificates live in the `caddy-data` and `caddy-config` volumes. Caddy requests new certificates when those volumes are empty.

## Know what the recipes reach

`just backup` and `just restore` use the Compose stack's `backup` service from [`compose.yml`](../../infra/docker/compose.yml). The service joins the stack's network and mounts its `artifacts-data` volume. Both recipes read database credentials and the artifact backend from `.env`. They pull the release image, or build from source when the checkout has no published image, and start Postgres if it is down. Restore prepares all stack images before stopping writers. See [release images](upgrade.md#verify-release-images) for signature verification.

With the `s3` backend, the backup holds a copy of the bucket prefix instead of the volume.

## Write a backup

Give each backup a new directory, for example one named by date:

```bash
just backup backups/2026-10-23
```

A relative directory is relative to the checkout. The recipe exports into a disposable container volume, then transfers the backup to your host directory and prints the `just restore` command for it. The files belong to your user. Both commands set directories to `0700` and regular files to `0600`. Keep backups private because the dump can contain sensitive run output and encrypted secrets.

Both commands refuse a destination that exists and is not empty. An empty directory is allowed. The error suggests a new directory, such as one named by date. A nightly job needs a different directory each night, for example `backups/$(date +%F)`. Remove a backup by removing its directory.

Both commands stage the backup in a private sibling directory. They flush each file and directory before renaming the finished directory to the destination in one step. Then they flush the destination's parent directory. Until the rename, restore cannot read a backup from the destination. A failed export removes its staging directory, but a killed export can leave one behind. Remove a leftover staging directory only after confirming no export is running. Both commands reject symbolic links in the export.

## Restore a backup

A restore overwrites the database and the artifact store. Before you start, check `.env` for the `SWIZZLE_ENCRYPTION_KEY` used to make the backup. Also check that `SWIZZLE_ARTIFACT_BACKEND` matches the backend in `metadata.json`.

1. Restore the backup:

   ```bash
   just restore backups/2026-10-23
   ```

   The recipe asks for confirmation and streams the private backup into a disposable container volume. It stops the api, scheduler, and workers before replacing the database and artifact store. It starts the stack again only after a successful restore. If restore fails, the services stay stopped. Restore refuses a backup with a different artifact backend or missing files. With `s3`, restore empties the configured prefix before uploading the backup's objects.

2. Run `swizzle doctor`, then trigger a known automation and check that it succeeds.
