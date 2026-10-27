declare module "pg" {
  export interface QueryResultRow {
    readonly [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    readonly command: string;
    readonly rowCount: number | null;
    readonly rows: R[];
  }

  export interface QueryConfig<I = unknown[]> {
    readonly text: string;
    readonly values?: I;
  }

  export interface PoolConfig {
    readonly connectionString?: string;
  }

  export class Client {
    constructor(config?: PoolConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryTextOrConfig: string | QueryConfig,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
  }

  export class PoolClient extends Client {
    /** Returns the connection to the pool; `true` or an error ends it instead. */
    release(destroy?: boolean | Error): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    /** "connect" fires for each new connection, "remove" once a connection's socket has closed. */
    on(event: "connect" | "remove", listener: (client: PoolClient) => void): this;
    /** An idle connection failed; the pool has already dropped it. */
    on(event: "error", listener: (error: Error, client: PoolClient) => void): this;
    query<R extends QueryResultRow = QueryResultRow>(
      queryTextOrConfig: string | QueryConfig,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
  }

  const pg: {
    Client: typeof Client;
    Pool: typeof Pool;
  };

  export default pg;
}
