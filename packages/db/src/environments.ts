import { ConfigurationError } from "@swizzle/core";
import { sql } from "drizzle-orm";

import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import type { StoredEnvironment } from "./environment-types.js";
import { platformEnvironments } from "./schema.js";

export const ENVIRONMENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

// A heartbeat older than this counts as "not live" for the purpose of the
// deploy guard. Services beat every ~10s; the window is generous enough to ride
// out a restart without producing a false "unserved" warning.
const LIVE_SERVICE_WINDOW_SECONDS = 60;

export interface CreateEnvironmentInput {
  readonly name: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
}

export interface EnvironmentStore {
  createEnvironment(input: CreateEnvironmentInput): Promise<StoredEnvironment>;
  listEnvironments(): Promise<readonly StoredEnvironment[]>;
  close(): Promise<void>;
}

export class EnvironmentError extends ConfigurationError {
  constructor(
    public override readonly code: "ENVIRONMENT_NAME_INVALID" | "ENVIRONMENT_NOT_CONFIGURED",
    message: string,
  ) {
    super(code, message);
    this.name = "EnvironmentError";
  }
}

export function validateEnvironmentName(name: string): string {
  const normalized = name.trim();
  if (!ENVIRONMENT_NAME_PATTERN.test(normalized)) {
    throw new EnvironmentError(
      "ENVIRONMENT_NAME_INVALID",
      "Environment name must be 1-32 characters and use only letters, numbers, underscores, or hyphens.",
    );
  }
  return normalized;
}

/**
 * The environment a service process serves: its `SWIZZLE_ENVIRONMENT`. The API answers a request
 * without `?environment=` from it, and the scheduler fires the cron triggers of it. Both call this
 * at startup and refuse to start without one, so no surface falls back to a name of its own.
 */
export function readConfiguredEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.SWIZZLE_ENVIRONMENT;
  if (configured === undefined || configured.trim().length === 0) {
    throw new EnvironmentError(
      "ENVIRONMENT_NOT_CONFIGURED",
      "SWIZZLE_ENVIRONMENT is not set. Set it to the environment this service serves, such as staging.",
    );
  }
  return validateEnvironmentName(configured);
}

export function createPostgresEnvironmentStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): EnvironmentStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;

  return {
    async createEnvironment(input) {
      const name = validateEnvironmentName(input.name);
      const displayName = normalizeOptionalText(input.displayName);
      const description = normalizeOptionalText(input.description);

      await client.db
        .insert(platformEnvironments)
        .values({
          name,
          ...(description !== undefined ? { description } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          set: {
            ...(description !== undefined ? { description } : {}),
            ...(displayName !== undefined ? { displayName } : {}),
            updatedAt: new Date(),
          },
          target: platformEnvironments.name,
        });

      const environment = (await listEnvironments(client)).find(
        (candidate) => candidate.name === name,
      );
      if (environment === undefined) {
        throw new Error(`Persisted environment could not be reloaded: ${name}`);
      }
      return environment;
    },

    async listEnvironments() {
      return await listEnvironments(client);
    },

    async close() {
      if (ownsClient) {
        await client.close();
      }
    },
  };
}

async function listEnvironments(client: DatabaseClient): Promise<readonly StoredEnvironment[]> {
  const result = await client.db.execute(sql`
    WITH discovered_primary(environment, last_seen_at) AS (
      SELECT environment, max(deployed_at) FROM deployments GROUP BY environment
      UNION ALL SELECT environment, max(updated_at) FROM automation_triggers GROUP BY environment
      UNION ALL SELECT environment, max(updated_at) FROM environment_secrets GROUP BY environment
      UNION ALL SELECT environment, max(injected_at) FROM run_execution_secret_usages GROUP BY environment
      UNION ALL SELECT environment, max(updated_at) FROM environment_connections GROUP BY environment
      UNION ALL SELECT environment, max(injected_at) FROM run_execution_connection_usages GROUP BY environment
      UNION ALL SELECT environment, max(occurred_at) FROM audit_events GROUP BY environment
      UNION ALL SELECT environment, max(updated_at) FROM notification_rules GROUP BY environment
      UNION ALL SELECT environment, max(updated_at) FROM notification_deliveries GROUP BY environment
      UNION ALL SELECT environment, max(observed_at) FROM service_heartbeats GROUP BY environment
    ),
    discovered_activity(environment, last_seen_at) AS (
      SELECT environment, last_seen_at FROM discovered_primary
      UNION ALL SELECT environment, max(observed_at) FROM queue_metric_samples GROUP BY environment
      UNION ALL SELECT environment, max(created_at) FROM maintenance_runs GROUP BY environment
    ),
    primary_rollup AS (
      SELECT environment AS name, max(last_seen_at) AS last_seen_at
      FROM discovered_primary
      WHERE environment IS NOT NULL AND btrim(environment) <> ''
      GROUP BY environment
    ),
    activity_rollup AS (
      SELECT environment AS name, max(last_seen_at) AS last_seen_at
      FROM discovered_activity
      WHERE environment IS NOT NULL AND btrim(environment) <> ''
      GROUP BY environment
    ),
    live_services AS (
      SELECT environment AS name, array_agg(DISTINCT service ORDER BY service) AS services
      FROM service_heartbeats
      WHERE environment IS NOT NULL AND btrim(environment) <> ''
        AND observed_at > now() - make_interval(secs => ${LIVE_SERVICE_WINDOW_SECONDS})
      GROUP BY environment
    )
    SELECT
      coalesce(registry.name, primary_rollup.name) AS name,
      registry.display_name AS "displayName",
      registry.description,
      registry.created_at AS "createdAt",
      registry.updated_at AS "updatedAt",
      activity_rollup.last_seen_at AS "lastSeenAt",
      registry.name IS NOT NULL AS registered,
      primary_rollup.name IS NOT NULL AND primary_rollup.last_seen_at IS NOT NULL AS "hasData",
      coalesce(live_services.services, ARRAY[]::text[]) AS "liveServices"
    FROM platform_environments registry
    FULL OUTER JOIN primary_rollup ON primary_rollup.name = registry.name
    LEFT JOIN activity_rollup ON activity_rollup.name = coalesce(registry.name, primary_rollup.name)
    LEFT JOIN live_services ON live_services.name = coalesce(registry.name, primary_rollup.name)
    ORDER BY coalesce(registry.name, primary_rollup.name) ASC
  `);

  return result.rows.map((row: Record<string, unknown>) => ({
    createdAt: toIsoString(row.createdAt),
    description: row.description === null ? null : String(row.description),
    displayName: row.displayName === null ? null : String(row.displayName),
    hasData: Boolean(row.hasData),
    lastSeenAt: toIsoString(row.lastSeenAt),
    liveServices: toStringArray(row.liveServices),
    name: String(row.name),
    registered: Boolean(row.registered),
    updatedAt: toIsoString(row.updatedAt),
  }));
}

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
