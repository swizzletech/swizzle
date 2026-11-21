import pino, { type Logger, type LoggerOptions } from "pino";

import { createStdoutLogSink, fileLogSink } from "./logger-file.js";

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

  const logFile = process.env.SWIZZLE_LOG_FILE;
  return pino(base, logFile ? fileLogSink(logFile) : createStdoutLogSink());
}
