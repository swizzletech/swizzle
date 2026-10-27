import type { Server } from "node:http";

/** The operator's single inference destination. It never comes from automation input. */
export interface LocalLlmPolicy {
  readonly upstream: URL;
  readonly apiKey: string;
  readonly model: string;
  readonly concurrency: number;
  readonly requestsPerAttempt: number;
  readonly maxTokens: number;
}

/** Separate listeners keep grant creation off the sandbox's network. */
export interface LocalLlmGateway {
  readonly inference: Server;
  readonly control: Server;
  close(): Promise<void>;
}
