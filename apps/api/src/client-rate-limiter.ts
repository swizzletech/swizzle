import { AutomationRuntimeError, parseRateLimitSpec, type RateLimitConfig } from "@swizzle/runtime";
import type { FastifyRequest } from "fastify";

import { normalizeClientIp } from "./http-shared.js";

export interface ClientRateLimiter {
  check(clientKey: string): RateLimitDecision;
}

interface RateLimitDecision {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly limit: number;
  readonly retryAfterMs: number;
  readonly windowMs: number;
}

const MAX_TRACKED_CLIENTS = 10_000;
const OFF_SPELLINGS = new Set(["false", "off", "disabled", "0"]);

export function createClientRateLimiterFromEnvironment(
  variable: string,
  defaultSpec: string,
): ClientRateLimiter {
  const raw = process.env[variable]?.trim() || defaultSpec;
  if (OFF_SPELLINGS.has(raw.toLowerCase())) return createClientRateLimiter(null);
  try {
    return createClientRateLimiter(parseRateLimitSpec(variable, raw));
  } catch (error) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      error instanceof Error ? error.message : `Invalid ${variable} value.`,
      {
        details: {
          expected: `Rate limit like "${defaultSpec}", "10/sec", "1000/hour", or "off".`,
          value: raw,
          variable,
        },
      },
    );
  }
}

export function createClientRateLimiter(
  config: RateLimitConfig | null,
  maxClients = MAX_TRACKED_CLIENTS,
): ClientRateLimiter {
  if (config === null) {
    return {
      check: () => ({
        allowed: true,
        currentCount: 0,
        limit: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        windowMs: 0,
      }),
    };
  }

  const buckets = new Map<string, number[]>();
  const decide = (allowed: boolean, bucket: readonly number[], retryAfterMs: number) => ({
    allowed,
    currentCount: bucket.length,
    limit: config.maxRequests,
    retryAfterMs,
    windowMs: config.windowMs,
  });

  return {
    check(clientKey) {
      const now = Date.now();
      const cutoff = now - config.windowMs;
      const bucket = (buckets.get(clientKey) ?? []).filter((timestamp) => timestamp > cutoff);
      if (bucket.length >= config.maxRequests) {
        buckets.set(clientKey, bucket);
        const oldest = bucket[0] ?? now;
        return decide(false, bucket, Math.max(1_000, oldest + config.windowMs - now));
      }
      buckets.delete(clientKey);
      if (buckets.size >= maxClients) evict(buckets, cutoff, maxClients);
      bucket.push(now);
      buckets.set(clientKey, bucket);
      return decide(true, bucket, 0);
    },
  };
}

function evict(buckets: Map<string, number[]>, cutoff: number, maxClients: number): void {
  for (const [key, timestamps] of buckets) {
    if (buckets.size < maxClients && (timestamps.at(-1) ?? 0) > cutoff) break;
    buckets.delete(key);
  }
}

export function clientKey(request: FastifyRequest): string {
  return normalizeClientIp(request.ip ?? request.socket.remoteAddress ?? "unknown");
}
