import { CodedError } from "@swizzle/db";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type { EventCallbackResponse } from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";

import {
  type ClientRateLimiter,
  clientKey,
  createClientRateLimiterFromEnvironment,
} from "./client-rate-limiter.js";
import type { ApiServer } from "./http-shared.js";

const MAX_EVENT_BODY_BYTES = 64 * 1024;

export function createEventCallbackRateLimiterFromEnvironment(): ClientRateLimiter {
  return createClientRateLimiterFromEnvironment("SWIZZLE_EVENT_CALLBACK_RATE_LIMIT", "60/min");
}

export function registerEventCallbackRoutes(
  app: ApiServer,
  options: {
    readonly eventCallbackRateLimiter: ClientRateLimiter;
    readonly platform: PlatformServices;
  },
): void {
  app.post<{ Reply: EventCallbackResponse }>(
    "/events/:token",
    { bodyLimit: MAX_EVENT_BODY_BYTES },
    async (request, reply) => {
      const limit = options.eventCallbackRateLimiter.check(clientKey(request));
      if (!limit.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1_000));
        reply.header("Retry-After", String(retryAfterSeconds));
        throw new CodedError(
          "EVENT_CALLBACK_RATE_LIMITED",
          `Too many event callbacks. Retry after ${retryAfterSeconds}s.`,
        );
      }

      const { token } = request.params as { token: string };
      const lookup = await options.platform.findWaitByLink({ kind: "event", token });
      if (lookup.status !== "not-found") await request.audit.target(lookup.target);
      if (lookup.status !== "open") return notAvailable();

      try {
        const result = await options.platform.resolveRunEvent({
          runId: lookup.wait.runId,
          stepKey: lookup.wait.stepKey,
          value: request.body ?? null,
        });
        if (result.status !== "resolved") return notAvailable();
      } catch (error) {
        if (
          error instanceof AutomationRuntimeError &&
          error.code === "AUTOMATION_STEP_LIMIT_EXCEEDED"
        ) {
          throw new CodedError(
            "EVENT_CALLBACK_TOO_LARGE",
            "The event body is larger than the run can store.",
          );
        }
        throw error;
      }
      return { resumed: true };
    },
  );
}

function notAvailable(): never {
  throw new CodedError(
    "EVENT_CALLBACK_NOT_AVAILABLE",
    "No event callback is available for this link.",
  );
}
