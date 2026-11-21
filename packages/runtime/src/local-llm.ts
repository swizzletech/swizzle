import type { Server } from "node:http";

export interface LocalLlmPolicy {
  readonly upstream: URL;
  readonly apiKey: string;
  readonly model: string;
  readonly concurrency: number;
  readonly requestsPerAttempt: number;
  readonly maxTokens: number;
}

export interface LocalLlmGateway {
  readonly inference: Server;
  readonly control: Server;
  close(): Promise<void>;
}
