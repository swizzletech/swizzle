export {
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ApiErrorResponse,
  isApiErrorCode,
} from "./api-errors.js";
export { bootService, ConfigurationError } from "./boot.js";
export {
  configureOutboundHttpProxy,
  controlEgressAgentOptions,
  EgressProxyConfigurationError,
  parseEgressProxyUrl,
  SWIZZLE_CONTROL_EGRESS_PROXY_ENV,
} from "./http-egress.js";
export {
  type ResolveServiceInstanceIdOptions,
  resolveServiceInstanceId,
} from "./instance-id.js";
export { type CreateLoggerOptions, createLogger } from "./logger.js";
export {
  createSmtpMailer,
  type Mailer,
  type MailMessage,
  type MailSettings,
  readMailSettings,
  SWIZZLE_MAIL_FROM_ENV,
  SWIZZLE_SMTP_URL_ENV,
} from "./mail.js";
export { installProcessGuards, type ProcessGuardOptions } from "./process-guards.js";
export { getTracer, shutdownTracing, startTracing, trace } from "./tracing.js";
export { APP_VERSION } from "./version.js";
export { DEFAULT_WORKER_CONCURRENCY, readWorkerConcurrency } from "./worker-settings.js";

export const APP_NAME = "Swizzle";

export function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function createDisplayName(name: string): string {
  return name.trim().replaceAll(/\s+/g, "-").toLowerCase();
}
