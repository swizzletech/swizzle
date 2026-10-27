import type { Logger } from "pino";

export interface ProcessGuardOptions {
  /**
   * Milliseconds to wait after logging an uncaught exception before forcing
   * process.exit(1). Gives async transports time to flush.
   */
  readonly exitDelayMs?: number;
  /**
   * If false, do not exit on uncaughtException — only log. Useful for tests.
   */
  readonly exitOnUncaught?: boolean;
}

export function installProcessGuards(logger: Logger, options: ProcessGuardOptions = {}): void {
  const exitDelayMs = options.exitDelayMs ?? 1000;
  const exitOnUncaught = options.exitOnUncaught ?? true;

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: serializeError(reason) }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: serializeError(error) }, "Uncaught exception");
    if (exitOnUncaught) {
      setTimeout(() => process.exit(1), exitDelayMs).unref();
    }
  });

  process.on("warning", (warning) => {
    logger.warn(
      {
        warning: {
          message: warning.message,
          name: warning.name,
          stack: warning.stack,
        },
      },
      "Node process warning",
    );
  });
}

function serializeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      cause: value.cause instanceof Error ? serializeError(value.cause) : value.cause,
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return { value: String(value) };
}
