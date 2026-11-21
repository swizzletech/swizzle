import type { Logger } from "pino";

import { installProcessGuards } from "./process-guards.js";

export class ConfigurationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export async function bootService<T>(logger: Logger, configure: () => Promise<T>): Promise<T> {
  installProcessGuards(logger);
  try {
    return await configure();
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logger.fatal({ code: error.code }, error.message);
    process.exit(1);
  }
}
