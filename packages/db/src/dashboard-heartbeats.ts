import { and, desc, eq } from "drizzle-orm";

import type { DatabaseClient } from "./client.js";
import { asMetadata } from "./dashboard-shared.js";
import type { ServiceHeartbeatRecord, UpsertServiceHeartbeatInput } from "./dashboard-types.js";
import { serviceHeartbeats } from "./schema.js";

export async function listServiceHeartbeats(
  client: DatabaseClient,
  environment: string | null,
  service?: string,
): Promise<readonly ServiceHeartbeatRecord[]> {
  const filters = environment === null ? [] : [eq(serviceHeartbeats.environment, environment)];
  if (service !== undefined) {
    filters.push(eq(serviceHeartbeats.service, service));
  }

  const rows = await client.db
    .select({
      createdAt: serviceHeartbeats.createdAt,
      environment: serviceHeartbeats.environment,
      host: serviceHeartbeats.host,
      instanceId: serviceHeartbeats.instanceId,
      metadata: serviceHeartbeats.metadata,
      observedAt: serviceHeartbeats.observedAt,
      pid: serviceHeartbeats.pid,
      service: serviceHeartbeats.service,
      updatedAt: serviceHeartbeats.updatedAt,
    })
    .from(serviceHeartbeats)
    .where(and(...filters))
    .orderBy(
      desc(serviceHeartbeats.observedAt),
      serviceHeartbeats.service,
      serviceHeartbeats.instanceId,
    );

  return rows.map(mapServiceHeartbeatRow);
}

export async function upsertServiceHeartbeat(
  client: DatabaseClient,
  input: UpsertServiceHeartbeatInput,
): Promise<ServiceHeartbeatRecord> {
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  const [row] = await client.db
    .insert(serviceHeartbeats)
    .values({
      environment: input.environment,
      host: input.host ?? null,
      instanceId: input.instanceId,
      metadata: input.metadata ?? {},
      observedAt,
      pid: input.pid ?? null,
      service: input.service,
    })
    .onConflictDoUpdate({
      set: {
        environment: input.environment,
        host: input.host ?? null,
        metadata: input.metadata ?? {},
        observedAt,
        pid: input.pid ?? null,
        updatedAt: observedAt,
      },
      target: [serviceHeartbeats.service, serviceHeartbeats.instanceId],
    })
    .returning({
      createdAt: serviceHeartbeats.createdAt,
      environment: serviceHeartbeats.environment,
      host: serviceHeartbeats.host,
      instanceId: serviceHeartbeats.instanceId,
      metadata: serviceHeartbeats.metadata,
      observedAt: serviceHeartbeats.observedAt,
      pid: serviceHeartbeats.pid,
      service: serviceHeartbeats.service,
      updatedAt: serviceHeartbeats.updatedAt,
    });

  if (row === undefined) {
    throw new Error("Failed to persist service heartbeat.");
  }

  return mapServiceHeartbeatRow(row);
}

function mapServiceHeartbeatRow(row: {
  readonly createdAt: Date;
  readonly environment: string;
  readonly host: string | null;
  readonly instanceId: string;
  readonly metadata: unknown;
  readonly observedAt: Date;
  readonly pid: number | null;
  readonly service: string;
  readonly updatedAt: Date;
}): ServiceHeartbeatRecord {
  return {
    createdAt: row.createdAt.toISOString(),
    environment: row.environment,
    host: row.host,
    instanceId: row.instanceId,
    metadata: asMetadata(row.metadata),
    observedAt: row.observedAt.toISOString(),
    pid: row.pid,
    service: row.service,
    updatedAt: row.updatedAt.toISOString(),
  };
}
