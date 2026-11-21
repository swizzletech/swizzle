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
    release(destroy?: boolean | Error): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "connect" | "remove", listener: (client: PoolClient) => void): this;
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
