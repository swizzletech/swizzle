import type { Logger } from "pino";

import { installProcessGuards } from "./process-guards.js";

/** Configuration failures carry the diagnostic code the operator can act on. */
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

/** Install guards before configuration and report expected boot failures without a stack trace. */
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
