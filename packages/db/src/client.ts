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
  /** Resolves once every connection's socket is closed, not only once the pool stops lending. */
  close(): Promise<void>;
  migrate(): Promise<void>;
}

export function createDatabaseClient(
  options: { readonly connectionString?: string } = {},
): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString ?? DEFAULT_DATABASE_URL,
  });
  // An idle connection the server ends, as on a restart or a terminated backend, has already
  // left the pool when this fires; the next query opens a new one and reports any lasting error.
  // Unheard, the event would crash the process; a process warning reaches the service log.
  pool.on("error", (error) => {
    process.emitWarning(`Postgres ended an idle connection: ${error.message}`);
  });
  // pg-pool's end() resolves while the sockets of idle connections are still closing, so a
  // DROP DATABASE ... WITH (FORCE) right after close() could still reach them. The pool emits
  // "remove" once a connection's socket has closed.
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

/** PostgreSQL error codes the stores turn into domain errors. */
export const PG_ERROR = {
  foreignKeyViolation: "23503",
  /** What a uuid column raises for text that is not a UUID. */
  invalidTextRepresentation: "22P02",
  /** What ON DELETE RESTRICT raises, where NO ACTION raises foreignKeyViolation. */
  restrictViolation: "23001",
  uniqueViolation: "23505",
} as const;

/** PostgreSQL metadata from the cause chain Drizzle wraps it in. */
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

/** The PostgreSQL error code somewhere in the cause chain Drizzle wraps it in. */
export function causeCode(error: unknown): string | undefined {
  return causeViolation(error)?.code;
}
