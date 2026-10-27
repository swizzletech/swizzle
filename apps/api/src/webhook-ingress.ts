import { CodedError } from "@swizzle/db";
import {
  AutomationRuntimeError,
  createWebhookRunContext,
  type WebhookRunContext,
} from "@swizzle/runtime";
import type { TriggerRunResponse } from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import {
  type ClientRateLimiter,
  clientKey,
  createClientRateLimiterFromEnvironment,
} from "./client-rate-limiter.js";
import { type ApiServer, getEnvironment } from "./http-shared.js";

// The webhook ingress is the platform's only unauthenticated door. Its error
// responses must never reveal platform internals (declared secret names, automation
// names, config state) and must not act as an existence oracle. Every state that
// means "there is nothing here you may talk to" — unknown path, paused trigger,
// misconfigured trigger, missing platform secrets, or a failed/absent signature on a
// signed endpoint — collapses to the SAME opaque 404 so an anonymous caller cannot
// distinguish a real-but-not-ready webhook from a nonexistent one. Only two outcomes
// remain observable: 200 (accepted) and 422 (payload schema mismatch), and 422 is
// reachable only after any required signature has already passed.
const WEBHOOK_NOT_AVAILABLE_CODES = new Set<AutomationRuntimeError["code"]>([
  "TRIGGER_NOT_FOUND",
  "TRIGGER_PAUSED",
  "TRIGGER_CONFIGURATION_INVALID",
  "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
  "PLATFORM_REQUIRED_SECRETS_MISSING",
  "WEBHOOK_NOT_AVAILABLE",
]);

/**
 * Records every POST route registered on `app` from now on, so call it before the first route.
 * The returned predicate answers whether a webhook path would be answered by one of them instead
 * of the catch-all ingress (a `:param` segment matches any one segment). Deploy uses it to refuse
 * such a path.
 */
export function trackApiPostRoutes(app: ApiServer): (webhookPath: string) => boolean {
  const patterns: string[][] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.includes("POST") && route.url !== "/*") {
      patterns.push(route.url.split("/"));
    }
  });

  return (webhookPath) => {
    const segments = webhookPath.split("/");
    return patterns.some(
      (pattern) =>
        pattern.length === segments.length &&
        pattern.every((part, index) => part.startsWith(":") || part === segments[index]),
    );
  };
}

export function registerWebhookIngressRoute(
  app: ApiServer,
  options: {
    readonly platform: PlatformServices;
    readonly webhookIngressLimiter: ClientRateLimiter;
  },
): void {
  app.post<{ Reply: TriggerRunResponse }>("/*", async (request, reply) => {
    const environment = getEnvironment(request);
    const requestPath = getRequestPath(request.raw.url);
    // One budget per client across paths and environments: guessing either spends the same
    // budget as flooding one webhook.
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
  });
}

// Turns a runtime error into a caller-safe response for the public ingress door.
// Never forwards `error.details` or `error.message` verbatim (both can embed secret
// names or automation names); uses fixed, generic text instead. Non-runtime errors
// are rethrown so the global handler returns an opaque 500.
function sanitizeWebhookIngressError(error: unknown): never {
  if (!(error instanceof AutomationRuntimeError)) {
    throw error;
  }

  if (WEBHOOK_NOT_AVAILABLE_CODES.has(error.code)) return replyWebhookNotAvailable();

  if (error.code === "WEBHOOK_PAYLOAD_INVALID") {
    // Payload errors describe the caller's own request, not platform internals, and
    // are only reachable once any required signature has passed — safe to surface.
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
  return (url ?? "/").split("?")[0] ?? "/";
}
