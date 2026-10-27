import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { deployments, workerRunImages } from "./schema.js";

/**
 * Which run image each worker assembled for each deployment, and which of them its Docker engine
 * keeps. A worker records a tag before it assembles the image and asks for its keep set before a
 * prune pass; neither holds a lock across the pass.
 */
export function createRunImageRetentionStore(options: { readonly client?: DatabaseClient } = {}) {
  const client = options.client ?? createDatabaseClient();
  return {
    async record(input: {
      readonly deploymentId: string;
      readonly workerId: string;
      readonly environment: string;
      readonly tag: string;
    }): Promise<void> {
      await client.db
        .insert(workerRunImages)
        .values(input)
        .onConflictDoUpdate({
          target: [workerRunImages.deploymentId, workerRunImages.workerId],
          set: { tag: input.tag },
        });
    },
    /**
     * The tags a worker recorded for active versions. A forced deploy or rollback of the same
     * version can reuse an old image before the worker reports the new deployment, so this keeps
     * the newest report for each active version. One statement sees deployment changes and image
     * ownership in one snapshot.
     */
    async keep(workerId: string): Promise<readonly string[]> {
      const active = alias(deployments, "active");
      const rows = await client.db
        .selectDistinctOn([deployments.versionId, workerRunImages.environment], {
          tag: workerRunImages.tag,
        })
        .from(workerRunImages)
        .innerJoin(
          deployments,
          and(
            eq(deployments.id, workerRunImages.deploymentId),
            eq(deployments.environment, workerRunImages.environment),
          ),
        )
        .innerJoin(
          active,
          and(
            eq(active.versionId, deployments.versionId),
            eq(active.environment, deployments.environment),
            eq(active.status, "active"),
          ),
        )
        .where(eq(workerRunImages.workerId, workerId))
        .orderBy(deployments.versionId, workerRunImages.environment, sql`${deployments.seq} desc`);
      return [...new Set(rows.map((row) => row.tag))];
    },
    async close(): Promise<void> {
      if (options.client === undefined) await client.close();
    },
  };
}
