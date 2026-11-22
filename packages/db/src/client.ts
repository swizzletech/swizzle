import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type NodePgDatabase, type NodePgTransaction } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import * as schema from "./schema.js";

export const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://swizzle:swizzle@localhost:5432/swizzle";

export interface DatabaseClient {
  readonly db:
    | NodePgDatabase<typeof schema>
    | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
  readonly pool: Pool;
  close(): Promise<void>;
  migrate(): Promise<void>;
}

export function createDatabaseClient(
  options: { readonly connectionString?: string } = {},
): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString ?? DEFAULT_DATABASE_URL,
  });
  pool.on("error", (error) => {
    process.emitWarning(`Postgres ended an idle connection: ${error.message}`);
  });
  const connections = new Set<PoolClient>();
  let onAllRemoved = () => {};
  pool.on("connect", (connection) => connections.add(connection));
  pool.on("remove", (connection) => {
    connections.delete(connection);
    if (connections.size === 0) onAllRemoved();
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      const allRemoved = new Promise<void>((resolve) => {
        onAllRemoved = resolve;
        if (connections.size === 0) resolve();
      });
      await pool.end();
      await allRemoved;
    },
    async migrate() {
      await migrate(db, {
        migrationsFolder: path.resolve(fileURLToPath(new URL("../drizzle", import.meta.url))),
      });
    },
  };
}

export const PG_ERROR = {
  foreignKeyViolation: "23503",
  invalidTextRepresentation: "22P02",
  restrictViolation: "23001",
  uniqueViolation: "23505",
} as const;

export function causeViolation(
  error: unknown,
): { readonly code: string; readonly constraint: string | undefined } | undefined {
  for (
    let current = error;
    typeof current === "object" && current !== null;
    current = "cause" in current ? current.cause : undefined
  ) {
    if ("code" in current && typeof current.code === "string") {
      return {
        code: current.code,
        constraint:
          "constraint" in current && typeof current.constraint === "string"
            ? current.constraint
            : undefined,
      };
    }
  }
  return undefined;
}

export function causeCode(error: unknown): string | undefined {
  return causeViolation(error)?.code;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const violation = causeViolation(error);
  return violation?.code === PG_ERROR.uniqueViolation && violation.constraint === constraint;
}
