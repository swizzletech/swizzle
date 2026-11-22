import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { CodedError, inScope, type SecretDeclarationCollision } from "@swizzle/db";
import {
  type JudgedTriggerSummary,
  WEBHOOK_PATH_PREFIX,
  type WithWebhookUrl,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyInstance, FastifyRequest, FastifyTypeProviderDefault } from "fastify";
import type { Logger } from "pino";

export type ApiServer = FastifyInstance<
  Server<typeof IncomingMessage, typeof ServerResponse>,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  FastifyTypeProviderDefault
>;

export interface EnvironmentQuery {
  readonly environment?: string;
}

export interface DashboardRunsQuery extends EnvironmentQuery {
  readonly approvalOnly?: "false" | "true";
  readonly failedOnly?: "false" | "true";
  readonly automation?: string;
  readonly cursor?: string;
  readonly limit?: string;
  readonly parentRunId?: string;
  readonly queuedSince?: string;
  readonly state?: string;
  readonly status?: string;
  readonly topLevelOnly?: "false" | "true";
  readonly triggerType?: string;
}

export interface NotificationDeliveriesQuery extends EnvironmentQuery {
  readonly automation?: string;
  readonly eventType?: string;
  readonly limit?: string;
}

export interface NotificationRuleBody {
  readonly automationName?: string;
  readonly chatId?: string;
  readonly cooldownSeconds?: number;
  readonly enabled?: boolean;
  readonly eventType?: string;
  readonly project?: string;
  readonly threshold?: number;
  readonly windowSeconds?: number;
}

declare module "fastify" {
  interface FastifyInstance {
    readonly configuredEnvironment: string;
  }
}

export function getEnvironment(request: FastifyRequest): string {
  const query = request.query as EnvironmentQuery | undefined;
  return query?.environment ?? request.server.configuredEnvironment;
}

export function resolveTrustProxy(): boolean | string {
  const raw = process.env.SWIZZLE_TRUSTED_PROXY?.trim();
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false" || normalized === "off" || normalized === "0") return false;
  return raw;
}

export function normalizeClientIp(ip: string | undefined): string {
  const value = ip ?? "unknown";
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

export function requestValidationError(message: string): never {
  throw new CodedError("REQUEST_INVALID", message);
}

export function randomRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getAllowedOrigins(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configuredOrigins = splitOrigins(environment.SWIZZLE_CORS_ORIGINS);
  if (configuredOrigins.length > 0) return configuredOrigins;
  const dashboardOrigin = environment.SWIZZLE_DASHBOARD_ORIGIN?.trim();
  return dashboardOrigin ? [dashboardOrigin] : [];
}

export function dashboardOrigin(environment: NodeJS.ProcessEnv = process.env): string | null {
  const origin = URL.parse(environment.SWIZZLE_DASHBOARD_ORIGIN?.trim() ?? "");
  return origin !== null && (origin.protocol === "https:" || origin.protocol === "http:")
    ? origin.origin
    : null;
}

function splitOrigins(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export { deploymentResponse as serializeDeploymentResponse } from "@swizzle/runtime/platform";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost", "0.0.0.0"]);

export function publicApiUrl(request: FastifyRequest): string | null {
  return apiBaseUrl(request, process.env.SWIZZLE_PUBLIC_URL);
}

function apiBaseUrl(request: FastifyRequest, setting: string | undefined): string | null {
  const configured = setting?.trim();
  if (configured !== undefined && configured !== "") {
    const url = URL.parse(configured);
    return (url === null ? configured : `${url.origin}${url.pathname}`).replace(/\/+$/u, "");
  }
  const host = request.headers.host ?? "";
  return LOOPBACK_HOSTNAMES.has(host.replace(/:\d+$/u, ""))
    ? `${request.protocol}://${host}`
    : null;
}

export function withWebhookUrl<T extends { readonly trigger: JudgedTriggerSummary | null }>(
  request: FastifyRequest,
  record: T,
): WithWebhookUrl<T> {
  const { trigger } = record;
  if (trigger === null) return { ...record, trigger: null };
  const url =
    trigger.webhookPath === null
      ? null
      : webhookUrl(request, trigger.webhookPath, trigger.environment);
  return { ...record, trigger: { ...trigger, webhookUrl: url } };
}

export function webhookUrl(
  request: FastifyRequest,
  webhookPath: string,
  environment: string,
): string | null {
  const base = webhookPath.startsWith(`${WEBHOOK_PATH_PREFIX}/`)
    ? publicApiUrl(request)
    : apiBaseUrl(request, process.env.SWIZZLE_API_ORIGIN);
  return base === null ? null : `${base}${webhookPath}?${new URLSearchParams({ environment })}`;
}

export function formatSecretDeclarationCollisionWarnings(
  collisions: readonly {
    readonly automationNames: readonly string[];
    readonly secretName: string;
  }[],
): readonly string[] {
  return collisions.map((collision) => {
    const automations = collision.automationNames.join(", ");
    const sharing = collision.automationNames.length === 1 ? "both share" : "all share";
    return `Secret ${collision.secretName} is also declared by ${automations} - ${sharing} one value; renaming to <AUTOMATION>_${collision.secretName} avoids coupling.`;
  });
}

export async function visibleCollisions(
  request: FastifyRequest,
  platform: PlatformServices,
  environment: string,
  collisions: readonly SecretDeclarationCollision[],
): Promise<readonly SecretDeclarationCollision[]> {
  const scope = await request.access.scope(environment);
  if (scope.all) return collisions;
  const readable = new Map<string, Promise<boolean>>();
  const isReadable = (name: string) => {
    let answer = readable.get(name);
    if (answer === undefined) {
      answer = platform
        .findAutomation(name)
        .then((owner) => owner !== null && inScope(scope, owner));
      readable.set(name, answer);
    }
    return answer;
  };
  const visible = async (names: readonly string[]) => {
    const flags = await Promise.all(names.map(isReadable));
    return names.filter((_, index) => flags[index]);
  };
  const result: SecretDeclarationCollision[] = [];
  for (const collision of collisions) {
    const automationSlugs = await visible(collision.automationSlugs);
    if (automationSlugs.length === 0) continue;
    result.push({
      ...collision,
      automationNames: await visible(collision.automationNames),
      automationSlugs,
    });
  }
  return result;
}
