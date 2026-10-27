// The environment record environments.ts stores, apart from it so that the @swizzle/db root names
// it without loading drizzle or pg.

export interface StoredEnvironment {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly registered: boolean;
  readonly hasData: boolean;
  /**
   * The services, such as "worker" and "scheduler", whose heartbeat arrived within the live window
   * of environments.ts. Empty means nobody serves the environment: a deploy there registers but
   * never executes.
   */
  readonly liveServices: readonly string[];
}
