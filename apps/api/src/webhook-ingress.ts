import { CodedError } from "@swizzle/db";
import {
  AutomationRuntimeError,
  createWebhookRunContext,
  type WebhookRunContext,
} from "@swizzle/runtime";
import {
  isWebhookDeliveryPath,
  type TriggerRunResponse,
  WEBHOOK_PATH_PREFIX,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  type ClientRateLimiter,
  clientKey,
  createClientRateLimiterFromEnvironment,
} from "./client-rate-limiter.js";
import { type ApiServer, getEnvironment } from "./http-shared.js";

const WEBHOOK_NOT_AVAILABLE_CODES = new Set<AutomationRuntimeError["code"]>([
  "TRIGGER_NOT_FOUND",
  "TRIGGER_PAUSED",
  "TRIGGER_CONFIGURATION_INVALID",
  "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
  "PLATFORM_REQUIRED_SECRETS_MISSING",
  "WEBHOOK_NOT_AVAILABLE",
]);

export function registerWebhookIngressRoute(
  app: ApiServer,
  options: {
    readonly platform: PlatformServices;
    readonly webhookIngressLimiter: ClientRateLimiter;
  },
): void {
  const deliver = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<TriggerRunResponse> => {
    const environment = getEnvironment(request);
    const requestPath = getRequestPath(request.raw.url);
    if (!isWebhookDeliveryPath(requestPath)) return replyWebhookNotAvailable();
    const rateLimit = options.webhookIngressLimiter.check(clientKey(request));
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000));
      reply.header("Retry-After", String(retryAfterSeconds));
      throw new CodedError(
        "WEBHOOK_RATE_LIMITED",
        `Webhook ingress rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
        {
          details: {
            currentCount: rateLimit.currentCount,
            limit: rateLimit.limit,
            retryAfterMs: rateLimit.retryAfterMs,
            windowMs: rateLimit.windowMs,
          },
        },
      );
    }

    const payload = request.body ?? {};
    try {
      const run = await options.platform.triggerWebhookByPath({
        correlationId: request.id,
        environment,
        path: requestPath,
        payload,
        webhookContext: buildWebhookContext(request),
      });

      return {
        deploymentId: run.deploymentId,
        queuedAt: run.queuedAt,
        runId: run.runId,
        status: run.status,
      };
    } catch (error) {
      return sanitizeWebhookIngressError(error);
    }
  };
  app.post<{ Reply: TriggerRunResponse }>(`${WEBHOOK_PATH_PREFIX}/*`, deliver);
  app.post<{ Reply: TriggerRunResponse }>("/*", deliver);
}

function sanitizeWebhookIngressError(error: unknown): never {
  if (!(error instanceof AutomationRuntimeError)) {
    throw error;
  }

  if (WEBHOOK_NOT_AVAILABLE_CODES.has(error.code)) return replyWebhookNotAvailable();

  if (error.code === "WEBHOOK_PAYLOAD_INVALID") {
    throw new CodedError(
      "WEBHOOK_PAYLOAD_INVALID",
      "Webhook payload does not match the trigger payload schema.",
      {
        ...(error.details?.validationErrors !== undefined
          ? { details: { validationErrors: error.details.validationErrors } }
          : {}),
      },
    );
  }

  throw new CodedError("WEBHOOK_REJECTED", "The webhook request could not be processed.");
}

function replyWebhookNotAvailable(): never {
  throw new CodedError("WEBHOOK_NOT_AVAILABLE", "No webhook is available for this path.");
}

export function createWebhookIngressLimiterFromEnvironment(): ClientRateLimiter {
  return createClientRateLimiterFromEnvironment("SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT", "60/min");
}

function buildWebhookContext(request: FastifyRequest): WebhookRunContext | null {
  if (request.rawBody === undefined) {
    return null;
  }

  return createWebhookRunContext({
    headers: request.headers,
    rawBody: request.rawBody,
  });
}

function getRequestPath(url: string | undefined): string {
  const path = (url ?? "").split("?")[0] ?? "";
  return path || "/";
}
