import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { StoredDeployment, WorkerCredential } from "@swizzle/db";
import {
  createPostgresControlPlaneStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { collectWorkerCapabilities } from "@swizzle/runtime";
import { readWorkerReply, WORKER_ROUTES } from "@swizzle/runtime/platform";
import { startVerificationApi } from "./verify-api-process.js";
import { commitDeploymentFixture } from "./verify-state-fixtures.js";

/** The keep set and disk measurement over the real worker routes and PostgreSQL. */
export async function verifyRunImages(client: DatabaseClient): Promise<void> {
  const registry = createPostgresWorkerRegistry({ client });
  const store = createPostgresControlPlaneStore({ client });
  const api = await startVerificationApi();
  const credentials: WorkerCredential[] = [];
  const capabilities = await collectWorkerCapabilities([]);
  const call = async (worker: WorkerCredential, route: string, body: unknown) => {
    const response = await fetch(`${api.url}/worker/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, route);
    return response;
  };
  const enroll = async (profile: string) => {
    const enrollment = await registry.create({
      name: profile,
      profiles: [profile],
      services: [],
      capacity: 1,
      issuedBy: null,
      environments: [
        { projectId: "00000000-0000-4000-8000-000000000001", environment: "state-machine" },
      ],
    });
    const worker = await registry.enroll(enrollment.code, profile);
    credentials.push(worker);
    await call(worker, "runtime", { capabilities, services: {}, runImageDisk: null });
    const stored = await client.pool.query(
      "select capabilities from workers where id=$1 and last_seen_at is not null",
      [worker.worker.id],
    );
    assert.deepEqual(
      stored.rows[0]?.capabilities,
      capabilities,
      "the heartbeat stores capabilities",
    );
    const heartbeats = await client.pool.query(
      "select 1 from service_heartbeats where instance_id like $1",
      [`${worker.worker.id}%`],
    );
    assert.equal(heartbeats.rowCount, 0, "a worker's state lives on its workers row only");
    return worker;
  };
  const replace = async (deployment: StoredDeployment, profile: string) =>
    (
      await store.commitDeployment({
        intent: "redeploy-if-unchanged",
        credentials: [],
        auditEvent: { eventType: "deploy", metadata: {} },
        deployment: {
          ...deployment,
          deploymentId: randomUUID(),
          deployedAt: new Date().toISOString(),
          config: { ...deployment.config, runtime: { ...deployment.config.runtime, profile } },
        },
      })
    ).deployment;
  const report = async (worker: WorkerCredential, deployment: StoredDeployment, tag: string) => {
    await call(worker, "run-images", { deploymentId: deployment.deploymentId, tag });
  };
  const keep = async (worker: WorkerCredential) =>
    readWorkerReply(
      WORKER_ROUTES.runImageKeep,
      await (await call(worker, "run-images/keep", {})).json(),
    ).keep;
  try {
    const a = await enroll("host-default");
    const b = await enroll("image-group-b");
    const first = await commitDeploymentFixture(store, "image-group-a");
    const other = await replace(
      await commitDeploymentFixture(store, "image-group-b"),
      "image-group-b",
    );
    const tagA = `swizzle-run:${"a".repeat(24)}`;
    const tagB = `swizzle-run:${"b".repeat(24)}`;
    await report(a, first, tagA);
    await report(b, other, tagB);
    const replacement = await replace(other, "image-group-b");
    assert.equal(replacement.versionId, other.versionId);
    assert.deepEqual(await keep(a), [tagA], "a worker's keep set holds only its own tags");
    assert.deepEqual(
      await keep(b),
      [tagB],
      "an unreported identical-source replacement keeps its cached image",
    );
    console.log(
      "Run images: each worker keeps only its own tags, and a same-source replacement keeps its image.",
    );

    // A laptop that wakes polls before its next heartbeat: its keep set must not depend on it.
    await client.pool.query(
      "update workers set last_seen_at = now() - interval '1 hour' where id = $1",
      [a.worker.id],
    );
    assert.deepEqual(await keep(a), [tagA], "a stale heartbeat keeps the worker's active images");
    console.log("Run images: a worker whose heartbeat is an hour old keeps its active images.");

    const disk = {
      activeBytes: 3 * 1_048_576,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 1_048_576,
    };
    await call(a, "runtime", { capabilities, services: {}, runImageDisk: disk });
    const listed = await registry.list();
    assert.deepEqual(
      listed.find((worker) => worker.id === a.worker.id)?.runImageDisk,
      disk,
      "the heartbeat stores the worker's disk measurement",
    );
    assert.equal(listed.find((worker) => worker.id === b.worker.id)?.runImageDisk, null);
    console.log("Run images: the heartbeat after a pass stores its disk measurement.");
  } finally {
    await api.close();
    for (const credential of credentials) await registry.revoke(credential.worker.id, null);
    await Promise.all([registry.close(), store.close()]);
  }
}
