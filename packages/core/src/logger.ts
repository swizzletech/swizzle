import pino, { type Logger, type LoggerOptions } from "pino";

const PRODUCTION = process.env.NODE_ENV === "production";

export interface CreateLoggerOptions {
  readonly bindings?: Record<string, unknown>;
  readonly level?: string;
}

interface LoggedRequest {
  readonly headers?: Record<string, unknown>;
  readonly host?: string;
  readonly ip?: string;
  readonly method?: string;
  readonly socket?: { readonly remotePort?: number };
  readonly url?: string;
}

/**
 * Fastify's request serializer with credentials cut out of the URL: the capability token of an
 * approval or event callback link and the OAuth callback's `code` and `state`. Fastify prefers the logger's own `req`
 * serializer over its default, so every request log line goes through this.
 */
function serializeRequest(request: LoggedRequest) {
  return {
    host: request.host,
    method: request.method,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
    url: request.url
      ?.replace(/^\/(approvals|events)\/[^/?#]+/u, "/$1/[REDACTED]")
      .replace(/([?&](?:code|state)=)[^&#]*/gu, "$1[REDACTED]"),
    version: request.headers?.["accept-version"],
  };
}

export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? "info";
  const base: LoggerOptions = {
    level,
    name,
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authorization",
        "request.headers.cookie",
        "headers.authorization",
        "headers.cookie",
        "body.password",
        "body.currentPassword",
        "body.newPassword",
        "body.setupToken",
        "body.token",
        "body.clientSecret",
        "password",
        "currentPassword",
        "newPassword",
        "setupToken",
        "token",
        "clientSecret",
        "SWIZZLE_ENCRYPTION_KEY",
        "SWIZZLE_ENCRYPTION_PREVIOUS_KEYS",
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_URL",
        "VALKEY_URL",
      ],
    },
    // pino serializes only `err` as an Error by default; under `error`, an Error logged as `{}`.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req: serializeRequest,
    },
    ...(options.bindings !== undefined ? { base: options.bindings } : {}),
  };

  if (!PRODUCTION) {
    try {
      return pino({
        ...base,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "HH:MM:ss.l",
          },
        },
      });
    } catch {
      return pino(base);
    }
  }

  // Both production sinks write synchronously: a slow sink slows the request that logs, so a flood
  // that outruns it cannot pile log lines up in memory.
  const logFile = process.env.SWIZZLE_LOG_FILE;
  if (logFile) {
    return pino(
      base,
      pino.transport({
        // The worker thread drains a 4 MB ring. An async transport queues the lines the ring
        // cannot take on the main thread, up to the maximum string length; sync waits for room
        // instead. pino documents `sync` for transports but leaves it out of its types.
        ...{ sync: true },
        options: {
          file: logFile,
          frequency: process.env.SWIZZLE_LOG_FILE_FREQUENCY ?? "daily",
          limit: { count: Number(process.env.SWIZZLE_LOG_FILE_COUNT ?? 10) },
          mkdir: true,
          size: process.env.SWIZZLE_LOG_FILE_SIZE ?? "20M",
        },
        target: "pino-roll",
      }),
    );
  }

  // pino's default async destination buffers without a bound behind a slow Docker log reader.
  return pino(base, pino.destination({ dest: 1, sync: true }));
}
