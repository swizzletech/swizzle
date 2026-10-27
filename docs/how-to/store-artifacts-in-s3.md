# Store deployment artifacts in S3

Each deployment stores its source tree in the artifact backend. The default backend is `local`: a directory shared in Compose by the API and scheduler through the `artifacts-data` volume. Workers receive source bundles from the API. The `s3` backend stores the trees in a bucket of an external S3-compatible service, such as AWS S3 or Cloudflare R2. The stack bundles no S3 server. The API makes a temporary source copy when it prepares a deployed execution or check, then removes the copy after preparation. The same cleanup runs if copying or preparation fails.

In the Compose stack, the API reaches the bucket through the control egress proxy ([`controlEgressAgentOptions`](../../packages/core/src/http-egress.ts)). The proxy allows the exact hostname and port of `SWIZZLE_ARTIFACT_S3_ENDPOINT`, including a LAN address or `http://host.docker.internal:9000` for a server on the Docker host ([`control-egress.mjs`](../../infra/docker/control-egress.mjs)). Workers receive source bundles from the API and have no bucket credentials. Sandboxed runs receive no bucket exception. The scheduler and the `backup` service reach the bucket directly.

## Switch the backend

1. Set the backend and the bucket in `.env` for the Compose stack, or in `~/.config/swizzle/dev.env`, which `just dev` passes to every service it starts:

   ```env
   SWIZZLE_ARTIFACT_BACKEND=s3
   SWIZZLE_ARTIFACT_S3_BUCKET=swizzle-artifacts
   SWIZZLE_ARTIFACT_S3_ENDPOINT=https://s3.example.com
   SWIZZLE_ARTIFACT_S3_REGION=us-east-1
   SWIZZLE_ARTIFACT_S3_PREFIX=artifacts
   SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE=true
   AWS_ACCESS_KEY_ID=<access key>
   AWS_SECRET_ACCESS_KEY=<secret key>
   ```

   Leave `SWIZZLE_ARTIFACT_S3_ENDPOINT` empty for AWS S3.

2. Restart the stack (`just stack`) or `just dev` so the services read the new backend.

3. Check the backend:

   ```bash
   swizzle doctor
   ```

   `doctor` and the API's `/ready` write, read and delete a probe object under the prefix. A failure names the backend and the target, never the credentials.

4. Each deployment records the backend it was stored in ([`createArtifactStorageForReference`](../../packages/runtime/src/storage.ts)), so existing deployments keep reading their trees from `local`. Keep the local directory while a deployment you may run or roll back to lives there, or move an automation to the bucket with `swizzle apply --force`.

A backup records the backend, and a restore refuses a backup from a different backend. See [back up and restore](back-up-and-restore.md).
